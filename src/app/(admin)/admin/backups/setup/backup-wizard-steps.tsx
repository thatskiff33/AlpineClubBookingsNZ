"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import {
  ViewOnlyActionButton,
  type AncestorViewOnlyBannerProps,
} from "@/components/admin/view-only-action";
import { ADMIN_FULL_ADMIN_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import {
  MIN_BACKUP_RETENTION_DAYS,
  MAX_BACKUP_RETENTION_DAYS,
} from "@/lib/backup-config-shared";
import type { BackupWizardContext } from "./use-backup-wizard-context";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";

const CREDENTIALS_ENDPOINT = "/api/admin/integrations/credentials";
const CONFIG_ENDPOINT = "/api/admin/backups/config";
const RUN_ENDPOINT = "/api/admin/backups/run";

/** Human-readable size for the verified backup object (base-1024). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Write a write-only secret through the shared C1 credentials route (Full Admin). */
async function writeCredential(key: string, value: string): Promise<void> {
  const res = await fetch(CREDENTIALS_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "backup", key, value }),
  });
  if (!res.ok) throw new Error(await apiErrorMessageFromResponse(res, `Could not save ${key}.`));
}

/** Write non-secret backup configuration through the backups config route. */
async function writeConfig(payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(CONFIG_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(await apiErrorMessageFromResponse(res, "Could not save the configuration."));
  }
}

function SetStatus({ set }: { set: boolean }) {
  return (
    <span className="text-xs">
      {set ? (
        <span className="text-success-11">Set ✓</span>
      ) : (
        <span className="text-muted-foreground">Not set</span>
      )}
    </span>
  );
}

function ErrorAlert({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11"
    >
      {message}
    </div>
  );
}

function SuccessAlert({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11"
    >
      {message}
    </div>
  );
}

/**
 * Migration callout (step 1): legacy BACKUP_* env vars are detected. Names the
 * values the operator must re-enter here — field names only, NEVER any value —
 * and lists the detected env var names so they can be removed afterwards. The
 * louder danger tone is used when those vars are set but backups are silently
 * NOT running (legacyEnvUnmigrated).
 */
