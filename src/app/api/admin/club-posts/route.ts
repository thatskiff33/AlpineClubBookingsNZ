import { NextRequest, NextResponse } from "next/server";

import {
  listClubPostsForAdmin,
  parseAdminPostTab,
} from "@/lib/club-posts-admin";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/club-posts — the moderation list (#2998, epic #2992).
 *
 * The module is re-checked here as well as by the feature-route rule, because a
 * gate that lived only in middleware shipped bypassed once already (#2780
 * security review), and it is checked BEFORE the permission guard so an off
 * module cannot be probed by the difference between 403 and 404.
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

  const url = new URL(request.url);
  const posts = await listClubPostsForAdmin({
    tab: parseAdminPostTab(url.searchParams.get("tab")),
    q: url.searchParams.get("q")?.trim() || undefined,
  });

  return NextResponse.json({ posts });
}
