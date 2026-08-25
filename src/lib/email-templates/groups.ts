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

export function groupSettlementReceiptTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
}): string {
  return layout(`
    ${heading("Your Group Booking Is Settled")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", thanks for settling your group's stay at " + escapeHtml(CLUB_NAME) + "'s lodge. Everyone you are paying for is now confirmed.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Joiners settled", value: String(data.joinerCount) },
      { label: "Total paid", value: formatCents(data.totalCents) },
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

export function groupSettlementExpiredTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
}): string {
  return layout(`
    ${heading("Your Group Settlement Has Expired")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", the combined payment you started for your group's stay at " + escapeHtml(CLUB_NAME) + "'s lodge was not completed in time, so the beds held for your joiners have been released.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Joiners affected", value: String(data.joinerCount) },
      { label: "Amount not charged", value: formatCents(data.totalCents) },
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
