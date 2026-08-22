import { NextRequest, NextResponse } from "next/server";

import { logAudit } from "@/lib/audit";
import {
  ClubPostSettingsValidationError,
  countPostsBeyondRetention,
  loadClubPostSettings,
  saveClubPostRetention,
} from "@/lib/club-post-retention";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET|PUT /api/admin/club-posts/settings — the board's retention window
 * (#2999, epic #2992).
 *
 * GET also answers how many posts the CURRENT window would delete, so the
 * screen can show the consequence before an admin saves rather than after.
 */

async function gate(level: "view" | "edit") {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.commsPortal) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  return requireAdmin({ permission: { area: "membership", level } });
}

export async function GET() {
  const guard = await gate("view");
  if (!guard.ok) return guard.response;

  const settings = await loadClubPostSettings();
  return NextResponse.json({
    settings,
    beyondRetention: await countPostsBeyondRetention(settings.retentionDays),
  });
}

export async function PUT(request: NextRequest) {
  const guard = await gate("edit");
  if (!guard.ok) return guard.response;

  const body = await request.json().catch(() => null);
  const before = await loadClubPostSettings();

  try {
    const settings = await saveClubPostRetention(
      (body as { retentionDays?: unknown })?.retentionDays,
      guard.session.user.id,
    );

    logAudit({
      action: "club_post.retention.update",
      category: "communication",
      memberId: guard.session.user.id,
      entityType: "ClubPostSettings",
      entityId: "default",
      // Both values, because this setting silently destroys member content on a
      // schedule and what it was before is the first thing anybody will ask.
      details: `Club message board retention changed from ${before.retentionDays} to ${settings.retentionDays} days (0 = keep everything).`,
    });

    return NextResponse.json({
      settings,
      beyondRetention: await countPostsBeyondRetention(settings.retentionDays),
    });
  } catch (error) {
    if (error instanceof ClubPostSettingsValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logger.error({ err: error }, "failed to save club post retention");
    return NextResponse.json(
      { error: "That setting could not be saved." },
      { status: 500 },
    );
  }
}
