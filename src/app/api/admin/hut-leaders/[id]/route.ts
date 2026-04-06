import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";

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
    updateData.startDate = new Date(parsed.data.startDate + "T00:00:00");
  }
  if (parsed.data.endDate) {
    updateData.endDate = new Date(parsed.data.endDate + "T00:00:00");
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
