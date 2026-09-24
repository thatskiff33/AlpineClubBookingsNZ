"use client";

import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DIETARY_REQUIREMENTS_LABEL,
  DIETARY_REQUIREMENTS_MAX_LENGTH,
} from "@/lib/member-dietary-field";

/**
 * The one dietary/allergy input (#2941, `INV-PRIV-022`), shared by the member's
 * own profile and onboarding and by the admin member editors, so the label, the
 * limit and the privacy sentence cannot drift between screens. The parent only
 * renders it while the club has the field ON; it holds no data itself.
 */
export function MemberDietaryRequirementsField({
  id,
  value,
  onChange,
  audience,
  disabled,
  readOnly,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Whose words the hint speaks: the member about themself, or an admin. */
  audience: "self" | "admin";
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
}) {
  const hint = useFieldHint();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{DIETARY_REQUIREMENTS_LABEL}</Label>
      <Textarea
        id={id}
        name="dietaryRequirements"
        className={className}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        readOnly={readOnly}
        maxLength={DIETARY_REQUIREMENTS_MAX_LENGTH}
        rows={3}
        {...hint.fieldProps}
      />
      <FieldHint {...hint.hintProps}>
        {audience === "self"
          ? "Optional. Any dietary needs or allergies the club should know about. Only you and the club's membership administrators can see this, and it is never sent to Xero."
          : "Optional. Visible only to the member and to membership administrators; never sent to Xero."}{" "}
        Up to {DIETARY_REQUIREMENTS_MAX_LENGTH} characters.
      </FieldHint>
    </div>
  );
}
