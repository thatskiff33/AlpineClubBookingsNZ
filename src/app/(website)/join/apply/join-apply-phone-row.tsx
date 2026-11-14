"use client";

import type { ChangeEvent } from "react";
import { FieldHint, describedByFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { memberFieldLabel } from "@/lib/format-validation-errors";
import { JOIN_APPLY_INPUT_IDS } from "./join-apply-input-ids";

/*
  #2264 — the phone row is three boxes sharing ONE example. Greyed "64", "27"
  and "123 4567" inside them read as a number the application already carries.
  A grouped micro-input row gets a single hint that all three boxes point at,
  which is `describedByFieldHint` rather than `useFieldHint`: one hook owes
  exactly one `fieldProps` spread, and this row needs the same id three times.
  The boxes keep their `aria-label`s — those are their accessible NAME, and the
  hint only describes them.

  #4947 — the row's error works the same way: one message under the row, which
  all three boxes point at and all three mark invalid. It names the box it is
  about, since a bare "Too big: expected string to have <=5 characters" fits two
  of them. The names are the ones the summary uses (`memberFieldLabel`).
*/
const PHONE_HINT_ID = "join-apply-phone-hint";
const PHONE_ERROR_ID = "join-apply-phone-error";

type PhoneField = "phoneCountryCode" | "phoneAreaCode" | "phoneNumber";

const PHONE_BOXES = (
  [
    { field: "phoneCountryCode", className: "w-20" },
    { field: "phoneAreaCode", className: "w-20" },
    { field: "phoneNumber", className: "flex-1" },
  ] as const satisfies ReadonlyArray<{ field: PhoneField; className: string }>
).map(({ field, className }) => ({
  field,
  className,
  label: memberFieldLabel(field),
}));

export function JoinApplyPhoneRow({
  values,
  errors,
  onFieldChange,
}: {
  values: Readonly<Record<PhoneField, string>>;
  errors: Readonly<Partial<Record<PhoneField, string>>>;
  onFieldChange: (field: PhoneField) => (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const failing = PHONE_BOXES.find(({ field }) => errors[field]);
  const error = failing && `${failing.label}: ${errors[failing.field]}`;
  const describedBy = describedByFieldHint(PHONE_HINT_ID, error && PHONE_ERROR_ID);
  return (
    <div className="space-y-2">
      <Label>Phone</Label>
      <div className="flex gap-2">
        {PHONE_BOXES.map(({ field, label, className }) => (
          <Input
            key={field}
            id={JOIN_APPLY_INPUT_IDS[field]}
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
