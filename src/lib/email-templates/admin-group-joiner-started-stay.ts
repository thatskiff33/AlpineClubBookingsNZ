/**
 * #3672 (`INV-PAY-108`): the admin alert for joiners of a paid organiser-pays
 * group whose bill did not cover them, left organiser-settled because the
 * group's stay has started (the same started-stay rule as `INV-PAY-016`).
 * Sender: `src/lib/email/admin-alerts-group-joiner-started-stay.ts`.
 */
import { escapeHtml } from "./escape";
import { alertBox, button, heading, infoTable, layout } from "./layout";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";

/** The instruction paragraph; `email-message-audit-defaults.ts` repeats it as editable copy. */
const GROUP_JOINER_STARTED_STAY_NOTE =
  "The organiser of this group has paid, but these joiners were not on the bill they paid. Their stay has already started, so they were NOT switched to paying for themselves automatically. Arrange their payment by hand, or cancel their bookings.";

export function adminGroupJoinerStartedStayTemplate(data: {
  organiserName: string;
  organiserBookingId: string;
  checkIn: Date;
  joinerNames: string;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Unpaid Group Joiners on a Stay That Has Started")}
    ${alertBox(GROUP_JOINER_STARTED_STAY_NOTE, "warning")}
    ${infoTable([
      {
        label: "Organiser's booking",
        value: escapeHtml(formatBookingReference(data.organiserBookingId)),
      },
      { label: "Organiser", value: escapeHtml(data.organiserName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Joiners", value: escapeHtml(data.joinerNames) },
    ])}
    ${button("View Bookings", data.reviewUrl, { sameOrigin: true })}
  `);
}
