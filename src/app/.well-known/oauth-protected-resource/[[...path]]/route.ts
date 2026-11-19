import { NextResponse } from "next/server";

import { mcpModuleOffResponse } from "@/lib/mcp/http";
import { buildProtectedResourceMetadata } from "@/lib/mcp/oauth";

/**
 * GET /.well-known/oauth-protected-resource[/api/mcp] (ALP-653, RFC 9728)
 *
 * Tells an AI app which authorisation server issues tokens for this site's
 * MCP endpoint. Public by design and holds no member data. Answers the bare
 * path and the path-suffixed form, since apps ask for either.
 */
export async function GET() {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  return NextResponse.json(buildProtectedResourceMetadata(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
