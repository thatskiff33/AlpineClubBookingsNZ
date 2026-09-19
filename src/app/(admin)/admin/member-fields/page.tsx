"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Save, UserCog } from "lucide-react";
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
  MEMBER_FIELD_DEFINITIONS,
  MEMBER_FIELD_KEYS,
  type MemberFieldKey,
  type MemberFieldsSettingsValues,
} from "@/config/member-fields";
import { useActionAttention } from "@/hooks/use-scroll-to-feedback";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { apiErrorMessageFromBody } from "@/lib/api-error-message";

interface FieldsResponse {
  settings: MemberFieldsSettingsValues;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

function cloneSettings(
  settings: MemberFieldsSettingsValues,
): MemberFieldsSettingsValues {
  return Object.fromEntries(
    MEMBER_FIELD_KEYS.map((key) => [key, settings[key]]),
  ) as MemberFieldsSettingsValues;
}

export default function AdminMemberFieldsPage() {
  const [payload, setPayload] = useState<FieldsResponse | null>(null);
  const [draft, setDraft] = useState<MemberFieldsSettingsValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  // Member fields live under the membership area (the write route enforces
  // membership:edit), so gate the editor on that area (#1940).
  const canEdit = useAdminAreaEditAccess("membership");

  async function loadSettings() {
    setLoading(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/member-fields", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as
        | FieldsResponse
        | { error?: string };
      if (!response.ok || !("settings" in body)) {
        throw new Error(apiErrorMessageFromBody(body, "Failed to load settings"));
      }
      setPayload(body);
      setDraft(cloneSettings(body.settings));
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load settings",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  // Failure wins, success positions at the top, and neither runs for a
  // passive re-render — the shared action-attention rule (#2934).
  useActionAttention({
    error: error,
    errorTarget: feedbackRef,
    success: savedMessage,
    successTarget: pageRef,
  });

  const dirty =
    payload !== null &&
    draft !== null &&
    MEMBER_FIELD_KEYS.some((key) => payload.settings[key] !== draft[key]);

  function setFieldEnabled(key: MemberFieldKey, enabled: boolean) {
    setDraft((current) =>
      current ? { ...current, [key]: enabled } : current,
    );
    setSavedMessage("");
  }

  async function saveSettings() {
    if (!draft) return;

    setSaving(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/member-fields", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: draft }),
      });
      const body = (await response.json()) as
        | FieldsResponse
        | { error?: string };
      if (!response.ok || !("settings" in body)) {
        // Stale-tab / narrowed-permission save surfaces the persistent
        // forbidden-save reason in the existing error banner (#1940).
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new Error(apiErrorMessageFromBody(body, "Failed to save settings"));
      }
      setPayload(body);
      setDraft(cloneSettings(body.settings));
      setSavedMessage("Member field settings saved.");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save settings",
      );
    } finally {
      setSaving(false);
    }
  }

  const fields = useMemo(
    () => MEMBER_FIELD_KEYS.map((key) => MEMBER_FIELD_DEFINITIONS[key]),
    [],
  );

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view member fields but cannot change them.
      Membership edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (loading && !payload) {
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
            onClick={() => void loadSettings()}
            disabled={loading || saving}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            type="button"
            onClick={() => void saveSettings()}
            disabled={!dirty || saving || draft === null}
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save
          </ViewOnlyActionButton>
        </div>
      </div>

      {(error || savedMessage) && (
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
          {error || savedMessage}
        </div>
      )}

      <div className="rounded-md border border-border bg-card px-4 py-3">
        <div className="flex items-start gap-3">
          <UserCog className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            When a field is off it is hidden from the member editor, member
            onboarding and profile, and is excluded from CSV import and export.
            Existing data already stored is not deleted.
          </p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
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
                    disabled={saving || !canEdit}
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
