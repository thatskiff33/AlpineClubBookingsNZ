import { NextResponse } from "next/server";

import { mcpModuleOffResponse } from "@/lib/mcp/http";
import { buildAuthorizationServerMetadata } from "@/lib/mcp/oauth";

/**
 * GET /.well-known/oauth-authorization-server (ALP-653, RFC 8414)
 *
 * Tells an AI app where to register, where to send the member to approve, and
 * where to exchange the approval for tokens. Public by design and holds no
 * member data.
 */
export async function GET() {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  return NextResponse.json(buildAuthorizationServerMetadata(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
