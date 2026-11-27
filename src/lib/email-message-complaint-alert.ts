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
  emailComplaintTypeLabel,
} from "@/lib/email-complaint-note";

export const EMAIL_COMPLAINT_ALERT_TRIGGER: Partial<
  Record<EmailAuditTemplateName, { triggerSummary: string; frequency: string }>
> = {
  "admin-email-complaint": {
    triggerSummary:
      "The mail service reported a complaint from a recipient about an email the club sent, usually the recipient marking it as spam, and the address is now blocked (#5469, owner decisions D3 and D5)",
    frequency:
      "Once per complaint report for each address it names, guarded by a cross-instance claim, and not at all when the template is muted or nobody receives Reported issues alerts. The alert is stored first, and the payments cron's sweep re-sends it until an admin has it or a copy is queued for the email retry cron, for up to 7 days (every 15 minutes after a failed send, a day later when nobody could receive it); a block lifted before it goes withdraws it for good. A 'not spam' report sends nothing",
  },
};

/** The sample for one of this alert's tokens, or undefined for any other token. */
export function emailComplaintAlertSampleValue(token: string): string | undefined {
  if (token === "recipientEmail") return "sam.member@example.org";
  if (token === "complaintType") return emailComplaintTypeLabel("abuse");
  if (token === "memberNames") return emailComplaintMemberNames(["Sam Member"]);
  if (token === "emailNote") return emailComplaintEmailNote({ label: "Booking Confirmed", sentAt: "16 Apr 2026, 2:30 pm" });
  if (token === "blockNote") return EMAIL_COMPLAINT_BLOCK_NOTE;
  if (token === "deliverabilityUrl") return `https://bookings.example.org${adminHref("email-deliverability")}`;
  return undefined;
}

/** The tokens this alert adds to the registry's approved list. */
export const EMAIL_COMPLAINT_ALERT_TOKENS = ["recipientEmail", "complaintType", "memberNames", "emailNote", "blockNote", "deliverabilityUrl"] as const;

/** Whose address, that it is now blocked, and where to lift it: an override must keep these. */
export const EMAIL_COMPLAINT_ALERT_REQUIRED_TOKENS: Partial<Record<EmailAuditTemplateName, string[]>> = {
  "admin-email-complaint": ["recipientEmail", "blockNote", "deliverabilityUrl"],
};
