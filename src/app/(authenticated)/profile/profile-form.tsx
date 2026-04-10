"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2 } from "lucide-react";

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
}

export function ProfileForm({ member }: ProfileFormProps) {
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
    streetCountry: member.streetCountry,
    postalAddressLine1: member.postalAddressLine1,
    postalAddressLine2: member.postalAddressLine2,
    postalCity: member.postalCity,
    postalRegion: member.postalRegion,
    postalPostalCode: member.postalPostalCode,
    postalCountry: member.postalCountry,
  });
  const [sameAsPhysical, setSameAsPhysical] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSameAsPhysical = (checked: boolean) => {
    setSameAsPhysical(checked);
    if (checked) {
      setForm((prev) => ({
        ...prev,
        postalAddressLine1: prev.streetAddressLine1,
        postalAddressLine2: prev.streetAddressLine2,
        postalCity: prev.streetCity,
        postalRegion: prev.streetRegion,
        postalPostalCode: prev.streetPostalCode,
        postalCountry: prev.streetCountry,
      }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error ?? "Failed to update profile");
        return;
      }

      toast.success("Profile updated successfully");
    } catch {
      toast.error("An unexpected error occurred");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Name */}
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

      {/* Phone */}
      <div className="space-y-2">
        <Label>Phone Number</Label>
        <div className="flex gap-2">
          <div className="w-20">
            <Input
              name="phoneCountryCode"
              value={form.phoneCountryCode}
              onChange={handleChange}
              placeholder="64"
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
              maxLength={15}
              aria-label="Phone number"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Country code (e.g. 64), area code (e.g. 27), and number. Synced with Xero.
        </p>
      </div>

      {/* Date of Birth */}
      <div className="space-y-2">
        <Label htmlFor="dateOfBirth">Date of Birth</Label>
        <Input
          id="dateOfBirth"
          name="dateOfBirth"
          type="date"
          value={form.dateOfBirth}
          onChange={handleChange}
          max={new Date().toISOString().substring(0, 10)}
        />
        <p className="text-xs text-muted-foreground">
          Used to determine your membership age tier (Adult / Youth / Child).
        </p>
      </div>

      {/* Physical Address */}
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Physical Address</legend>
        <Input
          name="streetAddressLine1"
          value={form.streetAddressLine1}
          onChange={handleChange}
          placeholder="Address line 1"
          maxLength={200}
        />
        <Input
          name="streetAddressLine2"
          value={form.streetAddressLine2}
          onChange={handleChange}
          placeholder="Address line 2"
          maxLength={200}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            name="streetCity"
            value={form.streetCity}
            onChange={handleChange}
            placeholder="City / Town"
            maxLength={200}
          />
          <Input
            name="streetRegion"
            value={form.streetRegion}
            onChange={handleChange}
            placeholder="Region"
            maxLength={200}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            name="streetPostalCode"
            value={form.streetPostalCode}
            onChange={handleChange}
            placeholder="Postal code"
            maxLength={20}
          />
          <Input
            name="streetCountry"
            value={form.streetCountry}
            onChange={handleChange}
            placeholder="Country"
            maxLength={100}
          />
        </div>
      </fieldset>

      {/* Postal Address */}
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Postal Address</legend>
        <div className="flex items-center gap-2 pb-1">
          <Checkbox
            id="sameAsPhysical"
            checked={sameAsPhysical}
            onCheckedChange={(checked) => handleSameAsPhysical(checked === true)}
          />
          <Label htmlFor="sameAsPhysical" className="text-sm font-normal cursor-pointer">
            Same as physical address
          </Label>
        </div>
        <Input
          name="postalAddressLine1"
          value={form.postalAddressLine1}
          onChange={handleChange}
          placeholder="Address line 1"
          maxLength={200}
          disabled={sameAsPhysical}
        />
        <Input
          name="postalAddressLine2"
          value={form.postalAddressLine2}
          onChange={handleChange}
          placeholder="Address line 2"
          maxLength={200}
          disabled={sameAsPhysical}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            name="postalCity"
            value={form.postalCity}
            onChange={handleChange}
            placeholder="City / Town"
            maxLength={200}
            disabled={sameAsPhysical}
          />
          <Input
            name="postalRegion"
            value={form.postalRegion}
            onChange={handleChange}
            placeholder="Region"
            maxLength={200}
            disabled={sameAsPhysical}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            name="postalPostalCode"
            value={form.postalPostalCode}
            onChange={handleChange}
            placeholder="Postal code"
            maxLength={20}
            disabled={sameAsPhysical}
          />
          <Input
            name="postalCountry"
            value={form.postalCountry}
            onChange={handleChange}
            placeholder="Country"
            maxLength={100}
            disabled={sameAsPhysical}
          />
        </div>
      </fieldset>

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </form>
  );
}
