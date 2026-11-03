"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PushRegistrationOutcome } from "@/lib/servernz-push-registration";
import type { SERVER_VERSION_MISMATCH_CODE } from "@/lib/servernz-api-version";
import type { LodgeLinkStep, LodgeLinkStepResult } from "@/lib/servernz-lodge-link-step";

// What happens on the setup page after an API key is saved: the site's address
// is registered with the central server (the credentials route answers with
// the outcome), then the server's lodges are downloaded and this club's lodges
// linked to the ones it owns (`/api/admin/alpine-server/lodge-links`). Split
// out of `alpine-server-setup.tsx` to keep that file inside its size budget.

export type KeySaveRegistration = PushRegistrationOutcome | typeof SERVER_VERSION_MISMATCH_CODE;

type StatusMessage = { kind: "ok" | "warn" | "err"; text: string };

/** The registration outcome in words, and whether the lodge step can follow. */
export function registrationMessage(outcome: KeySaveRegistration | undefined): StatusMessage & { linkLodges: boolean } {
  switch (outcome) {
    case "registered":
    case "already-registered":
      return { kind: "ok", text: "API key stored securely, and this site's address is registered with the central server.", linkLodges: true };
    case "not-https":
      return {
        kind: "warn",
        text: "API key stored securely. This site's address is not https, so the central server cannot reach it: shared posts arrive by polling every 3 hours, and the central lodge search cannot ask about free beds.",
        linkLodges: true,
      };
    case "no-address":
      return { kind: "warn", text: "API key stored securely. Save the server base URL above so this site can register with the central server.", linkLodges: false };
    case "awaiting-approval":
      return {
        kind: "warn",
        text: "API key stored securely. The central server has not approved this club's connection yet; this site registers itself automatically once it is approved. Come back after approval to link your lodges.",
        linkLodges: false,
      };
    case "server-version-mismatch":
      return {
        kind: "warn",
        text: "API key stored securely. Syncing is paused because the server is on a different software version - see Server software version below.",
        linkLodges: false,
      };
    default:
      return {
        kind: "warn",
        text: "API key stored securely, but this site's address could not be registered with the central server just now. It tries again every 3 hours.",
        linkLodges: true,
      };
  }
}

type Choose = Extract<LodgeLinkStep, { kind: "choose" }>;
// The "Not linked" item's value: the Select primitive refuses an empty-string
// item value, and no central lodge id is this.
const NOT_LINKED = "__not_linked__";

/**
 * The lodge step: run it after a key save, then show its outcome (and the
 * dialog when the club must choose).
 */
export function useLodgeLinkStep() {
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [choose, setChoose] = useState<Choose | null>(null);

  async function run() {
    setStatus({ kind: "ok", text: "Downloading this club's lodges from the central server…" });
    try {
      const res = await fetch("/api/admin/alpine-server/lodge-links", { method: "POST" });
      const data = (await res.json().catch(() => null)) as (LodgeLinkStepResult & { error?: string }) | null;
      if (!res.ok || !data) throw new Error(data?.error ?? "Could not download this club's lodges.");
      const step = data.step;
      switch (step.kind) {
        case "sharing-off":
          setStatus({ kind: "warn", text: "Enable Other Clubs details below, then press Download, to link your lodges to the central server's." });
          break;
        case "no-owned":
          setStatus({ kind: "warn", text: "The central server does not list a lodge for this club yet, so there is nothing to link. Ask its administrator to add your lodge, then Download." });
          break;
        case "no-lodges":
          setStatus({ kind: "warn", text: "This site has no active lodge to link yet." });
          break;
        case "already-linked":
          setStatus({ kind: "ok", text: "Your lodges are already linked to the central server's." });
          break;
        case "download-running":
          setStatus({ kind: "warn", text: "Another sync with the central server is running. Press Download below in a minute, then link each lodge from its Central lodge card." });
          break;
        case "choose":
          setStatus(null);
          setChoose(step);
          break;
      }
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Could not download this club's lodges." });
    }
  }

  const statusLine = status ? (
    <p
      className={`text-sm ${status.kind === "ok" ? "text-success-11" : status.kind === "warn" ? "text-warning-11" : "text-destructive"}`}
      role="status"
      data-testid="lodge-link-status"
    >
      {status.text}
    </p>
  ) : null;

  const dialog = choose ? (
    <LodgeLinkDialog
      step={choose}
      onClose={(saved) => {
        setChoose(null);
        if (saved) setStatus({ kind: "ok", text: "Lodge links saved." });
      }}
    />
  ) : null;

  return { run, statusLine, dialog };
}

/**
 * One select per local lodge, offering the owned central lodges and "Not
 * linked". Nothing is linked until Save (#4262: every club links explicitly,
 * so a one-lodge club gets its only owned lodge preselected, not saved). The
 * current link is preselected, else the suggestion; a central
 * lodge chosen in one row is disabled in the others (`centralLodgeId` is
 * unique). Save writes every changed row in one request, then closes.
 */
export function LodgeLinkDialog({ step, onClose }: { step: Choose; onClose: (saved: boolean) => void }) {
  const [chosen, setChosen] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(step.lodges.map((l) => [l.id, l.centralLodgeId ?? l.suggestedCentralLodgeId])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const links = step.lodges
      .filter((l) => (chosen[l.id] ?? null) !== l.centralLodgeId)
      .map((l) => ({ lodgeId: l.id, centralLodgeId: chosen[l.id] ?? null, expectCurrent: l.centralLodgeId }));
    if (links.length === 0) {
      onClose(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/alpine-server/lodge-links", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "Could not save the links.");
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the links.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(false); }}>
      <DialogContent showCloseButton={!saving} onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Link your lodges</DialogTitle>
          <DialogDescription>
            Choose which of the central server&apos;s lodges each of your lodges is.
            The central lodge search asks about free beds only for a linked lodge.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {step.lodges.map((lodge) => {
            const id = `lodge-link-${lodge.id}`;
            return (
              <div key={lodge.id} className="space-y-1">
                <Label htmlFor={id}>
                  {lodge.name}
                  {lodge.active ? "" : " (inactive)"}
                </Label>
                <Select
                  value={chosen[lodge.id] ?? NOT_LINKED}
                  disabled={saving}
                  onValueChange={(value) =>
                    setChosen((prev) => ({ ...prev, [lodge.id]: value === NOT_LINKED ? null : value }))
                  }
                >
                  <SelectTrigger id={id} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NOT_LINKED}>Not linked</SelectItem>
                    {step.owned.map((central) => (
                      <SelectItem
                        key={central.id}
                        value={central.id}
                        disabled={step.lodges.some((other) => other.id !== lodge.id && chosen[other.id] === central.id)}
                      >
                        {central.label}
                      </SelectItem>
                    ))}
                    {lodge.centralLodgeId !== null && !step.owned.some((c) => c.id === lodge.centralLodgeId) ? (
                      <SelectItem value={lodge.centralLodgeId}>No longer owned (clear this)</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving..." : "Save links"}
            </Button>
            <Button variant="outline" onClick={() => onClose(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
