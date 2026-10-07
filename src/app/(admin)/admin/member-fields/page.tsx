"use client";

import { useMemo, useRef } from "react";
import { Loader2, Pencil, RefreshCw, Save, UserCog } from "lucide-react";
import { BackLink } from "@/components/admin/back-link";
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
import {
  DEFAULT_MEMBER_FIELDS_SETTINGS,
  MEMBER_FIELD_DEFINITIONS,
  MEMBER_FIELD_KEYS,
  type MemberFieldKey,
  type MemberFieldsSettingsValues,
} from "@/config/member-fields";
import {
  useActionAttention,
  useRevealAttention,
} from "@/hooks/use-scroll-to-feedback";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { apiErrorMessageFromBody } from "@/lib/api-error-message";

interface FieldsResponse {
  settings: MemberFieldsSettingsValues;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

const ENDPOINT = "/api/admin/member-fields";

/**
 * Every key the route knows, taken from the response and never from a draft
 * spread, so the PUT body is always exactly the route's strict schema.
 */
function toDraft(settings: Partial<MemberFieldsSettingsValues> | undefined) {
  return Object.fromEntries(
    MEMBER_FIELD_KEYS.map((key) => [
      key,
      settings?.[key] ?? DEFAULT_MEMBER_FIELDS_SETTINGS[key],
    ]),
  ) as MemberFieldsSettingsValues;
}

/*
  The canonical settings-section pattern (`docs/ARCHITECTURE.md` →
  "Admin/member layer"), adopted by #2941 when the dietary/allergy toggle
  joined this page: the section loads READ-ONLY, one Edit reveals Save/Cancel,
  no checkbox persists on its own, Cancel restores every box from the snapshot,
  and Save is dirty-gated and re-seeds from the server's response. It is ONE
  section — the four toggles share one row and one strict whole-object PUT —
  so one `useSectionEditState` instance matches storage exactly and no
  fresh-read merge is needed.

  #2934's action-attention rule is kept: a failed save — including the 403 a
  narrowed-permission tab gets — lands in a focused `role="alert"`, and a
  success positions at the top of the page.

  There is no first-save exception. The GET synthesises defaults on a missing
  row, and those defaults ARE the effective settings at every read site, so a
  pristine save would only write an audit row for a change that never happened
  (#2143).
*/
export default function AdminMemberFieldsPage() {
  const pageRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  // Member fields live under the membership area (the write route enforces
  // membership:edit), so gate the editor on that area (#1940).
  const canEdit = useAdminAreaEditAccess("membership");

  const section = useSectionEditState<MemberFieldsSettingsValues>({
    load: async (signal) => {
      const response = await fetch(ENDPOINT, {
        credentials: "same-origin",
        signal,
      });
      const body = (await response.json()) as
        | FieldsResponse
        | { error?: string };
      if (!response.ok || !("settings" in body)) {
        throw new Error(apiErrorMessageFromBody(body, "Failed to load settings"));
      }
      return toDraft(body.settings);
    },
    save: async (draft) => {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: toDraft(draft) }),
      });
      const body = (await response.json().catch(() => ({}))) as
        | FieldsResponse
        | { error?: string };
      if (!response.ok || !("settings" in body)) {
        // A stale tab or narrowed permission maps to the shared forbidden-save
        // copy (#1940), shown in the focused failure below.
        if (response.status === 403) throw new ForbiddenSaveError();
        throw new Error(apiErrorMessageFromBody(body, "Failed to save settings"));
      }
      return toDraft(body.settings);
    },
    successMessage: "Member field settings saved.",
    loadErrorFallback: "Failed to load settings",
    saveErrorFallback: "Failed to save settings",
  });

  const { draft, editing, saving, dirty, error, success } = section;

  // Failure wins, success positions at the top, and neither runs for a
  // passive re-render — the shared action-attention rule (#2934).
  useActionAttention({
    error,
    errorTarget: feedbackRef,
    success,
    successTarget: pageRef,
  });
  // Edit unmounts the button that held focus; bring the section into view
  // only when the admin asked to edit (#2934).
  useRevealAttention(sectionRef, section.editRequestKey);

  const fields = useMemo(
    () => MEMBER_FIELD_KEYS.map((key) => MEMBER_FIELD_DEFINITIONS[key]),
    [],
  );

  function setFieldEnabled(key: MemberFieldKey, enabled: boolean) {
    section.setDraft({ [key]: enabled } as Partial<MemberFieldsSettingsValues>);
  }

  /*
    #2160: the view-only explanation lives here, once, as the FIRST child of the
    outermost wrapper in EVERY branch — announced on arrival and ahead of the
    controls it explains — instead of on each disabled button below. The
    `role="status"` wrapper is permanently mounted so the live region is
    registered in the accessibility tree before its content appears.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view member fields but cannot change them.
      Membership edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (section.loading && !draft) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-6">
          <BackLink href="/admin/membership-setup" label="Membership & Members" />
          <div className="flex min-h-[320px] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div ref={pageRef} className="space-y-8">
        <BackLink href="/admin/membership-setup" label="Membership & Members" />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Member fields</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Choose which optional member fields the club collects and displays.
              Turn a field off to avoid collecting data the club does not need.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void section.reload()}
              disabled={section.loading || saving || editing}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            {!editing ? (
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                type="button"
                variant="outline"
                aria-label="Edit member fields"
                onClick={section.startEditing}
                disabled={draft === null}
              >
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </ViewOnlyActionButton>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={section.cancelEditing}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  type="button"
                  onClick={() => void section.save()}
                  disabled={!dirty || saving || draft === null}
                >
                  {saving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  Save
                </ViewOnlyActionButton>
              </>
            )}
          </div>
        </div>

        {(error || success) && (
          <div
            ref={feedbackRef}
            role={error ? "alert" : "status"}
            tabIndex={error ? -1 : undefined}
            className={
              error
                ? "scroll-mt-20 rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11 focus:outline-none"
                : "rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11"
            }
          >
            {error || success}
          </div>
        )}

        <div className="rounded-md border border-border bg-card px-4 py-3">
          <div className="flex items-start gap-3">
            <UserCog className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              When a field is off it is hidden from the member editor, member
              onboarding and profile, and is excluded from CSV import and export.
              Existing data already stored is not deleted. Dietary/allergy
              information is privacy-sensitive: when it is on, a profile value
              is seen only by the member themself and membership administrators
              (the member CSV export then contains it), and each new booking
              keeps its own copy for that stay, seen only by booking officers
              and the hut leader running the stay.
            </p>
          </div>
        </div>

        <div ref={sectionRef} className="grid gap-4 xl:grid-cols-2">
          {fields.map((field) => {
            const checkboxId = `member-field-${field.key}`;
            const enabled = draft?.[field.key] ?? false;

            return (
              <Card key={field.key}>
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id={checkboxId}
                      checked={enabled}
                      onCheckedChange={(checked) =>
                        setFieldEnabled(field.key, checked === true)
                      }
                      disabled={!editing || saving || !canEdit}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-base">
                          <label htmlFor={checkboxId}>{field.label}</label>
                        </CardTitle>
                        <Badge variant={enabled ? "success" : "secondary"}>
                          {enabled ? "On" : "Off"}
                        </Badge>
                      </div>
                      <CardDescription className="mt-1">
                        {field.description}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent />
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
