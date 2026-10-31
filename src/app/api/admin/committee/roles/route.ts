import { NextResponse } from "next/server";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  buildUniqueCommitteeRoleKey,
  committeeRoleOrderBy,
  committeeRoleSelect,
  normalizeCommitteeEmail,
  normalizeCommitteeText,
  serializeCommitteeRole,
} from "@/lib/committee";
import { committeeRoleCreateSchema } from "@/lib/forms/committee-role-schema";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";


export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const roles = await prisma.committeeRole.findMany({
    orderBy: committeeRoleOrderBy(),
    select: committeeRoleSelect,
  });

  return NextResponse.json({
    roles: roles.map(serializeCommitteeRole),
  });
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = committeeRoleCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const key = await buildUniqueCommitteeRoleKey(prisma, parsed.data.name);
  const lastRole = await prisma.committeeRole.findFirst({
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = parsed.data.sortOrder ?? (lastRole?.sortOrder ?? -1) + 1;

  const created = await prisma.$transaction(async (tx) => {
    const role = await tx.committeeRole.create({
      data: {
        key,
        name: parsed.data.name.trim(),
        description: normalizeCommitteeText(parsed.data.description),
        contactEmail: normalizeCommitteeEmail(parsed.data.contactEmail),
        isActive: parsed.data.isActive,
        sortOrder,
      },
      select: committeeRoleSelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "COMMITTEE_ROLE_CREATED",
        actor: { memberId: session.user.id },
        entity: { type: "CommitteeRole", id: role.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Committee role created",
        metadata: { newCommitteeRole: serializeCommitteeRole(role) },
        request: getAuditRequestContext(request),
      }),
    );

    return role;
  });

  return NextResponse.json(
    { role: serializeCommitteeRole(created) },
    { status: 201 },
  );
}
