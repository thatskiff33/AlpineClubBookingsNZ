import { NextResponse } from "next/server";

import { mcpModuleOffResponse } from "@/lib/mcp/http";
import { buildProtectedResourceMetadata } from "@/lib/mcp/oauth";

/**
 * GET /.well-known/oauth-protected-resource (ALP-653, RFC 9728)
 *
 * Tells an AI app which authorisation server issues tokens for this site's
 * MCP endpoint. Public by design and holds no member data. Apps ask for the
 * bare path or the path-suffixed form; `api/mcp/route.ts` beside this file
 * serves the second with this handler. Two fixed paths rather than a
 * catch-all, so no asset-shaped address can land here.
 */
export async function GET() {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  return NextResponse.json(buildProtectedResourceMetadata(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
