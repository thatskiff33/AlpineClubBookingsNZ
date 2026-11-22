"use client";
import { fetchWithRecentAuth } from "@/components/confirm-its-you";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MODULE_KEYS, type ModuleKey, type ModuleSettingsValues } from "@/config/modules";
import { useActionAttention } from "@/hooks/use-scroll-to-feedback";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  ApiRefusalError,
  apiErrorMessageFromBody,
  refusalMessageOr,
  readApiObjectOrEmpty,
} from "@/lib/api-error-message";
import { ModulesInfoNote } from "./_components/modules-info-note";
import { ModuleCard, type ModuleStatus } from "./_components/module-card";
import {
  AI_DIAGNOSTICS_DISCLOSURE,
  AI_DIAGNOSTICS_DISCLOSURE_VERSION,
} from "@/lib/ai-diagnostics-disclosure";

interface ModulesResponse {
  settings: ModuleSettingsValues;
  modules: ModuleStatus[];
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

function getReadiness(
  module: ModuleStatus,
  adminEnabled: boolean,
): ModuleStatus["readiness"] {
  if (!adminEnabled) {
    return {
      ...module.readiness,
      status: "admin_disabled",
      message: `${module.label} is turned off in the admin Modules settings.`,
    };
  }

  // This survives an optimistic re-render of the draft state: a module that
  // needs credentials must not flip to a green "Enabled" the moment the admin
  // ticks the box.
  if (module.readiness.status === "credentials_missing") {
    return module.readiness;
  }

  return {
    ...module.readiness,
    status: "ready",
    message: `${module.label} is enabled.`,
  };
}

/** Ties the disabled Save button to the hint that says why (#5243). */
const AI_DIAGNOSTICS_ACKNOWLEDGEMENT_HINT_ID = "ai-diagnostics-acknowledgement-hint";

function cloneSettings(settings: ModuleSettingsValues): ModuleSettingsValues {
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, settings[key]]),
  ) as ModuleSettingsValues;
}

