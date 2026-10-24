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
import {
  CAPACITY_RACE_REFUND_EVENT_REASON,
  cancelCardRefundEventReason,
  isCancelCardRefundEvent,
  MADE_BEFORE_PAID_ANOTHER_WAY_SNAPSHOT,
} from "@/lib/cancel-card-refund-event-reason";
import type { ClubFormat } from "@/lib/club-format";
import type { CancellationLedgerSnapshot } from "@/lib/paid-cancellation-event";
import { parsePaidCancellationDecisionSnapshot } from "@/lib/cancellation-settled-money";
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
  /**
   * #3611: what the booking ledger was told the club keeps
   * (`retainedAmountCents` plus applied credit not restored, design §5.1), and
   * the credit figures it rests on. Absent on cancellations before #3611.
   */
  ledger?: CancellationLedgerSnapshot;
  /**
   * #4097 (`INV-PAY-129`): a card cancel whose card refund plan carried less
   * than the refund due - the card's part, the part owed by bank transfer, and
   * the part the club checks first. Absent otherwise.
   */
  cardShortfall?: { cardCents: number; bankCents: number; checkCents: number };
  /**
   * #4125: the system cancelled it, not the member - the dates filled up while
   * payment was completing (the capacity race). Absent on a member's cancel.
   */
  cancelledBecause?: "capacity_race";
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
 * one. The documented exceptions write a DECISION record, not narrative, with a
 * direct, un-swallowed `tx.bookingEvent.create` inside the transition's own
 * transaction, so it must commit or roll back with what it describes:
 * #3638's second-instrument conflict marker
 * (`recordSecondInstrumentMarkerInTransaction`, inside the Xero settle
 * transaction, so a failed insert aborts it and the delivery is retried), the
 * paid-path CANCELLED snapshot (`writePaidCancellationEvent`, #3639,
 * `INV-PAY-106`), so the cancel cannot commit without its decision, and
 * #3672's group payer-switch marker (`releaseUnpaidJoinersToMemberPaysInTx`,
 * `INV-PAY-109`), which must commit or roll back with the switch, and the
 * REFUNDED event of a capacity race's or a member cancel's card refund
 * (`closeRefundRowRecordingEvent`, #4125, #4145), which commits with the
 * recovery row's close that records the refund made.
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
 * #4125: the reason of the capacity race's refund, made - inline or by the
 * recovery runner. Its home is the pure module the narrative reads (`INV-SSOT`).
 */
export { CAPACITY_RACE_REFUND_EVENT_REASON };

/**
 * #4125, #4145 (`INV-PAY-134`): a pre-persisted card refund, made - its
 * recovery row's close and the REFUNDED event the member's narrative reads as
 * the cancellation's settlement, in ONE transaction, so a crash between them
 * cannot lose the event. `close` is the status-guarded move to `SUCCEEDED` (true when THIS
 * close moved the row) - the door's own after its inline attempt, or the
 * recovery runner's (`payment-recovery.ts`). The event is written only when it
 * did, dated by that close and for the amount actually refunded (the frozen
 * plan's total), so it lands EXACTLY ONCE across the two; a closed row is
 * never reopened (`card-refund-failed-later.ts`). A decision record, not
 * narrative: the insert is NOT swallowed, so a failed one rolls the close
 * back, the row stays open, and the runner's replay - answered by Stripe with
 * the original refunds - closes it and records it. Two doors use it: the
 * capacity race (`closeCapacityRaceRefundRecordingEvent`) and the member's
 * cancel's own close (`booking_cancel_refund_recovery_<booking>`); the
 * runner's close of that row records it the same way
 * (`closeCancellationRefundAfterReplay`).
 */
export async function closeRefundRowRecordingEvent(
  input: { bookingId: string; amountCents: number; actorMemberId: string | null; reason: string },
  close: (tx: Prisma.TransactionClient) => Promise<boolean>
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (!(await close(tx))) return false;
    await recordRefundRowEvent(tx, input);
    return true;
  });
}

/**
 * The REFUNDED event a card refund row's close writes (`INV-SSOT`): the close
 * that made it (`closeRefundRowRecordingEvent`), or a "Paid another way" close
 * for the slices Stripe had made first - dated by Stripe's latest refund and
 * marked so (`MADE_BEFORE_PAID_ANOTHER_WAY_SNAPSHOT`, #4145).
 */
