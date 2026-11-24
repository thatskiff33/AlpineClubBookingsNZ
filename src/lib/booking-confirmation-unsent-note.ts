/**
 * #5433 (owner decision D1): what the officers' "Booking confirmation not
 * sent" alert says. One sentence for the hand-built HTML and the editable
 * default body (`email-message-audit-defaults.ts`), so they cannot drift. It
 * must be true in every case the alert is sent for: the confirmation could not
 * be sent in time, it failed or bounced, or the owner's address cannot be
 * emailed (none, a club placeholder, or on the bounce list). A leaf, so the
 * registry can use it without loading a template.
 */
export const BOOKING_CONFIRMATION_UNSENT_NOTE =
  "This booking was paid, but the email confirming it did not reach the booking's owner, and it will not be sent automatically. Either it could not be sent in time, or it failed or bounced, or the owner has no address that can be emailed. Check the booking, then send a fresh confirmation from its page or contact the owner another way.";
