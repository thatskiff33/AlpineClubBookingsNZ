/**
 * The club's AI-connection policy (ALP-653, `INV-MCP-002`): who may connect an
 * AI app, the most a connection may do, and which apps are approved.
 *
 * A singleton row; an absent row reads as `DEFAULT_MCP_SETTINGS`, which match
 * the column defaults (pinned by `mcp-settings.test.ts`), so a club that has
 * never opened the settings screen behaves exactly as one that saved it
 * unchanged.
 */
import type { McpGrantScope } from "@prisma/client";

import {
  hasAdminPortalAccess,
  type AdminPermissionInput,
} from "@/lib/admin-permissions";
import { prisma } from "@/lib/prisma";

import type { McpActionKind } from "./catalogue";

export const MCP_SETTINGS_ID = "default";

export interface McpSettingsValues {
  readonly membersMayConnect: boolean;
  readonly officersMayConnect: boolean;
  readonly maxScope: McpGrantScope;
  readonly allowedRedirectHosts: readonly string[];
}

export const DEFAULT_MCP_SETTINGS: McpSettingsValues = {
  membersMayConnect: true,
  officersMayConnect: false,
  maxScope: "READ",
  allowedRedirectHosts: ["claude.ai", "claude.com", "chatgpt.com"],
};

export const MCP_SETTINGS_SELECT = {
  membersMayConnect: true,
  officersMayConnect: true,
  maxScope: true,
  allowedRedirectHosts: true,
} as const;

export async function loadMcpSettings(): Promise<McpSettingsValues> {
  const record = await prisma.mcpSettings.findUnique({
    where: { id: MCP_SETTINGS_ID },
    select: MCP_SETTINGS_SELECT,
  });
  return record ?? DEFAULT_MCP_SETTINGS;
}

/**
 * Whether the club lets this person hold a connection. An officer (anyone the
 * admin area admits at all) is judged by `officersMayConnect` alone: their
 * connection can read other members' details, so the members' switch never
 * covers them. Asked when a connection is approved and again on every use, so
 * switching either off stops existing connections on their next request.
 */
export function mayHoldMcpConnection(
  settings: McpSettingsValues,
  user: AdminPermissionInput,
): boolean {
  return hasAdminPortalAccess(user)
    ? settings.officersMayConnect
    : settings.membersMayConnect;
}

const SCOPE_RANK: Record<McpGrantScope, number> = { READ: 0, READ_WRITE: 1 };

/**
 * What a connection may do right now: the lesser of what the member approved
 * and what the club currently allows. Lowering `maxScope` narrows every
 * existing connection on its next request without rewriting any of them.
 */
export function effectiveMcpScope(
  grantScope: McpGrantScope,
  settings: McpSettingsValues,
): McpGrantScope {
  return SCOPE_RANK[grantScope] <= SCOPE_RANK[settings.maxScope]
    ? grantScope
    : settings.maxScope;
}

/**
 * Whether a connection with this scope may run an action of this kind: a
 * view-only connection runs reads and nothing else. The tool list and the
 * dispatcher both ask here, so an action is never offered and then refused
 * (`INV-SSOT-002`).
 */
export function mcpScopeAllows(scope: McpGrantScope, kind: McpActionKind): boolean {
  return kind === "read" || scope === "READ_WRITE";
}