export function MigrationCallout({
  context,
}: {
  context: BackupWizardContext;
}) {
  if (context.legacyEnvVars.length === 0) return null;
  const danger = context.legacyEnvUnmigrated;
  const tone = danger
    ? "border-danger-6 bg-danger-3 text-danger-11"
    : "border-warning-6 bg-warning-3 text-warning-11";
  return (
    <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${tone}`}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        {danger ? (
          <p>
            Legacy backup environment variables are still set, but backups are
            disabled or not configured for durable (S3) storage — so nightly
            backups are <strong>not running</strong>. Re-enter the configuration
            in this wizard to resume them.
          </p>
        ) : (
          <p>
            Legacy backup environment variables were detected. They are no longer
            read; re-enter the configuration in this wizard, then remove them.
          </p>
        )}
        <p>
          Re-enter these values as you go: the S3{" "}
          <strong>access key ID</strong> and <strong>secret access key</strong>{" "}
          on this step, then the <strong>bucket</strong> and{" "}
          <strong>region</strong> on the destination step. Afterwards remove:{" "}
          <code className="font-mono">{context.legacyEnvVars.join(", ")}</code>.
        </p>
      </div>
    </div>
  );
}

/** Step 1 — "S3 credentials": write-only access key id + secret → C1 route. */
export function CredentialsStep({
  context,
  helpers,
}: {
  context: BackupWizardContext;
  helpers: WizardStepHelpers;
}) {
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const canWrite = context.canManageDestination;
  const bothSet = context.accessKeyIdSet && context.secretAccessKeySet;
  const dirty = Boolean(accessKeyId.trim() || secretAccessKey.trim());

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      if (accessKeyId.trim())
        await writeCredential("access_key_id", accessKeyId.trim());
      if (secretAccessKey.trim())
        await writeCredential("secret_access_key", secretAccessKey.trim());
      setAccessKeyId("");
      setSecretAccessKey("");
      setSuccess("Saved. Stored values are write-only and never shown again.");
      helpers.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Enter your S3 credentials
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Backups upload to an S3-compatible bucket. Paste the access key ID and
          secret access key for an IAM user (or equivalent) that can write to
          that bucket. Both are encrypted at rest and never shown again; entering
          a new value replaces the old one.
        </p>
      </div>

      <MigrationCallout context={context} />

      {context.needsReentry ? (
        <div className="flex items-start gap-2 rounded-md border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            A stored backup credential can no longer be read (the app encryption
            key changed). Re-enter both values below to restore backups.
          </span>
        </div>
      ) : null}

      {!canWrite ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Only a <strong>Full Admin</strong> can enter or replace the S3
            credentials. You can view the status here.
          </span>
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="backup-wizard-access-key">S3 access key ID</Label>
          <SetStatus set={context.accessKeyIdSet} />
        </div>
        <Input
          id="backup-wizard-access-key"
          autoComplete="off"
          placeholder={context.accessKeyIdSet ? "Enter a new value to replace" : ""}
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
          disabled={!canWrite || saving}
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="backup-wizard-secret-key">S3 secret access key</Label>
          <SetStatus set={context.secretAccessKeySet} />
        </div>
        <Input
          id="backup-wizard-secret-key"
          type="password"
          autoComplete="new-password"
          placeholder={
            context.secretAccessKeySet ? "Enter a new value to replace" : ""
          }
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
          disabled={!canWrite || saving}
        />
      </div>

      <ErrorAlert message={error} />
      <SuccessAlert message={success} />

      <div className="flex items-center gap-3">
        {/* KEEPS its own reason (#2324). The wizard banner states `support`;
            writing the S3 credentials additionally needs Full Admin, so a
            support-edit admin without it sees no banner and a dead button. */}
        <ViewOnlyActionButton
          type="button"
          canEdit={canWrite}
          readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : bothSet ? "Replace credentials" : "Save credentials"}
        </ViewOnlyActionButton>
        {bothSet ? (
          <span className="inline-flex items-center gap-1 text-sm text-success-11">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Both credentials stored
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Step 2 — "Destination": bucket + region → backups config route (Full Admin). */
export function DestinationStep({
  context,
  helpers,
}: {
  context: BackupWizardContext;
  helpers: WizardStepHelpers;
}) {
  // #2264 — worded identically to the same two fields on the Backups settings
  // page (backups-client.tsx), which are their twins.
  const bucketHint = useFieldHint();
  const regionHint = useFieldHint();
  const [bucket, setBucket] = useState(context.bucket ?? "");
  const [region, setRegion] = useState(context.region);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const canWrite = context.canManageDestination;
  const dirty =
    bucket.trim() !== (context.bucket ?? "") || region.trim() !== context.region;

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await writeConfig({ bucket: bucket.trim(), region: region.trim() });
      setSuccess("Destination saved.");
      helpers.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Choose the backup destination
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The bucket and region are where each nightly dump is uploaded. They are
          not secret, but repointing the destination sends the whole database
          dump elsewhere — so only a Full Admin can change them.
        </p>
      </div>

      {!canWrite ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Only a <strong>Full Admin</strong> can change the backup destination.
          </span>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="backup-wizard-bucket">Bucket</Label>
          <Input
            id="backup-wizard-bucket"
            autoComplete="off"
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            disabled={!canWrite || saving}
            {...bucketHint.fieldProps}
          />
          <FieldHint {...bucketHint.hintProps}>
            Example: my-club-backups
          </FieldHint>
        </div>
        <div className="space-y-1">
          <Label htmlFor="backup-wizard-region">Region</Label>
          <Input
            id="backup-wizard-region"
            autoComplete="off"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            disabled={!canWrite || saving}
            {...regionHint.fieldProps}
          />
          <FieldHint {...regionHint.hintProps}>
            Example: ap-southeast-2
          </FieldHint>
        </div>
      </div>

      <ErrorAlert message={error} />
      <SuccessAlert message={success} />

      <div className="flex items-center gap-3">
        {/* KEEPS its own reason (#2324) — Full Admin, not the banner's
            `support` scope. Same reasoning as the credentials step above. */}
        <ViewOnlyActionButton
          type="button"
          canEdit={canWrite}
          readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
          onClick={() => void handleSave()}
          disabled={!bucket.trim() || !dirty || saving}
        >
          {saving ? "Saving…" : "Save destination"}
        </ViewOnlyActionButton>
        {context.bucket ? (
          <span className="inline-flex items-center gap-1 text-sm text-success-11">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {`s3://${context.bucket} (${context.region})`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Step 3 — "Operational": enabled toggle + retention → config route (support:edit). */
export function OperationalStep({
  context,
  helpers,
  ancestorRendersViewOnlyBanner = false,
}: {
  context: BackupWizardContext;
  helpers: WizardStepHelpers;
} & AncestorViewOnlyBannerProps) {
  const [enabled, setEnabled] = useState(context.enabled);
  const [retentionDays, setRetentionDays] = useState(context.retentionDays);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const canWrite = helpers.canEdit === true;
  const validRetention =
    retentionDays >= MIN_BACKUP_RETENTION_DAYS &&
    retentionDays <= MAX_BACKUP_RETENTION_DAYS;
  const dirty =
    enabled !== context.enabled || retentionDays !== context.retentionDays;

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await writeConfig({ enabled, retentionDays });
      setSuccess("Backup configuration saved.");
      helpers.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Turn on nightly backups
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Enable the scheduled nightly backup and choose how many days of local
          backup files to keep. These operational settings need support edit
          access (not Full Admin).
        </p>
      </div>

      {/* The "your role can view but not change these settings" sentence that
          used to sit here has gone (#2324), for the same two reasons as the one
          on the verification step below: the shell's view-only banner states
          exactly that, for exactly this scope (`support`), once at the top of
          the wizard — and this copy was keyed off `!canWrite`, which is also
          true while the session is still resolving, so it flashed at admins who
          CAN change these settings. */}

      <div className="flex items-center gap-3">
        <input
          id="backup-wizard-enabled"
          type="checkbox"
          className="h-4 w-4 rounded border-input accent-primary"
          checked={enabled}
          disabled={!canWrite || saving}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <Label htmlFor="backup-wizard-enabled" className="cursor-pointer">
          Enable nightly database backups
        </Label>
      </div>

      <div className="grid gap-2 sm:max-w-xs">
        <Label htmlFor="backup-wizard-retention">Retention (days)</Label>
        <Input
          id="backup-wizard-retention"
          type="number"
          min={MIN_BACKUP_RETENTION_DAYS}
          max={MAX_BACKUP_RETENTION_DAYS}
          value={retentionDays}
          disabled={!canWrite || saving}
          onChange={(e) =>
            setRetentionDays(Number.parseInt(e.target.value, 10) || 0)
          }
        />
      </div>

      <ErrorAlert message={error} />
      <SuccessAlert message={success} />

      <div className="flex items-center gap-3">
        {/* Gated on the wizard's OWN scope (`support`), which is exactly what
            the shell's banner states — so this one drops its per-button reason
            and leans on the shell's vouch (#2324). */}
        <ViewOnlyActionButton
          type="button"
          canEdit={helpers.canEdit}
          describeReason={!ancestorRendersViewOnlyBanner}
          onClick={() => void handleSave()}
          disabled={!dirty || !validRetention || saving}
        >
          {saving ? "Saving…" : "Save"}
        </ViewOnlyActionButton>
        {context.enabled ? (
          <span className="inline-flex items-center gap-1 text-sm text-success-11">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Nightly backups enabled
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Step 4 — "Verification run": fire a real backup and confirm it uploaded and
 * read back from S3. The completion badge appears when the latest run reports
 * SUCCESS with `s3ReadbackVerified` (the backups equivalent of Stripe's
 * webhook-verified badge), showing the S3 key and object size.
 *
 * Mechanism: the button POSTs to the existing run endpoint (which dispatches a
 * background job and returns 202); the shared context hook then polls the
 * existing status route and derives `verified` from the newest run's
 * metadata-only resultSummary. No new backend surface is added.
 */
export function VerificationStep({
  context,
  helpers,
  ancestorRendersViewOnlyBanner = false,
}: {
  context: BackupWizardContext;
  helpers: WizardStepHelpers;
} & AncestorViewOnlyBannerProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const canRun = helpers.canEdit === true;
  const notEnabled = !context.enabled;
  const notDurable = !context.durable;
  const blocked =
    starting ||
    context.running ||
    notEnabled ||
    notDurable ||
    context.needsReentry;

  async function runVerification() {
    setError("");
    setStarting(true);
    try {
      const res = await fetch(RUN_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok && res.status !== 202) {
        setError(await apiErrorMessageFromResponse(res, "Could not start a verification backup."));
        return;
      }
      helpers.refresh();
    } catch {
      setError("Could not start a verification backup.");
    } finally {
      setStarting(false);
    }
  }

  // The specific reason the action is unavailable (beyond the view-only gate the
  // shell banner already states), shown inline so it is never a silent grey-out.
  let blockedReason = "";
  if (context.needsReentry) {
    blockedReason =
      "Re-enter the S3 credentials on step 1 — the stored ones can’t be decrypted.";
  } else if (notDurable) {
    blockedReason =
      "Set the S3 credentials and destination on the earlier steps first.";
  } else if (notEnabled) {
    blockedReason = "Enable nightly backups on the previous step first.";
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Run a verification backup
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          This runs a real <code>pg_dump</code> now, uploads it to your S3
          destination, and reads it back to confirm the whole path works. It runs
          in the background and can take several minutes; this step updates when
          it finishes.
        </p>
      </div>

      {/* The "you need support edit access" sentence that used to sit here has
          gone (#2324): the shell's view-only banner states exactly that, for
          exactly this scope, once at the top of the wizard. Saying it again
          beside the button was the same statement twice — and it was keyed off
          `!canRun`, which is also true while the session is still resolving, so
          it flashed at admins who CAN run a backup. */}
      <ErrorAlert message={error} />

      <div className="flex flex-wrap items-center gap-3">
        {/* `support`-gated, the wizard's own scope — vouched (#2324). */}
        <ViewOnlyActionButton
          type="button"
          canEdit={helpers.canEdit}
          describeReason={!ancestorRendersViewOnlyBanner}
          onClick={() => void runVerification()}
          disabled={blocked}
        >
          {context.running || starting ? (
            <>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
              Running…
            </>
          ) : (
            "Run verification backup"
          )}
        </ViewOnlyActionButton>
        {canRun && !context.running && blockedReason ? (
          <span className="text-sm text-warning-11">{blockedReason}</span>
        ) : null}
      </div>

      {context.verified ? (
        <div className="flex items-start gap-2 rounded-md border border-success-6 bg-success-3 p-3 text-sm text-success-11">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p>
              Verified — the backup uploaded to S3 and was read back
              successfully.
            </p>
            {context.verifiedS3Key ? (
              <p className="break-all">
                Object: <code className="font-mono">{context.verifiedS3Key}</code>
                {context.verifiedSizeBytes != null
                  ? ` (${formatBytes(context.verifiedSizeBytes)})`
                  : ""}
              </p>
            ) : null}
          </div>
        </div>
      ) : context.running ? (
        <div className="flex items-start gap-2 rounded-md border border-info-6 bg-info-3 p-3 text-sm text-info-11">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden />
          <span>
            A backup is running now. This can take several minutes; the result
            will appear here automatically.
          </span>
        </div>
      ) : context.latestRunFailed ? (
        <div className="flex items-start gap-2 rounded-md border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            The last backup run failed
            {context.latestRunError ? `: ${context.latestRunError}` : ""}. Fix
            the cause and run the verification again.
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Not verified yet. Run a verification backup to confirm durable, S3
            read-back-verified backups are working.
          </span>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Once verified, manage day-to-day backup settings and history on the{" "}
        <Link
          href="/admin/backups"
          className="font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          Database Backups
        </Link>{" "}
        page.
      </p>
    </div>
  );
}
