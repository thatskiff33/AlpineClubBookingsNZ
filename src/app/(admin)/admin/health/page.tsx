"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Activity,
  Database,
  CreditCard,
  RefreshCw,
  Mail,
  Clock,
  Server,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Webhook,
} from "lucide-react";

interface HealthCheck {
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

interface CronRun {
  id: string;
  jobName: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  status: string;
  resultSummary: Record<string, unknown> | null;
  error: string | null;
}

interface WebhookLogEntry {
  id: string;
  source: string;
  eventType: string;
  eventId: string;
  status: string;
  durationMs: number;
  error: string | null;
  createdAt: string;
}

type CronHealthStatus =
  | "current"
  | "stale"
  | "failed"
  | "skipped"
  | "missing"
  | "disabled"
  | "untracked"
  | "unknown";

interface CronHealthJob {
  jobName: string;
  label: string;
  schedule: string;
  timezone: string;
  expectedLocalTime: string;
  staleAfterMinutes: number | null;
  enabled: boolean;
  disabledReason: string | null;
  recordsRuns: boolean;
  note?: string;
  status: CronHealthStatus;
  severity: "ok" | "warning" | "error" | "info";
  summary: string;
  staleThreshold: string | null;
  latestRunAt: string | null;
  latestRunStatus: string | null;
  latestSuccessAt: string | null;
  latestFailureAt: string | null;
}

interface CronHealthReport {
  generatedAt: string;
  cronEnabled: boolean;
  defaultTimezone: string;
  jobs: CronHealthJob[];
}

interface EmailSuppressionEntry {
  id: string;
  email: string;
  reason: "BOUNCE" | "COMPLAINT";
  eventCount: number;
  suppressedAt: string | null;
  lastEventAt: string;
  lastEventType: string;
  lastBounceType: string | null;
  lastBounceSubType: string | null;
  lastComplaintFeedbackType: string | null;
  lastSesMessageId: string | null;
}

interface ExhaustedEmailFailure {
  id: string;
  to: string;
  subject: string;
  templateName: string;
  attempts: number;
  lastAttemptAt: string;
  errorMessage: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewNote: string | null;
}

interface HealthData {
  health: {
    status: string;
    version: string;
    uptime: number;
    checks: {
      db?: HealthCheck;
      config?: HealthCheck;
      stripe?: HealthCheck;
      xero?: HealthCheck;
      smtp?: HealthCheck;
    };
  };
  cronJobs: Record<string, CronRun[]>;
  cronHealth?: CronHealthReport;
  webhookStats: Record<string, { success: number; failure: number; total: number }>;
  recentWebhooks: WebhookLogEntry[];
  emailDeliverability: {
    summary: {
      activeCount: number;
      bounceCount: number;
      complaintCount: number;
      eventsLast24h: number;
    };
    suppressions: EmailSuppressionEntry[];
  };
  emailFailures: {
    summary: {
      activeCount: number;
      reviewedCount: number;
      scannedCount: number;
      maxAttempts: number;
    };
    failures: ExhaustedEmailFailure[];
    recentlyReviewed: ExhaustedEmailFailure[];
  };
  systemInfo: {
    version: string;
    nodeVersion: string;
    uptime: number;
    memoryMb: { rss: number; heapUsed: number; heapTotal: number };
    sentryConfigured: boolean;
    sentryDashboardUrl: string | null;
    sentryConfigWarning: string | null;
  };
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ok: "bg-green-100 text-green-800",
    healthy: "bg-green-100 text-green-800",
    SUCCESS: "bg-green-100 text-green-800",
    success: "bg-green-100 text-green-800",
    current: "bg-green-100 text-green-800",
    degraded: "bg-yellow-100 text-yellow-800",
    SKIPPED: "bg-yellow-100 text-yellow-800",
    skipped: "bg-yellow-100 text-yellow-800",
    stale: "bg-yellow-100 text-yellow-800",
    missing: "bg-yellow-100 text-yellow-800",
    error: "bg-red-100 text-red-800",
    unhealthy: "bg-red-100 text-red-800",
    FAILURE: "bg-red-100 text-red-800",
    failure: "bg-red-100 text-red-800",
    failed: "bg-red-100 text-red-800",
    BOUNCE: "bg-red-100 text-red-800",
    COMPLAINT: "bg-red-100 text-red-800",
    disabled: "bg-slate-100 text-slate-700",
    untracked: "bg-slate-100 text-slate-700",
    unknown: "bg-gray-100 text-gray-800",
  };

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[status] || colors.unknown}`}
    >
      {status}
    </span>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "ok" || status === "healthy" || status === "SUCCESS" || status === "success") {
    return <CheckCircle className="h-5 w-5 text-green-500" />;
  }
  if (status === "degraded" || status === "SKIPPED") {
    return <AlertTriangle className="h-5 w-5 text-yellow-500" />;
  }
  return <XCircle className="h-5 w-5 text-red-500" />;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString("en-NZ", {
    timeZone: "Pacific/Auckland",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatOptionalDate(dateStr: string | null) {
  return dateStr ? formatDate(dateStr) : "Not recorded";
}

function CronError({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = error.length > 80;

  if (!isLong) {
    return <span className="text-red-600">{error}</span>;
  }

  return (
    <button
      onClick={() => setExpanded((e) => !e)}
      className="text-left text-red-600 max-w-xs"
    >
      {expanded ? (
        <span className="whitespace-pre-wrap break-words">{error}</span>
      ) : (
        <span>{error.slice(0, 80)}... <span className="text-red-400 underline text-xs">show more</span></span>
      )}
    </button>
  );
}

function CronResultSummary({ summary }: { summary: Record<string, unknown> }) {
  const healthSignal = typeof summary.healthSignal === "string" ? summary.healthSignal : null;
  const sizeBytes = typeof summary.sizeBytes === "number" ? summary.sizeBytes : null;
  const minSizeBytes = typeof summary.minSizeBytes === "number" ? summary.minSizeBytes : null;
  const reason = typeof summary.reason === "string" ? summary.reason : null;

  if (healthSignal || sizeBytes !== null) {
    return (
      <span className="text-xs text-slate-500">
        {healthSignal ? `${healthSignal}` : "backup"}{" "}
        {sizeBytes !== null ? `${sizeBytes} bytes` : ""}
        {minSizeBytes !== null ? ` / min ${minSizeBytes}` : ""}
      </span>
    );
  }

  if (reason) {
    return <span className="text-xs text-slate-500">{reason}</span>;
  }

  return null;
}

export default function AdminHealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [clearingSuppressionId, setClearingSuppressionId] = useState<string | null>(null);
  const [reviewingEmailFailureId, setReviewingEmailFailureId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/health");
      if (!res.ok) throw new Error("Failed to fetch health data");
      const json = await res.json();
      setData(json);
      setError(null);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const clearSuppression = useCallback(
    async (id: string, email: string) => {
      if (!window.confirm(`Clear email suppression for ${email}?`)) {
        return;
      }

      setClearingSuppressionId(id);
      try {
        const res = await fetch(`/api/admin/email-suppressions/${id}/clear`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Reviewed from admin health dashboard" }),
        });
        if (!res.ok) throw new Error("Failed to clear suppression");
        await fetchData();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setClearingSuppressionId(null);
      }
    },
    [fetchData]
  );

  const archiveEmailFailure = useCallback(
    async (id: string, to: string) => {
      const reason = window.prompt(
        `Archive exhausted email failure for ${to}?`,
        "Reviewed from admin health dashboard"
      );
      if (reason === null) {
        return;
      }

      setReviewingEmailFailureId(id);
      try {
        const res = await fetch(`/api/admin/email-failures/${id}/review`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        if (!res.ok) throw new Error("Failed to archive exhausted email failure");
        await fetchData();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setReviewingEmailFailureId(null);
      }
    },
    [fetchData]
  );

  useEffect(() => {
    fetchData();
    // Auto-refresh every 60 seconds
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">System Health</h1>
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 bg-slate-100 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">System Health</h1>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          Failed to load health data: {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const {
    health,
    cronJobs,
    cronHealth,
    webhookStats,
    recentWebhooks,
    emailDeliverability,
    emailFailures,
    systemInfo,
  } = data;
  const checkEntries = Object.entries(health.checks) as [string, HealthCheck][];
  const checkIcons: Record<string, typeof Database> = {
    db: Database,
    config: AlertTriangle,
    stripe: CreditCard,
    xero: RefreshCw,
    smtp: Mail,
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">System Health</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-500">
            Last refresh: {lastRefresh.toLocaleTimeString("en-NZ")}
          </span>
          <button
            onClick={fetchData}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Overall Status */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-4">
        <StatusIcon status={health.status} />
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            System is {health.status}
          </h2>
          <p className="text-sm text-slate-500">
            Version {systemInfo.version} &middot; Node {systemInfo.nodeVersion} &middot; Uptime {formatUptime(systemInfo.uptime)}
          </p>
        </div>
      </div>

      {/* Service Checks */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Service Checks
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {checkEntries.map(([name, check]) => {
            const Icon = checkIcons[name] || Server;
            return (
              <div key={name} className="bg-white border rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-slate-500" />
                    <span className="font-medium text-slate-900 capitalize">{name}</span>
                  </div>
                  <StatusBadge status={check.status} />
                </div>
                <p className="text-sm text-slate-500">
                  {check.status === "ok"
                    ? `${check.latencyMs}ms`
                    : check.error || "Error"}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Email Deliverability */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Mail className="h-5 w-5" />
          Email Deliverability
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Active suppressions</p>
            <p className="text-2xl font-bold text-slate-900">
              {emailDeliverability.summary.activeCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Bounces</p>
            <p className="text-2xl font-bold text-red-600">
              {emailDeliverability.summary.bounceCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Complaints</p>
            <p className="text-2xl font-bold text-red-600">
              {emailDeliverability.summary.complaintCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Events 24h</p>
            <p className="text-2xl font-bold text-slate-900">
              {emailDeliverability.summary.eventsLast24h}
            </p>
          </div>
        </div>

        {emailDeliverability.suppressions.length === 0 ? (
          <div className="bg-white border rounded-lg p-4 text-slate-500">
            No active recipient suppressions.
          </div>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto">
            <div className="min-w-[760px]">
              <div className="grid grid-cols-[minmax(0,1.7fr)_100px_90px_140px_88px] gap-3 px-4 py-2 text-xs font-medium text-slate-500 bg-slate-50 border-b">
                <span>Recipient</span>
                <span>Reason</span>
                <span>Events</span>
                <span>Last event</span>
                <span className="text-right">Action</span>
              </div>
              <div className="divide-y">
                {emailDeliverability.suppressions.map((suppression) => (
                  <div
                    key={suppression.id}
                    className="grid grid-cols-[minmax(0,1.7fr)_100px_90px_140px_88px] gap-3 px-4 py-3 text-sm items-center"
                  >
                    <span className="font-medium text-slate-900 truncate">
                      {suppression.email}
                    </span>
                    <StatusBadge status={suppression.reason} />
                    <span className="text-slate-600">{suppression.eventCount}</span>
                    <span className="text-slate-500">
                      {formatDate(suppression.lastEventAt)}
                    </span>
                    <button
                      onClick={() =>
                        clearSuppression(suppression.id, suppression.email)
                      }
                      disabled={clearingSuppressionId === suppression.id}
                      className="inline-flex justify-self-end items-center gap-1.5 px-2.5 py-1.5 text-xs bg-slate-100 hover:bg-slate-200 rounded-md transition-colors disabled:opacity-50"
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      Clear
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Exhausted Email Failures */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Mail className="h-5 w-5" />
          Exhausted Email Failures
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Active failures</p>
            <p className="text-2xl font-bold text-red-600">
              {emailFailures.summary.activeCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Archived</p>
            <p className="text-2xl font-bold text-slate-900">
              {emailFailures.summary.reviewedCount}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Retry limit</p>
            <p className="text-2xl font-bold text-slate-900">
              {emailFailures.summary.maxAttempts}
            </p>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm text-slate-500">Scanned</p>
            <p className="text-2xl font-bold text-slate-900">
              {emailFailures.summary.scannedCount}
            </p>
          </div>
        </div>

        {emailFailures.failures.length === 0 ? (
          <div className="bg-white border rounded-lg p-4 text-slate-500">
            No active exhausted email failures.
          </div>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto">
            <div className="min-w-[900px]">
              <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_140px_90px_140px_88px] gap-3 px-4 py-2 text-xs font-medium text-slate-500 bg-slate-50 border-b">
                <span>Recipient</span>
                <span>Subject</span>
                <span>Template</span>
                <span>Attempts</span>
                <span>Last attempt</span>
                <span className="text-right">Action</span>
              </div>
              <div className="divide-y">
                {emailFailures.failures.map((failure) => (
                  <div
                    key={failure.id}
                    className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_140px_90px_140px_88px] gap-3 px-4 py-3 text-sm items-center"
                  >
                    <span className="font-medium text-slate-900 truncate">
                      {failure.to}
                    </span>
                    <span className="text-slate-700 truncate" title={failure.subject}>
                      {failure.subject}
                    </span>
                    <span className="text-slate-600 truncate">
                      {failure.templateName}
                    </span>
                    <span className="text-slate-600">{failure.attempts}</span>
                    <span className="text-slate-500">
                      {formatDate(failure.lastAttemptAt)}
                    </span>
                    <button
                      onClick={() => archiveEmailFailure(failure.id, failure.to)}
                      disabled={reviewingEmailFailureId === failure.id}
                      className="inline-flex justify-self-end items-center gap-1.5 px-2.5 py-1.5 text-xs bg-slate-100 hover:bg-slate-200 rounded-md transition-colors disabled:opacity-50"
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      Archive
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* System Info */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Server className="h-5 w-5" />
          System Info
        </h2>
        <div className="bg-white border rounded-lg p-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-slate-500">Memory (RSS)</p>
              <p className="text-lg font-medium">{systemInfo.memoryMb.rss} MB</p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Heap Used</p>
              <p className="text-lg font-medium">
                {systemInfo.memoryMb.heapUsed} / {systemInfo.memoryMb.heapTotal} MB
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Sentry</p>
              <p className="text-lg font-medium">
                {systemInfo.sentryConfigured ? (
                  <span className="text-green-600">Connected</span>
                ) : (
                  <span className="text-slate-400">Not configured</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Uptime</p>
              <p className="text-lg font-medium">{formatUptime(systemInfo.uptime)}</p>
            </div>
          </div>
          {systemInfo.sentryDashboardUrl && (
            <div className="mt-3 pt-3 border-t">
              <a
                href={systemInfo.sentryDashboardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:underline"
              >
                Open Sentry Dashboard
              </a>
            </div>
          )}
          {systemInfo.sentryConfigWarning && (
            <div className="mt-3 pt-3 border-t text-sm text-amber-700 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{systemInfo.sentryConfigWarning}</span>
            </div>
          )}
        </div>
      </div>

      {/* Cron Job Status */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Clock className="h-5 w-5" />
          Cron Jobs
        </h2>
        {(cronHealth
          ? cronHealth.jobs.length === 0
          : Object.keys(cronJobs).length === 0) ? (
          <div className="bg-white border rounded-lg p-4 text-slate-500">
            No cron job runs recorded yet.
          </div>
        ) : (
          <div className="space-y-4">
            {cronHealth?.jobs.map((job) => {
              const runs = cronJobs[job.jobName] ?? [];

              return (
                <div key={job.jobName} className="bg-white border rounded-lg">
                  <div className="p-4 border-b bg-slate-50">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-medium text-slate-900">{job.label}</h3>
                          <span className="font-mono text-xs text-slate-500">
                            {job.jobName}
                          </span>
                        </div>
                        <p className="text-sm text-slate-600 mt-1">{job.summary}</p>
                      </div>
                      <StatusBadge status={job.status} />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3 text-sm">
                      <div>
                        <p className="text-xs text-slate-500">Schedule</p>
                        <p className="font-mono text-slate-700 break-words">
                          {job.schedule}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500">Expected</p>
                        <p className="text-slate-700">{job.expectedLocalTime}</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500">Timezone</p>
                        <p className="text-slate-700">{job.timezone}</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500">Stale threshold</p>
                        <p className="text-slate-700">
                          {job.staleThreshold ?? "Not tracked"}
                        </p>
                      </div>
                    </div>
                    {(job.disabledReason || job.note) && (
                      <div className="mt-3 text-sm text-slate-600 space-y-1">
                        {job.disabledReason && <p>{job.disabledReason}</p>}
                        {job.note && <p>{job.note}</p>}
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 text-xs text-slate-500">
                      <p>Latest run: {formatOptionalDate(job.latestRunAt)}</p>
                      <p>Latest success: {formatOptionalDate(job.latestSuccessAt)}</p>
                      <p>Latest failure: {formatOptionalDate(job.latestFailureAt)}</p>
                    </div>
                  </div>
                  <div className="divide-y">
                    {!job.recordsRuns ? (
                      <div className="p-3 text-sm text-slate-500">
                        CronJobRun history is not recorded for this scheduled job.
                      </div>
                    ) : runs.length === 0 ? (
                      <div className="p-3 text-sm text-slate-500">
                        No cron runs recorded yet.
                      </div>
                    ) : (
                      runs.map((run) => (
                        <div key={run.id} className="p-3 flex items-center justify-between text-sm">
                          <div className="flex items-center gap-3">
                            <StatusBadge status={run.status} />
                            <span className="text-slate-600">{formatDate(run.startedAt)}</span>
                          </div>
                          <div className="flex items-center gap-4 text-slate-500">
                            {run.durationMs != null && <span>{run.durationMs}ms</span>}
                            {run.error && <CronError error={run.error} />}
                            {run.resultSummary && <CronResultSummary summary={run.resultSummary} />}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            }) ??
              Object.entries(cronJobs).map(([jobName, runs]) => (
                <div key={jobName} className="bg-white border rounded-lg">
                  <div className="p-4 border-b bg-slate-50">
                    <h3 className="font-medium text-slate-900">{jobName}</h3>
                  </div>
                  <div className="divide-y">
                    {runs.map((run) => (
                      <div key={run.id} className="p-3 flex items-center justify-between text-sm">
                        <div className="flex items-center gap-3">
                          <StatusBadge status={run.status} />
                          <span className="text-slate-600">{formatDate(run.startedAt)}</span>
                        </div>
                        <div className="flex items-center gap-4 text-slate-500">
                          {run.durationMs != null && <span>{run.durationMs}ms</span>}
                          {run.error && <CronError error={run.error} />}
                          {run.resultSummary && <CronResultSummary summary={run.resultSummary} />}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Webhook Stats */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Webhook className="h-5 w-5" />
          Webhooks (Last 24h)
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          {Object.keys(webhookStats).length === 0 ? (
            <div className="bg-white border rounded-lg p-4 text-slate-500 col-span-2">
              No webhook activity in the last 24 hours.
            </div>
          ) : (
            Object.entries(webhookStats).map(([source, stats]) => (
              <div key={source} className="bg-white border rounded-lg p-4">
                <h3 className="font-medium text-slate-900 capitalize mb-2">{source}</h3>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-2xl font-bold text-green-600">{stats.success}</p>
                    <p className="text-xs text-slate-500">Success</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-red-600">{stats.failure}</p>
                    <p className="text-xs text-slate-500">Failed</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-slate-700">{stats.total}</p>
                    <p className="text-xs text-slate-500">Total</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Recent Webhook Logs */}
        {recentWebhooks.length > 0 && (
          <div className="bg-white border rounded-lg">
            <div className="p-4 border-b bg-slate-50">
              <h3 className="font-medium text-slate-900">Recent Webhook Events</h3>
            </div>
            <div className="divide-y">
              {recentWebhooks.map((wh) => (
                <div key={wh.id} className="p-3 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-3">
                    <StatusBadge status={wh.status} />
                    <span className="font-mono text-slate-600">{wh.source}</span>
                    <span className="text-slate-500">{wh.eventType}</span>
                  </div>
                  <div className="flex items-center gap-3 text-slate-500">
                    <span>{wh.durationMs}ms</span>
                    <span>{formatDate(wh.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
