import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // The club-time delegate. `loadPersistedClubTimeSettings` returns `null`
    // when it is ABSENT, and the page then falls back to the environment — the
    // very defect CT-4 removes, silently, with nothing able to tell. Every test
    // here leaves it resolving `null`, which reproduces the no-row fallback and
    // keeps their expectations unchanged; the zone-authority test supplies a row.
    clubTimeSettings: { findUnique: vi.fn() },
    member: { count: vi.fn(), findUnique: vi.fn() },
    booking: { count: vi.fn(), findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
    bedAllocation: { findMany: vi.fn() },
    payment: { aggregate: vi.fn() },
    refundRequest: { count: vi.fn() },
    adminCreditAdjustmentRequest: { count: vi.fn() },
    membershipCancellationRequest: { count: vi.fn() },
    memberLifecycleActionRequest: { count: vi.fn() },
    deletionRequest: { count: vi.fn() },
    bookingChangeRequest: { count: vi.fn() },
    lodge: { count: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

// Partial mock: only the query is faked. coverageNeedsLodgeContext and
// coverageLodgeLabel are pure functions over the rows and the lodge count this
// suite supplies, so mocking them would only let the suite disagree with
// production about when a lodge name is shown (#2917).
vi.mock("@/lib/hut-leader-coverage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hut-leader-coverage")>()),
  getUnassignedHutLeaderDates: vi.fn(),
}));

