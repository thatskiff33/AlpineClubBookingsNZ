/**
 * THE MEMBER-FACING REFUND SENTENCES OF A BOOKING'S EMAILS (`INV-SSOT`).
 *
 * Named for "Booking Modified", where it started (#3827), but the ONE home for
 * the refund sentence of the "Booking Modified", "Booking Cancelled" and
 * "Refund Appeal Approved" emails - HTML template and admin-editable body alike -
 * and for the cancel dialog's on-screen confirmation of an organiser-paid
 * refund (#3973) or an own-card refund not made yet (#4084). Pure, with no
 * runtime imports (types only), so a client component can read it. Every function takes the
 * settlement's own answer of where the money went or is going; nothing here
 * decides it.
 */
import type { BankTransferRefundPayee } from "@/lib/group-organiser-paid";

/**
 * #3916, #3973: a refund on a joiner's booking the group organiser paid for by
 * card goes back to the ORGANISER's card (#3653), not to anything the joiner
 * paid with. ONE wording for the "Booking Modified" and "Booking Cancelled"
 * emails, HTML and admin-editable body alike, and the cancel dialog's
 * confirmation. The caller passes the settlement's own answer that the refund
 * went there.
 */
export function organiserCardRefundSentence(amount: string): string {
  return `A refund of ${amount} has been processed to the group organiser's card, because the group organiser paid for this booking.`;
}

/**
 * #3973: that refund to the organiser's card, not yet made - Stripe has not
 * answered it, and the recovery runner retries it until it does. A joiner's own
 * cancel whose refund did not complete inline, or the organiser's cancel of the
 * group whose refund for this child did not.
 */
export function organiserCardRefundPendingSentence(amount: string): string {
  return `A refund of ${amount} is on its way to the group organiser's card, because the group organiser paid for this booking.`;
}

/**
 * #3653, #3973: a joiner cancelling behind the group organiser's cancellation,
 * which already carries this booking's refund to the organiser's card as its
 * own debt. `refunded` is that debt's own status (`SUCCEEDED`). The cancel, its
 * preview (`groupCancellationRefundNote`) and its email say it in these words.
 */
export function groupCancellationRefundSentence(amount: string, refunded: boolean): string {
  return refunded
    ? `The group organiser's cancellation refunded ${amount} for this booking to the organiser's card.`
    : `The group organiser's cancellation is already refunding ${amount} for this booking to the organiser's card.`;
}

/**
 * #3956 (`INV-PAY-123`): what the group ORGANISER is told when a joiner's
 * approved refund appeal is refunded to the organiser's card. ONE wording for
 * the HTML template and the admin-editable body's `{{refundSentence}}`.
 * "Is being refunded" holds whether Stripe has answered yet or not.
 */
export function organiserJoinerAppealRefundSentence(amount: string, joinerName: string): string {
  return `The club has approved a refund appeal from ${joinerName}, who is in your group booking. Because you paid for their place, ${amount} for their share is being refunded to the card you paid with.`;
}

/**
 * #3973: an organiser cancel of a group the organiser settled by Internet
 * Banking, and (#3949) a joiner's own cancel of a place in one. There is no card
 * to refund, so the club repays the organiser by hand; it is promised, not
 * reported, and never to the joiner.
 */
export function organiserByHandRefundSentence(amount: string): string {
  return `The club will refund ${amount} to the group organiser directly, because the group organiser paid for this booking.`;
}

/**
 * #4299 (`INV-PAY-147`): an increase on a place the group organiser paid for by
 * Internet Banking is invoiced to the ORGANISER, so the joiner is told there is
 * nothing for them to pay. ONE wording for the "Booking Modified" HTML email and
 * its admin-editable body, and (N4, `quote`) the edit panel's preview of it,
 * which says what saving will do.
 */
export function organiserBilledSentence(amount: string, when: "saved" | "quote" = "saved"): string {
  const billed = when === "quote" ? "will be invoiced" : "has been invoiced";
  return `The extra ${amount} for this change ${billed} to the group organiser, because the group organiser paid for this booking. There is nothing for you to pay.`;
}

/**
 * #3973: a refund on a joiner's booking that goes to the group ORGANISER, not
 * the joiner. Paid by card, to the organiser's card (#3653): made
 * (`organiser_card`), still on its way (`organiser_card_pending`), or carried by
 * the organiser's earlier cancellation of the group, still running
 * (`group_cancel_refunding`) or made (`group_cancel_refunded`). Paid by
 * Internet Banking, repaid by the club by hand (`organiser_by_hand`): the
 * organiser's cancel of the group (#3973), or a joiner's own cancel (#3949,
 * owner decision, 22 Oct 2026). The cancel's result carries one, so the
 * confirmation screen says what the email says.
 */
