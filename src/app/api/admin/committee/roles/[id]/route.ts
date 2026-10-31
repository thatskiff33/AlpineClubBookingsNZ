import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  committeeRoleSelect,
  normalizeCommitteeEmail,
  normalizeCommitteeText,
  serializeCommitteeRole,
} from "@/lib/committee";
import { committeeRolePatchSchema } from "@/lib/forms/committee-role-schema";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({
  id: z.string().min(1),
});

function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

function auditActionForUpdate(
  before: { isActive: boolean },
  data: { isActive?: boolean },
) {
  if (data.isActive === false && before.isActive) {
    return {
      action: "COMMITTEE_ROLE_ARCHIVED",
      summary: "Committee role archived",
    };
  }
  if (data.isActive === true && !before.isActive) {
    return {
      action: "COMMITTEE_ROLE_REACTIVATED",
      summary: "Committee role reactivated",
    };
  }
  return {
    action: "COMMITTEE_ROLE_UPDATED",
    summary: "Committee role updated",
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

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

  const parsed = committeeRolePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "At least one committee role field is required" },
      { status: 400 },
    );
  }

  const existing = await prisma.committeeRole.findUnique({
    where: { id: parsedParams.data.id },
    select: committeeRoleSelect,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Committee role not found" },
      { status: 404 },
    );
  }

  const data: Prisma.CommitteeRoleUpdateInput = {};
  if (parsed.data.name !== undefined) {
    data.name = parsed.data.name.trim();
  }
  if (parsed.data.description !== undefined) {
    data.description = normalizeCommitteeText(parsed.data.description);
  }
  if (parsed.data.contactEmail !== undefined) {
    data.contactEmail = normalizeCommitteeEmail(parsed.data.contactEmail);
  }
  if (parsed.data.isActive !== undefined) {
    data.isActive = parsed.data.isActive;
  }
  if (parsed.data.sortOrder !== undefined) {
    data.sortOrder = parsed.data.sortOrder;
  }

  const auditAction = auditActionForUpdate(existing, parsed.data);
  const updated = await prisma.$transaction(async (tx) => {
    const role = await tx.committeeRole.update({
      where: { id: existing.id },
      data,
      select: committeeRoleSelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: auditAction.action,
        actor: { memberId: session.user.id },
        entity: { type: "CommitteeRole", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: auditAction.summary,
        metadata: {
          changedFields: changedFields(existing, data as Record<string, unknown>),
          previousCommitteeRole: serializeCommitteeRole(existing),
          newCommitteeRole: serializeCommitteeRole(role),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return role;
  });

  return NextResponse.json({ role: serializeCommitteeRole(updated) });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.committeeRole.findUnique({
    where: { id: parsedParams.data.id },
    select: committeeRoleSelect,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Committee role not found" },
      { status: 404 },
    );
  }

  if ((existing._count?.assignments ?? 0) > 0) {
    return NextResponse.json(
      {
        error:
          "Committee roles with assignments cannot be deleted. Archive the role instead.",
      },
      { status: 409 },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.committeeRole.delete({ where: { id: existing.id } });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "COMMITTEE_ROLE_DELETED",
        actor: { memberId: session.user.id },
        entity: { type: "CommitteeRole", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Committee role deleted",
        metadata: { previousCommitteeRole: serializeCommitteeRole(existing) },
        request: getAuditRequestContext(request),
      }),
    );
  });

  return NextResponse.json({ ok: true });
}
