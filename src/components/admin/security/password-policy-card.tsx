"use client";

import { KeyRound, Loader2, RefreshCw, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import {
  MIN_PASSWORD_LENGTH_CEILING,
  MIN_PASSWORD_LENGTH_FLOOR,
} from "@/lib/password-policy";
import {
  KIOSK_SESSION_MAX_AGE_HOURS,
  SESSION_MAX_AGE_DEFAULT_HOURS,
  SESSION_MAX_AGE_MAX_HOURS,
  SESSION_MAX_AGE_MIN_HOURS,
} from "@/lib/session-max-age";
import { apiErrorMessageFromBody } from "@/lib/api-error-message";

// Self-contained password-policy card for the Login & Security page (epic #2030,
// child #2033; edit-gated in #2103). Kept fully independent — it loads and saves
// its own state via /api/admin/security/password-policy — so the sibling
// magic-link (#2034) and Google (#2035) cards can be dropped onto the page with
// no churn here. It follows the canonical settings-section pattern: read-only on
// load, per-section Edit → Save/Cancel, Cancel reverts to the saved snapshot,
// and Refresh is hidden while editing.

// The four configurable character-class requirements, in display order.
const CLASS_FIELDS = [
  { key: "requireUppercase", label: "Require an uppercase letter (A–Z)" },
  { key: "requireLowercase", label: "Require a lowercase letter (a–z)" },
  { key: "requireDigit", label: "Require a number (0–9)" },
  { key: "requireSymbol", label: "Require a symbol (e.g. ! ? # $)" },
] as const;

type ClassField = (typeof CLASS_FIELDS)[number]["key"];

interface PolicyDraft {
  minPasswordLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  breachedPasswordCheck: boolean;
  sessionMaxAgeHours: number;
}

interface SettingsResponse {
  policy: PolicyDraft & { magicLinkTtlMinutes: number };
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

function toDraft(policy: SettingsResponse["policy"]): PolicyDraft {
  return {
    minPasswordLength: policy.minPasswordLength,
    requireUppercase: policy.requireUppercase,
    requireLowercase: policy.requireLowercase,
    requireDigit: policy.requireDigit,
    requireSymbol: policy.requireSymbol,
    breachedPasswordCheck: policy.breachedPasswordCheck,
    sessionMaxAgeHours: policy.sessionMaxAgeHours,
  };
}

function isMinLengthValid(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_PASSWORD_LENGTH_FLOOR &&
    value <= MIN_PASSWORD_LENGTH_CEILING
  );
}

// #4611 (INV-AUTH-007): the same bounds the route refuses outside.
function isSessionMaxAgeValid(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= SESSION_MAX_AGE_MIN_HOURS &&
    value <= SESSION_MAX_AGE_MAX_HOURS
  );
}

function describeHours(hours: number): string {
  if (hours % 24 !== 0) return `${hours} hours`;
  const days = hours / 24;
  return days === 1 ? "1 day" : `${days} days`;
}

