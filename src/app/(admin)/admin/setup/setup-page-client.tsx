"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Bell,
  BookOpenCheck,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  Landmark,
  ListChecks,
  Loader2,
  PlayCircle,
  Plug,
  RefreshCw,
  RotateCcw,
  SkipForward,
  UserX,
  type LucideIcon,
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
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";
import type {
  AdminPermissionArea,
  AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { apiErrorMessageFromBody } from "@/lib/api-error-message";

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

interface SetupHubCard {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  requiredAreas: AdminPermissionArea[];
}

const setupHubCards: SetupHubCard[] = [
  {
    href: "/admin/setup/foundations",
    title: "Initial Setup",
    description:
      "Start with the installation checklist, club identity, modules, lodge records, and system health.",
    icon: ListChecks,
    requiredAreas: ["support"],
  },
  {
    href: "/admin/setup/finance",
    title: "Finance",
    description:
      "Open finance reporting, Xero setup, sync tools, and the collapsed report-mapping editor.",
    icon: Landmark,
    requiredAreas: ["finance"],
  },
  {
    href: "/admin/setup/booking-rules",
    title: "Booking Rules",
    description:
      "Review booking policy, seasons, age groups, promo codes, inventory, and booking copy.",
    icon: BookOpenCheck,
    requiredAreas: ["bookings", "lodge"],
  },
  {
    href: "/admin/setup/integrations",
    title: "Operational Integrations",
    description:
      "Check external-provider readiness, Xero connection, modules, and delivery health.",
    icon: Plug,
    requiredAreas: ["support", "finance"],
  },
  {
    href: "/admin/membership-setup",
    title: "Membership & Members",
    description:
      "Configure membership types, member fields, and subscription lockout policy.",
    icon: BadgeCheck,
    requiredAreas: ["membership"],
  },
  {
    href: "/admin/setup/cancellation",
    title: "Cancellation",
    description:
      "Review cancellation settings, cancellation request queues, and related message copy.",
    icon: UserX,
    requiredAreas: ["membership", "support"],
  },
  {
    href: "/admin/notifications",
    title: "Email Messages / Notifications",
    description:
      "Manage delivery rules, recipients, email templates, and member-facing message text.",
    icon: Bell,
    requiredAreas: ["support"],
  },
];

function statusVariant(status: SetupStatus): BadgeProps["variant"] {
  if (status === "complete") return "success";
  if (status === "blocked") return "destructive";
  if (status === "warning") return "warning";
  return "secondary";
}

function StatusIcon({ status }: { status: SetupStatus }) {
  if (status === "complete") {
    return <CheckCircle2 className="h-4 w-4 text-success-11" />;
  }
  if (status === "blocked") {
    return <CircleAlert className="h-4 w-4 text-danger-11" />;
  }
  if (status === "warning") {
    return <CircleAlert className="h-4 w-4 text-warning-11" />;
  }
  return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
}

function progressLabel(progress: ProgressStatus) {
  if (progress === "completed") return "Acknowledged";
  if (progress === "skipped") return "Skipped";
  return null;
}

function canSeeAnyRequiredArea(
  permissionMatrix: AdminPermissionMatrix,
  areas: AdminPermissionArea[],
) {
  return areas.some((area) => permissionMatrix[area] !== "none");
}

function getVisibleSetupHubCards(
  cards: SetupHubCard[],
  features: FeatureFlags,
  permissionMatrix: AdminPermissionMatrix,
) {
  return cards.filter(
    (card) =>
      isFeatureHrefVisible(card.href, features) &&
      canSeeAnyRequiredArea(permissionMatrix, card.requiredAreas),
  );
}

function SetupHubCards({
  features,
  permissionMatrix,
}: {
  features: FeatureFlags;
  permissionMatrix: AdminPermissionMatrix;
}) {
  const visibleCards = getVisibleSetupHubCards(
    setupHubCards,
    features,
    permissionMatrix,
  );

  if (visibleCards.length === 0) return null;

  return (
    <section id="setup-hubs" className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Setup hubs</h2>
        <p className="text-sm text-muted-foreground">
          Open the relevant drill-down before editing lower-frequency
          configuration.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visibleCards.map(({ href, title, description, icon: Icon }) => (
          <Link key={href} href={href} className="group block">
            <Card className="h-full transition-colors hover:border-brand-gold/70">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Icon className="h-5 w-5 shrink-0 text-foreground" />
                  <CardTitle className="text-base">{title}</CardTitle>
                </div>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function SetupPageClient({
  permissionMatrix,
  features,
}: {
  permissionMatrix: AdminPermissionMatrix;
  features: FeatureFlags;
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
        throw new Error(apiErrorMessageFromBody(body, "Failed to load setup readiness"));
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
        throw new Error(apiErrorMessageFromBody(body, "Provider test failed"));
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
      <div className="flex min-h-[320px] items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading setup readiness
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Setup Wizard</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
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
        <div className="rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11">
          {error}
        </div>
      ) : null}

      {setupCompleted ? (
        <div className="rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11">
          Setup has been marked complete.
        </div>
      ) : null}

      {readiness ? (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-md border bg-card p-4">
              <div className="flex items-center gap-2">
                <StatusIcon status={overallStatus} />
                <p className="text-sm font-medium text-muted-foreground">Overall</p>
              </div>
              <p className="mt-2 text-2xl font-semibold capitalize text-foreground">
                {overallStatus.replace("_", " ")}
              </p>
            </div>
            <div className="rounded-md border bg-card p-4">
              <p className="text-sm font-medium text-muted-foreground">Progress</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">
                {completionPercent}%
              </p>
            </div>
            <div className="rounded-md border bg-card p-4">
              <p className="text-sm font-medium text-muted-foreground">Blocked</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">
                {readiness.summary.blocked}
              </p>
            </div>
            <div className="rounded-md border bg-card p-4">
              <p className="text-sm font-medium text-muted-foreground">Skipped</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">
                {readiness.summary.skipped}
              </p>
            </div>
          </div>

          {requiredBlockers.length > 0 ? (
            <div className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
              Resolve or explicitly skip required blocked steps before marking setup complete.
            </div>
          ) : null}

          <SetupHubCards
            features={features}
            permissionMatrix={permissionMatrix}
          />

          {/* The lodge-capacity card remains on the setup page and keeps the
              #1548 matrix gate because its backing API is lodge-area while
              /admin/setup itself is support-area. */}
          {permissionMatrix.lodge !== "none" ? <LodgeCapacityCard /> : null}

          <section id="setup-checks" className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                Readiness checks
              </h2>
              <p className="text-sm text-muted-foreground">
                Work through the live checks after choosing the matching setup
                hub.
              </p>
            </div>
            {readiness.categories.map((category) => (
              <section key={category.id} className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-foreground">
                      {category.title}
                    </h2>
                    <p className="text-sm text-muted-foreground">{category.description}</p>
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
                          <p className="text-sm text-muted-foreground">{check.message}</p>
                          {check.details.length > 0 ? (
                            <ul className="space-y-1 text-sm text-muted-foreground">
                              {check.details.map((detail) => (
                                <li key={detail}>{detail}</li>
                              ))}
                            </ul>
                          ) : null}

                          {result ? (
                            <div
                              className={`rounded-md border px-3 py-2 text-sm ${
                                result.ok
                                  ? "border-success-6 bg-success-3 text-success-11"
                                  : "border-danger-6 bg-danger-3 text-danger-11"
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
          </section>
        </>
      ) : null}
    </div>
  );
}
