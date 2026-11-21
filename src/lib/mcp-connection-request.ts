/**
 * Whether a request arrives as an AI app connection (ALP-653, `INV-MCP-006`).
 *
 * Presence of the internal principal header is enough: such a request is that
 * connection or nobody (`auth()` never falls back to a cookie), so a route
 * that narrows authority or sends a connection less may decide on presence
 * and lose nothing. Outside a request there are no headers and so no
 * connection.
 *
 * It lives outside `src/lib/mcp/` on purpose: an older route that sends a
 * connection less imports it, and a route importing `@/lib/mcp/` is read as
 * built on the module by `mcp-module-off.test.ts`.
 */
import "server-only";

import { headers } from "next/headers";

import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

/** For a handler that has the request. */
export function arrivesAsMcpConnection(request: Request): boolean {
  return request.headers.has(MCP_PRINCIPAL_HEADER);
}

/** For a handler with no `request` argument: reads the request being served. */
export async function servingMcpConnection(): Promise<boolean> {
  try {
    return (await headers()).has(MCP_PRINCIPAL_HEADER);
  } catch {
    return false;
  }
}
