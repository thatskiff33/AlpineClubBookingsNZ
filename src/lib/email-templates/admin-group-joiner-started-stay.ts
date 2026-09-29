/**
 * #3672 (`INV-PAY-109`): the admin alert for joiners of a paid organiser-pays
 * group whose bill did not cover them and whose stay has started. They were
 * switched to paying for themselves like every such joiner, but not emailed
 * mid-stay, so the treasurer collects by hand and records it on each joiner's
 * booking, where the admin tools' manual payment lives.
 * Sender: `src/lib/email/admin-alerts-group-joiner-started-stay.ts`.
 */
import { escapeHtml } from "./escape";
import { alertBox, BASE_URL, button, heading, infoTable, layout } from "./layout";
import { emailPalette } from "@/lib/email-theme";
import { sanitizeEmailHref } from "@/lib/app-url";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";

/** The instruction paragraph; `email-message-audit-defaults.ts` repeats it as editable copy. */
const GROUP_JOINER_STARTED_STAY_NOTE =
  "The organiser of this group has paid, but these joiners were not on the bill they paid. Each booking is now the joiner's own to pay. Their stay has already started, so they were not emailed about it. Collect payment from them by hand, then open each joiner's booking below and record it with Record manual payment under Admin tools. They can also pay by card from their own booking.";

/** One switched joiner, linked to the booking their payment is recorded on. */
export interface StartedStayJoinerLink {
  name: string;
  bookingUrl: string;
}

function joinerLink(joiner: StartedStayJoinerLink): string {
  const safeUrl = sanitizeEmailHref(joiner.bookingUrl, { baseUrl: BASE_URL, sameOrigin: true });
  return `<a href="${escapeHtml(safeUrl)}" target="_blank" style="color: ${emailPalette().charcoal}; font-weight: 700; text-decoration: underline;">${escapeHtml(joiner.name)}</a>`;
}

export function adminGroupJoinerStartedStayTemplate(data: {
  organiserName: string;
  organiserBookingId: string;
  organiserBookingUrl: string;
  checkIn: Date;
  joiners: StartedStayJoinerLink[];
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
      { label: "Joiners", value: data.joiners.map(joinerLink).join("<br>") },
    ])}
    ${button("Open Organiser's Booking", data.organiserBookingUrl, { sameOrigin: true })}
  `);
}
