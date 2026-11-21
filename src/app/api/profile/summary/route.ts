import { NextResponse } from "next/server";

import { mcpModuleOffResponse } from "@/lib/mcp/http";
import { getMemberProfileSummary } from "@/lib/member-self-read";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * GET /api/profile/summary
 *
 * The signed-in member's own contact details. Never another member's: the id
 * comes from the session and the route takes no other.
 *
 * Added for AI app connections (ALP-653), so it is absent while that module is
 * off (`INV-MCP-001`).
 */
export async function GET() {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }

  const profile = await getMemberProfileSummary(guard.session.user.id);
  if (!profile) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ profile });
}
