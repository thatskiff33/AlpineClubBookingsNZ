"use client";

import type { ChangeEvent } from "react";
import { FieldHint, describedByFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/*
  #2264 — the phone row is three boxes sharing ONE example. Greyed "64", "27"
  and "123 4567" inside them read as a number the application already carries.
  A grouped micro-input row gets a single hint that all three boxes point at,
  which is `describedByFieldHint` rather than `useFieldHint`: one hook owes
  exactly one `fieldProps` spread, and this row needs the same id three times.
  The boxes keep their `aria-label`s — those are their accessible NAME, and the
  hint only describes them.

  #4947 — the row's error works the same way: one message under the row, which
  all three boxes point at and all three mark invalid, whichever box the
  browser or the server refused.
*/
const PHONE_HINT_ID = "join-apply-phone-hint";
const PHONE_ERROR_ID = "join-apply-phone-error";

export type PhoneField = "phoneCountryCode" | "phoneAreaCode" | "phoneNumber";

const PHONE_BOXES: ReadonlyArray<{
  field: PhoneField;
  label: string;
  className: string;
}> = [
  { field: "phoneCountryCode", label: "Phone country code", className: "w-20" },
  { field: "phoneAreaCode", label: "Phone area code", className: "w-20" },
  { field: "phoneNumber", label: "Phone number", className: "flex-1" },
];

export function JoinApplyPhoneRow({
  values,
  error,
  onFieldChange,
}: {
  values: Readonly<Record<PhoneField, string>>;
  /** The first message any of the three boxes has, if any. */
  error: string | undefined;
  onFieldChange: (field: PhoneField) => (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const describedBy = describedByFieldHint(PHONE_HINT_ID, error && PHONE_ERROR_ID);
  return (
    <div className="space-y-2">
      <Label>Phone</Label>
      <div className="flex gap-2">
        {PHONE_BOXES.map(({ field, label, className }) => (
          <Input
            key={field}
            id={field}
            className={className}
            value={values[field]}
            onChange={onFieldChange(field)}
            aria-label={label}
            aria-invalid={!!error}
            aria-describedby={describedBy}
          />
        ))}
      </div>
      {error && (
        <p id={PHONE_ERROR_ID} className="text-xs text-destructive">
          {error}
        </p>
      )}
      <FieldHint id={PHONE_HINT_ID}>
        Country code, area code, and number. Example: 64 27 123 4567
      </FieldHint>
    </div>
  );
}
