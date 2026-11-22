/**
 * The club's AI connection settings as an officer saves them (ALP-653,
 * `INV-MCP-002`, `INV-MCP-003`).
 */
import { McpGrantScope } from "@prisma/client";
import { z } from "zod";

import { normaliseRedirectHost } from "./redirect-uris";

/** The most approved-app hosts a club may list. */
export const MCP_ALLOWED_HOSTS_MAX = 50;

export const mcpSettingsUpdateSchema = z
  .object({
    membersMayConnect: z.boolean(),
    officersMayConnect: z.boolean(),
    maxScope: z.enum(McpGrantScope),
    allowedRedirectHosts: z.array(z.string().max(300)).max(MCP_ALLOWED_HOSTS_MAX),
  })
  .strict();

export type McpAllowedHostsResult =
  | { readonly ok: true; readonly hosts: string[] }
  | { readonly ok: false; readonly invalid: string };

/**
 * Reduces what the officer typed to bare hostnames, in their order, without
 * repeats. One entry that is not a hostname refuses the whole save and is
 * named, so a typo is never silently dropped from the approved list.
 */
export function normaliseMcpAllowedHosts(entries: readonly string[]): McpAllowedHostsResult {
  const hosts: string[] = [];
  for (const entry of entries) {
    if (entry.trim() === "") continue;
    const host = normaliseRedirectHost(entry);
    if (host === null) return { ok: false, invalid: entry };
    if (!hosts.includes(host)) hosts.push(host);
  }
  return { ok: true, hosts };
}
