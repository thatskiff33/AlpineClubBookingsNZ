import { BookingRequestType, BookingStatus, Prisma } from "@prisma/client";
import { logAudit } from "@/lib/audit";
import { getBookingRequestSettings } from "@/lib/booking-request";
import { clubCalendarDateOf, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { addDaysDateOnly, countNightsDateOnly } from "@/lib/date-only";
import { sendWholeLodgeGuestNamesReminderEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import {
  countPlaceholderGuestNames,
  PLACEHOLDER_GUEST_NAME_PREFIXES,
} from "@/lib/placeholder-guest-names";
import { prisma } from "@/lib/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Booking states whose guest names no longer matter. */
const CLOSED_BOOKING_STATUSES = new Set<BookingStatus>([
  BookingStatus.CANCELLED,
  BookingStatus.BUMPED,
]);

/**
 * How close to check-in the reminder switches to its FINAL, daily voice.
 *
 * The escalation the owner asked for on #2550 is a change of urgency and
 * frequency, not of consequence: inside this many days the member is reminded
 * every day instead of every `attendeeConfirmationReminderDays`, and the
 * message says the roster is about to be printed. Nothing is ever withheld.
 */
export const PLACEHOLDER_NAME_FINAL_ESCALATION_DAYS = 2;

/** How the reminder addresses the member, by how close the stay is. */
export type PlaceholderNameReminderStage = "first" | "reminder" | "final";

export interface PlaceholderGuestNameReminderResult {
  scanned: number;
  sent: number;
  /**
   * Nothing to do, or nothing this run may do: the party turned out to be
   * fully named after the detector re-checked it, the previous reminder is
   * still inside the cadence window, or a concurrent run took the claim.
   */
  skipped: number;
  failed: number;
}

/**
 * Guest projection the detector needs — see `placeholder-guest-names.ts`.
 * `isMember`/`memberId` are selected because a member guest is never a
 * placeholder and can never be renamed on the booking.
 */
const PLACEHOLDER_GUEST_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  isMember: true,
  memberId: true,
} as const;

/**
 * Coarse database pre-filter for a party that MIGHT still be unnamed.
 *
 * Prisma cannot express "the last name is an ordinal", so the query narrows on
 * the generated first names and `isPlaceholderGuestName` re-checks every
 * candidate in memory. A booking with no row matching even this loose shape
 * definitely has no placeholders left, which is what keeps the sweep cheap.
 */
function candidatePlaceholderGuestWhere(): Prisma.BookingGuestWhereInput {
  return {
    firstName: { in: [...PLACEHOLDER_GUEST_NAME_PREFIXES] },
    isMember: false,
    memberId: null,
  };
}

/** Whole days from the club's calendar date to the stay's (date-only) check-in. */
function daysUntilCheckIn(today: Date, checkIn: Date): number {
  return countNightsDateOnly(today, checkIn);
}

function stageFor({
  today,
  checkIn,
  hasSentBefore,
}: {
  today: Date;
  checkIn: Date;
  hasSentBefore: boolean;
}): PlaceholderNameReminderStage {
  if (daysUntilCheckIn(today, checkIn) <= PLACEHOLDER_NAME_FINAL_ESCALATION_DAYS) {
    return "final";
  }
  return hasSentBefore ? "reminder" : "first";
}

/**
 * Escalating reminders for member whole-lodge bookings whose party is still
 * "Guest 1..N" (#2550).
 *
 * School bookings already have their own prompt (the tokenized attendee
 * confirmation, `school-attendee-confirmation.ts`) and this sweep deliberately
 * leaves that cadence exactly as it was; the gap #2550 closes is that a member
 * whole-lodge booking got no nudge at all. The member edits their own party
 * through the ordinary booking-guest edit path, so there is no token and no
 * public page here — the email points at their signed-in booking.
 *
 * **Idempotency.** The cadence is stamped on the request's existing
 * `attendeeConfirmationLastSentAt` column (school requests are `type: SCHOOL`
 * and this sweep never looks at them, so the two uses cannot collide, and no
 * schema change is needed). The stamp is CLAIMED with a guarded `updateMany`
 * before the send, so two overlapping cron runs cannot both mail the same
 * member; a lost claim is counted as skipped and runs no side effect. A send
 * that then fails keeps the stamp and is retried at the next cadence window
 * rather than immediately — the same trade `cron-pre-arrival-reminders.ts`
 * makes, and the safe direction for a reminder.
 *
 * **Never blocking.** Nothing in this module is consulted by check-in, booking
 * confirmation, or roster generation. It only sends mail and feeds the admin
 * dashboard count below.
 */
export async function sendPlaceholderGuestNameReminders(
  now: Date = new Date(),
): Promise<PlaceholderGuestNameReminderResult> {
  const settings = await getBookingRequestSettings();
  const leadDays = settings.attendeeConfirmationLeadDays;
  const reminderDays = Math.max(settings.attendeeConfirmationReminderDays, 1);
  if (leadDays <= 0) {
    return { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  }

  // `checkIn` is stored as @db.Date (a calendar date at UTC midnight), so the
  // window is derived from a calendar date rather than the raw instant (F32,
  // #1888). `now` IS an instant, so it is projected through the club's
  // PERSISTED timezone — this used to read the container's (#3123,
  // INV-CONFIG-002) — and encoded back to the UTC-midnight shape `@db.Date`
  // round-trips. The CLI-safe runtime reader, because
  // `src/instrumentation.node.ts` loads this module through
  // `general-cron-runner` and `server-only` throws at import there.
  //
  // Unlike the school sweep this window INCLUDES the arrival day itself: a
  // party that is still unnamed on the morning they travel is exactly who the
  // final reminder is for, and sending it changes nothing about whether they
  // may come.
  const clubZone = await readClubTimeZoneOutsideRequest();
  const today = dateOnlyInstantOf(clubCalendarDateOf(now, clubZone));
  const windowEnd = addDaysDateOnly(today, leadDays);

  const requests = await prisma.bookingRequest.findMany({
    where: {
      // The member whole-lodge front door (#2263): an authenticated member who
      // asked for sole occupancy. `isMemberWholeLodgeRequest` keys on exactly
      // this pair; SCHOOL rows are excluded so the school cadence is untouched.
      type: { not: BookingRequestType.SCHOOL },
      requestedByMemberId: { not: null },
      exclusivityRequested: true,
      convertedBookingId: { not: null },
      convertedBooking: {
        deletedAt: null,
        status: { notIn: [...CLOSED_BOOKING_STATUSES] },
        checkIn: { gte: today, lte: windowEnd },
        guests: { some: candidatePlaceholderGuestWhere() },
      },
    },
    select: {
      id: true,
      attendeeConfirmationLastSentAt: true,
      convertedBooking: {
        select: {
          id: true,
          memberId: true,
          checkIn: true,
          checkOut: true,
          lodgeId: true,
          member: { select: { email: true, firstName: true } },
          // D-12 (#2307): this email PUBLISHES a headcount ("Guests: 6"), so it
          // may only count the people who will actually be at the lodge. A
          // member guest whose consent is still PENDING holds a bed and nothing
          // else, and a DECLINED/EXPIRED row that survived its removal attempt
          // is not an occupant either — counting them would tell the booker
          // something untrue, exactly as `cron-pre-arrival-reminders.ts` says.
          // Placeholders always carry `consentStatus: null`, so the filter keeps
          // every one of them and the unnamed count is unchanged.
          guests: {
            where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE },
            select: PLACEHOLDER_GUEST_SELECT,
          },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }],
  });

  const result: PlaceholderGuestNameReminderResult = {
    scanned: requests.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  for (const request of requests) {
    const booking = request.convertedBooking;
    if (!booking) continue;

    // The loose `guests.some` filter above only proves a candidate exists; the
    // detector is the authority. A party the member has finished naming sends
    // nothing at all.
    const unnamedGuestCount = countPlaceholderGuestNames(booking.guests);
    if (unnamedGuestCount === 0) {
      result.skipped += 1;
      continue;
    }

    const lastSentAt = request.attendeeConfirmationLastSentAt;
    const stage = stageFor({
      today,
      checkIn: booking.checkIn,
      hasSentBefore: Boolean(lastSentAt),
    });
    // Escalation: daily once the stay is imminent, otherwise the club's
    // configured reminder interval.
    const intervalDays = stage === "final" ? 1 : reminderDays;
    if (
      lastSentAt &&
      now.getTime() - lastSentAt.getTime() < intervalDays * DAY_MS
    ) {
      result.skipped += 1;
      continue;
    }

    // Status-guarded claim: only the run that still sees the stamp it read may
    // send. A concurrent run loses the claim and does nothing.
    const claimed = await prisma.bookingRequest.updateMany({
      where: { id: request.id, attendeeConfirmationLastSentAt: lastSentAt },
      data: {
        attendeeConfirmationLastSentAt: now,
        version: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      result.skipped += 1;
      continue;
    }

    try {
      await sendWholeLodgeGuestNamesReminderEmail({
        bookingId: booking.id,
        recipientMemberId: booking.memberId,
        email: booking.member.email,
        firstName: booking.member.firstName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guestCount: booking.guests.length,
        unnamedGuestCount,
        stage,
        lodgeId: booking.lodgeId,
      });

      result.sent += 1;
      logAudit({
        action: "booking_request.placeholder_guest_name_reminder_sent",
        targetId: request.id,
        entityType: "BookingRequest",
        entityId: request.id,
        category: "booking",
        outcome: "success",
        summary:
          stage === "final"
            ? "Sent the final whole-lodge guest-name reminder"
            : stage === "reminder"
              ? "Re-sent the whole-lodge guest-name reminder"
              : "Sent the whole-lodge guest-name reminder",
        metadata: {
          bookingId: booking.id,
          checkIn: booking.checkIn.toISOString(),
          unnamedGuestCount,
          stage,
        },
      });
    } catch (err) {
      result.failed += 1;
      logger.error(
        {
          err,
          bookingRequestId: request.id,
          bookingId: booking.id,
          job: "placeholderGuestNameReminders",
        },
        "Failed to send whole-lodge guest-name reminder",
      );
    }
  }

  return result;
}

/**
 * Bookings approaching check-in whose party still carries generated placeholder
 * names — the admin-dashboard face of #2550.
 *
 * A deliberate sibling of `countUnconfirmedSchoolAttendeeLists` rather than a
 * replacement for it: that count answers "has the school contact signed off the
 * list?", which stays a real and separate operational question (a school can
 * name everybody and still never confirm). This one answers "will the chore
 * roster print 'School Child 1' or 'Guest 2' at the lodge?", and it covers BOTH
 * front doors plus any other booking that somehow carries a placeholder-shaped
 * name — it reads the guest rows themselves rather than a request type.
 *
 * Read-only, and blocks nothing.
 */
export async function countBookingsWithUnnamedPlaceholderGuests(
  now: Date = new Date(),
): Promise<number> {
  const settings = await getBookingRequestSettings();
  const leadDays = settings.attendeeConfirmationLeadDays;
  if (leadDays <= 0) return 0;

  // Same @db.Date boundary as the sweep above (F32, #1888; #3123), and the same
  // inclusive arrival day: a party still unnamed on the day they arrive is the
  // most urgent row on the board, not one that should silently drop off it.
  const today = dateOnlyInstantOf(
    clubCalendarDateOf(now, await readClubTimeZoneOutsideRequest()),
  );
  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: { notIn: [...CLOSED_BOOKING_STATUSES] },
      checkIn: { gte: today, lte: addDaysDateOnly(today, leadDays) },
      guests: { some: candidatePlaceholderGuestWhere() },
    },
    select: {
      id: true,
      guests: {
        where: candidatePlaceholderGuestWhere(),
        select: PLACEHOLDER_GUEST_SELECT,
      },
    },
    // The window is at most `attendeeConfirmationLeadDays` wide and only holds
    // bookings that still carry a candidate placeholder, so this bound is far
    // above any realistic count; it exists so a data anomaly cannot turn an
    // admin dashboard read into an unbounded scan.
    take: 500,
  });

  return bookings.filter(
    (booking) => countPlaceholderGuestNames(booking.guests) > 0,
  ).length;
}
