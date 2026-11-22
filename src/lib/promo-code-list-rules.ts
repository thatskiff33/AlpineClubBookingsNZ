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

/**
 * #3828 (`INV-MOD`): the legacy one-code request fields cannot edit a booking
 * that carries several of the booker's codes — `promoCode` would replace every
 * one of them and `removePromoCode` would release them all.
 */
export const SEVERAL_PROMO_CODES_ONE_CODE_EDIT_MESSAGE =
  "This booking has more than one promo code, so its codes can't be changed one at a time.";

export const DUPLICATE_PROMO_CODE_MESSAGE =
  "The same promo code was entered more than once.";

/** While `multiPromoCodes` is off a working-bee discount stands alone (#3826). */
export const PROMO_WORK_PARTY_EXCLUSION_MESSAGE =
  "A promo code cannot be combined with a working bee discount. Please remove one of them and try again.";

/**
 * The same refusal, said to an officer adding the booking to a work party
 * (#5149): the booking's own code is already on it, so there is nothing for
 * the officer to remove and try again.
 */
export const PROMO_WORK_PARTY_EXCLUSION_OFFICER_MESSAGE =
  "This booking already has a promo code, which can't be combined with a work party discount.";

/** Who a refusal is said to: the booker (the default), or an officer correcting the booking. */
export type PromoCodeListAudience = "booker" | "officer";

/**
 * The refusal a code list earns, or null. `typedCodes` are the booker's codes,
 * already normalised (`normalizePromoCodeInput`); `workPartyApplied` says a
 * working-bee discount is on the booking beside them. `audience` words the
 * refusal for who will read it; the rule is the same for both.
 */
export function promoCodeListRefusal(input: {
  typedCodes: readonly string[];
  workPartyApplied: boolean;
  multiPromoCodes: boolean;
  audience?: PromoCodeListAudience;
}): string | null {
  if (new Set(input.typedCodes).size !== input.typedCodes.length) {
    return DUPLICATE_PROMO_CODE_MESSAGE;
  }
  if (input.multiPromoCodes) return null;
  if (input.workPartyApplied && input.typedCodes.length > 0) {
    return input.audience === "officer" ? PROMO_WORK_PARTY_EXCLUSION_OFFICER_MESSAGE : PROMO_WORK_PARTY_EXCLUSION_MESSAGE;
  }
  if (input.typedCodes.length > 1) return ONE_PROMO_CODE_PER_BOOKING_MESSAGE;
  return null;
}

/**
 * Whether a code an edit names may be applied. Internal promos (work party
 * events) cannot be entered as codes, and a code renamed between the unlocked
 * read and the lock is not found (`promoCode` undefined). Fork triyder/AlpineClubBookingsNZ#119: the one
 * exception is the internal code `admittedInternalPromoCodeId` names, the work
 * party an officer's "Add booking to work party" is adding. That is a service
 * argument the batch service receives beside `tx`, never a request-body field,
 * so no member route can set it; every other internal code is still refused as
 * not found. Its one caller is `applyPromoCodeChanges`.
 */
export function enteredPromoCodeAdmitted<T extends { id: string; internal: boolean }>(
  promoCode: T | undefined,
  admittedInternalPromoCodeId: string | null,
): promoCode is T {
  if (!promoCode) return false;
  return !promoCode.internal || promoCode.id === admittedInternalPromoCodeId;
}

/** Fork triyder/AlpineClubBookingsNZ#119/triyder/AlpineClubBookingsNZ#130: the work party an officer's correction adds or removes, by its internal code. */
export type WorkPartyCodeCorrection = { readonly promoCodeId: string; readonly direction: "add" | "remove" };

/** The one internal code a correction admits: an Add's. A Remove (fork triyder/AlpineClubBookingsNZ#130) admits none. */
export function admittedWorkPartyCodeId(correction: WorkPartyCodeCorrection | null): string | null {
  return correction?.direction === "add" ? correction.promoCodeId : null;
}

/**
 * Fork triyder/AlpineClubBookingsNZ#130: with several codes on, a stored internal code a list leaves out
 * is carried; the officer removing that work party drops it instead.
 */
export function withoutRemovedWorkPartyCode<E extends { code: string }>(
  requested: E[] | null,
  stored: ReadonlyArray<{ promoCodeId: string; promoCode: { code: string } }>,
  correction: WorkPartyCodeCorrection | null,
): E[] | null {
  if (correction?.direction !== "remove") return requested;
  const removed = stored.find((row) => row.promoCodeId === correction.promoCodeId)?.promoCode.code;
  return requested?.filter((entry) => entry.code !== removed) ?? null;
}
