/**
 * #4211 (`INV-PAY-043`) - the words of the kept-capture alert
 * (`admin-duplicate-capture-kept`), shared by its hand-built HTML
 * (`email-templates/admin-duplicate-capture-kept.ts`), the
 * `{{duplicateCaptureKeptNote}}` token and the duplicate-capture guard's
 * reasons. A sibling of `email-message-notes.ts`, split by size, and like it
 * imports nothing.
 */

/**
 * Why the duplicate-capture guard kept a card capture instead of refunding it:
 * the booking is paid and another payment on it holds money, but the guard has
 * no usable record of which payment settled it.
 *
 * - `not-recorded`: `Payment.settledByTransactionId` is empty - paid before the
 *   record existed, by the previous app version during an upgrade, or by a bank
 *   receipt the settle could not match to exactly one receipt row.
 * - `settler-released`: the recorded settler no longer holds money (refunded,
 *   reversed, or going back to the member), so it says nothing about which
 *   remaining payment to keep - or, with nothing else holding money
 *   (`otherHoldsMoney: false`), whether this payment now pays for the booking.
 * - `new-capture` (#4285): no record and no other payment the app counts as
 *   settling the booking, and the app had never recorded this payment before -
 *   new money on a booking that was paid some other way (account credit, a zero
 *   total, a group settlement) or whose earlier payment was refunded. With
 *   `otherHoldsMoney: true` (#4285 review) a payment the app no longer counts -
 *   behind a dead cancel, or whose duplicate-capture refund failed later and
 *   open rows owe back less than all it holds - still holds money, and the
 *   alert names it.
 * - `new-capture-closed` (#4285 review): that alert, still owed when the
 *   payments cron's drain sends it, on a booking cancelled or closed since. A
 *   cancellation refunds at most what the booking was worth, so part or all of
 *   a payment the booking never needed may still be held. The alert's amount is
 *   what the card payment still holds after card refunds taken from it; a
 *   refund the cancellation made as account credit or by hand never touches
 *   it, so the alert names that refund where the cancellation recorded one.
 * - `new-capture-later-payment` (#4285 review): that alert, still owed when the
 *   drain sends it, once another payment also holds money. Two payments now hold
 *   money on a booking paid another way or whose earlier payment was refunded.
 */
export type DuplicateCaptureKeptReason =
  | "not-recorded"
  | "settler-released"
  | "new-capture"
  | "new-capture-closed"
  | "new-capture-later-payment";

/**
 * #4285 review: what the cancellation's own record says it refunded, for a
 * `new-capture-closed` alert, with amounts formatted by the caller (this module
 * imports nothing). `none`: no refund was due. `card`: its card part and where
 * that refund stands, as of the drain's read - `sent` only once its row
 * SUCCEEDED and no refund it made failed later still owed again, `not-sent`
 * while it (or such a refund) is on its way or dead, `paid-another-way` for a
 * close recorded as paid another way (with what it left `unpaid`), a `sent`
 * refund naming any part that failed later and was closed that way
 * (`closedAnotherWay`), `unrecorded` with no row (a cancel from
 * before the row existed); `organiserCard` where it goes to the group
 * organiser's card (#3653) - and, for a card refund shortfall (#4097,
 * `INV-PAY-129`), the parts owed by bank transfer and for the club to check,
 * each as its hand-back task stands: `owed` while open, `paid` once completed,
 * `closed` once dismissed.
 */
export type CancellationRefundNote =
  | { method: "none" }
  | { method: "credit" | "manual"; amount: string }
  | {
      method: "card";
      /** Null when the card plan carried nothing: the whole refund is owed another way. */
      card: {
        amount: string;
        standing: "sent" | "not-sent" | "paid-another-way" | "unrecorded";
        organiserCard?: true;
        /** What a close recorded as paid another way left unpaid, when it left any. */
        unpaid?: string;
        /** `sent` only: the part that failed later and was closed as paid another way. */
        closedAnotherWay?: string;
      } | null;
      byBank: ShortfallPartNote | null;
      toCheck: ShortfallPartNote | null;
    };

