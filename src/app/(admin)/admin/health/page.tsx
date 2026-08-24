"use client";

import Link from "next/link";
import {
  Activity,
  Database,
  CreditCard,
  RefreshCw,
  Mail,
  Server,
  AlertTriangle,
  Webhook,
  Clock,
  ChevronRight,
} from "lucide-react";
import { StatusBadge, StatusIcon, formatUptime, formatDate } from "./_components/shared";
import { useClubTime } from "@/components/club-time-provider";
import { useHealthData } from "./_components/use-health-data";
import type { HealthCheck } from "./_components/types";

export default function AdminHealthPage() {
  // `lastRefresh` is a real INSTANT — the moment the health payload was
  // fetched — so it is shown in the club's persisted zone, not the viewer's
  // (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();
  const { data, loading, error, lastRefresh, refresh } = useHealthData();

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-foreground mb-6">System Health</h1>
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 bg-muted rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-foreground mb-6">System Health</h1>
        <div className="bg-danger-3 border border-danger-6 rounded-lg p-4 text-danger-11">
          Failed to load health data: {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { health, webhookStats, recentWebhooks, systemInfo } = data;
  const checkEntries = Object.entries(health.checks) as [string, HealthCheck][];
  const checkIcons: Record<string, typeof Database> = {
    db: Database,
    config: AlertTriangle,
    stripe: CreditCard,
    xero: RefreshCw,
    smtp: Mail,
    paymentRecovery: CreditCard,
  };
  // Friendly names for check keys the backend reports in camelCase.
  const checkLabels: Record<string, string> = {
    db: "Database",
    smtp: "SMTP",
    paymentRecovery: "Payment recovery",
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">System Health</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            Last refresh: {clubTime.instantTime(lastRefresh)}
          </span>
          <button
            onClick={refresh}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-muted hover:bg-accent rounded-md transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Overall Status */}
      <div className="bg-card border rounded-lg p-4 flex items-center gap-4">
        <StatusIcon status={health.status} />
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            System is {health.status}
          </h2>
          <p className="text-sm text-muted-foreground">
            Version {systemInfo.version} &middot; Node {systemInfo.nodeVersion} &middot; Uptime {formatUptime(systemInfo.uptime)}
          </p>
        </div>
      </div>

      {/* Service Checks */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Service Checks
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {checkEntries.map(([name, check]) => {
            const Icon = checkIcons[name] || Server;
            return (
              <div key={name} className="bg-card border rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium text-foreground capitalize">
                      {checkLabels[name] ?? name}
                    </span>
                  </div>
                  <StatusBadge status={check.status} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {check.status === "ok"
                    ? `${check.latencyMs}ms`
                    : check.error || "Error"}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Related monitoring */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Link
          href="/admin/email-deliverability"
          className="bg-card border rounded-lg p-4 flex items-center justify-between hover:border-brand-gold/70 transition-colors"
        >
          <div className="flex items-center gap-3">
            <Mail className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="font-medium text-foreground">Email Deliverability</p>
              <p className="text-sm text-muted-foreground">Suppressions &amp; exhausted failures</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
        <Link
          href="/admin/background-jobs"
          className="bg-card border rounded-lg p-4 flex items-center justify-between hover:border-brand-gold/70 transition-colors"
        >
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="font-medium text-foreground">Background Jobs</p>
              <p className="text-sm text-muted-foreground">Cron job health &amp; run history</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      </div>

      {/* System Info */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
          <Server className="h-5 w-5" />
          System Info
        </h2>
        <div className="bg-card border rounded-lg p-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Memory (RSS)</p>
              <p className="text-lg font-medium">{systemInfo.memoryMb.rss} MB</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Heap Used</p>
              <p className="text-lg font-medium">
                {systemInfo.memoryMb.heapUsed} / {systemInfo.memoryMb.heapTotal} MB
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Sentry</p>
              <p className="text-lg font-medium">
                {systemInfo.sentryConfigured ? (
                  <span className="text-success-11">Connected</span>
                ) : (
                  <span className="text-muted-foreground">Not configured</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Uptime</p>
              <p className="text-lg font-medium">{formatUptime(systemInfo.uptime)}</p>
            </div>
          </div>
          {systemInfo.sentryDashboardUrl && (
            <div className="mt-3 pt-3 border-t">
              <a
                href={systemInfo.sentryDashboardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-info-11 hover:underline"
              >
                Open Sentry Dashboard
              </a>
            </div>
          )}
          {systemInfo.sentryConfigWarning && (
            <div className="mt-3 pt-3 border-t text-sm text-warning-11 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{systemInfo.sentryConfigWarning}</span>
            </div>
          )}
        </div>
      </div>

      {/* Webhook Stats */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
          <Webhook className="h-5 w-5" />
          Webhooks (Last 24h)
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          {Object.keys(webhookStats).length === 0 ? (
            <div className="bg-card border rounded-lg p-4 text-muted-foreground col-span-2">
              No webhook activity in the last 24 hours.
            </div>
          ) : (
            Object.entries(webhookStats).map(([source, stats]) => (
              <div key={source} className="bg-card border rounded-lg p-4">
                <h3 className="font-medium text-foreground capitalize mb-2">{source}</h3>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-2xl font-bold text-success-11">{stats.success}</p>
                    <p className="text-xs text-muted-foreground">Success</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-danger-11">{stats.failure}</p>
                    <p className="text-xs text-muted-foreground">Failed</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-muted-foreground">{stats.total}</p>
                    <p className="text-xs text-muted-foreground">Total</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Recent Webhook Logs */}
        {recentWebhooks.length > 0 && (
          <div className="bg-card border rounded-lg">
            <div className="p-4 border-b bg-muted">
              <h3 className="font-medium text-foreground">Recent Webhook Events</h3>
            </div>
            <div className="divide-y">
              {recentWebhooks.map((wh) => (
                <div key={wh.id} className="p-3 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-3">
                    <StatusBadge status={wh.status} />
                    <span className="font-mono text-muted-foreground">{wh.source}</span>
                    <span className="text-muted-foreground">{wh.eventType}</span>
                  </div>
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <span>{wh.durationMs}ms</span>
                    <span>{formatDate(clubTime, wh.createdAt)}</span>
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
