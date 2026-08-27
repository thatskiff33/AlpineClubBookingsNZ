/**
 * Group bookings — ORGANISER_PAYS settlement collection.
 *
 * The organiser of an ORGANISER_PAYS group settles every joiner's child booking
 * as one combined bill. Each child booking was created PAYMENT_PENDING and
 * flagged `organiserSettled`, so the joiner is never billed and cannot pay it.
 *
 * Settlement reuses the existing pay-on-account semantics (issue #709):
 *
 *   1. When the organiser starts a settlement, the children are committed to
 *      CONFIRMED under the same advisory lock as every other creation path. A
 *      CONFIRMED booking holds capacity, so the beds are reserved the moment the
 *      organiser commits to pay — exactly like a school group's emailed invoice.
 *      The capacity claim is all-or-nothing: if any child no longer fits, no
 *      child is committed and no money is taken, and the organiser is told who
 *      could not be placed so they can remove them and retry.
 *   2. A single Stripe PaymentIntent for the combined total is created and
 *      recorded on GroupBookingSettlement.
 *   3. On `payment_intent.succeeded` (webhook, type=group_settlement) the
 *      children flip CONFIRMED -> PAID exactly once. Because the beds were
 *      already held at CONFIRMED there is no second capacity race and no refund
 *      path: the combined charge simply settles bookings whose beds are secured.
 *
 * Conventions match group-booking.ts: integer cents, NZ date-only booking dates,
 * Stripe/Xero calls run outside the database transaction.
 */
import {
  BookingEventType,
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  cancelPaymentIntentIfCancellable,
  createPaymentIntent,
  findOrCreateCustomer,
  getPaymentIntent,
} from "@/lib/stripe";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueOwnHostingCoverageReevaluation } from "@/lib/adult-member-hosting-review";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { recordBookingEvent } from "@/lib/booking-events";
import {
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroGroupSettlementInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  checkInternetBankingLeadTime,
  loadInternetBankingPaymentSettings,
} from "@/lib/internet-banking-settings";
import {
  buildGroupSettlementPaymentReference,
  type BookingPaymentMethod,
} from "@/lib/booking-payment-methods";
import { GroupBookingError, normaliseJoinCode } from "@/lib/group-booking";
import {
  sendGroupJoinSettledEmail,
  sendGroupSettlementReceiptEmail,
} from "@/lib/email";
import logger from "@/lib/logger";

/** Statuses an organiser-settled child can hold before it is settled. */
const SETTLEABLE_CHILD_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
] as const;

type GroupSettlementOutcome =
  | "ready"
  | "invoice_sent"
  | "already_settled"
  | "nothing_to_settle"
  // A succeeded intent could not be applied (#1883): the settle route surfaces
  // the real apply outcome instead of masking it as "already_settled".
  | "refunded"
  | "cancelled"
  | "amount_mismatch"
  | "not_found";

export interface GroupSettlementIntentResult {
  outcome: GroupSettlementOutcome;
  /** Combined total for the organiser-settled children, in cents. */
  amountCents: number;
  /** Number of child bookings covered by this settlement. */
  childCount: number;
  /** Present when outcome === "ready": pass to Stripe Elements. */
  clientSecret?: string | null;
  paymentIntentId?: string;
  /**
   * Present when outcome === "invoice_sent": the bank-transfer reference shown
   * to the organiser for the combined Internet Banking invoice.
   */
  reference?: string;
}

interface SettleableChild {
  id: string;
  finalPriceCents: number;
  status: BookingStatus;
}

/** Load the group with the fields settlement needs, asserting organiser ownership. */
async function requireOrganiserPaysGroup(rawCode: string, sessionUserId: string) {
  const code = normaliseJoinCode(rawCode);
  const group = code
    ? await prisma.groupBooking.findUnique({
        where: { joinCode: code },
        select: {
          id: true,
          organiserMemberId: true,
          organiserBookingId: true,
          paymentMode: true,
          status: true,
          organiserMember: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          organiserBooking: {
            select: { checkIn: true },
          },
          settlement: true,
        },
      })
    : null;

  if (!group) {
    throw new GroupBookingError("Group booking not found", 404);
  }
  if (group.organiserMemberId !== sessionUserId) {
    throw new GroupBookingError("This is not your group booking", 403);
  }
  if (group.paymentMode !== GroupBookingPaymentMode.ORGANISER_PAYS) {
    throw new GroupBookingError(
      "This group is each-pays-own; joiners settle their own bookings",
      409
    );
  }
  if (group.status === GroupBookingStatus.CANCELLED) {
    throw new GroupBookingError("This group booking has been cancelled", 409);
  }
  return group;
}

/** All organiser-settled children of the group still awaiting settlement. */
async function loadSettleableChildren(
  organiserBookingId: string
): Promise<SettleableChild[]> {
  return prisma.booking.findMany({
    where: {
      parentBookingId: organiserBookingId,
      organiserSettled: true,
      deletedAt: null,
      status: { in: [...SETTLEABLE_CHILD_STATUSES] },
    },
    select: { id: true, finalPriceCents: true, status: true },
  });
}

/**
 * Start (or resume) an organiser settlement: commit the children to CONFIRMED
 * (capacity held) and return a Stripe client secret for the combined total.
 *
 * Idempotent: a child already CONFIRMED from a prior attempt is reused, and an
 * outstanding PaymentIntent for the same total is returned rather than charged
 * twice.
 */
