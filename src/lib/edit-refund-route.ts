/**
 * #5303: where the member's own refund on an edit goes, and the one wording of
 * it (`INV-SSOT-001`). A booking whose reduction has no card to go back to - an
 * Internet Banking payment, or a card payment Stripe holds no record of (#5212,
 * `INV-PAY-160`) - is refunded by the treasurer by bank transfer, so no choice
 * the member is offered may promise the card. Each booking's answer is the
 * settlement's own (`editReductionRefundsToCard`, surfaced as the settlement
 * options' `refundByBankTransfer`); this module only words it.
 *
 * A linked move asks ONE card-or-credit question over several bookings, which
 * can be paid different ways, hence the mixed route.
 */
export type EditRefundRoute = "CARD" | "BANK_TRANSFER" | "CARD_AND_BANK_TRANSFER";

export const EDIT_REFUND_ROUTES: readonly EditRefundRoute[] = ["CARD", "BANK_TRANSFER", "CARD_AND_BANK_TRANSFER"];

/** The route over every booking the one choice covers, from each booking's `refundByBankTransfer`. */
export function editRefundRouteOf(refundsByBankTransfer: readonly boolean[]): EditRefundRoute {
  const bank = refundsByBankTransfer.filter(Boolean).length;
  if (bank === 0) return "CARD";
  return bank === refundsByBankTransfer.length ? "BANK_TRANSFER" : "CARD_AND_BANK_TRANSFER";
}

/**
 * The route when one choice covers bookings whose routes are already known: the
 * price summary's radio while a linked move needing the choice is active answers
 * for this booking and the linked ones together (#5303 review).
 */
export function combineEditRefundRoutes(routes: readonly EditRefundRoute[]): EditRefundRoute {
  return editRefundRouteOf(
    routes.flatMap((route) => (route === "CARD_AND_BANK_TRANSFER" ? [false, true] : [route === "BANK_TRANSFER"])),
  );
}

/** The other option's label, beside the refund's. */
export const EDIT_REFUND_CREDIT_CHOICE_LABEL = "Hold as account credit";

/** The refund option's label beside "account credit". */
export function editRefundChoiceLabel(route: EditRefundRoute): string {
  switch (route) {
    case "CARD":
      return "Refund to original card";
    case "BANK_TRANSFER":
      return "Refund by bank transfer";
    case "CARD_AND_BANK_TRANSFER":
      return "Refund to original card, or by bank transfer for a booking that can't be refunded to a card";
  }
}

/** The same route inside a sentence: "comes back {phrase} or as account credit". */
export function editRefundDestinationPhrase(route: EditRefundRoute): string {
  switch (route) {
    case "CARD":
      return "to your card";
    case "BANK_TRANSFER":
      return "by bank transfer";
    case "CARD_AND_BANK_TRANSFER":
      return "to your card (or by bank transfer for a booking that can't be refunded to a card)";
  }
}
