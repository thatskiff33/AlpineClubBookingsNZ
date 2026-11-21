"use client";

import { useCallback, useEffect, useId, useState } from "react";

import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { Pagination } from "@/components/admin/admin-pagination";
import { useAdminQueuePage } from "@/components/admin/use-admin-queue-page";
import { useClubTime } from "@/components/club-time-provider";
import { fetchWithRecentAuth } from "@/components/confirm-its-you";
import { FocusedActionError } from "@/components/focused-action-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useActionFailure } from "@/hooks/use-action-failure";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { ForbiddenSaveError, useSectionEditState } from "@/hooks/use-section-edit-state";
import { apiRefusalFromResponse, refusalMessageOr } from "@/lib/api-error-message";
import { requireInstant } from "@/lib/club-time";
import type { McpAdminConnectionListItem } from "@/lib/mcp/grants";
import { MCP_SCOPE_LABELS } from "@/lib/mcp/scope-labels";
import type { McpSettingsValues } from "@/lib/mcp/settings";

const SETTINGS_URL = "/api/admin/mcp/settings";
const GRANTS_URL = "/api/admin/mcp/grants";
const LOAD_FAILED = "The AI app settings could not be read.";
const SAVE_FAILED = "The AI app settings could not be saved.";

export function AiConnectionsClient({ connectAddress }: { connectAddress: string }) {
  // Both write routes are gated `support:edit`; a support:view officer reads
  // this page and cannot change it.
  const canEdit = useAdminAreaEditAccess("support");

  return (
    <div className="space-y-6">
      {/*
        One banner for the page, mounted in every state so its live region is
        registered before it can carry content (#2160).
      */}
      <AdminViewOnlySectionBanner canEdit={canEdit}>
        Your admin role can see the AI app settings and connections but cannot
        change them. Support edit access is required.
      </AdminViewOnlySectionBanner>
      <SettingsSection canEdit={canEdit} connectAddress={connectAddress} />
      <ConnectionsSection canEdit={canEdit} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface SettingsDraft {
  membersMayConnect: boolean;
  officersMayConnect: boolean;
  maxScope: McpSettingsValues["maxScope"];
  /** The approved apps, one host to a line, as the officer types them. */
  allowedHostsText: string;
}

function toDraft(settings: McpSettingsValues): SettingsDraft {
  return {
    membersMayConnect: settings.membersMayConnect,
    officersMayConnect: settings.officersMayConnect,
    maxScope: settings.maxScope,
    allowedHostsText: settings.allowedRedirectHosts.join("\n"),
  };
}

function SettingsSection({
  canEdit,
  connectAddress,
}: {
  canEdit: boolean | undefined;
  connectAddress: string;
}) {
  const scopeId = useId();
  const hostsId = useId();
  const hostsHintId = useId();
  const membersId = useId();
  const officersId = useId();
  const officersHintId = useId();

  const section = useSectionEditState<SettingsDraft>({
    load: async (signal) => {
      const response = await fetch(SETTINGS_URL, { signal, cache: "no-store" });
      if (!response.ok) throw new Error(LOAD_FAILED);
      return toDraft((await response.json()) as McpSettingsValues);
    },
    loadErrorFallback: LOAD_FAILED,
    save: async (draft) => {
      let response: Response;
      try {
        // Changing who may hand their account to an AI app asks the officer
        // to confirm it is them (INV-AUTH-010).
        response = await fetchWithRecentAuth(SETTINGS_URL, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            membersMayConnect: draft.membersMayConnect,
            officersMayConnect: draft.officersMayConnect,
            maxScope: draft.maxScope,
            // The route reduces each line to a host and names one it cannot read.
            allowedRedirectHosts: draft.allowedHostsText.split("\n"),
          }),
        });
      } catch {
        // A request that never got an answer: the screen's words, not the browser's.
        throw new Error(SAVE_FAILED);
      }
      if (!response.ok) {
        if (response.status === 403) throw new ForbiddenSaveError();
        throw await apiRefusalFromResponse(response, SAVE_FAILED);
      }
      return toDraft((await response.json()) as McpSettingsValues);
    },
    successMessage: "AI app settings saved.",
    saveErrorFallback: SAVE_FAILED,
  });

  const { draft, editing, saving, dirty, error, success } = section;

  // Mounted in every state, for the reason the banner above is.
  const feedback = (
    <div className="space-y-2">
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
      <p className="text-sm font-medium" role="status">
        {success}
      </p>
    </div>
  );

  if (section.loading || !draft) {
    return (
      <div className="space-y-4">
        {feedback}
        {section.loading ? (
          <p className="text-sm text-muted-foreground">Reading the AI app settings...</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {feedback}
      <Card {...section.sectionRegionProps}>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle {...section.titleProps} headingLevel={2} className="text-base">
              Who may connect, and what an app may do
            </CardTitle>
            <CardDescription>
              A change here applies to connections already made, the next time
              each app asks for something.
            </CardDescription>
          </div>
          {!editing && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={section.startEditing}
              {...section.editTriggerProps}
            >
              Edit
            </ViewOnlyActionButton>
          )}
        </CardHeader>
        <CardContent className="space-y-5 text-sm">
          <div className="flex items-start gap-3">
            <Checkbox
              id={membersId}
              className="mt-0.5"
              checked={draft.membersMayConnect}
              disabled={!editing}
              onCheckedChange={(checked) => section.setDraft({ membersMayConnect: checked })}
            />
            <div>
              <Label htmlFor={membersId}>Members may connect an AI app</Label>
              <p className="text-xs text-muted-foreground">
                The app sees that member&apos;s own bookings, family group and profile.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <Checkbox
              id={officersId}
              className="mt-0.5"
              aria-describedby={officersHintId}
              checked={draft.officersMayConnect}
              disabled={!editing}
              onCheckedChange={(checked) => section.setDraft({ officersMayConnect: checked })}
            />
            <div>
              <Label htmlFor={officersId}>Officers may connect an AI app</Label>
              <p id={officersHintId} className="text-xs text-muted-foreground">
                Anyone who can open the admin area counts as an officer. Their app
                can reach what they can, so other members&apos; details go to the
                company that runs the app. Say so in the club&apos;s privacy notice
                before turning this on.
              </p>
            </div>
          </div>

          <div className="max-w-md space-y-1">
            <Label htmlFor={scopeId}>The most a connection may do</Label>
            <Select
              value={draft.maxScope}
              disabled={!editing}
              onValueChange={(value) =>
                section.setDraft({ maxScope: value as SettingsDraft["maxScope"] })
              }
            >
              <SelectTrigger id={scopeId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="READ">{MCP_SCOPE_LABELS.READ}</SelectItem>
                <SelectItem value="READ_WRITE">{MCP_SCOPE_LABELS.READ_WRITE}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              With view and change, a member can let an app start or cancel a
              booking for them. Each member still chooses view only or view and
              change when they approve an app.
            </p>
          </div>

          <div className="max-w-md space-y-1">
            <Label htmlFor={hostsId}>Approved AI apps</Label>
            <Textarea
              id={hostsId}
              aria-describedby={hostsHintId}
              rows={5}
              spellCheck={false}
              value={draft.allowedHostsText}
              disabled={!editing}
              onChange={(event) => section.setDraft({ allowedHostsText: event.target.value })}
            />
            <p id={hostsHintId} className="text-xs text-muted-foreground">
              One website address to a line, such as claude.ai. A member can only
              approve an app that sends them back to one of these, or an app
              running on their own computer.
            </p>
          </div>

          {editing && (
            <div className="flex gap-3">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                onClick={() => void section.save()}
                disabled={!dirty || saving}
              >
                {saving ? "Saving..." : "Save AI app settings"}
              </ViewOnlyActionButton>
              {/* A plain Button: Cancel reverts local state and writes nothing. */}
              <Button variant="outline" onClick={section.cancelEditing} disabled={saving}>
                Cancel
              </Button>
            </div>
          )}

          <div className="space-y-1 border-t pt-4">
            <p className="text-muted-foreground">
              The address a member adds as a connector in their AI app. It is also
              shown on each member&apos;s profile.
            </p>
            <code className="block break-all rounded-md border bg-muted px-3 py-2 text-xs">
              {connectAddress}
            </code>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

function ConnectionsSection({ canEdit }: { canEdit: boolean | undefined }) {
  const club = useClubTime();
  const [connections, setConnections] = useState<McpAdminConnectionListItem[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [endingId, setEndingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const failure = useActionFailure();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const queuePage = useAdminQueuePage({ filterKey: "connections" });
  const { page, receive, beginLoad } = queuePage;

  const load = useCallback(async (signal?: AbortSignal) => {
    const isCurrent = beginLoad();
    try {
      const response = await fetch(`${GRANTS_URL}?page=${page}`, { signal, cache: "no-store" });
      if (!isCurrent() || signal?.aborted) return;
      if (!response.ok) {
        setLoadError("The connections could not be read. Reload the page to try again.");
        return;
      }
      const body = (await response.json()) as { connections: McpAdminConnectionListItem[] };
      if (!isCurrent() || signal?.aborted) return;
      if (!receive(body, body.connections.length)) return;
      setConnections(body.connections);
      setLoadError("");
    } catch {
      if (!isCurrent() || signal?.aborted) return;
      setLoadError("The connections could not be read. Reload the page to try again.");
    }
  }, [beginLoad, page, receive]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshVersion]);

  async function disconnect(row: McpAdminConnectionListItem) {
    const who = `${row.appName} for ${row.memberName}`;
    setEndingId(row.id);
    setNotice("");
    failure.clear();
    try {
      const response = await fetch(`${GRANTS_URL}/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      // 404 is a connection that has already ended: it is gone either way.
      if (!response.ok && response.status !== 404) {
        throw await apiRefusalFromResponse(response, `${who} could not be disconnected.`);
      }
      setRefreshVersion((version) => version + 1);
      setNotice(`Disconnected ${who}.`);
    } catch (err) {
      failure.fail(refusalMessageOr(err, `${who} could not be disconnected. Please try again.`));
    } finally {
      setEndingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2} className="text-base">Connections</CardTitle>
        <CardDescription>
          Every AI app a member has connected and not yet disconnected, newest
          first. Disconnecting stops the app at once; the member can connect it
          again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-destructive" role="alert">
          {loadError}
        </p>
        <p className="font-medium" role="status">
          {notice}
        </p>
        <FocusedActionError
          id="ai-connections-error"
          error={failure.error}
          attentionKey={failure.attentionKey}
        />
        {queuePage.pagination ? (
          <Pagination {...queuePage.pagination} aria-label="AI app connection pages" />
        ) : null}
        {connections === null ? (
          loadError ? null : (
            <p className="text-muted-foreground">Reading the connections...</p>
          )
        ) : connections.length === 0 ? (
          <p className="text-muted-foreground">No AI apps are connected.</p>
        ) : (
          <ul className="divide-y">
            {connections.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-words font-medium">{row.memberName}</span>
                    <Badge variant="secondary">{MCP_SCOPE_LABELS[row.scope]}</Badge>
                  </div>
                  <p className="mt-0.5 break-all text-xs text-muted-foreground">
                    {row.appName} · {row.appHost} · Connected{" "}
                    {club.instantDate(requireInstant(row.connectedAt))} ·{" "}
                    {row.lastUsedAt
                      ? `Last used ${club.instantDateTime(requireInstant(row.lastUsedAt))}`
                      : "Not used yet"}
                  </p>
                </div>
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  size="sm"
                  variant="outline"
                  onClick={() => void disconnect(row)}
                  disabled={endingId !== null}
                  aria-label={`Disconnect ${row.appName} for ${row.memberName}`}
                >
                  Disconnect
                </ViewOnlyActionButton>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
