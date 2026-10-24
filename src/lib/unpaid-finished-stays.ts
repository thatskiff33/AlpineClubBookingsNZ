import { buildUnpaidConfirmedWholeLodgeWhere } from "@/lib/booking-payment-flow";
import type { Prisma } from "@prisma/client";
import { ADDITIONAL_OWED_BOOKING_STATUSES } from "@/lib/additional-payment-chase";

/**
 * Unpaid finished stays (#1709): bookings still owing their price whose
 * check-out is on or before NZ today — the stay is over but payment is still
 * owing. Retroactive card creates (#1704) match from the moment of creation;
 * organic bookings that cross check-out unpaid surface here too.
 *
 * Single source of truth for the predicate and deep link shared by the admin
 * dashboard attention card and the sidebar Needs Attention badge (#1731);
 * keep every surface on these helpers so the queues can never drift.
 *
 * This module stays free of runtime Prisma/server imports so the client-side
 * admin sidebar can consume the href builder directly.
 */
/** The collection queue uses the modification paths' unpaid classification. */
export function buildUnpaidFinishedStaysStatusWhere(): Prisma.BookingWhereInput {
  return {
    OR: [
      { status: "PAYMENT_PENDING" },
      buildUnpaidConfirmedWholeLodgeWhere(),
    ],
  };
}

export function buildUnpaidFinishedStaysWhere(
  today: Date,
): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    checkOut: { lte: today },
    ...buildUnpaidFinishedStaysStatusWhere(),
  };
}

/**
 * Deep link to the bookings list pre-filtered to the same queue via the
 * Check Out range filter. `todayKey` is the NZ date-only key (YYYY-MM-DD).
 */
export function buildUnpaidFinishedStaysHref(todayKey: string): string {
  return `/admin/bookings?unpaid=finished&checkOutTo=${todayKey}`;
}

/*
 * The settled-lifecycle statuses that can carry an unsettled upward
 * modification delta (CONFIRMED / PAID / COMPLETED) live in
 * src/lib/additional-payment-chase.ts so the SQL predicate below and its
 * in-memory twin `isAdditionalPaymentOwed` are built from ONE list. They are
 * disjoint from PAYMENT_PENDING (which the primary predicate above already
 * counts), so the two queue counts can be summed without double-counting a
 * booking. COMPLETED matters most: the completion cron advances PAID bookings
 * once their check-out day has passed (#2029), so a finished paid stay has
 * usually already left PAID by the time its delta lingers.
 */

/**
 * Booking-level fragment for "an upward modification delta is still owed on
 * the card additional-payment flow" (#1723 path 2): the payment summary columns
 * track the LATEST ADDITIONAL transaction, and any state other than SUCCEEDED —
 * PENDING, FAILED (abandoned/auto-cancelled), or a null status on legacy rows —
 * means the recorded price increase was never collected. Composed with AND by
 * the bookings-list `additionalOwed` filter so it cannot clobber explicit admin
 * filter choices.
 *
 * `isAdditionalPaymentOwed` (src/lib/additional-payment-chase.ts) is the exact
 * in-memory twin, sharing this status list.
 *
 * The member-facing surfaces use a DIFFERENT, wider list — exactly one status
 * wider — and the difference is deliberate:
 *
 *  - the two surfaces that let a member PAY (the booking-page card and
 *    /api/bookings/[id]/additional-payment-secret) gate on
 *    `ADDITIONAL_PAYABLE_BOOKING_STATUSES`, which is this list plus
 *    PAYMENT_PENDING. PAYMENT_PENDING is missing here only so this queue's count
 *    can be summed with the unpaid-finished-stays count above without counting a
 *    booking twice; the money on such a booking is genuinely collectable, so
 *    hiding the member's own pay button for a counting reason would strand it;
 *  - the member dashboard's owed total is scoped by its own query
 *    (ACTIVE_BOOKING_STATUSES + COMPLETED), which is wider again but likewise
 *    excludes CANCELLED and BUMPED.
 *
 * What all of them agree on is the part that decides whether money can move: a
 * CANCELLED or BUMPED booking is in NO list, member-facing or admin. That is
 * what stops a member being shown — or being able to complete — a payment for a
 * booking the club has stopped counting.
 */
export function buildAdditionalOwedWhere(): Prisma.BookingWhereInput {
  return {
    status: { in: [...ADDITIONAL_OWED_BOOKING_STATUSES] },
    payment: {
      is: {
        additionalAmountCents: { gt: 0 },
        OR: [
          { additionalPaymentStatus: null },
          { additionalPaymentStatus: { not: "SUCCEEDED" } },
        ],
      },
    },
  };
}

