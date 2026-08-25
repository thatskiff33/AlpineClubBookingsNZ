import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { z } from "zod";
import {
  BookingStatus,
  PaymentTransactionKind,
  SubscriptionStatus,
} from "@prisma/client";
import { isAdditionalPaymentOwed } from "@/lib/additional-payment-chase";
import { summarizeAdditionalLedgerGap } from "@/lib/additional-ledger-gap";
import { getOccupiedBedsForNight } from "@/lib/capacity";
import { resolveMetricsCapacityAndScope } from "@/lib/finance-booking-metrics";
import logger from "@/lib/logger";
import {
  buildBookingTrendSeries,
  buildRevenueSeries,
  REPORT_BOOKING_STATUSES,
  summarizeNetCollectedCash,
  summarizeOverlappingGuests,
} from "@/lib/admin-reports";
import { clubSeasonYear } from "@/lib/financial-year";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  buildBookingDeletedWhere,
  parseBookingDeletedVisibility,
} from "@/lib/booking-delete-visibility";
import { dateOnlyInstantOf, endOfClubDayInclusive, parseCalendarDate, startOfClubDay } from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";
import { addDaysDateOnly, eachDateOnlyInRange, formatDateOnly } from "@/lib/date-only";

const reportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deleted: z.enum(["hide", "include", "only"]).default("hide"),
  // Reporting lodge scope: omitted = all active lodges (occupancy denominator
  // is the summed active-lodge capacity); a value scopes to that lodge.
  lodgeId: z.string().min(1).optional(),
});

