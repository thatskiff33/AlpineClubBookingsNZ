import { NextResponse } from "next/server";

import { hasAccessRole } from "@/lib/access-roles";
import { LODGE_ROSTER_CONNECTION_SHAPE } from "@/lib/connection-shapes";
import { projectForConnection } from "@/lib/connection-projection";
import { mcpModuleOffResponse } from "@/lib/mcp/http";
import { buildMemberLodgeRoster } from "@/lib/member-lodge-roster";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * GET /api/lodge-roster
 *
 * Who is staying at the lodges the signed-in member can book over the next
 * `ROSTER_WINDOW_DAYS` nights: the roster page's own loader,
 * `buildMemberLodgeRoster`, so every reduction `INV-PRIV-017` requires has
 * already happened before this route sees the data. It adds no filtering or
 * name formatting of its own, and takes no parameter that could widen the
 * window or name another member.
 *
 * Answers with names and nights only (`LODGE_ROSTER_CONNECTION_SHAPE`), the
 * fields the page draws, whoever asks.
 *
 * Added for AI app connections (ALP-718), so it is absent while that module is
 * off (`INV-MCP-001`), as well as while the roster is.
 */
export async function GET(request: Request) {
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
  if (!modules.memberLodgeRoster || !hasAccessRole(guard.session.user, "USER")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const roster = await buildMemberLodgeRoster(guard.session.user.id);
  return NextResponse.json(projectForConnection(roster, LODGE_ROSTER_CONNECTION_SHAPE));
}
