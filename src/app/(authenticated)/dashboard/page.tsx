import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
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
  CalendarDays,
  BedDouble,
  PlusCircle,
  Mountain,
  Home,
  Shield,
  Wallet,
  CreditCard,
  TicketPercent,
} from "lucide-react";
import { formatCents } from "@/lib/utils";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { isHutLeader } from "@/lib/hut-leader";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { summarizeMemberPaymentOwed } from "@/lib/member-dashboard";
import { getAvailablePromoCodesForMember } from "@/lib/promo";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import {
  ACTIVE_BOOKING_STATUSES,
  PAYMENT_OWED_BOOKING_STATUSES,
} from "@/lib/booking-status";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const firstName = session.user.name?.split(" ")[0] ?? "Member";
  const memberId = session.user.id;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Check if member is a staying guest (PAID booking where checkIn-1 <= today <= checkOut)
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const stayingGuestBooking = await prisma.booking.findFirst({
    where: {
      memberId,
      status: "PAID",
      checkIn: { lte: tomorrow },
      checkOut: { gte: today },
    },
    select: { id: true },
  });
  const isStayingGuest = !!stayingGuestBooking;

  // Check if member has an active hut leader assignment (day-before access)
  const isHutLeaderActive = session.user.role === "MEMBER"
    ? await isHutLeader(memberId, tomorrow).then(async (dayBefore) => {
        if (dayBefore) return true;
        return isHutLeader(memberId, today);
      })
    : false;

  const [
    upcomingBookings,
    recentBookings,
    draftBookings,
    paymentOwedBookings,
    creditBalanceCents,
    availablePromoCodes,
  ] = await Promise.all([
    prisma.booking.findMany({
      where: {
        memberId,
        status: { in: [...ACTIVE_BOOKING_STATUSES] },
        checkIn: { gte: today },
      },
      orderBy: { checkIn: "asc" },
      take: 20,
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        status: true,
        finalPriceCents: true,
        _count: { select: { guests: true } },
      },
    }),
    prisma.booking.findMany({
      where: { memberId, status: { not: "DRAFT" } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        status: true,
        finalPriceCents: true,
        createdAt: true,
        _count: { select: { guests: true } },
      },
    }),
    prisma.booking.findMany({
      where: {
        memberId,
        status: "DRAFT",
        draftExpiresAt: { gt: today },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        finalPriceCents: true,
        draftExpiresAt: true,
        _count: { select: { guests: true } },
      },
    }),
    prisma.booking.findMany({
      where: {
        memberId,
        status: { in: [...ACTIVE_BOOKING_STATUSES, "COMPLETED"] },
        OR: [
          { status: { in: [...PAYMENT_OWED_BOOKING_STATUSES] } },
          { payment: { is: { additionalAmountCents: { gt: 0 } } } },
        ],
      },
      select: {
        status: true,
        finalPriceCents: true,
        payment: {
          select: {
            status: true,
            additionalAmountCents: true,
            additionalPaymentStatus: true,
          },
        },
      },
    }),
    getMemberCreditBalance(memberId),
    getAvailablePromoCodesForMember(memberId),
  ]);

  const nextStay = upcomingBookings[0] ?? null;
  const paymentOwed = summarizeMemberPaymentOwed(paymentOwedBookings);

  return (
    <div className="space-y-8">
      {/* Welcome header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Welcome back, {firstName}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Tokoroa Alpine Club — Member Portal
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/profile">
              View User Profile
            </Link>
          </Button>
          <Button asChild>
            <Link href="/book">
              <PlusCircle className="mr-2 h-4 w-4" />
              New Booking
            </Link>
          </Button>
        </div>
      </div>

      {/* Lodge access cards */}
      {(isStayingGuest || isHutLeaderActive) && (
        <div className="flex flex-wrap gap-3">
          {isStayingGuest && (
            <Button asChild variant="outline" className="gap-2">
              <Link href="/lodge/kiosk">
                <Home className="h-4 w-4" />
                View Lodge
              </Link>
            </Button>
          )}
          {isHutLeaderActive && (
            <Button asChild variant="outline" className="gap-2">
              <Link href="/lodge/kiosk">
                <Shield className="h-4 w-4" />
                Hut Leader
              </Link>
            </Button>
          )}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Upcoming Bookings
            </CardTitle>
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{upcomingBookings.length}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {upcomingBookings.length === 0
                ? "No bookings scheduled"
                : `${upcomingBookings.length} booking${upcomingBookings.length !== 1 ? "s" : ""} coming up`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Next Stay</CardTitle>
            <BedDouble className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {nextStay ? (
              <>
                <div className="text-lg font-semibold">
                  {new Date(nextStay.checkIn).toLocaleDateString("en-NZ", {
                    day: "numeric",
                    month: "short",
                  })}
                  {" — "}
                  {new Date(nextStay.checkOut).toLocaleDateString("en-NZ", {
                    day: "numeric",
                    month: "short",
                  })}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {nextStay._count.guests} guest{nextStay._count.guests !== 1 ? "s" : ""} · {formatCents(nextStay.finalPriceCents)}
                </p>
              </>
            ) : (
              <>
                <div className="text-lg font-semibold text-slate-500">
                  No upcoming stays
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Book a stay at the lodge
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Credit Owed</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatCents(creditBalanceCents)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {creditBalanceCents > 0
                ? "Available account credit for future bookings"
                : "No account credit available"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Payment Owed</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatCents(paymentOwed.totalCents)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {paymentOwed.totalCents > 0
                ? `${paymentOwed.bookingCount} booking${paymentOwed.bookingCount !== 1 ? "s" : ""} need payment`
                : "No payment due"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Promo Codes Available</CardTitle>
            <TicketPercent className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{availablePromoCodes.length}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {availablePromoCodes.length > 0
                ? "Assigned to your member account"
                : "No assigned promo codes available"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Quick Book</CardTitle>
            <Mountain className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <CardDescription className="mb-4">
              Check availability and book your next alpine getaway.
            </CardDescription>
            <Button asChild size="sm" className="w-full">
              <Link href="/book">Book Now</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Draft bookings */}
      {draftBookings.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-slate-900">
              Draft Bookings
            </h2>
          </div>
          <Card>
            <CardContent className="pt-4">
              <div className="divide-y">
                {draftBookings.map((booking) => (
                  <div key={booking.id} className="flex items-center justify-between py-3">
                    <div className="min-w-0">
                      <p className="font-medium text-sm">
                        {new Date(booking.checkIn).toLocaleDateString("en-NZ", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                        {" — "}
                        {new Date(booking.checkOut).toLocaleDateString("en-NZ", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {booking._count.guests} guest{booking._count.guests !== 1 ? "s" : ""} · {formatCents(booking.finalPriceCents)}
                        {booking.draftExpiresAt && (
                          <span className="text-amber-600 ml-2">
                            Expires {new Date(booking.draftExpiresAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
                          </span>
                        )}
                      </p>
                    </div>
                    <Button asChild size="sm" variant="outline">
                      <Link href={buildHrefWithReturnTo(`/bookings/${booking.id}`, "/dashboard")}>Resume</Link>
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Recent bookings */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-900">
            Recent Bookings
          </h2>
          <Button variant="outline" size="sm" asChild>
            <Link href="/bookings">View all</Link>
          </Button>
        </div>
        <Card>
          {recentBookings.length === 0 ? (
            <CardContent className="py-12 text-center">
              <BedDouble className="mx-auto h-10 w-10 text-slate-300 mb-3" />
              <p className="text-sm font-medium text-slate-500">
                No bookings yet
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Your booking history will appear here.
              </p>
              <Button asChild size="sm" className="mt-4">
                <Link href="/book">Make your first booking</Link>
              </Button>
            </CardContent>
          ) : (
            <CardContent className="pt-4">
              <div className="divide-y">
                {recentBookings.map((booking) => (
                  <Link
                    key={booking.id}
                    href={buildHrefWithReturnTo(`/bookings/${booking.id}`, "/dashboard")}
                    className="flex items-center justify-between py-3 hover:bg-slate-50 -mx-2 px-2 rounded"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm">
                        {new Date(booking.checkIn).toLocaleDateString("en-NZ", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                        {" — "}
                        {new Date(booking.checkOut).toLocaleDateString("en-NZ", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {booking._count.guests} guest{booking._count.guests !== 1 ? "s" : ""} · {formatCents(booking.finalPriceCents)}
                      </p>
                    </div>
                    <Badge
                      variant="secondary"
                      className={bookingStatusClass(booking.status)}
                    >
                      {bookingStatusLabel(booking.status)}
                    </Badge>
                  </Link>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}
