"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { BookingStatus } from "@prisma/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCents } from "@/lib/utils";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";

export interface MyBookingItem {
  id: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  finalPriceCents: number;
  status: BookingStatus;
  // Split-booking (#738) labelling, pre-computed on the server.
  linkLabel: "linked-parent" | "provisional-child" | null;
}

type SortDir = "desc" | "asc";

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-NZ", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function MyBookingsList({ bookings }: { bookings: MyBookingItem[] }) {
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [statusFilter, setStatusFilter] = useState<BookingStatus | "all">("all");

  // Statuses actually present, so the filter only offers useful options.
  const statusOptions = useMemo(() => {
    const seen = new Set<BookingStatus>();
    for (const booking of bookings) seen.add(booking.status);
    return Array.from(seen);
  }, [bookings]);

  const visibleBookings = useMemo(() => {
    const filtered =
      statusFilter === "all"
        ? bookings
        : bookings.filter((booking) => booking.status === statusFilter);
    const direction = sortDir === "asc" ? 1 : -1;
    // Sort by start date with a stable id tiebreaker so equal dates keep a
    // deterministic order (issue #771).
    return [...filtered].sort((a, b) => {
      const byDate =
        (new Date(a.checkIn).getTime() - new Date(b.checkIn).getTime()) * direction;
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
    });
  }, [bookings, statusFilter, sortDir]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="booking-sort">Sort by start date</Label>
          <Select value={sortDir} onValueChange={(value) => setSortDir(value as SortDir)}>
            <SelectTrigger id="booking-sort" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">Newest first</SelectItem>
              <SelectItem value="asc">Oldest first</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {statusOptions.length > 1 && (
          <div className="space-y-1">
            <Label htmlFor="booking-status">Status</Label>
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as BookingStatus | "all")}
            >
              <SelectTrigger id="booking-status" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {statusOptions.map((status) => (
                  <SelectItem key={status} value={status}>
                    {bookingStatusLabel(status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {visibleBookings.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-gray-600">
            No bookings match the current filter.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {visibleBookings.map((booking) => (
            <Link
              key={booking.id}
              href={buildHrefWithReturnTo(`/bookings/${booking.id}`, "/bookings")}
            >
              <Card className="cursor-pointer transition-shadow hover:shadow-md mb-3">
                <CardContent className="flex items-center justify-between p-4">
                  <div className="space-y-1">
                    <p className="font-medium">
                      {formatDate(booking.checkIn)} - {formatDate(booking.checkOut)}
                    </p>
                    <p className="text-sm text-gray-600">
                      {booking.guestCount} guest{booking.guestCount !== 1 ? "s" : ""} &middot;{" "}
                      {formatCents(booking.finalPriceCents)}
                    </p>
                    {booking.linkLabel === "provisional-child" ? (
                      <p className="text-xs text-sky-700">
                        Provisional non-member guests · linked to your member booking
                      </p>
                    ) : booking.linkLabel === "linked-parent" ? (
                      <p className="text-xs text-sky-700">
                        Includes linked provisional non-member guests
                      </p>
                    ) : null}
                  </div>
                  <Badge variant="secondary" className={bookingStatusClass(booking.status)}>
                    {bookingStatusLabel(booking.status)}
                  </Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