const MAX_LOGGED_LEDGER_GAP_BOOKINGS = 20;

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  const parsed = reportQuerySchema.safeParse({
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    deleted: parseBookingDeletedVisibility(searchParams.get("deleted")),
    lodgeId: searchParams.get("lodgeId") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // ONE REPORT WINDOW, TWO ENCODINGS, BECAUSE THE COLUMNS ARE TWO KINDS OF THING
  // (INV-DATE-013). The `*Instant` pair is the club's first and last MOMENT of the day,
  // in the PERSISTED timezone rather than the container's (CT-4, #2870; INV-CONFIG-002),
  // keeping the INCLUSIVE last-millisecond `lte` shape — the kernel's day end is
  // half-open, hence the -1. The `*Day` pair is the two CALENDAR DAYS, for `@db.Date`
  // columns, which take no zone: the adapter narrows such a bound to its UTC date, so a
  // club-midnight instant lands a day early (INV-DATE-026). The shape regex admits two
  // bad requests and both are refused here: `2026-13-45`, a day that does not exist,
  // which used to reach Prisma as an Invalid Date and surface as a 500; and `9999-12-31`,
  // which has no day AFTER it, so the half-open end below throws a `RangeError` from
  // OUTSIDE the `try` — and `/admin/audit-log?to=9999-12-31` is a URL that really gets used.
  const from = parseCalendarDate(parsed.data.from);
  const to = parseCalendarDate(parsed.data.to);
  if (!from || !to || parsed.data.to >= "9999-12-31") return NextResponse.json({ error: "Invalid date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD" }, { status: 400 });
  const zone = await clubTimeZone();
  const fromInstant = startOfClubDay(from, zone);
  const toInstant = endOfClubDayInclusive(to, zone);
  const fromDay = dateOnlyInstantOf(from);
  const toDay = dateOnlyInstantOf(to);
  const deletedWhere = buildBookingDeletedWhere(parsed.data.deleted);
  if (toInstant <= fromInstant) return NextResponse.json({ error: "to must be after from" }, { status: 400 });

  // Validate an explicit lodge scope the way the write paths do (400 on
  // unknown/inactive). Omitted stays "all active lodges" — the sanctioned
  // reporting aggregate — so only validate when a lodgeId is supplied.
  if (
    parsed.data.lodgeId &&
    !(await resolveOptionalActiveLodgeId(prisma, parsed.data.lodgeId))
  ) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 }
    );
  }

  try {
    const currentSeasonYear = clubSeasonYear(zone);
    const currentSeasonLabel = `${currentSeasonYear}/${currentSeasonYear + 1}`;

    const { capacity: lodgeCapacity, bookingLodgeWhere } =
      await resolveMetricsCapacityAndScope(parsed.data.lodgeId);

    const [
      bookings,
      totalActiveMembers,
      paidMembers,
      unpaidMembers,
      overdueMembers,
      newMembers,
    ] = await Promise.all([
      prisma.booking.findMany({
        where: {
          ...deletedWhere,
          ...bookingLodgeWhere,
          // Selected report dates are inclusive; booking lodge nights are the
          // half-open [checkIn, checkOut) range.
          checkIn: { lte: toDay },
          checkOut: { gt: fromDay },
          status: { in: [...REPORT_BOOKING_STATUSES] },
        },
        include: {
          guests: { include: { nights: true } },
          payment: {
            select: {
              status: true,
              amountCents: true,
              refundedAmountCents: true,
              additionalAmountCents: true,
              additionalPaymentStatus: true,
              // #2408: the cash figure continues to come from amountCents. We
              // load only ADDITIONAL ledger evidence so Reports can surface the
              // same possible-understatement guard as Finance without
              // rebuilding cash or returning transaction rows.
              transactions: {
                where: { kind: PaymentTransactionKind.ADDITIONAL },
                select: {
                  kind: true,
                  status: true,
                  amountCents: true,
                },
              },
            },
          },
        },
        orderBy: [{ checkIn: "asc" }, { id: "asc" }],
      }),
      prisma.member.count({
        where: {
          active: true,
        },
      }),
      prisma.memberSubscription.count({
        where: {
          seasonYear: currentSeasonYear,
          status: SubscriptionStatus.PAID,
          member: { active: true },
        },
      }),
      prisma.memberSubscription.count({
        where: {
          seasonYear: currentSeasonYear,
          status: SubscriptionStatus.UNPAID,
          member: { active: true },
        },
      }),
      prisma.memberSubscription.count({
        where: {
          seasonYear: currentSeasonYear,
          status: SubscriptionStatus.OVERDUE,
          member: { active: true },
        },
      }),
      prisma.member.count({
        where: {
          active: true,
          OR: [
            // `joinedDate` is `@db.Date` (#2872) so it takes the two DAYS,
            // inclusive at both ends — what the instant pair meant before the
            // column was narrowed. `createdAt` is an instant and keeps them.
            { joinedDate: { gte: fromDay, lte: toDay } },
            {
              joinedDate: null,
              createdAt: { gte: fromInstant, lte: toInstant },
            },
          ],
        },
      }),
    ]);

    // 1. Occupancy by date
    const days = eachDateOnlyInRange(
      fromDay,
      addDaysDateOnly(toDay, 1),
    );

    // Custodian occupancy (#2286) is deliberately EXCLUDED here. Utilisation
    // reporting measures how much the lodge was BOOKED, so a bed held for a
    // season by a custodian — which no member could have booked — must not
    // inflate the occupancy rate. The consequence is stated in
    // docs/CAPACITY_MODEL.md: during custodian season this report reads
    // slightly low against the lodge's true fullness. Every ADMISSION path and
    // the capacity-warnings cron count the custodian; only this report and the
    // other utilisation surfaces do not.
    const occupancyBookings = bookings.filter((booking) =>
      (OPERATIONAL_STAY_BOOKING_STATUSES as readonly string[]).includes(
        booking.status,
      ),
    );
    const occupancyByDate = days.map((day) => {
      const beds = getOccupiedBedsForNight(day, occupancyBookings);
      return {
        date: formatDateOnly(day),
        occupiedBeds: beds,
        availableBeds: lodgeCapacity - beds,
        occupancyRate:
          lodgeCapacity > 0 ? Math.round((beds / lodgeCapacity) * 100) : 0,
      };
    });

    // 2. Revenue by dynamic granularity
    const revenueSeries = buildRevenueSeries(bookings, fromDay, toDay);

    // 3. Booking trends by overlapped stay week. A booking spanning several
    // nights is counted once in each touched week, never once per night.
    const trendData = buildBookingTrendSeries(
      bookings,
      fromDay,
      toDay,
    );

    // 4. Distinct guest rows that stay at least one selected night.
    const { totalGuests, memberGuests, nonMemberGuests } =
      summarizeOverlappingGuests(bookings, fromDay, toDay);

    // 5. Summary stats. Booked revenue is the selected stay-night slice; the
    // allocator divided the WHOLE price first, preserving every integer cent.
    const totalRevenueCents = revenueSeries.data.reduce(
      (sum, bucket) => sum + bucket.revenueCents,
      0,
    );
    // Collected cash is booking-level payment data, deliberately separate from
    // stay-night revenue. Payment.amountCents already includes captured
    // additions (#2408), so transaction-ledger reconstruction is forbidden.
    const netCollectedCents = summarizeNetCollectedCash(
      bookings.map((booking) => booking.payment),
    );
    const additionalLedgerGap = summarizeAdditionalLedgerGap(bookings);
    if (additionalLedgerGap.bookingIds.length > 0) {
      logger.error(
        {
          bookingIds: additionalLedgerGap.bookingIds.slice(
            0,
            MAX_LOGGED_LEDGER_GAP_BOOKINGS,
          ),
          bookingCount: additionalLedgerGap.additionalLedgerGapBookings,
          additionalLedgerGapCents:
            additionalLedgerGap.additionalLedgerGapCents,
          netCollectedCents,
        },
        "Admin Reports: payments record a collected additional payment with no captured ADDITIONAL PaymentTransaction behind it. Net Collected Cash may understate by additionalLedgerGapCents. Reconcile those payments' ledgers (reconcilePaymentAggregates) before trusting the collected figure.",
      );
    }
    // #2350: upward changes whose extra was never collected. This booking-level
    // obligation remains visible as its own figure.
    // Do not subtract this booking-level obligation from the selected
    // stay-night revenue slice and call the result cash: payment state owns
    // netCollectedCents. Scoped by the SHARED owed predicate, which narrows
    // this further than the
    // explicit positive report cohort.
    //
    // The narrowing is NOT a claim that those deltas are uncollectable — a
    // PAYMENT_PENDING booking's delta plainly is, and the member can still pay
    // it. It is the double-count rule: the owed predicate excludes
    // PAYMENT_PENDING precisely so this figure can sit beside the payment-owed
    // queue, which already counts the whole of every PAYMENT_PENDING booking,
    // without counting the same money twice (src/lib/unpaid-finished-stays.ts).
    // Using the predicate also keeps this number equal to the one the dashboard
    // card, the sidebar badge, the bookings list and the chase cron all report.
    const outstandingAdditional = bookings.reduce(
      (acc, b) => {
        if (!isAdditionalPaymentOwed({ bookingStatus: b.status, payment: b.payment }))
          return acc;
        return {
          bookings: acc.bookings + 1,
          cents: acc.cents + (b.payment?.additionalAmountCents ?? 0),
        };
      },
      { bookings: 0, cents: 0 }
    );
    const avgOccupancy =
      occupancyByDate.length > 0
        ? Math.round(
            occupancyByDate.reduce((sum, d) => sum + d.occupancyRate, 0) /
              occupancyByDate.length
          )
        : 0;

    // 6. Status breakdown
    const statusBreakdown = {
      pending: bookings.filter((b) => b.status === BookingStatus.PENDING).length,
      paymentPending: bookings.filter((b) => b.status === BookingStatus.PAYMENT_PENDING).length,
      confirmed: bookings.filter((b) => b.status === BookingStatus.CONFIRMED).length,
      paid: bookings.filter((b) => b.status === BookingStatus.PAID).length,
      awaitingReview: bookings.filter((b) => b.status === BookingStatus.AWAITING_REVIEW).length,
      completed: bookings.filter((b) => b.status === BookingStatus.COMPLETED).length,
    };

    return NextResponse.json({
      summary: {
        totalBookings: bookings.length,
        totalRevenueCents,
        netCollectedCents,
        // Aggregate warning data only. Transaction rows and booking ids remain
        // server-side evidence and are never exposed by the Reports API.
        additionalLedgerGapCents:
          additionalLedgerGap.additionalLedgerGapCents,
        additionalLedgerGapBookings:
          additionalLedgerGap.additionalLedgerGapBookings,
        // #2350: the actionable uncollected addition remains visible beside the
        // separately-derived booked-revenue and collected-cash figures.
        outstandingAdditionalCents: outstandingAdditional.cents,
        outstandingAdditionalBookings: outstandingAdditional.bookings,
        totalGuests,
        avgOccupancyRate: avgOccupancy,
        memberGuests,
        nonMemberGuests,
      },
      statusBreakdown,
      memberStats: {
        totalActiveMembers,
        paidMembers,
        unpaidMembers,
        overdueMembers,
        newMembers,
        currentSeasonYear,
        currentSeasonLabel,
      },
      occupancy: occupancyByDate,
      revenueGranularity: revenueSeries.granularity,
      revenue: revenueSeries.data,
      trends: trendData,
    });
  } catch (err) {
    logger.error({ err }, "Error generating reports");
    return NextResponse.json({ error: "Failed to generate reports" }, { status: 500 });
  }
}
