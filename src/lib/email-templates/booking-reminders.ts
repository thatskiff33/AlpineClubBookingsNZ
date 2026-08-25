/**
 * Emails sent ahead of a stay: the check-in and pre-arrival reminders, the
 * chaser for an unpaid increase, and the whole-lodge guest-names request.
 *
 * Same sender family as `./booking` (`src/lib/email/booking.ts`); split off it
 * for size. The arrival instructions block is shared from `./booking`, where
 * the confirmation email also uses it.
 */
import { arrivalInstructionsSection } from "./booking";
import { escapeHtml } from "./escape";
import {
  alertBox,
  BASE_URL,
  button,
  formatCents,
  heading,
  infoTable,
  layout,
  muted,
  paragraph,
  supportContactSentence,
} from "./layout";
import { CLUB_LODGE_TRAVEL_NOTE, CLUB_NAME } from "@/config/club-identity";
import { emailPalette } from "@/lib/email-theme";
import { emailCalendarDay, emailClubDate } from "@/lib/email-templates-club-time";

// ---- N-01: Check-in Reminder ----

export function checkinReminderTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guests: Array<{ firstName: string; lastName: string }>,
  chores: Array<{ name: string; description: string | null }>
): string {
  const p = emailPalette();
  const guestListHtml = guests
    .map((g) => `<li style="padding: 4px 0; color: ${p.deep}; font-size: 14px;">${escapeHtml(g.firstName)} ${escapeHtml(g.lastName)}</li>`)
    .join("");

  const choreSection = chores.length > 0
    ? `${paragraph("<strong>Your arrival day chores:</strong>")}${infoTable(chores.map((c) => ({ label: escapeHtml(c.name), value: c.description ? escapeHtml(c.description) : "" })))}`
    : "";

  return layout(`
    ${heading("Check-in Reminder")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge stay begins <strong>tomorrow</strong>!")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(checkIn) },
      { label: "Check-out", value: emailCalendarDay(checkOut) },
      { label: "Guests", value: String(guests.length) },
    ])}
    ${paragraph("<strong>Guest list:</strong>")}
    <ul style="margin: 0 0 16px 0; padding-left: 20px;">${guestListHtml}</ul>
    ${choreSection}
    ${alertBox("Please ensure you arrive prepared for alpine conditions. Check the weather forecast before departing.", "info")}
    ${paragraph(CLUB_LODGE_TRAVEL_NOTE)}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

export function preArrivalReminderTemplate(params: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expectedArrivalTime?: string | null;
  lodgeTravelNote: string;
  doorCode?: string | null;
  // #2350: extra still owing on this booking after an upward change, when the
  // stay is about to start and it has not been collected. Zero/absent for the
  // ordinary case, which renders exactly as before.
  outstandingAdditionalAmountCents?: number;
  // #2621 (owner decision D-M5): the checkout-day chore sentence, composed by
  // the sender with `checkoutDayChoreNote` and EMPTY for a club that does not
  // run a chore roster — the chores module defaults OFF. Handed in rather than
  // written here so this HTML and the admin-editable body's
  // {{checkoutChoreNote}} cannot say different things (the
  // {{namingUrgencyNote}} convention). Omitted reads as empty, which is the
  // fail-quiet direction: a member never sees a roster instruction the club may
  // not mean.
  checkoutChoreNote?: string;
}): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Check-in", value: emailCalendarDay(params.checkIn) },
    { label: "Check-out", value: emailCalendarDay(params.checkOut) },
    { label: "Guests", value: String(params.guestCount) },
  ];

  if (params.expectedArrivalTime) {
    rows.push({
      label: "Expected arrival",
      value: escapeHtml(params.expectedArrivalTime),
    });
  }

  return layout(`
    ${heading("Upcoming Lodge Stay")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ", your lodge stay is coming up.")}
    ${infoTable(rows)}
    ${params.checkoutChoreNote ? paragraph(escapeHtml(params.checkoutChoreNote)) : ""}
    ${outstandingAdditionalPaymentNote(params.outstandingAdditionalAmountCents)}
    ${arrivalInstructionsSection({
      travelNote: params.lodgeTravelNote,
      doorCode: params.doorCode,
    })}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

/**
 * The one-line "there is still money owing on this booking" block (#2350),
 * shared by the pre-arrival reminder and the standalone additional-payment
 * reminder so both say the same thing in the same words. Empty for a booking
 * with nothing outstanding, so the surrounding template is unchanged.
 */
function outstandingAdditionalPaymentNote(amountCents: number | undefined): string {
  if (!amountCents || amountCents <= 0) return "";
  return alertBox(
    `There is still ${formatCents(amountCents)} to pay on this booking after a change to your stay. Please pay it from your booking page before you arrive.`,
    "warning",
  );
}

/**
 * F-#2350: standalone reminder that an additional payment raised by a booking
 * change has not been collected. Sent automatically a few days after the change
 * and again shortly before check-in, and by an admin on demand from the booking
 * page. Carries no token or link secret, so its rendered body is retained
 * normally.
 */
export function additionalPaymentReminderTemplate(params: {
  firstName: string;
  additionalAmountCents: number;
  checkIn: Date;
  checkOut: Date;
  requestedOn: Date;
}): string {
  return layout(`
    ${heading("Payment Still Needed")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ", a change to your lodge booking increased the total, and the extra amount has not been paid yet.")}
    ${infoTable([
      { label: "Amount still to pay", value: formatCents(params.additionalAmountCents) },
      { label: "Requested on", value: emailClubDate(params.requestedOn) },
      { label: "Check-in", value: emailCalendarDay(params.checkIn) },
      { label: "Check-out", value: emailCalendarDay(params.checkOut) },
    ])}
    ${alertBox(
      "Open your booking and complete the outstanding payment. If you have already paid, or you think this is wrong, please contact the club.",
      "warning",
    )}
    ${button("Pay Now", BASE_URL + "/bookings")}
  `);
}

/**
 * #2550 — member-facing reminder that a whole-lodge booking's party is still
 * "Guest 1..N".
 *
 * The member renames their own guests through the ordinary booking-guest edit
 * path, so this message carries NO token and no public page: the canonical
 * authenticated booking link is appended centrally for every booking-scoped
 * send (`finalizeBookingEmailHtml`).
 *
 * `urgencyNote` arrives ALREADY COMPOSED from
 * `wholeLodgeGuestNamesUrgencyNote`, and the sender hands the identical string
 * to the `{{namingUrgencyNote}}` token, so the HTML and the admin-editable flat
 * body cannot drift.
 */
export function wholeLodgeGuestNamesReminderTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  unnamedGuestCount: number;
  isFinal: boolean;
  urgencyNote: string;
}): string {
  return layout(`
    ${heading(data.isFinal ? "Last Chance: Who Is Coming With You?" : "Who Is Coming With You?")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", your whole-lodge booking at " + escapeHtml(CLUB_NAME) + "'s lodge is coming up and some of your party are still listed as placeholders rather than by name.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Still unnamed", value: String(data.unnamedGuestCount) },
    ])}
    ${paragraph(escapeHtml(data.urgencyNote))}
    ${muted("You can update the names yourself from your booking. Changing a name does not change anybody's age group or what the stay costs — to change how many people are coming, or their age groups, contact the club.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}
