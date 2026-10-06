"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { ArrowUpToLine, ArrowDownToLine, ExternalLink } from "lucide-react";
import {
  NO_KEY_SERVER_VERSION,
  SERVERNZ_EXPECTED_SERVER_VERSION,
  SERVER_VERSION_MISMATCH_CODE,
  computeServerVersionStatus,
  describeServerVersionPause,
  type ServerVersionCheck,
} from "@/lib/servernz-api-version";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant, type BoundClubTime } from "@/lib/club-time";
import { isFullAdmin } from "@/lib/access-roles";
import {
  ViewOnlyActionButton,
  AdminViewOnlySectionBanner,
} from "@/components/admin/view-only-action";
import {
  useAdminAreaEditAccess,
  ADMIN_FULL_ADMIN_ONLY_ACTION_REASON,
} from "@/hooks/use-admin-area-edit-access";

interface InitialState {
  apiKeySet: boolean;
  apiKeyUpdatedAt: string | null;
  baseUrl: string | null;
  otherLodgesEnabled: boolean;
  otherLodgesLastUploadAt: string | null;
  otherLodgesLastDownloadAt: string | null;
  /** The stored server version (#49): null until asked, "unknown" for a 404. */
  serverVersion: string | null;
  serverVersionCheckedAt: string | null;
}

/**
 * What the page knows about the server's version (#49): the stored answer at
 * render, then whatever the version route reports. `couldNotCheck` is the
 * route's "the server could not be reached this time" - the last answer is
 * kept and shown as such, and it is NOT a mismatch. `missingBaseUrl` is a key
 * with no usable server address: nothing was asked.
 */
interface VersionView {
  serverVersion: string | null;
  checkedAt: string | null;
  couldNotCheck: boolean;
  missingBaseUrl: boolean;
}

// Upload/download stamps are real INSTANTS, shown in the club's persisted zone
// rather than the viewer's or the build's (CT-4, #2870; INV-CONFIG-002).
function fmt(clubTime: BoundClubTime, iso: string | null): string {
  if (!iso) return "never";
  return clubTime.instantDateTime(requireInstant(iso));
}

/**
 * The server's number as shown: the route's own no-key value (`0`) with no
 * key, "not checked yet" while a key is stored but the server has never been
 * asked, otherwise the stored answer.
 */
function shownServerVersion(apiKeySet: boolean, stored: string | null): string {
  if (!apiKeySet) return NO_KEY_SERVER_VERSION;
  return stored ?? "not checked yet";
}

