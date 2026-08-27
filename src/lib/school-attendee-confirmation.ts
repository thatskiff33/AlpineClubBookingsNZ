import { BookingRequestType, BookingStatus } from "@prisma/client";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import { logAudit } from "@/lib/audit";
import { getBookingRequestSettings } from "@/lib/booking-request";
import {
  resolveGuestNameUpdates,
  type ResolvedGuestNameUpdate,
} from "@/lib/booking-modify";
import { addDaysDateOnly } from "@/lib/date-only";
import { clubCalendarDateOf, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { sendSchoolAttendeeConfirmationEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Booking states whose attendee lists are no longer worth confirming. */
const CLOSED_BOOKING_STATUSES = new Set<BookingStatus>([
  BookingStatus.CANCELLED,
  BookingStatus.BUMPED,
]);

/**
 * School attendee confirmation (#1101). Quoted school bookings are created
 * with placeholder guests ("School Child 1..N"); the chore roster needs real
 * names by arrival. Starting `attendeeConfirmationLeadDays` before check-in,
 * the school contact is emailed a tokenized link (SHA-256 hash stored, raw
 * token emailed, rotated on every send — the quote-token pattern) to a public
 * page where they can rename attendees (identity-only, price-preserving) and
 * explicitly confirm the list. Reminders repeat every
 * `attendeeConfirmationReminderDays` until confirmed or check-in.
 */
export async function sendSchoolAttendeeConfirmationPrompts(
  now: Date = new Date(),
): Promise<{ scanned: number; sent: number; failed: number }> {
  const settings = await getBookingRequestSettings();
  const leadDays = settings.attendeeConfirmationLeadDays;
  const reminderDays = Math.max(settings.attendeeConfirmationReminderDays, 1);
  if (leadDays <= 0) {
    return { scanned: 0, sent: 0, failed: 0 };
  }

  // checkIn is stored as @db.Date (a calendar date at UTC midnight), so
  // comparing it against the raw `now` instant shifts the window boundary by a
  // day for part of every club day. `now` is a real INSTANT and has no calendar
  // day until one is supplied, so it is projected through the club's PERSISTED
  // timezone — not the container's, which is what this used to read (#3123,
  // INV-CONFIG-002) — and the result is encoded back to the UTC-midnight shape
  // `@db.Date` round-trips (F32, #1888). `now` stays the instant used below for
  // the cadence and timestamp writes.
  //
  // The CLI-safe runtime reader rather than `club-time/server`: this module is
  // loaded by `general-cron-runner` from `src/instrumentation.node.ts`, where
  // `server-only` is a bare throw at import.
  const clubZone = await readClubTimeZoneOutsideRequest();
  const today = dateOnlyInstantOf(clubCalendarDateOf(now, clubZone));
  const windowEnd = addDaysDateOnly(today, leadDays);
  const requests = await prisma.bookingRequest.findMany({
    where: {
      type: BookingRequestType.SCHOOL,
      attendeesConfirmedAt: null,
      convertedBookingId: { not: null },
      convertedBooking: {
        deletedAt: null,
        status: { notIn: [...CLOSED_BOOKING_STATUSES] },
        checkIn: { gt: today, lte: windowEnd },
      },
    },
    include: {
      convertedBooking: {
        select: {
          id: true,
          memberId: true,
          checkIn: true,
          checkOut: true,
          guests: { select: { id: true } },
        },
      },
    },
  });

  const result = { scanned: requests.length, sent: 0, failed: 0 };

  for (const request of requests) {
    const booking = request.convertedBooking;
    if (!booking) continue;

    // One prompt per cadence window: the first send happens as soon as the
    // booking enters the lead window, then every reminderDays until the
    // school confirms or check-in arrives. Reruns inside a window are no-ops.
    const lastSentAt = request.attendeeConfirmationLastSentAt;
    if (
      lastSentAt &&
      now.getTime() - lastSentAt.getTime() < reminderDays * DAY_MS
    ) {
      continue;
    }

    // Rotate the token before sending so the email always carries a working
    // link; the link stays valid until check-in. `lastSentAt` moves only
    // after a successful send, so a delivery failure retries next run.
    const { token, tokenHash } = issueActionToken();
    await prisma.bookingRequest.update({
      where: { id: request.id },
      data: {
        attendeeConfirmationTokenHash: tokenHash,
        attendeeConfirmationTokenExpiresAt: booking.checkIn,
        version: { increment: 1 },
      },
    });

    try {
      await sendSchoolAttendeeConfirmationEmail({
        bookingContext: {
          bookingId: booking.id,
          recipientMemberId: booking.memberId,
        },
        email: request.contactEmail,
        firstName: request.contactFirstName,
        schoolName: request.schoolName,
        token,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guestCount: booking.guests.length,
        isReminder: Boolean(lastSentAt),
      });

      await prisma.bookingRequest.update({
        where: { id: request.id },
        data: { attendeeConfirmationLastSentAt: now, version: { increment: 1 } },
      });

      result.sent += 1;
      logAudit({
        action: "booking_request.attendee_confirmation_prompt_sent",
        targetId: request.id,
        entityType: "BookingRequest",
        entityId: request.id,
        category: "booking",
        outcome: "success",
        summary: lastSentAt
          ? "Re-sent the school attendee confirmation link"
          : "Sent the school attendee confirmation link",
        metadata: {
          bookingId: booking.id,
          checkIn: booking.checkIn.toISOString(),
        },
      });
    } catch (err) {
      result.failed += 1;
      logger.error(
        { err, bookingRequestId: request.id, bookingId: booking.id },
        "Failed to send school attendee confirmation prompt",
      );
    }
  }

  return result;
}

type SchoolAttendeeConfirmationStatus =
  | "ready"
  | "confirmed"
  | "invalid"
  | "expired"
  | "closed";

export interface SchoolAttendeeConfirmationDetails {
  status: SchoolAttendeeConfirmationStatus;
  message: string;
  request: {
    id: string;
    schoolName: string | null;
    contactFirstName: string;
    attendeesConfirmedAt: string | null;
  } | null;
  booking: {
    id: string;
    checkIn: string;
    checkOut: string;
    guests: Array<{
      id: string;
      firstName: string;
      lastName: string;
      ageTier: string;
      /** Member guests are identity-linked and not renameable here. */
      isMember: boolean;
    }>;
  } | null;
}

function detailsFor(
  status: SchoolAttendeeConfirmationStatus,
  message: string,
  record?: {
    request: SchoolAttendeeConfirmationDetails["request"];
    booking: SchoolAttendeeConfirmationDetails["booking"];
  },
): SchoolAttendeeConfirmationDetails {
  return {
    status,
    message,
    request: record?.request ?? null,
    booking: record?.booking ?? null,
  };
}

async function findRequestByToken(token: string) {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  return prisma.bookingRequest.findUnique({
    where: { attendeeConfirmationTokenHash: hashActionToken(trimmed) },
    include: {
      convertedBooking: {
        include: {
          guests: { orderBy: { createdAt: "asc" } },
          payment: true,
        },
      },
    },
  });
}

export async function getSchoolAttendeeConfirmation(
  token: string,
  now: Date = new Date(),
): Promise<SchoolAttendeeConfirmationDetails> {
  const request = await findRequestByToken(token);
  if (!request || !request.convertedBooking) {
    return detailsFor(
      "invalid",
      "This attendee confirmation link is invalid or has been replaced by a newer email. Check your latest email from the club, or contact the club office for a fresh link.",
    );
  }

  const booking = request.convertedBooking;
  const record = {
    request: {
      id: request.id,
      schoolName: request.schoolName,
      contactFirstName: request.contactFirstName,
      attendeesConfirmedAt: request.attendeesConfirmedAt?.toISOString() ?? null,
    },
    booking: {
      id: booking.id,
      checkIn: booking.checkIn.toISOString(),
      checkOut: booking.checkOut.toISOString(),
      guests: booking.guests.map((guest) => ({
        id: guest.id,
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier,
        isMember: guest.isMember || Boolean(guest.memberId),
      })),
    },
  };

  if (booking.deletedAt || CLOSED_BOOKING_STATUSES.has(booking.status)) {
    return detailsFor(
      "closed",
      "This booking is no longer active, so the attendee list cannot be updated.",
      record,
    );
  }

  if (request.attendeesConfirmedAt) {
    return detailsFor(
      "confirmed",
      "The attendee list has been confirmed. Contact the club office if anything needs to change.",
      record,
    );
  }

  if (
    request.attendeeConfirmationTokenExpiresAt &&
    request.attendeeConfirmationTokenExpiresAt <= now
  ) {
    return detailsFor(
      "expired",
      "This attendee confirmation link has expired. Contact the club office and an administrator can send you a fresh link.",
      record,
    );
  }

  return detailsFor(
    "ready",
    "Update the attendee names below, then confirm the list.",
    record,
  );
}

export class SchoolAttendeeConfirmationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SchoolAttendeeConfirmationError";
    this.status = status;
  }
}

