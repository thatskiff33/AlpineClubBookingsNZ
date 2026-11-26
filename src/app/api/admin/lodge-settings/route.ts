import { NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  lodgeSettingsBodySchema,
  lodgeSettingsQuerySchema,
} from "@/lib/admin-lodge-schemas/setup";
import { createAuditLog } from "@/lib/audit";
import {
  ADMIN_LODGE_SETTINGS_CONNECTION_SHAPE,
  ADMIN_LODGE_SETTINGS_SAVED_CONNECTION_SHAPE,
  type LodgeSettingsAnswer,
  type LodgeSettingsSavedAnswer,
} from "@/lib/connection-shapes/lodge-setup";
import {
  CLUB_CONFIG_LODGE_CAPACITY,
  getLodgeCapacityStatus,
} from "@/lib/lodge-capacity";
import { isLodgeSetUpForBookings } from "@/lib/lodge-booking-readiness";
import {
  loadLodgeSettings,
  updateLodgeSettings,
} from "@/lib/lodge-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { connectionJson } from "@/lib/mcp-connection-request";

// Per-lodge scope (lodge-scoping contract): an explicit lodgeId must name
// an active lodge; omitted keeps the legacy single-row behaviour.
async function validateLodgeScope(lodgeId: string | null | undefined) {
  if (!lodgeId) return { ok: true as const };
  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: { active: true },
  });
  if (!lodge?.active) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      ),
    };
  }
  return { ok: true as const };
}

// The query and body schemas (capacity bounds shared with every editor of the
// field, #2724) live in admin-lodge-schemas/setup.ts so the AI app actions
// `get_lodge_settings` and `update_lodge_settings` offer the same fields
// (ALP-722).

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  // A string or nothing always parses, and an empty value reads the club-wide
  // row as it always has; the 400 is only a backstop.
  const query = lodgeSettingsQuerySchema.safeParse({
    lodgeId: new URL(request.url).searchParams.get("lodgeId") ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }
  const lodgeId = query.data.lodgeId ?? null;
  const scope = await validateLodgeScope(lodgeId);
  if (!scope.ok) return scope.response;

  const settings = await loadLodgeSettings(prisma, lodgeId);
  // Whether the named lodge can take a booking at all, from the one resolver
  // every booking path reads (#3407). The lodge setup wizard reads it before
  // it may say a lodge is ready: the configured figure alone cannot answer that
  // with Bed Allocation on, where active beds count too. Only for an explicit
  // lodge — the legacy no-lodgeId read has no lodge to resolve.
  // The resolved figure goes with it, so "ready" can state the real capacity
  // (with Bed Allocation on, the lower of the beds and the typed ceiling).
  const resolvedCapacity = lodgeId
    ? (await getLodgeCapacityStatus(lodgeId)).capacity
    : undefined;
  const setUpForBookings =
    resolvedCapacity === undefined
      ? undefined
      : isLodgeSetUpForBookings(resolvedCapacity);
  const answer: LodgeSettingsAnswer = {
    capacity: settings.capacity,
    hutLeaderLookaheadDays: settings.hutLeaderLookaheadDays,
    schoolGroupSoftCap: settings.schoolGroupSoftCap,
    clubConfigCapacity: CLUB_CONFIG_LODGE_CAPACITY,
    ...(setUpForBookings === undefined
      ? {}
      : { setUpForBookings, resolvedCapacity }),
  };
  return connectionJson(request, answer, ADMIN_LODGE_SETTINGS_CONNECTION_SHAPE);
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const body = lodgeSettingsBodySchema.safeParse(json.body);
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid input", details: body.error.flatten() },
      { status: 400 },
    );
  }

  const scope = await validateLodgeScope(body.data.lodgeId);
  if (!scope.ok) return scope.response;

  const previousSettings = await loadLodgeSettings(prisma, body.data.lodgeId);
  const settings = await updateLodgeSettings({
    capacity: body.data.capacity,
    hutLeaderLookaheadDays:
      body.data.hutLeaderLookaheadDays ??
      previousSettings.hutLeaderLookaheadDays,
    // Omitted keeps the current value; explicit null clears to the default.
    schoolGroupSoftCap:
      body.data.schoolGroupSoftCap === undefined
        ? previousSettings.schoolGroupSoftCap
        : body.data.schoolGroupSoftCap,
    updatedByMemberId: guard.session.user.id,
    lodgeId: body.data.lodgeId,
  });
  // #2352 slice-1 review. This was `invalidatePublicLodgeCapacity()`, i.e. the
  // capacity TAG only. `{{lodge-capacity}}` is resolved server-side from uncached
  // reads, so the stored CMS page carries no capacity tag and a tag clear expired
  // nothing — `/accommodation` kept advertising the old bed count until the
  // 300-second backstop lapsed AND a further request arrived. The full clear is
  // what makes a capacity save behave like every other admin save.
  revalidatePublicSite();

  await createAuditLog({
    action: "LODGE_SETTINGS_UPDATED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "LodgeSettings",
    entityId: body.data.lodgeId ?? "default",
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

  const saved: LodgeSettingsSavedAnswer = {
    capacity: settings.capacity,
    hutLeaderLookaheadDays: settings.hutLeaderLookaheadDays,
    schoolGroupSoftCap: settings.schoolGroupSoftCap,
    clubConfigCapacity: CLUB_CONFIG_LODGE_CAPACITY,
  };
  return connectionJson(request, saved, ADMIN_LODGE_SETTINGS_SAVED_CONNECTION_SHAPE);
}
