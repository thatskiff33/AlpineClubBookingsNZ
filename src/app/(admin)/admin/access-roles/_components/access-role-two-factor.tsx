"use client";

/**
 * The access-role two-factor choice (#4618): Default, Required or Not
 * required, stored as `requiresTwoFactor` null/true/false. Split out of
 * `access-role-manager.tsx` so that component does not grow (function-length
 * ratchet, #4927). Every piece renders nothing, or sends nothing, until the
 * officer sign-in release is on.
 */
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { OFFICER_SIGN_IN_ENFORCED } from "@/lib/officer-sign-in-switch";
import { isOfficerTwoFactorRequired } from "@/lib/second-factor-enrolment";

export type TwoFactorChoice = "default" | "required" | "not-required";

const TWO_FACTOR_CHOICE_LABELS: Record<TwoFactorChoice, string> = {
  default: "Default",
  required: "Required",
  "not-required": "Not required",
};

export function twoFactorChoiceFromStored(
  value: boolean | null | undefined,
): TwoFactorChoice {
  if (value === true) return "required";
  if (value === false) return "not-required";
  return "default";
}

function storedFromTwoFactorChoice(choice: TwoFactorChoice): boolean | null {
  if (choice === "required") return true;
  if (choice === "not-required") return false;
  return null;
}

/**
 * The request-body fragment for a role save. Sent only once the officer
 * sign-in release is on, so an inert build never writes the column.
 */
export function twoFactorRoleBody(
  choice: TwoFactorChoice,
): { requiresTwoFactor?: boolean | null } {
  return OFFICER_SIGN_IN_ENFORCED
    ? { requiresTwoFactor: storedFromTwoFactorChoice(choice) }
    : {};
}

/** What Default means for this role, from the one officer rule. */
function defaultTwoFactorSummary(permissions: AdminPermissionMatrix): string {
  const required = isOfficerTwoFactorRequired({
    releaseEnabled: true,
    policyEnabled: true,
    kiosk: false,
    assignments: [
      {
        role: null,
        requiresTwoFactor: null,
        financeLevel: permissions.finance.toUpperCase(),
        supportLevel: permissions.support.toUpperCase(),
      },
    ],
  });
  return required
    ? "required, because this role can edit Finance or Support & System"
    : "not required";
}

/** The built-in roles note's officer sentence, or nothing while inert. */
export const BUILT_IN_ROLES_TWO_FACTOR_NOTE = OFFICER_SIGN_IN_ENFORCED
  ? " Full Admins always need an authenticator app or a passkey while the club's officer two-factor policy is on; the lodge kiosk never does."
  : null;

/** The role list's "Two-factor:" line. */
export function RoleTwoFactorSummary({
  role,
}: {
  role: { requiresTwoFactor?: boolean | null; permissions: AdminPermissionMatrix };
}) {
  if (!OFFICER_SIGN_IN_ENFORCED) return null;
  const { requiresTwoFactor, permissions } = role;
  return (
    <p className="text-xs text-muted-foreground">
      Two-factor:{" "}
      {requiresTwoFactor === true
        ? "Required"
        : requiresTwoFactor === false
          ? "Not required"
          : `Default (${defaultTwoFactorSummary(permissions)})`}
    </p>
  );
}

/** The role dialog's two-factor field. */
export function RoleTwoFactorField({
  value,
  permissions,
  onChange,
}: {
  value: TwoFactorChoice;
  permissions: AdminPermissionMatrix;
  onChange: (choice: TwoFactorChoice) => void;
}) {
  if (!OFFICER_SIGN_IN_ENFORCED) return null;
  return (
    <div className="space-y-1.5">
      <Label htmlFor="access-role-two-factor">Two-factor</Label>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as TwoFactorChoice)}
      >
        <SelectTrigger id="access-role-two-factor" className="w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(TWO_FACTOR_CHOICE_LABELS) as TwoFactorChoice[]).map(
            (choice) => (
              <SelectItem key={choice} value={choice}>
                {TWO_FACTOR_CHOICE_LABELS[choice]}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Whether holders must use an authenticator app or a passkey. Default is{" "}
        {defaultTwoFactorSummary(permissions)}. Not required drops only this
        role; another role, or Full Admin, can still require it.
      </p>
    </div>
  );
}