export async function createGroupSettlementIntent(
  rawCode: string,
  sessionUserId: string,
  paymentMethod: BookingPaymentMethod = "stripe"
): Promise<GroupSettlementIntentResult> {
  const group = await requireOrganiserPaysGroup(rawCode, sessionUserId);

  if (group.settlement?.status === PaymentStatus.SUCCEEDED) {
    return {
      outcome: "already_settled",
      amountCents: group.settlement.amountCents,
      childCount: 0,
    };
  }

  const children = await loadSettleableChildren(group.organiserBookingId);
  if (children.length === 0) {
    return { outcome: "nothing_to_settle", amountCents: 0, childCount: 0 };
  }

  // Internet Banking: raise one combined Xero invoice to the organiser instead
  // of charging a card. Reconciliation flips the children to PAID on payment.
  if (paymentMethod === "internet_banking") {
    return createGroupSettlementInvoice(
      group.id,
      group.organiserBooking.checkIn,
      children,
      group.settlement?.stripePaymentIntentId ?? null,
    );
  }

  const settlementHasRefundHistory =
    group.settlement?.status === PaymentStatus.REFUNDED ||
    group.settlement?.status === PaymentStatus.PARTIALLY_REFUNDED;
  const preLockAmountCents = children.reduce(
    (sum, child) => sum + child.finalPriceCents,
    0
  );
  let existingIntent: Awaited<ReturnType<typeof getPaymentIntent>> | null = null;

  // Captured money is reconciled before attempting a new capacity claim. The
  // pre-lock total is not sent to a provider here; the apply path revalidates
  // the capture, settlement, children and total under its own lock.
  if (
    group.settlement?.stripePaymentIntentId &&
    group.settlement.amountCents === preLockAmountCents &&
    !settlementHasRefundHistory
  ) {
    existingIntent = await getPaymentIntent(
      group.settlement.stripePaymentIntentId
    );
    if (existingIntent.status === "succeeded") {
      const applied = await applyGroupSettlementSucceeded({
        id: existingIntent.id,
        amount: existingIntent.amount,
      });
      return {
        outcome:
          applied.outcome === "settled" ||
          applied.outcome === "already_settled"
            ? "already_settled"
            : applied.outcome,
        amountCents: group.settlement.amountCents,
        childCount: children.length,
      };
    }
  }

  // Lock, re-read and claim before deriving provider amount. Repricing writers
  // share lock(1), so this returned snapshot is authoritative for this attempt.
  const { children: committedChildren, hostingCoverageQueued } =
    await commitChildrenToConfirmed(group.id, children);
  if (hostingCoverageQueued) {
    await settleHostingCoverageAfterCommit({ limit: 25 });
  }
  const amountCents = committedChildren.reduce(
    (sum, child) => sum + child.finalPriceCents,
    0
  );
  if (amountCents <= 0) {
    return { outcome: "nothing_to_settle", amountCents: 0, childCount: 0 };
  }

  // Reuse an outstanding intent for the same total before creating a new one,
  // mirroring the single-booking create-payment-intent route. A succeeded intent
  // means the webhook is mid-flight or was missed; reconcile and report the
  // real outcome. A settlement with refund history is never reused (#1883,
  // mirroring #1765): a refunded Stripe intent reports "succeeded" forever, so
  // re-admitting it would settle the children with money already handed back.
  // Skipping the branch mints a FRESH intent whose idempotency key is
  // discriminated by the refunded intent id, so Stripe cannot replay it either.
  if (
    group.settlement?.stripePaymentIntentId &&
    group.settlement.amountCents === amountCents &&
    !settlementHasRefundHistory
  ) {
    const existing =
      existingIntent ??
      (await getPaymentIntent(group.settlement.stripePaymentIntentId));
    if (existing.status === "succeeded") {
      const applied = await applyGroupSettlementSucceeded({
        id: existing.id,
        amount: existing.amount,
      });
      if (
        applied.outcome === "settled" ||
        applied.outcome === "already_settled"
      ) {
        return { outcome: "already_settled", amountCents, childCount: committedChildren.length };
      }
      // The capture did NOT settle anything (refund history, drifted total, or
      // a vanished settlement row). Never report it settled (#1883): surface
      // the real state and mint nothing — the webhook safety net owns
      // refunding an unapplied capture, and the organiser can retry once the
      // settlement state is resolved.
      return {
        outcome: applied.outcome,
        amountCents,
        childCount: committedChildren.length,
      };
    }
    if (existing.client_secret && existing.status !== "canceled") {
      return {
        outcome: "ready",
        amountCents,
        childCount: committedChildren.length,
        clientSecret: existing.client_secret,
        paymentIntentId: existing.id,
      };
    }
  }

  const customer = await findOrCreateCustomer({
    email: group.organiserMember.email,
    name: `${group.organiserMember.firstName} ${group.organiserMember.lastName}`,
    memberId: group.organiserMember.id,
  });

  const paymentIntent = await createPaymentIntent({
    amountCents,
    customerId: customer.id,
    metadata: {
      type: "group_settlement",
      groupBookingId: group.id,
      organiserMemberId: group.organiserMemberId,
    },
    // Discriminate the key by the intent being superseded, not amount alone.
    // Stripe idempotency keys live 24h, so a bare `groupsettle_<group>_<amount>`
    // can replay a *canceled* prior intent: settle at X (intent A) -> child
    // changes, total Y (intent B, A canceled) -> child reverts to X -> re-settle
    // mints `..._X` again within 24h -> Stripe replays dead intent A. Each intent
    // is superseded at most once, so `(amount, supersededIntentId)` is unique per
    // epoch; two concurrent mints of the *same* attempt read the same
    // `group.settlement` and share the key (Stripe dedupes). The `"initial"`
    // sentinel is safe because real Stripe intent ids are always `pi_…`.
    idempotencyKey: `groupsettle_${group.id}_${amountCents}_${group.settlement?.stripePaymentIntentId ?? "initial"}`,
  });

  const attached = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const currentGroup = await tx.groupBooking.findUnique({
      where: { id: group.id },
      select: { status: true },
    });
    if (!currentGroup || currentGroup.status === GroupBookingStatus.CANCELLED) {
      return false;
    }
    await tx.groupBookingSettlement.upsert({
      where: { groupBookingId: group.id },
      create: {
        groupBookingId: group.id,
        stripePaymentIntentId: paymentIntent.id,
        stripeCustomerId: customer.id,
        amountCents,
        status: PaymentStatus.PENDING,
      },
      update: {
        stripePaymentIntentId: paymentIntent.id,
        stripeCustomerId: customer.id,
        amountCents,
        status: PaymentStatus.PENDING,
      },
    });
    return true;
  });
  if (!attached) {
    await cancelPaymentIntentIfCancellable(paymentIntent.id).catch((err) =>
      logger.error(
        { err, groupBookingId: group.id, paymentIntentId: paymentIntent.id },
        "Failed to cancel a group settlement intent fenced during creation"
      )
    );
    throw new GroupBookingError("This group booking has been cancelled", 409);
  }

  // The new intent supersedes any prior card attempt (e.g. the total changed).
  // Void the old intent so a retained client_secret in a stale tab can no
  // longer capture money that settles nothing.
  await cancelSupersededSettlementIntent(
    group.settlement?.stripePaymentIntentId ?? null,
    paymentIntent.id,
    group.id,
  );

  return {
    outcome: "ready",
    amountCents,
    childCount: committedChildren.length,
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

/**
 * Internet Banking settlement: hold the joiners' beds (all-or-nothing, like the
 * Stripe path) then enqueue one combined Xero invoice raised to the organiser.
 * No card is charged; the children stay CONFIRMED until Xero reports the invoice
 * paid, at which point `applyGroupSettlementSucceededFromInvoice` flips them PAID.
 *
 * The module is re-gated here so a server-side IB settlement is impossible when
 * the Internet Banking module is off, even if the UI gate were bypassed.
 */
async function createGroupSettlementInvoice(
  groupBookingId: string,
  checkIn: Date,
  children: SettleableChild[],
  staleStripePaymentIntentId: string | null
): Promise<GroupSettlementIntentResult> {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.xeroIntegration || !modules.internetBankingPayments) {
    throw new GroupBookingError(
      "Internet Banking payments are not available.",
      400
    );
  }
  const internetBankingSettings = await loadInternetBankingPaymentSettings();
  const leadTime = checkInternetBankingLeadTime({
    checkIn,
    settings: internetBankingSettings,
    // #3123 — the club's PERSISTED zone, read here and OUTSIDE the settlement
    // transaction this function's caller opens. The runtime reader rather than
    // the `server-only` binding: this module is instrumentation-reachable
    // (`xero-inbound/invoice.ts` -> `invoice-paid-effects.ts` -> here).
    today: dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest())),
  });
  if (!leadTime.allowed) {
    throw new GroupBookingError(
      leadTime.unavailableReason ??
        "Internet Banking is not available for this check-in date.",
      400,
      {
        code: "INTERNET_BANKING_CUTOFF",
        details: {
          minimumDaysBeforeCheckIn: leadTime.minimumDaysBeforeCheckIn,
          checkIn: leadTime.checkIn,
        },
      },
    );
  }

  const { children: committedChildren, hostingCoverageQueued } =
    await commitChildrenToConfirmed(groupBookingId, children);
  if (hostingCoverageQueued) {
    await settleHostingCoverageAfterCommit({ limit: 25 });
  }
  const amountCents = committedChildren.reduce(
    (sum, child) => sum + child.finalPriceCents,
    0
  );
  if (amountCents <= 0) {
    return { outcome: "nothing_to_settle", amountCents: 0, childCount: 0 };
  }

  const { settlement, queued } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const currentGroup = await tx.groupBooking.findUnique({
      where: { id: groupBookingId },
      select: { status: true },
    });
    if (!currentGroup || currentGroup.status === GroupBookingStatus.CANCELLED) {
      throw new GroupBookingError("This group booking has been cancelled", 409);
    }
    const settlement = await tx.groupBookingSettlement.upsert({
      where: { groupBookingId },
      create: {
        groupBookingId,
        source: PaymentSource.INTERNET_BANKING,
        amountCents,
        status: PaymentStatus.PENDING,
      },
      update: {
        source: PaymentSource.INTERNET_BANKING,
        stripePaymentIntentId: null,
        amountCents,
        status: PaymentStatus.PENDING,
      },
    });
    const queued = await enqueueXeroGroupSettlementInvoiceOperation(
      settlement.id,
      { store: tx }
    );
    return { settlement, queued };
  });

  // Void the dropped card intent in Stripe so a retained client_secret in a
  // stale tab can no longer capture money alongside the combined invoice.
  await cancelSupersededSettlementIntent(
    staleStripePaymentIntentId,
    null,
    groupBookingId,
  );

  // The outbox row was committed atomically with the settlement above. Only the
  // opportunistic worker kick is best-effort; the cron will drain the durable
  // row if this process stops or the kick fails.
  try {
    if (queued.queueOperationId) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    }
  } catch (xeroErr) {
    logger.error(
      { err: xeroErr, groupBookingId, settlementId: settlement.id },
      "Failed to kick combined Xero invoice worker for group settlement"
    );
  }

  return {
    outcome: "invoice_sent",
    amountCents,
    childCount: committedChildren.length,
    reference: buildGroupSettlementPaymentReference(groupBookingId),
  };
}

