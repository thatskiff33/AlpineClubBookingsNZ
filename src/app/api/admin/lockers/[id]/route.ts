import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";

const updateLockerSchema = z.object({
  allocatedToMemberId: z.string().trim().min(1).max(191).nullable().optional(),
});

/**
 * PUT /api/admin/lockers/[id]
 * Updates locker allocation while keeping locker name unchanged.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;

  const existing = await prisma.locker.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Locker not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateLockerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const allocatedToMemberId = parsed.data.allocatedToMemberId ?? null;
  if (allocatedToMemberId) {
    const member = await prisma.member.findUnique({
      where: { id: allocatedToMemberId },
      select: { id: true },
    });
    if (!member) {
      return NextResponse.json(
        { error: "Allocated member not found" },
        { status: 404 },
      );
    }
  }

  const locker = await prisma.locker.update({
    where: { id },
    data: { allocatedToMemberId },
    include: {
      allocatedTo: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  });

  return NextResponse.json({ locker });
}
