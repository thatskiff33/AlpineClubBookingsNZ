import { ApiError } from "@/lib/api-error";

/**
 * The refusal when a modification produces a settleable refund and the caller has
 * not said where it goes. Exported with a machine CODE (#2526) so a surface that
 * can OFFER the choice — the officer's booking-policy exception queue — can tell
 * this apart from every other 400 and render the card/credit control instead of
 * an error the reader cannot act on.
 *
 * IN ITS OWN MODULE, WITH `ApiError` AS ITS ONLY IMPORT (#3232). It was declared
 * in `booking-modify-settlement.ts`, which reaches the pricing planner, the
 * cancellation policy and the payment-state readers — so a caller that needed
 * only to RECOGNISE this refusal had to pull that whole graph in, and the linked
 * move's suite (which doubles the modification service on purpose) died at import
 * before a single test ran. `over-capacity-confirmation.ts` was split out for the
 * same reason, and `booking-modify-settlement.ts` re-exports both names, so every
 * existing importer is unchanged.
 */
export const SETTLEMENT_METHOD_REQUIRED_MESSAGE =
  "Choose a refund or account credit before saving";
export const SETTLEMENT_METHOD_REQUIRED_CODE = "SETTLEMENT_METHOD_REQUIRED";

export class BookingModificationSettlementMethodRequiredError extends ApiError {
  readonly code = SETTLEMENT_METHOD_REQUIRED_CODE;

  constructor() {
    super(SETTLEMENT_METHOD_REQUIRED_MESSAGE, 400);
    this.name = "BookingModificationSettlementMethodRequiredError";
  }
}
