import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { CLUB_CONFIG_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import {
  loadLodgeSettings,
  MAX_HUT_LEADER_LOOKAHEAD_DAYS,
  updateLodgeSettings,
} from "@/lib/lodge-settings";
import { requireAdmin } from "@/lib/session-guards";

const settingsSchema = z
  .object({
    // Null clears the override and falls back to the club config bed total.
    capacity: z.number().int().positive().max(100000).nullable(),
    hutLeaderLookaheadDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_HUT_LEADER_LOOKAHEAD_DAYS)
      .optional(),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const settings = await loadLodgeSettings();
  return NextResponse.json({
    capacity: settings.capacity,
    hutLeaderLookaheadDays: settings.hutLeaderLookaheadDays,
    clubConfigCapacity: CLUB_CONFIG_LODGE_CAPACITY,
  });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const body = settingsSchema.safeParse(json.body);
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid input", details: body.error.flatten() },
      { status: 400 },
    );
  }

  const previousSettings = await loadLodgeSettings();
  const settings = await updateLodgeSettings({
    capacity: body.data.capacity,
    hutLeaderLookaheadDays:
      body.data.hutLeaderLookaheadDays ??
      previousSettings.hutLeaderLookaheadDays,
    updatedByMemberId: guard.session.user.id,
  });

  await createAuditLog({
    action: "LODGE_SETTINGS_UPDATED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "LodgeSettings",
    entityId: "default",
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: "Lodge settings updated",
    metadata: {
      previousCapacity: previousSettings.capacity,
      newCapacity: settings.capacity,
      previousHutLeaderLookaheadDays:
        previousSettings.hutLeaderLookaheadDays,
      newHutLeaderLookaheadDays: settings.hutLeaderLookaheadDays,
    },
  });

  return NextResponse.json({
    capacity: settings.capacity,
    hutLeaderLookaheadDays: settings.hutLeaderLookaheadDays,
    clubConfigCapacity: CLUB_CONFIG_LODGE_CAPACITY,
  });
}
