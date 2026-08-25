import {
  EMAIL_DEFAULT_LODGE_NAME,
  loadEmailMessageSettingsForLodge,
} from "@/lib/email-message-settings";
import type { BookingEmailRecipient } from "@/lib/booking-email-contract";
import {
  familyMemberBookingAddedTemplate,
} from "@/lib/email-templates/family-booking";
import { sendEmail, type EmailSendOutcome } from "./core";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";

/**
 * The family-scope "you were added to a booking" FYI (#2284, S2).
 *
 * The missing half of #2250 self-removal: a member can only take themselves off
 * a booking they know they are on. When someone in a member's OWN family group
 * puts them on a booking, this tells them — directly if they hold a login, or
 * the group's login-holding adults on their behalf if they do not
 * (`familyAdultDelegateResolver`, the same recipient rule MG2 ships).
 *
 * WHY IT IS SEPARATE FROM `email/member-guest.ts`. Those six emails are a
 * member-guest FEATURE and are gated only by the per-booking "No emails" switch
 * (owner decision D-16 has them ignore notification preferences, because being
 * ASKED for consent is not a mutable preference). This one is GENERAL FAMILY
 * BEHAVIOUR sent regardless of the memberGuests module, and it is an FYI rather
 * than a consent ask — so it DOES carry a personal opt-out
 * (`NotificationPreference.bookingAddedByFamily`), applied by the dispatcher
 * before this sender is ever called. Like every member email it passes a real
 * `{ bookingId }` context, so the #2258 switch withholds it and the withheld
 * send lands on the booking's banner record.
 *
 * A pure transport that returns the mailer's outcome and writes nothing itself.
 */

export type FamilyBookingAddAudience =
  /** The added member reading it themselves (they hold a login). */
  | { kind: "TARGET" }
  /** An adult in the added member's family group, told on their behalf. */
  | { kind: "DELEGATE"; addedMemberName: string };

export interface SendFamilyMemberBookingAddedEmailParams {
  /** Booking this message belongs to (#2258). */
  bookingId: string;
  recipient: BookingEmailRecipient;
  email: string;
  /** First name of whoever is being TOLD — the member, or a family adult. */
  firstName: string;
  /** The member who made the booking and added this member down as a guest. */
  bookerName: string;
  checkIn: Date;
  checkOut: Date;
  /** Booking's lodge, so the copy names the right one (multi-lodge). */
  lodgeId?: string | null;
  audience: FamilyBookingAddAudience;
}

function composeFamilyBookingAdded(params: {
  bookerName: string;
  lodgeName: string;
  audience: FamilyBookingAddAudience;
}): { heading: string; contextNote: string; removalNote: string } {
  const booker = params.bookerName;
  if (params.audience.kind === "TARGET") {
    return {
      heading: "You've been added to a lodge booking",
      contextNote: `${booker} has added you to a booking at ${params.lodgeName}. You did not need to do anything — this is just so you know you are on it.`,
      removalNote:
        "If you would rather not go, you can usually take yourself off the booking from your bookings page (future stays only). If you cannot, contact the club and an administrator can help.",
    };
  }
  const name = params.audience.addedMemberName;
  return {
    heading: `${name} has been added to a lodge booking`,
    contextNote: `${booker} has added ${name} to a booking at ${params.lodgeName}. You are being told because you are an adult in ${name}'s family group and ${name} has no login of their own.`,
    removalNote:
      `If this is not right, ${name} can be taken off the booking from the family's bookings page (future stays only), or contact the club and an administrator can help.`,
  };
}

export async function sendFamilyMemberBookingAddedEmail(
  params: SendFamilyMemberBookingAddedEmailParams,
): Promise<EmailSendOutcome> {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);
  const copy = composeFamilyBookingAdded({
    bookerName: params.bookerName,
    lodgeName: settings.lodgeName,
    audience: params.audience,
  });

  return sendEmail({
    to: params.email,
    subject: `${copy.heading} - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => familyMemberBookingAddedTemplate({
      firstName: params.firstName,
      addedHeading: copy.heading,
      addedContextNote: copy.contextNote,
      lodgeName: settings.lodgeName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      removalNote: copy.removalNote,
    })),
    bookingContext: { bookingId: params.bookingId, recipient: params.recipient },
    templateName: "family-member-added",
    templateData: {
      firstName: params.firstName,
      addedHeading: copy.heading,
      addedContextNote: copy.contextNote,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      removalNote: copy.removalNote,
    },
    lodgeId: params.lodgeId,
  });
}
