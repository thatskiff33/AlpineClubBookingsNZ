"use client";

import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { PolicyFeedback } from "@/components/admin/booking-policies/policy-feedback";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import {
  FOOD_OFFICER_EMAIL_MAX_LENGTH,
  FOOD_OFFICER_LABEL_MAX_LENGTH,
} from "@/lib/food-order-rules";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";

/**
 * The Food Orders settings card (fork #121). Lodge Operations.
 *
 * Canonical settings-section pattern (docs/ARCHITECTURE.md → "Admin/member
 * layer"): loads read-only, Edit reveals Save/Cancel, Cancel restores the
 * snapshot, Save is dirty-gated and persists once. One
 * `AdminViewOnlySectionBanner`, mounted in every state so its live region exists
 * from first paint, and every gated control opts out of its own explanation.
 *
 * The address is checked by the server only as a valid email (fork #121 owner decision
 * 10). It is not matched against members: keeping it current is the
 * committee's job, and the copy says so.
 */

type Draft = { officerEmail: string; officerLabel: string };
type Settings = { officerEmail: string | null; officerLabel: string };

const ENDPOINT = "/api/admin/food-orders/settings";

function toDraft(settings: Settings): Draft {
  return {
    officerEmail: settings.officerEmail ?? "",
    officerLabel: settings.officerLabel,
  };
}

export function FoodOrderSettingsSection() {
  const canEdit = useAdminAreaEditAccess("lodge");

  const section = useSectionEditState<Draft>({
    load: async (signal) => {
      const res = await fetch(ENDPOINT, { signal });
      if (!res.ok) throw new Error("Failed to load these settings");
      return toDraft(((await res.json()) as { settings: Settings }).settings);
    },
    save: async (draft) => {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          officerEmail: draft.officerEmail.trim(),
          officerLabel: draft.officerLabel.trim(),
        }),
      });
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError();
        throw new Error(
          await apiErrorMessageFromResponse(res, "Failed to save"),
        );
      }
      return toDraft(((await res.json()) as { settings: Settings }).settings);
    },
    successMessage: "Food order settings saved",
    isValid: (draft) =>
      draft.officerLabel.trim().length > 0 &&
      draft.officerLabel.trim().length <= FOOD_OFFICER_LABEL_MAX_LENGTH &&
      draft.officerEmail.trim().length <= FOOD_OFFICER_EMAIL_MAX_LENGTH,
  });

  const { draft, editing, saving, dirty, error, success } = section;

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      You can see these settings but not change them. Ask an administrator with
      Lodge Operations access if something here needs changing.
    </AdminViewOnlySectionBanner>
  );

  const feedback = (
    <PolicyFeedback
      error={error}
      success={success}
      onClearError={() => section.setError("")}
      onClearSuccess={() => section.setSuccess("")}
    />
  );

  if (section.loading || !draft) {
    return (
      <div>
        {viewOnlyBanner}
        {feedback}
        {section.loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading...
          </div>
        ) : null}
      </div>
    );
  }

  const readOnly = !editing;
  const notSetUp = draft.officerEmail.trim() === "";

  return (
    <div>
      {viewOnlyBanner}
      {feedback}
      <Card {...section.sectionRegionProps}>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle {...section.titleProps}>Where food orders go</CardTitle>
            <CardDescription>
              Every new order is emailed to this address, with a link to the
              order.
            </CardDescription>
          </div>
          {!editing && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={section.startEditing}
              {...section.editTriggerProps}
            >
              Edit
            </ViewOnlyActionButton>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {notSetUp && readOnly ? (
            <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              No address is set, so members cannot order yet: the order page
              tells them ordering is not set up.
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="food-officer-email">Email address for orders</Label>
            <Input
              id="food-officer-email"
              type="email"
              autoComplete="off"
              maxLength={FOOD_OFFICER_EMAIL_MAX_LENGTH}
              className="max-w-md"
              value={draft.officerEmail}
              disabled={readOnly}
              onChange={(event) =>
                section.setDraft({ officerEmail: event.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              Usually the food officer&apos;s committee address. It is only
              checked as an email address, so keep it up to date when the role
              changes hands. Leave it empty to stop taking orders.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="food-officer-label">What your club calls them</Label>
            <Input
              id="food-officer-label"
              maxLength={FOOD_OFFICER_LABEL_MAX_LENGTH}
              className="max-w-xs"
              value={draft.officerLabel}
              disabled={readOnly}
              onChange={(event) =>
                section.setDraft({ officerLabel: event.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              Shown on the order page, the history and the email, for example
              &quot;Food officer&quot; or &quot;Catering officer&quot;.
            </p>
          </div>

          {editing ? (
            <div className="flex gap-2">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                onClick={() => void section.save()}
                disabled={!dirty || saving || !section.valid}
              >
                {saving ? "Saving..." : "Save"}
              </ViewOnlyActionButton>
              <Button
                variant="outline"
                onClick={section.cancelEditing}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
