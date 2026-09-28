/**
 * Durable booking-lifecycle event store (issue #740).
 *
 * BookingEvent is a durable narrative fact store, not a complete transition
 * ledger. It captures the facts needed to render a plain-language narrative
 * later (amounts, dates, cancellation-policy snapshot, bump reason) for the
 * transitions that affect member/admin storytelling. Unlike AuditLog these rows
 * are never retention-pruned, so the narratives in `src/lib/booking-narrative.ts`
 * survive audit-log pruning.
 *
 * Status fields, AuditLog, CronJobRun, and provider/payment ledgers remain the
 * complete lifecycle evidence for transitions that do not need narrative facts
 * here, such as waitlist offers, admin review approval, force-confirm, and
 * scheduled completion.
 *
 * BookingEvent is additive: structured AuditLog writes for admin actions still
 * apply. This is a write helper only — it never throws into the caller's
 * transaction path; a failed event write is logged and swallowed so a booking
 * transition is never rolled back purely because its narrative event failed.
 */
import { BookingEventType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  DUPLICATE_CAPTURE_REFUND_EVENT_KIND,
  DUPLICATE_CAPTURE_REFUND_EVENT_REASON,
  type DuplicateCaptureRefundEventSnapshot,
} from "@/lib/duplicate-capture-refund-event";

/** Frozen cancellation facts stored on a CANCELLED event. */
export interface CancellationEventSnapshot {
  /** Human summary of the policy tier in effect at cancellation time. */
  policySummary: string;
  /**
   * B5 (#2262): "manual" means the booking was settled in cash / by an off-Xero
   * bank transfer, so the refund is a durable ManualRefundTask an admin pays
   * back by hand. At cancellation time NO settlement event exists yet for it —
   * the REFUNDED event is written when the task is completed — so the narrative
   * must not read the absent settlement as "no refund was due".
   */
  refundMethod: "card" | "credit" | "manual";
  refundPercentage: number;
  /** Amount the member had paid (net of earlier refunds) before this cancel. */
  paidAmountCents: number;
  /** Amount returned (card refund or account credit) for this cancellation. */
  settledAmountCents: number;
  /** Amount retained by the club under the policy. */
  retainedAmountCents: number;
  /** Non-refundable change fees folded into the retained amount, if any. */
  changeFeeCents?: number;
}

/** Frozen bump facts stored on a BUMPED event. */
export interface BumpEventSnapshot {
  /**
   * True when the member asked us to cancel the whole booking if their guests
   * could not be accommodated (the "only book if my guests can come" flag).
   */
  flagged: boolean;
}

export interface RecordBookingEventInput {
  bookingId: string;
  type: BookingEventType;
  /** Defaults to now() in the database when omitted. */
  occurredAt?: Date;
  actorMemberId?: string | null;
  amountCents?: number | null;
  reason?: string | null;
  snapshot?: Prisma.InputJsonValue | null;
}

type BookingEventClient = Pick<typeof prisma, "bookingEvent">;

/**
 * Write a BookingEvent. Call this AFTER the transition's transaction has
 * committed, on the base client (the default): a failed INSERT inside a
 * Postgres transaction aborts the whole transaction, so a swallowed event
 * failure must never sit inside the transition's own `$transaction`. The `db`
 * parameter exists for tests. Failures are logged and swallowed so a booking
 * transition is never undone purely because its narrative event failed.
 *
 * The ban is on SWALLOWING inside a transaction, not on writing an event in
 * one. Two deliberate exceptions write a direct, un-swallowed event inside the
 * transaction whose change it records, so a failed insert aborts it and the
 * work is retried: #3638's second-instrument conflict marker
 * (`recordSecondInstrumentMarkerInTransaction`), which must commit or roll back
 * with the bank receipt it describes, and #3672's group payer-switch marker
 * (`releaseUnpaidJoinersToMemberPaysInTx`), which must commit or roll back
 * with the switch.
 */
export async function recordBookingEvent(
  input: RecordBookingEventInput,
  db: BookingEventClient = prisma
): Promise<void> {
  try {
    await db.bookingEvent.create({
      data: {
        bookingId: input.bookingId,
        type: input.type,
        occurredAt: input.occurredAt,
        actorMemberId: input.actorMemberId ?? null,
        amountCents: input.amountCents ?? null,
        reason: input.reason ?? null,
        snapshot: input.snapshot ?? Prisma.JsonNull,
      },
    });
  } catch (err) {
    logger.error(
      { err, bookingId: input.bookingId, type: input.type },
      "Failed to record booking event"
    );
  }
}

/**
 * Record the #1992 duplicate-capture auto-refund as a durable, admin-only
 * BookingEvent (#2008).
 *
 * Stored as a REFUNDED event carrying the `duplicate_capture_refund`
 * discriminator snapshot so it is EXCLUDED from the shared member/admin
 * narrative (`isDuplicateCaptureRefundEvent`) — it never masquerades as a later
 * cancellation's settlement clause — while the admin booking-history timeline
 * renders it with honest copy. The booking stays PAID and its settlement money
 * is untouched; `actorMemberId` is null because the refund is system-initiated.
 *
 * Call AFTER the recovery operation's terminal SUCCEEDED transition has been
 * confirmed (the transition is the exactly-once guard across the inline and
 * cron-replay paths), and on the base client — like every recordBookingEvent
 * call, a failed write is logged and swallowed, never rolled into a payment
 * transaction.
 */
export async function recordDuplicateCaptureRefundEvent(
  input: {
    bookingId: string;
    amountCents: number;
    duplicatePaymentIntentId: string;
    settledPaymentIntentId: string | null;
  },
  db: BookingEventClient = prisma
): Promise<void> {
  const snapshot: DuplicateCaptureRefundEventSnapshot = {
    kind: DUPLICATE_CAPTURE_REFUND_EVENT_KIND,
    duplicatePaymentIntentId: input.duplicatePaymentIntentId,
    settledPaymentIntentId: input.settledPaymentIntentId,
    refundedAmountCents: input.amountCents,
  };
  await recordBookingEvent(
    {
      bookingId: input.bookingId,
      type: BookingEventType.REFUNDED,
      // System-initiated auto-refund: no member drove this transition.
      actorMemberId: null,
      amountCents: input.amountCents,
      reason: DUPLICATE_CAPTURE_REFUND_EVENT_REASON,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
    db
  );
}
