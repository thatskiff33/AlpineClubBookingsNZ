import Link from "next/link";
import { prisma } from "@/lib/prisma";
import {
  MemberLifecycleAction,
  MemberLifecycleActionRequestStatus,
} from "@prisma/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Users,
  CalendarRange,
  BookOpen,
  BedDouble,
  Tag,
  ClipboardList,
  ArrowRight,
  DollarSign,
  UserCheck,
  AlertTriangle,
  UserX,
  Trash2,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  canViewAdminHrefWithMatrix,
  emptyAdminPermissionMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { formatDollarsDisplay } from "@/lib/finance-format";
import { formatCents } from "@/lib/utils";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { CLUB_HUT_LEADER_LABEL, CLUB_NAME } from "@/config/club-identity";
import {
  ACTIVE_BOOKING_STATUSES,
  UPCOMING_CHECK_IN_BOOKING_STATUSES,
} from "@/lib/booking-status";
import {
  addCalendarDays,
  calendarDateFromParts,
  calendarDateOfDateOnlyInstant,
  calendarDateParts,
  dateOnlyInstantOf,
  daysInCalendarMonth,
  formatClubDayMonth,
} from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { countRosterDaysNeedingChores } from "@/lib/roster-status";
import { countGuestsAwaitingBed } from "@/lib/bed-allocation-board";
import {
  coverageLodgeLabel,
  coverageNeedsLodgeContext,
  getUnassignedHutLeaderDates,
} from "@/lib/hut-leader-coverage";
import { countActiveLodges } from "@/lib/lodges";
import { OPEN_DELETION_REQUEST_STATUSES } from "@/lib/deletion-request-decision";
import {
  buildUnpaidFinishedStaysHref,
  buildUnpaidFinishedStaysWhere,
  buildUnsettledAdditionalFinishedStaysWhere,
  buildUnsettledAdditionalStaysHref,
  buildUnsettledAdditionalUpcomingStaysWhere,
} from "@/lib/unpaid-finished-stays";

// #2264: the upcoming check-ins list renders its date range in a fixed-width
// column, so it stays compact — day plus short month, no year. F3 (#3079)
// declared that bag as the kernel's `dayMonth` shape, which is what the local
// formatter here has become.
//
// CT-4 (#2870): `checkIn` and `checkOut` are CALENDAR DATES — `@db.Date` columns
// Prisma hands back as UTC midnight — and a calendar date has no timezone, so the
// shape takes none. Reading them through APP_TIME_ZONE was a projection that
// named the night before for any club behind UTC (INV-DATE-019).

