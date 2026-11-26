import { NextRequest, NextResponse } from "next/server";

import {
  listClubPostsForAdmin,
  parseAdminPostTab,
} from "@/lib/club-posts-admin";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { requireAdmin } from "@/lib/session-guards";
import { clubPostListQuerySchema } from "@/lib/admin-membership-api/notices";
import { connectionJson } from "@/lib/mcp-connection-request";
import { CLUB_POST_LIST_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-notices";

/**
 * GET /api/admin/club-posts — the moderation list (#2998, epic #2992).
 *
 * The module is re-checked here as well as by the feature-route rule, because a
 * gate that lived only in middleware shipped bypassed once already (#2780
 * security review), and it is checked BEFORE the permission guard so an off
 * module cannot be probed by the difference between 403 and 404. An AI app
 * connection is sent the list without `removedAt`, always null here (ALP-720).
 */
export async function GET(request: NextRequest) {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.commsPortal) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const query = clubPostListQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: query.error.flatten() },
      { status: 400 },
    );
  }
  const posts = await listClubPostsForAdmin({
    tab: parseAdminPostTab(query.data.tab),
    q: query.data.q?.trim() || undefined,
  });

  return connectionJson(request, { posts }, CLUB_POST_LIST_CONNECTION_SHAPE);
}