import AdminDashboardPage from "@/app/(admin)/admin/dashboard/page";
import { auth } from "@/lib/auth";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import {
  OPERATIONAL_STAY_BOOKING_STATUSES,
  UPCOMING_CHECK_IN_BOOKING_STATUSES,
} from "@/lib/booking-status";
import { addDaysDateOnly, formatDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { APP_TIME_ZONE } from "@/config/operational";
import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { prisma } from "@/lib/prisma";

function mockDashboardCounts({
  pendingBookingReviews,
  pendingBookingChangeRequests,
  pendingDeletionRequests = 0,
  unpaidFinishedStays = 0,
  unsettledAdditionalFinishedStays = 0,
  unsettledAdditionalUpcomingStays = 0,
}: {
  pendingBookingReviews: number;
  pendingBookingChangeRequests: number;
  pendingDeletionRequests?: number;
  unpaidFinishedStays?: number;
  unsettledAdditionalFinishedStays?: number;
  unsettledAdditionalUpcomingStays?: number;
}) {
  // A Full Admin actor so every permission-gated officer card renders (#2091).
  vi.mocked(auth).mockResolvedValue({ user: { id: "admin-1" } } as any);
  vi.mocked(prisma.member.findUnique).mockResolvedValue({
    id: "admin-1",
    canLogin: true,
    accessRoles: [{ role: "ADMIN" }],
  } as any);
  vi.mocked(prisma.member.count).mockResolvedValue(0);
  // booking.count call order mirrors getStats(): totalBookings,
  // activeBookings, upcomingCheckIns, unpaidFinishedStays,
  // unsettledAdditionalFinishedStays, unsettledAdditionalUpcomingStays (#2350),
  // pendingBookingReviews. The roster and bed
  // officer-card counts no longer use booking.count — they run through
  // window-scoped helpers backed by booking.findMany + choreAssignment.findMany
  // / bedAllocation.findMany (all mocked empty below → count 0).
  vi.mocked(prisma.booking.count)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(unpaidFinishedStays)
    .mockResolvedValueOnce(unsettledAdditionalFinishedStays)
    .mockResolvedValueOnce(unsettledAdditionalUpcomingStays)
    .mockResolvedValueOnce(pendingBookingReviews);
  vi.mocked(prisma.payment.aggregate).mockResolvedValue({
    _sum: { amountCents: 0 },
  } as any);
  vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
  vi.mocked(prisma.choreAssignment.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.bedAllocation.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.refundRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.adminCreditAdjustmentRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.membershipCancellationRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.memberLifecycleActionRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.deletionRequest.count).mockResolvedValue(
    pendingDeletionRequests,
  );
  vi.mocked(prisma.bookingChangeRequest.count).mockResolvedValue(
    pendingBookingChangeRequests,
  );
  vi.mocked(getUnassignedHutLeaderDates).mockResolvedValue([]);
  // Single-lodge club: this suite asserts hrefs, not lodge copy (#2917).
  vi.mocked(prisma.lodge.count).mockResolvedValue(1);
}

describe("admin dashboard deep links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue(null);
  });

  it("links booking request alerts to the changes tab when only change requests are pending", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 2,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain('href="/admin/booking-requests?tab=changes"');
  });

  it("links booking request alerts to the approvals tab when booking reviews are pending", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 1,
      pendingBookingChangeRequests: 2,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain('href="/admin/booking-requests?tab=approvals"');
  });

  it("links pending account deletion request alerts to the deletion request queue", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
      pendingDeletionRequests: 2,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain('href="/admin/deletion-requests?status=PENDING"');
    expect(html).toContain("Account Deletion Requests");
    expect(html).toContain(
      "2 account deletion requests waiting for admin review",
    );
  });

  it("flags unpaid finished stays and links to the pre-filtered bookings list", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
      unpaidFinishedStays: 3,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());
    const todayKey = formatDateOnly(getTodayDateOnly(APP_TIME_ZONE));

    expect(html).toContain("Unpaid Finished Stays");
    expect(html).toContain(
      `href="/admin/bookings?status=PAYMENT_PENDING&amp;checkOutTo=${todayKey}"`,
    );
    expect(html).toContain("3 bookings still payment pending after check-out");

    // The count uses the finished-stay predicate (#1709): PAYMENT_PENDING
    // with check-out on or before NZ today, excluding soft-deleted bookings.
    expect(vi.mocked(prisma.booking.count).mock.calls).toContainEqual([
      {
        where: {
          deletedAt: null,
          status: "PAYMENT_PENDING",
          checkOut: { lte: getTodayDateOnly(APP_TIME_ZONE) },
        },
      },
    ]);
  });

  it("hides the unpaid finished stays card when no finished stay is owing", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).not.toContain("Unpaid Finished Stays");
  });

  it("flags unsettled stay additions and links to the additionalOwed filter (#1723, split by #2350)", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
      unsettledAdditionalFinishedStays: 3,
      unsettledAdditionalUpcomingStays: 2,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain("Bookings With Unpaid Additions");
    // #2350: one link covering BOTH halves — the bookings list has no
    // upcoming-only filter, and the split is stated in the label instead.
    expect(html).toContain(`href="/admin/bookings?additionalOwed=owed"`);
    expect(html).toContain("5 confirmed bookings");
    expect(html).toContain("2 upcoming");
    expect(html).toContain("3 finished");

    // The count uses the sibling finished-stay predicate (#1723 path 2):
    // settled statuses (never PAYMENT_PENDING, so it stays disjoint from the
    // card above) whose latest additional payment never succeeded, with
    // check-out on or before NZ today.
    expect(vi.mocked(prisma.booking.count).mock.calls).toContainEqual([
      {
        where: {
          deletedAt: null,
          checkOut: { lte: getTodayDateOnly(APP_TIME_ZONE) },
          status: { in: ["CONFIRMED", "PAID", "COMPLETED"] },
          payment: {
            is: {
              additionalAmountCents: { gt: 0 },
              OR: [
                { additionalPaymentStatus: null },
                { additionalPaymentStatus: { not: "SUCCEEDED" } },
              ],
            },
          },
        },
      },
    ]);
  });

  it("hides the unpaid-additions card when every finished stay's additions are settled", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).not.toContain("Finished Stays With Unpaid Additions");
  });

  it("scopes the officer-card counts to the next-7-day window using each surface's own filters (#2091)", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
    });

    await AdminDashboardPage();

    const today = getTodayDateOnly(APP_TIME_ZONE);
    const to = addDaysDateOnly(today, 7);

    // Bookings card count matches the list it links to (/admin/bookings?
    // upcoming=7): the upcoming status set (excludes AWAITING_REVIEW), not
    // deleted, check-in within the next 7 days.
    expect(vi.mocked(prisma.booking.count).mock.calls).toContainEqual([
      {
        where: {
          status: { in: [...UPCOMING_CHECK_IN_BOOKING_STATUSES] },
          deletedAt: null,
          checkIn: { gte: today, lte: to },
        },
      },
    ]);

    // Roster count: operational stays overlapping the window, guest-existence
    // required (roster-status.ts semantics), scoped to today..+7. #2631: the
    // overlap is checkout-INCLUSIVE, because a stay whose last night was
    // yesterday still needs this morning's chores done.
    const rosterCall = vi
      .mocked(prisma.booking.findMany)
      .mock.calls.find(
        ([args]) =>
          JSON.stringify((args as { where?: { status?: unknown } })?.where?.status) ===
          JSON.stringify({ in: [...OPERATIONAL_STAY_BOOKING_STATUSES] }),
      );
    expect(rosterCall).toBeDefined();
    expect((rosterCall![0] as { where: unknown }).where).toMatchObject({
      deletedAt: null,
      checkIn: { lt: to },
      checkOut: { gte: today },
      guests: { some: { stayStart: { lt: to }, stayEnd: { gte: today } } },
    });

    // Chore assignments read for the same window.
    expect(vi.mocked(prisma.choreAssignment.findMany).mock.calls).toContainEqual([
      {
        where: { date: { gte: today, lt: to } },
        select: { date: true, status: true, bookingId: true },
      },
    ]);

    // Bed count: allocatable stays overlapping the window, whole-lodge holds
    // excluded, guest-existence required (bed-allocation-board.ts semantics).
    const bedCall = vi
      .mocked(prisma.booking.findMany)
      .mock.calls.find(
        ([args]) =>
          (args as { where?: { wholeLodgeHold?: unknown } })?.where
            ?.wholeLodgeHold === false,
      );
    expect(bedCall).toBeDefined();
    expect((bedCall![0] as { where: unknown }).where).toMatchObject({
      deletedAt: null,
      status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
      wholeLodgeHold: false,
      checkIn: { lt: to },
      checkOut: { gt: today },
      guests: { some: { stayStart: { lt: to }, stayEnd: { gt: today } } },
    });

    // Bed allocations diffed for the same window at guest-night granularity.
    expect(vi.mocked(prisma.bedAllocation.findMany).mock.calls).toContainEqual([
      {
        where: { stayDate: { gte: today, lt: to } },
        select: { bookingGuestId: true, stayDate: true },
      },
    ]);
  });

  /**
   * THE DISCRIMINATING ONE (CT-4, #2870).
   *
   * The window test above renders with NO persisted row, so the page falls back
   * to the environment seed and its `getTodayDateOnly()`-derived expectations
   * agree with it. That is a correct thing to pin — it is the no-row fallback —
   * but it says nothing about AUTHORITY, and until this test existed the
   * dashboard's whole `getStats` derivation (the seven-day window AND the
   * month bounds behind "revenue this month") had never once been exercised
   * against a persisted zone. Every assertion on this page would have passed
   * against the `APP_TIME_ZONE` code CT-4 replaced.
   *
   * The zone is CHOSEN rather than written down, because a contributor or a CI
   * image running with `TZ=America/Denver` would otherwise make the "divergent"
   * literal the environment's own zone and quietly stop discriminating.
   *
   * Both halves are asserted because they fail differently: the seven-day
   * window is date-only arithmetic on the club's day, while the month bounds
   * are real instants bracketing the club's civil month — a zone-blind
   * implementation of the second can still get the first right.
   */
  it("derives the seven-day window and the month bounds from the PERSISTED club zone", async () => {
    const todayIn = (zone: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        // An INDEPENDENT oracle rather than `clubToday`: reading "what this zone
        // would say" through the kernel under test lets one defect satisfy both
        // sides of the comparison.
      }).format(new Date());
    const chosen = chooseDivergentClubZone({
      subject: "the club's today at the frozen instant",
      answerKey: "today",
      cases: [
        {
          // −6 at this date: still 30 June, so the civil month is JUNE while
          // the environment's is July.
          zone: "America/Denver",
          today: "2026-06-30",
          monthStart: "2026-06-01T06:00:00.000Z",
          monthEnd: "2026-07-01T05:59:59.999Z",
        },
        {
          // +14, no DST: already 1 July. Kept as the fallback candidate for a
          // host whose own TZ is Denver.
          zone: "Pacific/Kiritimati",
          today: "2026-07-01",
          monthStart: "2026-06-30T10:00:00.000Z",
          monthEnd: "2026-07-31T09:59:59.999Z",
        },
      ],
      answerFor: todayIn,
      // NOT `["UTC"]` — see the note in the chooser: a "today" assertion has at
      // most three calendar days to play with and adding UTC as a rival can
      // leave a correct tree with no candidate.
    });

    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
    });
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue({
      timeZone: chosen.zone,
    } as never);

    await AdminDashboardPage();

    const clubToday = new Date(`${chosen.today}T00:00:00.000Z`);
    const clubPlus7 = new Date(clubToday.getTime() + 7 * 86_400_000);
    const environmentToday = new Date(`${todayIn(APP_TIME_ZONE)}T00:00:00.000Z`);

    // The seven-day window: the upcoming-check-ins count is the cheapest place
    // to read both bounds off one call.
    expect(vi.mocked(prisma.booking.count).mock.calls).toContainEqual([
      {
        where: {
          status: { in: [...UPCOMING_CHECK_IN_BOOKING_STATUSES] },
          deletedAt: null,
          checkIn: { gte: clubToday, lte: clubPlus7 },
        },
      },
    ]);
    // and it is NOT the environment's day, which is what makes this a proof of
    // authority rather than of shape.
    expect(clubToday.getTime()).not.toBe(environmentToday.getTime());

    /*
      THE HUT-LEADER COVERAGE CARD IS WINDOWED FROM THE SAME DAY, and it is
      asserted here because it is the one officer card on this page that has its
      own fallback. Since #3123 that fallback is `clubTodayDateOnlyInstant()`
      rather than `getTodayDateOnly()`, so omitting the argument would no longer
      answer from `APP_TIME_ZONE` — it would take a SECOND, independent reading
      of the club's day. That is still two "today"s on one dashboard: a request
      crossing club midnight between the two reads leaves the coverage card
      counting a night the roster and bed-allocation cards beside it have already
      dropped. A default that silently works is exactly the kind of omission no
      other assertion on this page can see (CT-4, #2870).
    */
    expect(vi.mocked(getUnassignedHutLeaderDates)).toHaveBeenCalledWith({
      scope: { kind: "all" },
      today: clubToday,
    });

    /*
      THE MONTH BOUNDS ARE NOT THE ENVIRONMENT'S EITHER — the same negative the
      seven-day window carries above, and it has to come BEFORE the assertion
      that uses these literals rather than after it.

      `chooseDivergentClubZone` never checks this pair: `answerKey` is
      `"today"`, so the chooser verifies `today` against an independent oracle
      and takes `monthStart`/`monthEnd` on trust. A later edit that drifted
      those literals into agreeing with the environment is the failure this
      catches — and placed after the `toContainEqual` below it would never run,
      because the first failing assertion ends the test. Here it also gives that
      drift a legible message instead of an opaque deep-equal diff.

      Denver is on 30 June at this instant and the environment on 1 July, so the
      civil MONTHS differ, not merely the days.
    */
    expect(new Date(chosen.monthStart).getTime()).not.toBe(
      Date.UTC(
        environmentToday.getUTCFullYear(),
        environmentToday.getUTCMonth(),
        1,
      ),
    );

    // The month bounds behind "revenue this month". Written out by hand rather
    // than recomputed through the kernel, so a kernel defect cannot agree with
    // itself here.
    expect(vi.mocked(prisma.payment.aggregate).mock.calls).toContainEqual([
      {
        _sum: { amountCents: true },
        where: {
          status: "SUCCEEDED",
          createdAt: {
            gte: new Date(chosen.monthStart),
            lte: new Date(chosen.monthEnd),
          },
        },
      },
    ]);
  });
});
