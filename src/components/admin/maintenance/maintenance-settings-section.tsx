"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";

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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import { apiRefusalFromResponse } from "@/lib/api-error-message";

const LOAD_FALLBACK = "Failed to load these settings";
const SAVE_FALLBACK = "Failed to save";

/**
 * The maintenance-report policy section (#2780). Lodge Operations.
 *
 * Canonical settings-section pattern (docs/ARCHITECTURE.md → "Admin/member
 * layer"): loads read-only, Edit reveals Save/Cancel, Cancel restores the
 * snapshot, Save persists once and re-seeds from the server's response. One
 * `AdminViewOnlySectionBanner`, mounted above the loading state so its live region
 * exists from first paint, and every gated control opts out of its own explanation
 * because the banner states it once.
 *
 * THE ANONYMOUS TOGGLE CARRIES A WARNING RATHER THAN A LABEL, and the wording is
 * deliberate: it is the only control on this page that changes who can reach the
 * application at all. An admin ticking it is opening a door on the public internet,
 * and the copy says so in those terms instead of calling it "enable QR reports".
 */

type Draft = {
  anonymousReportsEnabled: boolean;
  photosEnabled: boolean;
  anonymousPhotosEnabled: boolean;
  photoRetentionDays: number;
  anonymousContactPrompt: boolean;
};

type Payload = { settings: Draft; limits: { photoRetentionDaysMin: number; photoRetentionDaysMax: number } };

const ENDPOINT = "/api/admin/maintenance-reports/settings";

export function MaintenanceSettingsSection({
  moduleEnabled,
}: {
  moduleEnabled: boolean;
}) {
  const canEdit = useAdminAreaEditAccess("lodge");

  const section = useSectionEditState<Draft>({
    load: async (signal) => {
      const res = await fetch(ENDPOINT, { signal });
      if (!res.ok) throw new Error(LOAD_FALLBACK);
      return ((await res.json()) as Payload).settings;
    },
    save: async (draft) => {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError();
        throw await apiRefusalFromResponse(res, SAVE_FALLBACK);
      }
      return ((await res.json()) as { settings: Draft }).settings;
    },
    successMessage: "Maintenance report settings saved",
    loadErrorFallback: LOAD_FALLBACK,
    saveErrorFallback: SAVE_FALLBACK,
    isValid: (draft) =>
      Number.isInteger(draft.photoRetentionDays) &&
      draft.photoRetentionDays >= 1 &&
      draft.photoRetentionDays <= 365,
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

  return (
    <div>
      {viewOnlyBanner}
      {feedback}
      <Card {...section.sectionRegionProps}>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle {...section.titleProps}>How maintenance reports work</CardTitle>
            <CardDescription>
              Photos, how long they are kept, and whether people can report a fault
              from a QR code without signing in.
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
          {!moduleEnabled ? (
            <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              Maintenance reports is switched off, so none of this is in use. You
              can still set it up here; turn the module on under{" "}
              <Link
                href="/admin/modules"
                className="font-medium text-foreground underline"
              >
                Admin › Modules
              </Link>{" "}
              when you are ready.
            </div>
          ) : null}

          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle
                className="mt-0.5 h-5 w-5 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="maintenance-anonymous"
                    checked={draft.anonymousReportsEnabled}
                    disabled={readOnly}
                    onCheckedChange={(checked) =>
                      section.setDraft({ anonymousReportsEnabled: checked === true })
                    }
                  />
                  <Label
                    htmlFor="maintenance-anonymous"
                    className="font-medium leading-snug"
                  >
                    Let people report a fault from a QR code without signing in
                  </Label>
                </div>
                <p className="text-sm text-muted-foreground">
                  This opens a page on the public internet that anybody holding the
                  code can post to. The code is long and unguessable, each lodge has
                  its own, you can replace one at any time, and there are limits on
                  how often it can be used — but it is still a door that does not ask
                  who you are. Leave it off unless you want the printed signs in the
                  lodge to work.
                </p>
                <p className="text-sm text-muted-foreground">
                  Nothing about anybody&apos;s account is readable or changeable from
                  that page. All somebody can do with the code is report a fault at
                  that one lodge.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <Checkbox
                id="maintenance-photos"
                checked={draft.photosEnabled}
                disabled={readOnly}
                onCheckedChange={(checked) =>
                  section.setDraft({ photosEnabled: checked === true })
                }
              />
              <Label htmlFor="maintenance-photos" className="leading-snug">
                Allow a photo to be attached to a report
              </Label>
            </div>
            <div className="flex items-start gap-2 pl-6">
              <Checkbox
                id="maintenance-anon-photos"
                checked={draft.anonymousPhotosEnabled}
                // Meaningless while photos are off entirely, so it is disabled
                // rather than left looking effective.
                disabled={readOnly || !draft.photosEnabled}
                onCheckedChange={(checked) =>
                  section.setDraft({ anonymousPhotosEnabled: checked === true })
                }
              />
              <Label htmlFor="maintenance-anon-photos" className="leading-snug">
                Allow a photo from the QR code too
                <span className="block text-xs font-normal text-muted-foreground">
                  Turn this off to keep photos from members only.
                </span>
              </Label>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="maintenance-retention">
              Delete photos after this many days
            </Label>
            <Input
              id="maintenance-retention"
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              className="max-w-[10rem]"
              value={draft.photoRetentionDays}
              disabled={readOnly}
              onChange={(event) =>
                section.setDraft({
                  photoRetentionDays: Number.parseInt(event.target.value, 10) || 0,
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Between 1 and 365. The report itself is kept for ever — only the photo
              is removed, so &quot;the pump failed twice last winter&quot; is still
              answerable. Changing this affects photos sent from now on; ones already
              submitted keep the window they were sent under.
            </p>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="maintenance-contact-prompt"
              checked={draft.anonymousContactPrompt}
              disabled={readOnly}
              onCheckedChange={(checked) =>
                section.setDraft({ anonymousContactPrompt: checked === true })
              }
            />
            <Label htmlFor="maintenance-contact-prompt" className="leading-snug">
              Ask QR reporters for a name and contact detail
              <span className="block text-xs font-normal text-muted-foreground">
                Always optional for them to fill in, and never checked against your
                membership list.
              </span>
            </Label>
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