/**
 * Best-effort void of a group-settlement PaymentIntent the settlement no longer
 * references (method switch or card re-attempt). Runs after the settlement row
 * is updated and outside any database transaction. A failed cancel is logged
 * and never breaks the settlement flow: if the stale intent later captures, the
 * webhook safety net refunds it and alerts admins.
 */
async function cancelSupersededSettlementIntent(
  staleIntentId: string | null,
  currentIntentId: string | null,
  groupBookingId: string
) {
  if (!staleIntentId || staleIntentId === currentIntentId) {
    return;
  }
  try {
    await cancelPaymentIntentIfCancellable(staleIntentId);
  } catch (err) {
    logger.error(
      { err, groupBookingId, paymentIntentId: staleIntentId },
      "Failed to cancel superseded group settlement intent; the webhook safety net will refund it if it captures"
    );
  }
}

/**
 * Commit every still-PAYMENT_PENDING child to CONFIRMED under the CHILDREN'S
 * per-lodge advisory lock(s), claiming capacity for each in turn so later
 * children see the earlier ones' beds. All-or-nothing: if any child no longer
 * fits, the whole transaction rolls back and a 409 lists the nights that are
 * full.
 */
async function commitChildrenToConfirmed(
  groupBookingId: string,
  children: SettleableChild[]
): Promise<{
  children: SettleableChild[];
  hostingCoverageQueued: boolean;
}> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const currentGroup = await tx.groupBooking.findUnique({
      where: { id: groupBookingId },
      select: { status: true },
    });
    if (!currentGroup || currentGroup.status === GroupBookingStatus.CANCELLED) {
      throw new GroupBookingError("This group booking has been cancelled", 409);
    }

    // Flipping PAYMENT_PENDING -> CONFIRMED is a net-new capacity claim, so it
    // must serialize under the lodge whose beds are being claimed: the child's
    // lodge, NOT the group's default lodge. Booking creators at that lodge hold
    // hash(childLodge); locking hash(default) for a non-default-lodge group
    // would leave them unserialized (overbooking race). Read the pending
    // children's lodge ids first (lodgeId is NOT NULL, so no fallback is
    // needed), then lock every distinct lodge in sorted id order before
    // claiming any capacity — deadlock-safe, matching the draft-cleanup cron.
    // Group joins cannot cross lodges, so this is normally a single lodge; the
    // multi-lock loop is defensive.
    const pendingLodgeRows = await tx.booking.findMany({
      where: { id: { in: children.map((c) => c.id) } },
      select: { lodgeId: true },
    });
    const lodgeIds = Array.from(
      new Set(pendingLodgeRows.map((row) => row.lodgeId))
    ).sort();
    for (const lodgeId of lodgeIds) {
      await acquireLodgeCapacityLock(tx, lodgeId);
    }

    const committed: SettleableChild[] = [];
    let hostingCoverageQueued = false;
    for (const child of children) {
      // Re-read inside the lock; another path may have already moved it.
      const fresh = await tx.booking.findUnique({
        where: { id: child.id },
        include: { guests: { include: { nights: true } } },
      });
      if (
        !fresh ||
        !SETTLEABLE_CHILD_STATUSES.includes(
          fresh.status as (typeof SETTLEABLE_CHILD_STATUSES)[number]
        )
      ) {
        continue;
      }

      if (fresh.status === BookingStatus.CONFIRMED) {
        committed.push({
          id: fresh.id,
          finalPriceCents: fresh.finalPriceCents ?? child.finalPriceCents,
          status: fresh.status,
        });
        continue;
      }

      const capacity = await checkCapacityForGuestRanges(
        fresh.lodgeId,
        fresh.checkIn,
        fresh.checkOut,
        fresh.guests,
        fresh.id,
        tx
      );
      if (!capacity.available && bookingHasCapacityOverride(fresh)) {
        // Persisted capacity override (#1771): defensive guard so the invariant
        // stays total. Group children cannot be admitted over capacity today, so
        // this branch is not expected to fire — but if a child ever carried an
        // override it must settle, not 409. Fall through to the CONFIRMED flip.
        logger.info(
          { bookingId: fresh.id },
          "Settling an over-capacity group child with a persisted capacity override (#1771); skipping the capacity block"
        );
      }
      if (!capacity.available && !bookingHasCapacityOverride(fresh)) {
        const fullNights = capacity.nightDetails
          .filter((n) => n.availableBeds < 0)
          .map((n) => n.date);
        throw new GroupBookingError(
          "The lodge is full for these dates, so the group cannot be settled",
          409,
          { code: "CAPACITY_EXCEEDED", details: { bookingId: fresh.id, fullNights } }
        );
      }

      const claimed = await tx.booking.updateMany({
        where: {
          id: fresh.id,
          status: BookingStatus.PAYMENT_PENDING,
        },
        data: {
          status: BookingStatus.CONFIRMED,
          draftExpiresAt: null,
          // #2265 — a joiner's booking is settled by the organiser, so its
          // `organiserSettled` flag permanently blocks the two paths that could
          // ever consume a stored credit election (the card pay step and the
          // Internet Banking switch both refuse an organiser-settled booking).
          // The election can therefore never be honoured and must not linger on
          // a committed booking pretending otherwise. Nothing is lost: no
          // credit was consumed, so there is nothing to release.
          creditElectionCents: null,
        },
      });
      if (claimed.count !== 1) {
        throw new GroupBookingError(
          "A group booking changed while settlement was being prepared",
          409,
        );
      }
      // CONFIRMED holds capacity, so the next child's check counts these beds.
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId: fresh.id,
        db: tx,
        previousRange: { checkIn: fresh.checkIn, checkOut: fresh.checkOut },
      });
      // #2576 §9. "Split-booking creation" and organiser settlement both land here:
      // this is the one place a group child is committed CONFIRMED, so it is where
      // the hosting facts have to be re-read at confirmation. Recorded inside this
      // transaction, which holds the child's own per-lodge capacity lock — the same
      // key every coverage-removing path takes — so the confirm-while-source-removed
      // race cannot interleave.
      //
      // NEVER REFUSED: the organiser has paid, or is about to, for everybody. §8
      // covers it ("payment or booking lifecycle", "automated status transitions"),
      // and a child that turns out to be uncovered becomes an urgent incident on the
      // officer queue instead of a settlement that fails for the whole group.
      await enqueueOwnHostingCoverageReevaluation(fresh.id, tx, {
        cause: "SYSTEM_CHANGE",
      });
      hostingCoverageQueued = true;
      committed.push({
        id: fresh.id,
        finalPriceCents: fresh.finalPriceCents ?? child.finalPriceCents,
        status: BookingStatus.CONFIRMED,
      });
    }
    return {
      children: committed,
      hostingCoverageQueued,
    };
  });
}

