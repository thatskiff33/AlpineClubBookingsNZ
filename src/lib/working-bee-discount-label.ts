/**
 * The member-facing name of a work party's promotion (#5066, `INV-SSOT`): the
 * booking page, the booking wizard's promo rows and the generated invoice all
 * name it this way, never by its internal code, which is the club's. Pure and
 * client-safe.
 */
export const WORKING_BEE_DISCOUNT_LABEL = "Working bee discount";

/** `Working bee discount (Spring working bee)`, or the bare label with no event name. */
export function workingBeeDiscountLabel(eventName: string | null | undefined): string {
  return eventName ? `${WORKING_BEE_DISCOUNT_LABEL} (${eventName})` : WORKING_BEE_DISCOUNT_LABEL;
}