/**
 * Apply identity-only attendee name updates and/or the explicit confirm
 * action. Names go through the same validation the quoted-booking edit flow
 * uses (#1099): identity-only by construction, so no pricing, promo, or
 * night-row state is touched — chore assignments keep pointing at the same
 * bookingGuestId rows and show the new names.
 */
export async function applySchoolAttendeeConfirmation({
  token,
  guestUpdates,
  confirm,
  now = new Date(),
}: {
  token: string;
  guestUpdates?: Array<{
    guestId: string;
    firstName: string;
    lastName: string;
  }>;
  confirm?: boolean;
  now?: Date;
}): Promise<{ confirmed: boolean; updatedGuestIds: string[] }> {
  const request = await findRequestByToken(token);
  if (!request || !request.convertedBooking) {
    throw new SchoolAttendeeConfirmationError(
      "This attendee confirmation link is invalid.",
      404,
    );
  }
  const booking = request.convertedBooking;

  if (booking.deletedAt || CLOSED_BOOKING_STATUSES.has(booking.status)) {
    throw new SchoolAttendeeConfirmationError(
      "This booking is no longer active.",
      409,
    );
  }
  if (request.attendeesConfirmedAt) {
    throw new SchoolAttendeeConfirmationError(
      "The attendee list has already been confirmed.",
      409,
    );
  }
  if (
    request.attendeeConfirmationTokenExpiresAt &&
    request.attendeeConfirmationTokenExpiresAt <= now
  ) {
    throw new SchoolAttendeeConfirmationError(
      "This attendee confirmation link has expired.",
      410,
    );
  }

  let resolvedUpdates: ResolvedGuestNameUpdate[] = [];
  if (guestUpdates && guestUpdates.length > 0) {
    // Quoted school bookings rename placeholder students even after the
    // school has paid its invoice (#1099).
    resolvedUpdates = resolveGuestNameUpdates({
      booking: {
        guests: booking.guests,
        status: booking.status,
        finalPriceCents: booking.finalPriceCents,
        payment: booking.payment,
      },
      input: { guestUpdates },
      allowWhenFullyPaid: true,
    });
  }

  const confirmed = Boolean(confirm);
  await prisma.$transaction(async (tx) => {
    for (const update of resolvedUpdates) {
      await tx.bookingGuest.update({
        where: { id: update.guestId },
        data: { firstName: update.firstName, lastName: update.lastName },
      });
    }
    if (confirmed) {
      await tx.bookingRequest.update({
        where: { id: request.id },
        data: { attendeesConfirmedAt: now, version: { increment: 1 } },
      });
    }
  });

  logAudit({
    action: confirmed
      ? "booking_request.attendees_confirmed"
      : "booking_request.attendee_names_updated",
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: confirmed
      ? "School contact confirmed the attendee list"
      : "School contact updated attendee names",
    metadata: {
      bookingId: booking.id,
      updatedGuestIds: resolvedUpdates.map((update) => update.guestId),
    },
  });

  return {
    confirmed,
    updatedGuestIds: resolvedUpdates.map((update) => update.guestId),
  };
}

