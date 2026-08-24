"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { AdminViewOnlyNotice } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { isFullAdmin } from "@/lib/access-roles";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";
import type { AiAssistantKeyState } from "@/lib/ai-assistant-config";
import {
  MAX_BUDGET_CENTS,
  centsToDollars,
  parseDollarsToCents,
} from "./budget";

const CREDENTIALS_URL = "/api/admin/integrations/credentials";
const USAGE_URL = "/api/admin/ai-assistant/usage";
const SETTINGS_URL = "/api/admin/ai-assistant/settings";

type BudgetStatus = "healthy" | "warning" | "critical" | "exhausted";

interface UsageSummary {
  budget: { limitCents: number; warningThresholds: number[] };
  month: {
    month: string;
    requestCount: number;
    failedCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    costCents: number;
    usagePercent: number;
    budgetStatus: BudgetStatus;
  };
  recentFailures: Array<{
    id: string;
    surface: string;
    pathname: string;
    model: string;
    errorCode: string | null;
    statusCode: number | null;
    errorMessage: string | null;
    createdAt: string;
  }>;
  bySurface: Array<{
    surface: string;
    count: number;
    successCount: number;
    failureCount: number;
  }>;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

const STATUS_TONES: Record<BudgetStatus, string> = {
  healthy: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  // Critical is already in the red zone — use the solid danger fill so it reads
  // as danger, while staying distinct from exhausted's muted danger pill.
  critical: "bg-danger text-danger-foreground",
  exhausted: "bg-danger-muted text-danger",
};

const STATUS_FILL: Record<BudgetStatus, string> = {
  healthy: "bg-success",
  warning: "bg-warning",
  critical: "bg-danger",
  exhausted: "bg-danger",
};

function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "muted";
  children: React.ReactNode;
}) {
  const toneClass = {
    success: "bg-success-muted text-success",
    warning: "bg-warning-muted text-warning",
    danger: "bg-danger-muted text-danger",
    muted: "bg-muted text-muted-foreground",
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClass}`}
    >
      {children}
    </span>
  );
}

export function AiAssistantClient({
  initialKeyState,
  keySetAt,
}: {
  initialKeyState: AiAssistantKeyState;
  keySetAt: string | null;
}) {
  return (
    <div className="space-y-6">
      <KeyCard initialKeyState={initialKeyState} initialKeySetAt={keySetAt} />
      <BudgetCard />
      <UsageCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Anthropic API key (write-only, Full Admin)
// ---------------------------------------------------------------------------

function KeyCard({
  initialKeyState,
  initialKeySetAt,
}: {
  initialKeyState: AiAssistantKeyState;
  initialKeySetAt: string | null;
}) {
  // When the key was last set is a real INSTANT (CT-4, #2870).
  const clubTime = useClubTime();
  const { data: session } = useSession();
  const canWrite = session?.user
    ? isFullAdmin({ accessRoles: session.user.accessRoles })
    : false;

  const [keyState, setKeyState] = useState<AiAssistantKeyState>(initialKeyState);
  const [setAt, setSetAt] = useState<string | null>(initialKeySetAt);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const onSave = useCallback(async () => {
    setError("");
    setSuccess("");
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Enter your Anthropic API key to save it.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(CREDENTIALS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          key: "api_key",
          value: trimmed,
        }),
      });
      if (!res.ok) {
        setError(await readError(res, "Could not store the API key."));
        return;
      }
      setValue("");
      setKeyState("saved");
      setSetAt(new Date().toISOString());
      setSuccess("Saved. The key is write-only and never shown again.");
    } catch {
      setError("Could not store the API key.");
    } finally {
      setSaving(false);
    }
  }, [value]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Anthropic API key</CardTitle>
          {keyState === "saved" ? (
            <StatusPill tone="success">Saved</StatusPill>
          ) : keyState === "needs_reentry" ? (
            <StatusPill tone="danger">Re-enter required</StatusPill>
          ) : (
            <StatusPill tone="muted">Not configured</StatusPill>
          )}
        </div>
        <CardDescription>
          Write-only. Enter a key to set or replace it; the stored key is never
          displayed. Enabling the module without a key is harmless — the
          assistant simply stays off until a key is saved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {keyState === "needs_reentry" ? (
          <div
            role="alert"
            className="rounded-md border border-danger bg-danger-muted px-3 py-2 text-sm text-danger"
          >
            The stored Anthropic key could not be decrypted (the app encryption
            key changed). The assistant is off until you re-enter the key below.
          </div>
        ) : null}

        {session?.user && !canWrite ? (
          <AdminViewOnlyNotice canEdit={false}>
            Only a Full Admin can set the Anthropic API key.
          </AdminViewOnlyNotice>
        ) : null}

        <div className="grid gap-2">
          <Label htmlFor="anthropic-api-key">
            API key{" "}
            {setAt ? (
              <span className="text-xs font-normal text-muted-foreground">
                (last set {clubTime.instantDateTime(requireInstant(setAt))})
              </span>
            ) : null}
          </Label>
          <Input
            id="anthropic-api-key"
            type="password"
            autoComplete="new-password"
            placeholder="sk-ant-…"
            value={value}
            disabled={!canWrite || saving}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        {success ? (
          <p role="status" className="text-sm text-success">
            {success}
          </p>
        ) : null}

        <Button onClick={onSave} disabled={!canWrite || saving}>
          {saving ? "Saving…" : "Save API key"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Monthly spend cap (support/edit)
// ---------------------------------------------------------------------------

function BudgetCard() {
  const canEdit = useAdminAreaEditAccess("support");

  const [dollars, setDollars] = useState("");
  const [savedCents, setSavedCents] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(SETTINGS_URL, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setError(await readError(res, "Could not load the spend cap."));
          return;
        }
        const data = (await res.json()) as { monthlyBudgetCents: number };
        if (!cancelled) {
          setSavedCents(data.monthlyBudgetCents);
          setDollars(centsToDollars(data.monthlyBudgetCents));
        }
      } catch {
        if (!cancelled) setError("Could not load the spend cap.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = useCallback(async () => {
    setError("");
    setSuccess("");
    const parsed = parseDollarsToCents(dollars);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(SETTINGS_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyBudgetCents: parsed.cents }),
      });
      if (!res.ok) {
        setError(await readError(res, "Could not save the spend cap."));
        return;
      }
      const data = (await res.json()) as { monthlyBudgetCents: number };
      setSavedCents(data.monthlyBudgetCents);
      setDollars(centsToDollars(data.monthlyBudgetCents));
      setSuccess("Monthly spend cap saved.");
    } catch {
      setError("Could not save the spend cap.");
    } finally {
      setSaving(false);
    }
  }, [dollars]);

  const editingDisabled = !canEdit || saving || loading;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly spend cap</CardTitle>
        <CardDescription>
          A hard limit on paid AI spend per calendar month (NZD). Once reached,
          the assistant stops answering until the next month; curated page help
          keeps working. Set it to $0.00 to switch paid answers off entirely.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AdminViewOnlyNotice canEdit={canEdit}>
          Your admin role can view the spend cap but cannot change it. Support
          edit access is required.
        </AdminViewOnlyNotice>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> Loading spend cap…
          </div>
        ) : (
          <>
            <div className="grid gap-2 sm:max-w-xs">
              <Label htmlFor="ai-budget">Monthly cap (NZD)</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">$</span>
                <Input
                  id="ai-budget"
                  inputMode="decimal"
                  value={dollars}
                  disabled={editingDisabled}
                  onChange={(event) => setDollars(event.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Maximum ${centsToDollars(MAX_BUDGET_CENTS)}. Also set a spend
                limit in the Anthropic console as the hard backstop.
              </p>
            </div>

            {savedCents === 0 ? (
              <p className="text-xs text-warning">
                The cap is $0.00 — paid AI answers are currently switched off.
              </p>
            ) : null}

            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            {success ? (
              <p role="status" className="text-sm text-success">
                {success}
              </p>
            ) : null}

            <Button onClick={onSave} disabled={editingDisabled}>
              {saving ? "Saving…" : "Save spend cap"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Usage panel
// ---------------------------------------------------------------------------

function UsageCard() {
  // Each failure's `createdAt` is a real INSTANT (CT-4, #2870).
  const clubTime = useClubTime();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(USAGE_URL, { cache: "no-store" });
      if (!res.ok) {
        setError(await readError(res, "Could not load AI usage."));
        return;
      }
      setUsage((await res.json()) as UsageSummary);
    } catch {
      setError("Could not load AI usage.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUsage();
  }, [fetchUsage]);

  const month = usage?.month;
  const percent = month ? Math.round(month.usagePercent * 100) : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Usage this month</CardTitle>
            <CardDescription>
              Spend against the cap, token totals, and recent failures. Question
              text is never stored.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchUsage()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        {loading && !usage ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> Loading usage…
          </div>
        ) : usage && month ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
              <UsageStat
                label="Spent this month"
                value={`$${centsToDollars(month.costCents)}`}
                detail={`of $${centsToDollars(usage.budget.limitCents)} cap`}
              />
              <UsageStat
                label="Requests"
                value={String(month.requestCount)}
                detail={`Failed: ${month.failedCount}`}
              />
              <UsageStat
                label="Tokens in / out"
                value={`${month.inputTokens} / ${month.outputTokens}`}
                detail={`Cache: ${month.cacheWriteTokens}w / ${month.cacheReadTokens}r`}
              />
              <div className="rounded-md border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Status
                </p>
                <div className="mt-1">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_TONES[month.budgetStatus]}`}
                  >
                    {month.budgetStatus}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {month.month}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>Budget used</span>
                <span>{percent}%</span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full ${STATUS_FILL[month.budgetStatus]}`}
                  style={{ width: `${Math.min(percent, 100)}%` }}
                />
              </div>
            </div>

            <div className="rounded-md border p-3">
              <p className="mb-2 text-sm font-medium">By surface</p>
              {usage.bySurface.length > 0 ? (
                <div className="space-y-2 text-sm">
                  {usage.bySurface.map((bucket) => (
                    <div
                      key={bucket.surface}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="capitalize">{bucket.surface}</span>
                      <span className="text-muted-foreground">
                        {bucket.count} ({bucket.failureCount} failed)
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No AI questions recorded yet this month.
                </p>
              )}
            </div>

            <div className="rounded-md border p-3">
              <p className="mb-2 text-sm font-medium">Recent failures</p>
              {usage.recentFailures.length > 0 ? (
                <div className="space-y-3">
                  {usage.recentFailures.map((failure) => (
                    <div
                      key={failure.id}
                      className="rounded-md bg-muted p-3 text-sm"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium capitalize">
                          {failure.surface}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {clubTime.instantDateTime(requireInstant(failure.createdAt))}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {failure.pathname}
                        {failure.errorCode ? ` — ${failure.errorCode}` : ""}
                        {failure.statusCode ? ` (HTTP ${failure.statusCode})` : ""}
                      </p>
                      {failure.errorMessage ? (
                        <p className="mt-2 text-xs text-danger">
                          {failure.errorMessage}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No failed AI calls recorded yet this month.
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No AI usage data recorded yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function UsageStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
