import { NextResponse } from "next/server";

import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { listNoticesForMember } from "@/lib/notices";
import { requireActiveSession } from "@/lib/session-guards";

const NOTICE_LIST_LIMIT = 50;

/**
 * GET /api/notices
 *
 * The notices the signed-in member can see, pinned first and then newest: the
 * same read as the notices page. Listing marks nothing as read.
 */
export async function GET() {
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
    limit: NOTICE_LIST_LIMIT,
  });
  return NextResponse.json({ notices });
}
