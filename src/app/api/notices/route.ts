import { NextResponse } from "next/server";

import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { mcpModuleOffResponse } from "@/lib/mcp/http";
import { listNoticesForMember } from "@/lib/notices";
import { MEMBER_NOTICE_LIST_LIMIT } from "@/lib/notice-list-limit";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * GET /api/notices
 *
 * The notices the signed-in member can see, pinned first and then newest: the
 * same read as the notices page. Listing marks nothing as read.
 *
 * Added for AI app connections (ALP-653), so it is absent while that module is
 * off (`INV-MCP-001`), as well as while notices are.
 */
export async function GET() {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }
  // The proxy gates this path on the module too; a gate that lived only there
  // has shipped bypassed before (#2780).
  const modules = await loadEffectiveModuleFlags();
  if (!modules.memberNotices) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const notices = await listNoticesForMember(guard.session.user.id, {
    limit: MEMBER_NOTICE_LIST_LIMIT,
  });
  return NextResponse.json({ notices });
}
