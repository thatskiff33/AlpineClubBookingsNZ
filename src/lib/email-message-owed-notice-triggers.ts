/**
 * The email registry's metadata for the officers' alerts raised when an owed
 * notice did not reach the member it was owed to (#5433): their default
 * subject and body, the tokens an edited body must keep, and when each alert
 * goes and how often, as the template editor shows it. Moved out of `REQUIRED_TEMPLATE_TOKENS` and
 * `TEMPLATE_TRIGGER_METADATA` in `email-message-registry.ts`, which is past its
 * size ceiling; those objects spread these in.
 */
import { BOOKING_CONFIRMATION_UNSENT_NOTE } from "@/lib/booking-confirmation-unsent-note";
import type { EmailAuditTemplateName } from "@/lib/email-message-audit-defaults";

/**
 * These alerts' default subject and body, spread into the audit defaults
 * (`email-message-audit-defaults.ts`, past its size budget) through
 * `email-message-external-alerts.ts`. Typed by their own literal keys, never by
 * `EmailAuditTemplateName`, which is derived from the map they join.
 */
export const OWED_NOTICE_ALERT_DEFAULTS = {
  // #5433: a waitlist email owed to a member passed its cut-off unsent.
  "admin-waitlist-notice-unsent": {
    "defaultSubject": "Waitlist email not sent: {{memberName}}",
    "defaultBody": "Waitlist Email Not Sent\n\n{{noticeNote}}\n\nMember: {{memberName}}\nBooking: {{bookingReference}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\nOpen Booking: {{bookingUrl}}"
  },
  // #5433 (owner decision D1): a paid booking's confirmation did not reach its owner.
  "admin-booking-confirmation-unsent": {
    "defaultSubject": "Booking confirmation not sent: {{memberName}}",
    "defaultBody": "Booking Confirmation Not Sent\n\n" + BOOKING_CONFIRMATION_UNSENT_NOTE + "\n\nOwner: {{memberName}}\nBooking: {{bookingReference}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\nOpen Booking: {{bookingUrl}}"
  },
  "admin-booking-notice-unsent": { "defaultSubject": "Booking email not sent: {{memberName}}", "defaultBody": "Booking Email Not Sent\n\n{{unsentNote}}\n\nOwner: {{memberName}}\nBooking: {{bookingReference}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\n\nOpen Booking: {{bookingUrl}}" }, // #5433 PR 4
} as const;

/**
 * The member and the booking link are what an officer acts on; a note token
 * says which email went unsent and what to do (`{{noticeNote}}` for the
 * waitlist's, `{{unsentNote}}` for the hold-deadline job's, #5433 PR 4).
 */
export const OWED_NOTICE_ALERT_REQUIRED_TOKENS: Partial<Record<EmailAuditTemplateName, string[]>> = {
  "admin-waitlist-notice-unsent": ["noticeNote", "memberName", "bookingUrl"],
  "admin-booking-confirmation-unsent": ["memberName", "bookingUrl"],
  "admin-booking-notice-unsent": ["unsentNote", "memberName", "bookingUrl"],
};

export const OWED_NOTICE_ALERT_TRIGGERS: Partial<
  Record<EmailAuditTemplateName, { triggerSummary: string; frequency: string }>
> = {
  "admin-waitlist-notice-unsent": {
    triggerSummary: "A waitlist email owed to a member (the offer of a place, or the notice that an offer lapsed) could not be sent before its cut-off; an offer email's send did not reach the member (it bounced, failed for good, or their address cannot be emailed); or an offer lapsed with its email not known to have reached them (#5433, owner decisions D2 and D5)",
    frequency:
      "Once per unsent notice, and once per offer for its email and its lapse together, guarded by a cross-instance claim. The claim is kept once any admin is sent it or has a copy queued for the email retry cron, held for a day when no admin can receive it, and given back when the send throws before reaching anyone",
  },
  "admin-booking-confirmation-unsent": {
    triggerSummary: "A booking paid by card, or confirmed at no charge by the hold-deadline job, owed its owner a confirmation email that did not reach them: it could not be sent by the end of the check-in day (or within seven days of the payment), it failed or bounced, or the owner's address cannot be emailed (#5433, owner decision D1)",
    frequency:
      "Once per paid booking, guarded by a cross-instance claim. The claim is kept once any admin is sent it or has a copy queued for the email retry cron, held for a day when no admin can receive it, and given back when the send throws before reaching anyone",
  },
  "admin-booking-notice-unsent": {
    triggerSummary: "An email the hold-deadline job owed a booking's owner did not reach them: the requester's notice that an unpaid request booking was released, the member's notice that their guests' unpaid provisional place was cancelled, or the request to save a new card after a saved card was found unusable, each when it could not be sent in time (within seven days, and by the end of the check-out day for a cancellation or the check-in day for a new card) or did not reach them (it failed or bounced, or the owner's address cannot be emailed at all); or the link to pay for a member's guests, when it could not be sent by the end of the check-in day or within seven days (#5433, owner decisions D9 and D10)",
    frequency:
      "Once per unsent email, guarded by a cross-instance claim. The claim is kept once any admin is sent it or has a copy queued for the email retry cron, held for a day when no admin can receive it, and given back when the send throws before reaching anyone",
  },
};
