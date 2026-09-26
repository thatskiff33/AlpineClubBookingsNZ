/**
 * Chasing an OUTSTANDING additional payment (#2350).
 *
 * When a booking is modified upwards after it was already paid — an admin adds
 * a non-member guest to a PAID booking, say — the extra owed is recorded on the
 * booking's `Payment` row as `additionalAmountCents` with an
 * `additionalPaymentStatus` of PENDING (awaiting the member's card) or FAILED
 * (the charge was attempted and did not go through). Until #2350 nothing ever
 * chased the member for it and no admin surface showed it.
 *
 * This module is the shared, side-effect-free brain for that chase: what counts
 * as owed, when the current obligation began, and which reminder (if any) is due
 * right now. It deliberately imports nothing from Prisma or the server runtime so
 * the admin bookings list, the booking page panel, the reminder cron, and the
 * manual re-send route can all agree by construction.
 *
 * The owed test itself lives in `buildAdditionalOwedWhere`
 * (src/lib/unpaid-finished-stays.ts) for the database side; the predicate here is
 * its in-memory twin and the two must always say the same thing. That claim is
 * only true because BOTH halves test the booking's lifecycle status against the
 * one list below: a cancelled booking carries its delta columns unchanged (the
 * cancel path marks the intent FAILED without zeroing the amount), so an
 * amount-and-status-only test would read a cancelled booking as still owing and
 * we would chase a member for money they do not owe.
 */

/** Days after the extra was raised before the first reminder goes out. */
export const ADDITIONAL_PAYMENT_REMINDER_DAYS = 3;

/**
 * Days before check-in for the last-chance reminder. Deliberately inside the
 * pre-arrival reminder's own 3-day window so the two land close together and a
 * member who is about to travel is told once, clearly, that money is still owing.
 */
export const ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN = 2;

/**
 * How long an admin must wait before re-sending the payment request by hand.
 *
 * BOTH senders consult it, in both directions: the manual re-send refuses inside
 * the window, and the cron treats the window as "not due yet" as well as reading
 * the episode stamps. Stamps alone were not enough — a manual send late on the
 * NZ day before the last-chance window opens writes only the day-N stamp, and
 * the next three-hourly tick after NZ midnight would have found the final
 * reminder unstamped and sent it minutes later. So an automatic nudge and a
 * manual one cannot reach the member inside the same hour; the cost is that a
 * genuinely due reminder can slip to the next tick, which is three hours, not a
 * lost email.
 */
export const ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES = 60;

/**
 * Booking lifecycle statuses whose upward-modification delta is still worth
 * collecting. A CANCELLED or BUMPED booking keeps its `additionalAmountCents`
 * and a PENDING/FAILED `additionalPaymentStatus` after cancellation — nothing
 * zeroes them — so the status is part of the owed test, not context around it.
 *
 * Single source of truth: `buildAdditionalOwedWhere`
 * (src/lib/unpaid-finished-stays.ts) builds its SQL `status: { in: ... }` from
 * this same list.
 */
export const ADDITIONAL_OWED_BOOKING_STATUSES = [
  "CONFIRMED",
  "PAID",
  "COMPLETED",
] as const;

export type AdditionalOwedBookingStatus =
  (typeof ADDITIONAL_OWED_BOOKING_STATUSES)[number];

