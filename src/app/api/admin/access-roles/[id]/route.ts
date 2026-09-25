import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  ACCESS_ROLE_DEFINITION_SELECT,
  serializeAccessRoleDefinition,
} from "@/lib/access-role-definitions";
import { isFullAdmin } from "@/lib/access-roles";
import {
  accessRolePermissionsSchema,
  definitionLevelDataFromPermissions,
} from "@/lib/access-role-definition-routes";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const patchSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
    permissions: accessRolePermissionsSchema.optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

function fullAdminOnlyResponse() {
  return NextResponse.json(
    { error: "Only a Full Admin can manage access roles" },
    { status: 403 },
  );
}

function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  // Role definitions grant permissions, so managing them is Full-Admin-only
  // — the area-based route requirement cannot express this, and a custom
  // role could otherwise widen itself.
  if (!isFullAdmin(session.user)) {
    return fullAdminOnlyResponse();
  }

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "At least one access role field is required" },
      { status: 400 },
    );
  }

  const existing = await prisma.accessRoleDefinition.findUnique({
    where: { id: parsedParams.data.id },
    select: ACCESS_ROLE_DEFINITION_SELECT,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Access role not found" },
      { status: 404 },
    );
  }

  const data: Prisma.AccessRoleDefinitionUpdateInput = {};
  if (parsed.data.label !== undefined) {
    data.label = parsed.data.label.trim();
  }
  if (parsed.data.description !== undefined) {
    data.description = parsed.data.description.trim();
  }
  if (parsed.data.sortOrder !== undefined) {
    data.sortOrder = parsed.data.sortOrder;
  }
  if (parsed.data.permissions !== undefined) {
    Object.assign(
      data,
      definitionLevelDataFromPermissions(parsed.data.permissions),
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const definition = await tx.accessRoleDefinition.update({
      where: { id: existing.id },
      data,
      select: ACCESS_ROLE_DEFINITION_SELECT,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "ACCESS_ROLE_DEFINITION_UPDATED",
        actor: { memberId: session.user.id },
        entity: { type: "AccessRoleDefinition", id: existing.id },
        category: "admin",
        severity: "critical",
        outcome: "success",
        summary: "Access role updated",
        metadata: {
          changedFields: changedFields(
            existing,
            data as Record<string, unknown>,
          ),
          previousAccessRoleDefinition:
            serializeAccessRoleDefinition(existing),
          newAccessRoleDefinition: serializeAccessRoleDefinition(definition),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return definition;
  });

  return NextResponse.json({ role: serializeAccessRoleDefinition(updated) });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  if (!isFullAdmin(session.user)) {
    return fullAdminOnlyResponse();
  }

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.accessRoleDefinition.findUnique({
    where: { id: parsedParams.data.id },
    select: ACCESS_ROLE_DEFINITION_SELECT,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Access role not found" },
      { status: 404 },
    );
  }

  // Block while assigned: count members holding the definition via the link
  // OR via a bare enum row for its systemRole (pre-backfill rows), so a
  // delete can never orphan live access. The Restrict FK is the backstop.
  const holderCount = await prisma.memberAccessRole.count({
    where: {
      OR: [
        { roleDefinitionId: existing.id },
        ...(existing.systemRole ? [{ role: existing.systemRole }] : []),
      ],
    },
  });
  if (holderCount > 0) {
    return NextResponse.json(
      {
        error: `This access role is assigned to ${holderCount} member${holderCount === 1 ? "" : "s"}. Remove it from all members before deleting.`,
        memberCount: holderCount,
      },
      { status: 409 },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.accessRoleDefinition.delete({ where: { id: existing.id } });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "ACCESS_ROLE_DEFINITION_DELETED",
        actor: { memberId: session.user.id },
        entity: { type: "AccessRoleDefinition", id: existing.id },
        category: "admin",
        severity: "critical",
        outcome: "success",
        summary: "Access role deleted",
        metadata: {
          previousAccessRoleDefinition:
            serializeAccessRoleDefinition(existing),
        },
        request: getAuditRequestContext(request),
      }),
    );
  });

  return NextResponse.json({ ok: true });
}
