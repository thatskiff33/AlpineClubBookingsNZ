"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import {
  formatClubInstantCompactDateTime,
  parseInstant,
  type BoundClubTime,
} from "@/lib/club-time";
import { formatCents } from "@/lib/utils";
import { useClubFormat } from "@/components/club-format-provider";

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ok: "bg-success-3 text-success-11",
    healthy: "bg-success-3 text-success-11",
    SUCCESS: "bg-success-3 text-success-11",
    success: "bg-success-3 text-success-11",
    current: "bg-success-3 text-success-11",
    degraded: "bg-warning-3 text-warning-11",
    SKIPPED: "bg-warning-3 text-warning-11",
    skipped: "bg-warning-3 text-warning-11",
    stale: "bg-warning-3 text-warning-11",
    missing: "bg-warning-3 text-warning-11",
    error: "bg-danger-3 text-danger-11",
    unhealthy: "bg-danger-3 text-danger-11",
    FAILURE: "bg-danger-3 text-danger-11",
    failure: "bg-danger-3 text-danger-11",
    failed: "bg-danger-3 text-danger-11",
    BOUNCE: "bg-danger-3 text-danger-11",
    COMPLAINT: "bg-danger-3 text-danger-11",
    disabled: "bg-muted text-muted-foreground",
    untracked: "bg-muted text-muted-foreground",
    unknown: "bg-muted text-foreground",
  };

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[status] || colors.unknown}`}
    >
      {status}
    </span>
  );
}

export function StatusIcon({ status }: { status: string }) {
  if (status === "ok" || status === "healthy" || status === "SUCCESS" || status === "success") {
    return <CheckCircle className="h-5 w-5 text-success-11" />;
  }
  if (status === "degraded" || status === "SKIPPED") {
    return <AlertTriangle className="h-5 w-5 text-warning-11" />;
  }
  return <XCircle className="h-5 w-5 text-danger-11" />;
}

export function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// #2264: deliberately not the medium date-time — the health dashboard packs
// many timestamps into narrow rows, so it drops the year and keeps 2-digit
// fields. Every value passed here is a real INSTANT — a cron run, a bounce, an
// escalation — never a calendar day, so it is projected through the club's
// PERSISTED zone (CT-4, #2870; INV-CONFIG-002).
//
// #3566 moved it onto the kernel's `compactDateTime` house shape, which the
// stuck-states "generated at" stamp shares. It was a local formatter here,
// memoised on the locale and zone pair (#3564), and an identical one on that
// page built from the BUILD's locale, so the two screens could disagree about
// one moment. The binding now carries both the zone and the club's locale, so
// a bare locale string can no longer be transposed with `dateStr`.
export function formatDate(clubTime: BoundClubTime, dateStr: string) {
  // Guarded, unlike the `new Date()` this replaces: a health payload is read
  // from a live system and a row with an unparseable stamp must not blank the
  // dashboard. An offset-less ISO string is refused rather than read in the
  // host's zone, which is the defect class this epic closes.
  const instant = parseInstant(dateStr);
  if (instant === null) return "unknown";
  return formatClubInstantCompactDateTime(
    instant,
    clubTime.zone,
    clubTime.format,
  );
}

export function formatOptionalDate(
  clubTime: BoundClubTime,
  dateStr: string | null,
) {
  return dateStr ? formatDate(clubTime, dateStr) : "Not recorded";
}

export function CronError({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = error.length > 80;

  if (!isLong) {
    return <span className="text-danger-11">{error}</span>;
  }

  return (
    <button
      onClick={() => setExpanded((e) => !e)}
      className="text-left text-danger-11 max-w-xs"
    >
      {expanded ? (
        <span className="whitespace-pre-wrap break-words">{error}</span>
      ) : (
        <span>{error.slice(0, 80)}... <span className="text-danger-11 underline text-xs">show more</span></span>
      )}
    </button>
  );
}

export function CronResultSummary({ summary }: { summary: Record<string, unknown> }) {
  const format = useClubFormat();
  const healthSignal = typeof summary.healthSignal === "string" ? summary.healthSignal : null;
  const sizeBytes = typeof summary.sizeBytes === "number" ? summary.sizeBytes : null;
  const minSizeBytes = typeof summary.minSizeBytes === "number" ? summary.minSizeBytes : null;
  const reason = typeof summary.reason === "string" ? summary.reason : null;

  // #2501 credit-sync check: a completed pass records `driftBookings` /
  // `totalDriftCents` in its result summary. Without an explicit indicator here
  // a drift-finding run still shows a green SUCCESS row (the run itself did not
  // fail — it found and reported drift), so an admin scanning the dashboard
  // would see nothing. Surface the drift count + amount as a warning so the
  // dashboard indicator named in issue #2501's scope is actually present.
  const driftBookings =
    typeof summary.driftBookings === "number" ? summary.driftBookings : null;
  if (driftBookings !== null) {
    const totalDriftCents =
      typeof summary.totalDriftCents === "number" ? summary.totalDriftCents : 0;
    if (driftBookings > 0) {
      return (
        <span className="text-xs font-medium text-danger-11">
          {driftBookings} credit drift ({formatCents(totalDriftCents, format)})
        </span>
      );
    }
    return (
      <span className="text-xs text-muted-foreground">Credits in sync</span>
    );
  }

  if (healthSignal || sizeBytes !== null) {
    return (
      <span className="text-xs text-muted-foreground">
        {healthSignal ? `${healthSignal}` : "backup"}{" "}
        {sizeBytes !== null ? `${sizeBytes} bytes` : ""}
        {minSizeBytes !== null ? ` / min ${minSizeBytes}` : ""}
      </span>
    );
  }

  if (reason) {
    return <span className="text-xs text-muted-foreground">{reason}</span>;
  }

  return null;
}
