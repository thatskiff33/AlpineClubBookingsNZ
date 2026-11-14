"use client";

import { BookingCalendar } from "@/components/booking-calendar";
import { LodgeSelect, type LodgeOption } from "@/components/lodge-select";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SettledLodgeOptionScope } from "@/lib/lodge-option-scope";

export function DatesStep({
  bookingBlockedBySubscription,
  handleDateSelect,
  checkIn,
  checkOut,
  lodges,
  lodgeId,
  lodgesLoading,
  lodgeScope,
  retryLodgeOptions,
  handleLodgeChange,
  selectedLodge,
}: {
  // The consequence, not the fact (#4941): true only when the club's lockout
  // mode is HARD_BLOCK and the subscription is unpaid. Under NON_MEMBER_PRICING
  // and NO_BLOCK an unpaid member still picks dates.
  bookingBlockedBySubscription: boolean;
  // Lodge nights are NZ date-only strings end-to-end (#2474).
  handleDateSelect: (ci: string, co: string) => void;
  checkIn: string | null;
  checkOut: string | null;
  lodges: LodgeOption[];
  lodgeId: string | null;
  lodgesLoading: boolean;
  lodgeScope: SettledLodgeOptionScope;
  retryLodgeOptions: () => void;
  handleLodgeChange: (nextLodgeId: string | null) => void;
  selectedLodge: LodgeOption | null;
}) {
  // A successful non-empty list can still be in the short normalisation window
  // before LodgeSelect chooses its first option. Keep the selector mounted in
  // that window so it can make the choice, but do not mount the calendar until
  // the choice has been validated against that same successful response.
  const lodgeUniverseReady =
    !lodgesLoading &&
    lodgeScope.kind !== "failed" &&
    lodgeScope.kind !== "forbidden" &&
    lodgeScope.kind !== "empty" &&
    lodges.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Select Your Dates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {bookingBlockedBySubscription ? (
          <p className="text-sm text-warning py-8 text-center">
            Booking is disabled until your subscription is paid.
          </p>
        ) : (
          <>
            {lodgeUniverseReady ? <div className="max-w-xs">
              <LodgeSelect
                lodges={lodges}
                value={lodgeId}
                onChange={handleLodgeChange}
                loading={lodgesLoading}
              />
            </div> : null}
            {lodgeScope.kind === "loading" ? (
              <p className="text-sm text-muted-foreground">Loading lodge options...</p>
            ) : lodgeScope.kind === "failed" ? (
              <Alert variant="error" title="The lodge list could not be loaded">
                <p className="mb-3">
                  We cannot show dates until we know which lodge the booking is
                  for. Nothing has been booked or charged.
                </p>
                <Button variant="outline" onClick={retryLodgeOptions}>
                  Try again
                </Button>
              </Alert>
            ) : lodgeScope.kind === "forbidden" ? (
              <Alert variant="error" title="Lodge access could not be checked">
                We cannot show dates or start a booking because your account
                could not load the lodge list. Nothing has been booked or charged.
              </Alert>
            ) : lodgeScope.kind === "empty" ? (
              <Alert variant="info" title="No active lodges">
                Booking is unavailable until the club has an active lodge.
              </Alert>
            ) : null}
            {lodgeScope.kind === "lodge" && lodges.length > 1 && selectedLodge?.travelNote ? (
              <p className="text-sm text-muted-foreground">
                {selectedLodge.travelNote}
              </p>
            ) : null}
            {lodgeScope.kind === "lodge" ? <BookingCalendar
              onDateSelect={handleDateSelect}
              selectedCheckIn={checkIn}
              selectedCheckOut={checkOut}
              lodgeId={lodgeScope.lodgeId}
            /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