/** Is this booking in a lifecycle state where an addition is still collectable? */
export function isAdditionalOwedBookingStatus(
  status: string | null | undefined,
): status is AdditionalOwedBookingStatus {
  return (
    status != null &&
    (ADDITIONAL_OWED_BOOKING_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * Booking lifecycle statuses in which a MEMBER may still pay an outstanding
 * upward-modification delta by card.
 *
 * Deliberately ONE status wider than the owed list above, and the extra one is
 * `PAYMENT_PENDING`. That is not a disagreement about whether the money is
 * collectable — it plainly is, and a PAYMENT_PENDING booking can genuinely carry
 * a delta (adding a guest to a booking with an issued Xero invoice raises one,
 * src/app/api/bookings/[id]/guests/route.ts). The admin queues exclude it purely
 * so their counts can be summed with the unpaid-finished-stays queue, which
 * already counts every PAYMENT_PENDING booking, without counting one booking
 * twice (see src/lib/unpaid-finished-stays.ts). Hiding the member's own pay
 * button for a counting reason would strand a real obligation.
 *
 * What the two lists agree on completely is the part that matters for money:
 * CANCELLED and BUMPED are in neither. Cancellation marks the additional intent
 * FAILED without zeroing `additionalAmountCents` and without always cancelling
 * the Stripe intent (`hasOutstandingAdditionalPaymentIntent` in
 * src/lib/booking-cancel.ts skips an intent that is ALREADY FAILED — a declined
 * card leaves the intent confirmable at Stripe), so an amount-and-status-only
 * gate let a member open a cancelled booking, be shown "pay this extra", fetch
 * the client secret and complete the charge. The late-capture backstop (#1350)
 * auto-refunds and alerts, but the member was still charged for a booking that
 * no longer exists. This list is the front door that gate is built from.
 */
export const ADDITIONAL_PAYABLE_BOOKING_STATUSES = [
  ...ADDITIONAL_OWED_BOOKING_STATUSES,
  "PAYMENT_PENDING",
] as const;

export type AdditionalPayableBookingStatus =
  (typeof ADDITIONAL_PAYABLE_BOOKING_STATUSES)[number];

/**
 * Is this booking in a lifecycle state where the MEMBER may still be shown, and
 * allowed to complete, a card payment for an outstanding addition?
 */
export function isAdditionalPayableBookingStatus(
  status: string | null | undefined,
): status is AdditionalPayableBookingStatus {
  return (
    status != null &&
    (ADDITIONAL_PAYABLE_BOOKING_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * THE MEMBER'S PAY DOOR, as one predicate (#3641, `INV-PAY-105`): the
 * additional PaymentIntent a member can still pay right now, or `null`.
 *
 * `GET /api/bookings/[id]/additional-payment-secret` hands out this intent's
 * client secret and nothing else, with no age limit, and the reminder cron
 * chases it until check-in. So "can the member still pay this ask?" has
 * exactly one answer, and it is this one. The Xero outbox reaper asks the same
 * question before it retires a supplementary invoice parked on an intent: an
 * invoice waiting on an ask this door still hands out is not stale, however
 * old it is or however many cards were declined against it.
 *
 * The door is closed when the booking no longer names the intent (a later
 * change superseded it, or an officer withdrew it: the `Payment` columns
 * always describe the LATEST additional transaction), when that ask was
 * already collected, when the booking was deleted, or when its lifecycle can
 * no longer take a card payment for an addition (CANCELLED, BUMPED).
 */
export function payableAdditionalPaymentIntentId(input: {
  bookingStatus: string | null | undefined;
  bookingDeletedAt: Date | null;
  payment:
    | {
        additionalPaymentIntentId: string | null;
        additionalPaymentStatus: string | null;
      }
    | null
    | undefined;
}): string | null {
  const { payment } = input;
  if (
    !payment?.additionalPaymentIntentId ||
    payment.additionalPaymentStatus === "SUCCEEDED" ||
    input.bookingDeletedAt !== null ||
    !isAdditionalPayableBookingStatus(input.bookingStatus)
  ) {
    return null;
  }
  return payment.additionalPaymentIntentId;
}

const MS_PER_DAY = 86_400_000;

/** The `Payment` columns every surface here reads. */
export interface AdditionalPaymentChasePayment {
  additionalAmountCents: number;
  additionalPaymentStatus: string | null;
  additionalReminderSentAt: Date | null;
  additionalFinalReminderSentAt: Date | null;
  createdAt: Date;
}

/**
 * The booking-and-payment pair the owed test needs. Deliberately an OBJECT with
 * a required `bookingStatus` key rather than two positional arguments: a caller
 * that forgets the status does not compile, which is the only way to stop this
 * predicate drifting back apart from its SQL twin.
 */
export interface AdditionalPaymentOwedInput {
  /** The booking's lifecycle status (`Booking.status`). */
  bookingStatus: string | null | undefined;
  payment:
    | Pick<
        AdditionalPaymentChasePayment,
        "additionalAmountCents" | "additionalPaymentStatus"
      >
    | null
    | undefined;
}

/**
 * The MONEY half of the owed test, on its own: an upward modification delta was
 * recorded and the money has not arrived. PENDING, FAILED (abandoned /
 * declined) and a null status on a legacy row all mean uncollected; only
 * SUCCEEDED means it was collected.
 *
 * It is deliberately only HALF the test, and is exported for the ONE caller
 * where the booking-status half is constant by construction: the manual cash /
 * off-Xero mark-paid (#2397, `prepareManualSettlement` in
 * src/lib/payment-reconciliation.ts) always lands the booking on PAID, which is
 * in ADDITIONAL_OWED_BOOKING_STATUSES, so the settle only has to ask whether the
 * money arrived. Every OTHER surface must use `isAdditionalPaymentOwed` below,
 * which conjoins the status half — a cancelled booking keeps its delta columns
 * unchanged and would otherwise read as still owing.
 *
 * It lives here, alongside the status half and the SQL builders' status list,
 * so there is exactly one money-half in the codebase; #2397 introduced it in
 * src/lib/unpaid-finished-stays.ts, which re-exports it for the callers that
 * predate #2350.
 */
export function isAdditionalAmountUncollected<
  T extends {
    additionalAmountCents: number;
    additionalPaymentStatus: string | null;
  },
>(payment: T | null | undefined): payment is T {
  if (!payment) return false;
  return (
    payment.additionalAmountCents > 0 &&
    payment.additionalPaymentStatus !== "SUCCEEDED"
  );
}

/**
 * Is an upward modification delta still uncollected AND still worth collecting?
 *
 * Two halves, both required:
 *  - the booking is in a lifecycle state that can still owe money (see
 *    ADDITIONAL_OWED_BOOKING_STATUSES). Cancelling a booking leaves the delta
 *    columns exactly as they were, so without this a cancelled booking reads as
 *    "still owing" and every surface — the chase email most of all — would dun
 *    the member for money they do not owe;
 *  - the money has not arrived — `isAdditionalAmountUncollected` above, called
 *    rather than restated, so the cash settle (#2397) that silences this chase
 *    and the chase itself can never drift apart.
 *
 * Same rule as `buildAdditionalOwedWhere`, the admin queues, and the cron.
 */
export function isAdditionalPaymentOwed(
  input: AdditionalPaymentOwedInput,
): boolean {
  if (!isAdditionalOwedBookingStatus(input.bookingStatus)) return false;
  return isAdditionalAmountUncollected(input.payment);
}

/**
 * When the CURRENT additional-payment obligation began.
 *
 * The `Payment` summary columns only ever describe the LATEST additional
 * transaction (see syncPaymentAdditionalSummary in payment-transactions.ts), so
 * that transaction's `createdAt` is the start of the episode the member is being
 * chased about. Legacy rows written before per-transaction records existed have
 * no such row; they fall back to the payment's own creation, which is stable and
 * always earlier than any stamp we could have written, so a stamp is never
 * wrongly discarded.
 */
export function additionalPaymentEpisodeStartedAt(params: {
  paymentCreatedAt: Date;
  latestAdditionalTransactionCreatedAt?: Date | null;
}): Date {
  return params.latestAdditionalTransactionCreatedAt ?? params.paymentCreatedAt;
}

/**
 * Does this stamp belong to the CURRENT episode?
 *
 * Reading the stamps relative to the episode is what lets a later modification
 * raise a fresh delta and be chased from scratch without any writer having to
 * reset the columns: a stamp from the previous, already-settled episode is older
 * than the new episode's start and simply stops counting.
 */
export function isCurrentEpisodeStamp(
  stamp: Date | null | undefined,
  episodeStartedAt: Date,
): boolean {
  return stamp != null && stamp.getTime() >= episodeStartedAt.getTime();
}

export type AdditionalPaymentReminderKind = "initial" | "final";

export interface AdditionalPaymentChaseInput {
  /** Wall-clock now. */
  now: Date;
  /** NZ date-only today, as the rest of the booking domain means it. */
  today: Date;
  /** Booking check-in, date-only. */
  checkIn: Date;
  /** Booking check-out, date-only. */
  checkOut: Date;
  episodeStartedAt: Date;
  reminderSentAt: Date | null;
  finalReminderSentAt: Date | null;
  /**
   * First-deploy guard: the instant automatic chasing began on THIS deployment.
   *
   * REQUIRED, and deliberately not defaulted to a constant in this file. A
   * hand-edited "raise this before you release" date is enforced by nothing: if
   * the deploy slips past it, every obligation raised in the gap is backlog that
   * the first pass mails at once — the exact failure the guard exists to
   * prevent. The cron derives it from a fact that is true at deploy time (the
   * first recorded run of the job, see
   * `resolveAdditionalPaymentChaseStartedAt` in
   * src/lib/cron-additional-payment-reminders.ts); the manual re-send passes the
   * epoch, because a person choosing to make contact is not the bulk mailing
   * this guard is about.
   */
  chaseStartsAt: Date;
}

/**
 * Which reminder is due for this booking right now, or `null` for none.
 *
 * The chase stops the moment the stay is over (`checkOut <= today`): a finished
 * stay with money still owing is the admin dashboard's unpaid-finished-stay queue
 * (#1723 path 2), which is a follow-up conversation rather than an automated
 * nudge. There is deliberately no auto-cancel and no expiry — nothing here ever
 * changes the booking.
 *
 * When both reminders are due at once the FINAL one wins and the caller stamps
 * both: inside the pre-arrival window the gentler "a few days ago you were asked"
 * nudge has nothing left to add, and sending two emails in one cron pass would be
 * exactly the noise the stamps exist to prevent.
 *
 * An obligation whose episode began before `chaseStartsAt` is never emailed
 * about: on the first deploy every already-outstanding delta is long past the
 * day-3 threshold, so without the guard the first pass would mail the whole
 * backlog at once. The exclusion is per EPISODE, not permanent — a later upward
 * change (or a member retrying a failed charge) starts a fresh episode after the
 * cutover and is chased normally.
 *
 * The cooldown is honoured here too, so the cron cannot land a reminder on top
 * of an admin's manual send: without it, a manual send late on the NZ day before
 * the pre-arrival window opens writes only the day-N stamp, leaving the next
 * tick free to send the near-identical last-chance email minutes later.
 */
export function resolveAdditionalPaymentChase(
  input: AdditionalPaymentChaseInput,
): AdditionalPaymentReminderKind | null {
  if (input.checkOut.getTime() <= input.today.getTime()) return null;

  if (input.episodeStartedAt.getTime() < input.chaseStartsAt.getTime()) {
    return null;
  }

  if (
    isWithinAdditionalPaymentResendCooldown({
      now: input.now,
      reminderSentAt: input.reminderSentAt,
      finalReminderSentAt: input.finalReminderSentAt,
    })
  ) {
    return null;
  }

  const finalWindowStart =
    input.checkIn.getTime() -
    ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN * MS_PER_DAY;
  if (
    input.today.getTime() >= finalWindowStart &&
    !isCurrentEpisodeStamp(input.finalReminderSentAt, input.episodeStartedAt)
  ) {
    return "final";
  }

  const initialDueAt =
    input.episodeStartedAt.getTime() +
    ADDITIONAL_PAYMENT_REMINDER_DAYS * MS_PER_DAY;
  if (
    input.now.getTime() >= initialDueAt &&
    !isCurrentEpisodeStamp(input.reminderSentAt, input.episodeStartedAt)
  ) {
    return "initial";
  }

  return null;
}

/**
 * Has the member been emailed about this delta within the re-send cooldown?
 * Checks BOTH stamps, so an automatic reminder that has just gone out blocks an
 * admin's re-send just as another re-send would — and, via
 * `resolveAdditionalPaymentChase` above, an admin's re-send blocks the cron's
 * next tick in exactly the same way.
 */
export function isWithinAdditionalPaymentResendCooldown(params: {
  now: Date;
  reminderSentAt: Date | null;
  finalReminderSentAt: Date | null;
}): boolean {
  const cutoff =
    params.now.getTime() - ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES * 60_000;
  return [params.reminderSentAt, params.finalReminderSentAt].some(
    (stamp) => stamp != null && stamp.getTime() > cutoff,
  );
}

/** Whole days between the delta being raised and now, floored at 0. */
export function additionalPaymentAgeDays(params: {
  now: Date;
  episodeStartedAt: Date;
}): number {
  return Math.max(
    0,
    Math.floor(
      (params.now.getTime() - params.episodeStartedAt.getTime()) / MS_PER_DAY,
    ),
  );
}
