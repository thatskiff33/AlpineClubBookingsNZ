/**
 * THE ONE HOME FOR A BOOKING-LEDGER POSTING KEY (#3595, `INV-MONEY-033`).
 *
 * A key is derived from the EVENT a line records — never from when it was
 * posted or by whom — so posting the same event twice produces the same key,
 * and the write door's `ON CONFLICT DO NOTHING` makes the second a no-op.
 *
 * Every format lives here and nowhere else. Review of #3597 found the formats
 * restated in five places (schema comment, design doc twice, invariant,
 * migration); a posting child that hand-rolled its own spelling would produce
 * keys that never collide with the ones this module makes, which is the
 * double-post this whole mechanism exists to prevent. The docs now show
 * examples and point here.
 *
 * WHAT A KEY DOES NOT DO, stated so nobody leans on it for more: a key makes
 * one EVENT idempotent. It does not make a booking's confirmation happen once
 * — the nights a booking holds can change between two settles, so their keys
 * change too. That is fenced separately, per booking, in the settle
 * (`bookingHasConfirmationLines`).
 */
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";

/** One guest's one night, as confirmed. */
export function confirmationNightKey(
  bookingId: string,
  bookingGuestId: string,
  stayDate: Date,
): string {
  return `confirmation:${bookingId}:night:${bookingGuestId}:${calendarDateOfDateOnlyInstant(stayDate)}`;
}

/** The booking's promotion adjustment, as confirmed. */
export function confirmationPromotionKey(bookingId: string): string {
  return `confirmation:${bookingId}:promotion`;
}

/**
 * One guest's one night as an edit sold it (#3582). The edit's
 * `BookingModification` row is written once and never again, so its id plus the
 * night is the whole identity; a later edit that re-sells the same night has a
 * different modification id and so a different key. A price rebase at review
 * closure posts under its own `PRICE_REBASE` history row the same way.
 */
export function modificationNightKey(
  bookingModificationId: string,
  bookingGuestId: string,
  stayDate: Date,
): string {
  return `modification:${bookingModificationId}:night:${bookingGuestId}:${calendarDateOfDateOnlyInstant(stayDate)}`;
}

/** The promotion as an edit (or a closure's rebase) left it, re-posted (#3582). */
export function modificationPromotionKey(bookingModificationId: string): string {
  return `modification:${bookingModificationId}:promotion`;
}

/** The change fee an edit charged (#3582). */
export function modificationChangeFeeKey(bookingModificationId: string): string {
  return `modification:${bookingModificationId}:change-fee`;
}

/**
 * What the club keeps when a booking is cancelled (#3611). A booking is
 * cancelled once — `CANCELLED` is terminal and every cancel path claims it with
 * a status-guarded flip — so its id is the whole identity. The stay's
 * reversals that post beside it are keyed by `reversalKey`, like every other.
 */
export function cancellationFeeKey(bookingId: string): string {
  return `cancellation:${bookingId}:fee`;
}

/**
 * The adjustment an officer agreed with the member by completing one review
 * task (#3582). A task completes at most once — its claim is status-guarded —
 * so its id is the whole identity.
 */
export function agreedAdjustmentKey(manualRefundTaskId: string): string {
  return `agreed-adjustment:${manualRefundTaskId}`;
}

/**
 * The reversal of a line, keyed by the REVERSED LINE'S ID rather than its key:
 * every line has an id, but a line posted before #3595 has no key. Keyed this
 * way, a second reversal of the same line always carries the same key as the
 * first, so a replay is skipped — and the database's unique `reversesLineId`
 * agrees with the unique key rather than being a second arbiter the write's
 * `ON CONFLICT DO NOTHING` could silently satisfy with a different posting.
 */
export function reversalKey(reversedLineId: string): string {
  return `reversal:${reversedLineId}`;
}

/**
 * A settlement line for one payment transaction — a card capture, a bank
 * receipt, or cash recorded by an officer (#3581). One transaction is captured
 * at most once, so its id is the whole identity.
 */
export function captureKey(paymentTransactionId: string): string {
  return `capture:${paymentTransactionId}`;
}

/** A card refund, one `PaymentRefund` row (#3581). */
export function refundKey(paymentRefundId: string): string {
  return `refund:${paymentRefundId}`;
}

/**
 * The line a source posts when it holds AGAIN after its previous line was
 * reversed (review of #3604). A source can flip more than once — a mark-paid
 * reversed, then the same row paid through Xero — and the base key is already
 * taken by the first line, so the next one is keyed off the reversal that
 * retired its predecessor. Deterministic from ledger state, so a replay of the
 * re-posting finds its own key and posts nothing.
 */
export function afterReversalKey(baseKey: string, reversalLineId: string): string {
  return `${baseKey}:after:${reversalLineId}`;
}

/**
 * The booking-side line for one `MemberCredit` row — credit applied to the
 * booking, credit minted from it, or applied credit restored on its
 * cancellation (#3599). A credit row's amount, type and booking link never
 * change after it is written, so its id is the whole identity and it posts
 * exactly one line, ever.
 */
export function creditKey(memberCreditId: string): string {
  return `credit:${memberCreditId}`;
}

/**
 * Money an officer handed back outside the card rails, recorded by completing
 * one `ManualRefundTask` (#3599). A task completes at most once — its claim is
 * status-guarded — so its id is the whole identity.
 */
export function handBackKey(manualRefundTaskId: string): string {
  return `handback:${manualRefundTaskId}`;
}
