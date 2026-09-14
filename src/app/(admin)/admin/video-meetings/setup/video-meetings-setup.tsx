"use client";

import { useCallback, useState } from "react";
import { useSession } from "next-auth/react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";
import { isFullAdmin } from "@/lib/access-roles";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  useAdminAreaEditAccess,
  ADMIN_FULL_ADMIN_ONLY_ACTION_REASON,
} from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
// `mirotalk-settings-shared`, never `mirotalk-config`: the latter is
// `server-only`, and importing a VALUE from it here fails `npm run build` with
// "'server-only' cannot be imported from a Client Component module". See that
// module's header. It is NOT unguarded until then, as this comment used to
// say: `client-server-boundary-census.test.ts` walks the real import graph from
// every `"use client"` module and fails this exact path, naming it
// `this file -> mirotalk-config -> server-only`, inside the REQUIRED
// `verify` check.
import {
  MIROTALK_CREDENTIAL_LABELS,
  MIROTALK_ENV_NAMES,
  mirotalkSecretsAtRiskFromAddressChange,
  validateMirotalkBaseUrl,
  validateMirotalkTokenLifetime,
  type MirotalkConfigurationStatus,
  type MirotalkCredentialKey,
  type MirotalkFieldStatus,
  type MirotalkSecretStatus,
  type MirotalkSettingField,
  type MirotalkSettingsDraft,
} from "@/lib/mirotalk-settings-shared";

/**
 * Video meetings (MiroTalk) setup — the club-editable half of the
 * configuration, moved out of the environment by #2940.
 *
 * ## The two sections, and why they behave differently
 *
 * The SETTINGS section follows the canonical staged-edit pattern
 * (`docs/ARCHITECTURE.md` -> "Admin/member layer"): it loads read-only, Edit
 * reveals Save and Cancel, nothing auto-persists, Cancel restores every field
 * from the snapshot, and Save writes once and re-seeds from the parsed SERVER
 * response — which matters here because the server normalises an address
 * (adding https, dropping a trailing slash), so re-seeding from the draft would
 * leave the form disagreeing with storage.
 *
 * The SECRETS section is not staged, and that is the established shape for a
 * write-only value rather than a divergence. There is nothing to stage: the
 * field starts empty whatever is stored, because nothing can read a secret back
 * out, so "Cancel restores the previous value" has no meaning. Each secret is
 * its own discrete action, in the same class as the row-level actions the
 * pattern already sanctions.
 *
 * ## Every control is Full Admin
 *
 * The page is in the finance area, so any admin who can see the Integrations
 * hub can READ this status — which is the point of showing where each value
 * comes from. Changing one needs Full Admin: the address is where a signed host
 * token is sent, the presenter choice decides whether whoever clicks a link
 * arrives with host powers, and the lifetime decides how long a forwarded link
 * keeps working. The API enforces all of that independently of this UI.
 */

const SETTINGS_ENDPOINT = "/api/admin/integrations/mirotalk";
const CREDENTIALS_ENDPOINT = "/api/admin/integrations/mirotalk/credentials";

export interface VideoMeetingsSetupProps {
  initialStatus: MirotalkConfigurationStatus;
  initialSettings: MirotalkSettingsDraft;
  /** When this section was last saved, or null if it never has been. */
  initialSettingsUpdatedAt: string | null;
}

interface SettingsPayload {
  status: MirotalkConfigurationStatus;
  settings: MirotalkSettingsDraft;
  /** When this section was last saved, or null if it never has been. */
  settingsUpdatedAt: string | null;
  /** Present when moving the address cleared the stored host sign-in. */
  secretsCleared?: string | null;
}

/** Plain English for where a value came from, at the point it is shown. */
function describeSource(field: MirotalkFieldStatus, envName: string): string {
  switch (field.source) {
    case "database":
      return `In force: ${field.effective} — set on this page. It applies the next time somebody opens a meeting; no restart is needed.`;
    case "environment":
      return `In force: ${field.effective} — from ${envName}. Leave the box empty to keep using it; changing it means editing the environment and restarting.`;
    case "derived":
      return `In force: ${field.effective} — nothing is set here or in ${envName}, so this is the default.`;
  }
}

/**
 * Takes the SETTING, not the variable name, and looks the name up itself — so a
 * caller cannot label a field with the wrong variable, and renaming one is one
 * edit in `mirotalk-settings-shared` rather than five sites.
 */
function SourceNote({
  field,
  setting,
}: {
  field: MirotalkFieldStatus;
  setting: MirotalkSettingField;
}) {
  const envName = MIROTALK_ENV_NAMES[setting];
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {describeSource(field, envName)}
      </p>
      {field.problem ? (
        <p className="text-xs text-destructive">{field.problem}</p>
      ) : null}
    </>
  );
}

