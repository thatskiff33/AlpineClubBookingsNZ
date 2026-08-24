"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  AdminViewOnlyNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  useSectionEditState,
  ForbiddenSaveError,
} from "@/hooks/use-section-edit-state";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant, type BoundClubTime } from "@/lib/club-time";
import { LocalBackupCard } from "@/app/(admin)/admin/backups/local-backup-card";

interface BackupRunSummary {
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

export interface LocalBackupFileSummary {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface LocalBackupDiskSpaceSummary {
  availableBytes: number;
  totalBytes: number;
  level: "ok" | "warning" | "critical";
}

export interface BackupStatus {
  enabled: boolean;
  bucket: string | null;
  region: string;
  retentionDays: number;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
  restoreValidationUrlSet: boolean;
  localEnabled: boolean;
  localPath: string | null;
  /** The path came from the deployment's mount rather than a saved value. */
  localPathFromEnv: boolean;
  /** Either destination switched on — what actually decides whether a run happens. */
  anyDestinationEnabled: boolean;
  localBackups: LocalBackupFileSummary[];
  /** Null when the directory could not be measured — shown as unknown, never as fine. */
  localDiskSpace: LocalBackupDiskSpaceSummary | null;
  localError: string | null;
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

interface ConfigDraft {
  enabled: boolean;
  retentionDays: number;
  bucket: string;
  region: string;
}

export const STATUS_URL = "/api/admin/backups/status";
export const CONFIG_URL = "/api/admin/backups/config";
export const RUN_URL = "/api/admin/backups/run";
const CREDENTIALS_URL = "/api/admin/integrations/credentials";

export async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

// Backup completion and run-start stamps are real INSTANTS, shown in the
// club's persisted zone rather than the viewer's (CT-4, #2870; INV-CONFIG-002).
function formatDateTime(clubTime: BoundClubTime, iso: string | null): string {
  if (!iso) return "—";
  return clubTime.instantDateTime(requireInstant(iso));
}

function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "muted" | "info";
  children: React.ReactNode;
}) {
  const toneClass = {
    success: "bg-success-muted text-success",
    warning: "bg-warning-muted text-warning",
    danger: "bg-danger-muted text-danger",
    info: "bg-info-muted text-info",
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

function runTone(status: BackupRunSummary["status"]) {
  switch (status) {
    case "SUCCESS":
      return "success" as const;
    case "RUNNING":
      return "info" as const;
    case "SKIPPED":
      return "muted" as const;
    default:
      return "danger" as const;
  }
}

export function BackupsClient() {
  const canEdit = useAdminAreaEditAccess("support");

  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [loading, setLoading] = useState(true);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(STATUS_URL, { cache: "no-store" });
      if (!res.ok) {
        setStatusError(await readError(res, "Could not load backup status."));
        return null;
      }
      const data = (await res.json()) as BackupStatus;
      setStatus(data);
      setStatusError("");
      return data;
    } catch {
      setStatusError("Could not load backup status.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll faster while a run is in progress, slower when idle.
  useEffect(() => {
    let cancelled = false;
    const schedule = (running: boolean) => {
      if (cancelled) return;
      pollTimer.current = setTimeout(
        async () => {
          const data = await loadStatus();
          schedule(Boolean(data?.running));
        },
        running ? 4000 : 20000,
      );
    };
    void loadStatus().then((data) => schedule(Boolean(data?.running)));
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [loadStatus]);

  const canManageDestination = status?.canManageDestination ?? false;

  // #2160 blueprint: one section banner, hoisted above the loading early-return
  // and rendered in every branch. The role="status" wrapper stays mounted so the
  // live region is registered before its content resolves (canEdit is tri-state
  // and settles after hydration). It sits OUTSIDE the space-y-6 stack so the
  // empty wrapper an edit-capable admin gets costs no layout.
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view backup status but cannot change configuration or
      run a backup. Support edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <>
      {viewOnlyBanner}
      <div className="space-y-6">
      {statusError ? (
        <div
          role="alert"
          className="rounded-md border border-danger bg-danger-muted px-4 py-3 text-sm text-danger"
        >
          {statusError}
        </div>
      ) : null}

      {loading && !status ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> Loading backup status…
        </div>
      ) : status ? (
        <>
          <StatusCard
            status={status}
            canEdit={canEdit}
            onRan={loadStatus}
          />
          <S3BackupCard
            status={status}
            canEdit={canEdit}
            canManageDestination={canManageDestination}
            onSaved={loadStatus}
          />
          <LocalBackupCard
            status={status}
            canEdit={canEdit}
            canManageDestination={canManageDestination}
            onSaved={loadStatus}
            // #2168: this shell renders `viewOnlyBanner` above every branch, so
            // it vouches for the card's buttons handing their explanation to it
            // rather than each repeating a reason. The literal is required AT
            // the render site — that is what makes the vouch checkable.
            ancestorRendersViewOnlyBanner={true}
          />
          <RecentRunsCard runs={status.recentRuns} />
        </>
      ) : null}
      </div>
    </>
  );
}

function StatusCard({
  status,
  canEdit,
  onRan,
}: {
  status: BackupStatus;
  canEdit: boolean | undefined;
  onRan: () => Promise<BackupStatus | null>;
}) {
  const clubTime = useClubTime();
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");

  const lastSuccess = status.recentRuns.find((r) => r.status === "SUCCESS");

  const runNow = useCallback(async () => {
    setRunError("");
    setRunning(true);
    try {
      const res = await fetch(RUN_URL, { method: "POST" });
      if (!res.ok && res.status !== 202) {
        setRunError(await readError(res, "Could not start a backup."));
        return;
      }
      await onRan();
    } catch {
      setRunError("Could not start a backup.");
    } finally {
      setRunning(false);
    }
  }, [onRan]);

  // canEdit gating is handled by ViewOnlyActionButton; these are the additional
  // run-specific reasons the button stays disabled.
  // `anyDestinationEnabled`, not `enabled`: the S3 switch alone is not what
  // decides whether a backup can run once a local destination exists.
  const disableRun =
    running ||
    status.running ||
    !status.anyDestinationEnabled ||
    status.needsReentry;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Status</CardTitle>
          <div className="flex items-center gap-2">
            {status.anyDestinationEnabled ? (
              <StatusPill tone="success">Enabled</StatusPill>
            ) : (
              <StatusPill tone="muted">Disabled</StatusPill>
            )}
            {status.durable ? (
              <StatusPill tone="success">S3 durable</StatusPill>
            ) : (
              <StatusPill tone="warning">Local only</StatusPill>
            )}
            {status.running ? (
              <StatusPill tone="info">Running…</StatusPill>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.needsReentry ? (
          <div
            role="alert"
            className="rounded-md border border-danger bg-danger-muted px-3 py-2 text-sm text-danger"
          >
            Stored backup credentials could not be decrypted (the app encryption
            key changed). Backups are failing. Re-enter the S3 credentials below.
          </div>
        ) : null}

        {status.legacyEnvUnmigrated ? (
          <div
            role="alert"
            className="rounded-md border border-danger bg-danger-muted px-3 py-2 text-sm text-danger"
          >
            Legacy backup environment variables are still set, but backups are
            disabled or not configured for durable (S3) storage here. Those
            variables are no longer read, so nightly backups are NOT running.
            Re-enter the configuration below to resume them, then remove:{" "}
            <span className="font-mono">
              {status.legacyEnvVars.join(", ")}
            </span>
            . The{" "}
            <Link
              href="/admin/backups/setup"
              className="font-medium underline underline-offset-4"
            >
              guided backup setup
            </Link>{" "}
            walks through re-entering each value.
          </div>
        ) : status.legacyEnvVars.length > 0 ? (
          <div className="rounded-md border border-warning bg-warning-muted px-3 py-2 text-sm text-warning">
            These environment variables are no longer used and should be removed
            after re-entering the configuration here:{" "}
            <span className="font-mono">
              {status.legacyEnvVars.join(", ")}
            </span>
            .
          </div>
        ) : null}

        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">
              Destination
            </dt>
            <dd className="text-sm text-foreground">
              {status.bucket
                ? `s3://${status.bucket} (${status.region})`
                : "Local only (not durable)"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">
              Retention
            </dt>
            <dd className="text-sm text-foreground">
              {status.retentionDays} day{status.retentionDays === 1 ? "" : "s"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">
              Last successful backup
            </dt>
            <dd className="text-sm text-foreground">
              {formatDateTime(clubTime, lastSuccess?.completedAt ?? null)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">
              Nightly schedule (cron)
            </dt>
            <dd className="font-mono text-sm text-foreground">
              {status.cronSchedule}
            </dd>
          </div>
        </dl>

        {runError ? (
          <p role="alert" className="text-sm text-danger">
            {runError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            onClick={runNow}
            disabled={disableRun}
          >
            {running || status.running ? (
              <>
                <Spinner className="h-4 w-4" /> Running…
              </>
            ) : (
              "Run backup now"
            )}
          </ViewOnlyActionButton>
          <p className="text-xs text-muted-foreground">
            Runs <code>pg_dump</code> against the live database now. A full
            backup can take several minutes; it runs in the background and this
            page updates when it finishes.
          </p>
        </div>

        {/* Disabled-reason hint (#2227): the run button greys out for several
            reasons. needsReentry and running already have their own alert/pill
            above, so the one otherwise-silent case is "backups disabled". */}
        {!status.anyDestinationEnabled && !status.needsReentry && !status.running ? (
          <p className="text-sm text-warning">
            Enable backups below first.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function S3BackupCard({
  status,
  canEdit,
  canManageDestination,
  onSaved,
}: {
  status: BackupStatus;
  canEdit: boolean | undefined;
  canManageDestination: boolean;
  onSaved: () => Promise<BackupStatus | null>;
}) {
  // #2264 — bucket/region examples move under their fields; parked in the
  // placeholder they read as a destination already configured.
  const bucketHint = useFieldHint();
  const regionHint = useFieldHint();
  const section = useSectionEditState<ConfigDraft>({
    initial: {
      enabled: status.enabled,
      retentionDays: status.retentionDays,
      bucket: status.bucket ?? "",
      region: status.region,
    },
    load: async () => {
      const res = await fetch(STATUS_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Could not load config."));
      const data = (await res.json()) as BackupStatus;
      return {
        enabled: data.enabled,
        retentionDays: data.retentionDays,
        bucket: data.bucket ?? "",
        region: data.region,
      };
    },
    save: async (draft, saved) => {
      const payload: Record<string, unknown> = {};
      if (!saved || draft.enabled !== saved.enabled) payload.enabled = draft.enabled;
      if (!saved || draft.retentionDays !== saved.retentionDays) {
        payload.retentionDays = draft.retentionDays;
      }
      if (!saved || draft.bucket !== saved.bucket) payload.bucket = draft.bucket;
      if (!saved || draft.region !== saved.region) payload.region = draft.region;

      const res = await fetch(CONFIG_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 403) throw new ForbiddenSaveError();
      if (!res.ok) {
        throw new Error(await readError(res, "Could not save configuration."));
      }
      await onSaved();
      // Re-seed from the freshly persisted values.
      return {
        enabled: payload.enabled !== undefined ? draft.enabled : saved?.enabled ?? draft.enabled,
        retentionDays: draft.retentionDays,
        bucket: draft.bucket,
        region: draft.region,
      };
    },
    successMessage: "Backup configuration saved.",
    isValid: (draft) =>
      draft.retentionDays >= 1 &&
      draft.retentionDays <= 3650 &&
      (draft.bucket.trim() === "" ||
        /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(draft.bucket.trim())) &&
      (draft.region.trim() === "" || /^[a-z0-9-]+$/.test(draft.region.trim())),
  });

  const draft = section.draft;
  if (!draft) return null;

  const editingDisabled = !section.editing || section.saving;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>AWS S3 Backup</CardTitle>
            <CardDescription>
              The enabled switch and retention are operational settings; the S3
              destination and credentials are Full-Admin only.
            </CardDescription>
          </div>
          {!section.editing ? (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={section.startEditing}
            >
              Edit
            </ViewOnlyActionButton>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <input
            id="backup-enabled"
            type="checkbox"
            className="h-4 w-4 rounded border-input accent-primary"
            checked={draft.enabled}
            disabled={editingDisabled}
            onChange={(e) => section.setDraft({ enabled: e.target.checked })}
          />
          <Label htmlFor="backup-enabled" className="cursor-pointer">
            Enable nightly database backups
          </Label>
        </div>

        <div className="grid gap-2 sm:max-w-xs">
          <Label htmlFor="backup-retention">Retention (days)</Label>
          <Input
            id="backup-retention"
            type="number"
            min={1}
            max={3650}
            value={draft.retentionDays}
            disabled={editingDisabled}
            onChange={(e) =>
              section.setDraft({
                retentionDays: Number.parseInt(e.target.value, 10) || 0,
              })
            }
          />
        </div>

        <div className="rounded-md border border-border p-3">
          <p className="mb-3 text-xs font-medium text-muted-foreground">
            S3 destination (Full Admin only)
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="backup-bucket">Bucket</Label>
              <Input
                id="backup-bucket"
                value={draft.bucket}
                disabled={editingDisabled || !canManageDestination}
                onChange={(e) => section.setDraft({ bucket: e.target.value })}
                {...bucketHint.fieldProps}
              />
              <FieldHint {...bucketHint.hintProps}>
                Example: my-club-backups
              </FieldHint>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="backup-region">Region</Label>
              <Input
                id="backup-region"
                value={draft.region}
                disabled={editingDisabled || !canManageDestination}
                onChange={(e) => section.setDraft({ region: e.target.value })}
                {...regionHint.fieldProps}
              />
              <FieldHint {...regionHint.hintProps}>
                Example: ap-southeast-2
              </FieldHint>
            </div>
          </div>
          {section.editing && !canManageDestination ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Changing the destination requires Full Admin access.
            </p>
          ) : null}
        </div>

        {section.error ? (
          <p role="alert" className="text-sm text-danger">
            {section.error}
          </p>
        ) : null}
        {section.success ? (
          <p role="status" className="text-sm text-success">
            {section.success}
          </p>
        ) : null}

        {section.editing ? (
          <div className="flex gap-2">
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              onClick={section.save}
              disabled={!section.dirty || !section.valid || section.saving}
            >
              {section.saving ? "Saving…" : "Save"}
            </ViewOnlyActionButton>
            <Button
              variant="outline"
              onClick={section.cancelEditing}
              disabled={section.saving}
            >
              Cancel
            </Button>
          </div>
        ) : null}

        {/*
          The credentials, folded into this panel rather than sitting in their
          own card (owner request). They keep their OWN save button, and that is
          not cosmetic: secrets are written write-only through the shared
          Full-Admin credentials route, while the fields above go through the
          support:edit backups config route. One save button over both would
          either post secrets on a support admin's ordinary config save or
          silently drop them.
        */}
        <CredentialsSection
          status={status}
          canManageDestination={canManageDestination}
          onSaved={onSaved}
        />
      </CardContent>
    </Card>
  );
}

function CredentialsSection({
  status,
  canManageDestination,
  onSaved,
}: {
  status: BackupStatus;
  canManageDestination: boolean;
  onSaved: () => Promise<BackupStatus | null>;
}) {
  // #2264 — the shadow-database URL example moves into the note already sitting
  // under the field (promoted, not stacked), so it survives the first keystroke.
  const restoreUrlHint = useFieldHint();
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [restoreUrl, setRestoreUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const writeCredential = useCallback(async (key: string, value: string) => {
    const res = await fetch(CREDENTIALS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "backup", key, value }),
    });
    if (!res.ok) {
      throw new Error(await readError(res, "Could not save the credential."));
    }
  }, []);

  const onSave = useCallback(async () => {
    setError("");
    setSuccess("");
    const pending: Array<[string, string]> = [];
    if (accessKeyId.trim()) pending.push(["access_key_id", accessKeyId.trim()]);
    if (secretAccessKey.trim())
      pending.push(["secret_access_key", secretAccessKey.trim()]);
    if (restoreUrl.trim())
      pending.push(["restore_validation_url", restoreUrl.trim()]);
    if (pending.length === 0) {
      setError("Enter at least one value to save.");
      return;
    }
    setSaving(true);
    try {
      for (const [key, value] of pending) {
        await writeCredential(key, value);
      }
      setAccessKeyId("");
      setSecretAccessKey("");
      setRestoreUrl("");
      setSuccess("Saved. Stored values are write-only and never shown again.");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }, [accessKeyId, secretAccessKey, restoreUrl, writeCredential, onSaved]);

  return (
    <div className="space-y-4 rounded-md border border-border p-3">
      <div>
        <p className="text-xs font-medium text-muted-foreground">
          Credentials (Full Admin only)
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Write-only. Enter a value to set or replace it; stored secrets are
          never displayed. Leave a field blank to keep the current value.
        </p>
      </div>
      {!canManageDestination ? (
          <AdminViewOnlyNotice canEdit={false}>
            Only a Full Admin can set backup credentials.
          </AdminViewOnlyNotice>
        ) : null}

        <div className="grid gap-2">
          <Label htmlFor="backup-access-key">
            S3 access key ID{" "}
            <StatusPill tone={status.accessKeyIdSet ? "success" : "muted"}>
              {status.accessKeyIdSet ? "Set" : "Not set"}
            </StatusPill>
          </Label>
          <Input
            id="backup-access-key"
            autoComplete="off"
            value={accessKeyId}
            disabled={!canManageDestination || saving}
            onChange={(e) => setAccessKeyId(e.target.value)}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="backup-secret-key">
            S3 secret access key{" "}
            <StatusPill tone={status.secretAccessKeySet ? "success" : "muted"}>
              {status.secretAccessKeySet ? "Set" : "Not set"}
            </StatusPill>
          </Label>
          <Input
            id="backup-secret-key"
            type="password"
            autoComplete="new-password"
            value={secretAccessKey}
            disabled={!canManageDestination || saving}
            onChange={(e) => setSecretAccessKey(e.target.value)}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="backup-restore-url">
            Restore-validation shadow database URL (optional){" "}
            <StatusPill tone={status.restoreValidationUrlSet ? "success" : "muted"}>
              {status.restoreValidationUrlSet ? "Set" : "Not set"}
            </StatusPill>
          </Label>
          <Input
            id="backup-restore-url"
            type="password"
            autoComplete="new-password"
            value={restoreUrl}
            disabled={!canManageDestination || saving}
            onChange={(e) => setRestoreUrl(e.target.value)}
            {...restoreUrlHint.fieldProps}
          />
          <FieldHint {...restoreUrlHint.hintProps}>
            When set, each backup is restored into this disposable database and
            smoke-checked. It must NOT point at the live database. Example:
            postgresql://…/shadow_db
          </FieldHint>
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

      <Button onClick={onSave} disabled={!canManageDestination || saving}>
        {saving ? "Saving…" : "Save credentials"}
      </Button>
    </div>
  );
}

function RecentRunsCard({ runs }: { runs: BackupRunSummary[] }) {
  const clubTime = useClubTime();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent runs</CardTitle>
      </CardHeader>
      <CardContent>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No backup runs recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {runs.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="flex items-center gap-2">
                  <StatusPill tone={runTone(run.status)}>{run.status}</StatusPill>
                  <span className="text-sm text-foreground">
                    {formatDateTime(clubTime, run.startedAt)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ({run.trigger})
                  </span>
                </div>
                {run.error ? (
                  <span className="max-w-md truncate text-xs text-danger" title={run.error}>
                    {run.error}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
