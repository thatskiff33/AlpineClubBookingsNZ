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
  Tag,
  ClipboardList,
  ArrowRight,
  DollarSign,
  CalendarCheck,
  AlertTriangle,
  UserX,
} from "lucide-react";
import { formatCents } from "@/lib/utils";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { CLUB_NAME } from "@/config/club-identity";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  addDaysDateOnly,
  endOfDateOnlyForTimeZone,
  formatDateOnly,
  getTodayDateOnly,
  startOfDateOnlyForTimeZone,
} from "@/lib/date-only";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";

async function getStats() {
  const today = getTodayDateOnly();
  const todayKey = formatDateOnly(today);
  const monthPrefix = todayKey.slice(0, 8);
  const startOfMonth = startOfDateOnlyForTimeZone(`${monthPrefix}01`);
  const monthEndDay = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const endOfMonth = endOfDateOnlyForTimeZone(
    `${monthPrefix}${String(monthEndDay).padStart(2, "0")}`
  );
  const sevenDaysFromNow = addDaysDateOnly(today, 7);

  const [
    totalMembers,
    activeMembers,
    inactiveMembers,
    totalBookings,
    activeBookings,
    revenueResult,
    upcomingCheckIns,
    recentBookings,
    pendingRefundAppeals,
    pendingCreditApprovals,
    pendingMembershipCancellations,
    pendingMemberArchives,
    pendingBookingReviews,
    pendingBookingChangeRequests,
    unassignedHutLeaderDates,
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
    prisma.booking.count({
      where: {
        status: { in: [...ACTIVE_BOOKING_STATUSES] },
        deletedAt: null,
        checkIn: { gte: today, lte: sevenDaysFromNow },
      },
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
    prisma.booking.count({
      where: { adminReviewStatus: "PENDING", deletedAt: null },
    }),
    prisma.bookingChangeRequest.count({
      where: { status: "REQUESTED" },
    }),
    getUnassignedHutLeaderDates(),
  ]);

  const revenueThisMonth = revenueResult._sum.amountCents ?? 0;

  return {
    totalMembers,
    activeMembers,
    inactiveMembers,
    totalBookings,
    activeBookings,
    revenueThisMonth,
    upcomingCheckIns,
    recentBookings,
    unassignedDatesWithBookings: unassignedHutLeaderDates.map(
      (item) => item.date,
    ),
    pendingRefundAppeals,
    pendingCreditApprovals,
    pendingMembershipCancellations,
    pendingMemberArchives,
    pendingBookingReviews,
    pendingBookingChangeRequests,
    pendingMembershipReviews:
      pendingMembershipCancellations + pendingMemberArchives,
  };
}


export default async function AdminDashboardPage() {
  const stats = await getStats();
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
        <h1 className="text-2xl font-bold text-slate-900">Admin Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">
          {CLUB_NAME} — Administration
        </p>
      </div>

      {hasPendingAdminReviews && (
        <Link href="/admin/refund-requests">
          <Card className="border-blue-200 bg-blue-50 hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="flex items-start gap-3 pt-5">
              <AlertTriangle className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-blue-900">Pending Review Queue</p>
                <p className="text-sm text-blue-700 mt-1">
                  {pendingReviewSummary.join(" and ")} waiting for admin review.
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}

      {hasPendingBookingApprovals && (
        <Link href="/admin/booking-requests">
          <Card className="border-amber-200 bg-amber-50 hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="flex items-start gap-3 pt-5">
              <AlertTriangle className="h-5 w-5 text-amber-700 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-900">Booking Requests</p>
                <p className="text-sm text-amber-800 mt-1">
                  {bookingApprovalSummary.join(" and ")} waiting for admin decision.
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}

      {stats.pendingMembershipReviews > 0 && (
        <Link href="/admin/membership-cancellations">
          <Card className="border-amber-200 bg-amber-50 hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="flex items-start gap-3 pt-5">
              <UserX className="h-5 w-5 text-amber-700 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-950">
                  Membership Lifecycle Review
                </p>
                <p className="text-sm text-amber-800 mt-1">
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
          <Card className="border-amber-200 bg-amber-50 hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="flex items-start gap-3 pt-5">
              <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-900">Hut Leader Assignment Required</p>
                <p className="text-sm text-amber-700 mt-1">
                  {stats.unassignedDatesWithBookings.length} upcoming date{stats.unassignedDatesWithBookings.length !== 1 ? "s" : ""} with bookings but no hut leader assigned:{" "}
                  {stats.unassignedDatesWithBookings.slice(0, 5).join(", ")}
                  {stats.unassignedDatesWithBookings.length > 5 ? ` and ${stats.unassignedDatesWithBookings.length - 5} more` : ""}
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      )}

      {/* Summary stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href="/admin/members" className="group">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Members</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stats.totalMembers}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {stats.activeMembers} active, {stats.inactiveMembers} inactive
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/admin/bookings" className="group">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Total Bookings
              </CardTitle>
              <BookOpen className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stats.totalBookings}</div>
              <p className="text-xs text-muted-foreground mt-1">
                All-time bookings
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/admin/bookings?status=PAYMENT_PENDING,CONFIRMED,PAID,PENDING" className="group">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Active Bookings
              </CardTitle>
              <CalendarCheck className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stats.activeBookings}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Payment pending + paid + holds
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/admin/payments" className="group">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Revenue This Month
              </CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">
                {formatCents(stats.revenueThisMonth)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                From succeeded payments
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/admin/bookings?upcoming=7" className="group">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Upcoming Check-ins
              </CardTitle>
              <CalendarRange className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stats.upcomingCheckIns}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Next 7 days
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/admin/members?active=true" className="group">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Active Members
              </CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stats.activeMembers}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Currently active accounts
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Recent Bookings */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-900">
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
                <BookOpen className="mx-auto h-10 w-10 text-slate-300 mb-3" />
                <p className="text-sm font-medium text-slate-500">
                  No bookings yet
                </p>
              </div>
            ) : (
              <div className="divide-y">
                {stats.recentBookings.map((booking) => (
                  <Link
                    key={booking.id}
                    href={`/admin/bookings`}
                    className="flex items-center justify-between py-3 hover:bg-slate-50 -mx-2 px-2 rounded"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {booking.member.firstName} {booking.member.lastName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(booking.checkIn).toLocaleDateString("en-NZ", {
                          day: "numeric",
                          month: "short",
                        })}
                        {" — "}
                        {new Date(booking.checkOut).toLocaleDateString("en-NZ", {
                          day: "numeric",
                          month: "short",
                        })}
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
        <h2 className="text-lg font-semibold text-slate-900 mb-4">
          Quick Actions
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="hover:shadow-md transition-shadow">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
                  <Users className="h-5 w-5 text-blue-600" />
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
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-50">
                  <CalendarRange className="h-5 w-5 text-green-600" />
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
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-50">
                  <BookOpen className="h-5 w-5 text-purple-600" />
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
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50">
                  <Tag className="h-5 w-5 text-orange-600" />
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
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50">
                  <ClipboardList className="h-5 w-5 text-teal-600" />
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
