"use client";

import { useCallback, useMemo, useState } from "react";
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
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import {
  useSectionEditState,
  ForbiddenSaveError,
} from "@/hooks/use-section-edit-state";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";
import {
  CONFIG_URL,
  RUN_URL,
  STATUS_URL,
  readError,
  type BackupStatus,
} from "@/app/(admin)/admin/backups/backups-client";

/**
 * Local (on-host) database backups.
 *
 * Its own file rather than another section inside `backups-client.tsx`, which
 * is already the largest file in this area: the panel carries three distinct
 * jobs — staged configuration, an immediate run, and a restore — and folding
 * them into the shell would have made the shell harder to read for everyone,
 * including the people maintaining the S3 half.
 *
 * The privilege split is the same one the S3 panel uses, and it is deliberate:
 * the ENABLE switch is support:edit (operational), while the DIRECTORY is
 * Full-Admin only, because whoever chooses where a full `pg_dump` lands can
 * send the whole database somewhere they can read it. Restore is Full-Admin
 * too, on stronger grounds — it overwrites production irreversibly.
 */

const RESTORE_URL = "/api/admin/backups/restore";

interface LocalDraft {
  localEnabled: boolean;
  localPath: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * The disk-space line, coloured by the owner's thresholds: yellow under 5 GB,
 * red under 1 GB.
 *
 * `role="alert"` on the red state only. A warning that announces itself to a
 * screen reader every poll would be noise; running OUT of room, on the feature
 * whose whole job is to have a copy, is worth interrupting for.
 */
function DiskSpaceLine({ status }: { status: BackupStatus }) {
  const space = status.localDiskSpace;
  if (!space) {
    return (
      <p className="text-sm text-muted-foreground">
        Disk space: unknown — the backup directory could not be measured.
      </p>
    );
  }
  const available = formatBytes(space.availableBytes);
  const total = formatBytes(space.totalBytes);
  if (space.level === "critical") {
    return (
      <p role="alert" className="text-sm font-medium text-danger">
        Disk space: {available} free of {total}. This is below 1 GB — backups
        are likely to fail. Free space or choose another directory.
      </p>
    );
  }
  if (space.level === "warning") {
    return (
      <p className="text-sm font-medium text-warning-11">
        Disk space: {available} free of {total}. This is below 5 GB — check
        there is room for the backups you are keeping.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      Disk space: {available} free of {total}.
    </p>
  );
}

export function LocalBackupCard({
  status,
  canEdit,
  canManageDestination,
  onSaved,
  ancestorRendersViewOnlyBanner = false,
}: {
  status: BackupStatus;
  canEdit: boolean | undefined;
  canManageDestination: boolean;
  onSaved: () => Promise<BackupStatus | null>;
  /**
   * #2168's vouch: TRUE only when the parent really does render an
   * `AdminViewOnlySectionBanner` above this card, passed as a literal at the
   * render site. Defaulting to FALSE is the safety — this card lives in its own
   * file, so rendering it standalone, in a dialog, or under some future parent
   * keeps each button's own view-only reason rather than silently deleting the
   * explanation.
   */
  ancestorRendersViewOnlyBanner?: boolean;
}) {
  const pathHint = useFieldHint();
  const section = useSectionEditState<LocalDraft>({
    initial: {
      localEnabled: status.localEnabled,
      localPath: status.localPath ?? "",
    },
    load: async () => {
      const res = await fetch(STATUS_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Could not load config."));
      const data = (await res.json()) as BackupStatus;
      return {
        localEnabled: data.localEnabled,
        localPath: data.localPath ?? "",
      };
    },
    save: async (draft, saved) => {
      const payload: Record<string, unknown> = {};
      if (!saved || draft.localEnabled !== saved.localEnabled) {
        payload.localEnabled = draft.localEnabled;
      }
      if (!saved || draft.localPath !== saved.localPath) {
        payload.localPath = draft.localPath;
      }
      const res = await fetch(CONFIG_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 403) throw new ForbiddenSaveError();
      if (!res.ok) {
        throw new Error(await readError(res, "Could not save local backup settings."));
      }
      await onSaved();
      return { localEnabled: draft.localEnabled, localPath: draft.localPath };
    },
    successMessage: "Local backup settings saved.",
    // The directory is MANDATORY once the switch is on — a local backup with
    // nowhere to write is a tick that silently does nothing. The server refuses
    // the same combination; this only stops the officer submitting it.
    isValid: (draft) => !draft.localEnabled || draft.localPath.trim().length > 0,
  });

  // A backup file's modification time is a real INSTANT (CT-4, #2870).
  const clubTime = useClubTime();
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState("");
  const [runError, setRunError] = useState("");

  // Memoised so the `selectedFilename` memo below is not invalidated on every
  // render by a fresh array literal.
  const backups = useMemo(() => status.localBackups ?? [], [status.localBackups]);
  const latest = backups[0]?.filename ?? "";
  const [selected, setSelected] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState("");
  const [restoreError, setRestoreError] = useState("");

  // Defaults to the LATEST backup, and follows it as new ones land, until the
  // officer picks one — then their choice stands.
  const selectedFilename = useMemo(
    () => (selected && backups.some((b) => b.filename === selected) ? selected : latest),
    [selected, latest, backups],
  );

  const onRunNow = useCallback(async () => {
    setRunError("");
    setRunMessage("");
    setRunning(true);
    try {
      const res = await fetch(RUN_URL, { method: "POST" });
      if (!res.ok) {
        setRunError(await readError(res, "Could not start the backup."));
        return;
      }
      setRunMessage("Backup started. Progress appears under Status and Recent runs.");
      await onSaved();
    } catch {
      setRunError("Could not start the backup.");
    } finally {
      setRunning(false);
    }
  }, [onSaved]);

  const onRestore = useCallback(async () => {
    setRestoreError("");
    setRestoreMessage("");
    setRestoring(true);
    try {
      const res = await fetch(RESTORE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: selectedFilename, confirm: "RESTORE" }),
      });
      if (!res.ok) {
        setRestoreError(await readError(res, "The restore failed."));
        return;
      }
      const data = (await res.json()) as {
        filename: string;
        memberCount: number;
        bookingCount: number;
      };
      setRestoreMessage(
        `Restored ${data.filename}: ${data.memberCount} members and ${data.bookingCount} bookings are in the database. Sign out and back in if anything looks stale.`,
      );
      setConfirming(false);
      await onSaved();
    } catch {
      setRestoreError("The restore failed.");
    } finally {
      setRestoring(false);
    }
  }, [selectedFilename, onSaved]);

