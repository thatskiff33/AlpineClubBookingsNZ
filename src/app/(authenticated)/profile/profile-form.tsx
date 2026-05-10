"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { MemberAddressFields } from "@/components/member-address-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  postalMatchesPhysical,
  withDefaultNzCountry,
} from "@/lib/member-address";

interface ProfileFormProps {
  member: {
    id: string;
    firstName: string;
    lastName: string;
    phoneCountryCode: string;
    phoneAreaCode: string;
    phoneNumber: string;
    dateOfBirth: string;
    streetAddressLine1: string;
    streetAddressLine2: string;
    streetCity: string;
    streetRegion: string;
    streetPostalCode: string;
    streetCountry: string;
    postalAddressLine1: string;
    postalAddressLine2: string;
    postalCity: string;
    postalRegion: string;
    postalPostalCode: string;
    postalCountry: string;
  };
  onSaved?: () => void;
  submitLabel?: string;
}

export function ProfileForm({
  member,
  onSaved,
  submitLabel = "Save Changes",
}: ProfileFormProps) {
  const [form, setForm] = useState({
    firstName: member.firstName,
    lastName: member.lastName,
    phoneCountryCode: member.phoneCountryCode,
    phoneAreaCode: member.phoneAreaCode,
    phoneNumber: member.phoneNumber,
    dateOfBirth: member.dateOfBirth,
    streetAddressLine1: member.streetAddressLine1,
    streetAddressLine2: member.streetAddressLine2,
    streetCity: member.streetCity,
    streetRegion: member.streetRegion,
    streetPostalCode: member.streetPostalCode,
    streetCountry: withDefaultNzCountry(member.streetCountry),
    postalAddressLine1: member.postalAddressLine1,
    postalAddressLine2: member.postalAddressLine2,
    postalCity: member.postalCity,
    postalRegion: member.postalRegion,
    postalPostalCode: member.postalPostalCode,
    postalCountry: withDefaultNzCountry(member.postalCountry),
  });
  const [sameAsPhysical, setSameAsPhysical] = useState(
    postalMatchesPhysical({
      streetAddressLine1: member.streetAddressLine1,
      streetAddressLine2: member.streetAddressLine2,
      streetCity: member.streetCity,
      streetRegion: member.streetRegion,
      streetPostalCode: member.streetPostalCode,
      streetCountry: withDefaultNzCountry(member.streetCountry),
      postalAddressLine1: member.postalAddressLine1,
      postalAddressLine2: member.postalAddressLine2,
      postalCity: member.postalCity,
      postalRegion: member.postalRegion,
      postalPostalCode: member.postalPostalCode,
      postalCountry: withDefaultNzCountry(member.postalCountry),
    })
  );
  const [saving, setSaving] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          postalSameAsPhysical: sameAsPhysical,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error ?? "Failed to update profile");
        return;
      }

      toast.success("Profile updated successfully");
      onSaved?.();
    } catch {
      toast.error("An unexpected error occurred");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="firstName">First Name</Label>
          <Input
            id="firstName"
            name="firstName"
            value={form.firstName}
            onChange={handleChange}
            required
            minLength={1}
            maxLength={100}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lastName">Last Name</Label>
          <Input
            id="lastName"
            name="lastName"
            value={form.lastName}
            onChange={handleChange}
            required
            minLength={1}
            maxLength={100}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Phone Number</Label>
        <div className="flex gap-2">
          <div className="w-20">
            <Input
              name="phoneCountryCode"
              value={form.phoneCountryCode}
              onChange={handleChange}
              placeholder="64"
              required
              maxLength={5}
              aria-label="Country code"
            />
          </div>
          <div className="w-20">
            <Input
              name="phoneAreaCode"
              value={form.phoneAreaCode}
              onChange={handleChange}
              placeholder="27"
              required
              maxLength={5}
              aria-label="Area code"
            />
          </div>
          <div className="flex-1">
            <Input
              name="phoneNumber"
              value={form.phoneNumber}
              onChange={handleChange}
              placeholder="123 4567"
              required
              maxLength={15}
              aria-label="Phone number"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Country code (e.g. 64), area code (e.g. 27), and number. Synced with Xero.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="dateOfBirth">Date of Birth</Label>
        <Input
          id="dateOfBirth"
          name="dateOfBirth"
          type="date"
          value={form.dateOfBirth}
          onChange={handleChange}
          max={new Date().toISOString().substring(0, 10)}
          required
        />
        <p className="text-xs text-muted-foreground">
          Used to determine your membership age tier (Adult / Youth / Child / Infant).
        </p>
      </div>

      <MemberAddressFields
        collapsible
        idPrefix="profile"
        onSameAsPhysicalChange={setSameAsPhysical}
        onValuesChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
        required
        sameAsPhysical={sameAsPhysical}
        values={form}
      />

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {saving ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}