export type OrganiserRefundMethod =
  | "organiser_card"
  | "organiser_card_pending"
  | "group_cancel_refunding"
  | "group_cancel_refunded"
  | "organiser_by_hand";

/** #3956: an approved appeal's refund to the organiser's card - made, or on its way. */
export type OrganiserCardAppealRefund = Extract<OrganiserRefundMethod, "organiser_card" | "organiser_card_pending">;

/**
 * #4084: a cancel's refund to the member's own card: made (`card`), or not
 * made yet (`card_pending`) - the Stripe call threw and the refund is queued
 * for the recovery runner, or Stripe answered `failed` or `canceled`
 * (`ownCardRefundMade`). The cancel's result carries one, so the confirmation
 * screen says what the email says.
 */
export type OwnCardRefundMethod = "card" | "card_pending";

/**
 * Where a "Booking Cancelled" email says the refund went. B5 (#2262): "manual"
 * is a cash / off-Xero settlement a person hands back, so it must never read as
 * "on its way to your card" (no card was charged) nor as account credit (none
 * was minted; a hand-back task was raised). #3973: the organiser's card
 * refunds, and the organiser's Internet Banking settlement the club repays by
 * hand (`OrganiserRefundMethod`). #4084: the member's own card
 * (`OwnCardRefundMethod`).
 */
export type BookingCancelledRefundMethod = OwnCardRefundMethod | "credit" | "manual" | OrganiserRefundMethod;

/**
 * #4097 (`INV-PAY-129`): the parts of an own-card cancel's refund its card
 * refund plan could not carry, inside `refundCents`. `bankCents`: what the
 * payment's non-card charges hold, which the club refunds by bank transfer.
 * `checkCents`: the rest, which the club checks first, so the member is told
 * only that the club will be in touch. `formatAmount` formats cents in the
 * club's format.
 */
export type OwnCardShortfallParts = { bankCents: number; checkCents: number; formatAmount: (cents: number) => string };

/**
 * #4097 (`INV-PAY-129`): an own-card cancel's refund split between the card
 * (made, or on its way when `pending`), a part refunded by bank transfer, and a
 * part the club will be in touch about - built from the one card clause and the
 * one bank-transfer clause (`INV-SSOT`). The email and the cancel dialog's
 * confirmation, where an officer cancelling on the member's behalf reads "the
 * member's" (`whose`). #4119: `"planned"` is the cancel preview's, before
 * anything is asked of the card, so the card's part "will be processed".
 */
export function ownCardRefundWithShortfallSentence(
  cardCents: number,
  { bankCents, checkCents, formatAmount }: OwnCardShortfallParts,
  pending: boolean | "planned",
  whose: OwnCardWhose = "your",
): string {
  const recipient = whose === "your" ? "you" : "the member";
  const cardClause = pending === "planned" ? ownCardRefundPlannedClause : pending ? ownCardRefundPendingClause : ownCardRefundClause;
  const card = cardCents <= 0 ? null : cardClause(formatAmount(cardCents), whose);
  const remaining = (cents: number) => `the remaining ${formatAmount(cents)}`;
  if (bankCents > 0 && checkCents > 0) {
    const rest = `${bankTransferRefundClause(formatAmount(bankCents), recipient)} and will be in touch about ${remaining(checkCents)}`;
    return card ? `${card}; ${rest}.` : `${capitalise(rest)}.`;
  }
  if (bankCents > 0) {
    return card ? `${card}, and ${bankTransferRefundClause(remaining(bankCents), recipient)}.` : bankTransferRefundSentence(formatAmount(bankCents), recipient);
  }
  return card
    ? `${card}, and the club will be in touch about ${remaining(checkCents)}.`
    : `The club will be in touch about the ${formatAmount(checkCents)} refund.`;
}

/**
 * #3973: the refund line of a "Booking Cancelled" email, ONE wording for the
 * HTML template, the admin-editable body's `{{refundMessage}}` and the cancel
 * dialog's organiser-paid confirmation (`INV-SSOT`). `amount` is `refundCents`
 * formatted in the club's format. #4097: `shortfall`, on an own-card refund, is
 * the part its card refund could not carry.
 */
