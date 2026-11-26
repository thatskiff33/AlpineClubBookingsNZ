import { NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import {
  loadSchoolHutLeaderKinds,
  saveSchoolHutLeaderKinds,
} from "@/lib/lodge-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  hutLeaderLodgeQuerySchema,
  schoolHutLeaderKindsBodySchema,
} from "@/lib/admin-lodge-schemas/hut-leaders";
import { ADMIN_SCHOOL_HUT_LEADER_KINDS_CONNECTION_SHAPE } from "@/lib/connection-shapes/lodge-hut-leaders";
import { connectionJson } from "@/lib/mcp-connection-request";

// "Who can be hut leader for school bookings" (#3819): one lodge's four kinds.
// Per lodge, so the lodge is always named (lodge-scoping contract) and must be
// active, exactly as the sibling lodge-settings route requires. Switched off
// with the Hut Leaders module by the shared route gate
// (`src/config/feature-routes.ts`), like the rest of hut-leader admin.
async function findActiveLodge(lodgeId: string): Promise<boolean> {
  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: { active: true },
  });
  return lodge?.active === true;
}

// The schemas live in admin-lodge-schemas/hut-leaders.ts so the AI app
// actions `get_school_hut_leader_kinds` and `update_school_hut_leader_kinds`
// offer the same fields (ALP-722).

function lodgeNotFound() {
  return NextResponse.json({ error: "Lodge not found or not active" }, { status: 400 });
}

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const query = hutLeaderLodgeQuerySchema.safeParse({
    lodgeId: new URL(request.url).searchParams.get("lodgeId") ?? undefined,
  });
  if (!query.success || !(await findActiveLodge(query.data.lodgeId))) return lodgeNotFound();

  return connectionJson(
    request,
    { kinds: await loadSchoolHutLeaderKinds(prisma, query.data.lodgeId) },
    ADMIN_SCHOOL_HUT_LEADER_KINDS_CONNECTION_SHAPE,
  );
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const body = schoolHutLeaderKindsBodySchema.safeParse(json.body);
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid input", details: body.error.flatten() },
      { status: 400 },
    );
  }
  const { lodgeId, kinds } = body.data;
  if (!(await findActiveLodge(lodgeId))) return lodgeNotFound();

  // "previous" is read inside the write's own transaction, so the audit row
  // names the value this save replaced.
  const { previous, saved } = await saveSchoolHutLeaderKinds({
    lodgeId,
    kinds,
    updatedByMemberId: guard.session.user.id,
  });

  await createAuditLog({
    action: "LODGE_SETTINGS_UPDATED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "LodgeSettings",
    entityId: lodgeId,
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: "Who can be hut leader for school bookings updated",
    metadata: {
      setting: "schoolHutLeaderKinds",
      previousSchoolHutLeaderKinds: previous,
      newSchoolHutLeaderKinds: saved,
    },
  });

  return connectionJson(request, { kinds: saved }, ADMIN_SCHOOL_HUT_LEADER_KINDS_CONNECTION_SHAPE);
}
