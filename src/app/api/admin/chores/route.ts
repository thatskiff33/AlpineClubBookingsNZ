import { NextRequest, NextResponse } from "next/server"
import { parseJsonRequestBody } from "@/lib/api-json"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { createAuditLog } from "@/lib/audit"
import {
  lodgeNullTolerantScope,
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges"
import {
  choreCreateBodySchema,
  choreListQuerySchema,
} from "@/lib/admin-lodge-schemas/chores-work-parties"
import {
  ADMIN_CHORE_CONNECTION_SHAPE,
  ADMIN_CHORE_LIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/lodge-chores-work-parties"
import { connectionJson, connectionListJson } from "@/lib/mcp-connection-request"

// The schemas live in admin-lodge-schemas/chores-work-parties.ts so the AI
// app actions `list_chore_templates` and `create_chore_template` offer the
// same fields (ALP-722).

export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;
  // Null-tolerant filter: rows without a lodgeId (pre-backfill or written by
  // a draining old colour during the expand deploy) show under every lodge.
  // A string or nothing always parses; the 400 is only a backstop.
  const query = choreListQuerySchema.safeParse({
    lodgeId: req.nextUrl.searchParams.get("lodgeId") ?? undefined,
  })
  if (!query.success) {
    return NextResponse.json({ error: query.error.issues[0]?.message }, { status: 400 })
  }
  const lodgeId = query.data.lodgeId
  // Validate an explicit lodge scope the way the POST path does (400 on
  // unknown/inactive). Omitted lists chores across every lodge, so only
  // validate when a lodgeId is supplied.
  if (lodgeId && !(await resolveOptionalActiveLodgeId(prisma, lodgeId))) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 }
    )
  }
  const chores = await prisma.choreTemplate.findMany({
    where: lodgeId ? lodgeNullTolerantScope(lodgeId) : undefined,
    orderBy: { sortOrder: "asc" },
  })
  // The browser keeps the bare array; a connection gets it under `chores`.
  return connectionListJson(req, chores, "chores", ADMIN_CHORE_LIST_CONNECTION_SHAPE)
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const jsonBody = await parseJsonRequestBody(req)
  if (!jsonBody.ok) return jsonBody.response
  const body = jsonBody.body
  const parsed = choreCreateBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { lodgeId: requestedLodgeId, ...data } = parsed.data
  if (data.recommendedPeopleMax < data.recommendedPeopleMin) {
    return NextResponse.json(
      { error: "Max people must be >= min people" },
      { status: 400 }
    )
  }

  const lodgeId = await resolveOptionalActiveLodgeId(prisma, requestedLodgeId);
  if (!lodgeId) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 }
    );
  }

  const chore = await prisma.choreTemplate.create({ data: { ...data, lodgeId } })

  // Audit the config write with the acting admin as actor (mirrors the
  // lodge-settings editor). This is what the bootstrap-import six-signal probe
  // (signal 6) relies on to detect a hand-configured club's chore templates.
  await createAuditLog({
    action: "CHORE_TEMPLATE_CREATED",
    memberId: guard.session.user.id,
    actorMemberId: guard.session.user.id,
    entityType: "ChoreTemplate",
    entityId: chore.id,
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: "Chore template created",
    metadata: {
      lodgeId,
      name: chore.name,
      isEssential: chore.isEssential,
      active: chore.active,
    },
  })

  return connectionJson(req, chore, ADMIN_CHORE_CONNECTION_SHAPE, { status: 201 })
}
