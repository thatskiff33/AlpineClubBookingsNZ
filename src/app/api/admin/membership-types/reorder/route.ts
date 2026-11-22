import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  membershipTypeOrderBy,
  serializeMembershipType,
} from "@/lib/membership-types";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const membershipTypeSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  publicDescription: true,
  publiclyListed: true,
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: true,
  subscriptionBehavior: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  allowedAgeTiers: {
    select: { ageTier: true },
    orderBy: { ageTier: "asc" },
  },
  xeroContactGroupRules: {
    select: {
      id: true,
      ageTiers: true,
      mode: true,
      groupId: true,
      groupName: true,
      isActive: true,
      sortOrder: true,
    },
    orderBy: [{ sortOrder: "asc" }, { groupName: "asc" }, { groupId: "asc" }],
  },
  _count: { select: { assignments: true } },
} satisfies Prisma.MembershipTypeSelect;

const reorderSchema = z
  .object({
    orderedIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const uniqueIds = new Set(parsed.data.orderedIds);
  if (uniqueIds.size !== parsed.data.orderedIds.length) {
    return NextResponse.json(
      { error: "Membership type ids must be unique" },
      { status: 400 },
    );
  }

  const before = await prisma.membershipType.findMany({
    orderBy: membershipTypeOrderBy(),
    select: membershipTypeSelect,
  });
  const existingIds = new Set(before.map((type) => type.id));
  const missingIds = parsed.data.orderedIds.filter((id) => !existingIds.has(id));
  if (missingIds.length > 0) {
    return NextResponse.json(
      { error: "One or more membership types were not found", missingIds },
      { status: 404 },
    );
  }

  await prisma.$transaction(async (tx) => {
    for (const [sortOrder, id] of parsed.data.orderedIds.entries()) {
      await tx.membershipType.update({
        where: { id },
        data: { sortOrder },
      });
    }

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBERSHIP_TYPES_REORDERED",
        actor: { memberId: session.user.id },
        entity: { type: "MembershipType", id: "membership-types" },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Membership types reordered",
        metadata: {
          previousOrder: before.map((type) => ({
            id: type.id,
            key: type.key,
            sortOrder: type.sortOrder,
          })),
          newOrder: parsed.data.orderedIds.map((id, sortOrder) => ({
            id,
            sortOrder,
          })),
        },
        request: getAuditRequestContext(request),
      }),
    );
  });

  const updated = await prisma.membershipType.findMany({
    orderBy: membershipTypeOrderBy(),
    select: membershipTypeSelect,
  });

  revalidatePath("/", "layout");
  return NextResponse.json({
    membershipTypes: updated.map(serializeMembershipType),
  });
}
