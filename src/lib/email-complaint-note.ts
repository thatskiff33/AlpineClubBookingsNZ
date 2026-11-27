/**
 * #5469: the sentences in the officers' complaint alert
 * (`email-templates/admin-email-complaint.ts`), one home for the sender and the
 * email registry's preview. A leaf module, so the registry can preview the
 * tokens without loading the sender. Each must be true whenever the alert goes:
 * it is sent only once the address's block is in place, to officers who hold
 * Support & System edit, which is what lifting a block needs.
 */

export const EMAIL_COMPLAINT_BLOCK_NOTE =
  "The address is now blocked, so this site sends it no further email until the block is lifted. You can see the block, and lift it if they ask to receive email again, on the Email Deliverability page.";

/** The members whose record uses the address, or a plain "none". */
export function emailComplaintMemberNames(names: readonly string[]): string {
  return names.length > 0 ? names.join(", ") : "None: no member record uses this address";
}

/** Which email the complaint was about, when the report could be matched to one. */
export function emailComplaintEmailNote(
  email: { label: string; sentAt: string | null } | null,
): string {
  if (!email) return "The app could not tell which email the complaint was about.";
  return email.sentAt ? `${email.label}, sent ${email.sentAt}` : email.label;
}
