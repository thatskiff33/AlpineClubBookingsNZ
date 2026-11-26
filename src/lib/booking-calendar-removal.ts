/**
 * #5249: removing a cancelled or bumped stay from a member's calendar.
 *
 * The booking-confirmed email offers an add-to-calendar entry (fork #35). Once
 * the booking is cancelled or bumped the download route stops serving it, but
 * an entry the member already saved stays. The cancelled and bumped emails
 * therefore carry a calendar cancellation of that same event (same UID, higher
 * SEQUENCE) and one sentence telling the member to remove the stay if it is
 * still showing.
 *
 * Both are sent only where the member was OFFERED an entry: the booking's
 * confirmation went out (a SENT `booking-confirmed` row for this recipient),
 * and the same privacy decision that put the calendar links into that
 * confirmation (`resolveBookingEmailLink`) still lets the booking id into
 * outbound mail for this recipient. A non-login contact or an unauthorised
 * address was never offered an entry and gets neither.
 *
 * Everything here only READS, after the cancel or bump has committed, and never
 * aborts the send: a failed read means no attachment and no sentence, and a
 * failed file build means the sentence without the attachment.
 */
import { BOOKING_CONFIRMED_TEMPLATE_NAME } from "@/lib/email/booking-confirmed-template";
import type { EmailAttachment } from "@/lib/email/internal";
import { resolveBookingEmailLink } from "@/lib/booking-email-authority";
import {
  bookingCalendarSequence,
  buildBookingIcs,
  SERVABLE_BOOKING_STATUS,
} from "@/lib/calendar-links";
import { formatDateOnly } from "@/lib/date-only";
import { calendarRemovalNote, calendarUpdateNote } from "@/lib/email-message-notes";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

interface BookingCalendarRemoval {
  /** `{{calendarRemovalNote}}` and the HTML paragraph; empty when not offered. */
  note: string;
  /** The cancellation file, or none when not offered or it could not be built. */
  attachments: EmailAttachment[];
}

const NOT_OFFERED: BookingCalendarRemoval = { note: "", attachments: [] };

/** Offered, with or without the file: the note names an attachment only if there is one. */
function offeredRemoval(attachment: EmailAttachment | null): BookingCalendarRemoval {
  return {
    note: calendarRemovalNote(attachment !== null),
    attachments: attachment ? [attachment] : [],
  };
}

/** The templates that carry the cancellation file, here and on a retry. */
const CALENDAR_REMOVAL_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  "booking-cancelled",
  "booking-bumped",
]);

interface CalendarOfferParams {
  bookingId: string;
  /** The booking owner the email goes to; null for an organisation owner. */
  recipientMemberId: string | null;
  deliveryAddress: string;
  /** The email being sent; must be a booking-scoped template. */
  templateName: string;
}

/**
 * Whether this recipient was offered an add-to-calendar entry for the booking.
 * Fails closed: any read error answers false, logged.
 */
async function wasBookingCalendarEntryOffered(
  params: CalendarOfferParams,
): Promise<boolean> {
  if (!params.recipientMemberId) return false;
  try {
    const confirmation = await prisma.emailLog.findFirst({
      where: {
        bookingId: params.bookingId,
        templateName: BOOKING_CONFIRMED_TEMPLATE_NAME,
        bookingRecipientMemberId: params.recipientMemberId,
        status: "SENT",
      },
      select: { id: true },
    });
    if (!confirmation) return false;
    // Fails closed on its own errors (no link), so it needs no catch here.
    const link = await resolveBookingEmailLink({
      bookingId: params.bookingId,
      templateName: params.templateName,
      recipient: { kind: "member", memberId: params.recipientMemberId },
      deliveryAddress: params.deliveryAddress,
    });
    return link.bookingUrl !== null;
  } catch (err) {
    logger.error(
      { err, bookingId: params.bookingId, templateName: params.templateName },
      "Failed to read whether a calendar entry was offered; sending without the calendar note (#5249)",
    );
    return false;
  }
}

/**
 * The calendar note and cancellation file for a cancelled or bumped booking's
 * email. The file is built only while the booking is in a state the download
 * route refuses to serve, so it can never remove the entry of a stay that
 * stands.
 */
export async function resolveBookingCalendarRemoval(
  params: CalendarOfferParams,
): Promise<BookingCalendarRemoval> {
  if (!(await wasBookingCalendarEntryOffered(params))) return NOT_OFFERED;
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        checkIn: true,
        checkOut: true,
        status: true,
        updatedAt: true,
        lodge: { select: { name: true } },
      },
    });
    if (!booking || SERVABLE_BOOKING_STATUS[booking.status]) {
      return offeredRemoval(null);
    }
    const sentAt = new Date();
    // Above every SEQUENCE the download route served (an EARLIER revision's
    // `updatedAt`), so a calendar applies this as the newer revision.
    const sequence = Math.max(
      bookingCalendarSequence(sentAt),
      bookingCalendarSequence(booking.updatedAt) + 1,
    );
    const ics = buildBookingIcs({
      stay: {
        bookingId: params.bookingId,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
      lodgeName: booking.lodge.name,
      sequence,
      generatedAt: sentAt,
      cancelled: true,
    });
    // checkIn is date-only, so formatDateOnly is its encoder (INV-DATE-019).
    const fileDate = formatDateOnly(booking.checkIn).replaceAll("-", "");
    return offeredRemoval({
      filename: `lodge-stay-cancelled-${fileDate}.ics`,
      content: Buffer.from(ics, "utf8"),
      contentType: "text/calendar; charset=utf-8; method=CANCEL",
    });
  } catch (err) {
    logger.error(
      { err, bookingId: params.bookingId, templateName: params.templateName },
      "Failed to build a calendar cancellation; sending the calendar note without it (#5249)",
    );
    return offeredRemoval(null);
  }
}

/**
 * `{{calendarUpdateNote}}` for a booking-modified email: the sentence only when
 * the stay's dates moved and the member was offered an entry, else empty. No
 * file: an app that ignores the event id would add a second entry beside the
 * stale one.
 */
export async function resolveCalendarUpdateNote(
  params: CalendarOfferParams & {
    oldCheckIn: Date;
    oldCheckOut: Date;
    newCheckIn: Date;
    newCheckOut: Date;
  },
): Promise<string> {
  const datesMoved =
    formatDateOnly(params.oldCheckIn) !== formatDateOnly(params.newCheckIn) ||
    formatDateOnly(params.oldCheckOut) !== formatDateOnly(params.newCheckOut);
  return datesMoved && (await wasBookingCalendarEntryOffered(params))
    ? calendarUpdateNote()
    : "";
}

/**
 * The attachments a retried cancelled or bumped email carries: the retry cron
 * replays the stored HTML, so the file is rebuilt here under the same rules.
 * Empty for every other template and for a row without a booking.
 */
export async function retryCalendarRemovalAttachments(emailLog: {
  templateName: string;
  bookingId: string | null;
  bookingRecipientMemberId: string | null;
  to: string;
}): Promise<EmailAttachment[]> {
  if (
    !emailLog.bookingId ||
    !CALENDAR_REMOVAL_TEMPLATE_NAMES.has(emailLog.templateName)
  ) {
    return [];
  }
  const { attachments } = await resolveBookingCalendarRemoval({
    bookingId: emailLog.bookingId,
    recipientMemberId: emailLog.bookingRecipientMemberId,
    deliveryAddress: emailLog.to,
    templateName: emailLog.templateName,
  });
  return attachments;
}