export interface GroupSettlementAppliedResult {
  outcome:
    | "settled"
    | "already_settled"
    | "not_found"
    | "amount_mismatch"
    | "cancelled"
    // #1883 — the settlement carries refund history; the (still "succeeded")
    // intent's money was handed back, so it must never settle the children.
    | "refunded";
  settledBookingIds: string[];
}

/** The settlement shape the shared settle/notify routine needs. */
interface LoadedSettlementForApply {
  id: string;
  amountCents: number;
  stripeCustomerId: string | null;
  groupBookingId: string;
  groupBooking: {
    organiserBookingId: string;
    status: GroupBookingStatus;
    organiserMember: { id: string; email: string; firstName: string; lastName: string };
    organiserBooking: { checkIn: Date; checkOut: Date };
  };
}

/** The relation includes both apply paths load on their settlement row. */
const APPLY_SETTLEMENT_INCLUDE = {
  groupBooking: {
    select: {
      organiserBookingId: true,
      status: true,
      organiserMember: {
        select: { id: true, email: true, firstName: true, lastName: true },
      },
      organiserBooking: { select: { checkIn: true, checkOut: true } },
    },
  },
} as const;

/**
 * Flip every committed (CONFIRMED) organiser-settled child to PAID exactly once,
 * record a Payment per child, mark the settlement SUCCEEDED, and notify everyone.
 * Idempotent under the booking advisory lock. Shared by the Stripe webhook and
 * the Internet Banking Xero-invoice reconciliation paths.
 *
 * @param options.enqueueChildInvoices  Stripe settlements raise a Xero invoice
 *   per child; Internet Banking settlements are already covered by the single
 *   combined invoice, so they pass `false` to avoid duplicate invoices.
 */
