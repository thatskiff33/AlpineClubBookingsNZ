"use client";

import { useState } from "react";
import type { McpGrantScope } from "@prisma/client";
import { Loader2 } from "lucide-react";

import { FocusedActionError } from "@/components/focused-action-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useActionFailure } from "@/hooks/use-action-failure";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";
import { MCP_SCOPE_LABELS } from "@/lib/mcp/scope-labels";

import { ProfileSectionCard } from "./profile-section-card";

export interface ConnectedAppRow {
  readonly id: string;
  readonly appName: string;
  readonly appHost: string;
  readonly scope: McpGrantScope;
  readonly connectedLabel: string;
  /** Null when the app has connected but not yet asked for anything. */
  readonly lastUsedLabel: string | null;
}

/**
 * Profile "Connected AI apps" (ALP-653, `INV-MCP-004`): the AI apps this
 * member has allowed to act as them, each with a Disconnect that ends the
 * connection at once.
 *
 * `connectAddress` is the address a member types into an AI app to start a
 * connection. It is null when the club does not let this account connect, and
 * the card then says so; apps connected earlier are still listed so they can
 * be disconnected.
 */
export function ConnectedAppsCard({
  initialConnections,
  connectAddress,
}: {
  initialConnections: readonly ConnectedAppRow[];
  connectAddress: string | null;
}) {
  const [connections, setConnections] = useState(initialConnections);
  const [endingId, setEndingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const failure = useActionFailure();

  async function disconnect(row: ConnectedAppRow) {
    setEndingId(row.id);
    setNotice("");
    failure.clear();
    try {
      const response = await fetch(`/api/member/mcp-grants/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      // 404 is a connection that has already ended: it is gone either way.
      if (!response.ok && response.status !== 404) {
        failure.fail(
          await apiErrorMessageFromResponse(
            response,
            `${row.appName} could not be disconnected. Please try again.`,
          ),
        );
        return;
      }
      setConnections((current) => current.filter((item) => item.id !== row.id));
      setNotice(`${row.appName} is disconnected. It can no longer use your account.`);
    } catch {
      failure.fail(`${row.appName} could not be disconnected. Please try again.`);
    } finally {
      setEndingId(null);
    }
  }

  return (
    <ProfileSectionCard
      className="scroll-mt-20"
      contentClassName="space-y-4 text-sm"
      description="AI apps you have allowed to act as you on this website"
      id="connected-apps"
      title="Connected AI apps"
    >
      {connections.length === 0 ? (
        <p className="text-muted-foreground">No AI apps are connected to your account.</p>
      ) : (
        <ul className="divide-y">
          {connections.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words font-medium">{row.appName}</span>
                  <Badge variant="secondary">{MCP_SCOPE_LABELS[row.scope]}</Badge>
                </div>
                <p className="mt-0.5 break-all text-xs text-muted-foreground">
                  {row.appHost} · Connected {row.connectedLabel} ·{" "}
                  {row.lastUsedLabel ? `Last used ${row.lastUsedLabel}` : "Not used yet"}
                </p>
              </div>
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() => void disconnect(row)}
                disabled={endingId !== null}
                aria-label={`Disconnect ${row.appName}`}
              >
                {endingId === row.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="font-medium" role="status">
        {notice}
      </p>
      <FocusedActionError
        id="connected-apps-error"
        error={failure.error}
        attentionKey={failure.attentionKey}
      />

      {connectAddress ? (
        <div className="space-y-1 border-t pt-3">
          <p className="text-muted-foreground">
            To connect an app, add this address as a connector in the app&apos;s
            settings. The app sends you back here to sign in and approve it.
          </p>
          <code className="block break-all rounded-md border bg-muted px-3 py-2 text-xs">
            {connectAddress}
          </code>
        </div>
      ) : (
        <p className="border-t pt-3 text-muted-foreground">
          Your club does not allow your account to connect an AI app.
        </p>
      )}
    </ProfileSectionCard>
  );
}