export default function AdminModulesPage() {
  const router = useRouter();
  // Module activation is a support-area setting; a support:view admin sees it
  // read-only (#1940). The PUT route enforces support:edit.
  const canEdit = useAdminAreaEditAccess("support");
  const [payload, setPayload] = useState<ModulesResponse | null>(null);
  const [draft, setDraft] = useState<ModuleSettingsValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  // The provider-disclosure tick (#5243). Asked for only while this save would
  // switch AI Diagnostics on, and cleared whenever the draft is reset.
  const [aiDiagnosticsAcknowledged, setAiDiagnosticsAcknowledged] =
    useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  // Resolves true only when the reload succeeded, so a caller can act on a
  // good reload without a failed one ever doing so.
  async function loadModules(): Promise<boolean> {
    setLoading(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/modules", {
        credentials: "same-origin",
      });
      const body = (await readApiObjectOrEmpty(response)) as ModulesResponse | { error?: string };
      if (!response.ok || !("settings" in body) || !("modules" in body)) {
        throw new ApiRefusalError(apiErrorMessageFromBody(body, "Failed to load modules"));
      }
      setPayload(body);
      setDraft(cloneSettings(body.settings));
      setAiDiagnosticsAcknowledged(false);
      return true;
    } catch (loadError) {
      setError(
        refusalMessageOr(loadError, "Failed to load modules"),
      );
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadModules();
  }, []);

  // The Refresh button also refreshes the server layout, which holds the admin
  // menus, but only after a successful reload. It stays out of loadModules so
  // the mount effect above does not depend on the router.
  async function refreshModules() {
    if (await loadModules()) router.refresh();
  }

  // Failure wins, success positions at the top, and neither runs for a
  // passive re-render — the shared action-attention rule (#2934).
  useActionAttention({
    error: error,
    errorTarget: feedbackRef,
    success: savedMessage,
    successTarget: pageRef,
  });

  const modules = useMemo(() => {
    if (!payload || !draft) return [];
    return payload.modules.map((module) => ({
      ...module,
      adminEnabled: draft[module.key],
      effectiveEnabled: draft[module.key],
      readiness: getReadiness(module, draft[module.key]),
    }));
  }, [payload, draft]);

  const dirty =
    payload !== null &&
    draft !== null &&
    MODULE_KEYS.some((key) => payload.settings[key] !== draft[key]);

  const enablesAiDiagnostics =
    payload !== null &&
    draft !== null &&
    draft.aiDiagnostics &&
    !payload.settings.aiDiagnostics;
  const awaitingAiDiagnosticsAcknowledgement =
    enablesAiDiagnostics && !aiDiagnosticsAcknowledged;

  function setModuleEnabled(key: ModuleKey, enabled: boolean) {
    setDraft((current) =>
      current
        ? {
            ...current,
            [key]: enabled,
          }
        : current,
    );
    if (key === "aiDiagnostics" && !enabled) setAiDiagnosticsAcknowledged(false);
    setSavedMessage("");
  }

  async function saveModules() {
    if (!draft) return;

    setSaving(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetchWithRecentAuth("/api/admin/modules", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          enablesAiDiagnostics
            ? {
                settings: draft,
                aiDiagnosticsDisclosureAcknowledgedVersion:
                  AI_DIAGNOSTICS_DISCLOSURE_VERSION,
              }
            : { settings: draft },
        ),
      });
      if (response.status === 403) {
        throw new ApiRefusalError(ADMIN_FORBIDDEN_SAVE_REASON);
      }
      const body = (await readApiObjectOrEmpty(response)) as ModulesResponse | { error?: string };
      if (!response.ok || !("settings" in body) || !("modules" in body)) {
        throw new ApiRefusalError(apiErrorMessageFromBody(body, "Failed to save modules"));
      }
      setPayload(body);
      setDraft(cloneSettings(body.settings));
      setAiDiagnosticsAcknowledged(false);
      setSavedMessage("Module settings saved.");
      router.refresh();
    } catch (saveError) {
      setError(
        refusalMessageOr(saveError, "Failed to save modules"),
      );
    } finally {
      setSaving(false);
    }
  }

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
      Your admin role can view the module settings but cannot change them.
      Support edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (loading && !payload) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="flex min-h-[320px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div ref={pageRef} className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Modules</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Turn optional club modules on or off. These toggles are the single
            control for whether a module is available across the site.
          </p>
        </div>

        <div className="flex flex-col items-start gap-2 lg:items-end">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void refreshModules()}
              disabled={loading || saving}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              onClick={() => void saveModules()}
              disabled={
                !dirty ||
                saving ||
                draft === null ||
                awaitingAiDiagnosticsAcknowledgement
              }
              aria-describedby={
                awaitingAiDiagnosticsAcknowledgement
                  ? AI_DIAGNOSTICS_ACKNOWLEDGEMENT_HINT_ID
                  : undefined
              }
            >
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save
            </ViewOnlyActionButton>
          </div>
          {awaitingAiDiagnosticsAcknowledgement ? (
            <p
              id={AI_DIAGNOSTICS_ACKNOWLEDGEMENT_HINT_ID}
              className="max-w-xs text-sm text-muted-foreground lg:text-right"
            >
              {AI_DIAGNOSTICS_DISCLOSURE.acknowledgementRequired}
            </p>
          ) : null}
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

      <ModulesInfoNote />

      <div className="grid gap-4 xl:grid-cols-2">
        {modules.map((module) => (
          <ModuleCard
            key={module.key}
            module={module}
            onEnabledChange={(enabled) => setModuleEnabled(module.key, enabled)}
            disabled={saving || !canEdit}
            aiDiagnosticsAcknowledgement={
              module.key === "aiDiagnostics" && enablesAiDiagnostics
                ? {
                    checked: aiDiagnosticsAcknowledged,
                    onChange: setAiDiagnosticsAcknowledged,
                    disabled: saving || !canEdit,
                  }
                : undefined
            }
          />
        ))}
      </div>
      </div>
    </div>
  );
}
