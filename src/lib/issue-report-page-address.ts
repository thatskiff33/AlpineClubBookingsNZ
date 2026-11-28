/**
 * The page address an issue report names, as each caller may read it
 * (ALP-724). The officer's screen shows the address the member reported from
 * whole; an AI app gets the path only, because a query or fragment can carry a
 * one-time token, a search or another member's details.
 */
import "server-only";

import { arrivesAsMcpConnection } from "@/lib/mcp-connection-request";

/** The path of `pageUrl`, with no origin, query or fragment. */
export function issueReportPagePath(pageUrl: string): string {
  const withoutOrigin = pageUrl.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  const path = withoutOrigin.split(/[?#]/, 1)[0] ?? "";
  return path.startsWith("/") ? path : `/${path}`;
}

/** `pageUrl` whole for a browser, its path only for an AI app connection. */
export function issueReportPageAddressFor(request: Request, pageUrl: string): string {
  return arrivesAsMcpConnection(request) ? issueReportPagePath(pageUrl) : pageUrl;
}
