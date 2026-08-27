"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { ArrowUpToLine, ArrowDownToLine, ExternalLink } from "lucide-react";
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
}

// Upload/download stamps are real INSTANTS, shown in the club's persisted zone
// rather than the viewer's or the build's (CT-4, #2870; INV-CONFIG-002).
function fmt(clubTime: BoundClubTime, iso: string | null): string {
  if (!iso) return "never";
  return clubTime.instantDateTime(requireInstant(iso));
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
      setMessage({ kind: "ok", text: "Base URL saved." });
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
      if (!res.ok) throw new Error(data?.error ?? `Failed to ${direction}`);
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
