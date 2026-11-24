/**
 * #5433: the instruction in the officers' alert for a waitlist email that
 * passed its cut-off unsent, one per email. A leaf module, so the email
 * registry can preview the `{{noticeNote}}` token without loading a template
 * (template: `email-templates/admin-waitlist-notice-unsent.ts`).
 */

/**
 * Which waitlist email went unsent: the offer, the offer-expired notice, or
 * (owner decision D5, 24 Nov 2026) an offer that lapsed before its email could
 * ever be sent.
 */
export type WaitlistNoticeUnsent = "offer" | "offer-expired" | "offer-lapsed-untold";

export const WAITLIST_NOTICE_UNSENT_NOTE: Readonly<Record<WaitlistNoticeUnsent, string>> = {
  offer:
    "This member was offered a waitlist place, but the email telling them could not be sent in time, so it will not be sent automatically. They may not know about the offer. Check the booking and contact them if the offer still stands.",
  "offer-expired":
    "This member's waitlist offer lapsed and they are back on the waitlist, but the email telling them could not be sent in time, so it will not be sent automatically. Contact them if they need to know.",
  "offer-lapsed-untold":
    "This member was offered a waitlist place, but the offer lapsed before the email telling them could ever be sent, so they may not have known about it. They keep their place in the queue, but for this place the waitlist considers everyone else waiting for these nights before them. Contact them if you want to step in.",
};
