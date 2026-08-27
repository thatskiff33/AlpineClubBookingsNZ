import { NextRequest, NextResponse } from "next/server";
import {
  BookingStatus,
  CreditType,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";
import { CreatePaymentIntentSchema } from "@/types/payments";
import { canCreateImmediatePaymentIntent } from "@/lib/booking-payment-flow";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import {
  HOSTING_COVERAGE_RETRY_BODY,
  isHostingCoverageParticipantRetry,
} from "@/lib/adult-member-hosting-queue-participants";
import { enqueueOwnHostingCoverageReevaluation } from "@/lib/adult-member-hosting-review";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import {
  buildInternetBankingHoldUntil,
  checkInternetBankingLeadTime,
  loadInternetBankingPaymentSettings,
} from "@/lib/internet-banking-settings";
import { recordInternetBankingPaymentTransaction } from "@/lib/payment-transactions";
import { cancelPaymentIntentIfCancellable } from "@/lib/stripe";
import {
  enqueueXeroAppliedCreditAllocationOperation,
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { isXeroConnected } from "@/lib/xero";
import logger from "@/lib/logger";
import { hasAdminAccess } from "@/lib/access-roles";
import { lockMemberCreditLedger } from "@/lib/member-credit";
import { consumeStoredCreditElection } from "@/lib/booking-credit-election";

/**
 * The member's account credit leaves nothing for the invoice to ask for, so
 * there is no Internet Banking payment to make. Thrown INSIDE the transaction
 * on purpose: the rollback puts any election this request consumed straight
 * back on the booking, so the member can settle it at $0 on the card pay step
 * instead with their election untouched.
 */
class CreditCoversWholeBookingError extends Error {
  constructor() {
    super("Account credit covers this booking in full");
    this.name = "CreditCoversWholeBookingError";
  }
}

/**
 * Switch an existing card (Stripe) PAYMENT_PENDING booking to Internet Banking.
 *
 * Mirrors the booking-create Internet Banking branch for an already-created
 * booking: flips its Payment to PaymentSource.INTERNET_BANKING with a BOOKING-
 * reference, voids any open Stripe intent, and raises + emails the Xero invoice.
 * The booking stays PAYMENT_PENDING until Xero inbound reconciliation marks it
 * PAID, exactly like a booking created with Internet Banking. Internet Banking is
 * an optional module, so this 400s when it is off.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = CreatePaymentIntentSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.xeroIntegration || !modules.internetBankingPayments) {
    return NextResponse.json(
      { error: "Internet Banking payments are not available." },
      { status: 400 }
    );
  }

  const { bookingId } = parsed.data;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      payment: true,
      guests: { include: { nights: true } },
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (booking.memberId !== session.user.id && !hasAdminAccess(session.user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (booking.organiserSettled) {
    return NextResponse.json(
      {
        error:
          "This booking is paid by the group organiser and cannot be paid individually",
      },
      { status: 400 }
    );
  }

  const reference = buildInternetBankingPaymentReference(booking.id);

  // Already on Internet Banking → idempotent success.
  if (booking.payment?.source === PaymentSource.INTERNET_BANKING) {
    return NextResponse.json({
      reference,
      holdBedSlots: booking.payment.internetBankingHoldSlots,
      holdUntil: booking.payment.internetBankingHoldUntil,
    });
  }

  const internetBankingSettings = await loadInternetBankingPaymentSettings();
  const leadTime = checkInternetBankingLeadTime({
    checkIn: booking.checkIn,
    settings: internetBankingSettings,
    // #3123 — the club's PERSISTED zone decides the cutoff day, not the
    // container's. `booking.checkIn` is a stored `@db.Date` calendar day and
    // stays zone-free; this is the other side of that comparison, encoded on
    // the same UTC-midnight frame (`INV-DATE-026`).
    today: await clubTodayDateOnlyInstant(),
  });
  if (!leadTime.allowed) {
    return NextResponse.json(
      {
        error: leadTime.unavailableReason ?? "Internet Banking is not available for this check-in date.",
        code: "INTERNET_BANKING_CUTOFF",
        minimumDaysBeforeCheckIn: leadTime.minimumDaysBeforeCheckIn,
        checkIn: leadTime.checkIn,
      },
      { status: 400 },
    );
  }

  // Only an immediately-payable (charge-now) booking can switch; a saved-card
  // hold or organiser-settled / draft booking cannot.
  if (
    booking.status !== "PAYMENT_PENDING" ||
    !canCreateImmediatePaymentIntent({
      status: booking.status,
      hasNonMembers: booking.hasNonMembers,
      organiserSettled: booking.organiserSettled,
    })
  ) {
    return NextResponse.json(
      { error: "This booking cannot switch to Internet Banking." },
      { status: 400 }
    );
  }
  if (booking.finalPriceCents <= 0) {
    return NextResponse.json(
      { error: "This booking has nothing to pay." },
      { status: 400 }
    );
  }
  if (booking.payment?.status === PaymentStatus.SUCCEEDED) {
    return NextResponse.json(
      { error: "This booking has already been paid." },
      { status: 400 }
    );
  }

  // Void any open Stripe intent so the member can't also be charged by card.
  if (booking.payment?.stripePaymentIntentId) {
    try {
      await cancelPaymentIntentIfCancellable(booking.payment.stripePaymentIntentId);
    } catch (err) {
      logger.error(
        { err, bookingId },
        "Failed to cancel Stripe intent while switching to Internet Banking"
      );
    }
  }

  // #1620 §3 — preserve the payment-mirror invariant `amountCents +
  // creditAppliedCents = finalPriceCents`. The pre-switch (card-origin) payment
  // carries creditAppliedCents = 0 even though credit was consumed, so derive the
  // applied amount from the authoritative BOOKING_APPLIED ledger (NOT the stale
  // mirror) and set the IB payment to the effective amount the member now owes.
  // The invoice is reduced to this effective amount by the applied-credit
  // allocation op enqueued below (Option A: member pays effective).
  const holdBedSlots = internetBankingSettings.holdBedSlots;
  const holdUntil = buildInternetBankingHoldUntil(internetBankingSettings);
  const paymentResult = await prisma.$transaction(async (tx) => {
    // #1881 two-tier protocol. Switching to Internet Banking with holdBedSlots
    // flips the booking to CONFIRMED (a capacity-holding status) — a net-new
    // capacity claim and a money-side-effect (the IB payment). It must take
    // BOTH locks (global lock(1) first, then the per-lodge capacity lock) and
    // re-read the booking UNDER the locks: the pre-transaction `booking`
    // snapshot was read with no lock at all, so before this the capacity check
    // and status flip consumed a stale snapshot and did not mutually exclude a
    // concurrent cancel (lock(1)) or per-lodge creator.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    // Re-read under the locks; every status/capacity decision below consumes
    // ONLY this post-lock snapshot. A concurrent cancel/modify that committed
    // during the lock wait is only visible here.
    const locked = await tx.booking.findUnique({
      where: { id: booking.id },
      include: { guests: { include: { nights: true } } },
    });
    if (!locked || locked.status !== BookingStatus.PAYMENT_PENDING) {
      return { type: "notSwitchable" as const };
    }

    // Credit writers serialize on a per-member key, not lock(1). Compose all
    // three tiers in the global -> lodge -> member order before aggregating so
    // this read cannot race an applied-credit writer.
    await lockMemberCreditLedger(locked.memberId, tx);

    if (holdBedSlots) {
      const capacity = await checkCapacityForGuestRanges(
        bookingLodgeId,
        locked.checkIn,
        locked.checkOut,
        locked.guests,
        locked.id,
        tx,
      );
      if (!capacity.available && bookingHasCapacityOverride(locked)) {
        // Persisted capacity override (#1771): admitted above the ceiling by an
        // admin, so switching to Internet Banking must not report
        // capacityExceeded — fall through and hold the slots as requested.
        logger.info(
          { bookingId: booking.id },
          "Switching an over-capacity booking with a persisted capacity override (#1771) to Internet Banking; skipping the capacity block"
        );
      }
      if (!capacity.available && !bookingHasCapacityOverride(locked)) {
        return { type: "capacityExceeded" as const };
      }
    }

    // #2265 — an admin-released AWAITING_REVIEW booking can still be carrying
    // the member's stored credit election when they choose Internet Banking.
    // Consume it HERE, under the locks this transaction already holds and
    // before the invoice amount is computed, so the Xero invoice is raised for
    // what the member actually owes rather than the pre-credit price. Without
    // this the switch bypassed the election entirely: the member was invoiced
    // the full amount and their credit stayed stranded on a booking that could
    // never consume it (the card pay path is the only other consumer, and this
    // booking has left it). Deliberately after the capacity decision above —
    // a refused switch must leave the election intact.
    const creditElection = await consumeStoredCreditElection(tx, {
      bookingId: locked.id,
    });

    // Recompute the payment mirror under the full lock set so a pre-lock
    // price/credit pair cannot be persisted after either side changes. The
    // aggregate is read AFTER the consumption above, so it already includes the
    // election's ledger row.
    const appliedCreditAgg = await tx.memberCredit.aggregate({
      where: { appliedToBookingId: locked.id, type: CreditType.BOOKING_APPLIED },
      _sum: { amountCents: true },
    });
    const creditAppliedCents = Math.max(
      0,
      -(appliedCreditAgg._sum.amountCents ?? 0),
    );
    const amountCents = Math.max(0, locked.finalPriceCents - creditAppliedCents);

    // Nothing left to invoice. Raising a $0 Internet Banking invoice and asking
    // the member to bank-transfer nothing is not a payment path, and settling
    // the booking to PAID here would duplicate the card route's $0 settlement
    // in a route that is about invoices. Bail: the rollback restores the
    // election, and the member completes the booking on the pay step, which
    // settles a fully covered booking at $0 (#2265).
    if (amountCents === 0) {
      throw new CreditCoversWholeBookingError();
    }

    const payment = await tx.payment.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        amountCents,
        creditAppliedCents,
        source: PaymentSource.INTERNET_BANKING,
        reference,
        status: PaymentStatus.PENDING,
        internetBankingHoldSlots: holdBedSlots,
        internetBankingHoldUntil: holdUntil,
        internetBankingHoldReleasedAt: null,
      },
      update: {
        amountCents,
        creditAppliedCents,
        source: PaymentSource.INTERNET_BANKING,
        reference,
        status: PaymentStatus.PENDING,
        stripePaymentIntentId: null,
        internetBankingHoldSlots: holdBedSlots,
        internetBankingHoldUntil: holdUntil,
        internetBankingHoldReleasedAt: null,
      },
    });

    if (holdBedSlots) {
      // Status-guarded claim (#1881): only a still-PAYMENT_PENDING booking may
      // be claimed CONFIRMED. Under the locks count 0 cannot happen (the
      // re-read gated on it), but the guard means a concurrent cancel that
      // slipped the lock can never be clobbered back to CONFIRMED.
      const claimed = await tx.booking.updateMany({
        where: { id: booking.id, status: BookingStatus.PAYMENT_PENDING },
        data: { status: BookingStatus.CONFIRMED },
      });
      if (claimed.count === 0) {
        return { type: "notSwitchable" as const };
      }
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId: booking.id,
        db: tx,
      });
      // #2576 §9. "Payment completion" on the owner's list: this claim confirms the
      // booking, so the hosting facts have to be re-read against it. Recorded inside
      // the transaction — under the same per-lodge capacity lock every
      // coverage-removing path takes, which is what closes the confirm-while-source-
      // removed race — and drained after commit.
      //
      // ESCALATED RATHER THAN REFUSED, deliberately, and this is the one member-
      // facing confirmation where that is right: the member is not changing the
      // party or the nights, they are choosing how to pay for a booking that already
      // exists and already holds beds. Refusing here would leave them unable to pay
      // for it, which is not one of the three actions §6 tells a member to take.
      await enqueueOwnHostingCoverageReevaluation(booking.id, tx, {
        cause: "SYSTEM_CHANGE",
      });
    }

    await recordInternetBankingPaymentTransaction({
      paymentId: payment.id,
      amountCents,
      status: PaymentStatus.PENDING,
      reference,
      reason: "internet_banking_switch_at_pay",
      store: tx,
    });

    return { type: "updated" as const, payment, creditElection };
  }).catch((err: unknown) => {
    // The "credit covers it all" bail is signalled by a throw so the whole
    // transaction rolls back and the election goes back on the booking. Turn it
    // into an ordinary outcome here; every other error still propagates.
    if (err instanceof CreditCoversWholeBookingError) {
      return { type: "creditCoversBooking" as const };
    }
    if (isHostingCoverageParticipantRetry(err)) {
      return { type: "hostingCoverageRetry" as const };
    }
    throw err;
  });

  if (paymentResult.type === "hostingCoverageRetry") {
    return NextResponse.json(HOSTING_COVERAGE_RETRY_BODY, { status: 409 });
  }

  if (paymentResult.type === "creditCoversBooking") {
    return NextResponse.json(
      {
        error:
          "Your account credit covers this booking in full, so there is nothing to pay by Internet Banking. Complete it from the booking page.",
        code: "CREDIT_COVERS_BOOKING",
      },
      { status: 409 },
    );
  }

  if (paymentResult.type === "capacityExceeded") {
    return NextResponse.json(
      {
        error: "The lodge is fully booked on some of your requested dates.",
        code: "CAPACITY_EXCEEDED",
      },
      { status: 409 },
    );
  }

  if (paymentResult.type === "notSwitchable") {
    // A concurrent cancel/modify moved the booking out of PAYMENT_PENDING while
    // we waited on the locks (#1881). Nothing was written; report a conflict.
    return NextResponse.json(
      { error: "This booking can no longer switch to Internet Banking." },
      { status: 409 },
    );
  }

  // #2576 §9: drain the re-evaluation the claim above recorded, now that the
  // confirmation has committed. Best-effort; the cron sweep is the authority.
  await settleHostingCoverageAfterCommit({ bookingId: booking.id });

  try {
    const queued = await enqueueXeroBookingInvoiceOperation(booking.id, {
      createdByMemberId: session.user.id,
    });
    // #1620 — enqueue the applied-credit allocation AFTER the invoice op (older
    // createdAt → processed first) so the invoice exists when the allocation
    // runs; if not yet raised the allocation handler throws and the outbox
    // retries. Skips itself when there is no unallocated applied credit.
    const queuedAllocation = await enqueueXeroAppliedCreditAllocationOperation(
      booking.id,
      { createdByMemberId: session.user.id },
    );
    if (
      (queued.queueOperationId || queuedAllocation.queueOperationId) &&
      (await isXeroConnected())
    ) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 2 });
    }
  } catch (err) {
    logger.error(
      { err, bookingId },
      "Failed to queue Xero invoice after switching to Internet Banking"
    );
  }

  return NextResponse.json({
    reference,
    holdBedSlots,
    holdUntil,
    // #2265 — the same payload the card pay step returns, so a clamped election
    // is reported here too rather than applied in silence. Null when this
    // booking carried no outstanding election.
    creditElection: paymentResult.creditElection,
  });
}
