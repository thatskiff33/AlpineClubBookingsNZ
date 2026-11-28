"use client";

/**
 * One work-party event's attending bookings: the read, and what the expanded
 * card shows while it loads, when it fails and once it has loaded. Moved
 * verbatim out of the work-parties page (ALP-649, #5187) so the page stays
 * near its size budget; the page owns which card is open.
 */

import { Button } from "@/components/ui/button";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FocusedActionError } from "@/components/focused-action-error";
import { useClubFormat } from "@/components/club-format-provider";
import { calendarDateOfSerialisedDbDateOrNull } from "@/lib/club-time";
import { formatCents } from "@/lib/pricing";
import { apiRefusalFromResponse } from "@/lib/api-error-message";

interface AttendingBooking {
  id: string;
  discountCents: number;
  createdAt: string;
  booking: {
    id: string;
    checkIn: string;
    checkOut: string;
    status: string;
    finalPriceCents: number;
  };
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
}

export interface EventDetail {
  attendingBookings: AttendingBooking[];
  totalDiscountCents: number;
}

// CT-4 (#2870): a work-party day and a booking's check-in/check-out are
// CALENDAR DATES, serialised from `@db.Date` columns as UTC midnight. Decoding
// that encoding in UTC is the identity for every club; reading it through
// APP_TIME_ZONE was a projection that named the previous day for any club
// behind UTC (INV-DATE-019). The rendered shape — the stored `yyyy-MM-dd` — is
// unchanged.
export function formatStoredDate(value: string) {
  return calendarDateOfSerialisedDbDateOrNull(value) ?? value;
}

export const DETAIL_FALLBACK = "Failed to load attending bookings";

/**
 * One event's attending bookings. A failed read used to leave "Loading
 * bookings..." standing for good; the refusal is now thrown, and the caller
 * shows the reason inside that event's card, where the officer pressed "Show
 * bookings", with a way to try again.
 */
export async function fetchEventDetail(eventId: string): Promise<EventDetail> {
  const res = await fetch(`/api/admin/work-parties/${eventId}`);
  if (!res.ok) throw await apiRefusalFromResponse(res, DETAIL_FALLBACK);
  const data = await res.json();
  return { attendingBookings: data.attendingBookings, totalDiscountCents: data.totalDiscountCents };
}

/**
 * The attending-bookings table for one expanded event, the loading state, or
 * why the read failed. The failure region is permanently mounted while the row
 * is open and takes focus when a reason arrives (`FocusedActionError`), so a
 * card below the fold does not fail off screen.
 *
 * Extracted (#2801) so the expanded detail is looked up ONCE: the row above
 * used to test `details[event.id]` and then read `.attendingBookings` off a
 * second lookup of the same key, which under stricter indexed access is the
 * compiler pointing out that the two reads were never provably the same value.
 * "Have I loaded this event's bookings yet" is now one question with one
 * answer, in one place.
 */
export function ExpandedEventBookings({
  eventId,
  detail,
  error,
  onRetry,
}: {
  eventId: string;
  detail: EventDetail | undefined;
  error: string;
  onRetry: () => void;
}) {
  const failure = (
    <FocusedActionError
      id={`wp-bookings-error-${eventId}`}
      error={error}
      action={<Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}
    />
  );
  if (error || !detail) {
    return (
      <>
        {failure}
        {!error && (
          <div className="rounded-md border p-3 text-sm text-muted-foreground">
            Loading bookings...
          </div>
        )}
      </>
    );
  }
  return <EventBookingsTable detail={detail} />;
}

function EventBookingsTable({ detail }: { detail: EventDetail }) {
  const format = useClubFormat();
  return (
    <AdminDataTable showDensityToggle={false}>
      <TableHeader>
        <TableRow>
          <TableHead>Member</TableHead>
          <TableHead>Stay</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Discount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {detail.attendingBookings.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              {row.member.firstName} {row.member.lastName}
            </TableCell>
            <TableCell>
              {formatStoredDate(row.booking.checkIn)} to{" "}
              {formatStoredDate(row.booking.checkOut)}
            </TableCell>
            <TableCell>{row.booking.status}</TableCell>
            <TableCell className="text-right">
              {formatCents(row.discountCents, format)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </AdminDataTable>
  );
}
