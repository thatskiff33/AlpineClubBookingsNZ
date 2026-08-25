/**
 * The one email a family member gets when somebody in their group adds them to
 * a booking.
 *
 * Its own module because `src/lib/email/family-booking.ts` is its own sender
 * module: it is family-group business AND booking business, and the split
 * mirrors the sender families rather than re-litigating that boundary here.
 */
import { escapeHtml } from "./escape";
import {
  BASE_URL,
  button,
  heading,
  infoTable,
  layout,
  paragraph,
} from "./layout";
import { emailCalendarDay } from "@/lib/email-templates-club-time";

/**
 * "A family member added you to a booking" (#2284, S2).
 *
 * The general-family counterpart to `memberGuestAddedTemplate`: a courtesy FYI
 * sent when someone in the reader's OWN family group puts them (or a non-login
 * member they are the adult for) on a booking. It is NOT a member-guest feature
 * email — it carries no consent, no party list, and no held-bed language, only
 * the stay and how to come off it. The dispatcher applies the personal opt-out
 * and the #2258 per-booking switch withholds it like every member email.
 */
export function familyMemberBookingAddedTemplate(data: {
  firstName: string;
  addedHeading: string;
  addedContextNote: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  removalNote: string;
}): string {
  return layout(`
    ${heading(escapeHtml(data.addedHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.addedContextNote)}`)}
    ${infoTable([
      { label: "Lodge", value: escapeHtml(data.lodgeName) },
      {
        label: "Stay",
        value: `${escapeHtml(emailCalendarDay(data.checkIn))} - ${escapeHtml(emailCalendarDay(data.checkOut))}`,
      },
    ])}
    ${paragraph(escapeHtml(data.removalNote))}
    ${button("View this booking", `${BASE_URL}/bookings`)}
  `);
}
