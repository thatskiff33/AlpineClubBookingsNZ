/**
 * #3954 (review round 4): THE ONE REFUSAL A PRICE REDUCTION RAISES WHEN THE
 * UNPAID ASK IT READ MOVED UNDER IT - the member's capture landed, or a retry
 * claimed the ask's failed mint - before the edit could retire it.
 *
 * TRANSIENT, AND TYPED SO NOBODY READS IT AS FINAL. Every door answers it with
 * a 409 and the edit rolls back whole; trying again a moment later reads the
 * ask as it now stands. A member-guest consent decline or expiry must not turn
 * it into a terminal BLOCKED row (`consentRemovalRefusalMessage` lets it
 * propagate, so the claim rolls back to PENDING and the sweep or the member
 * retries). A leaf module - only `ApiError` - so a route or the consent service
 * can recognise it without pulling the reduction's payment graph in.
 */
import { ApiError } from "@/lib/api-error";

/** The member's capture, or a retry's claim, landed while the reduction was saved. */
export const ADDITIONAL_ASK_CHANGED_DURING_REDUCTION_MESSAGE =
  "A payment on this booking changed while this was being saved, so nothing was changed. Please try again in a moment.";

/**
 * A retry is minting the booking's card request at this moment (claimed within
 * `RECENT_RECOVERY_CLAIM_MS`); closing it under the retry would leave its old
 * figure live beside the smaller ask. It finishes within seconds.
 */
export const ADDITIONAL_ASK_BEING_RAISED_MESSAGE =
  "A payment request on this booking is being set up right now, so nothing was changed. Please try again in a moment.";

export class AdditionalAskChangedDuringReductionError extends ApiError {
  constructor(message: string = ADDITIONAL_ASK_CHANGED_DURING_REDUCTION_MESSAGE) {
    super(message, 409);
    this.name = "AdditionalAskChangedDuringReductionError";
  }
}
