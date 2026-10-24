/**
 * The refund method a cancellation is forced to, whatever the member chose —
 * the ONE home for that decision (#3643 follow-up, from #1491's review).
 *
 * A captured internet banking payment has no card charge to reverse, so its
 * cancellation refund is always held as account credit. The cancel path
 * applies this before it tiers the refund; the cancel preview returns it so
 * the dialog offers only what will happen. Pure, so both can import it. Both
 * read it through `cancelRefundDisposition` below (#3949 review rounds 3-4).
 */
import { PaymentSource } from "@prisma/client";

export type ForcedCancelRefundMethod = "credit" | "organiser_card" | "organiser_by_hand" | null;

/**
 * #3653: `paidByOrganiserCard` is the joiner's booking the group organiser paid
 * for by card (`group-organiser-paid.ts`). Its refund goes back to the
 * ORGANISER's card, so there is no account-credit choice to offer the joiner.
 */
export function forcedCancelRefundMethod(
  paymentSource: string | null | undefined,
  paidByOrganiserCard = false,
  /**
   * #3949 (owner decision, 22 Oct 2026; `INV-PAY-137`): `paidByOrganiserInternetBanking`. Its refund goes back to
   * the ORGANISER by bank transfer, as a hand-back task, never as the joiner's account credit.
   */
  paidByOrganiserInternetBanking = false,
): ForcedCancelRefundMethod {
  if (paidByOrganiserCard) return "organiser_card";
  if (paidByOrganiserInternetBanking) return "organiser_by_hand";
  return paymentSource === PaymentSource.INTERNET_BANKING ? "credit" : null;
}

/**
 * #3949 (review round 3): the method a paid cancel tiers its refund at and whether it is paid back by hand - the
 * ONE home for the cancel (`cancelBooking`) and its preview's card-shortfall question
 * (`cancelPreviewCardShortfall`), so the two cannot size a different branch.
 *
 * A refund to the organiser is tiered on the card tiers, whichever way they paid; one the organiser paid by
 * Internet Banking is paid back by hand (owner decision, 22 Oct 2026). A hand-settled payment of the member's own
 * is paid back by hand on the method they chose; an Internet Banking one of their own is held as account credit.
 */
export function cancelRefundDisposition(params: {
  paymentSource: string | null | undefined;
  /** The joiner's booking the organiser paid for by card, with a cancel basis (`organiserChildCancelBasis`). */
  organiserCard: boolean;
  /** The joiner's booking the organiser paid for by Internet Banking (`paidByOrganiserInternetBanking`), not by card. */
  organiserByBank: boolean;
  manuallyMarkedPaid: boolean;
  /** The method the member chose, where nothing forces one. */
  requested: "card" | "credit";
}): { forced: ForcedCancelRefundMethod; refundMethod: "card" | "credit"; manualDisposition: boolean } {
  const organiserByBank = !params.organiserCard && params.organiserByBank;
  const forced = forcedCancelRefundMethod(params.paymentSource, params.organiserCard, organiserByBank);
  const refundMethod = forced === "credit" ? "credit" : forced === null ? params.requested : "card";
  return { forced, refundMethod, manualDisposition: !params.organiserCard && (params.manuallyMarkedPaid || organiserByBank) };
}
