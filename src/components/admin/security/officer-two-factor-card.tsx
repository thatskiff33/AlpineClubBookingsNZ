"use client";

import { Loader2, ShieldCheck } from "lucide-react";
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
import { useSectionEditState } from "@/hooks/use-section-edit-state";
import { apiErrorMessageFromBody } from "@/lib/api-error-message";
import {
  OFFICER_TWO_FACTOR_GRACE_MAX_DAYS,
  OFFICER_TWO_FACTOR_GRACE_MIN_DAYS,
} from "@/lib/officer-two-factor-grace";

type PolicyDraft = {
  officerTwoFactorPolicy: boolean;
  officerTwoFactorGraceDays: number;
};

/**
 * The officer second-factor policy (#4618). Full Admins save. Anyone else who
 * can open Login & Security sees the card and cannot change it.
 */
export function OfficerTwoFactorCard({ canEdit }: { canEdit: boolean }) {
  const section = useSectionEditState<PolicyDraft>({
    successMessage: "Officer two-factor policy saved.",
    isValid: (draft) =>
      Number.isInteger(draft.officerTwoFactorGraceDays) &&
      draft.officerTwoFactorGraceDays >= OFFICER_TWO_FACTOR_GRACE_MIN_DAYS &&
      draft.officerTwoFactorGraceDays <= OFFICER_TWO_FACTOR_GRACE_MAX_DAYS,
    load: async (signal) => {
      const response = await fetch("/api/admin/security/officer-two-factor", {
        credentials: "same-origin",
        signal,
      });
      if (!response.ok) {
        throw new Error("Could not load the officer two-factor policy.");
      }
      const body = (await response.json()) as PolicyDraft;
      return {
        officerTwoFactorPolicy: body.officerTwoFactorPolicy === true,
        officerTwoFactorGraceDays: body.officerTwoFactorGraceDays,
      };
    },
    save: async (draft) => {
      const response = await fetch("/api/admin/security/officer-two-factor", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          apiErrorMessageFromBody(body, "Could not save the officer two-factor policy."),
        );
      }
      const saved = (await response.json()) as PolicyDraft;
      return {
        officerTwoFactorPolicy: saved.officerTwoFactorPolicy === true,
        officerTwoFactorGraceDays: saved.officerTwoFactorGraceDays,
      };
    },
  });

  const draft = section.draft;
  const editing = section.editing && canEdit;

  return (
    <Card {...section.sectionRegionProps}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div>
              <CardTitle {...section.titleProps} className="text-base">
                Officer two-factor
              </CardTitle>
              <CardDescription className="mt-1">
                Full Admins, and officers whose role can edit Finance or Support
                &amp; System, use an authenticator app or a passkey. An emailed
                code does not count. They get this many days to set one up the
                first time the requirement reaches them.
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
      <CardContent className="space-y-4">
        <AdminViewOnlySectionBanner canEdit={canEdit} />
        {section.error ? (
          <p role="alert" className="text-sm text-destructive">
            {section.error}
          </p>
        ) : null}
        {section.success ? (
          <p role="status" className="text-sm text-muted-foreground">
            {section.success}
          </p>
        ) : null}
        {section.loading && !draft ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : draft ? (
          <>
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                id="officer-two-factor-policy"
                checked={draft.officerTwoFactorPolicy}
                disabled={!editing || section.saving}
                onCheckedChange={(checked) =>
                  section.setDraft({
                    ...draft,
                    officerTwoFactorPolicy: checked,
                  })
                }
              />
              <Label htmlFor="officer-two-factor-policy" className="font-normal">
                Require an authenticator app or a passkey for those officers
              </Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="officer-two-factor-grace">Grace period (days)</Label>
              <Input
                id="officer-two-factor-grace"
                type="number"
                inputMode="numeric"
                min={OFFICER_TWO_FACTOR_GRACE_MIN_DAYS}
                max={OFFICER_TWO_FACTOR_GRACE_MAX_DAYS}
                value={draft.officerTwoFactorGraceDays}
                disabled={!editing || section.saving}
                onChange={(event) =>
                  section.setDraft({
                    ...draft,
                    officerTwoFactorGraceDays: Number(event.target.value),
                  })
                }
                className="max-w-[8rem]"
              />
              <p className="text-xs text-muted-foreground">
                A whole number from {OFFICER_TWO_FACTOR_GRACE_MIN_DAYS} to{" "}
                {OFFICER_TWO_FACTOR_GRACE_MAX_DAYS}. Zero means the next sign-in
                goes straight to set-up.
              </p>
            </div>
            {editing ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void section.save()}
                  disabled={section.saving || !section.valid}
                >
                  {section.saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={section.cancelEditing}
                  disabled={section.saving}
                >
                  Cancel
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
