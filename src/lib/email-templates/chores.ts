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
import { emailCalendarDay } from "@/lib/email-templates-club-time";

/**
 * Chore-roster date: the deliberate long-weekday form ("Thursday, 16 April
 * 2026") the roster emails have always used, NOT the house `emailClubDate`
 * medium form. `date` is a lodge-night date-only string; parsing it with the
 * `T00:00:00` suffix pins it to local midnight, which round-trips back to the
 * same calendar date when formatted without a `timeZone` override. Do not
 * change the format — subject line and body must stay identical, which is why
 * this lives here and is shared with `src/lib/email/chores.ts` (#2256).
 */
export function formatChoreRosterDate(date: string): string {
  return new Date(date + "T00:00:00").toLocaleDateString(
    "en-NZ",
    { weekday: "long", year: "numeric", month: "long", day: "numeric" }
  );
}

export function choreRosterTemplate(
  guestName: string,
  date: string,
  chores: Array<{ name: string; description: string | null }>,
  choreLink?: string
): string {
  const formattedDate = formatChoreRosterDate(date);

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
