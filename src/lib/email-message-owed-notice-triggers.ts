/**
 * The email registry's trigger metadata for the officers' alerts raised when
 * an owed notice did not reach the member it was owed to (#5433). Moved out of
 * `TEMPLATE_TRIGGER_METADATA` in `email-message-registry.ts`, which is past its
 * size ceiling; that object spreads this one in. Each entry says when the
 * alert goes and how often, as the template editor shows it.
 */
import type { EmailAuditTemplateName } from "@/lib/email-message-audit-defaults";

export const OWED_NOTICE_ALERT_TRIGGERS: Partial<
  Record<EmailAuditTemplateName, { triggerSummary: string; frequency: string }>
> = {
  "admin-waitlist-notice-unsent": {
    triggerSummary: "A waitlist email owed to a member (the offer of a place, or the notice that an offer lapsed) could not be sent before its cut-off; an offer email's send did not reach the member (it bounced, failed for good, or their address cannot be emailed); or an offer lapsed with its email not known to have reached them (#5433, owner decisions D2 and D5)",
    frequency:
      "Once per unsent notice, and once per offer for its email and its lapse together, guarded by a cross-instance claim. The claim is kept once any admin is sent it or has a copy queued for the email retry cron, held for a day when no admin can receive it, and given back when the send throws before reaching anyone",
  },
  "admin-booking-confirmation-unsent": {
    triggerSummary: "A booking paid by card owed its owner a confirmation email that did not reach them: it could not be sent by the end of the check-in day (or within seven days of the payment), it failed or bounced, or the owner's address cannot be emailed (#5433, owner decision D1)",
    frequency:
      "Once per paid booking, guarded by a cross-instance claim. The claim is kept once any admin is sent it or has a copy queued for the email retry cron, held for a day when no admin can receive it, and given back when the send throws before reaching anyone",
  },
};
