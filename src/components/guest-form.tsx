"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export interface GuestData {
  firstName: string;
  lastName: string;
  ageTier: "ADULT" | "YOUTH" | "CHILD";
  isMember: boolean;
}

interface GuestFormProps {
  guests: GuestData[];
  onGuestsChange: (guests: GuestData[]) => void;
  maxGuests: number;
}

export function GuestForm({ guests, onGuestsChange, maxGuests }: GuestFormProps) {
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

      {guests.map((guest, index) => (
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
              />
            </div>
            <div className="space-y-1">
              <Label>Last Name</Label>
              <Input
                value={guest.lastName}
                onChange={(e) => updateGuest(index, "lastName", e.target.value)}
                placeholder="Last name"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Age Category</Label>
              <Select
                value={guest.ageTier}
                onChange={(e) => updateGuest(index, "ageTier", e.target.value)}
              >
                <option value="ADULT">Adult (18+)</option>
                <option value="YOUTH">Youth (10-17)</option>
                <option value="CHILD">Child (under 10)</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Membership</Label>
              <Select
                value={guest.isMember ? "true" : "false"}
                onChange={(e) => updateGuest(index, "isMember", e.target.value === "true")}
              >
                <option value="true">Member</option>
                <option value="false">Non-member</option>
              </Select>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