async function getStats() {
  // CT-4 (#2870): every derivation below now starts from the club's PERSISTED
  // timezone rather than `APP_TIME_ZONE` (INV-CONFIG-002), and the month bounds
  // are calendar arithmetic on a `CalendarDate` rather than string slicing plus
  // `Date.UTC(y, m + 1, 0)`. The values handed to Prisma are unchanged in kind:
  // `today` and `sevenDaysFromNow` are `@db.Date` date-only bounds, and the
  // month pair are real instants bracketing the club's civil month.
  const club = await clubTime();
  const todayKey = club.today();
  const today = dateOnlyInstantOf(todayKey);
  const { year, month } = calendarDateParts(todayKey);
  const startOfMonth = club.startOfDay(calendarDateFromParts(year, month, 1));
  // Inclusive end — the millisecond before the next club day begins — because
  // these bound an `lte` filter. The kernel offers only the half-open
  // `endOfDayExclusive`; an `endOfClubDayInclusive` helper is reported on #2870
  // as wanted in `src/lib`, where three other lanes have written this same
  // `getTime() - 1`.
  const endOfMonth = new Date(
    club
      .endOfDayExclusive(
        calendarDateFromParts(year, month, daysInCalendarMonth(year, month)),
      )
      .getTime() - 1,
  );
  const sevenDaysFromNow = dateOnlyInstantOf(addCalendarDays(todayKey, 7));

  const [
    totalMembers,
    activeMembers,
    inactiveMembers,
    totalBookings,
    activeBookings,
    revenueResult,
    upcomingCheckIns,
    unpaidFinishedStays,
    unsettledAdditionalFinishedStays,
    unsettledAdditionalUpcomingStays,
    recentBookings,
    pendingRefundAppeals,
    pendingCreditApprovals,
    pendingMembershipCancellations,
    pendingMemberArchives,
    pendingDeletionRequests,
    pendingBookingReviews,
    pendingBookingChangeRequests,
    unassignedHutLeaderDates,
    activeLodgeCount,
    rosterDaysNeedingChores,
    bedGuestsAwaiting,
  ] = await Promise.all([
    prisma.member.count(),
    prisma.member.count({ where: { active: true } }),
    prisma.member.count({ where: { active: false } }),
    prisma.booking.count({ where: { deletedAt: null } }),
    prisma.booking.count({
      where: { deletedAt: null, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
    }),
    prisma.payment.aggregate({
      _sum: { amountCents: true },
      where: {
        status: "SUCCEEDED",
        createdAt: { gte: startOfMonth, lte: endOfMonth },
      },
    }),
    // Bookings officer card headline (#2091): check-ins in the next 7 days.
    // Uses UPCOMING_CHECK_IN_BOOKING_STATUSES (not the wider
    // ACTIVE_BOOKING_STATUSES) so the count equals the list the card deep links
    // to — /admin/bookings?upcoming=7 applies the same status set — rather than
    // over-counting AWAITING_REVIEW bookings the list hides.
    prisma.booking.count({
      where: {
        status: { in: [...UPCOMING_CHECK_IN_BOOKING_STATUSES] },
        deletedAt: null,
        checkIn: { gte: today, lte: sevenDaysFromNow },
      },
    }),
    // Unpaid finished stays (#1709): PAYMENT_PENDING with check-out on or
    // before NZ today — the stay is over but payment is still owing. The
    // predicate is shared with the sidebar Needs Attention badge (#1731) via
    // src/lib/unpaid-finished-stays.ts so the two surfaces can never drift.
    prisma.booking.count({
      where: buildUnpaidFinishedStaysWhere(today),
    }),
    // Unsettled finished-stay additions (#1723 path 2): a settled (PAID /
    // COMPLETED) stay that ended with an upward modification delta still
    // uncollected — never PAYMENT_PENDING, so the card above can't see it.
    // Predicate shared with the sidebar badge via unpaid-finished-stays.ts.
    prisma.booking.count({
      where: buildUnsettledAdditionalFinishedStaysWhere(today),
    }),
    // #2350: the same uncollected addition on a stay that has NOT finished.
    // Counting only finished stays meant the club learned about the money after
    // the guests had gone home; this half can still be chased (and the reminder
    // cron is emailing the member about it). Disjoint from the count above.
    prisma.booking.count({
      where: buildUnsettledAdditionalUpcomingStaysWhere(today),
    }),
    prisma.booking.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        status: true,
        finalPriceCents: true,
        createdAt: true,
        member: { select: { firstName: true, lastName: true } },
        _count: { select: { guests: true } },
      },
    }),
    prisma.refundRequest.count({
      where: { status: "PENDING" },
    }),
    prisma.adminCreditAdjustmentRequest.count({
      where: { status: "PENDING" },
    }),
    prisma.membershipCancellationRequest.count({
      where: {
        status: "REQUESTED",
        participants: {
          some: {
            status: "REQUESTED",
            confirmedAt: { not: null },
          },
        },
      },
    }),
    prisma.memberLifecycleActionRequest.count({
      where: {
        action: MemberLifecycleAction.ARCHIVE,
        status: MemberLifecycleActionRequestStatus.REQUESTED,
      },
    }),
    prisma.deletionRequest.count({
      where: { status: { in: OPEN_DELETION_REQUEST_STATUSES } },
    }),
    prisma.booking.count({
      where: { adminReviewStatus: "PENDING", deletedAt: null },
    }),
    prisma.bookingChangeRequest.count({
      where: { status: "REQUESTED" },
    }),
    // `today` IS STILL PASSED, and the reason changed with #3123 —
    // `getUnassignedHutLeaderDates` no longer falls back to `getTodayDateOnly()`
    // and `APP_TIME_ZONE`, so this is no longer the difference between the
    // container's day and the club's. What it is now is the difference between
    // ONE reading of the club's day and TWO. The two officer cards either side
    // of this one (roster, bed allocation) are windowed from `today` above; let
    // the coverage card resolve its own and a request that crosses club midnight
    // between the two reads paints one card a day ahead of its neighbours, which
    // is the same defect CT-4 (#2870) found here wearing a different cause. It
    // also saves the extra settings read the fallback would perform
    // (INV-CONFIG-002).
    getUnassignedHutLeaderDates({ scope: { kind: "all" }, today }),
    // Whether this club is multi-lodge, for the ADR-002 Presentation Rule below.
    // Keyed on the CLUB, not on how many lodges happen to be uncovered (#2917
    // review): a two-lodge club whose gaps all sit at one lodge must still be
    // told which lodge, and the wording must not flip as lodges gain and lose
    // cover. Same house predicate as the bookings calendar and quote copy. Cheap:
    // a single indexed count, batched into this existing round-trip set.
    countActiveLodges(prisma),
    // Roster Assignment officer card (#2091, D-E2): DAYS in the next 7 days
    // that still need a chore roster. Window-scoped to the roster surface's own
    // needs-roster semantics (days with ≥1 guest in the lodge and no chore
    // assignment, per src/lib/roster-status.ts computeRosterDayStatuses), so the
    // headline reconciles with what the officer sees — a per-day count that
    // neither drops a stay rostered on only some of its days nor inflates on
    // guestless bookings. Days, not nights (#2631): a changeover morning whose
    // guests all leave before midday still needs its chores done and is counted
    // here exactly as the roster calendar paints it. Cheap: bounded 7-day
    // window.
    countRosterDaysNeedingChores({ from: today, to: sevenDaysFromNow }),
    // Bed Allocation officer card (#2091, D-E2): guests in the next 7 days with a
    // bed-night still awaiting allocation. Window-scoped mirror of the bed
    // board's own unallocatedGuestNights set (src/lib/bed-allocation-board.ts):
    // per-guest-night diff with the board's guest-existence rule and whole-lodge
    // holds excluded (ADR-001), so a partially-allocated booking still counts its
    // pending guests exactly as the board's buckets do. Cheap: bounded 7-day
    // window matching the board's landing window.
    countGuestsAwaitingBed({ from: today, to: sevenDaysFromNow }),
  ]);

  const revenueThisMonth = revenueResult._sum.amountCents ?? 0;
  const unassignedNamesLodges = coverageNeedsLodgeContext({
    activeLodgeCount,
    rows: unassignedHutLeaderDates,
  });

  return {
    todayKey,
    totalMembers,
    activeMembers,
    inactiveMembers,
    totalBookings,
    activeBookings,
    revenueThisMonth,
    upcomingCheckIns,
    unpaidFinishedStays,
    unsettledAdditionalFinishedStays,
    unsettledAdditionalUpcomingStays,
    recentBookings,
    // One entry per uncovered LODGE-night (#2917): two lodges uncovered on one
    // night is two pieces of work. The label names the lodge whenever the club
    // has more than one active lodge, per the Presentation Rule (ADR-002), so a
    // single-lodge club sees the same bare dates and count as before while a
    // multi-lodge club is never handed a date it cannot place.
    unassignedDatesWithBookings: unassignedHutLeaderDates.map((item) => {
      const lodgeLabel = unassignedNamesLodges
        ? coverageLodgeLabel(item)
        : null;
      return lodgeLabel ? `${item.date} (${lodgeLabel})` : item.date;
    }),
    unassignedNamesLodges,
    pendingRefundAppeals,
    pendingCreditApprovals,
    pendingMembershipCancellations,
    pendingMemberArchives,
    pendingDeletionRequests,
    pendingBookingReviews,
    pendingBookingChangeRequests,
    pendingMembershipReviews:
      pendingMembershipCancellations + pendingMemberArchives,
    rosterDaysNeedingChores,
    bedGuestsAwaiting,
  };
}