export function bookingCancelledRefundSentence(
  refundCents: number,
  amount: string,
  refundMethod: BookingCancelledRefundMethod,
  shortfall?: OwnCardShortfallParts,
): string {
  if (refundCents <= 0) return "No refund was applicable based on the cancellation policy.";
  const restCents = shortfall ? shortfall.bankCents + shortfall.checkCents : 0;
  if (shortfall && restCents > 0 && (refundMethod === "card" || refundMethod === "card_pending")) {
    return ownCardRefundWithShortfallSentence(refundCents - restCents, shortfall, refundMethod === "card_pending");
  }
  switch (refundMethod) {
    case "manual":
      return `You paid for this booking in cash or by bank transfer, so there is no card payment to reverse. The club will arrange your refund of ${amount} directly and will be in touch.`;
    case "organiser_card":
      return organiserCardRefundSentence(amount);
    case "organiser_card_pending":
      return organiserCardRefundPendingSentence(amount);
    case "group_cancel_refunding":
      return groupCancellationRefundSentence(amount, false);
    case "group_cancel_refunded":
      return groupCancellationRefundSentence(amount, true);
    case "organiser_by_hand":
      return organiserByHandRefundSentence(amount);
    case "credit":
      return `A credit of ${amount} has been added to your account for future bookings.`;
    case "card":
      return ownCardRefundSentence(amount);
    case "card_pending":
      return ownCardRefundPendingSentence(amount);
  }
}

/**
 * #3973: a refund already made reads as a success; a hand-back, a refund still
 * on its way (#4084: `card_pending` too), or no refund at all reads as
 * information. #4097: so does a card refund with a part its card refund could
 * not carry (`shortfallCents`, both parts). The email's box and the
 * confirmation screen both ask here.
 */
export function bookingCancelledRefundMade(refundCents: number, refundMethod: BookingCancelledRefundMethod, shortfallCents = 0): boolean {
  if (refundCents <= 0 || shortfallCents > 0) return false;
  return refundMethod === "card" || refundMethod === "credit" || refundMethod === "organiser_card" || refundMethod === "group_cancel_refunded";
}

/** Whose payment method a card refund sentence names: the member's own, or an officer's "the member's". */
type OwnCardWhose = "your" | "the member's";

/** #4097: the card refund made, as a clause the sentences below finish (`INV-SSOT`). */
function ownCardRefundClause(amount: string, whose: OwnCardWhose = "your"): string {
  return `A refund of ${amount} has been processed to ${whose} original payment method`;
}

/** A card refund back to what the member paid with; Booking Modified and Booking Cancelled alike. */
function ownCardRefundSentence(amount: string): string {
  return `${ownCardRefundClause(amount)}.`;
}

/** #3827, #4119: the card refund not yet asked for (an approved appeal's, the cancel preview's), as a clause (`INV-SSOT`). */
function ownCardRefundPlannedClause(amount: string, whose: OwnCardWhose = "your"): string {
  return `A refund of ${amount} will be processed to ${whose} original payment method`;
}

/**
 * #4125: a card refund not made yet, as the words after its amount - the one
 * wording the emails' clause below and the booking narrative's
 * (`booking-narrative-cancelled-post-payment.ts`) both say it in (`INV-SSOT`).
 */
export function cardRefundOnItsWay(amount: string, whose: OwnCardWhose = "your"): string {
  return `${amount} is on its way to ${whose} original payment method`;
}

/** #4097: the card refund not made yet, as a clause (`INV-SSOT`). */
function ownCardRefundPendingClause(amount: string, whose: OwnCardWhose = "your"): string {
  return `A refund of ${cardRefundOnItsWay(amount, whose)}`;
}

/**
 * #4070: that card refund, not made yet (`ownCardRefundMade`) - it failed,
 * timed out or was not made. Booking Modified and (#4084) Booking Cancelled
 * alike, and the cancel dialog's confirmation, where an officer cancelling on
 * the member's behalf reads "the member's" (`whose`).
 */
export function ownCardRefundPendingSentence(amount: string, whose: OwnCardWhose = "your"): string {
  return `${ownCardRefundPendingClause(amount, whose)}.`;
}

/** #3827, #4097: the club's bank-transfer refund, as a clause and as a sentence (`INV-SSOT`). */
function bankTransferRefundClause(amount: string, recipient: "you" | "the member" = "you"): string {
  return `the club will refund ${amount} to ${recipient} by bank transfer`;
}