async function settleConfirmedChildrenAndNotify(
  settlement: LoadedSettlementForApply,
  options: {
    source: PaymentSource;
    reference: string;
    stripeCustomerId?: string | null;
    enqueueChildInvoices: boolean;
  }
): Promise<GroupSettlementAppliedResult> {
  // #2576 §9: drain whatever `commitChildrenToConfirmed` recorded for these
  // children before this settlement runs. Best-effort; the cron sweep is the
  // authority on completion.
  //
  // UNFILTERED, unlike the member-facing routes, and with a limit that fits the
  // shape: a group's children belong to DIFFERENT joiners, so there is no single
  // owner to scope the claim to, and one settlement can legitimately have queued a
  // row per child. This is a settlement job rather than a member's request, so the
  // cost is already accounted for.
  await settleHostingCoverageAfterCommit({ limit: 25 });

  const settled = await prisma.$transaction(async (tx) => {
    // #1881 two-tier protocol. This path flips CONFIRMED -> PAID (no net-new
    // capacity claim — both statuses already hold beds) AND flips the settlement
    // status (a money/booking-status transition). The settlement-status tier is
    // serialised by the GLOBAL lock(1), which is the SAME key the group-settlement
    // reaper, markGroupSettlementIntentFailed/Refunded, and the organiser-cancel
    // FAILED claim take, so settle can never interleave a reap/fail/refund of the
    // same settlement. (The pre-#1881 default-lodge key did NOT exclude the
    // reaper's lock(1), so a settle could race a reap into an inconsistent
    // settlement/child state.) Bed reconciliation is still an allocation
    // writer, so after the global tier this transaction discovers and acquires
    // the complete sorted child-lodge union before mutating any child.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    // Re-confirm the settlement is still unpaid inside the lock (idempotency).
    const current = await tx.groupBookingSettlement.findUnique({
      where: { id: settlement.id },
      select: {
        status: true,
        groupBooking: { select: { status: true } },
      },
    });
    if (current?.groupBooking?.status === GroupBookingStatus.CANCELLED) {
      return "cancelled" as const;
    }
    if (current?.status === PaymentStatus.SUCCEEDED) {
      return [] as string[];
    }
    // #1883 — a refund can land between the caller's status read and this
    // lock (markGroupSettlementIntentRefunded takes the SAME global lock, so the
    // two serialize). Refunded money must never settle the children.
    if (
      current?.status === PaymentStatus.REFUNDED ||
      current?.status === PaymentStatus.PARTIALLY_REFUNDED
    ) {
      return "refunded" as const;
    }

    const candidateChildren = await tx.booking.findMany({
      where: {
        parentBookingId: settlement.groupBooking.organiserBookingId,
        organiserSettled: true,
        deletedAt: null,
        status: BookingStatus.CONFIRMED,
      },
      select: {
        id: true,
        finalPriceCents: true,
        checkIn: true,
        checkOut: true,
        lodgeId: true,
      },
    });
    const lockedLodgeIds = new Set(
      candidateChildren.map((child) => child.lodgeId),
    );
    for (const lodgeId of [...lockedLodgeIds].sort()) {
      await acquireLodgeCapacityLock(tx, lodgeId);
    }
    const children = await tx.booking.findMany({
      where: {
        parentBookingId: settlement.groupBooking.organiserBookingId,
        organiserSettled: true,
        deletedAt: null,
        status: BookingStatus.CONFIRMED,
      },
      select: {
        id: true,
        finalPriceCents: true,
        checkIn: true,
        checkOut: true,
        lodgeId: true,
      },
    });
    if (children.some((child) => !lockedLodgeIds.has(child.lodgeId))) {
      throw new Error(
        "Group settlement child lodge changed during lock acquisition; retry",
      );
    }

    // Re-verify the settlement total against the children as they exist NOW,
    // under the lock (#1033). A joiner can modify their CONFIRMED child
    // booking while the combined intent/invoice sits open, so a payment that
    // matches the *recorded* settlement amount can still mismatch what the
    // children currently cost. Never auto-apply such a payment — hand it to
    // the operator-review path instead.
    const currentTotalCents = children.reduce(
      (sum, child) => sum + child.finalPriceCents,
      0
    );
    if (currentTotalCents !== settlement.amountCents) {
      logger.error(
        {
          groupBookingId: settlement.groupBookingId,
          settlementId: settlement.id,
          recordedCents: settlement.amountCents,
          currentChildrenCents: currentTotalCents,
          childCount: children.length,
        },
        "Group settlement total no longer matches its children - refusing to auto-apply payment"
      );
      return null;
    }

    const settledIds: string[] = [];
    for (const child of children) {
      await tx.payment.upsert({
        where: { bookingId: child.id },
        create: {
          bookingId: child.id,
          amountCents: child.finalPriceCents,
          source: options.source,
          status: PaymentStatus.SUCCEEDED,
          reference: options.reference,
          stripeCustomerId: options.stripeCustomerId ?? null,
        },
        update: {
          status: PaymentStatus.SUCCEEDED,
          source: options.source,
          reference: options.reference,
          stripeCustomerId: options.stripeCustomerId ?? null,
        },
      });
      // Status-guarded PAID flip (#1881): CONFIRMED -> PAID only. The children
      // query already filtered CONFIRMED under lock(1); the guard makes the
      // no-clobber guarantee structural against a racing reaper revert.
      const paid = await tx.booking.updateMany({
        where: { id: child.id, status: BookingStatus.CONFIRMED },
        data: {
          status: BookingStatus.PAID,
          draftExpiresAt: null,
          // #2265 — belt and braces with the commit flip above: no settled
          // booking carries a non-NULL election. See the note there for why an
          // organiser-settled joiner can never consume one.
          creditElectionCents: null,
        },
      });
      // Defense-in-depth (#1881, mirroring F1's markBookingPaymentSucceeded
      // claim): under lock(1) with the CONFIRMED-filtered read above this can
      // never be 0, but assert it so a count-0 rolls the whole settle back
      // rather than leaving this child's Payment SUCCEEDED with no PAID booking.
      if (paid.count === 0) {
        throw new Error(
          "Group settlement child status changed concurrently during the PAID claim (#1881)"
        );
      }
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId: child.id,
        db: tx,
        previousRange: { checkIn: child.checkIn, checkOut: child.checkOut },
      });
      settledIds.push(child.id);
    }

    // Status-guarded settlement SUCCEEDED claim (#1881): never overwrite a
    // settlement a concurrent reaper/refund already moved to a terminal state.
    await tx.groupBookingSettlement.updateMany({
      where: {
        id: settlement.id,
        status: {
          notIn: [
            PaymentStatus.SUCCEEDED,
            PaymentStatus.REFUNDED,
            PaymentStatus.PARTIALLY_REFUNDED,
          ],
        },
      },
      data: { status: PaymentStatus.SUCCEEDED, paidAt: new Date() },
    });

    return settledIds;
  });

  if (settled === "refunded") {
    logger.warn(
      { groupBookingId: settlement.groupBookingId, settlementId: settlement.id },
      "Group settlement was refunded before the settle transaction ran - refusing to settle (#1883)"
    );
    return { outcome: "refunded", settledBookingIds: [] };
  }

  if (settled === "cancelled") {
    logger.warn(
      { groupBookingId: settlement.groupBookingId, settlementId: settlement.id },
      "Group cancellation fenced settlement apply - refusing to settle children (#1881)"
    );
    return { outcome: "cancelled", settledBookingIds: [] };
  }

  if (settled === null) {
    return { outcome: "amount_mismatch", settledBookingIds: [] };
  }

  // Side effects after commit: a durable "paid" booking event and (Stripe only)
  // a Xero invoice per child. Failures here are logged but never undo the
  // settlement.
  for (const bookingId of settled) {
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.MEMBER_PAID,
      actorMemberId: null,
      reason: "Settled by the group organiser as part of the combined group bill",
    });
    if (options.enqueueChildInvoices) {
      try {
        const queued = await enqueueXeroBookingInvoiceOperation(bookingId);
        if (queued.queueOperationId) {
          await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
        }
      } catch (xeroErr) {
        logger.error(
          { err: xeroErr, bookingId },
          "Failed to queue Xero invoice for settled group child booking"
        );
      }
    }
  }

  // Notify the organiser (receipt) and each joiner (spot confirmed). Email
  // failures are logged but never undo the settlement.
  if (settled.length > 0) {
    const organiser = settlement.groupBooking.organiserMember;
    const organiserBooking = settlement.groupBooking.organiserBooking;
    const organiserName = `${organiser.firstName} ${organiser.lastName}`.trim();
    try {
      await sendGroupSettlementReceiptEmail({
        bookingContext: {
          bookingId: settlement.groupBooking.organiserBookingId,
          recipientMemberId: organiser.id,
        },
        email: organiser.email,
        firstName: organiser.firstName,
        checkIn: organiserBooking.checkIn,
        checkOut: organiserBooking.checkOut,
        joinerCount: settled.length,
        totalCents: settlement.amountCents,
      });
    } catch (emailErr) {
      logger.error(
        { err: emailErr, groupBookingId: settlement.groupBookingId },
        "Failed to send group settlement receipt to organiser"
      );
    }

    const settledBookings = await prisma.booking.findMany({
      where: { id: { in: settled } },
      select: {
        // #2258: each joiner's own booking id gates their settled-spot email.
        id: true,
        memberId: true,
        checkIn: true,
        checkOut: true,
        member: { select: { email: true, firstName: true } },
        _count: { select: { guests: true } },
      },
    });
    for (const booking of settledBookings) {
      try {
        await sendGroupJoinSettledEmail({
          bookingContext: {
            bookingId: booking.id,
            recipientMemberId: booking.memberId,
          },
          email: booking.member.email,
          firstName: booking.member.firstName,
          organiserName,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guestCount: booking._count.guests,
        });
      } catch (emailErr) {
        logger.error(
          { err: emailErr, groupBookingId: settlement.groupBookingId },
          "Failed to send settled-spot confirmation to group joiner"
        );
      }
    }
  }

  logger.info(
    {
      groupBookingId: settlement.groupBookingId,
      settledCount: settled.length,
      source: options.source,
    },
    "Group settlement paid"
  );

  return { outcome: "settled", settledBookingIds: settled };
}

