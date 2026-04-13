import { prisma } from "@/lib/prisma";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { formatCents } from "@/lib/utils";
import { BookingFilters } from "@/components/admin/booking-filters";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { AdminBookingCalendar } from "@/components/admin-booking-calendar";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";

export default async function AdminBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    from?: string;
    to?: string;
    search?: string;
    upcoming?: string;
    sort?: string;
    month?: string;
  }>;
}) {
  const params = await searchParams;
  const statusFilter = params.status;
  const fromDate = params.from;
  const toDate = params.to;
  const search = params.search;
  const upcomingDays = params.upcoming ? parseInt(params.upcoming, 10) : null;
  const sortBy = params.sort === "checkIn" ? "checkIn" : "updatedAt";
  const monthFilter = params.month;

  const where: Record<string, unknown> = {};

  if (statusFilter === "DRAFT") {
    where.status = "DRAFT";
  } else if (statusFilter && statusFilter !== "all") {
    // Support comma-separated statuses (e.g. "CONFIRMED,PAID")
    const statuses = statusFilter.split(",").map((s) => s.trim()).filter(Boolean);
    where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
  } else {
    // Exclude DRAFT bookings by default
    where.status = { not: "DRAFT" };
  }

  if (upcomingDays !== null && !isNaN(upcomingDays)) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + upcomingDays);
    where.checkIn = { gte: today, lte: futureDate };
    // When filtering upcoming, default to active statuses if no status filter set
    if (!statusFilter) {
      where.status = { in: ["CONFIRMED", "PAID", "PENDING"] };
    }
  }

  if (monthFilter && /^\d{4}-\d{2}$/.test(monthFilter)) {
    const [y, m] = monthFilter.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0); // last day of month
    where.checkIn = { ...(where.checkIn as object || {}), gte: monthStart, lte: monthEnd };
  }

  if (fromDate) {
    where.checkIn = { ...(where.checkIn as object || {}), gte: new Date(fromDate) };
  }

  if (toDate) {
    where.checkOut = { ...(where.checkOut as object || {}), lte: new Date(toDate) };
  }

  if (search) {
    where.member = {
      OR: [
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ],
    };
  }

  const bookings = await prisma.booking.findMany({
    where,
    include: {
      member: { select: { firstName: true, lastName: true, email: true } },
      guests: true,
    },
    orderBy: { [sortBy]: "desc" },
    take: 100,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">All Bookings</h1>
        <Link
          href="/admin/book"
          className="app-button-brand"
        >
          + Create Booking
        </Link>
      </div>

      <BookingFilters />

      <AdminBookingCalendar />

      {bookings.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-gray-500">
            No bookings found matching your filters.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-gray-500">{bookings.length} bookings found</p>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 bg-white rounded-lg shadow">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Member</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Dates</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Guests</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Xero</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {bookings.map((booking) => (
                  <tr key={booking.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link href={`/bookings/${booking.id}`} className="hover:underline">
                        <p className="font-medium text-sm">
                          {booking.member.firstName} {booking.member.lastName}
                        </p>
                        <p className="text-xs text-gray-500">{booking.member.email}</p>
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {new Date(booking.checkIn).toLocaleDateString("en-NZ")} -{" "}
                      {new Date(booking.checkOut).toLocaleDateString("en-NZ")}
                    </td>
                    <td className="px-4 py-3 text-sm">{booking.guests.length}</td>
                    <td className="px-4 py-3 text-sm font-medium">{formatCents(booking.finalPriceCents)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className={bookingStatusClass(booking.status)}>
                          {bookingStatusLabel(booking.status)}
                        </Badge>
                        {booking.requiresAdminReview ? (
                          <Badge variant="secondary" className="bg-amber-100 text-amber-900">
                            Review
                          </Badge>
                        ) : null}
                      </div>
                      {booking.requiresAdminReview && booking.adminReviewReason ? (
                        <p className="mt-1 text-xs text-amber-800">{booking.adminReviewReason}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <Link
                        href={buildXeroRecordActivityUrl("Booking", booking.id)}
                        className="text-blue-600 hover:underline"
                      >
                        Activity
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
