/**
 * #3827 (`INV-SSOT-001`): THE ONE HOME for what a LIST of promo codes may hold,
 * before any code is priced — the stored spelling of a typed code, the refusal
 * for the same code twice, and the refusals while the club's `multiPromoCodes`
 * switch is off (#3826). The create, the edit save, the edit preview and the
 * several-code check all read it, so the four answer one request one way.
 *
 * A leaf: no Prisma and no module flags. Each caller reads the switch the way
 * its own transaction allows and passes the answer in.
 */

/** ONE spelling of a typed promo code as it is stored (#3770). */
export function normalizePromoCodeInput(code: string): string {
  return code.toUpperCase().trim();
}

/** While `multiPromoCodes` is off a booking holds one code (#3826). */
export const ONE_PROMO_CODE_PER_BOOKING_MESSAGE =
  "Only one promo code can be used on a booking.";

export const DUPLICATE_PROMO_CODE_MESSAGE =
  "The same promo code was entered more than once.";

/** While `multiPromoCodes` is off a working-bee discount stands alone (#3826). */
export const PROMO_WORK_PARTY_EXCLUSION_MESSAGE =
  "A promo code cannot be combined with a working bee discount. Please remove one of them and try again.";

/**
 * The refusal a code list earns, or null. `typedCodes` are the booker's codes,
 * already normalised (`normalizePromoCodeInput`); `workPartyApplied` says a
 * working-bee discount is on the booking beside them.
 */
export function promoCodeListRefusal(input: {
  typedCodes: readonly string[];
  workPartyApplied: boolean;
  multiPromoCodes: boolean;
}): string | null {
  if (new Set(input.typedCodes).size !== input.typedCodes.length) {
    return DUPLICATE_PROMO_CODE_MESSAGE;
  }
  if (input.multiPromoCodes) return null;
  if (input.workPartyApplied && input.typedCodes.length > 0) {
    return PROMO_WORK_PARTY_EXCLUSION_MESSAGE;
  }
  if (input.typedCodes.length > 1) return ONE_PROMO_CODE_PER_BOOKING_MESSAGE;
  return null;
}
