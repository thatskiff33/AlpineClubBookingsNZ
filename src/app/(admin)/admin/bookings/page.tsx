import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { formatCents } from "@/lib/utils";
import { BookingFilters } from "@/components/admin/booking-filters";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { AdminBookingCalendar } from "@/components/admin-booking-calendar";
import { buildXeroRecordActivityUrl } from "@/lib/xero-record-links";
import { buildHrefWithReturnTo, buildPathWithSearch } from "@/lib/internal-return-path";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ReactNode } from "react";

type BookingSortBy = "member" | "lastUpdated" | "checkIn" | "guests" | "total" | "status";
type SortDir = "asc" | "desc";

const bookingSortColumns = new Set<BookingSortBy>([
  "member",
  "lastUpdated",
  "checkIn",
  "guests",
  "total",
  "status",
]);
const validBookingStatuses = new Set<BookingStatus>(Object.values(BookingStatus));

function parseDateStart(value: string) {
  return new Date(`${value}T00:00:00`);
}

function parseDateEnd(value: string) {
  return new Date(`${value}T23:59:59`);
}

function getSortBy(params: { sortBy?: string; sort?: string }): BookingSortBy {
  const requested = params.sortBy ?? params.sort;
  return bookingSortColumns.has(requested as BookingSortBy)
    ? (requested as BookingSortBy)
    : requested === "updatedAt"
      ? "lastUpdated"
      : "lastUpdated";
}

function getDefaultSortDir(sortBy: BookingSortBy): SortDir {
  return sortBy === "member" || sortBy === "status" ? "asc" : "desc";
}

function getOrderBy(sortBy: BookingSortBy, sortDir: SortDir): Prisma.BookingOrderByWithRelationInput[] {
  switch (sortBy) {
    case "member":
      return [
        { member: { lastName: sortDir } },
        { member: { firstName: sortDir } },
        { updatedAt: "desc" },
      ];
    case "checkIn":
      return [{ checkIn: sortDir }, { updatedAt: "desc" }];
    case "guests":
      return [{ guests: { _count: sortDir } }, { updatedAt: "desc" }];
    case "total":
      return [{ finalPriceCents: sortDir }, { updatedAt: "desc" }];
    case "status":
      return [{ status: sortDir }, { updatedAt: "desc" }];
    case "lastUpdated":
    default:
      return [{ updatedAt: sortDir }, { id: "asc" }];
  }
}

function formatDate(value: Date) {
  return value.toLocaleDateString("en-NZ");
}

export function formatAdminBookingGuestCount(totalGuests: number, nonMemberGuests: number) {
  return `${totalGuests} (${nonMemberGuests} non-member${nonMemberGuests === 1 ? "" : "s"})`;
}

