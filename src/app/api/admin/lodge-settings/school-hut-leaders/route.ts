import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import {
  loadSchoolHutLeaderKinds,
  saveSchoolHutLeaderKinds,
} from "@/lib/lodge-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

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

const kindsSchema = z
  .object({
    teacherOnBooking: z.boolean(),
    custodian: z.boolean(),
    memberOnBooking: z.boolean(),
    memberStayingSeparately: z.boolean(),
  })
  .strict();

const putSchema = z
  .object({
    lodgeId: z.string().min(1),
    kinds: kindsSchema,
  })
  .strict();

function lodgeNotFound() {
  return NextResponse.json({ error: "Lodge not found or not active" }, { status: 400 });
}

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const lodgeId = new URL(request.url).searchParams.get("lodgeId");
  if (!lodgeId || !(await findActiveLodge(lodgeId))) return lodgeNotFound();

  return NextResponse.json({ kinds: await loadSchoolHutLeaderKinds(prisma, lodgeId) });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const body = putSchema.safeParse(json.body);
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

  return NextResponse.json({ kinds: saved });
}
