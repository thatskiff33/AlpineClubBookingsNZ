/**
 * The email registry's entries for the officers' complaint alert
 * (`admin-email-complaint`, #5469 owner decision D3): when it goes, and its
 * preview samples, each the sender's own wording. Kept out of
 * `email-message-registry.ts`, which is past its size ceiling; that file
 * spreads the trigger in and asks here for these tokens' samples.
 */
import { adminHref } from "@/lib/admin-hubs";
import type { EmailAuditTemplateName } from "@/lib/email-message-audit-defaults";
import {
  EMAIL_COMPLAINT_BLOCK_NOTE,
  emailComplaintEmailNote,
  emailComplaintMemberNames,
} from "@/lib/email-complaint-note";

export const EMAIL_COMPLAINT_ALERT_TRIGGER: Partial<
  Record<EmailAuditTemplateName, { triggerSummary: string; frequency: string }>
> = {
  "admin-email-complaint": {
    triggerSummary:
      "The mail service reported a complaint from a recipient about an email the club sent, usually the recipient marking it as spam, and the address is now blocked (#5469, owner decision D3)",
    frequency:
      "Once per complaint, guarded by a cross-instance claim. The claim is kept once any admin is sent it or has a copy queued for the email retry cron, held for a day when no admin can receive it, and given back when the send throws, so the mail service's next delivery of the report sends it",
  },
};

/** The sample for one of this alert's tokens, or undefined for any other token. */
export function emailComplaintAlertSampleValue(token: string): string | undefined {
  if (token === "recipientEmail") return "sam.member@example.org";
  if (token === "memberNames") return emailComplaintMemberNames(["Sam Member"]);
  if (token === "emailNote") return emailComplaintEmailNote({ label: "Booking Confirmed", sentAt: "16 Apr 2026, 2:30 pm" });
  if (token === "blockNote") return EMAIL_COMPLAINT_BLOCK_NOTE;
  if (token === "deliverabilityUrl") return `https://bookings.example.org${adminHref("email-deliverability")}`;
  return undefined;
}
