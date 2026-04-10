import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { calculateOverlapDays } from "@/lib/hut-leader-overlap";

const updateSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * PUT /api/admin/hut-leaders/[id]
 * Update a hut leader assignment.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.hutLeaderAssignment.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }

  const updateData: Record<string, Date> = {};
  if (parsed.data.startDate) {
    if (!isDateOnlyString(parsed.data.startDate)) {
      return NextResponse.json({ error: "Invalid startDate" }, { status: 400 });
    }
    updateData.startDate = parseDateOnly(parsed.data.startDate);
  }
  if (parsed.data.endDate) {
    if (!isDateOnlyString(parsed.data.endDate)) {
      return NextResponse.json({ error: "Invalid endDate" }, { status: 400 });
    }
    updateData.endDate = parseDateOnly(parsed.data.endDate);
  }

  // Validate start <= end
  const finalStart = updateData.startDate ?? existing.startDate;
  const finalEnd = updateData.endDate ?? existing.endDate;
  if (finalStart > finalEnd) {
    return NextResponse.json(
      { error: "startDate must be before or equal to endDate" },
      { status: 400 }
    );
  }

  // Check for overlapping assignments (excluding self) — 1 day overlap allowed, 2+ rejected
  const potentialOverlaps = await prisma.hutLeaderAssignment.findMany({
    where: {
      id: { not: id },
      startDate: { lte: finalEnd },
      endDate: { gte: finalStart },
    },
    include: {
      member: { select: { firstName: true, lastName: true } },
    },
  });

  for (const existing of potentialOverlaps) {
    const overlapDays = calculateOverlapDays(finalStart, finalEnd, existing.startDate, existing.endDate);
    if (overlapDays > 1) {
      const name = `${existing.member.firstName} ${existing.member.lastName}`;
      const start = formatDateOnly(existing.startDate);
      const end = formatDateOnly(existing.endDate);
      return NextResponse.json(
        { error: `Assignment overlaps with ${name}'s assignment (${start} to ${end}) by ${overlapDays} days. Maximum 1 day overlap is allowed for handover.` },
        { status: 409 }
      );
    }
  }

  try {
    await prisma.hutLeaderAssignment.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Error updating hut leader assignment");
    return NextResponse.json({ error: "Failed to update assignment" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/hut-leaders/[id]
 * Delete a hut leader assignment.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const existing = await prisma.hutLeaderAssignment.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }

  try {
    await prisma.hutLeaderAssignment.delete({ where: { id } });
    logger.info({ assignmentId: id }, "Hut leader assignment deleted");
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Error deleting hut leader assignment");
    return NextResponse.json({ error: "Failed to delete assignment" }, { status: 500 });
  }
}