/**
 * Webhook handler for a succeeded group-settlement PaymentIntent. Flips every
 * committed (CONFIRMED) organiser-settled child to PAID exactly once, records a
 * Payment per child referencing the combined intent, and marks the settlement
 * SUCCEEDED. Idempotent across webhook redelivery.
 */
export async function applyGroupSettlementSucceeded(paymentIntent: {
  id: string;
  amount: number;
}): Promise<GroupSettlementAppliedResult> {
  const settlement = await prisma.groupBookingSettlement.findUnique({
    where: { stripePaymentIntentId: paymentIntent.id },
    include: APPLY_SETTLEMENT_INCLUDE,
  });

  if (!settlement) {
    logger.warn(
      { paymentIntentId: paymentIntent.id },
      "Group settlement PaymentIntent succeeded but no settlement record found"
    );
    return { outcome: "not_found", settledBookingIds: [] };
  }

  if (settlement.status === PaymentStatus.SUCCEEDED) {
    return { outcome: "already_settled", settledBookingIds: [] };
  }

  // #1883 — refund history is immutable (mirrors #1765 for single bookings):
  // a refunded intent keeps status "succeeded" in Stripe forever, so once the
  // settlement is marked REFUNDED/PARTIALLY_REFUNDED the same intent must
  // never be re-admitted as settlement. The children stay unsettled; the
  // organiser owes a fresh payment via a new intent.
  if (
    settlement.status === PaymentStatus.REFUNDED ||
    settlement.status === PaymentStatus.PARTIALLY_REFUNDED
  ) {
    logger.warn(
      {
        paymentIntentId: paymentIntent.id,
        groupBookingId: settlement.groupBookingId,
        settlementStatus: settlement.status,
      },
      "Group settlement has refund history - refusing to re-admit its intent as settlement (#1883)"
    );
    return { outcome: "refunded", settledBookingIds: [] };
  }

  // Never auto-apply a payment whose amount does not match what we recorded;
  // leave the settlement PENDING for an operator to review.
  if (paymentIntent.amount !== settlement.amountCents) {
    logger.error(
      {
        paymentIntentId: paymentIntent.id,
        expectedCents: settlement.amountCents,
        receivedCents: paymentIntent.amount,
        groupBookingId: settlement.groupBookingId,
      },
      "Group settlement amount mismatch - refusing to auto-apply payment"
    );
    return { outcome: "amount_mismatch", settledBookingIds: [] };
  }

  return settleConfirmedChildrenAndNotify(settlement, {
    source: PaymentSource.STRIPE,
    reference: paymentIntent.id,
    stripeCustomerId: settlement.stripeCustomerId,
    enqueueChildInvoices: true,
  });
}

