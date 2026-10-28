/**
 * Group-booking settlement emails: the organiser's receipt, and what each
 * joiner is told when a combined payment settles, expires, releases or is
 * cancelled.
 *
 * The family boundary is `src/lib/email/groups.ts`.
 */
import { escapeHtml } from "./escape";
import {
  formatCents,
  heading,
  infoTable,
  layout,
  paragraph,
  supportContactSentence,
} from "./layout";
import { CLUB_NAME } from "@/config/club-identity";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import type { ClubFormat } from "@/lib/club-format";
import { organiserJoinerAppealRefundSentence } from "@/lib/booking-modified-email-copy";

export function groupSettlementReceiptTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
},
  format: ClubFormat,
): string {
  return layout(`
    ${heading("Your Group Booking Is Settled")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", thanks for settling your group's stay at " + escapeHtml(CLUB_NAME) + "'s lodge. Everyone you are paying for is now confirmed.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Joiners settled", value: String(data.joinerCount) },
      { label: "Total paid", value: formatCents(data.totalCents, format) },
    ])}
    ${paragraph("Each joiner has been emailed to confirm their spot. There is nothing more for them to pay.")}
    ${supportContactSentence("If anything looks wrong, contact the club at ")}
  `);
}

export function groupJoinSettledTemplate(data: {
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
}): string {
  return layout(`
    ${heading("Your Spot Is Confirmed")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", " + escapeHtml(data.organiserName) + " has settled the cost of your stay at " + escapeHtml(CLUB_NAME) + "'s lodge as part of their group booking. Your spot is confirmed and there is nothing for you to pay.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
    ])}
    ${supportContactSentence("If you have any questions about your stay, contact the club at ")}
  `);
}

/**
 * #3672 (`INV-PAY-109`): the organiser paid the group's bill before this
 * joiner was on it, so the joiner now pays for their own place. The booking
 * link (added for every booking-scoped message) takes them to the pay step.
 */
export function groupJoinPaySelfTemplate(data: {
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Please Pay For Your Place")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", " + escapeHtml(data.organiserName) + " has paid for their group's stay at " + escapeHtml(CLUB_NAME) + "'s lodge. You joined after that payment was prepared, so your place was not included in it.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
    ])}
    ${paragraph("Your place is not confirmed until you pay for it yourself. Open your booking to pay.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

export function groupSettlementExpiredTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
},
  format: ClubFormat,
): string {
  return layout(`
    ${heading("Your Group Settlement Has Expired")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", the combined payment you started for your group's stay at " + escapeHtml(CLUB_NAME) + "'s lodge was not completed in time, so the beds held for your joiners have been released.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Joiners affected", value: String(data.joinerCount) },
      { label: "Amount not charged", value: formatCents(data.totalCents, format) },
    ])}
    ${paragraph("No money has been taken. If your group still plans to come, restart the payment from your group booking page — the beds are subject to availability.")}
    ${supportContactSentence("If anything looks wrong, contact the club at ")}
  `);
}

export function groupJoinReleasedTemplate(data: {
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Your Held Spot Has Been Released")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", " + escapeHtml(data.organiserName) + " started a combined payment for your stay at " + escapeHtml(CLUB_NAME) + "'s lodge but it was not completed in time, so your held bed has been released.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
    ])}
    ${paragraph("Your booking is back to awaiting payment. If the group still plans to come, the organiser can restart the payment — or check with them about what happens next.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

/**
 * Final notice after a reaped organiser-pays place is cancelled (#1094): the
 * organiser never restarted the combined payment, so the joiner's pending
 * booking reached its terminal state.
 */
export function groupJoinCancelledTemplate(data: {
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Your Group Booking Has Been Cancelled")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", the combined group payment " + escapeHtml(data.organiserName) + " started for your stay at " + escapeHtml(CLUB_NAME) + "'s lodge was never completed, so your pending booking has now been cancelled. Nothing has been charged to you.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
    ])}
    ${paragraph("If you still want to come, you can make your own booking for these dates — or talk to the organiser about starting a fresh group trip.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

/**
 * #3956 (`INV-PAY-123`): the organiser's notice that a joiner's approved refund
 * appeal is being refunded to the card they paid for the group with.
 */
export function groupOrganiserJoinerRefundTemplate(data: {
  firstName: string;
  joinerName: string;
  amountCents: number;
  checkIn: Date;
  checkOut: Date;
},
  format: ClubFormat,
): string {
  return layout(`
    ${heading("Refund to Your Card")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${paragraph(escapeHtml(organiserJoinerAppealRefundSentence(formatCents(data.amountCents, format), data.joinerName)))}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
    ])}
    ${supportContactSentence("If you have questions, contact the club at ")}
  `);
}

/**
 * #4299 (`INV-PAY-147`): the organiser's extra invoice when a place in their
 * internet-banking group costs more.
 */
export function groupOrganiserExtraInvoiceTemplate(data: {
  firstName: string;
  joinerName: string;
  changeSummary: string;
  amountCents: number;
  xeroInvoiceNumber: string;
},
  format: ClubFormat,
): string {
  return layout(`
      ${heading("Extra Invoice for Your Group Booking")}
      ${paragraph(`Hi ${escapeHtml(data.firstName)}, a change to a place in the group you paid for by internet banking has increased its cost. As the group organiser, you are responsible for this extra payment.`)}
      ${infoTable([
        { label: "Place", value: escapeHtml(data.joinerName) },
        { label: "Change", value: escapeHtml(data.changeSummary) },
        { label: "Extra amount to pay", value: formatCents(data.amountCents, format) },
        { label: "Invoice reference", value: escapeHtml(data.xeroInvoiceNumber) },
      ])}
      ${paragraph("Please pay this extra invoice by internet banking, quoting the invoice reference above.")}
      ${supportContactSentence("If you need the club's bank details or think this invoice is wrong, contact the club at ")}
    `);
}
