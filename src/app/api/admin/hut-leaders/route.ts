import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { calculateOverlapDays } from "@/lib/hut-leader-overlap";

const createSchema = z.object({
  memberId: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).refine((data) => data.startDate <= data.endDate, {
  message: "startDate must be before or equal to endDate",
});

/**
 * GET /api/admin/hut-leaders
 * List all hut leader assignments.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const assignments = await prisma.hutLeaderAssignment.findMany({
    include: {
      member: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
    orderBy: { startDate: "desc" },
  });

  return NextResponse.json({
    assignments: assignments.map((a) => ({
      id: a.id,
      memberId: a.memberId,
      memberName: `${a.member.firstName} ${a.member.lastName}`,
      memberEmail: a.member.email,
      startDate: a.startDate.toISOString().split("T")[0],
      endDate: a.endDate.toISOString().split("T")[0],
      createdAt: a.createdAt.toISOString(),
    })),
  });
}

/**
 * POST /api/admin/hut-leaders
 * Create a new hut leader assignment.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const member = await prisma.member.findUnique({
    where: { id: parsed.data.memberId },
    select: { id: true, active: true },
  });

  if (!member || !member.active) {
    return NextResponse.json({ error: "Member not found or inactive" }, { status: 404 });
  }

  // Check for overlapping assignments — 1 day overlap allowed for handover, 2+ rejected
  const newStart = new Date(parsed.data.startDate + "T00:00:00");
  const newEnd = new Date(parsed.data.endDate + "T00:00:00");

  const potentialOverlaps = await prisma.hutLeaderAssignment.findMany({
    where: {
      startDate: { lte: newEnd },
      endDate: { gte: newStart },
    },
    include: {
      member: { select: { firstName: true, lastName: true } },
    },
  });

  for (const existing of potentialOverlaps) {
    const overlapDays = calculateOverlapDays(newStart, newEnd, existing.startDate, existing.endDate);
    if (overlapDays > 1) {
      const name = `${existing.member.firstName} ${existing.member.lastName}`;
      const start = existing.startDate.toISOString().split("T")[0];
      const end = existing.endDate.toISOString().split("T")[0];
      return NextResponse.json(
        { error: `Assignment overlaps with ${name}'s assignment (${start} to ${end}) by ${overlapDays} days. Maximum 1 day overlap is allowed for handover.` },
        { status: 409 }
      );
    }
  }

  try {
    const assignment = await prisma.hutLeaderAssignment.create({
      data: {
        memberId: parsed.data.memberId,
        startDate: newStart,
        endDate: newEnd,
      },
    });

    logger.info(
      { assignmentId: assignment.id, memberId: parsed.data.memberId },
      "Hut leader assignment created"
    );

    return NextResponse.json({ id: assignment.id }, { status: 201 });
  } catch (err) {
    logger.error({ err }, "Error creating hut leader assignment");
    return NextResponse.json({ error: "Failed to create assignment" }, { status: 500 });
  }
}
