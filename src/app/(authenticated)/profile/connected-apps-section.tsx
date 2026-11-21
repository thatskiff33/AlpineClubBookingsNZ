import type { Session } from "next-auth";
import { requireInstant } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { listMcpConnectionsForMember } from "@/lib/mcp/grants";
import { mcpResourceUrl } from "@/lib/mcp/oauth";
import { loadMcpSettings, mayHoldMcpConnection } from "@/lib/mcp/settings";
import { ConnectedAppsCard } from "./connected-apps-card";

/** Rendered only when the MCP module is enabled; existing grants remain revocable. */
export async function ConnectedAppsSection({ user }: { user: Session["user"] }) {
  const club = await clubTime();
  const connections = await listMcpConnectionsForMember(user.id);
  const settings = await loadMcpSettings();
  return (
    <ConnectedAppsCard
      initialConnections={connections.map((connection) => ({
        id: connection.id,
        appName: connection.appName,
        appHost: connection.appHost,
        scope: connection.scope,
        connectedLabel: club.instantDate(requireInstant(connection.connectedAt)),
        lastUsedLabel: connection.lastUsedAt
          ? club.instantDate(requireInstant(connection.lastUsedAt))
          : null,
      }))}
      connectAddress={mayHoldMcpConnection(settings, user) ? mcpResourceUrl() : null}
    />
  );
}
