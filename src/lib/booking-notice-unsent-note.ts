/**
 * #5433 PR 4: what the officers' "Booking email not sent" alert says, one
 * sentence per member notice the confirm-pending job owes. One definition for
 * the hand-built HTML, the sender's `{{unsentNote}}` and the registry's
 * preview, so they cannot drift. A leaf, so the registry can use it without
 * loading a template (template: `email-templates/admin-booking-notice-unsent.ts`).
 *
 * One alert for these four notices, not one each: the two "not sent" alerts
 * before it (`admin-booking-confirmation-unsent`, `admin-waitlist-notice-unsent`)
 * keep their own names, subjects and bodies, because officers' preferences and
 * any body an officer has edited are stored against those names.
 *
 * Each note must be true in every case its notice alerts for: past the
 * notice's cut-off (it could not be sent in time), or after a send that did
 * not reach the member (it failed for good, bounced, or the owner has no
 * address that can be emailed). The payment link alerts only past its cut-off.
 * None advises an action the app refuses: contacting the owner is always open.
 */

/** Which member notice did not reach its owner. */
export type BookingNoticeUnsent = "request-hold-cancelled" | "split-guest-cancelled" | "split-guest-payment-link" | "saved-card-unusable";

const DID_NOT_REACH = "(it could not be sent in time, failed, bounced, or the owner has no address that can be emailed), and it will not be sent automatically.";

export const BOOKING_NOTICE_UNSENT_NOTE: Readonly<Record<BookingNoticeUnsent, string>> = {
  "request-hold-cancelled":
    `This booking, made from an approved booking request, was cancelled automatically because it was still unpaid at the end of its check-in day, and its beds were released. The email telling the requester did not reach them ${DID_NOT_REACH} Contact them if they need to know.`,
  "split-guest-cancelled":
    `This provisional booking for a member's guests was cancelled automatically because the guests' portion was still unpaid at the end of the check-in day. The email telling the member did not reach them ${DID_NOT_REACH} Contact them if they need to know.`,
  "split-guest-payment-link":
    "The email with the link to pay for this member's guests' portion could not be sent in time, and it will not be sent automatically. The guests' portion is still unpaid. Check the booking and contact the member.",
  "saved-card-unusable":
    `This booking's saved card was found unusable and was removed. The email asking the owner to save a new card did not reach them ${DID_NOT_REACH} Contact them if the booking still needs a card.`,
};
