import { NextResponse } from "next/server";

import { mcpModuleOffResponse } from "@/lib/mcp/http";
import { listMemberBookingSummaries } from "@/lib/member-self-read";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * GET /api/bookings/mine
 *
 * The signed-in member's bookings, newest stay first: the ones they made and
 * the ones they are a guest on. The same set the bookings page lists, up to
 * the newest 200; `truncated` says when there are older ones.
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

  return NextResponse.json(await listMemberBookingSummaries(guard.session.user.id));
}