export function PasswordPolicyCard() {
  const canEdit = useAdminAreaEditAccess("support");

  const section = useSectionEditState<PolicyDraft>({
    load: async (signal) => {
      const response = await fetch("/api/admin/security/password-policy", {
        credentials: "same-origin",
        signal,
      });
      const body = (await response.json()) as SettingsResponse | { error?: string };
      if (!response.ok || !("policy" in body)) {
        throw new Error(apiErrorMessageFromBody(body, "Failed to load password policy"));
      }
      return toDraft(body.policy);
    },
    save: async (draft) => {
      const response = await fetch("/api/admin/security/password-policy", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await response.json()) as SettingsResponse | { error?: string };
      if (!response.ok || !("policy" in body)) {
        if (response.status === 403) throw new ForbiddenSaveError();
        throw new Error(apiErrorMessageFromBody(body, "Failed to save password policy"));
      }
      return toDraft(body.policy);
    },
    successMessage: "Password policy saved.",
    saveErrorFallback: "Failed to save password policy",
    loadErrorFallback: "Failed to load password policy",
    isValid: (draft) =>
      isMinLengthValid(draft.minPasswordLength) &&
      isSessionMaxAgeValid(draft.sessionMaxAgeHours),
  });

  const { draft, loading, saving, editing, dirty, error } = section;
  const savedMessage = section.success;
  const formValid = section.valid;
  const minLengthValid = draft ? isMinLengthValid(draft.minPasswordLength) : true;
  const sessionMaxAgeValid = draft
    ? isSessionMaxAgeValid(draft.sessionMaxAgeHours)
    : true;

  function cancelEditing() {
    section.cancelEditing();
    section.setError("");
    section.setSuccess("");
  }

  function setClass(key: ClassField, value: boolean) {
    section.setDraft({ [key]: value } as Partial<PolicyDraft>);
    section.setSuccess("");
  }

  function setBreachedPasswordCheck(value: boolean) {
    section.setDraft({ breachedPasswordCheck: value });
    section.setSuccess("");
  }

  function setSessionMaxAgeHours(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    section.setDraft({ sessionMaxAgeHours: Number.isNaN(parsed) ? 0 : parsed });
    section.setSuccess("");
  }

  function setMinLength(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    section.setDraft({ minPasswordLength: Number.isNaN(parsed) ? 0 : parsed });
    section.setSuccess("");
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. It sits OUTSIDE the `space-y-4`
    stack so the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view login &amp; security settings but cannot change
      them. Support edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <Card {...section.sectionRegionProps}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <CardTitle {...section.titleProps} className="text-base">Password policy</CardTitle>
              <CardDescription className="mt-1">
                Set the minimum length and required character types for member
                passwords. Rules apply the next time a member sets or changes their
                password; existing passwords keep working. To force everyone onto
                the new rules, use the &ldquo;require password change&rdquo; option
                on the member record. You can also set how long anyone stays
                signed in.
              </CardDescription>
            </div>
          </div>
          {!editing && draft ? (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              type="button"
              onClick={section.startEditing}
              {...section.editTriggerProps}
            >
              Edit
            </ViewOnlyActionButton>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {viewOnlyBanner}
        <div className="space-y-4">
        {(error || savedMessage) && (
          <div
            role={error ? "alert" : "status"}
            className={
              error
                ? "rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11"
                : "rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11"
            }
          >
            {error || savedMessage}
          </div>
        )}

        {loading && draft === null ? (
          <div className="flex min-h-[160px] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : draft ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="min-password-length">Minimum password length</Label>
              <Input
                id="min-password-length"
                type="number"
                inputMode="numeric"
                min={MIN_PASSWORD_LENGTH_FLOOR}
                max={MIN_PASSWORD_LENGTH_CEILING}
                value={draft.minPasswordLength}
                onChange={(event) => setMinLength(event.target.value)}
                disabled={!editing || saving}
                className="max-w-[8rem]"
                aria-describedby="min-password-length-hint"
              />
              <p id="min-password-length-hint" className="text-xs text-muted-foreground">
                Between {MIN_PASSWORD_LENGTH_FLOOR} and {MIN_PASSWORD_LENGTH_CEILING}{" "}
                characters. A hard maximum of 128 characters always applies.
              </p>
              {!minLengthValid ? (
                <p className="text-xs text-destructive">
                  Enter a whole number between {MIN_PASSWORD_LENGTH_FLOOR} and{" "}
                  {MIN_PASSWORD_LENGTH_CEILING}.
                </p>
              ) : null}
            </div>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-muted-foreground">
                Required character types
              </legend>
              {CLASS_FIELDS.map(({ key, label }) => {
                const checkboxId = `password-${key}`;
                return (
                  <div key={key} className="flex items-center gap-3">
                    <Checkbox
                      id={checkboxId}
                      checked={draft[key]}
                      onCheckedChange={(checked) => setClass(key, checked === true)}
                      disabled={!editing || saving}
                    />
                    <Label htmlFor={checkboxId} className="font-normal">
                      {label}
                    </Label>
                    <Badge variant={draft[key] ? "success" : "secondary"}>
                      {draft[key] ? "On" : "Off"}
                    </Badge>
                  </div>
                );
              })}
            </fieldset>

            {/*
              #4610 (INV-AUTH-006): the breached-password check. Staged with the
              rest of the card and saved through the same PUT.
            */}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-muted-foreground">
                Breached passwords
              </legend>
              <div className="flex items-center gap-3">
                <Checkbox
                  id="password-breachedPasswordCheck"
                  checked={draft.breachedPasswordCheck}
                  onCheckedChange={(checked) => setBreachedPasswordCheck(checked === true)}
                  disabled={!editing || saving}
                  aria-describedby="password-breachedPasswordCheck-hint"
                />
                <Label htmlFor="password-breachedPasswordCheck" className="font-normal">
                  Refuse passwords found in public data breaches
                </Label>
                <Badge variant={draft.breachedPasswordCheck ? "success" : "secondary"}>
                  {draft.breachedPasswordCheck ? "On" : "Off"}
                </Badge>
              </div>
              <p
                id="password-breachedPasswordCheck-hint"
                className="text-xs text-muted-foreground"
              >
                When someone sets a password, it is checked against a public
                list of leaked passwords. Only the first 5 characters of a
                one-way code made from the password are sent, never the password
                itself. If the service does not answer within 3 seconds, the
                password is accepted.
              </p>
            </fieldset>

            {/*
              #4611 (INV-AUTH-007): the maximum session age. Staged with the
              rest of the card and saved through the same PUT.
            */}
            <div className="space-y-2">
              <Label htmlFor="session-max-age-hours">
                Sign members out after (hours)
              </Label>
              <Input
                id="session-max-age-hours"
                type="number"
                inputMode="numeric"
                min={SESSION_MAX_AGE_MIN_HOURS}
                max={SESSION_MAX_AGE_MAX_HOURS}
                value={draft.sessionMaxAgeHours}
                onChange={(event) => setSessionMaxAgeHours(event.target.value)}
                disabled={!editing || saving}
                className="max-w-[8rem]"
                aria-describedby="session-max-age-hours-hint"
              />
              <p id="session-max-age-hours-hint" className="text-xs text-muted-foreground">
                {sessionMaxAgeValid
                  ? `Currently ${describeHours(draft.sessionMaxAgeHours)}. `
                  : null}
                Everyone must sign in again this long after they last signed
                in, however much they use the site. Between{" "}
                {SESSION_MAX_AGE_MIN_HOURS} hours and {SESSION_MAX_AGE_MAX_HOURS}{" "}
                hours ({describeHours(SESSION_MAX_AGE_MAX_HOURS)}); the default
                is {SESSION_MAX_AGE_DEFAULT_HOURS} hours (
                {describeHours(SESSION_MAX_AGE_DEFAULT_HOURS)}). A change applies
                to people already signed in. The lodge kiosk account keeps its
                own {describeHours(KIOSK_SESSION_MAX_AGE_HOURS)}.
              </p>
              {!sessionMaxAgeValid ? (
                <p className="text-xs text-destructive">
                  Enter a whole number of hours between {SESSION_MAX_AGE_MIN_HOURS}{" "}
                  and {SESSION_MAX_AGE_MAX_HOURS}.
                </p>
              ) : null}
            </div>

            {editing && dirty ? (
              <p className="text-sm text-warning-11" role="status">
                You have unsaved changes.
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2 pt-2">
              {editing ? (
                <>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    type="button"
                    onClick={() => void section.save()}
                    disabled={!dirty || saving || !formValid}
                  >
                    {saving ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    Save
                  </ViewOnlyActionButton>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={cancelEditing}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void section.reload()}
                  disabled={loading || saving}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh
                </Button>
              )}
            </div>
          </>
        ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
