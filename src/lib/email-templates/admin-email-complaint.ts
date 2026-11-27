/**
 * #5469 (owner decision D3, 27 Nov 2026): the officers' alert for a complaint
 * the mail service reported about an email the club sent, usually the
 * recipient marking it as spam. The address is now blocked, so this is how an
 * officer learns of it. Sent once per complaint by
 * `src/lib/email/admin-alerts-email-complaint.ts`, only once the block is in
 * place. Every value but the page link comes from the report or the member
 * records, so each is escaped.
 */
import { escapeHtml } from "./escape";
import { alertBox, button, heading, infoTable, layout, paragraph } from "./layout";

export function adminEmailComplaintTemplate(data: {
  recipientEmail: string;
  memberNames: string;
  emailNote: string;
  blockNote: string;
  deliverabilityUrl: string;
}): string {
  return layout(`
    ${heading("Complaint About a Club Email")}
    ${paragraph(`The mail service reported a complaint from ${escapeHtml(data.recipientEmail)} about an email from the club. A complaint usually means the recipient marked the email as spam.`)}
    ${infoTable([
      { label: "Address", value: escapeHtml(data.recipientEmail) },
      { label: "Members using this address", value: escapeHtml(data.memberNames) },
      { label: "Email", value: escapeHtml(data.emailNote) },
    ])}
    ${alertBox(escapeHtml(data.blockNote), "warning")}
    ${button("Open Email Deliverability", data.deliverabilityUrl, { sameOrigin: true })}
  `);
}