/** One part of a card refund shortfall, as its hand-back task stands. */
export type ShortfallPartNote = { amount: string; standing: "owed" | "paid" | "closed" };

function joinedClauses(clauses: string[]): string {
  return clauses.length <= 1 ? (clauses[0] ?? "") : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
}

function cardRefundClauses(refund: Extract<CancellationRefundNote, { method: "card" }>): string[] {
  const card = refund.card;
  const refundOf = card?.organiserCard ? `refund of ${card.amount} to the group organiser's card` : `card refund of ${card?.amount}`;
  const leftUnpaid = card?.unpaid ? `, with ${card.unpaid} of it left unpaid` : "";
  const failedLaterClosed = card?.closedAnotherWay ? `, but ${card.closedAnotherWay} of that failed later and was closed as paid another way${leftUnpaid}` : "";
  const cardClause = card
    ? {
        sent: `it refunded ${card.amount} to ${card.organiserCard ? "the group organiser's card" : "card"}${failedLaterClosed}`,
        "not-sent": `a ${refundOf} was planned but has not been sent in full`,
        "paid-another-way": `its ${refundOf} was closed as paid another way${leftUnpaid}`,
        unrecorded: `a ${refundOf} was planned, with no record of whether it was sent`,
      }[card.standing]
    : null;
  const bank = refund.byBank;
  const check = refund.toCheck;
  return [
    ...(cardClause ? [cardClause] : []),
    ...(bank
      ? [{ owed: `${bank.amount} is owed back by bank transfer`, paid: `${bank.amount} was paid back by bank transfer`, closed: `the club recorded the ${bank.amount} owed by bank transfer as settled` }[bank.standing]]
      : []),
    ...(check
      ? [{ owed: `${check.amount} is for the club to check before paying it back`, paid: `${check.amount} was paid back by bank transfer after the club checked it`, closed: `the club checked the ${check.amount} and closed it` }[check.standing]]
      : []),
  ];
}

function cancellationRefundSentence(refund: CancellationRefundNote | null | undefined): string {
  if (!refund) return "";
  const said =
    refund.method === "card" ? joinedClauses(cardRefundClauses(refund)) || "no card refund was planned"
    : refund.method === "none" ? "no refund was due"
    : refund.method === "credit" ? `it refunded ${refund.amount} as account credit`
    : `${refund.amount} is to be paid back by hand`;
  return ` The cancellation's record shows ${said}.`;
}

/** The other payment, as the alert names it. */
function otherPaymentLabel(otherPaymentIntentId: string | null): string {
  return otherPaymentIntentId ? `card payment ${otherPaymentIntentId}` : "a cash or bank payment";
}

/**
 * #4285 review: what "nothing else holds money" can truthfully say. The guard
 * reads other payments by ledger status and PRIMARY rows only
 * (`readOtherSettledCaptureWhere`): the payments the app counts as settling the
 * booking, never every charge a card still holds (an additional-payment charge,
 * or one marked refunded by account credit).
 */
