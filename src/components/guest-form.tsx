"use client";

import type { AgeTier } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgeTierOptions } from "@/lib/use-age-tier-options";

export interface GuestData {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
}

interface GuestFormProps {
  guests: GuestData[];
  onGuestsChange: (guests: GuestData[]) => void;
  maxGuests: number;
}

export function GuestForm({ guests, onGuestsChange, maxGuests }: GuestFormProps) {
  const ageTierOptions = useAgeTierOptions();

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

      {guests.map((guest, index) => {
        const isLinkedMember = Boolean(guest.memberId);
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
          </div>
        );
      })}
    </div>
  );
}
