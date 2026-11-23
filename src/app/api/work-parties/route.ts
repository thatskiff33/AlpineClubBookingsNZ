import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { canViewWorkParties } from "@/lib/work-party-access";
import { listUpcomingMemberWorkParties } from "@/lib/work-party-member";
import { MEMBER_WORK_PARTY_LIST_LIMIT } from "@/lib/work-party-query-schema";
import { MEMBER_WORK_PARTY_LIST_CONNECTION_SHAPE } from "@/lib/connection-shapes-lodge-life";
import { connectionJson } from "@/lib/mcp-connection-request";
import { mcpModuleOffResponse } from "@/lib/mcp/http";

/**
 * Upcoming open work parties, as the dashboard's Work Parties card lists them
 * (#5148), for the AI app action `list_work_parties` (ALP-796). The card's own
 * loader (`listUpcomingMemberWorkParties`), so the two cannot disagree about
 * which work parties are open. Never the internal promo code.
 *
 * Members only (`canViewWorkParties`), and 404 with the Work Parties module
 * off, exactly as `GET /api/work-parties/[id]`. No website page calls it, so
 * it is also 404 while the AI apps module (`mcpServer`) is off (INV-MCP-001).
 */
export async function GET(req: NextRequest) {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  const rateLimited = await applyRateLimit(rateLimiters.bookingQuery, req);
  if (rateLimited) return rateLimited;

  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  const modules = await loadEffectiveModuleFlags();
  if (!modules.workParties || !canViewWorkParties(guard.session.user)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const workParties = await listUpcomingMemberWorkParties(
    await clubTodayDateOnlyInstant(),
    MEMBER_WORK_PARTY_LIST_LIMIT,
  );
  return connectionJson(req, { workParties }, MEMBER_WORK_PARTY_LIST_CONNECTION_SHAPE);
}