  const draft = section.draft;
  if (!draft) return null;
  const editingDisabled = !section.editing || section.saving;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Local backup</CardTitle>
            <CardDescription>
              Keep a copy of each backup in a directory on the server. Uses the
              same retention as above; older files are deleted automatically.
            </CardDescription>
          </div>
          {!section.editing ? (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={!ancestorRendersViewOnlyBanner}
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
            id="local-backup-enabled"
            type="checkbox"
            className="h-4 w-4 rounded border-input accent-primary"
            checked={draft.localEnabled}
            disabled={editingDisabled}
            onChange={(e) => section.setDraft({ localEnabled: e.target.checked })}
          />
          <Label htmlFor="local-backup-enabled" className="cursor-pointer">
            Enable local backups
          </Label>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="local-backup-path">Backup directory</Label>
          <Input
            id="local-backup-path"
            value={draft.localPath}
            required
            disabled={editingDisabled || !canManageDestination}
            onChange={(e) => section.setDraft({ localPath: e.target.value })}
            {...pathHint.fieldProps}
          />
          {/*
            Deployment-NEUTRAL on purpose (INV-CONFIG-001). An earlier draft of
            this hint asserted "this application runs in a container", which is
            true of one deployment and false for an adopter running the app
            directly on a host - and it told that adopter they cannot write
            where in fact they can. The container case is stated as a condition
            they can evaluate, not as a fact about their system.

            The "outside the application directory" clause is load-bearing, not
            padding: `resolveLocalBackupDirectory` REFUSES such a path, because
            anything under the app root risks being served over the web. Saying
            so here is what stops the officer discovering the rule as a refusal.

            Where the value came from is NOT stated here. The paragraph below
            says it, and only when `status.localPathFromEnv` says it is true.
          */}
          <FieldHint {...pathHint.hintProps}>
            A full path outside the application directory, on a volume that
            survives a restart. If this deployment runs in a container, it must
            be a path inside the container — a directory mounted into it, not a
            path on the host.
          </FieldHint>
          {status.localPathFromEnv ? (
            <p className="text-xs text-muted-foreground">
              Filled in from this deployment&apos;s configuration
              (BACKUP_LOCAL_DIR). Leave it as it is unless the mount has moved.
            </p>
          ) : null}
          {section.editing && !canManageDestination ? (
            <p className="text-xs text-muted-foreground">
              Changing the backup directory requires Full Admin access.
            </p>
          ) : null}
          {section.editing && draft.localEnabled && !draft.localPath.trim() ? (
            <p className="text-xs text-danger">
              Enter a directory before enabling local backups.
            </p>
          ) : null}
        </div>

        {status.localError ? (
          <p role="alert" className="text-sm text-danger">
            {status.localError}
          </p>
        ) : null}
        {status.localPath ? <DiskSpaceLine status={status} /> : null}

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
              describeReason={!ancestorRendersViewOnlyBanner}
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

        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">Manual backup</p>
          <p className="text-sm text-muted-foreground">
            Runs a backup now, to every destination that is enabled. It runs in
            the background; watch Status and Recent runs for the result.
          </p>
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={!ancestorRendersViewOnlyBanner}
            onClick={onRunNow}
            // The same conditions the Status card's run button uses — the two
            // press the same endpoint, so a button that looks available here and
            // 409s there would be worse than a disabled one.
            disabled={
              running ||
              status.running ||
              !status.anyDestinationEnabled ||
              status.needsReentry
            }
          >
            {running || status.running ? "Backup running…" : "Manual Backup"}
          </ViewOnlyActionButton>
          {!status.anyDestinationEnabled && !status.running ? (
            <p className="text-sm text-warning">
              Enable a backup destination first — tick <strong>Enable local
              backups</strong> above and save, or enable the nightly S3 backup.
            </p>
          ) : null}
          {runError ? (
            <p role="alert" className="text-sm text-danger">
              {runError}
            </p>
          ) : null}
          {runMessage ? (
            <p role="status" className="text-sm text-success">
              {runMessage}
            </p>
          ) : null}
        </div>

        {/*
          Restore. Full-Admin only, and deliberately the least inviting control
          on the page: it replaces the live database with the chosen file, and
          everything since that file was written is gone. The two-step confirm
          exists so it can never be one stray click.
        */}
        <div className="space-y-2 rounded-md border border-danger-6 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            Restore a backup (Full Admin only)
          </p>
          {backups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {status.localPath
                ? "No backups in the directory yet."
                : "Set a backup directory to restore from one."}
            </p>
          ) : (
            <>
              <div className="grid gap-2 sm:max-w-md">
                <Label htmlFor="local-backup-restore">Backup to restore</Label>
                <select
                  id="local-backup-restore"
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={selectedFilename}
                  disabled={!canManageDestination || restoring}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setConfirming(false);
                  }}
                >
                  {backups.map((backup, index) => (
                    <option key={backup.filename} value={backup.filename}>
                      {clubTime.instantDateTime(requireInstant(backup.modifiedAt))} ·{" "}
                      {formatBytes(backup.sizeBytes)}
                      {index === 0 ? " (latest)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              {!canManageDestination ? (
                <p className="text-sm text-muted-foreground">
                  Restoring a backup requires Full Admin access.
                </p>
              ) : !confirming ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setRestoreError("");
                    setRestoreMessage("");
                    setConfirming(true);
                  }}
                >
                  Restore this backup…
                </Button>
              ) : (
                <div className="space-y-2">
                  <p role="alert" className="text-sm font-medium text-danger">
                    This replaces the live database with this backup. Every
                    booking, payment and member change made since it was taken
                    will be lost, and this cannot be undone.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      onClick={onRestore}
                      disabled={restoring}
                    >
                      {restoring ? "Restoring…" : "Yes, overwrite the database"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setConfirming(false)}
                      disabled={restoring}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
          {restoreError ? (
            <p role="alert" className="text-sm text-danger">
              {restoreError}
            </p>
          ) : null}
          {restoreMessage ? (
            <p role="status" className="text-sm text-success">
              {restoreMessage}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
