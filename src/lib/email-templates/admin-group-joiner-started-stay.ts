/**
 * #3672 (`INV-PAY-108`): the admin alert for joiners of a paid organiser-pays
 * group whose bill did not cover them and whose stay has started. They were
 * switched to paying for themselves like every such joiner, but not emailed
 * mid-stay, so the treasurer collects by hand.
 * Sender: `src/lib/email/admin-alerts-group-joiner-started-stay.ts`.
 */
import { escapeHtml } from "./escape";
import { alertBox, button, heading, infoTable, layout } from "./layout";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";

/** The instruction paragraph; `email-message-audit-defaults.ts` repeats it as editable copy. */
const GROUP_JOINER_STARTED_STAY_NOTE =
  "The organiser of this group has paid, but these joiners were not on the bill they paid. Each booking is now the joiner's own to pay. Their stay has already started, so they were not emailed about it. Collect payment from them by hand and mark each booking paid, or they can pay by card from their booking.";

export function adminGroupJoinerStartedStayTemplate(data: {
  organiserName: string;
  organiserBookingId: string;
  checkIn: Date;
  joinerNames: string;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Group Joiners Mid-Stay Now Pay for Themselves")}
    ${alertBox(GROUP_JOINER_STARTED_STAY_NOTE, "warning")}
    ${infoTable([
      {
        label: "Organiser's booking",
        value: escapeHtml(formatBookingReference(data.organiserBookingId)),
      },
      { label: "Organiser", value: escapeHtml(data.organiserName) },
      { label: "Group check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Joiners", value: escapeHtml(data.joinerNames) },
    ])}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}
