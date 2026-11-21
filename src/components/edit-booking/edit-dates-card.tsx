"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The stay envelope: check-in, check-out, and what the current edit mode allows.
 *
 * Moved out of `edit-booking-panel.tsx` (#2690) as pure presentation. The
 * shift-mode coupling — moving one bound derives the other so the night count
 * stays fixed — is NOT here: it stays in the panel's `handleCheckInChange` /
 * `handleCheckOutChange`, because preview and apply are required to agree on
 * the night count and that rule belongs with the payload builder.
 */
export function EditDatesCard({
  checkIn,
  checkOut,
  bookingCheckIn,
  bookingCheckOut,
  today,
  minEditableDate,
  overrideEnabled,
  checkInLocked,
  isInProgressEdit,
  shiftMode,
  originalNights,
  onCheckInChange,
  onCheckOutChange,
}: {
  checkIn: string;
  checkOut: string;
  bookingCheckIn: string;
  bookingCheckOut: string;
  today: string;
  minEditableDate: string;
  overrideEnabled: boolean;
  checkInLocked: boolean;
  isInProgressEdit: boolean;
  shiftMode: boolean;
  originalNights: number;
  onCheckInChange: (value: string) => void;
  onCheckOutChange: (value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2}>Dates</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="edit-checkin">Check-in</Label>
            <Input
              id="edit-checkin"
              type="date"
              value={checkIn}
              min={overrideEnabled ? undefined : today}
              disabled={checkInLocked}
              onChange={(e) => onCheckInChange(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-checkout">Check-out</Label>
            <Input
              id="edit-checkout"
              type="date"
              value={checkOut}
              min={isInProgressEdit ? minEditableDate : checkIn || today}
              onChange={(e) => onCheckOutChange(e.target.value)}
            />
          </div>
        </div>
        {checkIn !== bookingCheckIn || checkOut !== bookingCheckOut ? (
          <p className="text-sm text-muted-foreground mt-2">
            Originally: {bookingCheckIn} to {bookingCheckOut}
          </p>
        ) : null}
        {shiftMode ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Shift keeps this {originalNights}-night stay the same length — the
            price stays exactly as booked.
          </p>
        ) : null}
        {isInProgressEdit ? (
          <div className="mt-2 space-y-1 text-sm text-warning-11">
            <p>
              Your stay has started, so the check-in date stays fixed — you
              can extend your check-out, night by night, from {minEditableDate}{" "}
              onward.
            </p>
            <p>
              Minimum-stay rules apply to your whole stay, not just the added
              nights. Nights up to today can only be changed by an admin.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
