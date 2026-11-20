/**
 * `XeroObjectLink.role` values of the credit notes a booking edit raises
 * (#5066 review F7, `INV-SSOT`). Plain module, no imports, so any layer can
 * read it. Older sites still spell these as literals; new readers use these.
 */

/** An edit's reduction applied against the booking's invoice (`localModel` Booking or BookingModification). */
export const MODIFICATION_CREDIT_NOTE_ROLE = "MODIFICATION_CREDIT_NOTE";

/** An edit's reduction moved to the member's account credit (`localModel` BookingModification). */
export const MODIFICATION_ACCOUNT_CREDIT_NOTE_ROLE = "MODIFICATION_ACCOUNT_CREDIT_NOTE";

/** A payment's money moved to the member's account credit (`localModel` Payment). */
export const ACCOUNT_CREDIT_NOTE_ROLE = "ACCOUNT_CREDIT_NOTE";