export default async function AdminBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    from?: string;
    to?: string;
    updatedFrom?: string;
    updatedTo?: string;
    checkInFrom?: string;
    checkInTo?: string;
    search?: string;
    upcoming?: string;
    sort?: string;
    sortBy?: string;
    sortDir?: string;
    month?: string;
  }>;
}) {
  const params = await searchParams;
  const statusFilter = params.status;
  const updatedFrom = params.updatedFrom;
  const updatedTo = params.updatedTo;
  const checkInFrom = params.checkInFrom ?? params.from;
  const checkInTo = params.checkInTo;
  const legacyToDate = params.checkInTo ? undefined : params.to;
  const search = params.search;
  const upcomingDays = params.upcoming ? parseInt(params.upcoming, 10) : null;
  const sortBy = getSortBy(params);
  const sortDir: SortDir = params.sortDir === "asc" || params.sortDir === "desc"
    ? params.sortDir
    : getDefaultSortDir(sortBy);
  const monthFilter = params.month;
  const currentSearchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value) {
      currentSearchParams.set(key, value);
    }
  }
  const currentBookingsPath = buildPathWithSearch("/admin/bookings", currentSearchParams);

  const where: Prisma.BookingWhereInput = {};
  const checkInFilter: Prisma.DateTimeFilter = {};
  const checkOutFilter: Prisma.DateTimeFilter = {};
  const updatedAtFilter: Prisma.DateTimeFilter = {};

  if (statusFilter === "DRAFT") {
    where.status = BookingStatus.DRAFT;
  } else if (statusFilter && statusFilter !== "all") {
    // Support comma-separated statuses (e.g. "CONFIRMED,PAID")
    const statuses = statusFilter
      .split(",")
      .map((s) => s.trim())
      .filter((status): status is BookingStatus =>
        validBookingStatuses.has(status as BookingStatus)
      );
    where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
  } else {
    // Exclude DRAFT bookings by default
    where.status = { not: BookingStatus.DRAFT };
  }

  if (upcomingDays !== null && !isNaN(upcomingDays)) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + upcomingDays);
    checkInFilter.gte = today;
    checkInFilter.lte = futureDate;
    // When filtering upcoming, default to active statuses if no status filter set
    if (!statusFilter) {
      where.status = {
        in: [
          BookingStatus.PAYMENT_PENDING,
          BookingStatus.CONFIRMED,
          BookingStatus.PAID,
          BookingStatus.PENDING,
        ],
      };
    }
  }

  if (monthFilter && /^\d{4}-\d{2}$/.test(monthFilter)) {
    const [y, m] = monthFilter.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0); // last day of month
    checkInFilter.gte = monthStart;
    checkInFilter.lte = monthEnd;
  }

  if (checkInFrom) {
    checkInFilter.gte = parseDateStart(checkInFrom);
  }

  if (checkInTo) {
    checkInFilter.lte = parseDateEnd(checkInTo);
  }

  if (legacyToDate) {
    checkOutFilter.lte = parseDateEnd(legacyToDate);
  }

  if (updatedFrom) {
    updatedAtFilter.gte = parseDateStart(updatedFrom);
  }

  if (updatedTo) {
    updatedAtFilter.lte = parseDateEnd(updatedTo);
  }

  if (search?.trim()) {
    const queryTerms = search.trim().split(/\s+/).filter(Boolean);
    where.member = {
      is: {
        AND: queryTerms.map((term) => ({
          OR: [
            { firstName: { contains: term, mode: "insensitive" } },
            { lastName: { contains: term, mode: "insensitive" } },
            { email: { contains: term, mode: "insensitive" } },
          ],
        })),
      },
    };
  }

  if (Object.keys(checkInFilter).length > 0) {
    where.checkIn = checkInFilter;
  }

  if (Object.keys(checkOutFilter).length > 0) {
    where.checkOut = checkOutFilter;
  }

  if (Object.keys(updatedAtFilter).length > 0) {
    where.updatedAt = updatedAtFilter;
  }

  const bookings = await prisma.booking.findMany({
    where,
    include: {
      member: { select: { id: true, firstName: true, lastName: true, email: true } },
      guests: { select: { isMember: true } },
    },
    orderBy: getOrderBy(sortBy, sortDir),
    take: 100,
  });

  function sortHref(column: BookingSortBy) {
    const nextParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value) {
        nextParams.set(key, value);
      }
    }

    const nextDir: SortDir = sortBy === column
      ? sortDir === "asc" ? "desc" : "asc"
      : getDefaultSortDir(column);
    nextParams.delete("sort");
    nextParams.set("sortBy", column);
    nextParams.set("sortDir", nextDir);

    return `/admin/bookings?${nextParams.toString()}`;
  }

  function SortIcon({ column }: { column: BookingSortBy }) {
    if (sortBy !== column) {
      return <ArrowUpDown className="ml-1 h-3 w-3 opacity-40" />;
    }

    return sortDir === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3" />
    );
  }

  function SortHeader({ column, children }: { column: BookingSortBy; children: ReactNode }) {
    return (
      <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
        <Link href={sortHref(column)} className="inline-flex items-center whitespace-nowrap hover:text-gray-900">
          {children}
          <SortIcon column={column} />
        </Link>
      </th>
    );
  }

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
                  <SortHeader column="member">Member</SortHeader>
                  <SortHeader column="lastUpdated">Last Updated</SortHeader>
                  <SortHeader column="checkIn">Check In</SortHeader>
                  <SortHeader column="guests">Guests</SortHeader>
                  <SortHeader column="total">Total</SortHeader>
                  <SortHeader column="status">Status</SortHeader>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Xero</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {bookings.map((booking) => {
                  const nonMemberGuestCount = booking.guests.filter((guest) => !guest.isMember).length;

                  return (
                    <tr key={booking.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link
                          href={buildHrefWithReturnTo(`/admin/members/${booking.member.id}`, currentBookingsPath)}
                          className="hover:underline"
                        >
                          <p className="font-medium text-sm text-blue-600">
                            {booking.member.firstName} {booking.member.lastName}
                          </p>
                          <p className="text-xs text-gray-500">{booking.member.email}</p>
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-sm">{formatDate(booking.updatedAt)}</td>
                      <td className="px-4 py-3 text-sm">
                        <p>{formatDate(booking.checkIn)}</p>
                        <p className="text-xs text-gray-500">to {formatDate(booking.checkOut)}</p>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {formatAdminBookingGuestCount(booking.guests.length, nonMemberGuestCount)}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium">{formatCents(booking.finalPriceCents)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={buildHrefWithReturnTo(`/bookings/${booking.id}`, currentBookingsPath)}
                            className="inline-flex"
                          >
                            <Badge variant="secondary" className={`${bookingStatusClass(booking.status)} cursor-pointer`}>
                              {bookingStatusLabel(booking.status)}
                            </Badge>
                          </Link>
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
                          href={buildXeroRecordActivityUrl("Booking", booking.id, currentBookingsPath)}
                          className="text-blue-600 hover:underline"
                        >
                          Activity
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
