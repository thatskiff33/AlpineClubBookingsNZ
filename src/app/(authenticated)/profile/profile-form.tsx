"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { MemberAddressFields } from "@/components/member-address-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldHint, describedByFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  shouldDefaultPostalSameAsPhysical,
  withDefaultNzCountry,
} from "@/lib/member-address";
import { useClubTime } from "@/components/club-time-provider";
import { getSafeInternalReturnPath } from "@/lib/internal-return-path";

/*
  #2264 — the phone row is three boxes but ONE example: a greyed "64", "27" and
  "123 4567" sitting inside them read as a number the profile already holds. A
  grouped micro-input row therefore gets a single hint, and all three boxes point
  at it. That is `describedByFieldHint`, not `useFieldHint`: one hook would owe
  exactly one `fieldProps` spread, and this row needs the same id on three
  controls. The id is a constant, spelled once, so no box can drift off it. It is
  static like the form's other ids (firstName, lastName, dateOfBirth).
*/
const PHONE_HINT_ID = "profile-phone-hint";
const PHONE_DESCRIBED_BY = describedByFieldHint(PHONE_HINT_ID);

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
    occupation?: string;
    lodgeScreenPhoneOptIn?: boolean;
  };
  editable?: boolean;
  formId?: string;
  onSaved?: () => void;
  onSavingChange?: (saving: boolean) => void;
  returnTo?: string | null;
  showSubmitButton?: boolean;
  submitLabel?: string;
  ageTier?: string;
  showOccupation?: boolean;
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
  ageTier,
  showOccupation = false,
}: ProfileFormProps) {
  const router = useRouter();
  /*
    The date-of-birth field's upper bound is the CLUB'S TODAY (CT-4, #2870;
    epic #2988; INV-CONFIG-002) — the persisted `ClubTimeSettings.timeZone`,
    delivered to this browser as data by `ClubTimeProvider`. It used to be
    `todayDateOnlyForTimeZone()`, which reads `APP_TIME_ZONE` — the container's
    `TZ` — and never the browser's clock, so the shape is unchanged and only the
    authority moved. It must not become the VIEWER's today either: a member
    filling this in from London would otherwise be offered a bound the server
    guard behind `/api/profile` (which compares against the club's day) does not
    agree with.
  */
  const clubTime = useClubTime();
  const safeReturnTo = getSafeInternalReturnPath(returnTo);
  // Occupation is collected for adults only, and only when the club has the
  // showOccupation field enabled.
  const showOccupationField = showOccupation && ageTier === "ADULT";
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
    occupation: member.occupation ?? "",
    lodgeScreenPhoneOptIn: member.lodgeScreenPhoneOptIn ?? false,
  });
  const [sameAsPhysical, setSameAsPhysical] = useState(() =>
    shouldDefaultPostalSameAsPhysical({
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
    }),
  );
  const [saving, setSaving] = useState(false);
  const readOnly = !editable;
  const readOnlyInputClassName = readOnly
    ? "bg-muted text-foreground shadow-none focus-visible:ring-0"
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
              required
              maxLength={5}
              aria-label="Country code"
              aria-describedby={PHONE_DESCRIBED_BY}
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
              required
              maxLength={5}
              aria-label="Area code"
              aria-describedby={PHONE_DESCRIBED_BY}
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
              required
              maxLength={15}
              aria-label="Phone number"
              aria-describedby={PHONE_DESCRIBED_BY}
            />
          </div>
        </div>
        <FieldHint id={PHONE_HINT_ID}>
          Country code, area code, and number. Example: 64 27 123 4567. Synced
          with Xero.
        </FieldHint>
      </div>

      {ageTier === "ADULT" ? (
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <Checkbox
              id="lodgeScreenPhoneOptIn"
              className="mt-0.5"
              disabled={saving || readOnly}
              checked={form.lodgeScreenPhoneOptIn}
              onCheckedChange={(checked) => {
                if (readOnly) return;
                setForm((prev) => ({ ...prev, lodgeScreenPhoneOptIn: checked }));
              }}
            />
            <Label htmlFor="lodgeScreenPhoneOptIn" className="font-normal">
              Show my phone number on the lodge lobby display
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Off by default. When your lodge turns on phone display, opting in
            lets your number appear on the public lobby screen so other guests
            can reach you. Lodge staff can still see it at check-in either way.
          </p>
        </div>
      ) : null}

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
          max={clubTime.today()}
          required
        />
        <p className="text-xs text-muted-foreground">
          Used to determine your membership age tier (Adult / Youth / Child / Infant).
        </p>
      </div>

      {showOccupationField ? (
        <div className="space-y-2">
          <Label htmlFor="occupation">Occupation</Label>
          <Input
            className={readOnlyInputClassName}
            disabled={saving}
            id="occupation"
            name="occupation"
            readOnly={readOnly}
            value={form.occupation}
            onChange={handleChange}
            maxLength={100}
          />
          <p className="text-xs text-muted-foreground">
            Optional. Your occupation for club records.
          </p>
        </div>
      ) : null}

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
