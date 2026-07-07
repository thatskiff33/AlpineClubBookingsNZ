"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  Loader2,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  SkipForward,
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
import { LodgeCapacityCard } from "@/components/admin/lodge-capacity-card";
import { FinanceReportMappingsPanel } from "@/components/admin/finance-report-mappings-panel";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

type SetupStatus = "complete" | "warning" | "blocked" | "not_started";
type ProgressStatus = "open" | "completed" | "skipped";
type Provider = "stripe" | "smtp" | "sentry" | "xero";

interface SetupStepCheck {
  id: string;
  title: string;
  description: string;
  status: SetupStatus;
  required: boolean;
  message: string;
  details: string[];
  href?: string;
  progress: ProgressStatus;
  action?: {
    type: "provider-test";
    provider: Provider;
    label: string;
  };
}

interface SetupCategory {
  id: string;
  title: string;
  description: string;
  status: SetupStatus;
  checks: SetupStepCheck[];
}

interface SetupReadiness {
  status: SetupStatus;
  summary: {
    total: number;
    complete: number;
    warning: number;
    blocked: number;
    skipped: number;
  };
  categories: SetupCategory[];
  generatedAt: string;
}

interface SetupProgressState {
  completedStepIds: string[];
  skippedStepIds: string[];
  completedAt: string | null;
  completedByMemberId: string | null;
}

interface SetupResponse {
  readiness: SetupReadiness;
  progress: SetupProgressState;
}

interface ProviderTestResult {
  ok: boolean;
  provider: Provider;
  checkedAt: string;
  message: string;
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

function statusVariant(status: SetupStatus): BadgeProps["variant"] {
  if (status === "complete") return "success";
  if (status === "blocked") return "destructive";
  if (status === "warning") return "warning";
  return "secondary";
}

function StatusIcon({ status }: { status: SetupStatus }) {
  if (status === "complete") {
    return <CheckCircle2 className="h-4 w-4 text-green-700" />;
  }
  if (status === "blocked") {
    return <CircleAlert className="h-4 w-4 text-red-700" />;
  }
  if (status === "warning") {
    return <CircleAlert className="h-4 w-4 text-amber-700" />;
  }
  return <CircleDashed className="h-4 w-4 text-slate-500" />;
}

function progressLabel(progress: ProgressStatus) {
  if (progress === "completed") return "Acknowledged";
  if (progress === "skipped") return "Skipped";
  return null;
}

export function SetupPageClient({
  permissionMatrix,
}: {
  permissionMatrix: AdminPermissionMatrix;
}) {
  const [readiness, setReadiness] = useState<SetupReadiness | null>(null);
  const [progress, setProgress] = useState<SetupProgressState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingStep, setSavingStep] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [runningProvider, setRunningProvider] = useState<Provider | null>(null);
  const [providerResults, setProviderResults] = useState<Record<string, ProviderTestResult>>({});

