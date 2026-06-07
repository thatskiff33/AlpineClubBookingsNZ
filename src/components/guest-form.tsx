"use client";

import type { AgeTier } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgeTierOptions } from "@/lib/use-age-tier-options";

export interface GuestData {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: string;
  stayEnd?: string;
}

interface GuestFormProps {
  guests: GuestData[];
  onGuestsChange: (guests: GuestData[]) => void;
  maxGuests: number;
  bookingCheckIn?: string;
  bookingCheckOut?: string;
  perGuestDatesEnabled?: boolean;
  onPerGuestDatesEnabledChange?: (enabled: boolean) => void;
}

function shiftDateOnly(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function GuestForm({
  guests,
  onGuestsChange,
  maxGuests,
  bookingCheckIn,
  bookingCheckOut,
  perGuestDatesEnabled = false,
  onPerGuestDatesEnabledChange,
}: GuestFormProps) {
  const ageTierOptions = useAgeTierOptions();
  const showPerGuestDatesToggle = Boolean(
    bookingCheckIn &&
    bookingCheckOut &&
    guests.length > 1 &&
    onPerGuestDatesEnabledChange
  );
  const latestStayStart = bookingCheckOut ? shiftDateOnly(bookingCheckOut, -1) : undefined;

  function addGuest() {
    if (guests.length >= maxGuests) return;
    onGuestsChange([
      ...guests,
      { firstName: "", lastName: "", ageTier: "ADULT", isMember: false },
    ]);
  }

  function removeGuest(index: number) {
    onGuestsChange(guests.filter((_, i) => i !== index));
  }

  function updateGuest(index: number, field: keyof GuestData, value: string | boolean) {
    const updated = guests.map((g, i) => {
      if (i !== index) return g;
      return { ...g, [field]: value };
    });
    onGuestsChange(updated);
  }

  function handlePerGuestDatesChange(enabled: boolean) {
    onPerGuestDatesEnabledChange?.(enabled);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          Guests ({guests.length}/{maxGuests} max)
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addGuest}
          disabled={guests.length >= maxGuests}
        >
          + Add Guest
        </Button>
      </div>

      {guests.length === 0 && (
        <p className="text-sm text-gray-500">
          Add at least one guest to proceed. You should include yourself if you&apos;re staying.
        </p>
      )}

      {showPerGuestDatesToggle && (
        <div className="flex items-center gap-2 rounded-md border p-3">
          <Checkbox
            id="per-guest-booking-dates"
            checked={perGuestDatesEnabled}
            onCheckedChange={(checked) => handlePerGuestDatesChange(checked === true)}
          />
          <Label htmlFor="per-guest-booking-dates" className="cursor-pointer">
            Per guest booking dates
          </Label>
        </div>
      )}

      {guests.map((guest, index) => {
        const isLinkedMember = Boolean(guest.memberId);
        const stayStart = guest.stayStart || bookingCheckIn || "";
        const stayEnd = guest.stayEnd || bookingCheckOut || "";
        const earliestStayEnd = stayStart ? shiftDateOnly(stayStart, 1) : bookingCheckIn;
        return (
          <div key={index} className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Guest {index + 1}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeGuest(index)}
              className="text-red-500 hover:text-red-700"
            >
              Remove
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>First Name</Label>
              <Input
                value={guest.firstName}
                onChange={(e) => updateGuest(index, "firstName", e.target.value)}
                placeholder="First name"
                required
                disabled={isLinkedMember}
              />
            </div>
            <div className="space-y-1">
              <Label>Last Name</Label>
              <Input
                value={guest.lastName}
                onChange={(e) => updateGuest(index, "lastName", e.target.value)}
                placeholder="Last name"
                required
                disabled={isLinkedMember}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label>Age Category</Label>
            <select
              value={guest.ageTier}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => updateGuest(index, "ageTier", e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
              disabled={isLinkedMember}
            >
              {ageTierOptions.map((option) => (
                <option key={option.tier} value={option.tier}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <p className="text-sm text-gray-500">
            {isLinkedMember
              ? "Linked family members keep their member details and member pricing."
              : "Typed-in guests are treated as non-members and charged at non-member rates."}
          </p>
          {perGuestDatesEnabled && bookingCheckIn && bookingCheckOut && (
            <div className="grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`guest-${index}-stay-start`}>Date In</Label>
                <Input
                  id={`guest-${index}-stay-start`}
                  type="date"
                  value={stayStart}
                  min={bookingCheckIn}
                  max={latestStayStart}
                  onChange={(e) => updateGuest(index, "stayStart", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`guest-${index}-stay-end`}>Date Out</Label>
                <Input
                  id={`guest-${index}-stay-end`}
                  type="date"
                  value={stayEnd}
                  min={earliestStayEnd}
                  max={bookingCheckOut}
                  onChange={(e) => updateGuest(index, "stayEnd", e.target.value)}
                  required
                />
              </div>
            </div>
          )}
          </div>
        );
      })}
    </div>
  );
}
