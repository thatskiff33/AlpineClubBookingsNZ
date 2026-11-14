import { BookingStatus, type Prisma } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { isAdditionalPaymentOwed } from "@/lib/additional-payment-chase";
import { ASK_CAUSE_ROWS, additionalAskCause } from "@/lib/additional-ask-cause";
import { LEDGER_ROWS_NEWEST_FIRST } from "@/lib/payment-ledger-order";
import { addCalendarDays, dateOnlyInstantOf, type CalendarDate } from "@/lib/club-time";
import type { sendPreArrivalReminderEmail } from "@/lib/email";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";

/**
 * THE PRE-ARRIVAL REMINDER, AS READ FROM ONE BOOKING.
 *
 * Two senders build this message: the daily cron
 * (`cron-pre-arrival-reminders.ts`) and the officer's "send a fresh copy" action
 * (`booking-fresh-email-copy.ts`). The message carries the lodge's door code and
 * keeps no body (`SENSITIVE_EMAIL_LOG_TEMPLATES`), so the officer's copy is not a
 * replay: it is the same message rendered again from the booking as it is now.
 * Both read the booking through this include and turn it into the sender's
 * arguments here, so the officer can never send a different guest count or a
 * different outstanding-balance note than the cron would.
 */

export const PRE_ARRIVAL_REMINDER_DAYS = 3;

export const PRE_ARRIVAL_REMINDER_STATUSES = [
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
] as const;

/** Whether a booking in this status is one the club reminds before arrival. */
export function isPreArrivalReminderStatus(status: BookingStatus): boolean {
  return (PRE_ARRIVAL_REMINDER_STATUSES as readonly BookingStatus[]).includes(status);
}

/**
 * The check-in days the cron reminds on a given club day: today through
 * `PRE_ARRIVAL_REMINDER_DAYS` days ahead, as date-only instants for the query.
 */
export function preArrivalReminderWindow(today: CalendarDate): {
  windowStart: Date;
  windowEndExclusive: Date;
} {
  return {
    windowStart: dateOnlyInstantOf(today),
    windowEndExclusive: dateOnlyInstantOf(
      addCalendarDays(today, PRE_ARRIVAL_REMINDER_DAYS + 1),
    ),
  };
}

export const PRE_ARRIVAL_REMINDER_BOOKING_INCLUDE = {
  member: true,
  // #3369: the owner may be an Organisation; bookingOwner() reads both.
  organisation: { select: { name: true, email: true } },
  // Owner decision D-12 (#2307): the reminder tells a member how many
  // guests are arriving, so it counts the guests who will actually be
  // there. A member guest whose consent is still PENDING holds a bed under
  // D-4 but is not operationally present, and an inflated "Guests: 4" in an
  // email is the club telling the booker something untrue. Filtering the
  // include is what fixes `guests.length` below — the count has no separate
  // query of its own.
  guests: { where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE } },
  // #2350: an upward booking change may have left money uncollected. The
  // pre-arrival note is the last thing most members read before they
  // travel, so it says so when that is true. This is the booking's own
  // balance, so it is unaffected by the guest filter above — a pending
  // member guest still holds their bed, and the money owed for it is still
  // owed.
  payment: {
    select: {
      additionalAmountCents: true,
      additionalPaymentStatus: true,
      // #4253: the request's cause words the note (a change, or credit used elsewhere).
      transactions: {
        where: { kind: "ADDITIONAL" },
        orderBy: [...LEDGER_ROWS_NEWEST_FIRST] as Prisma.PaymentTransactionOrderByWithRelationInput[],
        take: ASK_CAUSE_ROWS,
        select: { reason: true, carriedAskCents: true, withdrawnAt: true },
      },
    },
  },
} satisfies Prisma.BookingInclude;

export type PreArrivalReminderBooking = Prisma.BookingGetPayload<{
  include: typeof PRE_ARRIVAL_REMINDER_BOOKING_INCLUDE;
}>;

/** The sender's arguments for this booking, addressed to its current owner. */
export function preArrivalReminderEmailParams(
  booking: PreArrivalReminderBooking,
): Parameters<typeof sendPreArrivalReminderEmail>[0] {
  const owner = bookingOwner(booking);
  return {
    bookingId: booking.id,
    recipientMemberId: owner.memberId,
    email: owner.member.email,
    firstName: owner.member.firstName,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guestCount: booking.guests.length,
    expectedArrivalTime: booking.expectedArrivalTime,
    lodgeId: booking.lodgeId,
    outstandingAdditionalAmountCents: isAdditionalPaymentOwed({
      bookingStatus: booking.status,
      payment: booking.payment,
    })
      ? booking.payment?.additionalAmountCents ?? 0
      : 0,
    outstandingAdditionalCause: additionalAskCause(booking.payment?.transactions ?? []),
  };
}
