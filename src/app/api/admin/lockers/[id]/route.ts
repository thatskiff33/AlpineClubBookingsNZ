import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";

const updateLockerSchema = z.object({
  name: z
    .string()
    .trim()
    .transform((value) => value.replace(/\s+/g, " "))
    .pipe(z.string().min(1).max(200))
    .optional(),
  allocatedToMemberId: z.string().trim().min(1).max(191).nullable().optional(),
});

async function findDuplicateLockerName(
  name: string,
  excludeId: string,
  lodgeId: string | null,
) {
  // Per-lodge name uniqueness (lodgeId is NOT NULL on Locker): scope the
  // clash check to the requested lodge when one is given.
  return prisma.locker.findFirst({
    where: {
      id: { not: excludeId },
      name: {
        equals: name,
        mode: "insensitive",
      },
      ...(lodgeId ? { lodgeId } : {}),
    },
    select: { id: true },
  });
}

/**
 * PUT /api/admin/lockers/[id]
 * Updates locker name and allocation.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;

  const existing = await prisma.locker.findUnique({
    where: { id },
    select: { id: true, name: true, allocatedToMemberId: true, lodgeId: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Locker not found" }, { status: 404 });
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = updateLockerSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const allocatedToMemberId = parsed.data.allocatedToMemberId ?? null;
  if (allocatedToMemberId) {
    const member = await prisma.member.findFirst({
      where: { id: allocatedToMemberId, active: true },
      select: { id: true },
    });
    if (!member) {
      return NextResponse.json(
        { error: "Allocated member not found" },
        { status: 404 },
      );
    }
  }

  const nextName = parsed.data.name ?? existing.name;
  if (
    nextName !== existing.name &&
    (await findDuplicateLockerName(nextName, id, existing.lodgeId ?? null))
  ) {
    return NextResponse.json(
      { error: "A locker with that name already exists at this lodge" },
      { status: 409 },
    );
  }

  try {
    const locker = await prisma.$transaction(async (tx) => {
      const updated = await tx.locker.update({
        where: { id },
        data: { name: nextName, allocatedToMemberId },
        include: {
          allocatedTo: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      });

      await createAuditLog(
        {
          action: "locker.updated",
          memberId: guard.session.user.id,
          entityType: "Locker",
          entityId: updated.id,
          category: "admin",
          outcome: "success",
          summary: "Locker updated",
          metadata: {
            lockerId: updated.id,
            before: {
              name: existing.name,
              allocatedToMemberId: existing.allocatedToMemberId,
            },
            after: {
              name: updated.name,
              allocatedToMemberId: updated.allocatedToMemberId,
            },
          },
        },
        tx,
      );

      return updated;
    });

    return NextResponse.json({ locker });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "A locker with that name already exists" },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { error: "Failed to update locker" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/admin/lockers/[id]
 * Deletes a locker record after recording the previous allocation.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;

  const existing = await prisma.locker.findUnique({
    where: { id },
    select: { id: true, name: true, allocatedToMemberId: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Locker not found" }, { status: 404 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.locker.delete({ where: { id } });
    await createAuditLog(
      {
        action: "locker.deleted",
        memberId: guard.session.user.id,
        entityType: "Locker",
        entityId: id,
        category: "admin",
        outcome: "success",
        summary: "Locker deleted",
        metadata: {
          lockerId: id,
          name: existing.name,
          allocatedToMemberId: existing.allocatedToMemberId,
        },
      },
      tx,
    );
  });

  return NextResponse.json({ success: true });
}
