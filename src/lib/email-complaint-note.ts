/**
 * #5469: the sentences in the officers' complaint alert
 * (`email-templates/admin-email-complaint.ts`), one home for the sender and the
 * email registry's preview. A leaf module, so the registry can preview the
 * tokens without loading the sender. Each must be true whenever the alert goes:
 * it is sent only while the address's block is in place, to officers who hold
 * Support & System edit, which is what lifting a block needs.
 */
import type { ComplaintType } from "@/lib/email/delivery-feedback";

/**
 * "This site's own emails": invoices that Xero emails at the app's request do
 * not consult the block, and stay that way (owner decision D7, 28 Nov 2026), so
 * the alert names them as the exception.
 */
export const EMAIL_COMPLAINT_BLOCK_NOTE =
  "The address is now blocked, so this site sends it none of its own emails until the block is lifted. Invoices emailed by Xero are not covered by the block. You can see the block, and lift it if they ask to receive email again, on the Email Deliverability page.";

/** A complaint's type in plain words. */
const COMPLAINT_TYPE_LABEL: Readonly<Record<ComplaintType, string>> = {
  abuse: "Marked as spam or abuse",
  fraud: "Reported as fraud or phishing",
  virus: "Reported as carrying a virus",
  "auth-failure": "Reported as failing email authentication checks",
  other: "Another kind of complaint",
  "not-given": "Not given by the mail service",
  unrecognised: "A type the app does not recognise",
};

export function emailComplaintTypeLabel(type: string): string {
  return COMPLAINT_TYPE_LABEL[type as ComplaintType] ?? COMPLAINT_TYPE_LABEL.unrecognised;
}

/** The members whose record uses the address, the rest counted, or a plain "none". */
export function emailComplaintMemberNames(names: readonly string[], total: number = names.length): string {
  if (names.length === 0) return "None: no member record uses this address";
  const more = total - names.length;
  return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
}

/** Which email the complaint was about, when the report could be matched to one. */
export function emailComplaintEmailNote(
  email: { label: string; sentAt: string | null } | null,
): string {
  if (!email) return "The app could not tell which email the complaint was about.";
  return email.sentAt ? `${email.label}, sent ${email.sentAt}` : email.label;
}
