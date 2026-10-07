import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  ACCESS_ROLE_DEFINITION_SELECT,
  buildAccessRoleOptions,
  buildUniqueAccessRoleKey,
  loadAccessRoleDefinitions,
  serializeAccessRoleDefinition,
} from "@/lib/access-role-definitions";
import { isFullAdmin } from "@/lib/access-roles";
import {
  accessRoleDefinitionHolderCounts,
  accessRolePermissionsSchema,
  definitionLevelDataFromPermissions,
} from "@/lib/access-role-definition-routes";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const createSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).optional().default(""),
    permissions: accessRolePermissionsSchema,
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const definitions = await loadAccessRoleDefinitions(prisma);
  const holderCounts = await accessRoleDefinitionHolderCounts(
    prisma,
    definitions,
  );

  return NextResponse.json({
    roles: definitions.map((definition) => ({
      ...serializeAccessRoleDefinition(definition),
      memberCount: holderCounts.get(definition.id) ?? 0,
    })),
    roleOptions: buildAccessRoleOptions(definitions),
  });
}

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  // Role definitions grant permissions, so managing them is Full-Admin-only
  // — the area-based route requirement cannot express this, and a custom
  // role could otherwise widen itself.
  if (!isFullAdmin(session.user)) {
    return NextResponse.json(
      { error: "Only a Full Admin can manage access roles" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const key = await buildUniqueAccessRoleKey(prisma, parsed.data.label);
  const lastDefinition = await prisma.accessRoleDefinition.findFirst({
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder =
    parsed.data.sortOrder ?? (lastDefinition?.sortOrder ?? -1) + 1;

  const created = await prisma.$transaction(async (tx) => {
    const definition = await tx.accessRoleDefinition.create({
      data: {
        key,
        label: parsed.data.label.trim(),
        description: parsed.data.description.trim(),
        sortOrder,
        ...definitionLevelDataFromPermissions(parsed.data.permissions),
      },
      select: ACCESS_ROLE_DEFINITION_SELECT,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "ACCESS_ROLE_DEFINITION_CREATED",
        actor: { memberId: session.user.id },
        entity: { type: "AccessRoleDefinition", id: definition.id },
        category: "admin",
        severity: "critical",
        outcome: "success",
        summary: "Access role created",
        metadata: {
          newAccessRoleDefinition: serializeAccessRoleDefinition(definition),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return definition;
  });

  return NextResponse.json(
    { role: serializeAccessRoleDefinition(created) },
    { status: 201 },
  );
}
