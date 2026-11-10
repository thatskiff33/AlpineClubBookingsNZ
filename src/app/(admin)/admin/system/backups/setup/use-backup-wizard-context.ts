"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Derives the database-backup setup wizard's server truth (#2227) — the
 * `context` the reusable shell verifies each step against. Everything here is
 * LIVE server state from the existing `/api/admin/backups/status` route
 * (credential presence metadata, destination, operational config, run history +
 * the S3-readback verification of the latest run), so step gating can never be
 * faked by a stale persisted cursor.
 *
 * NO new backend surface is introduced: the wizard reuses the same read route
 * the flat backups page already polls. It never receives any secret value — the
 * status route returns only booleans, the non-secret bucket/region, retention,
 * the needs-reentry flag, and metadata-only run summaries (exposure contract,
 * #2079).
 */

/** Metadata-only backup run summary, as returned by the status route. */
export interface BackupRunSummary {
  id: string;
  status: "RUNNING" | "SUCCESS" | "FAILURE" | "SKIPPED";
  trigger: "scheduled" | "manual";
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  resultSummary: unknown;
  triggeredByMemberId: string | null;
}

interface BackupStatusResponse {
  enabled: boolean;
  bucket: string | null;
  region: string;
  retentionDays: number;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
  restoreValidationUrlSet: boolean;
  durable: boolean;
  needsReentry: boolean;
  running: boolean;
  activeRun: BackupRunSummary | null;
  recentRuns: BackupRunSummary[];
  legacyEnvVars: string[];
  legacyEnvUnmigrated: boolean;
  cronSchedule: string;
  canManageDestination: boolean;
}

export interface BackupWizardContext {
  /** Legacy BACKUP_* env vars still present (server-detected); empty when clean. */
  legacyEnvVars: string[];
  /**
   * The dangerous migration state: legacy env vars are still set but the in-app
   * config is disabled or not durable, so nightly backups are silently NOT
   * running. Drives the louder migration callout on step 1.
   */
  legacyEnvUnmigrated: boolean;
  /** Whether each write-only S3 secret is stored — never the value. */
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
  /** Destination bucket (not secret) or null when local-only. */
  bucket: string | null;
  region: string;
  /** Operational config. */
  enabled: boolean;
  retentionDays: number;
  /** True when backups will upload durably (bucket + both S3 secrets present). */
  durable: boolean;
  /** A stored backup credential no longer decrypts (the app auth secret changed). */
  needsReentry: boolean;
  /** Whether the viewer may write the destination + credentials (Full Admin). */
  canManageDestination: boolean;
  /** A backup run is in progress right now. */
  running: boolean;
  /** The most recent run (any status), or null when none recorded. */
  latestRun: BackupRunSummary | null;
  /**
   * The verification gate: the most recent run finished SUCCESS and its S3
   * read-back was verified. This is the backups equivalent of Stripe's
   * webhook-verified badge — proof the whole dump → upload → read-back path
   * works end to end.
   */
  verified: boolean;
  /** The verified run's S3 object key, shown on success. */
  verifiedS3Key: string | null;
  /** The verified run's uploaded size in bytes, shown on success. */
  verifiedSizeBytes: number | null;
  /** The most recent run finished FAILURE (drives the retry guidance). */
  latestRunFailed: boolean;
  /** The most recent run's redacted error message, when it failed. */
  latestRunError: string | null;
}

const STATUS_ENDPOINT = "/api/admin/backups/status";

const EMPTY_CONTEXT: BackupWizardContext = {
  legacyEnvVars: [],
  legacyEnvUnmigrated: false,
  accessKeyIdSet: false,
  secretAccessKeySet: false,
  bucket: null,
  region: "",
  enabled: false,
  retentionDays: 0,
  durable: false,
  needsReentry: false,
  canManageDestination: false,
  running: false,
  latestRun: null,
  verified: false,
  verifiedS3Key: null,
  verifiedSizeBytes: null,
  latestRunFailed: false,
  latestRunError: null,
};

interface RunReadback {
  s3ReadbackVerified: boolean;
  s3Key: string | null;
  sizeBytes: number | null;
}

/** Safely lift the read-back fields off a run's metadata-only resultSummary. */
function readReadback(run: BackupRunSummary | null): RunReadback {
  const summary = run?.resultSummary;
  if (!summary || typeof summary !== "object") {
    return { s3ReadbackVerified: false, s3Key: null, sizeBytes: null };
  }
  const rec = summary as Record<string, unknown>;
  return {
    s3ReadbackVerified: rec.s3ReadbackVerified === true,
    s3Key: typeof rec.s3Key === "string" ? rec.s3Key : null,
    sizeBytes: typeof rec.sizeBytes === "number" ? rec.sizeBytes : null,
  };
}

function toContext(data: BackupStatusResponse): BackupWizardContext {
  const latestRun = data.recentRuns[0] ?? null;
  const readback = readReadback(latestRun);
  const verified =
    latestRun?.status === "SUCCESS" && readback.s3ReadbackVerified;
  return {
    legacyEnvVars: data.legacyEnvVars,
    legacyEnvUnmigrated: data.legacyEnvUnmigrated,
    accessKeyIdSet: data.accessKeyIdSet,
    secretAccessKeySet: data.secretAccessKeySet,
    bucket: data.bucket,
    region: data.region,
    enabled: data.enabled,
    retentionDays: data.retentionDays,
    durable: data.durable,
    needsReentry: data.needsReentry,
    canManageDestination: data.canManageDestination,
    running: data.running,
    latestRun,
    verified,
    verifiedS3Key: verified ? readback.s3Key : null,
    verifiedSizeBytes: verified ? readback.sizeBytes : null,
    latestRunFailed: latestRun?.status === "FAILURE",
    latestRunError: latestRun?.status === "FAILURE" ? latestRun.error : null,
  };
}

export function useBackupWizardContext(): {
  context: BackupWizardContext;
  loading: boolean;
  refresh: () => void;
} {
  const [context, setContext] = useState<BackupWizardContext>(EMPTY_CONTEXT);
  const [loading, setLoading] = useState(true);
  const runningRef = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(STATUS_ENDPOINT, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as BackupStatusResponse;
        setContext(toContext(data));
        runningRef.current = Boolean(data.running);
        return Boolean(data.running);
      }
    } catch {
      // Leave the last-known state; the wizard degrades to "not verified".
    } finally {
      setLoading(false);
    }
    return runningRef.current;
  }, []);

  // Poll faster while a verification run is in progress, slower when idle, so the
  // step-4 completion badge appears without the operator refreshing the page.
  useEffect(() => {
    let cancelled = false;
    const schedule = (running: boolean) => {
      if (cancelled) return;
      pollTimer.current = setTimeout(
        async () => {
          const stillRunning = await load();
          schedule(stillRunning);
        },
        running ? 4000 : 20000,
      );
    };
    void load().then((running) => schedule(running));
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { context, loading, refresh };
}
