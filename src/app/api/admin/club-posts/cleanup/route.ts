import { NextResponse } from "next/server";

import { logAudit } from "@/lib/audit";
import { runClubPostCleanup } from "@/lib/club-post-retention";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { requireAdmin } from "@/lib/session-guards";
import { connectionJson } from "@/lib/mcp-connection-request";
import { CLUB_POST_CLEANUP_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-notices";

/**
 * POST /api/admin/club-posts/cleanup — run the retention pass now (#2999).
 *
 * The same function the scheduled cron calls. It takes a single-flight claim, so
 * pressing this while the scheduled pass is running reports `busy` rather than
 * deleting twice.
 */
export async function POST(request: Request) {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.commsPortal) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  try {
    const outcome = await runClubPostCleanup();

    // Audited even when nothing was deleted: "somebody ran this and it removed
    // nothing" is exactly what you want on the record when a member asks where
    // their post went.
    logAudit({
      action: "club_post.retention.run",
      category: "communication",
      memberId: guard.session.user.id,
      entityType: "ClubPostSettings",
      entityId: "default",
      details: outcome.skipped
        ? `Ran club message board cleanup: skipped (${outcome.skipped}).`
        : `Ran club message board cleanup: deleted ${outcome.deleted} post(s).`,
    });

    return connectionJson(request, outcome, CLUB_POST_CLEANUP_CONNECTION_SHAPE);
  } catch (error) {
    logger.error({ err: error }, "club post cleanup failed");
    return NextResponse.json(
      { error: "The cleanup could not be run." },
      { status: 500 },
    );
  }
}
