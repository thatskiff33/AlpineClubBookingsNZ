/**
 * Group bookings — organiser-cancel cleanup.
 *
 * When the organiser cancels their host booking, the existing cancel path
 * (booking-cancel.ts) cancels and refunds the organiser's *own* booking and any
 * linked provisional (PENDING) non-member child. That leaves a gap for groups:
 *
 *   - EACH_PAYS_OWN joiners own and pay their own independent child bookings, so
 *     they are intentionally left intact; we only close the group to new joins.
 *
 *   - ORGANISER_PAYS joiners rely entirely on the organiser to settle. Their
 *     child bookings are never PENDING (they are PAYMENT_PENDING, then CONFIRMED
 *     once the organiser commits to settle, then PAID), so the PENDING-only
 *     cleanup never touches them. Cancelling the organiser would otherwise strand
 *     them: CONFIRMED beds keep holding lodge capacity with the payer gone, and
 *     nothing can ever be settled. This module cancels those children, releases
 *     their beds, and — for a group that was already settled — refunds the
 *     organiser.
 *
 * The settlement is a single Stripe PaymentIntent for the combined total, so the
 * refund is one Stripe refund. The refund amount follows the *same* date-based
 * cancellation policy as the organiser's own booking and every normal booking
 * (calculateRefundAmount), applied per paid child so each child's Xero refund
 * credit note (allocated against that child's own settlement invoice) sums
 * exactly to the single Stripe refund.
 *
 * Conventions match group-booking.ts: integer cents, NZ date-only booking dates,
 * Stripe/Xero calls run outside the database transaction. Everything here is
 * best-effort and idempotent: the Stripe refund carries an idempotency key, the
 * settlement guards on its own status, and already-CANCELLED children are skipped
 * by the status filter, so a re-run never double-refunds or double-cancels.
 *
 * Re-drivability (#1236): the first run persists the per-child refund plan
 * ({childId: cents}) on the settlement BEFORE the Stripe refund and BEFORE the
 * settlement flips to REFUNDED/PARTIALLY_REFUNDED. A crash-interrupted re-drive
 * (the group-settlement-reaper resume phase re-invokes this function)
 * reconstructs that plan verbatim rather than recomputing it: the per-child
 * refundedAmountCents mirror is the record of record for these organiser-settled
 * refunds, and daysUntilDate can land in a different cancellation tier on a >24h
 * re-drive, so recomputing the mirror amount would be unsafe.
 *
 * Refund durability (F3, #1351, owner-decided auto-retry): a durable recovery
 * operation is enqueued BEFORE the inline Stripe refund (the #1349
 * enqueue-then-execute pattern, delayed so the cron only claims it when this
 * run failed or died) and marked SUCCEEDED after the flip. A transient Stripe
 * failure no longer abandons the organiser's refund: the persisted plan is
 * KEPT frozen, the children are still cancelled (beds must release now) with
 * their refund mirrors deferred, and executeGroupSettlementRefundPlan replays
 * the refund under the same `group_cancel_refund_<settlementId>` key, flips
 * the settlement, applies the per-child mirrors idempotently (only for
 * already-CANCELLED plan children whose mirror is still zero — ACTIVE
 * children stay owned by the reaper resume path), and enqueues their Xero
 * credit notes. Admins are alerted only when the recovery retries exhaust.
 *
 * Credit-note durability (F21 #3, #1257/#1377): the inline per-child refund
 * credit-note enqueue is a DB outbox insert, so it now commits INSIDE the same
 * transaction as the child cancel + refund mirror (store: tx). A crash can no
 * longer strand a CANCELLED child with its mirror written but no credit-note
 * operation queued — the drift is closed for every source, including
 * Internet-Banking children the #1354 daily reconcile self-heal cannot recover
 * (they carry no per-child xeroInvoiceId). A resume/replay never re-derives
 * money; it only completes an interrupted cleanup.
 */