/**
 * Unconfirmed school attendee lists already inside their prompt window — the
 * admin-visible face of this workflow (stuck-state dashboard, #1101).
 */
export async function countUnconfirmedSchoolAttendeeLists(
  now: Date = new Date(),
): Promise<number> {
  const settings = await getBookingRequestSettings();
  const leadDays = settings.attendeeConfirmationLeadDays;
  if (leadDays <= 0) return 0;

  // Same @db.Date boundary as sendSchoolAttendeeConfirmationPrompts (F32, #1888):
  // project the instant through the CLUB's persisted timezone and pin the
  // resulting calendar date to UTC midnight, so the count matches the prompts
  // rather than answering from the container's zone (#3123).
  const today = dateOnlyInstantOf(
    clubCalendarDateOf(now, await readClubTimeZoneOutsideRequest()),
  );
  return prisma.bookingRequest.count({
    where: {
      type: BookingRequestType.SCHOOL,
      attendeesConfirmedAt: null,
      convertedBookingId: { not: null },
      convertedBooking: {
        deletedAt: null,
        status: { notIn: [...CLOSED_BOOKING_STATUSES] },
        checkIn: { gt: today, lte: addDaysDateOnly(today, leadDays) },
      },
    },
  });
}

/**
 * Admin action (#1153): rotate the attendee-confirmation token and send the
 * email immediately, outside the cron cadence — e.g. the school lost the
 * email or the link expired at check-in. Works after check-in with a short
 * expiry so late roster fixes remain possible; blocked once confirmed.
 */