/**
 * Reconciliation handler for a paid combined Internet Banking settlement invoice.
 * Matched by `GroupBookingSettlement.xeroInvoiceId` when Xero reports the invoice
 * PAID; flips every CONFIRMED organiser-settled child to PAID and marks the
 * settlement SUCCEEDED. Idempotent across re-reconciliation.
 */
export async function applyGroupSettlementSucceededFromInvoice(
  xeroInvoiceId: string
): Promise<GroupSettlementAppliedResult> {
  const settlement = await prisma.groupBookingSettlement.findFirst({
    where: { xeroInvoiceId },
    include: APPLY_SETTLEMENT_INCLUDE,
  });

  if (!settlement) {
    logger.warn(
      { xeroInvoiceId },
      "Group settlement invoice paid but no settlement record found"
    );
    return { outcome: "not_found", settledBookingIds: [] };
  }

  if (settlement.status === PaymentStatus.SUCCEEDED) {
    return { outcome: "already_settled", settledBookingIds: [] };
  }

  return settleConfirmedChildrenAndNotify(settlement, {
    source: PaymentSource.INTERNET_BANKING,
    reference: settlement.xeroInvoiceNumber ?? xeroInvoiceId,
    stripeCustomerId: null,
    enqueueChildInvoices: false,
  });
}