import {
  BookingEventType,
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "./prisma";
import { processRefund, cancelPaymentIntentIfCancellable } from "./stripe";
import {
  calculateRefundAmount,
  daysUntilDate,
  loadCancellationPolicy,
} from "./cancellation";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "./bed-allocation-lifecycle";
import {
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
  RELEASE_WHOLE_LODGE_HOLD_UPDATE,
} from "./booking-status";
import { revokePaymentLinksForBooking } from "./payment-link";
import { recordBookingEvent } from "./booking-events";
import { logAudit } from "./audit";
import { sendBookingCancelledEmail } from "./email";
import { processWaitlistForDates } from "./waitlist";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "./xero-operation-outbox";
import { isXeroConnected } from "./xero";
import {
  enqueueGroupSettlementRefundRecovery,
  markGroupSettlementRefundRecoverySucceeded,
} from "@/lib/payment-recovery";
import { enqueueXeroGroupSettlementInvoiceVoidOperation } from "@/lib/xero-group-settlement-void-outbox";
import logger from "@/lib/logger";

/** Child booking statuses that an organiser cancel must clean up. */
const ACTIVE_CHILD_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
] as const;

// F3 (#1351): the recovery operation is enqueued BEFORE the inline Stripe
// refund, so the cron must not claim it while this run is still executing.
// Ten minutes comfortably outlives one Stripe call plus the child loop; an
// inline FAILURE re-arms the operation for immediate retry, and the inline
// happy path closes it, so the delay only ever matters after a process death.
const GROUP_SETTLEMENT_REFUND_RETRY_DELAY_MS = 10 * 60 * 1000;

/**
 * Anchor Payment row for the settlement's recovery operation FK (#1351): the
 * organiser's own payment when it exists, else any settled child's. The
 * processor never reads it — the group-settlement branch dispatches on the
 * idempotency-key prefix before any payment lookup.
 */
async function resolveSettlementRecoveryAnchorPaymentId(
  organiserBookingId: string,
  children: ReadonlyArray<{ payment: { id: string } | null }>
): Promise<string | null> {
  const organiserPayment = await prisma.payment.findUnique({
    where: { bookingId: organiserBookingId },
    select: { id: true },
  });
  return (
    organiserPayment?.id ??
    children.find((candidate) => candidate.payment)?.payment?.id ??
    null
  );
}

/**
 * Deserialize a persisted refund plan ({childId: cents}) into a Map, defensively.
 * Only finite non-negative integer cent values survive; malformed entries are
 * skipped and a non-object never throws. The plan is applied verbatim on a
 * re-drive, so a corrupt entry must degrade to "no refund for that child" rather
 * than crash the cleanup.
 */
function deserializeRefundPlan(value: unknown): Map<string, number> {
  const plan = new Map<string, number>();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return plan;
  }
  for (const [childId, cents] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (typeof cents === "number" && Number.isInteger(cents) && cents >= 0) {
      plan.set(childId, cents);
    }
  }
  return plan;
}

async function markGroupCancelled(groupBookingId: string): Promise<void> {
  await prisma.groupBooking.update({
    where: { id: groupBookingId },
    data: { status: GroupBookingStatus.CANCELLED },
  });
}

/**
 * Clean up a group when its organiser cancels the host booking. A no-op when the
 * cancelled booking does not host a group. Never throws: the organiser's own
 * cancellation has already committed, so failures here are logged loudly rather
 * than surfaced (the refund is idempotent and the work is safe to re-run).
 */
