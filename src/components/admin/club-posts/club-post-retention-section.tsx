"use client";

import { useState } from "react";

import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useSectionEditState } from "@/hooks/use-section-edit-state";
import { useClubTime } from "@/components/club-time-provider";
import { RETENTION_CHOICES } from "@/lib/club-post-retention-choices";

interface RetentionDraft {
  retentionDays: number;
}

/**
 * Club message board retention (#2999, epic #2992).
 *
 * A settings section, so unlike the moderation queue beside it this follows the
 * canonical staged-edit model: read-only on mount, Edit -> Save/Cancel, Cancel
 * restores the snapshot, and Save is dirty-gated by the hook rather than by a
 * comparison in the route.
 *
 * This setting deletes member content on a schedule, so the screen says how
 * many posts the chosen window would remove BEFORE it is saved — using the
 * server's own count rather than an estimate.
 */
export function ClubPostRetentionSection({
  initialRetentionDays,
  initialBeyondRetention,
  lastCleanupAt,
  lastCleanupDeleted,
}: {
  initialRetentionDays: number;
  initialBeyondRetention: number;
  lastCleanupAt: string | null;
  lastCleanupDeleted: number;
}) {
  const club = useClubTime();

  const canEdit = useAdminAreaEditAccess("membership");
  const [beyond, setBeyond] = useState(initialBeyondRetention);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const section = useSectionEditState<RetentionDraft>({
    initial: { retentionDays: initialRetentionDays },
    // Names the consequence rather than saying "Saved": this setting is the one
    // on the page that deletes things later, so the confirmation should say
    // which way it now points.
    successMessage: (saved) =>
      saved.retentionDays === 0
        ? "Saved. Posts will be kept indefinitely."
        : `Saved. Posts older than ${saved.retentionDays} days will be deleted.`,
    saveErrorFallback: "That setting could not be saved.",
    save: async (draft) => {
      const res = await fetch("/api/admin/club-posts/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retentionDays: draft.retentionDays }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? "That setting could not be saved.");
      }
      const body = (await res.json()) as {
        settings: { retentionDays: number };
        beyondRetention: number;
      };
      setBeyond(body.beyondRetention);
      // Re-seeded from what the SERVER returned, never from the local draft.
      return { retentionDays: body.settings.retentionDays };
    },
  });

  async function runCleanup() {
    setCleaning(true);
    setCleanupMessage(null);
    try {
      const res = await fetch("/api/admin/club-posts/cleanup", {
        method: "POST",
      });
      if (!res.ok) throw new Error("The cleanup could not be run.");
      const outcome = (await res.json()) as {
        skipped?: "disabled" | "busy";
        deleted: number;
      };
      setCleanupMessage(
        outcome.skipped === "disabled"
          ? "Nothing was deleted: posts are set to be kept indefinitely."
          : outcome.skipped === "busy"
            ? "A cleanup was already running, so this one did nothing. Try again shortly."
            : `Deleted ${outcome.deleted} post${outcome.deleted === 1 ? "" : "s"}.`,
      );
      setBeyond(0);
    } catch (error) {
      setCleanupMessage(
        error instanceof Error ? error.message : "The cleanup could not be run.",
      );
    } finally {
      setCleaning(false);
    }
  }

  const draft = section.draft ?? { retentionDays: initialRetentionDays };
  const keepsEverything = draft.retentionDays === 0;

  // THE FRAME: banner and both feedback regions render in every state, so the
  // section is never mounted together with an already-populated alert.
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Retention</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <AdminViewOnlySectionBanner canEdit={canEdit}>
          You can see how long posts are kept but not change it. Ask an
          administrator with membership access.
        </AdminViewOnlySectionBanner>

        {section.error ? <Alert variant="error">{section.error}</Alert> : null}
        {section.success ? (
          <Alert variant="success">{section.success}</Alert>
        ) : null}
        {cleanupMessage ? <Alert>{cleanupMessage}</Alert> : null}

        <div className="space-y-2">
          <Label htmlFor="club-post-retention">Keep posts for</Label>
          <select
            id="club-post-retention"
            className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60"
            value={draft.retentionDays}
            disabled={!section.editing || section.saving}
            onChange={(event) =>
              section.setDraft({ retentionDays: Number(event.target.value) })
            }
          >
            {RETENTION_CHOICES.map((choice) => (
              <option key={choice.days} value={choice.days}>
                {choice.label}
              </option>
            ))}
          </select>

          <p className="text-sm text-muted-foreground">
            {keepsEverything
              ? "Nothing is deleted automatically. Posts stay until an administrator removes them."
              : "Posts older than this are deleted permanently by a job that runs every few hours. This cannot be undone, and hidden posts are deleted too."}
          </p>

          {!keepsEverything && beyond > 0 ? (
            <p className="text-sm font-medium text-destructive">
              {beyond} post{beyond === 1 ? "" : "s"} on the board{" "}
              {beyond === 1 ? "is" : "are"} already older than this and would be
              deleted.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {section.editing ? (
            <>
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                size="sm"
                disabled={!section.dirty || section.saving}
                onClick={() => void section.save()}
              >
                {section.saving ? "Saving…" : "Save"}
              </ViewOnlyActionButton>
              <Button
                size="sm"
                variant="outline"
                disabled={section.saving}
                onClick={() => section.cancelEditing()}
              >
                Cancel
              </Button>
            </>
          ) : (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              size="sm"
              variant="outline"
              onClick={() => section.startEditing()}
            >
              Edit
            </ViewOnlyActionButton>
          )}

          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={cleaning || section.editing}
            onClick={() => void runCleanup()}
          >
            {cleaning ? "Running…" : "Run cleanup now"}
          </ViewOnlyActionButton>
        </div>

        {lastCleanupAt ? (
          <p className="text-xs text-muted-foreground">
            Last run {club.instantDateTime(new Date(lastCleanupAt))} — deleted{" "}
            {lastCleanupDeleted} post{lastCleanupDeleted === 1 ? "" : "s"}.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            The cleanup has not run yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
