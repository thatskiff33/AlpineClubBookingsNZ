"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { getSafeInternalReturnPath } from "@/lib/internal-return-path";

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
  editable?: boolean;
  formId?: string;
  onSaved?: () => void;
  onSavingChange?: (saving: boolean) => void;
  returnTo?: string | null;
  showSubmitButton?: boolean;
  submitLabel?: string;
}

export function ProfileForm({
  member,
  editable = true,
  formId,
  onSaved,
  onSavingChange,
  returnTo,
  showSubmitButton = true,
  submitLabel = "Save Changes",
}: ProfileFormProps) {
  const router = useRouter();
  const safeReturnTo = getSafeInternalReturnPath(returnTo);
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
  const readOnly = !editable;
  const readOnlyInputClassName = readOnly
    ? "bg-slate-50 text-slate-900 shadow-none focus-visible:ring-0"
    : undefined;

  function setSavingState(nextSaving: boolean) {
    setSaving(nextSaving);
    onSavingChange?.(nextSaving);
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (readOnly) return;

    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly) return;

    setSavingState(true);

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
      if (safeReturnTo) {
        router.replace(safeReturnTo);
      }
    } catch {
      toast.error("An unexpected error occurred");
    } finally {
      setSavingState(false);
    }
  };

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="firstName">First Name</Label>
          <Input
            className={readOnlyInputClassName}
            disabled={saving}
            id="firstName"
            name="firstName"
            readOnly={readOnly}
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
            className={readOnlyInputClassName}
            disabled={saving}
            id="lastName"
            name="lastName"
            readOnly={readOnly}
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
              className={readOnlyInputClassName}
              disabled={saving}
              name="phoneCountryCode"
              readOnly={readOnly}
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
              className={readOnlyInputClassName}
              disabled={saving}
              name="phoneAreaCode"
              readOnly={readOnly}
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
              className={readOnlyInputClassName}
              disabled={saving}
              name="phoneNumber"
              readOnly={readOnly}
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
          className={readOnlyInputClassName}
          disabled={saving}
          id="dateOfBirth"
          name="dateOfBirth"
          type="date"
          readOnly={readOnly}
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
        disabled={saving}
        idPrefix="profile"
        onSameAsPhysicalChange={setSameAsPhysical}
        onValuesChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
        readOnly={readOnly}
        required
        sameAsPhysical={sameAsPhysical}
        values={form}
      />

      {showSubmitButton ? (
        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saving ? "Saving..." : submitLabel}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
