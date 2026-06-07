"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
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

type ModuleReadinessStatus =
  | "ready"
  | "admin_disabled"
  | "capability_disabled";

interface ModuleStatus {
  key: ModuleKey;
  label: string;
  description: string;
  envVar: string;
  adminEnabled: boolean;
  capabilityEnabled: boolean;
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
  if (status === "capability_disabled") return "warning";
  return "secondary";
}

function readinessLabel(status: ModuleReadinessStatus) {
  if (status === "ready") return "Ready";
  if (status === "capability_disabled") return "Capability off";
  return "Admin disabled";
}

function getReadiness(
  module: ModuleStatus,
  adminEnabled: boolean,
): ModuleStatus["readiness"] {
  if (!module.capabilityEnabled) {
    return {
      ...module.readiness,
      status: "capability_disabled",
      message: `${module.envVar} is not enabled, so ${module.label} cannot take effect even if admins activate it.`,
    };
  }

  if (!adminEnabled) {
    return {
      ...module.readiness,
      status: "admin_disabled",
      message: `${module.label} is available at deploy time but disabled by admin activation.`,
    };
  }

  return {
    ...module.readiness,
    status: "ready",
    message: `${module.label} is active and deploy capability is available.`,
  };
}

function cloneSettings(settings: ModuleSettingsValues): ModuleSettingsValues {
  return {
    kiosk: settings.kiosk,
    chores: settings.chores,
    financeDashboard: settings.financeDashboard,
    waitlist: settings.waitlist,
    xeroIntegration: settings.xeroIntegration,
    bedAllocation: settings.bedAllocation,
    internetBankingPayments: settings.internetBankingPayments,
  };
}

export default function AdminModulesPage() {
  const [payload, setPayload] = useState<ModulesResponse | null>(null);
  const [draft, setDraft] = useState<ModuleSettingsValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

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

  const modules = useMemo(() => {
    if (!payload || !draft) return [];
    return payload.modules.map((module) => ({
      ...module,
      adminEnabled: draft[module.key],
      effectiveEnabled: draft[module.key] && module.capabilityEnabled,
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

  if (loading && !payload) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Modules</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            Manage admin activation for optional club modules. Deploy capability
            still comes from environment feature flags.
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
          <Button
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
          </Button>
        </div>
      </div>

      {(error || savedMessage) && (
        <div
          className={
            error
              ? "rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
              : "rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
          }
        >
          {error || savedMessage}
        </div>
      )}

      <div className="rounded-md border border-slate-200 bg-white px-4 py-3">
        <div className="flex items-start gap-3">
          <ServerCog className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
          <div className="space-y-1 text-sm text-slate-600">
            <p>
              Admin activation is stored in the database and does not store
              secrets, tokens, tenant ids, or provider credentials.
            </p>
            <p>
              A module is ready only when both admin activation and its deploy
              capability flag are enabled.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {modules.map((module) => {
          const checkboxId = `module-${module.key}`;
          const statusIcon = module.effectiveEnabled ? (
            <CheckCircle2 className="h-4 w-4 text-green-700" />
          ) : (
            <AlertCircle className="h-4 w-4 text-amber-700" />
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
                    disabled={saving}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">
                        <label htmlFor={checkboxId}>{module.label}</label>
                      </CardTitle>
                      <Badge variant={module.adminEnabled ? "success" : "secondary"}>
                        {module.adminEnabled ? "Admin on" : "Admin off"}
                      </Badge>
                      <Badge
                        variant={
                          module.capabilityEnabled ? "success" : "warning"
                        }
                      >
                        {module.envVar}{" "}
                        {module.capabilityEnabled ? "on" : "off"}
                      </Badge>
                    </div>
                    <CardDescription className="mt-1">
                      {module.description}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  {statusIcon}
                  <div>
                    <Badge
                      variant={readinessVariant(module.readiness.status)}
                      className="mb-2"
                    >
                      {readinessLabel(module.readiness.status)}
                    </Badge>
                    <p>{module.readiness.message}</p>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Dependencies
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
                    {module.readiness.dependencies.map((dependency) => (
                      <li key={dependency}>{dependency}</li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