const NO_OTHER_SETTLING_PAYMENT = "the app counts no other payment on it as settling it";
const NO_OTHER_SETTLING_PAYMENT_THEN = "the app counted no other payment on it as settling it";

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The reason-specific paragraph, shared by the hand-built HTML and the
 * `{{duplicateCaptureKeptNote}}` token (#2268): the flat editable body has no
 * conditional syntax, so the sentence that differs travels as one token.
 */
export function duplicateCaptureKeptParagraph(input: {
  reason: DuplicateCaptureKeptReason;
  otherPaymentIntentId: string | null;
  /** False when nothing else holds money: a released settler and this payment alone (#4211 review). */
  otherHoldsMoney?: boolean;
  /** `new-capture-closed` only: the cancellation's recorded refund, when it recorded one. */
  cancellationRefund?: CancellationRefundNote | null;
}): string {
  const lead = input.otherHoldsMoney === false
    ? `A card payment arrived on this booking after it was already paid, and ${NO_OTHER_SETTLING_PAYMENT}.`
    : `A card payment arrived on this booking after it was already paid, and ${otherPaymentLabel(input.otherPaymentIntentId)} on it still holds money.`;
  const laterPayment = `A new card payment was recorded on this booking after it was already paid, while ${NO_OTHER_SETTLING_PAYMENT_THEN}: the booking was paid some other way (with account credit, at a zero total, or by a group organiser), or its earlier payment was refunded. ${capitalised(otherPaymentLabel(input.otherPaymentIntentId))} on it also holds money, so one or both of them may be extra. Nothing was refunded automatically.`;
  switch (input.reason) {
    case "not-recorded":
      return `${lead} The app has no record of which payment settled this booking: it was paid before the app kept one, by the previous app version during an upgrade, or by a bank payment that could not be matched to a single receipt. So nothing was refunded automatically.`;
    case "settler-released":
      return input.otherHoldsMoney === false
        ? `${lead} The payment the app recorded as settling this booking no longer holds money (it was refunded or reversed, or is being refunded), so the app cannot tell whether this payment now pays for the booking or is a duplicate, and nothing was refunded automatically.`
        : `${lead} The payment the app recorded as settling this booking no longer holds money (it was refunded or reversed, or is being refunded), so the app cannot tell which of the remaining payments to keep, and nothing was refunded automatically.`;
    case "new-capture-closed":
      return `A new card payment was recorded on this booking after it was already paid, while ${NO_OTHER_SETTLING_PAYMENT_THEN}, and the booking has since been cancelled or closed. A cancellation refunds at most what the booking was worth, so part or all of this payment may still be held: the amount shown is what this card payment still holds after any card refund taken from it. A refund made as account credit or by hand never touches this card payment, so part of what it holds may already have been refunded another way.${cancellationRefundSentence(input.cancellationRefund)}`;
    case "new-capture-later-payment":
      return laterPayment;
    case "new-capture":
      // #4285 review: a payment the app no longer counts as settling it (behind a dead
      // cancel, or a refund that failed later) may still hold money; then it is named.
      return input.otherHoldsMoney === true
        ? laterPayment
        : `A new card payment was recorded on this booking after it was already paid, and ${NO_OTHER_SETTLING_PAYMENT}: the booking was paid some other way (with account credit, at a zero total, or by a group organiser), or its earlier payment was refunded, so this payment may be extra. Nothing was refunded automatically.`;
  }
}

/**
 * What to do, shared by the hand-built HTML and the `{{duplicateCaptureKeptAction}}`
 * token (#4211 review): with another payment holding money one of the two is
 * extra; with none, this payment may be the only one left paying for the
 * booking, and refunding it would leave the booking unpaid. It ends with the
 * Stripe check the upgrade window needs - for two payments only: a `new-capture`
 * payment stands alone, so "neither payment" would be untrue (#4285 review).
 */
export function duplicateCaptureKeptAction(input: { otherHoldsMoney?: boolean; reason?: DuplicateCaptureKeptReason }): string {
  const action = input.otherHoldsMoney === false
    ? "Check whether this payment should pay for the booking; refund it by hand only if the booking should not be paid by it."
    : "Check which payment settled the booking, and refund the other one by hand.";
  if (input.reason === "new-capture-closed") {
    return "Check the cancellation's refund in the booking's history (it may have refunded part of the booking as account credit or by hand) and in Stripe how much of this payment is still held, then refund by hand what the booking no longer needs.";
  }
  if (input.reason === "new-capture-later-payment" || (input.reason === "new-capture" && input.otherHoldsMoney === true)) {
    return "Check which of the two payments should pay for the booking, if either, and refund by hand any the booking does not need — both, if it was paid another way.";
  }
  return input.reason === "new-capture" ? action : `${action} ${DUPLICATE_CAPTURE_KEPT_STRIPE_CHECK}`;
}

/** Fixed wording: the check the upgrade window needs (#4211 review). */
export const DUPLICATE_CAPTURE_KEPT_STRIPE_CHECK =
  "Before you refund by hand, check in Stripe that neither payment has already been refunded: while an upgrade is switching over, the previous app version can still refund one automatically.";
