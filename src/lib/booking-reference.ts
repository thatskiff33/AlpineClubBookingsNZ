/**
 * The short, human-readable handle for a booking (#2576 §6).
 *
 * Bookings are keyed by cuid, which nobody can read out over the phone or match
 * against the reference on their confirmation email. The admin occupancy report
 * has shown an 8-character uppercase prefix since it shipped, and #2576 needs the
 * same handle in a MEMBER-facing refusal ("this change would leave booking
 * A1B2C3D4 without cover"), so the one rendering now lives here and both callers
 * read it.
 *
 * PREFIX, NOT A HASH, and deliberately so: it is derived from the id the member
 * can see in their own booking URL, so the two agree, and a support conversation
 * can go either way between them. It is not claimed to be unique — a cuid's first
 * 8 characters are its timestamp-ish prefix, so two bookings created in the same
 * moment can share one. So it is displayed beside the lodge and the dates, and
 * the one search that accepts it (AI Diagnostics' booking search) returns every
 * booking sharing it and asks which one is meant; nothing resolves it to a
 * single booking.
 */
export function formatBookingReference(bookingId: string): string {
  return storedShortBookingId(bookingId).toUpperCase();
}

/**
 * How many leading characters of a booking id the short forms keep (#5407 item
 * 36). The one definition: `storedShortBookingId` below, the AI Diagnostics
 * packs' SQL (`pg_catalog.left(<id>, ${SHORT_BOOKING_ID_LENGTH})`) and
 * `BOOKING_REFERENCE_SHAPE` all read it. Changing it changes stored text, so it
 * does not change (see `storedShortBookingId`).
 */
export const SHORT_BOOKING_ID_LENGTH = 8;

/**
 * What a booking reference typed by a person can look like: exactly
 * `SHORT_BOOKING_ID_LENGTH` letters or digits, either case. The AI Diagnostics
 * booking and finance searches refuse anything else, because any other length
 * could match no booking and would read as "there is no such booking".
 */
export const BOOKING_REFERENCE_SHAPE = new RegExp(`^[A-Za-z0-9]{${SHORT_BOOKING_ID_LENGTH}}$`);

/**
 * THE SHORT BOOKING ID AS STORED (#5407 item 36): the first eight characters of
 * a booking's or group booking's id, exactly as written, never re-cased.
 *
 * PERSISTED AND MATCHED: NEVER CHANGE WHAT THIS RETURNS. It is written into Xero
 * invoice, credit-note and payment references and line descriptions, into
 * credit-ledger descriptions, and (upper-cased by their builders in
 * `booking-payment-methods.ts`) into the Internet Banking references members
 * type into their bank. Records already written carry it, and readers match
 * some of them exactly (`cancellationCreditDescription`,
 * `buildBookingAppliedCreditDescription`), so a new length or case would leave
 * every earlier record unmatched. Officer-facing text that points at those
 * records uses it too, so it reads as Xero shows it.
 *
 * Not the display handle: a member or officer reads `formatBookingReference`.
 * `stored-short-booking-id-census.test.ts` fails on a `.slice`, `.substring`
 * or `.substr` short form in TypeScript, or a SQL `left(<id>, 8)`, written
 * anywhere else; its header lists what it cannot see. `booking-reference.test.ts`
 * pins the output.
 */
export function storedShortBookingId(bookingId: string): string {
  return bookingId.slice(0, SHORT_BOOKING_ID_LENGTH);
}
