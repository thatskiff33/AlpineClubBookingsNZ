/**
 * The member's answer to a refund appeal.
 *
 * Both outcomes share one layout so an approval and a decline cannot drift
 * apart in shape. Sent from the admin refund-request review route rather than
 * an `src/lib/email/*` sender, which is why this family has no sender-module
 * twin; the admin-side alert about the same appeal lives in `admin-finance.ts`.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  formatCents,
  heading,
  layout,
  multilineBlock,
  paragraph,
  supportContactSentence,
} from "./layout";
import { emailCalendarDay } from "@/lib/email-templates-club-time";

/**
 * #2321 — the refund-appeal outcome emails, ONE FUNCTION PER OUTCOME.
 *
 * These were a single template switching on a `status` boolean, alongside a
 * single registered `refund-request-resolved` body whose default wording said
 * "approved". The HTML path always branched correctly, but the flat editable
 * body could not — so a club that had saved an override sent approval wording,
 * and a sentence with an empty amount, to members whose appeal was declined.
 * Splitting both the registered template and this function means no surface
 * exists on which one outcome's wording can reach the other's recipient.
 */
function refundRequestOutcomeLayout(data: {
  firstName: string;
  headingText: string;
  outcomeSentence: string;
  outcomeTone: "success" | "warning";
  adminNotes: string | null;
}): string {
  return layout(`
    ${heading(data.headingText)}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${alertBox(data.outcomeSentence, data.outcomeTone)}
    ${data.adminNotes ? multilineBlock("<strong>Notes:</strong>\n" + escapeHtml(data.adminNotes)) : ""}
    ${supportContactSentence("If you have questions, contact the club at ")}
  `);
}

export function refundRequestApprovedTemplate(data: {
  firstName: string;
  amountCents: number | null;
  adminNotes: string | null;
  checkIn: Date;
  checkOut: Date;
}): string {
  return refundRequestOutcomeLayout({
    firstName: data.firstName,
    headingText: "Refund Appeal Approved",
    outcomeSentence:
      "Your refund appeal for your booking (" + emailCalendarDay(data.checkIn) + " - " + emailCalendarDay(data.checkOut) + ") has been approved. A refund of " + formatCents(data.amountCents ?? 0) + " will be processed to your original payment method.",
    outcomeTone: "success",
    adminNotes: data.adminNotes,
  });
}

export function refundRequestDeclinedTemplate(data: {
  firstName: string;
  adminNotes: string | null;
  checkIn: Date;
  checkOut: Date;
}): string {
  // Deliberately takes no amount at all: there is no refund to state, and the
  // parameter's absence is what stops one being printed.
  return refundRequestOutcomeLayout({
    firstName: data.firstName,
    headingText: "Refund Appeal Update",
    outcomeSentence:
      "Your refund appeal for your booking (" + emailCalendarDay(data.checkIn) + " - " + emailCalendarDay(data.checkOut) + ") was not approved at this time.",
    outcomeTone: "warning",
    adminNotes: data.adminNotes,
  });
}
