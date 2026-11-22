import { NextResponse } from "next/server";

import { hasAccessRole } from "@/lib/access-roles";
import { MEMBER_NOTICE_CONNECTION_SHAPE } from "@/lib/connection-shapes";
import { projectForConnection } from "@/lib/connection-projection";
import { mcpModuleOffResponse } from "@/lib/mcp/http";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getNoticeForMember } from "@/lib/notices";
import { memberNoticeAsText } from "@/lib/member-notice-text";
import { noticeIdParamsSchema } from "@/lib/notices-shared";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * GET /api/notices/[id]
 *
 * One notice the signed-in member can see, through the notice page's own
 * loader, so the audience rule is the page's: a notice outside it, or one
 * that does not exist, answers 404 alike. Reading marks nothing as read; that
 * is `POST /api/notices/[id]/read`.
 *
 * The body is sent as plain text, and only the fields the `get_notice` action
 * promises are sent at all.
 *
 * Added for AI app connections (ALP-718), so it is absent while that module is
 * off (`INV-MCP-001`), as well as while notices are.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  const limited = await applyRateLimit(rateLimiters.api, request);
  if (limited) return limited;

  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }
  // The proxy gates this path on the module too; a gate that lived only there
  // has shipped bypassed before (#2780).
  const modules = await loadEffectiveModuleFlags();
  // A kiosk-only (LODGE) account never reaches the member page this reuses:
  // the authenticated layout sends it to `/lodge/kiosk` (INV-PRIV-017).
  if (!modules.memberNotices || !hasAccessRole(guard.session.user, "USER")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = noticeIdParamsSchema.safeParse(await params);
  const notice = parsed.success
    ? await getNoticeForMember(guard.session.user.id, parsed.data.id)
    : null;
  if (!notice) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(
    projectForConnection({ notice: memberNoticeAsText(notice) }, MEMBER_NOTICE_CONNECTION_SHAPE),
  );
}
