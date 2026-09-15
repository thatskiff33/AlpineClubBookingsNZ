"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
  ServerCog,
} from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { MODULE_KEYS, type ModuleKey, type ModuleSettingsValues } from "@/config/modules";
import { useActionAttention } from "@/hooks/use-scroll-to-feedback";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

type ModuleReadinessStatus =
  | "ready"
  | "admin_disabled"
  // #2306 added a `not_available_yet` state for the memberGuests flag, which
  // gated nothing in that release. #2307 shipped the behaviour, removing the
  // only producer, so the state and its branches go with it.
  | "credentials_missing";

interface ModuleStatus {
  key: ModuleKey;
  label: string;
  description: string;
  adminEnabled: boolean;
  effectiveEnabled: boolean;
  readiness: {
    status: ModuleReadinessStatus;
    message: string;
    dependencies: string[];
  };
}

interface ModulesResponse {
  settings: ModuleSettingsValues;
  modules: ModuleStatus[];
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

function readinessVariant(
  status: ModuleReadinessStatus,
): BadgeProps["variant"] {
  if (status === "ready") return "success";
  if (status === "credentials_missing") return "warning";
  return "secondary";
}

function readinessLabel(status: ModuleReadinessStatus) {
  if (status === "ready") return "Enabled";
  if (status === "credentials_missing") return "Needs setup";
  return "Disabled";
}

// Modules whose "Needs setup" state has somewhere to deep-link to (#2080). C4/C5
// add their providers here as their wizards land.
//
// `analytics` points at the Integrations HUB rather than at a setup route of its
// own, because it has none by design: the owner's #2573 decision put Google
// Analytics on that hub as a peer card whose configuration opens in place, and
// expressly ruled out a dedicated analytics setup route. Without this entry
// analytics was the one module in the tree that could report `credentials_missing`
// with no clickable route to its configuration — on the screen where the #2573
// hard cutover is most likely to be discovered by an operator who has not read the
// release note, and two rows away from the Xero and Google sign-in cards that do
// show the affordance.
const MODULE_SETUP_HREFS: Partial<Record<ModuleKey, string>> = {
  xeroIntegration: "/admin/xero/setup",
  googleLogin: "/admin/google/setup",
  analytics: "/admin/integrations",
  // The Alpine Central Server setup lives on the Integrations hub (as a card
  // opening /admin/alpine-server/setup); the module's "Set up" affordance points
  // at the hub, matching the analytics pattern.
  alpineCentralServer: "/admin/integrations",
};

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

function cloneSettings(settings: ModuleSettingsValues): ModuleSettingsValues {
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, settings[key]]),
  ) as ModuleSettingsValues;
}

export default function AdminModulesPage() {
  // Module activation is a support-area setting; a support:view admin sees it
  // read-only (#1940). The PUT route enforces support:edit.
  const canEdit = useAdminAreaEditAccess("support");
  const [payload, setPayload] = useState<ModulesResponse | null>(null);
  const [draft, setDraft] = useState<ModuleSettingsValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  async function loadModules() {
    setLoading(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/modules", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as ModulesResponse | { error?: string };
      if (!response.ok || !("settings" in body) || !("modules" in body)) {
        throw new Error(responseErrorMessage(body, "Failed to load modules"));
      }
      setPayload(body);
      setDraft(cloneSettings(body.settings));
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load modules",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadModules();
  }, []);

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

  function setModuleEnabled(key: ModuleKey, enabled: boolean) {
    setDraft((current) =>
      current
        ? {
            ...current,
            [key]: enabled,
          }
        : current,
    );
    setSavedMessage("");
  }

  async function saveModules() {
    if (!draft) return;

    setSaving(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/modules", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: draft }),
      });
      if (response.status === 403) {
        throw new Error(ADMIN_FORBIDDEN_SAVE_REASON);
      }
      const body = (await response.json()) as ModulesResponse | { error?: string };
      if (!response.ok || !("settings" in body) || !("modules" in body)) {
        throw new Error(responseErrorMessage(body, "Failed to save modules"));
      }
      setPayload(body);
      setDraft(cloneSettings(body.settings));
      setSavedMessage("Module settings saved.");
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save modules",
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

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadModules()}
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
          <ServerCog className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              Module activation is stored in the database and does not store
              secrets, tokens, tenant ids, or provider credentials.
            </p>
            <p>
              A module is available across the site whenever it is enabled here.
              Some modules still need their own setup (for example Xero
              credentials) before they can do useful work.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {modules.map((module) => {
          const checkboxId = `module-${module.key}`;
          const statusIcon = module.effectiveEnabled ? (
            <CheckCircle2 className="h-4 w-4 text-success-11" />
          ) : (
            <AlertCircle className="h-4 w-4 text-warning-11" />
          );

          return (
            <Card key={module.key}>
              <CardHeader className="space-y-3">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id={checkboxId}
                    checked={module.adminEnabled}
                    onCheckedChange={(checked) =>
                      setModuleEnabled(module.key, checked === true)
                    }
                    disabled={saving || !canEdit}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">
                        <label htmlFor={checkboxId}>{module.label}</label>
                      </CardTitle>
                      <Badge variant={module.adminEnabled ? "success" : "secondary"}>
                        {module.adminEnabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </div>
                    <CardDescription className="mt-1">
                      {module.description}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                  {statusIcon}
                  <div>
                    <Badge
                      variant={readinessVariant(module.readiness.status)}
                      className="mb-2"
                    >
                      {readinessLabel(module.readiness.status)}
                    </Badge>
                    <p>{module.readiness.message}</p>
                    {module.readiness.status === "credentials_missing" &&
                    MODULE_SETUP_HREFS[module.key] ? (
                      <Link
                        href={MODULE_SETUP_HREFS[module.key] as string}
                        className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
                      >
                        Set up
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    ) : null}
                  </div>
                </div>

                {module.readiness.dependencies.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Dependencies
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {module.readiness.dependencies.map((dependency) => (
                        <li key={dependency}>{dependency}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
      </div>
    </div>
  );
}