/**
 * EXHAUSTIVE over the secret source, which is why that union had to lose
 * "derived". While it carried a state the resolver cannot produce, this
 * function's final `return` was doing two jobs — rendering "unset", and
 * silently absorbing the impossible case as "not set" as well.
 */
function secretBadge(secret: MirotalkSecretStatus) {
  if (secret.needsReentry) {
    return <Badge variant="destructive">needs re-entering</Badge>;
  }
  switch (secret.source) {
    case "database":
      return <Badge variant="secondary">stored</Badge>;
    case "environment":
      return (
        <Badge variant="outline">from {MIROTALK_ENV_NAMES[secret.key]}</Badge>
      );
    case "unset":
      return <Badge variant="outline">not set</Badge>;
  }
}

export function VideoMeetingsSetup({
  initialStatus,
  initialSettings,
  initialSettingsUpdatedAt,
}: VideoMeetingsSetupProps) {
  const clubTime = useClubTime();
  const canEditFinance = useAdminAreaEditAccess("finance");
  const { data: session } = useSession();
  const canEdit =
    canEditFinance === undefined
      ? undefined
      : canEditFinance &&
        Boolean(
          session?.user && isFullAdmin({ accessRoles: session.user.accessRoles }),
        );

  const [status, setStatus] = useState(initialStatus);
  const [settingsUpdatedAt, setSettingsUpdatedAt] = useState(
    initialSettingsUpdatedAt,
  );
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [busySecret, setBusySecret] = useState<string | null>(null);
  const [secretMessage, setSecretMessage] = useState<{
    kind: "ok" | "warn" | "err";
    text: string;
  } | null>(null);

  const refreshStatus = useCallback(async () => {
    const res = await fetch(SETTINGS_ENDPOINT);
    if (!res.ok) return;
    const data = (await res.json()) as SettingsPayload;
    setStatus(data.status);
    setSettingsUpdatedAt(data.settingsUpdatedAt);
  }, []);

  const section = useSectionEditState<MirotalkSettingsDraft>({
    initial: initialSettings,
    save: async (draft) => {
      const res = await fetch(SETTINGS_ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (res.status === 403) throw new ForbiddenSaveError();
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? "Could not save these settings.");
      }
      const payload = data as SettingsPayload;
      setStatus(payload.status);
      setSettingsUpdatedAt(payload.settingsUpdatedAt);
      // Moving the address drops the stored host sign-in, because those values
      // only mean anything to the server they were set for. Say so where the
      // secrets are, not in the settings banner the person has already read.
      setSecretMessage(
        payload.secretsCleared
          ? { kind: "warn", text: payload.secretsCleared }
          : null,
      );
      return payload.settings;
    },
    successMessage: "Video meeting settings saved.",
    // Both text fields are optional — empty means "use the environment" — so a
    // draft is invalid only when something was typed and is wrong.
    isValid: (draft) =>
      (!draft.baseUrl || validateMirotalkBaseUrl(draft.baseUrl).ok) &&
      (!draft.tokenLifetime ||
        validateMirotalkTokenLifetime(draft.tokenLifetime).ok),
  });

  const draft = section.draft ?? initialSettings;
  // One call each, read twice: once to gate Save and once to say why. Calling
  // the validator inline in the JSX needed a cast to reach `reason`, which is
  // the type telling you the shape was being read wrong.
  const baseUrlCheck = draft.baseUrl ? validateMirotalkBaseUrl(draft.baseUrl) : null;

  /**
   * The secrets this Save would delete, worked out BEFORE it is pressed
   * (#2940 review, S7 and C1).
   *
   * The decision itself is `mirotalkSecretsAtRiskFromAddressChange`, shared with
   * nothing else on this page on purpose: it has to ask the same question the
   * server asks, or the warning promises a deletion that does not happen or
   * stays silent through one that does.
   */
  const secretsAtRisk = section.editing
    ? mirotalkSecretsAtRiskFromAddressChange({
        secrets: status.secrets,
        inForce: status.baseUrl,
        draftBaseUrl: draft.baseUrl,
      })
    : [];
  const clearWarning = secretsAtRisk.length
    ? `Saving this will also delete the stored ${secretsAtRisk
        .map((key) => MIROTALK_CREDENTIAL_LABELS[key].toLowerCase())
        .join(", ")}, because ${secretsAtRisk.length === 1 ? "it only means" : "they only mean"} anything to the meeting server ${secretsAtRisk.length === 1 ? "it was" : "they were"} set for. Nobody can read ${secretsAtRisk.length === 1 ? "it" : "them"} back, so have the new server's values to hand before you save.`
    : null;
  const lifetimeCheck = draft.tokenLifetime
    ? validateMirotalkTokenLifetime(draft.tokenLifetime)
    : null;

  async function saveSecret(key: MirotalkCredentialKey) {
    const value = secretDrafts[key] ?? "";
    if (!value) return;
    const stored = status.secrets.find((secret) => secret.key === key);
    setBusySecret(key);
    setSecretMessage(null);
    try {
      const res = await fetch(CREDENTIALS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          value,
          // What this screen was told is stored. The server turns it into the
          // write expectation, so a second administrator who saved in between
          // makes this lose rather than silently overwriting them.
          version: stored?.version ?? null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not store that value.");
      setSecretDrafts((current) => ({ ...current, [key]: "" }));
      setSecretMessage(
        data?.warning
          ? { kind: "warn", text: data.warning }
          : { kind: "ok", text: `${MIROTALK_CREDENTIAL_LABELS[key]} stored.` },
      );
      await refreshStatus();
    } catch (error) {
      setSecretMessage({
        kind: "err",
        text: error instanceof Error ? error.message : "Could not store that value.",
      });
    } finally {
      setBusySecret(null);
    }
  }

  async function clearSecret(key: MirotalkCredentialKey) {
    const stored = status.secrets.find((secret) => secret.key === key);
    if (!stored?.version) return;
    setBusySecret(key);
    setSecretMessage(null);
    try {
      const res = await fetch(
        `${CREDENTIALS_ENDPOINT}?key=${encodeURIComponent(key)}&version=${encodeURIComponent(stored.version)}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not clear that value.");
      setSecretMessage({
        kind: "ok",
        text: `${MIROTALK_CREDENTIAL_LABELS[key]} cleared.`,
      });
      await refreshStatus();
    } catch (error) {
      setSecretMessage({
        kind: "err",
        text: error instanceof Error ? error.message : "Could not clear that value.",
      });
    } finally {
      setBusySecret(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Meeting server</CardTitle>
          <CardDescription>
            Where your club&apos;s MiroTalk meetings are hosted, and how the join
            links behave. Leave a box empty to keep using whatever the server
            environment already sets.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <AdminViewOnlySectionBanner canEdit={canEdit}>
            Your admin role can see how video meetings are configured, but
            changing any of it needs Full Admin — these settings decide where a
            signed join link is sent and what it lets the person holding it do.
          </AdminViewOnlySectionBanner>

          {/*
            The counterpart of each secret's "Last changed" line (#2940 review,
            C2). The timestamp was read from the row and shown nowhere, so the
            page said when a signing key last moved and not when the address did
            — from data it had already fetched on the same request.
          */}
          <p className="text-xs text-muted-foreground">
            {settingsUpdatedAt
              ? `Last saved on this page ${clubTime.instantDateTime(requireInstant(settingsUpdatedAt))}.`
              : "Nothing has been saved on this page yet, so every setting below is coming from the server environment or from its default."}
          </p>

          {section.error ? (
            <p className="text-sm text-destructive" role="alert">
              {section.error}
            </p>
          ) : null}
          {section.success ? (
            <p className="text-sm text-success-11" role="status">
              {section.success}
            </p>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="mirotalk-base-url">Meeting server address</Label>
            <Input
              id="mirotalk-base-url"
              placeholder="https://meet.example.org"
              value={draft.baseUrl}
              disabled={!section.editing}
              onChange={(event) => section.setDraft({ baseUrl: event.target.value })}
            />
            <SourceNote field={status.baseUrl} setting="baseUrl" />
            {/*
              WHAT THIS PAGE CANNOT CHANGE, said where the mistake would be
              made. The address has a counterpart in the deployment — which
              hostname the reverse proxy answers on and where it reaches
              MiroTalk — that only whoever runs the server can set. A Full Admin
              who points this at a host the deployment does not serve breaks
              every join link, and nothing else on the screen hints that there
              is a second half.
            */}
            <p className="text-xs text-muted-foreground">
              This has to be a MiroTalk server your deployment already serves —
              the hostname the reverse proxy answers on is set by whoever runs
              the server, not here, so changing this to a host they have not set
              up will break every join link.
            </p>
            {section.editing && baseUrlCheck && !baseUrlCheck.ok ? (
              <p className="text-xs text-destructive">{baseUrlCheck.reason}</p>
            ) : null}
            {clearWarning ? (
              <p className="text-xs text-warning-11" role="status">
                {clearWarning}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="mirotalk-presenter">
              Whoever opens a link is the host
            </Label>
            <Select
              value={
                draft.presenterEnabled === null
                  ? "unset"
                  : draft.presenterEnabled
                    ? "on"
                    : "off"
              }
              disabled={!section.editing}
              onValueChange={(value) =>
                section.setDraft({
                  presenterEnabled: value === "unset" ? null : value === "on",
                })
              }
            >
              <SelectTrigger id="mirotalk-presenter" aria-label="Host on join">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unset">Not set here</SelectItem>
                <SelectItem value="on">Yes — the meeting starts straight away</SelectItem>
                <SelectItem value="off">
                  No — joiners wait on MiroTalk&apos;s &ldquo;waiting for host&rdquo; screen
                </SelectItem>
              </SelectContent>
            </Select>
            <SourceNote field={status.presenter} setting="presenter" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="mirotalk-lifetime">How long a join link lasts</Label>
            <Input
              id="mirotalk-lifetime"
              placeholder="1h"
              value={draft.tokenLifetime}
              disabled={!section.editing}
              onChange={(event) =>
                section.setDraft({ tokenLifetime: event.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              Written as a number and a unit — 1h, 30m, 45s or 1d — or as a plain
              number of seconds. A link is minted fresh each time somebody clicks
              Join, so a short life costs nobody anything and limits how long a
              forwarded link keeps working.
            </p>
            <SourceNote field={status.tokenLifetime} setting="tokenLifetime" />
            {section.editing && lifetimeCheck && !lifetimeCheck.ok ? (
              <p className="text-xs text-destructive">{lifetimeCheck.reason}</p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            {section.editing ? (
              <>
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
                  onClick={() => void section.save()}
                  disabled={section.saving || !section.dirty || !section.valid}
                >
                  {section.saving ? "Saving…" : "Save"}
                </ViewOnlyActionButton>
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  variant="outline"
                  onClick={section.cancelEditing}
                  disabled={section.saving}
                >
                  Cancel
                </ViewOnlyActionButton>
              </>
            ) : (
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
                onClick={section.startEditing}
              >
                Edit
              </ViewOnlyActionButton>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Host sign-in</CardTitle>
          <CardDescription>
            The signing key and the host sign-in your MiroTalk server expects.
            With all three set, a join link opens the meeting with no login
            prompt; without them the link still works and MiroTalk asks for its
            own host login.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <AdminViewOnlySectionBanner canEdit={canEdit}>
            Your admin role can see whether these are set, but storing or
            clearing one needs Full Admin.
          </AdminViewOnlySectionBanner>

          <p className="text-sm text-muted-foreground">
            {status.tokenMintable
              ? "Join links are signed, so committee members open meetings as host without signing in."
              : "Join links are not signed yet. Set all three below, matching your MiroTalk server's JWT_KEY and one of its HOST_USERS entries."}
          </p>

          {secretMessage ? (
            <p
              className={
                secretMessage.kind === "err"
                  ? "text-sm text-destructive"
                  : secretMessage.kind === "warn"
                    ? "text-sm text-warning-11"
                    : "text-sm text-success-11"
              }
              role={secretMessage.kind === "err" ? "alert" : "status"}
            >
              {secretMessage.text}
            </p>
          ) : null}

          {status.secrets.map((secret) => (
            <div key={secret.key} className="space-y-2">
              <Label htmlFor={`mirotalk-${secret.key}`}>
                {MIROTALK_CREDENTIAL_LABELS[secret.key]} {secretBadge(secret)}
              </Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id={`mirotalk-${secret.key}`}
                  type="password"
                  autoComplete="off"
                  className="min-w-48 flex-1"
                  placeholder={
                    secret.source === "database"
                      ? "•••••••• (type a new value to replace it)"
                      : "Type a value to store it here"
                  }
                  value={secretDrafts[secret.key] ?? ""}
                  onChange={(event) =>
                    setSecretDrafts((current) => ({
                      ...current,
                      [secret.key]: event.target.value,
                    }))
                  }
                />
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
                  onClick={() => void saveSecret(secret.key)}
                  disabled={
                    busySecret !== null || !(secretDrafts[secret.key] ?? "").trim()
                  }
                >
                  {busySecret === secret.key ? "Saving…" : "Save"}
                </ViewOnlyActionButton>
                {secret.version ? (
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
                    variant="outline"
                    onClick={() => void clearSecret(secret.key)}
                    disabled={busySecret !== null}
                  >
                    Clear
                  </ViewOnlyActionButton>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {secret.needsReentry
                  ? "This was stored here but can no longer be read, because the app's encryption key changed. Type it again to repair it — until you do, join links are unsigned."
                  : secret.source === "database"
                    ? `Stored encrypted and never shown again.${secret.updatedAt ? ` Last changed ${clubTime.instantDateTime(requireInstant(secret.updatedAt))}.` : ""} Clearing it falls back to ${MIROTALK_ENV_NAMES[secret.key]}.`
                    : secret.source === "environment"
                      ? `Using ${MIROTALK_ENV_NAMES[secret.key]} from the server environment. Storing a value here takes over from it; nothing is copied across on its own.`
                      : `Not set here or in ${MIROTALK_ENV_NAMES[secret.key]}.`}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
