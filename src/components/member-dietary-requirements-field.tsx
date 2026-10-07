"use client";

import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DIETARY_REQUIREMENTS_LABEL,
  DIETARY_REQUIREMENTS_MAX_LENGTH,
} from "@/lib/member-dietary-field";

/**
 * Who can see the value, said in each audience's own words (`INV-PRIV-022`).
 * Since #3029 a profile value is also COPIED onto each new booking the member is
 * added to, where booking officers and the hut leader running that stay see it,
 * so the profile hints say so rather than promise a narrower audience.
 */
const DIETARY_FIELD_HINTS = {
  self: "Optional. Any dietary needs or allergies the club should know about. Only you and the club's membership administrators can see it on your profile; when you are added to a booking it is copied to that stay, where the club's booking officers and the hut leader running the stay can see it. It is never sent to Xero.",
  admin: "Optional. Visible to the member and to membership administrators, and copied to each new booking the member joins, where booking officers and that stay's hut leader see it; never sent to Xero.",
  booking: "For this stay only: changing it here never changes the member's profile. Visible to booking officers and to the hut leader running the stay; never sent to Xero, emails or reports.",
} as const;

/**
 * The one dietary/allergy input (#2941, `INV-PRIV-022`), shared by the member's
 * own profile and onboarding, by the admin member editors and (#3029) by the
 * booking's per-stay editor, so the label, the limit and the privacy sentence
 * cannot drift between screens. The parent only
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
  /**
   * Whose words the hint speaks: the member about themself, a membership admin
   * about a member's profile, or a booking admin about one stay's value (#3029).
   */
  audience: "self" | "admin" | "booking";
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
        {DIETARY_FIELD_HINTS[audience]}{" "}
        Up to {DIETARY_REQUIREMENTS_MAX_LENGTH} characters.
      </FieldHint>
    </div>
  );
}
