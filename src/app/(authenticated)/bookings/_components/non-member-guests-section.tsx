import Link from "next/link";
import type { BookingStatus } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/utils";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { calendarDateOfDateOnlyInstant, formatClubDate } from "@/lib/club-time";

// #1975: one genuine #738 split child, shaped for the parent's "Your non-member
// guests" section. Any status (a cancelled or bumped child must still show).
export interface NonMemberGuestChild {
  id: string;
  status: BookingStatus;
  guestCount: number;
  finalPriceCents: number;
  // The child shares the parent's stay dates; only surfaced when they differ.
  datesDiffer: boolean;
  // `@db.Date` LODGE NIGHTS, straight off Prisma — a calendar day encoded at UTC
  // midnight, never a moment (INV-DATE-010).
  checkIn: Date;
  checkOut: Date;
}

// Presentational (server-render safe): the parent member booking surfaces its
// linked provisional non-member children inline — status, differing dates,
// amount, and a link through — so the member reads one family stay with the
// guest portion nested. Presentation only; no pricing/capacity/settlement here.
export function NonMemberGuestsSection({
  guests,
  nonOwnerAdminViewer,
}: {
  guests: NonMemberGuestChild[];
  nonOwnerAdminViewer: boolean;
}) {
  if (guests.length === 0) return null;

  // #1975: the intro must stay truthful per state. When every child is
  // CANCELLED/BUMPED the provisional booking is no longer holding anything, so
  // the "held ... until confirmed and paid" copy would actively misinform. Any
  // child that is not cancelled/bumped counts as live and keeps the held copy.
  const anyLive = guests.some(
    (child) => child.status !== "CANCELLED" && child.status !== "BUMPED",
  );

  return (
    <Card className="border-info-6">
      <CardHeader>
        <CardTitle className="text-info-11">
          {nonOwnerAdminViewer
            ? "The member's non-member guests"
            : "Your non-member guests"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-info-11">
          {anyLive
            ? nonOwnerAdminViewer
              ? "The non-member portion of this party is held in a linked provisional booking. No beds are reserved for these guests until they are confirmed and paid for closer to the stay."
              : "The non-member portion of your party is held in a linked provisional booking. No beds are reserved for these guests until they are confirmed and paid for closer to your stay."
            : nonOwnerAdminViewer
              ? "The linked provisional booking for the member's non-member guests is no longer active."
              : "The linked provisional booking for your non-member guests is no longer active."}
        </p>
        <ul className="space-y-2">
          {guests.map((child) => (
            <li key={child.id}>
              <Link
                href={`/bookings/${child.id}`}
                className="block rounded-md border border-info-6 bg-info-3/60 p-3 transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info-7"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-muted-foreground">
                      {child.guestCount} non-member guest
                      {child.guestCount === 1 ? "" : "s"} &middot;{" "}
                      {formatCents(child.finalPriceCents)}
                    </p>
                    {child.datesDiffer ? (
                      <p className="text-xs text-muted-foreground">
                        {/*
                          A CALENDAR DATE takes no zone: the kernel decodes the
                          UTC-midnight encoding back to the day it encodes and
                          formats it pinned to `UTC`, so the projection is
                          provably the identity for every club (CT-4, #2870).
                          `formatNZDate` projected it through `APP_TIME_ZONE`,
                          which is a day early for any club west of Greenwich.
                        */}
                        {formatClubDate(calendarDateOfDateOnlyInstant(child.checkIn))}{" "}
                        - {formatClubDate(calendarDateOfDateOnlyInstant(child.checkOut))}
                      </p>
                    ) : null}
                    <p className="text-xs font-medium text-info-11 underline">
                      View provisional guest booking
                    </p>
                  </div>
                  <Badge
                    variant="secondary"
                    className={bookingStatusClass(child.status)}
                  >
                    {bookingStatusLabel(child.status)}
                  </Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