/**
 * #1883 — close the re-admit window after the webhook safety net refunds a
 * captured group-settlement intent. A refunded Stripe PaymentIntent reports
 * status "succeeded" forever, so the refund must be recorded on the settlement
 * row itself: the settle-page reuse branch, applyGroupSettlementSucceeded and
 * the in-lock re-check all refuse REFUNDED/PARTIALLY_REFUNDED settlements.
 *
 * Runs under the SAME global lock(1) as settleConfirmedChildrenAndNotify and the
 * reaper (#1881) so the mark serializes with any in-flight settle/reap of the
 * same settlement. The guarded updateMany never overwrites a
 * settlement that already SUCCEEDED (the refund path alerts admins about that
 * conflict) and is idempotent across webhook redelivery; a no-match (e.g. the
 * settlement was legitimately re-pointed at a newer intent) is a no-op.
 * stripePaymentIntentId is deliberately KEPT: the next settle attempt then
 * mints a fresh intent keyed `groupsettle_<group>_<amount>_<refundedIntent>`,
 * so Stripe's 24h idempotency window cannot replay the refunded intent.
 */
export async function markGroupSettlementIntentRefunded(
  paymentIntentId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await tx.groupBookingSettlement.updateMany({
      where: {
        stripePaymentIntentId: paymentIntentId,
        status: {
          notIn: [
            PaymentStatus.SUCCEEDED,
            PaymentStatus.REFUNDED,
            PaymentStatus.PARTIALLY_REFUNDED,
          ],
        },
      },
      data: { status: PaymentStatus.REFUNDED },
    });
  });
}

/**
 * Webhook handler for a failed or canceled group-settlement PaymentIntent. The
 * children stay CONFIRMED (beds held) so the organiser can retry; we only record
 * the failed state on the settlement so the UI can prompt another attempt.
 */
export async function markGroupSettlementIntentFailed(
  paymentIntentId: string,
  status: PaymentStatus = PaymentStatus.FAILED
): Promise<void> {
  // #1881 — take the SAME global lock(1) as its sibling
  // markGroupSettlementIntentRefunded, the settle path
  // (settleConfirmedChildrenAndNotify), the reaper, and the organiser-cancel
  // FAILED claim. Before this the FAILED mark took NO lock, so it could execute
  // BETWEEN the multi-statement settle transaction's own statements (the settle
  // holds lock(1) for its whole duration; an unlocked updateMany does not
  // serialise against it), leaving a torn interleaving the doc's "all
  // settlement-status transitions take lock(1)" claim explicitly rules out.
  // Wrapping the mark in lock(1) makes the two mutually exclude: they run
  // whole-before-whole, never interleaved.
  //
  // The guard deliberately does NOT exclude FAILED from the settle path's notIn
  // set: a settlement marked FAILED by a payment_failed/canceled webhook whose
  // money is then GENUINELY captured (payment_intent.succeeded -> settle) MUST
  // still become SUCCEEDED — real captured money has to settle the children, so
  // letting settle overwrite FAILED -> SUCCEEDED is correct, not a bug. What the
  // lock adds is atomicity (no interleaving), not a new veto. This mark records
  // only a non-success outcome (callers: payment_failed, payment_intent.canceled,
  // both stored FAILED), so it can never legitimately need to leave a positive
  // terminal state; the guarded updateMany fuses the "still non-terminal?" check
  // with the write, and a no-match (incl. unknown intent) is a no-op.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await tx.groupBookingSettlement.updateMany({
      where: {
        stripePaymentIntentId: paymentIntentId,
        status: {
          notIn: [
            PaymentStatus.SUCCEEDED,
            PaymentStatus.REFUNDED,
            PaymentStatus.PARTIALLY_REFUNDED,
          ],
        },
      },
      data: { status },
    });
  });
}