export async function settleGroupBookingOnOrganiserCancel(
  organiserBookingId: string,
  sessionUserId: string,
  ipAddress: string
): Promise<void> {
  const group = await prisma.groupBooking.findUnique({
    where: { organiserBookingId },
    include: { settlement: true },
  });
  if (!group) {
    return; // The cancelled booking does not host a group.
  }

  // EACH_PAYS_OWN: joiners own and pay their own bookings; leave them untouched.
  // Just close the group so it accepts no further joins.
  if (group.paymentMode !== GroupBookingPaymentMode.ORGANISER_PAYS) {
    await markGroupCancelled(group.id);
    return;
  }

  // Durable cancellation fence: settle/reaper/cancel all serialize on lock(1).
  // Once CANCELLED commits, a later settlement apply must refuse to promote
  // children. If settle won first, the post-fence reads below observe its
  // SUCCEEDED/PAID state and run the refund path. No provider call occurs while
  // this transaction is open.
  const cancellationFence = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await tx.groupBooking.update({
      where: { id: group.id },
      data: { status: GroupBookingStatus.CANCELLED },
    });
    // Return the exact settlement identity that existed at the cancellation
    // serialization point.  A pre-lock null must stay null (a later creator is
    // fenced by CANCELLED), while a pre-lock re-point to a newer intent must
    // cancel/fail that newer intent rather than the stale route snapshot.
    const settlement = await tx.groupBookingSettlement.findUnique({
      where: { groupBookingId: group.id },
    });
    const queuedVoid = settlement?.xeroInvoiceId
      ? await enqueueXeroGroupSettlementInvoiceVoidOperation(settlement.id, {
          createdByMemberId: sessionUserId,
          store: tx,
        })
      : null;
    return {
      settlement,
      queuedVoidOperationId: queuedVoid?.queueOperationId ?? null,
    };
  });

  // The compensating row committed atomically with CANCELLED.  This kick is
  // opportunistic only; the normal outbox cron owns durable retry.
  if (cancellationFence.queuedVoidOperationId) {
    void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((err) =>
      logger.error(
        { err, groupBookingId: group.id },
        "Failed to kick queued Xero group-invoice VOID after cancellation"
      )
    );
  }

  const children = await prisma.booking.findMany({
    where: {
      parentBookingId: organiserBookingId,
      organiserSettled: true,
      deletedAt: null,
      status: { in: [...ACTIVE_CHILD_STATUSES] },
    },
    include: { member: true, payment: true },
  });

  let settlement = cancellationFence.settlement;

  // Mid-settlement: an open (PENDING) intent with children committed to CONFIRMED
  // but not yet captured. Void the intent and fail the settlement BEFORE
  // cancelling the children, so the success webhook — which only settles CONFIRMED
  // children — cannot charge the organiser for beds we are about to release.
  if (
    settlement &&
    settlement.status === PaymentStatus.PENDING &&
    settlement.stripePaymentIntentId
  ) {
    // Capture the non-null row in a const so the async closure below keeps the
    // narrowing (`settlement` is now a `let`, reassigned after the reload).
    const openSettlement = settlement;
    // The Stripe void is an external provider call — keep it OUTSIDE the DB
    // transaction (the whole point of the lock discipline).
    try {
      await cancelPaymentIntentIfCancellable(openSettlement.stripePaymentIntentId!);
    } catch (err) {
      logger.error(
        { err, groupBookingId: group.id },
        "Failed to void open group settlement intent on organiser cancel"
      );
    }
    // #1881 — the FAILED claim was previously a bare `update` gated on a STALE
    // in-memory status read, taking NO lock, so it could not mutually exclude a
    // concurrent settle/reaper (which now serialise on lock(1)). Mirror
    // markGroupSettlementIntentFailed: take lock(1), re-read, and status-guard
    // the FAILED claim so a settle that captured the organiser's money under
    // the same lock is never clobbered back to FAILED.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await tx.groupBookingSettlement.updateMany({
        where: {
          id: openSettlement.id,
          stripePaymentIntentId: openSettlement.stripePaymentIntentId,
          status: PaymentStatus.PENDING,
        },
        data: { status: PaymentStatus.FAILED },
      });
    });
  }

  // #1881 — RELOAD the FULL settlement row AFTER the guarded FAILED claim so
  // every refund decision below reads ONE consistent status. A concurrent
  // settle can capture the organiser's money under lock(1) between the initial
  // load (~:197) and here, flipping the settlement PENDING -> SUCCEEDED and the
  // children CONFIRMED -> PAID. Reading only a repointed `settled` flag while
  // the refund-firing guard, the REFUNDED/PARTIALLY_REFUNDED flip and its
  // decision still read the STALE in-memory row was strictly worse than no
  // re-read: `settled` would compute + persist a refund plan, but the stale
  // guard (status !== SUCCEEDED) would SKIP the whole refund block — no Stripe
  // refund, no REFUNDED flip, no durable recovery armed — while the child loop
  // still wrote phantom per-child refund mirrors for money that never moved.
  // Reassigning `settlement` to the fresh row makes the plan, the Stripe
  // refund, the status flip, the recovery enqueue, and the per-child mirrors
  // all agree on one status: when settle won the race (now SUCCEEDED) the
  // owed refund FIRES and recovery is armed; a stale read can no longer strand
  // the organiser's money behind phantom mirrors.
  if (settlement) {
    const freshSettlement = await prisma.groupBookingSettlement.findUnique({
      where: { id: settlement.id },
    });
    if (freshSettlement) {
      settlement = freshSettlement;
    }
  }

  // Refund the organiser when the group was already settled. Only genuinely PAID
  // children were charged (a member could have joined after settlement and still
  // be unpaid), so the policy refund is computed per paid child and summed.
  //
  // The plan is reconstructed UNCONDITIONALLY from any persisted refundPlan: a
  // previous (crash-interrupted) run flips the settlement to REFUNDED before the
  // child-loop finishes, so gating the reconstruct on `settled` would lose the
  // plan and cancel the remaining paid children WITHOUT their refund mirror.
  // Reconstruct never recomputes — see the header (tier drift on a >24h re-drive).
  const settled = settlement?.status === PaymentStatus.SUCCEEDED;
  let refundByChildId = new Map<string, number>();
  let totalRefundCents = 0;

  if (settlement?.refundPlan != null) {
    // A previous (crash-interrupted) run already computed + persisted the plan.
    // Reuse it verbatim; NEVER recompute.
    refundByChildId = deserializeRefundPlan(settlement.refundPlan);
    for (const cents of refundByChildId.values()) {
      totalRefundCents += cents;
    }
  } else if (settled && children.length > 0) {
    const checkIn = children[0].checkIn;
    const days = daysUntilDate(checkIn);
    // All children of a group booking share the organiser's lodge (one
    // booking = one lodge, ADR-001), so the first child's lodge is the group's.
    const policy = await loadCancellationPolicy(checkIn, children[0].lodgeId);
    for (const child of children) {
      const isPaid =
        child.status === BookingStatus.PAID &&
        child.payment?.status === PaymentStatus.SUCCEEDED;
      if (!isPaid) {
        continue;
      }
      const { refundAmountCents } = calculateRefundAmount(
        child.finalPriceCents,
        days,
        policy,
        "card"
      );
      if (refundAmountCents > 0) {
        refundByChildId.set(child.id, refundAmountCents);
        totalRefundCents += refundAmountCents;
      }
    }

    // Persist the plan BEFORE the refund + flip so a crash anywhere downstream
    // re-drives with the RECORDED per-child amounts instead of recomputing.
    if (totalRefundCents > 0) {
      await prisma.groupBookingSettlement.update({
        where: { id: settlement!.id },
        data: {
          refundPlan: Object.fromEntries(
            refundByChildId
          ) as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }

  // Refund + settlement flip, guarded on SUCCEEDED so it fires exactly once
  // across re-drives: the plan survives this flip, so a re-drive after the flip
  // skips this block and only applies the reconstructed mirror below (crash after
  // flip). The Stripe idempotency key dedups a crash between refund and flip.
  if (
    totalRefundCents > 0 &&
    settlement?.stripePaymentIntentId &&
    // #1881 — the SAME fresh-status value the plan was computed from, so the
    // plan, the refund, the flip and the mirrors never disagree on the status.
    settled
  ) {
    // F3 (#1351): persist the retry debt BEFORE the Stripe call. The anchor
    // paymentId satisfies the recovery-op schema FK only; the processor
    // dispatches on the key prefix and never derives money from it. The
    // delay keeps the cron from racing this very run; the inline happy path
    // closes the operation right after the flip.
    let recoveryEnqueued = false;
    try {
      const anchorPaymentId = await resolveSettlementRecoveryAnchorPaymentId(
        organiserBookingId,
        children
      );
      if (anchorPaymentId) {
        await enqueueGroupSettlementRefundRecovery({
          organiserBookingId,
          paymentId: anchorPaymentId,
          settlementId: settlement.id,
          paymentIntentId: settlement.stripePaymentIntentId,
          amountCents: totalRefundCents,
          retryDelayMs: GROUP_SETTLEMENT_REFUND_RETRY_DELAY_MS,
        });
        recoveryEnqueued = true;
      } else {
        logger.error(
          { groupBookingId: group.id, settlementId: settlement.id },
          "No anchor payment row for group settlement refund recovery; retry will not be durable"
        );
      }
    } catch (enqueueErr) {
      logger.error(
        { err: enqueueErr, groupBookingId: group.id, settlementId: settlement.id },
        "Failed to enqueue group settlement refund recovery before the inline refund"
      );
    }

    try {
      await processRefund({
        paymentIntentId: settlement.stripePaymentIntentId,
        amountCents: totalRefundCents,
        metadata: {
          groupBookingId: group.id,
          reason: "organiser_cancellation",
        },
        // Key by the stable settlement id, not the tier-dependent amount.
        // The amount-in-key was a foot-gun: a >24h re-run in a different policy
        // tier would compute a different amount -> a different key -> a second
        // refund, and within 24h the same-key/different-params call errors.
        // Keying by settlement id removes the foot-gun (belt-and-suspenders),
        // but the real guarantee this refund runs once is #1160's upstream
        // single-flight cancel plus this SUCCEEDED guard — the persisted plan
        // makes the re-drive skip this block rather than re-refund. The
        // recovery replay (#1351) reuses this exact key, so an ambiguous
        // failure (Stripe refunded, response lost) is replayed, not repeated.
        idempotencyKey: `group_cancel_refund_${settlement.id}`,
      });
      await prisma.groupBookingSettlement.update({
        where: { id: settlement.id },
        data: {
          status:
            totalRefundCents >= settlement.amountCents
              ? PaymentStatus.REFUNDED
              : PaymentStatus.PARTIALLY_REFUNDED,
        },
      });
      if (recoveryEnqueued) {
        await markGroupSettlementRefundRecoverySucceeded({
          settlementId: settlement.id,
        }).catch((markErr) =>
          logger.error(
            { err: markErr, settlementId: settlement.id },
            "Failed to close group settlement refund recovery; the replay is a safe no-op"
          )
        );
      }
    } catch (err) {
      // F3 (#1351, owner-decided durable auto-retry — this branch previously
      // ABANDONED the refund: it nulled the persisted plan and left the
      // settlement SUCCEEDED 'for an operator to reconcile' with no alert and
      // no re-attempt path). Now: KEEP the plan frozen (a >24h retry must
      // execute the recorded tier, never recompute), zero this run's
      // per-child refund view so the loop below still cancels the children
      // and releases their beds WITHOUT writing refund mirrors (no money has
      // moved), and pull the pre-persisted recovery operation forward for an
      // immediate first retry. The replay reuses the same Stripe key, flips
      // the settlement, applies the mirrors, and enqueues the Xero credit
      // notes; admins are alerted only if its retries exhaust.
      const plannedRefundCents = totalRefundCents;
      logger.error(
        { err, groupBookingId: group.id, totalRefundCents: plannedRefundCents },
        "Failed to refund group settlement on organiser cancel; durable recovery will retry with the frozen plan"
      );
      refundByChildId.clear();
      totalRefundCents = 0;
      try {
        const anchorPaymentId = await resolveSettlementRecoveryAnchorPaymentId(
          organiserBookingId,
          children
        );
        if (anchorPaymentId) {
          await enqueueGroupSettlementRefundRecovery({
            organiserBookingId,
            paymentId: anchorPaymentId,
            settlementId: settlement.id,
            paymentIntentId: settlement.stripePaymentIntentId,
            amountCents: plannedRefundCents,
            retryDelayMs: 0,
            lastError: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (enqueueErr) {
        logger.error(
          { err: enqueueErr, groupBookingId: group.id, settlementId: settlement.id },
          "Failed to re-arm group settlement refund recovery after inline refund failure"
        );
      }
    }
  }

  for (const child of children) {
    const refundForChild = refundByChildId.get(child.id) ?? 0;
    // Captured from inside the per-child tx so the best-effort outbox worker
    // kick can run POST-commit (the enqueue itself is now durable — below).
    let queuedCreditNoteOperationId: string | null = null;
    let childClaimed = false;
    try {
      queuedCreditNoteOperationId = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        const cancelled = await tx.booking.updateMany({
          where: { id: child.id, status: { in: [...ACTIVE_CHILD_STATUSES] } },
          data: {
            status: BookingStatus.CANCELLED,
            ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
            // Best-effort field clearing (#177): this bulk group-cancel child
            // transition has no per-booking audit context, so it mirrors the
            // capacity-hold sibling — clear the stale hold, no released audit.
            ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
          },
        });
        if (cancelled.count === 0) return null;
        childClaimed = true;
        await reconcileBedAllocationsForBookingWithGlobalLockHeld({
          bookingId: child.id,
          db: tx,
          previousRange: { checkIn: child.checkIn, checkOut: child.checkOut },
        });
        await revokePaymentLinksForBooking(child.id, tx);
        if (refundForChild > 0 && child.payment) {
          // Ledger bypass is acceptable here: these organiser-settled child
          // payments have no PaymentTransaction rows (they were paid via the
          // combined settlement PI, not per-child intents), so there is no
          // ledger to post against — the per-child refundedAmountCents is the
          // record of record for these refunds.
          const nextRefunded = Math.min(
            child.payment.amountCents,
            child.payment.refundedAmountCents + refundForChild
          );
          await tx.payment.update({
            where: { id: child.payment.id },
            data: {
              refundedAmountCents: nextRefunded,
              status:
                nextRefunded >= child.payment.amountCents
                  ? PaymentStatus.REFUNDED
                  : PaymentStatus.PARTIALLY_REFUNDED,
            },
          });
          // Xero refund credit note per paid child, allocated against that
          // child's own settlement invoice so the books balance per joiner.
          // Enqueued INSIDE this tx (store: tx) so the outbox row commits
          // atomically with the child cancel + refund mirror (#1257/#1377):
          // the enqueue is a DB outbox insert, not a Xero HTTP call, so it
          // may join the transaction safely. This closes the crash window
          // between the child-cancel commit and a post-commit enqueue — a
          // window that permanently stranded non-Stripe (Internet-Banking)
          // children, which carry no per-child xeroInvoiceId for the #1354
          // daily reconcile self-heal to recover. If the enqueue fails, the
          // whole child-cancel tx rolls back so no CANCELLED child is ever left
          // with a written refund mirror but no queued credit-note op (the
          // invariant this closes). On a genuine crash the reaper re-drives the
          // still-ACTIVE child; a caught-but-survived error follows the same
          // pre-existing best-effort `continue` below (the reaper only re-drives
          // not-yet-CANCELLED groups) — this fix adds no new reachable drift.
          const queued = await enqueueXeroRefundCreditNoteOperation(
            child.payment.id,
            refundForChild,
            { createdByMemberId: sessionUserId, store: tx }
          );
          return queued.queueOperationId;
        }
        return null;
      });
    } catch (err) {
      logger.error(
        { err, bookingId: child.id, groupBookingId: group.id },
        "Failed to cancel group joiner booking on organiser cancel"
      );
      continue;
    }

    if (!childClaimed) continue;

    // Best-effort outbox worker kick, kept POST-commit (the outbox cron drains
    // the row regardless). Never inside the tx: that would put a Xero provider
    // HTTP call in the transaction.
    if (queuedCreditNoteOperationId && (await isXeroConnected())) {
      void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch(
        (xeroErr) =>
          logger.error(
            { err: xeroErr, bookingId: child.id },
            "Failed to kick Xero refund credit note worker after organiser cancel"
          )
      );
    }

    logAudit({
      action: "booking.cancel",
      memberId: sessionUserId,
      targetId: child.id,
      subjectMemberId: child.memberId,
      entityType: "Booking",
      entityId: child.id,
      category: "booking",
      severity: "critical",
      outcome: "success",
      summary: "Group joiner booking cancelled with organiser cancel",
      details:
        refundForChild > 0
          ? `Group organiser cancelled; refunded ${refundForChild} cents of the settled beds to the organiser`
          : "Group organiser cancelled; released the held spot (no payment taken)",
      metadata: {
        groupBookingId: group.id,
        organiserBookingId,
        statusBefore: child.status,
        refundForChild,
        paymentId: child.payment?.id ?? null,
      },
      ipAddress,
    });

    await recordBookingEvent({
      bookingId: child.id,
      type: refundForChild > 0 ? BookingEventType.REFUNDED : BookingEventType.CANCELLED,
      actorMemberId: sessionUserId,
      amountCents: refundForChild > 0 ? refundForChild : undefined,
      reason:
        refundForChild > 0
          ? "Group organiser cancelled the booking; the settled beds were refunded to the organiser."
          : "Group organiser cancelled the booking, releasing this held spot.",
    }).catch((err) =>
      logger.error(
        { err, bookingId: child.id },
        "Failed to record booking event for cancelled group joiner"
      )
    );

    sendBookingCancelledEmail(
      { bookingId: child.id, recipientMemberId: child.memberId },
      child.member.email,
      child.member.firstName,
      child.checkIn,
      child.checkOut,
      refundForChild,
      "card",
      0,
      child.lodgeId
    ).catch((err) =>
      logger.error(
        { err, bookingId: child.id },
        "Failed to send cancellation email to group joiner"
      )
    );

    processWaitlistForDates({
      checkIn: child.checkIn,
      checkOut: child.checkOut,
      lodgeId: child.lodgeId,
    }).catch((err) =>
      logger.error(
        { err, bookingId: child.id },
        "Failed to process waitlist after group joiner cancellation"
      )
    );
  }

  // The group was fenced CANCELLED before provider calls and child cleanup.

  logger.info(
    {
      groupBookingId: group.id,
      organiserBookingId,
      cancelledChildren: children.length,
      totalRefundCents,
    },
    "Cleaned up group booking on organiser cancel"
  );
}

type GroupSettlementRefundReplayOutcome =
  | "refunded"
  | "already_refunded"
  | "nothing_to_do"
  | "not_refundable";

export type GroupSettlementRefundReplayResult = {
  outcome: GroupSettlementRefundReplayOutcome;
  mirroredChildren: number;
};

/**
 * Replay an organiser-cancel settlement refund from the settlement's
 * PERSISTED refund plan (F3, #1351). Invoked by the payment-recovery cron for
 * `group_settlement_refund_recovery_<settlementId>` operations after the
 * inline refund failed or the process died mid-cancel.
 *
 * Frozen-tier contract: the plan is applied VERBATIM — this function never
 * calls calculateRefundAmount, so a >24h retry can never land in a different
 * cancellation tier than the one recorded at cancel time.
 *
 * Idempotency:
 * - The Stripe refund reuses the inline `group_cancel_refund_<settlementId>`
 *   key, so an ambiguous inline failure (Stripe refunded, response lost) is
 *   answered with the original refund, never repeated.
 * - The settlement flip is guarded on SUCCEEDED; a crash-after-flip replay
 *   lands in the already_refunded branch and only completes the mirrors.
 * - Per-child refundedAmountCents mirrors are applied only to plan children
 *   whose booking is already CANCELLED (the inline loop is done with them)
 *   and whose mirror is still zero, via a conditional updateMany — so this
 *   can never double-apply against the inline loop or the #1236 reaper
 *   resume path, which own ACTIVE children.
 * - Xero credit-note enqueues are deduplicated by the outbox (watermark /
 *   canonical-note logic), keyed off the mirror written just before.
 *
 * Throws on Stripe failure so the recovery machinery applies backoff and
 * alerts only when retries exhaust (owner decision, 2026-07-06).
 */
export async function executeGroupSettlementRefundPlan(
  settlementId: string
): Promise<GroupSettlementRefundReplayResult> {
  const settlement = await prisma.groupBookingSettlement.findUnique({
    where: { id: settlementId },
    include: { groupBooking: true },
  });
  if (!settlement) {
    logger.warn(
      { settlementId },
      "Group settlement refund replay found no settlement; nothing to do"
    );
    return { outcome: "nothing_to_do", mirroredChildren: 0 };
  }

  const plan = deserializeRefundPlan(settlement.refundPlan);
  let totalRefundCents = 0;
  for (const cents of plan.values()) {
    totalRefundCents += cents;
  }
  if (totalRefundCents <= 0) {
    return { outcome: "nothing_to_do", mirroredChildren: 0 };
  }

  let outcome: GroupSettlementRefundReplayOutcome;
  if (settlement.status === PaymentStatus.SUCCEEDED) {
    if (!settlement.stripePaymentIntentId) {
      // Internet-Banking settlements have no Stripe leg to refund; their
      // reconciliation is operator-driven and never enqueues this operation.
      return { outcome: "not_refundable", mirroredChildren: 0 };
    }
    await processRefund({
      paymentIntentId: settlement.stripePaymentIntentId,
      amountCents: totalRefundCents,
      metadata: {
        groupBookingId: settlement.groupBookingId,
        reason: "organiser_cancellation",
      },
      idempotencyKey: `group_cancel_refund_${settlement.id}`,
    });
    await prisma.groupBookingSettlement.update({
      where: { id: settlement.id },
      data: {
        status:
          totalRefundCents >= settlement.amountCents
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
      },
    });
    outcome = "refunded";
  } else if (
    settlement.status === PaymentStatus.REFUNDED ||
    settlement.status === PaymentStatus.PARTIALLY_REFUNDED
  ) {
    // Crash between the inline flip and the mirror writes: only the mirrors
    // are outstanding.
    outcome = "already_refunded";
  } else {
    // FAILED/PENDING settlement: the plan is moot (nothing was captured or
    // the settlement was voided); do not move money.
    return { outcome: "not_refundable", mirroredChildren: 0 };
  }

  let mirroredChildren = 0;
  for (const [childId, refundForChild] of plan) {
    if (refundForChild <= 0) continue;

    const child = await prisma.booking.findUnique({
      where: { id: childId },
      include: { payment: true },
    });
    // ACTIVE children still belong to the inline loop / reaper resume path,
    // which cancel + mirror atomically; touching them here could double-apply.
    if (!child || child.status !== BookingStatus.CANCELLED) continue;
    if (!child.payment || child.payment.refundedAmountCents > 0) continue;

    const nextRefunded = Math.min(child.payment.amountCents, refundForChild);
    // Conditional write: organiser-settled child payments receive refunds
    // ONLY from this module, so refundedAmountCents === 0 means unmirrored.
    // Mirror and durable Xero outbox insertion are one atomic unit.  Previously
    // the mirror committed first and enqueue failures were swallowed, leaving a
    // permanently stranded accounting operation that replay would skip because
    // refundedAmountCents was already non-zero.
    const mirrorResult = await prisma.$transaction(async (tx) => {
      const applied = await tx.payment.updateMany({
        where: { id: child.payment!.id, refundedAmountCents: 0 },
        data: {
          refundedAmountCents: nextRefunded,
          status:
            nextRefunded >= child.payment!.amountCents
              ? PaymentStatus.REFUNDED
              : PaymentStatus.PARTIALLY_REFUNDED,
        },
      });
      if (applied.count !== 1) {
        return { applied: false, queuedOperationId: null };
      }
      const queued = await enqueueXeroRefundCreditNoteOperation(
        child.payment!.id,
        nextRefunded,
        { store: tx }
      );
      return { applied: true, queuedOperationId: queued.queueOperationId };
    });
    if (!mirrorResult.applied) continue;
    mirroredChildren += 1;

    if (mirrorResult.queuedOperationId && (await isXeroConnected())) {
        void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch(
          (xeroErr) =>
            logger.error(
              { err: xeroErr, bookingId: child.id },
              "Failed to kick Xero refund credit note worker after settlement refund replay"
            )
        );
    }

    logAudit({
      action: "booking.payment.refund_recovered",
      targetId: child.id,
      subjectMemberId: child.memberId,
      entityType: "Booking",
      entityId: child.id,
      category: "booking",
      severity: "critical",
      outcome: "success",
      summary: "Group settlement refund recovered",
      details: `Recovered the organiser's settlement refund for this cancelled group joiner: ${nextRefunded} cents (frozen plan replay).`,
      metadata: {
        settlementId,
        groupBookingId: settlement.groupBookingId,
        refundForChild: nextRefunded,
        paymentId: child.payment.id,
        replayOutcome: outcome,
      },
    });

    await recordBookingEvent({
      bookingId: child.id,
      type: BookingEventType.REFUNDED,
      actorMemberId: null,
      amountCents: nextRefunded,
      reason:
        "The organiser's settlement refund for this cancelled group booking was recovered and refunded to the organiser.",
    }).catch((eventErr) =>
      logger.error(
        { err: eventErr, bookingId: child.id },
        "Failed to record booking event during settlement refund replay"
      )
    );
  }

  logger.info(
    { settlementId, outcome, mirroredChildren, totalRefundCents },
    "Group settlement refund replay completed"
  );

  return { outcome, mirroredChildren };
}