function capitalise(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

function bankTransferRefundSentence(amount: string, recipient: "you" | "the member" = "you"): string {
  return `${capitalise(bankTransferRefundClause(amount, recipient))}.`;
}

/**
 * #4057: where a "Booking Modified" refund went, as the edit's settlement
 * answers it after commit (`executeBookingModificationRefund`), never
 * recomputed. `own`: back to what the member paid with - their card, or by bank
 * transfer when the club sends it by hand. `own_card_pending` (#4070): that card
 * refund, not made yet (`ownCardRefundMade`). `organiser_card`: a joiner's booking
 * the group organiser paid for by card (#3653), and the refund's debt says
 * Stripe made it. `organiser_card_pending`: that refund, not made yet - failed,
 * not claimed in the run, or unreadable - and owed to the recovery runner.
 */
export type BookingModifiedRefundDestination =
  | "own"
  | "own_card_pending"
  | Extract<OrganiserRefundMethod, "organiser_card" | "organiser_card_pending">;

/**
 * #3827 (owner decision D-3813-6, `INV-PAY-117`): the refund half of a
 * "Booking Modified" email's money note, ONE wording for the HTML template and
 * the admin-editable body (`INV-SSOT`). A card refund has already been made by
 * the time the email goes; a bank-transfer refund is an officer task the club
 * has still to carry out, so it is promised rather than reported. #3916,
 * #4057: an organiser-card refund is reported made only when its debt says so,
 * otherwise it is on its way; such a refund is a Stripe one, so never by hand.
 * #4070: an own-card refund likewise, when Stripe did not make it.
 */
export function bookingModifiedRefundSentence(
  amount: string,
  /** #3949: who the club's bank transfer goes to (`editRefundBankTransferPayee`), or null when none is sent by hand. */
  refundByBankTransfer: BankTransferRefundPayee | null,
  refundDestination: BookingModifiedRefundDestination,
): string {
  switch (refundDestination) {
    case "organiser_card":
      return organiserCardRefundSentence(amount);
    case "organiser_card_pending":
      return organiserCardRefundPendingSentence(amount);
    case "own_card_pending":
      return ownCardRefundPendingSentence(amount);
    case "own":
      // #3949 (`INV-PAY-137`): a joiner's booking the organiser paid by internet banking is refunded to the organiser.
      if (refundByBankTransfer === "organiser") return organiserByHandRefundSentence(amount);
      return refundByBankTransfer === "member" ? bankTransferRefundSentence(amount) : ownCardRefundSentence(amount);
  }
}

/**
 * #4057, #4070: a card refund still on its way, the organiser's or the
 * member's own, reads as information, the way "Booking Cancelled" boxes it
 * (`bookingCancelledRefundMade`); every other edit refund keeps its success box.
 */
export function bookingModifiedRefundPending(refundDestination: BookingModifiedRefundDestination): boolean {
  return refundDestination === "organiser_card_pending" || refundDestination === "own_card_pending";
}

/**
 * #3827 (owner decision D-3813-7, `INV-PAY-118`): the refund sentence of a
 * "Refund Appeal Approved" email, ONE wording for the HTML template and the
 * admin-editable body's `{{refundSentence}}` (`INV-SSOT`). The part a card
 * refund carries is on its way; the part the club sends by bank transfer is an
 * officer task still to be done, so it is promised, the same way as an edit's.
 * `bankTransferCents` is the part of `approvedCents` the club sends by hand
 * (0 when the card carries it all).
 */
export function refundRequestApprovedRefundSentence(
  approvedCents: number,
  bankTransferCents: number,
  formatAmount: (cents: number) => string,
  /**
   * #3956 (`INV-PAY-123`): the booking was paid for by the group organiser's
   * card, so the whole refund goes there - made (`organiser_card`, its debt
   * says so), or still on its way (`organiser_card_pending`). Null for any
   * other booking.
   */
  organiserCardRefund: OrganiserCardAppealRefund | null = null,
  /** #3949 (`INV-PAY-137`): who the bank-transfer part goes to - the group organiser who paid for the booking by internet banking, or the member. */
  bankTransferPayee: BankTransferRefundPayee = "member",
): string {
  if (organiserCardRefund === "organiser_card") return organiserCardRefundSentence(formatAmount(approvedCents));
  if (organiserCardRefund === "organiser_card_pending") {
    return organiserCardRefundPendingSentence(formatAmount(approvedCents));
  }
  const cardCents = approvedCents - bankTransferCents;
  if (bankTransferCents <= 0) {
    return `${ownCardRefundPlannedClause(formatAmount(approvedCents))}.`;
  }
  if (cardCents <= 0) {
    // #3949: an organiser's internet-banking payment has no card part, so all of it goes back to them.
    return bankTransferPayee === "organiser" ? organiserByHandRefundSentence(formatAmount(bankTransferCents)) : bankTransferRefundSentence(formatAmount(bankTransferCents));
  }
  return `${ownCardRefundPlannedClause(formatAmount(cardCents))}, and ${bankTransferRefundClause(`the remaining ${formatAmount(bankTransferCents)}`)}.`;
}