/**
 * The SAME owed test, expressed against the `Payment` row rather than the
 * booking, for the guarded claims that stamp a reminder before it is sent
 * (src/lib/cron-additional-payment-reminders.ts and
 * src/lib/additional-payment-resend-service.ts).
 *
 * The read that decided to send is advisory; this is the WHERE that actually
 * decides, so it re-states every part of the test — including the booking's
 * lifecycle status, which is what stops a cancellation landing between the read
 * and the claim from turning into a "Payment Still Needed" email. Composed
 * inside an `AND` array by its callers so the nested OR cannot collide with the
 * other guards they add.
 */
export function buildAdditionalOwedPaymentWhere(): Prisma.PaymentWhereInput {
  return {
    additionalAmountCents: { gt: 0 },
    OR: [
      { additionalPaymentStatus: null },
      { additionalPaymentStatus: { not: "SUCCEEDED" } },
    ],
    booking: { is: { status: { in: [...ADDITIONAL_OWED_BOOKING_STATUSES] } } },
  };
}

/**
 * The MONEY half of the owed test, in memory: the `Payment` clause inside
 * `buildAdditionalOwedWhere` above, and nothing else. An upward modification
 * delta was recorded and the money has not arrived — PENDING, FAILED
 * (abandoned / declined) and a null status on a legacy row all mean uncollected;
 * only SUCCEEDED means it was collected.
 *
 * It is deliberately only HALF the owed test. Every queue and every chase must
 * ALSO test the booking's lifecycle status, because a cancelled booking keeps
 * its delta columns unchanged and would otherwise read as still owing. This
 * half is split out for the ONE caller where the status half is constant by
 * construction: the manual cash / off-Xero mark-paid (#2397,
 * `prepareManualSettlement` in src/lib/payment-reconciliation.ts) always lands
 * the booking on PAID, which is in `ADDITIONAL_OWED_BOOKING_STATUSES`, so the
 * settle only has to ask whether the money arrived.
 *
 * MERGE POINT with #2386 (issue #2350), now resolved: the definition moved to
 * `src/lib/additional-payment-chase.ts`, which owns the owed concept and is
 * already this module's dependency, and `isAdditionalPaymentOwed` there is
 * literally `isAdditionalOwedBookingStatus(bookingStatus) &&
 * isAdditionalAmountUncollected(payment)`. There is exactly ONE money-half in
 * the codebase, so this call site cannot drift from the chase it silences.
 * Re-exported here because the three callers that predate #2386 import it from
 * this module, and because this is where its SQL twin lives.
 */
export { isAdditionalAmountUncollected } from "@/lib/additional-payment-chase";

/**
 * Unsettled finished-stay additions (#1723 path 2): a settled (usually PAID or
 * COMPLETED) booking whose stay has ended but whose upward modification delta
 * was never collected. The booking is not PAYMENT_PENDING, so the primary
 * unpaid-finished-stays predicate never counts it — without this second
 * predicate it is the one silently lingering card obligation.
 *
 * Shared by the admin dashboard attention card, the sidebar Needs Attention
 * badge, and the bookings-list deep link, same drift rule as above.
 */
export function buildUnsettledAdditionalFinishedStaysWhere(
  today: Date,
): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    checkOut: { lte: today },
    ...buildAdditionalOwedWhere(),
  };
}

/**
 * Deep link to the bookings list pre-filtered to the same queue via the
 * `additionalOwed` filter plus the Check Out range filter.
 */
export function buildUnsettledAdditionalFinishedStaysHref(
  todayKey: string,
): string {
  return `/admin/bookings?additionalOwed=owed&checkOutTo=${todayKey}`;
}

/**
 * Unsettled additions on a stay that has NOT finished yet (#2350): the same
 * uncollected upward modification delta, but on a booking whose check-out is
 * still ahead. Counting only finished stays meant the club found out about the
 * money after the guests had gone home; this is the half that can still be
 * chased while the member is paying attention (the reminder cron emails them,
 * src/lib/cron-additional-payment-reminders.ts).
 *
 * Deliberately DISJOINT from the finished predicate above (`checkOut > today`
 * against its `checkOut <= today`), so the two counts can be shown side by side,
 * or summed for one badge, without double-counting a booking.
 */
export function buildUnsettledAdditionalUpcomingStaysWhere(
  today: Date,
): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    checkOut: { gt: today },
    ...buildAdditionalOwedWhere(),
  };
}

/**
 * Deep link covering BOTH halves of the unsettled-additions queue — every
 * booking with an uncollected addition, whenever it stays. Used by the sidebar
 * badge and the dashboard card, whose split label ("N upcoming, M finished")
 * names the two halves while the one link shows all of them; the bookings list
 * has no "upcoming only" filter to deep-link to, and inventing one to express a
 * split the list already sorts by check-out would be the worse trade.
 */
export function buildUnsettledAdditionalStaysHref(): string {
  return "/admin/bookings?additionalOwed=owed";
}