export async function resendSchoolAttendeeConfirmation({
  bookingRequestId,
  adminMemberId,
  now = new Date(),
}: {
  bookingRequestId: string;
  adminMemberId: string;
  now?: Date;
}): Promise<{ sentTo: string }> {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: bookingRequestId },
    include: {
      convertedBooking: {
        select: {
          id: true,
          memberId: true,
          status: true,
          deletedAt: true,
          checkIn: true,
          checkOut: true,
          guests: { select: { id: true } },
        },
      },
    },
  });

  if (
    !request ||
    request.type !== BookingRequestType.SCHOOL ||
    !request.convertedBooking
  ) {
    throw new SchoolAttendeeConfirmationError(
      "This is not a converted school booking request.",
      404,
    );
  }
  const booking = request.convertedBooking;
  if (booking.deletedAt || CLOSED_BOOKING_STATUSES.has(booking.status)) {
    throw new SchoolAttendeeConfirmationError(
      "This booking is no longer active.",
      409,
    );
  }
  if (request.attendeesConfirmedAt) {
    throw new SchoolAttendeeConfirmationError(
      "The attendee list has already been confirmed.",
      409,
    );
  }

  // Rotate before sending, like the cron. Pre-check-in links stay valid
  // until check-in; after check-in a short window covers late roster fixes.
  const { token, tokenHash } = issueActionToken();
  // checkIn is @db.Date; compare it against the CLUB's calendar date (not the
  // raw `now` instant, and not the container's day) so a check-in still in the
  // future is not mis-classified as past for part of every club day (F32,
  // #1888; #3123). The 3-day fallback stays a genuine timestamp window measured
  // from `now`.
  const todayAtClub = dateOnlyInstantOf(
    clubCalendarDateOf(now, await readClubTimeZoneOutsideRequest()),
  );
  const expiresAt =
    booking.checkIn > todayAtClub
      ? booking.checkIn
      : new Date(now.getTime() + 3 * DAY_MS);
  await prisma.bookingRequest.update({
    where: { id: request.id },
    data: {
      attendeeConfirmationTokenHash: tokenHash,
      attendeeConfirmationTokenExpiresAt: expiresAt,
      version: { increment: 1 },
    },
  });

  await sendSchoolAttendeeConfirmationEmail({
    bookingContext: {
      bookingId: booking.id,
      recipientMemberId: booking.memberId,
    },
    email: request.contactEmail,
    firstName: request.contactFirstName,
    schoolName: request.schoolName,
    token,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guestCount: booking.guests.length,
    isReminder: Boolean(request.attendeeConfirmationLastSentAt),
  });

  await prisma.bookingRequest.update({
    where: { id: request.id },
    data: { attendeeConfirmationLastSentAt: now, version: { increment: 1 } },
  });

  logAudit({
    action: "booking_request.attendee_confirmation_resent",
    memberId: adminMemberId,
    actorMemberId: adminMemberId,
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "Admin re-sent the school attendee confirmation link",
    metadata: {
      bookingId: booking.id,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return { sentTo: request.contactEmail };
}