export async function recordRefundRowEvent(
  tx: Pick<Prisma.TransactionClient, "bookingEvent">,
  input: { bookingId: string; amountCents: number; actorMemberId: string | null; reason: string; occurredAt?: Date; madeBeforePaidAnotherWay?: boolean },
): Promise<void> {
  await tx.bookingEvent.create({
    data: {
      bookingId: input.bookingId,
      type: BookingEventType.REFUNDED,
      occurredAt: input.occurredAt,
      actorMemberId: input.actorMemberId,
      amountCents: input.amountCents,
      reason: input.reason,
      snapshot: input.madeBeforePaidAnotherWay ? { ...MADE_BEFORE_PAID_ANOTHER_WAY_SNAPSHOT } : Prisma.JsonNull,
    },
  });
}

/** #4125: the capacity race's close, recording its REFUNDED event as above. */
export function closeCapacityRaceRefundRecordingEvent(
  input: { bookingId: string; amountCents: number; actorMemberId: string | null },
  close: (tx: Prisma.TransactionClient) => Promise<boolean>
): Promise<boolean> {
  return closeRefundRowRecordingEvent({ ...input, reason: CAPACITY_RACE_REFUND_EVENT_REASON }, close);
}

/** Where a member cancel's card refund event is read and written: the base client or a transaction. */
type CancelEventStore = Pick<Prisma.TransactionClient, "bookingEvent">;

/**
 * #4145: the REFUNDED event of a member cancel's card refund, for `amountCents`
 * of it - its reason the cancel's own (`cancelCardRefundEventReason`), from
 * the figures the cancel's CANCELLED snapshot froze (`writePaidCancellationEvent`),
 * said as a part on a card refund shortfall's card part, or for the slices made
 * before the rest was paid another way (`madeBeforePaidAnotherWay`: dated by
 * Stripe's refund and marked so). A cancel with no such snapshot
 * (one made before #3639) is named by its amount. Writes nothing - and says so -
 * when the booking already has one: a cancel made before #4145 wrote its event
 * up front, whatever became of the refund (the deploy boundary).
 */
export async function recordCancelCardRefundEvent(
  store: CancelEventStore,
  input: { bookingId: string; amountCents: number; actorMemberId: string | null; madeBeforePaidAnotherWay: boolean; format: ClubFormat; occurredAt?: Date },
): Promise<boolean> {
  const events = await store.bookingEvent.findMany({
    where: { bookingId: input.bookingId, type: { in: [BookingEventType.CANCELLED, BookingEventType.REFUNDED] } },
    orderBy: { occurredAt: "desc" },
    select: { type: true, reason: true, snapshot: true },
  });
  if (events.some(isCancelCardRefundEvent)) return false;
  const snapshot = events
    .map((event) => (event.type === BookingEventType.CANCELLED ? parsePaidCancellationDecisionSnapshot(event.snapshot) : null))
    .find((each) => each?.refundMethod === "card");
  const reason = cancelCardRefundEventReason({
    cardRefundCents: input.amountCents,
    policy: snapshot ? { refundPercentage: snapshot.refundPercentage, refundAmountCents: snapshot.settledAmountCents } : null,
    shortfall: input.madeBeforePaidAnotherWay || Boolean(snapshot?.cardShortfall),
    format: input.format,
  });
  await recordRefundRowEvent(store, { ...input, reason });
  return true;
}

/**
 * #4145: the recovery runner's close of a member cancel's card refund row,
 * recording its REFUNDED event (`recordCancelCardRefundEvent`) in the close's
 * own transaction, as `closeRefundRowRecordingEvent` does: no member drove it.
 * The row closes whether or not the event is written.
 */
export async function closeCancellationRefundAfterReplay(
  { bookingId, amountCents, format }: { bookingId: string; amountCents: number; format: ClubFormat },
  close: (tx: Prisma.TransactionClient) => Promise<boolean>
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (!(await close(tx))) return false;
    await recordCancelCardRefundEvent(tx, { bookingId, amountCents, actorMemberId: null, madeBeforePaidAnotherWay: false, format });
    return true;
  });
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
