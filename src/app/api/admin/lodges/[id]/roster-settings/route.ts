import { NextResponse } from "next/server";
import { z } from "zod";

import { createAuditLog } from "@/lib/audit";
import { DISPLAY_NAME_GRANULARITY_VALUES } from "@/lib/display-name-granularity-choices";
import { DEFAULT_ROSTER_NAME_GRANULARITY } from "@/lib/member-lodge-roster";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET|PUT /api/admin/lodges/[id]/roster-settings — how much of a name the
 * member lodge roster shows for ONE lodge (#2942, owner decision D2).
 *
 * WHY THIS IS ITS OWN ROUTE RATHER THAN A FIELD ON AN EXISTING ONE. Two
 * existing routes were the obvious candidates and both are the wrong home.
 * `/api/admin/display/lodge-config` edits the SIBLING column
 * (`Lodge.displayNameGranularity`) for the lobby screen, but everything about
 * it — its path, its payload, its `LODGE_DISPLAY_CONFIG_UPDATED` action and its
 * "Lodge display configuration updated" summary — says display. A roster
 * privacy change recorded under that action is an audit trail that names the
 * wrong feature, which is worse than no trail because it reads as trustworthy.
 * `PATCH /api/admin/lodges/[id]` edits lodge identity inside a transaction
 * holding the config-import singleton and the per-lodge capacity key, which a
 * settings write has no business taking.
 *
 * It sits UNDER `/api/admin/lodges/` on purpose: that prefix already resolves
 * to the `lodge` permission area in `admin-permissions.ts`, so the gate below
 * is the one the route map infers and no prefix has to be invented.
 *
 * NOT GATED ON THE MODULE FLAG, DELIBERATELY. An administrator has to be able
 * to choose the disclosure level BEFORE switching the roster on — a club that
 * can only set it afterwards has to publish full names for however long it
 * takes them to find the dial. The GET reports whether the roster is currently
 * on so the screen can say whether the setting is doing anything yet, and the
 * roster surface itself is gated by `FEATURE_ROUTE_RULES` and by its own
 * re-check of the flag.
 */

const paramsSchema = z.object({ id: z.string().min(1) });

const putSchema = z
  .object({
    // Null clears the per-lodge choice and falls back to the roster default.
    rosterNameGranularity: z
      .enum(DISPLAY_NAME_GRANULARITY_VALUES)
      .nullable(),
  })
  .strict();

async function readSettings(lodgeId: string) {
  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: { id: true, name: true, rosterNameGranularity: true },
  });
  if (!lodge) return null;
  const modules = await loadEffectiveModuleFlags();
  return {
    lodgeId: lodge.id,
    lodgeName: lodge.name,
    rosterNameGranularity: lodge.rosterNameGranularity,
    // The fallback is resolved in application code and is NOT the lobby
    // display's, so the screen is told what it is rather than restating a
    // default that would then be able to drift from the one the roster reads.
    defaultRosterNameGranularity: DEFAULT_ROSTER_NAME_GRANULARITY,
    memberLodgeRosterEnabled: modules.memberLodgeRoster,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid lodge id" }, { status: 400 });
  }

  const settings = await readSettings(parsedParams.data.id);
  if (!settings) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }
  return NextResponse.json(settings);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid lodge id" }, { status: 400 });
  }

  let body: z.infer<typeof putSchema>;
  try {
    body = putSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Read the previous value before writing it: the audit row's whole value here
  // is saying which way the disclosure moved, and a row recording only the new
  // level cannot answer "did somebody widen this".
  const before = await prisma.lodge.findUnique({
    where: { id: parsedParams.data.id },
    select: { id: true, rosterNameGranularity: true },
  });
  if (!before) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  await prisma.lodge.update({
    where: { id: parsedParams.data.id },
    data: { rosterNameGranularity: body.rosterNameGranularity },
  });

  // Category `admin`, matching every other writer under `/api/admin/lodges/`
  // (`LODGE_CREATED`, `LODGE_UPDATED`, and the lodge-settings and
  // lodge-instruction writers beside them). That group is pinned as uniform at
  // `admin` by `INV-PRIV-013`, and filing this one `lodge` because the sibling
  // DISPLAY writer does would open exactly the split the invariant exists to
  // close. The pin lives in
  // `scripts/audit/audit-writer-census-manifest.ts` ->
  // `LODGE_GATED_ADMIN_CATEGORIES_2765`.
  await createAuditLog({
    action: "LODGE_MEMBER_ROSTER_SETTINGS_UPDATED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "Lodge",
    entityId: parsedParams.data.id,
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: "Member lodge roster name detail updated",
    metadata: {
      before: { rosterNameGranularity: before.rosterNameGranularity },
      after: { rosterNameGranularity: body.rosterNameGranularity },
    },
  });

  const settings = await readSettings(parsedParams.data.id);
  if (!settings) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }
  return NextResponse.json(settings);
}