  async function loadSetup() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/admin/setup", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as SetupResponse | { error?: string };
      if (!response.ok || !("readiness" in body)) {
        throw new Error(responseErrorMessage(body, "Failed to load setup readiness"));
      }
      setReadiness(body.readiness);
      setProgress(body.progress);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load setup readiness",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSetup();
  }, []);

  const allChecks = useMemo(
    () => readiness?.categories.flatMap((category) => category.checks) ?? [],
    [readiness],
  );
  const requiredBlockers = allChecks.filter(
    (check) =>
      check.required &&
      check.status === "blocked" &&
      check.progress !== "skipped",
  );
  const completedSteps = allChecks.filter(
    (check) => check.status === "complete" || check.progress === "completed",
  ).length;
  const completionPercent =
    allChecks.length > 0 ? Math.round((completedSteps / allChecks.length) * 100) : 0;
  const setupCompleted = Boolean(progress?.completedAt);
  const overallStatus = setupCompleted ? "complete" : readiness?.status ?? "not_started";

  async function updateProgress(
    action: "complete" | "skip" | "reopen",
    stepId: string,
  ) {
    setSavingStep(stepId);
    setError("");
    try {
      const response = await fetch("/api/admin/setup/progress", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, stepId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to update setup progress");
      }
      await loadSetup();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to update setup progress",
      );
    } finally {
      setSavingStep(null);
    }
  }

  async function finishSetup() {
    setFinishing(true);
    setError("");
    try {
      const response = await fetch("/api/admin/setup/progress", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finish" }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to finish setup");
      }
      await loadSetup();
    } catch (finishError) {
      setError(
        finishError instanceof Error ? finishError.message : "Failed to finish setup",
      );
    } finally {
      setFinishing(false);
    }
  }

  async function runProviderTest(provider: Provider) {
    setRunningProvider(provider);
    setError("");
    try {
      const response = await fetch("/api/admin/setup/provider-test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const body = (await response.json()) as ProviderTestResult | { error?: string };
      if (!response.ok || !("ok" in body)) {
        throw new Error(responseErrorMessage(body, "Provider test failed"));
      }
      setProviderResults((current) => ({
        ...current,
        [provider]: body,
      }));
      await loadSetup();
    } catch (providerError) {
      setProviderResults((current) => ({
        ...current,
        [provider]: {
          ok: false,
          provider,
          checkedAt: new Date().toISOString(),
          message:
            providerError instanceof Error
              ? providerError.message
              : "Provider test failed",
        },
      }));
    } finally {
      setRunningProvider(null);
    }
  }

  if (loading && !readiness) {
    return (
      <div className="flex min-h-[320px] items-center justify-center gap-2 text-sm text-slate-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading setup readiness
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Setup Wizard</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Finish first-install readiness for club configuration, booking rules,
            provider connections, and finance mappings.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={loadSetup} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button
            onClick={finishSetup}
            disabled={
              finishing || setupCompleted || requiredBlockers.length > 0 || !readiness
            }
          >
            {finishing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {setupCompleted ? "Setup Complete" : "Mark Setup Complete"}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {setupCompleted ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Setup has been marked complete.
        </div>
      ) : null}

      {/* A cross-area card is hidden when the viewer lacks `view` on its
          backing API's area (`/api/admin/lodge-settings` → lodge;
          `/api/admin/setup/finance-report-mappings` +
          `/api/admin/xero/chart-of-accounts` → finance), matching the admin
          sidebar's hide precedent so a support-area viewer without lodge or
          finance access never fetches into a 403 (#1548 / owner finding 11). */}
      {permissionMatrix.lodge !== "none" ? <LodgeCapacityCard /> : null}

      {permissionMatrix.finance !== "none" ? <FinanceReportMappingsPanel /> : null}

      {readiness ? (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-md border bg-white p-4">
              <div className="flex items-center gap-2">
                <StatusIcon status={overallStatus} />
                <p className="text-sm font-medium text-slate-700">Overall</p>
              </div>
              <p className="mt-2 text-2xl font-semibold capitalize text-slate-900">
                {overallStatus.replace("_", " ")}
              </p>
            </div>
            <div className="rounded-md border bg-white p-4">
              <p className="text-sm font-medium text-slate-700">Progress</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">
                {completionPercent}%
              </p>
            </div>
            <div className="rounded-md border bg-white p-4">
              <p className="text-sm font-medium text-slate-700">Blocked</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">
                {readiness.summary.blocked}
              </p>
            </div>
            <div className="rounded-md border bg-white p-4">
              <p className="text-sm font-medium text-slate-700">Skipped</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">
                {readiness.summary.skipped}
              </p>
            </div>
          </div>

          {requiredBlockers.length > 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Resolve or explicitly skip required blocked steps before marking setup complete.
            </div>
          ) : null}

          <div className="space-y-6">
            {readiness.categories.map((category) => (
              <section key={category.id} className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-900">
                      {category.title}
                    </h2>
                    <p className="text-sm text-slate-600">{category.description}</p>
                  </div>
                  <Badge variant={statusVariant(category.status)} className="w-fit capitalize">
                    {category.status.replace("_", " ")}
                  </Badge>
                </div>

                <div className="grid gap-3 xl:grid-cols-2">
                  {category.checks.map((check) => {
                    const result = check.action
                      ? providerResults[check.action.provider]
                      : null;
                    const progress = progressLabel(check.progress);
                    const isSaving = savingStep === check.id;
                    return (
                      <Card key={check.id}>
                        <CardHeader className="space-y-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="flex gap-3">
                              <StatusIcon status={check.status} />
                              <div>
                                <CardTitle className="text-base">
                                  {check.title}
                                </CardTitle>
                                <CardDescription>{check.description}</CardDescription>
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Badge variant={statusVariant(check.status)} className="capitalize">
                                {check.status.replace("_", " ")}
                              </Badge>
                              {check.required ? (
                                <Badge variant="outline">Required</Badge>
                              ) : null}
                              {progress ? (
                                <Badge variant="secondary">{progress}</Badge>
                              ) : null}
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <p className="text-sm text-slate-700">{check.message}</p>
                          {check.details.length > 0 ? (
                            <ul className="space-y-1 text-sm text-slate-600">
                              {check.details.map((detail) => (
                                <li key={detail}>{detail}</li>
                              ))}
                            </ul>
                          ) : null}

                          {result ? (
                            <div
                              className={`rounded-md border px-3 py-2 text-sm ${
                                result.ok
                                  ? "border-green-200 bg-green-50 text-green-800"
                                  : "border-red-200 bg-red-50 text-red-800"
                              }`}
                            >
                              {result.message}
                            </div>
                          ) : null}

                          <div className="flex flex-wrap gap-2">
                            {check.href ? (
                              <Button asChild variant="outline" size="sm">
                                <a href={check.href}>
                                  <ExternalLink className="h-4 w-4" />
                                  Open
                                </a>
                              </Button>
                            ) : null}
                            {check.action ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => runProviderTest(check.action!.provider)}
                                disabled={runningProvider === check.action.provider}
                              >
                                {runningProvider === check.action.provider ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <PlayCircle className="h-4 w-4" />
                                )}
                                {check.action.label}
                              </Button>
                            ) : null}
                            {check.progress !== "completed" ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => updateProgress("complete", check.id)}
                                disabled={isSaving}
                              >
                                {isSaving ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <CheckCircle2 className="h-4 w-4" />
                                )}
                                Acknowledge
                              </Button>
                            ) : null}
                            {check.progress !== "skipped" ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => updateProgress("skip", check.id)}
                                disabled={isSaving}
                              >
                                <SkipForward className="h-4 w-4" />
                                Skip
                              </Button>
                            ) : null}
                            {check.progress !== "open" ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => updateProgress("reopen", check.id)}
                                disabled={isSaving}
                              >
                                <RotateCcw className="h-4 w-4" />
                                Reopen
                              </Button>
                            ) : null}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Membership Cancellation</CardTitle>
              <CardDescription>
                Configure cancellation copy and Xero handling before member cancellation requests go live.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                href="/admin/membership-cancellation"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
              >
                Open Membership Cancellation settings
                <ExternalLink className="h-4 w-4" />
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Email Messages</CardTitle>
              <CardDescription>
                Configure email variables and audited message templates before the site goes live.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                href="/admin/email-messages"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
              >
                Open Email Messages settings
                <ExternalLink className="h-4 w-4" />
              </Link>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