export function AlpineServerSetup({ initialState }: { initialState: InitialState }) {
  const clubTime = useClubTime();
  // Two different permissions, and the page says which is which rather than
  // presenting one dead button. The page lives in the finance area like the rest
  // of the Integrations hub, so the sync controls follow `finance: edit`; the
  // base URL and the API key additionally require Full Admin, because between
  // them they decide WHERE a credential is sent (see the settings route).
  const canEdit = useAdminAreaEditAccess("finance");
  const { data: session } = useSession();
  const canWriteConnection =
    canEdit === undefined
      ? undefined
      : canEdit &&
        Boolean(session?.user && isFullAdmin({ accessRoles: session.user.accessRoles }));
  const [baseUrl, setBaseUrl] = useState(initialState.baseUrl ?? "");
  const [savedBaseUrl, setSavedBaseUrl] = useState(initialState.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(initialState.apiKeySet);
  const [enabled, setEnabled] = useState(initialState.otherLodgesEnabled);
  const [lastUpload, setLastUpload] = useState(initialState.otherLodgesLastUploadAt);
  const [lastDownload, setLastDownload] = useState(
    initialState.otherLodgesLastDownloadAt,
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const connectionReady = apiKeySet && savedBaseUrl.length > 0;

  // The version check (#49): ONE call per page entry, from a mount effect,
  // and again only after a key or address is saved - never on re-render and
  // never on a timer, because the server rate-limits the version call per
  // token. The stored answer is shown while the call is in flight.
  const [version, setVersion] = useState<VersionView>({
    serverVersion: initialState.serverVersion,
    checkedAt: initialState.serverVersionCheckedAt,
    couldNotCheck: false,
    missingBaseUrl: false,
  });
  const [checkingVersion, setCheckingVersion] = useState(false);
  const refreshVersion = useCallback(async () => {
    setCheckingVersion(true);
    try {
      const res = await fetch("/api/admin/alpine-server/version", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Version check failed (${res.status})`);
      const data = (await res.json()) as ServerVersionCheck;
      setVersion({
        serverVersion: data.status === "no-key" ? null : data.serverVersion,
        checkedAt: data.checkedAt,
        couldNotCheck: data.couldNotCheck,
        missingBaseUrl: data.missingBaseUrl,
      });
    } catch {
      // The route itself could not be reached (a session that expired, a
      // network error on the admin's side): keep the stored answer and say
      // the check did not happen. Not a mismatch - and not worth a note
      // beside `0` when no key is stored, because nothing would have been
      // asked anyway.
      setVersion((current) => ({ ...current, couldNotCheck: true }));
    } finally {
      setCheckingVersion(false);
    }
  }, []);
  useEffect(() => {
    void refreshVersion();
  }, [refreshVersion]);

  const versionStatus = computeServerVersionStatus(version.serverVersion, apiKeySet);

  async function saveBaseUrl() {
    setBusy("baseUrl");
    setMessage(null);
    try {
      const res = await fetch("/api/admin/alpine-server/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Failed to save base URL");
      setSavedBaseUrl(data.baseUrl ?? "");
      setBaseUrl(data.baseUrl ?? "");
      if (data.apiKeyCleared) setApiKeySet(false);
      setMessage({ kind: "ok", text: "Base URL saved." });
      // A moved address forgets the stored key and the stored version with
      // it; ask again so the numbers shown match what is now stored.
      void refreshVersion();
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  async function saveApiKey() {
    if (!apiKey.trim()) return;
    setBusy("apiKey");
    setMessage(null);
    try {
      const res = await fetch("/api/admin/integrations/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "servernz",
          key: "api_key",
          value: apiKey.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Failed to save API key");
      setApiKeySet(true);
      setApiKey("");
      setMessage({ kind: "ok", text: "API key stored securely." });
      // A new key means a (possibly different) server can now be asked.
      void refreshVersion();
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  async function toggleEnabled() {
    setBusy("enable");
    setMessage(null);
    const next = !enabled;
    try {
      const res = await fetch("/api/admin/alpine-server/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otherLodgesEnabled: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Failed to update");
      setEnabled(Boolean(data.otherLodgesEnabled));
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  async function syncOtherLodges(direction: "upload" | "download") {
    setBusy(direction);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/admin/alpine-server/other-lodges/${direction}`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // The route refused for version (#49): it hands back both numbers, so
        // the page shows them in the status block below without a second
        // server call - and the message points there rather than repeating
        // the same sentence twice.
        if (data?.code === SERVER_VERSION_MISMATCH_CODE && typeof data.serverVersion === "string") {
          setVersion((current) => ({
            ...current,
            serverVersion: data.serverVersion,
            couldNotCheck: false,
          }));
          throw new Error(
            `${direction === "upload" ? "Upload" : "Download"} paused: the server is on a different software version - see Server software version above.`,
          );
        }
        throw new Error(data?.error ?? `Failed to ${direction}`);
      }
      if (direction === "upload") {
        setLastUpload(new Date().toISOString());
        setMessage({
          kind: "ok",
          text: `Uploaded ${data.sent ?? 0} changed: ${data.created} created, ${data.updated} updated, ${data.unchanged ?? 0} unchanged, ${data.skipped} skipped.`,
        });
      } else {
        setLastDownload(new Date().toISOString());
        setMessage({
          kind: "ok",
          text: `Downloaded ${data.fetched} entries: ${data.created} added, ${data.updated} updated, ${data.unchanged ?? 0} unchanged.`,
        });
      }
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  const requestConnectionHref = savedBaseUrl ? `${savedBaseUrl}/register` : null;

  return (
    <div className="space-y-6">
      {message ? (
        <p
          className={`text-sm ${message.kind === "ok" ? "text-success-11" : "text-destructive"}`}
          role="status"
        >
          {message.text}
        </p>
      ) : null}

      {/* Connection */}
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Point this club at your Alpine Central Server and store the API key it
            issues you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <AdminViewOnlySectionBanner canEdit={canEdit}>
            Your admin role can view the Alpine Central Server setup, but changing
            it needs finance edit access — and the server address and API key need
            Full Admin.
          </AdminViewOnlySectionBanner>
          <div className="space-y-2">
            <Label htmlFor="acs-base-url">Server base URL</Label>
            <div className="flex gap-2">
              <Input
                id="acs-base-url"
                placeholder="https://central.alpineclub.nz"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <ViewOnlyActionButton
                canEdit={canWriteConnection}
                readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
                onClick={saveBaseUrl}
                disabled={busy !== null}
              >
                {busy === "baseUrl" ? "Saving…" : "Save"}
              </ViewOnlyActionButton>
            </div>
          </div>

          <div className="rounded-md border border-border bg-muted p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span>
                No account yet? Request a connection on the central server, then
                paste the API key below.
              </span>
              {requestConnectionHref ? (
                <a
                  href={requestConnectionHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 whitespace-nowrap font-medium underline underline-offset-4"
                >
                  Request a Connection
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              ) : (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  Save a base URL first
                </span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="acs-api-key">
              API key{" "}
              {apiKeySet ? (
                <Badge variant="secondary">stored</Badge>
              ) : (
                <Badge variant="outline">not set</Badge>
              )}
            </Label>
            <div className="flex gap-2">
              <Input
                id="acs-api-key"
                type="password"
                autoComplete="off"
                placeholder={apiKeySet ? "•••••••• (enter a new key to replace)" : "acs_…"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <ViewOnlyActionButton
                canEdit={canWriteConnection}
                readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
                onClick={saveApiKey}
                disabled={busy !== null || !apiKey.trim()}
              >
                {busy === "apiKey" ? "Saving…" : "Save key"}
              </ViewOnlyActionButton>
            </div>
            {apiKeySet ? (
              <p className="text-xs text-muted-foreground">
                Last updated {fmt(clubTime, initialState.apiKeyUpdatedAt)}. The key is stored
                encrypted and never shown again.
              </p>
            ) : null}
          </div>

          {/* The two software versions (#49), beside the address and the key
              they describe. Asked once on entry; `0` with no key stored. One
              message inside this section on a mismatch - the section banner
              above is the ONLY banner, and this is a status, not a permission. */}
          <div
            className="rounded-md border border-border bg-muted p-3 text-sm"
            data-testid="server-version"
          >
            <p className="font-medium">Server software version</p>
            <p className="mt-1 text-muted-foreground">
              This site is built for server version{" "}
              <strong data-testid="server-version-expected">
                {SERVERNZ_EXPECTED_SERVER_VERSION}
              </strong>
              {" · "}Server:{" "}
              <strong data-testid="server-version-actual">
                {shownServerVersion(apiKeySet, version.serverVersion)}
              </strong>
              {checkingVersion ? <span> (checking…)</span> : null}
            </p>
            {apiKeySet && version.missingBaseUrl ? (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="server-version-no-address">
                The server address is missing or not usable, so the server could
                not be asked. Save a base URL above.
              </p>
            ) : apiKeySet && version.couldNotCheck ? (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="server-version-unchecked">
                Could not check just now
                {version.serverVersion
                  ? ` — last known ${version.serverVersion}, checked ${fmt(clubTime, version.checkedAt)}`
                  : ""}
                . Syncing is not paused by a failed check.
              </p>
            ) : version.checkedAt && apiKeySet ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Last checked {fmt(clubTime, version.checkedAt)}.
              </p>
            ) : null}
            {versionStatus === "mismatch" ? (
              <p className="mt-2 text-destructive" role="status" data-testid="server-version-mismatch">
                {describeServerVersionPause(
                  SERVERNZ_EXPECTED_SERVER_VERSION,
                  version.serverVersion as string,
                )}{" "}
                Upgrade whichever side is behind; syncing resumes on its own once
                the two match.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Shared items */}
      <Card>
        <CardHeader>
          <CardTitle>Shared data</CardTitle>
          <CardDescription>
            Items synced between this club and the central server. Enable an item,
            then upload to push your data or download to pull the distributed set.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AdminViewOnlySectionBanner canEdit={canEdit}>
            Your admin role can view what is shared, but enabling an item or
            running a sync needs finance edit access.
          </AdminViewOnlySectionBanner>

          {/* The owner approved sharing booking-officer contact details on the
              explicit condition that whoever turns this on is told plainly what
              leaves the club. It is stated here, at the switch, rather than only
              in the module description — this is the screen where the decision
              is actually made. */}
          <div className="mb-4 rounded-md border border-border bg-muted p-3 text-sm">
            <p className="font-medium">What leaves this club when an item is enabled</p>
            <p className="mt-1 text-muted-foreground">
              Your lodges&apos; names, locations, bed counts and booking-officer
              contact details are uploaded to the central server and redistributed
              to every other connected club, where they appear on those clubs&apos;
              pages. The booking-officer email is the committee role&apos;s shared
              address, never a member&apos;s personal one, and a member&apos;s phone
              number is shared only if your club already publishes it on your own
              committee page. No other member data is sent.
            </p>
          </div>
          {!connectionReady ? (
            <p className="mb-4 text-sm text-muted-foreground">
              Save a base URL and API key above to enable syncing.
            </p>
          ) : null}
          <div className="divide-y">
            {/* Only current shared item: Other Clubs details */}
            <div className="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">Other Clubs details</span>
                  <Badge variant={enabled ? "secondary" : "outline"}>
                    {enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  The registry of other clubs&apos; lodges (name, location, booking
                  officer, beds).
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Last upload {fmt(clubTime, lastUpload)} · last download {fmt(clubTime, lastDownload)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  variant="outline"
                  size="sm"
                  onClick={toggleEnabled}
                  disabled={busy !== null}
                >
                  {enabled ? "Disable" : "Enable"}
                </ViewOnlyActionButton>
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  size="sm"
                  onClick={() => syncOtherLodges("upload")}
                  disabled={busy !== null || !enabled || !connectionReady}
                >
                  <ArrowUpToLine className="mr-1.5 h-4 w-4" />
                  {busy === "upload" ? "Uploading…" : "Upload"}
                </ViewOnlyActionButton>
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  size="sm"
                  variant="secondary"
                  onClick={() => syncOtherLodges("download")}
                  disabled={busy !== null || !enabled || !connectionReady}
                >
                  <ArrowDownToLine className="mr-1.5 h-4 w-4" />
                  {busy === "download" ? "Downloading…" : "Download"}
                </ViewOnlyActionButton>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