// Officer key cards are permission-gated via the shared admin matrix (#2091,
// D-E3): a card is hidden — never disabled — when the actor cannot open its
// target page. The matrix is resolved server-side exactly as the admin layout
// does (definition-backed roles cannot be resolved client-side).
async function getPermissionMatrix() {
  const session = await auth();
  const actor = session?.user
    ? await prisma.member.findUnique({
        where: { id: session.user.id },
        select: {
          id: true,
          canLogin: true,
          accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
        },
      })
    : null;
  return actor ? getAdminPermissionMatrix(actor) : emptyAdminPermissionMatrix();
}

export default async function AdminDashboardPage() {
  // Resolve the stats batch and the actor's permission matrix concurrently —
  // the auth() + member lookup no longer waits on the stats round-trip (#2091).
  const [stats, permissionMatrix] = await Promise.all([
    getStats(),
    getPermissionMatrix(),
  ]);

  const canViewBookings = canViewAdminHrefWithMatrix(
    permissionMatrix,
    "/admin/bookings",
  );
  const canViewHutLeaders = canViewAdminHrefWithMatrix(
    permissionMatrix,
    "/admin/hut-leaders",
  );
  const canViewRoster = canViewAdminHrefWithMatrix(
    permissionMatrix,
    "/admin/roster",
  );
  const canViewBedAllocation = canViewAdminHrefWithMatrix(
    permissionMatrix,
    "/admin/bed-allocation",
  );
  const canViewMembers = canViewAdminHrefWithMatrix(
    permissionMatrix,
    "/admin/members",
  );
  const canViewPayments = canViewAdminHrefWithMatrix(
    permissionMatrix,
    "/admin/payments",
  );
  const showOfficerRow =
    canViewBookings ||
    canViewHutLeaders ||
    canViewRoster ||
    canViewBedAllocation;
  const showSecondaryRow = canViewMembers || canViewPayments;

  // #2350: the two halves of the unsettled-additions queue are disjoint by
  // construction (check-out before/after NZ today), so the total is a plain sum.
  const unsettledAdditionsTotal =
    stats.unsettledAdditionalFinishedStays +
    stats.unsettledAdditionalUpcomingStays;

  const hasPendingAdminReviews =
    stats.pendingRefundAppeals > 0 || stats.pendingCreditApprovals > 0;
  const pendingReviewSummary = [
    stats.pendingRefundAppeals > 0
      ? `${stats.pendingRefundAppeals} refund appeal${stats.pendingRefundAppeals === 1 ? "" : "s"}`
      : null,
    stats.pendingCreditApprovals > 0
      ? `${stats.pendingCreditApprovals} manual credit approval${stats.pendingCreditApprovals === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean) as string[];
  const hasPendingBookingApprovals =
    stats.pendingBookingReviews > 0 || stats.pendingBookingChangeRequests > 0;
  const bookingRequestsHref =
    stats.pendingBookingReviews > 0
      ? "/admin/booking-requests?tab=approvals"
      : "/admin/booking-requests?tab=changes";
  const bookingApprovalSummary = [
    stats.pendingBookingReviews > 0
      ? `${stats.pendingBookingReviews} new booking review${stats.pendingBookingReviews === 1 ? "" : "s"}`
      : null,
    stats.pendingBookingChangeRequests > 0
      ? `${stats.pendingBookingChangeRequests} change request${stats.pendingBookingChangeRequests === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean) as string[];
  const pendingMembershipReviewSummary = [
    stats.pendingMembershipCancellations > 0
      ? `${stats.pendingMembershipCancellations} cancellation request${
          stats.pendingMembershipCancellations === 1 ? "" : "s"
        }`
      : null,
    stats.pendingMemberArchives > 0
      ? `${stats.pendingMemberArchives} archive request${
          stats.pendingMemberArchives === 1 ? "" : "s"
        }`
      : null,
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Admin Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {CLUB_NAME} — Administration
        </p>
      </div>

      {hasPendingAdminReviews && (
        <Link href="/admin/refund-requests">
          <Card className="border-info-6 bg-info-3 hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="flex items-start gap-3 pt-5">
              <AlertTriangle className="h-5 w-5 text-info-11 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-info-11">Pending Review Queue</p>
                <p className="text-sm text-info-11 mt-1">
                  {pendingReviewSummary.join(" and ")} waiting for admin review.
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}

      {hasPendingBookingApprovals && (
        <Link href={bookingRequestsHref}>
          <Card className="border-warning-6 bg-warning-3 hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="flex items-start gap-3 pt-5">
              <AlertTriangle className="h-5 w-5 text-warning-11 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-warning-11">Booking Requests</p>
                <p className="text-sm text-warning-11 mt-1">
                  {bookingApprovalSummary.join(" and ")} waiting for admin decision.
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}

      {/* Unpaid finished stays (#1709): a stay that already ended but is
          still PAYMENT_PENDING — flagged so it cannot silently linger. */}
      {stats.unpaidFinishedStays > 0 && (
        <Link href={buildUnpaidFinishedStaysHref(stats.todayKey)}>
          <Card className="border-warning-6 bg-warning-3 hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="flex items-start gap-3 pt-5">
              <DollarSign className="h-5 w-5 text-warning-11 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-warning-11">
                  Unpaid Finished Stays
                </p>
                <p className="text-sm text-warning-11 mt-1">
                  {stats.unpaidFinishedStays} booking
                  {stats.unpaidFinishedStays === 1 ? "" : "s"} still payment
                  pending after check-out. Follow up on payment or settle the
                  booking.
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}

      {/* Unsettled stay additions (#1723 path 2, widened by #2350): a settled
          booking whose upward modification delta (admin recalculate / guest
          add) was never collected on the card additional-payment flow. The
          booking is not PAYMENT_PENDING, so the card above cannot count it.
          Both halves are shown — upcoming stays can still be chased, finished
          ones need a follow-up — behind one link to the owed filter. */}
      {unsettledAdditionsTotal > 0 && (
        <Link href={buildUnsettledAdditionalStaysHref()}>
          <Card className="border-warning-6 bg-warning-3 hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="flex items-start gap-3 pt-5">
              <DollarSign className="h-5 w-5 text-warning-11 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-warning-11">
                  Bookings With Unpaid Additions
                </p>
                <p className="text-sm text-warning-11 mt-1">
                  {unsettledAdditionsTotal} confirmed booking
                  {unsettledAdditionsTotal === 1 ? "" : "s"} with an additional
                  payment still owing ({stats.unsettledAdditionalUpcomingStays}{" "}
                  upcoming, {stats.unsettledAdditionalFinishedStays} finished).
                  Collect the outstanding amount or adjust the
                  booking.
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}

      {stats.pendingDeletionRequests > 0 && (
        <Link href="/admin/deletion-requests?status=PENDING">
          <Card className="border-danger-6 bg-danger-3 hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="flex items-start gap-3 pt-5">
              <Trash2 className="h-5 w-5 text-danger-11 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-danger-11">
                  Account Deletion Requests
                </p>
                <p className="text-sm text-danger-11 mt-1">
                  {stats.pendingDeletionRequests} account deletion request
                  {stats.pendingDeletionRequests === 1 ? "" : "s"} waiting for
                  admin review.
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}

      {stats.pendingMembershipReviews > 0 && (
        <Link href="/admin/membership-cancellations">
          <Card className="border-warning-6 bg-warning-3 hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="flex items-start gap-3 pt-5">
              <UserX className="h-5 w-5 text-warning-11 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-warning-11">
                  Membership Lifecycle Review
                </p>
                <p className="text-sm text-warning-11 mt-1">
                  {pendingMembershipReviewSummary.join(" and ")} waiting for admin review.
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}

      {/* Hut Leader warning */}
      {stats.unassignedDatesWithBookings.length > 0 && (
        <Link href="/admin/hut-leaders">
          <Card className="border-warning-6 bg-warning-3 hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="flex items-start gap-3 pt-5">
              <AlertTriangle className="h-5 w-5 text-warning-11 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-warning-11">{CLUB_HUT_LEADER_LABEL} Assignment Required</p>
                <p className="text-sm text-warning-11 mt-1">
                  {stats.unassignedDatesWithBookings.length} upcoming{" "}
                  {stats.unassignedNamesLodges ? "lodge-night" : "date"}
                  {stats.unassignedDatesWithBookings.length !== 1 ? "s" : ""} with bookings but no {CLUB_HUT_LEADER_LABEL.toLowerCase()} assigned:{" "}
                  {stats.unassignedDatesWithBookings.slice(0, 5).join(", ")}
                  {stats.unassignedDatesWithBookings.length > 5 ? ` and ${stats.unassignedDatesWithBookings.length - 5} more` : ""}
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}

      {/* Bookings-officer key cards (#2091, D-E1/D-E2): the four surfaces a
          bookings officer works every day, each headlining an actionable
          "work to do" count. Permission-gated (D-E3) so an officer only sees
          the cards whose target page they can open. */}
      {showOfficerRow && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {canViewBookings && (
            <Link href="/admin/bookings?upcoming=7" className="group">
              <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Bookings</CardTitle>
                  <BookOpen className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">
                    {stats.upcomingCheckIns}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    checking in within 7 days · {stats.activeBookings} active of{" "}
                    {stats.totalBookings} all-time
                  </p>
                </CardContent>
              </Card>
            </Link>
          )}

          {canViewHutLeaders && (
            <Link href="/admin/hut-leaders" className="group">
              <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    {CLUB_HUT_LEADER_LABEL} Assignment
                  </CardTitle>
                  <UserCheck className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">
                    {stats.unassignedDatesWithBookings.length}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    upcoming{" "}
                    {stats.unassignedNamesLodges ? "lodge-night" : "night"}
                    {stats.unassignedDatesWithBookings.length === 1
                      ? ""
                      : "s"}{" "}
                    with bookings but no{" "}
                    {CLUB_HUT_LEADER_LABEL.toLowerCase()} assigned
                  </p>
                </CardContent>
              </Card>
            </Link>
          )}

          {canViewRoster && (
            <Link href="/admin/roster" className="group">
              <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    Roster Assignment
                  </CardTitle>
                  <ClipboardList className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">
                    {stats.rosterDaysNeedingChores}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    day
                    {stats.rosterDaysNeedingChores === 1 ? "" : "s"} in the
                    next 7 days with no chores assigned
                  </p>
                </CardContent>
              </Card>
            </Link>
          )}

          {canViewBedAllocation && (
            <Link href="/admin/bed-allocation" className="group">
              <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    Bed Allocation
                  </CardTitle>
                  <BedDouble className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold">
                    {stats.bedGuestsAwaiting}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    guest
                    {stats.bedGuestsAwaiting === 1 ? "" : "s"} in the next 7 days
                    awaiting a bed
                  </p>
                </CardContent>
              </Card>
            </Link>
          )}
        </div>
      )}

      {/* Slim secondary row (#2091, D-E1): committee-level glance metrics kept
          in a visually lighter row beneath the officer cards. */}
      {showSecondaryRow && (
        <div className="grid gap-4 sm:grid-cols-2">
          {canViewMembers && (
            <Link href="/admin/members" className="group">
              <Card className="border-border bg-card hover:shadow-sm transition-shadow cursor-pointer">
                <CardContent className="flex items-center justify-between gap-3 py-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    Members
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-semibold text-foreground">
                      {stats.activeMembers}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      active of {stats.totalMembers} total
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          )}

          {canViewPayments && (
            <Link href="/admin/payments" className="group">
              <Card className="border-border bg-card hover:shadow-sm transition-shadow cursor-pointer">
                <CardContent className="flex items-center justify-between gap-3 py-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                    Revenue This Month
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-semibold text-foreground">
                      {formatDollarsDisplay(stats.revenueThisMonth)}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      from succeeded payments
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          )}
        </div>
      )}

      {/* Recent Bookings */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">
            Recent Bookings
          </h2>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/bookings">View all</Link>
          </Button>
        </div>
        <Card>
          <CardContent className="pt-4">
            {stats.recentBookings.length === 0 ? (
              <div className="py-8 text-center">
                <BookOpen className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
                <p className="text-sm font-medium text-muted-foreground">
                  No bookings yet
                </p>
              </div>
            ) : (
              <div className="divide-y">
                {stats.recentBookings.map((booking) => (
                  <Link
                    key={booking.id}
                    href={buildHrefWithReturnTo(
                      `/bookings/${booking.id}`,
                      "/admin/dashboard",
                    )}
                    className="flex items-center justify-between py-3 hover:bg-accent -mx-2 px-2 rounded"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {booking.member.firstName} {booking.member.lastName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatClubDayMonth(
                          calendarDateOfDateOnlyInstant(booking.checkIn),
                        )}
                        {" — "}
                        {formatClubDayMonth(
                          calendarDateOfDateOnlyInstant(booking.checkOut),
                        )}
                        {" · "}
                        {booking._count.guests} guest{booking._count.guests !== 1 ? "s" : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-sm font-medium">
                        {formatCents(booking.finalPriceCents)}
                      </span>
                      <Badge
                        variant="secondary"
                        className={bookingStatusClass(booking.status)}
                      >
                        {bookingStatusLabel(booking.status)}
                      </Badge>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick links */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-4">
          Quick Actions
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="hover:shadow-md transition-shadow">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-info-3">
                  <Users className="h-5 w-5 text-info-11" />
                </div>
                <div>
                  <CardTitle className="text-base">Members</CardTitle>
                  <CardDescription>View and manage members</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href="/admin/members">
                  Manage Members
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success-3">
                  <CalendarRange className="h-5 w-5 text-success-11" />
                </div>
                <div>
                  <CardTitle className="text-base">Seasons</CardTitle>
                  <CardDescription>Configure seasons and rates</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href="/admin/seasons">
                  Manage Seasons
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cat1-3">
                  <BookOpen className="h-5 w-5 text-cat1-11" />
                </div>
                <div>
                  <CardTitle className="text-base">Bookings</CardTitle>
                  <CardDescription>View all lodge bookings</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href="/admin/bookings">
                  View Bookings
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning-3">
                  <Tag className="h-5 w-5 text-warning-11" />
                </div>
                <div>
                  <CardTitle className="text-base">Promo Codes</CardTitle>
                  <CardDescription>Discounts and vouchers</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href="/admin/promo-codes">
                  Manage Promos
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow">
            <CardHeader>
              <div className="flex items-center gap-3">
                {/* #2188 P2 (M9): the Chore Roster tile is the BRAND-accent one
                    of the five quick-link tiles. It follows the club accent via
                    the role tokens — a neutral-tint container (`bg-accent`) with
                    a brand-accent icon (`text-primary`, which resolves to the
                    app's AA-gated accent ink in `app-theme-scope`) — rather than
                    a hardcoded teal. Its four siblings carry semantic hues on the
                    step scales; this one carries the club brand. */}
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent">
                  <ClipboardList className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-base">Chore Roster</CardTitle>
                  <CardDescription>Assign and manage chores</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href="/admin/roster">
                  View Roster
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
