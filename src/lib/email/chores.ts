import {
  choreRosterTemplate,
  formatChoreRosterDate,
  hutLeaderAssignmentTemplate,
} from "@/lib/email-templates/chores";
import {
  composeChoreLine,
  composeOptionalEmailLine,
} from "../email-message-notes";
import {
  CLUB_HUT_LEADER_LABEL,
  CLUB_NAME,
} from "@/config/club-identity";
import { EMAIL_DEFAULT_LODGE_NAME } from "@/lib/email-message-settings";
import { sendEmail } from "./core";
import type { BookingScopedEmailContext } from "@/lib/booking-email-contract";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";

// #1285: the "Chore Roster" notification preference is honored by the caller
// (`admin-roster-service.ts` via `shouldSendChoreRoster`), before a chore
// token is created — mirroring how check-in reminders are gated in their cron
// caller. This sender stays a pure transport so it never double-gates.
export async function sendChoreRosterEmail(
  // Booking whose stay this roster covers (#2258). A roster is delivered per
  // guest of a booking and ChoreAssignment.bookingId is NOT NULL, so there is
  // no roster without a booking and `"none"` is deliberately not offered: the
  // per-booking "No emails" switch must always be able to withhold it.
  bookingContext: BookingScopedEmailContext,
  email: string,
  guestName: string,
  date: string,
  chores: Array<{ name: string; description: string | null }>,
  choreLink?: string,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  // #2256: was a byte-identical copy of the template's own formatter; both now
  // call the one exported helper so the subject and the body can never drift.
  const formattedDate = formatChoreRosterDate(date);

  await sendEmail({
    to: email,
    subject: `Your chore roster for ${formattedDate} - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => choreRosterTemplate(guestName, date, chores, choreLink)),
    bookingContext,
    templateName: "chore-roster",
    templateData: {
      guestName,
      formattedDate,
      choreName: chores.map((chore) => chore.name).join(", "),
      choreDescription: chores
        .map((chore) => chore.description ?? "")
        .filter(Boolean)
        .join(", "),
      choreLink: choreLink ?? "",
      // #2268: pre-composed optional lines — the flat body has no conditional
      // syntax, so a chore with no description must not leave a dangling
      // "Sweep the deck:" and a roster sent without a link must not leave a
      // dangling "Mark Chores Complete:" plus an instruction for a link that
      // is not there.
      // A roster is only ever sent for chores that exist, so this block always
      // renders; only each chore's description is optional.
      choreListNote:
        chores
          .map((chore) => composeChoreLine(chore.name, chore.description))
          .join("") + "\n",
      choreLinkNote: choreLink
        ? composeOptionalEmailLine("Mark Chores Complete", choreLink) +
          composeOptionalEmailLine(
            null,
            "Use this link to mark your chores as done from your phone. Link expires in 48 hours.",
          )
        : "",
    },
    lodgeId,
  });
}

export async function sendHutLeaderAssignmentEmail(params: {
  email: string;
  firstName: string;
  startDate: Date;
  endDate: Date;
  pin: string;
  assignmentId: string;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your ${CLUB_NAME} ${CLUB_HUT_LEADER_LABEL.toLowerCase()} assignment`,
    html: await renderEmailHtml(() => hutLeaderAssignmentTemplate(params)),
    // Not booking-scoped: a hut-leader assignment is a roster duty spanning a
    // date range, not a message about anyone's booking (#2258).
    bookingContext: "none",
    templateName: "hut-leader-assignment",
    templateData: {
      firstName: params.firstName,
      startDate: emailCalendarDay(params.startDate),
      endDate: emailCalendarDay(params.endDate),
      pin: params.pin,
    },
  });
}
