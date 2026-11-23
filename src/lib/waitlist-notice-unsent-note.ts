/**
 * #5433: the instruction in the officers' alert for a waitlist email that
 * passed its cut-off unsent, one per email. A leaf module, so the email
 * registry can preview the `{{noticeNote}}` token without loading a template
 * (template: `email-templates/admin-waitlist-notice-unsent.ts`).
 */

/** Which waitlist email went unsent. */
export type WaitlistNoticeUnsent = "offer" | "offer-expired";

export const WAITLIST_NOTICE_UNSENT_NOTE: Readonly<Record<WaitlistNoticeUnsent, string>> = {
  offer:
    "This member was offered a waitlist place, but the email telling them could not be sent in time, so it will not be sent automatically. They may not know about the offer. Check the booking and contact them if the offer still stands.",
  "offer-expired":
    "This member's waitlist offer lapsed and they are back on the waitlist, but the email telling them could not be sent in time, so it will not be sent automatically. Contact them if they need to know.",
};
