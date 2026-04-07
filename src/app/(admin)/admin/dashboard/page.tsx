import Link from "next/link";
import { prisma } from "@/lib/prisma";
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
} from "lucide-react";
import { eachDayOfInterval, addDays } from "date-fns";
import { formatCents } from "@/lib/utils";
import { bookingStatusClass } from "@/lib/status-colors";

async function getStats() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const sevenDaysFromNow = new Date(now);
  sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [
    totalMembers,
    activeMembers,
    inactiveMembers,
    totalBookings,
    activeBookings,
    revenueResult,
    upcomingCheckIns,
    recentBookings,
  ] = await Promise.all([
    prisma.member.count(),
    prisma.member.count({ where: { active: true } }),
    prisma.member.count({ where: { active: false } }),
    prisma.booking.count(),
    prisma.booking.count({
      where: { status: { in: ["CONFIRMED", "PAID", "PENDING"] } },
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
        status: { in: ["CONFIRMED", "PAID", "PENDING"] },
        checkIn: { gte: today, lte: sevenDaysFromNow },
      },
    }),
    prisma.booking.findMany({
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
  ]);

  const revenueThisMonth = revenueResult._sum.amountCents ?? 0;

  // Check for unassigned hut leader dates in the next 14 days
  const lookAheadEnd = addDays(today, 14);
  const [hutLeaderAssignments, bookingsFor14Days] = await Promise.all([
    prisma.hutLeaderAssignment.findMany({
      where: { startDate: { lte: lookAheadEnd }, endDate: { gte: today } },
      select: { startDate: true, endDate: true },
    }),
    prisma.booking.findMany({
      where: {
        status: { in: ["CONFIRMED", "PAID"] },
        checkIn: { lte: lookAheadEnd },
        checkOut: { gt: today },
      },
      select: { checkIn: true, checkOut: true },
    }),
  ]);

  const unassignedDatesWithBookings: string[] = [];
  const days14 = eachDayOfInterval({ start: today, end: lookAheadEnd });
  for (const day of days14) {
    const isCovered = hutLeaderAssignments.some(
      (a) => a.startDate.getTime() <= day.getTime() && a.endDate.getTime() >= day.getTime()
    );
    if (isCovered) continue;
    const hasBooking = bookingsFor14Days.some(
      (b) => b.checkIn.getTime() <= day.getTime() && b.checkOut.getTime() > day.getTime()
    );
    if (hasBooking) {
      unassignedDatesWithBookings.push(day.toISOString().split("T")[0]);
    }
  }

  return {
    totalMembers,
    activeMembers,
    inactiveMembers,
    totalBookings,
    activeBookings,
    revenueThisMonth,
    upcomingCheckIns,
    recentBookings,
    unassignedDatesWithBookings,
  };
}


export default async function AdminDashboardPage() {
  const stats = await getStats();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Admin Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">
          Tokoroa Alpine Club — Administration
        </p>
      </div>

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

        <Link href="/admin/bookings?status=CONFIRMED,PAID" className="group">
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
                Confirmed + Pending
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
                        {booking.status}
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
