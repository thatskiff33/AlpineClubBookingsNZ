/**
 * Lodge-duty emails: the daily chore roster and the hut-leader assignment.
 *
 * The family boundary is `src/lib/email/chores.ts`.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  BASE_URL,
  button,
  heading,
  infoTable,
  layout,
  muted,
  paragraph,
} from "./layout";
import { CLUB_HUT_LEADER_LABEL } from "@/config/club-identity";
import { emailPalette } from "@/lib/email-theme";
import { parseCalendarDate } from "@/lib/club-time";
import {
  emailCalendarDay,
  emailLongWeekdayCalendarDay,
} from "@/lib/email-templates-club-time";

/**
 * Chore-roster date: the deliberate long-weekday form ("Thursday, 16 April
 * 2026") the roster emails have always used, NOT the house `emailClubDate`
 * medium form. `date` is a lodge-night date-only string. Subject line and body
 * must stay identical, which is why this lives here and is shared with
 * `src/lib/email/chores.ts` (#2256).
 *
 * THE CLUB'S LOCALE SINCE #3566. This used to call `toLocaleDateString("en-NZ",
 * …)` on a host-local midnight, so every club's roster was written the New
 * Zealand way whatever it had recorded, and this file carried the tree's one
 * file-wide date-lint exemption to allow it. It now renders the kernel's
 * `longWeekdayDate` house shape — the identical options bag — through the email
 * seam, which supplies the club's locale from the same cache as its zone. A
 * calendar day consults no zone at all, so the host-midnight trick is gone too.
 *
 * A value that is not a calendar day renders as itself rather than throwing:
 * the roster still goes out, and the raw text is more honest than the
 * "Invalid Date" the old call produced.
 */
export function formatChoreRosterDate(date: string): string {
  const day = parseCalendarDate(date);
  return day === null ? date : emailLongWeekdayCalendarDay(day);
}

/**
 * `formattedDate` is the roster date ALREADY rendered by
 * {@link formatChoreRosterDate}, and the sender renders it ONCE for the subject
 * and this body (#3566): formatting it twice, either side of the palette await,
 * could read the email seam's locale cache before and after a refresh and put
 * two different dates in one message.
 */
export function choreRosterTemplate(
  guestName: string,
  formattedDate: string,
  chores: Array<{ name: string; description: string | null }>,
  choreLink?: string
): string {
  const choreRows = chores.map((c) => ({
    label: escapeHtml(c.name),
    value: c.description ? escapeHtml(c.description) : "",
  }));

  const linkSection = choreLink
    ? `${button("Mark Chores Complete", choreLink)}${muted("Use this link to mark your chores as done from your phone. Link expires in 48 hours.")}`
    : "";

  return layout(`
    ${heading("Chore Roster")}
    ${paragraph("Hi " + escapeHtml(guestName) + ",")}
    ${paragraph("Here are your assigned chores for <strong>" + escapeHtml(formattedDate) + "</strong> at the lodge:")}
    ${infoTable(choreRows)}
    ${linkSection}
    ${alertBox("Last person to bed: Check heaters and fire are safe and doors are secure.", "warning")}
    ${muted("Thanks for helping keep the lodge running smoothly!")}
  `);
}

export function hutLeaderAssignmentTemplate(params: {
  firstName: string;
  startDate: Date;
  endDate: Date;
  pin: string;
  assignmentId: string;
}): string {
  const p = emailPalette();
  return layout(`
    ${heading(`${CLUB_HUT_LEADER_LABEL} Assignment`)}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ", thanks for taking on " + CLUB_HUT_LEADER_LABEL.toLowerCase() + " duties for the lodge.")}
    ${infoTable([
      { label: "Start date", value: emailCalendarDay(params.startDate) },
      { label: "End date", value: emailCalendarDay(params.endDate) },
      { label: "Kiosk PIN", value: `<strong style="font-size: 18px; letter-spacing: 2px;">${escapeHtml(params.pin)}</strong>` },
    ])}
    ${paragraph(`When you arrive, open the lodge kiosk and use this PIN to unlock ${CLUB_HUT_LEADER_LABEL.toLowerCase()} controls for arrivals, departures, and roster management.`)}
    ${alertBox(`Please keep this PIN private and share it only with the assigned ${CLUB_HUT_LEADER_LABEL.toLowerCase()} team for these dates.`, "warning")}
    ${paragraph("Responsibilities include checking the lodge list, helping guests settle in, marking arrivals and departures, and making sure the daily chore roster is set up and completed.")}
    ${paragraph(`Before your stay, please read the <a href="${escapeHtml(BASE_URL + "/hut-leader-instructions?a=" + encodeURIComponent(params.assignmentId))}" style="color: ${p.charcoal}; font-weight: 600; text-decoration: underline;">lodge instructions</a> covering opening, closing, and day-to-day running of the lodge — open the link and enter your kiosk PIN above to view them (no login needed).`)}
    ${button("Open Lodge View", BASE_URL + "/lodge")}
    ${muted("If you have any issues accessing the kiosk, please contact a club administrator.")}
  `);
}
