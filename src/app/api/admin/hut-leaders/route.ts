import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { calculateOverlapDays } from "@/lib/hut-leader-overlap";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { sendHutLeaderAssignmentEmail } from "@/lib/email";
import {
  generateHutLeaderPin,
  hashHutLeaderPin,
} from "@/lib/lodge-pin-session";

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
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
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
      startDate: formatDateOnly(a.startDate),
      endDate: formatDateOnly(a.endDate),
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
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
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
    select: {
      id: true,
      active: true,
      email: true,
      firstName: true,
    },
  });

  if (!member || !member.active) {
    return NextResponse.json({ error: "Member not found or inactive" }, { status: 404 });
  }

  // Check for overlapping assignments — 1 day overlap allowed for handover, 2+ rejected
  if (!isDateOnlyString(parsed.data.startDate) || !isDateOnlyString(parsed.data.endDate)) {
    return NextResponse.json({ error: "Invalid startDate or endDate" }, { status: 400 });
  }
  const newStart = parseDateOnly(parsed.data.startDate);
  const newEnd = parseDateOnly(parsed.data.endDate);

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
      const start = formatDateOnly(existing.startDate);
      const end = formatDateOnly(existing.endDate);
      return NextResponse.json(
        { error: `Assignment overlaps with ${name}'s assignment (${start} to ${end}) by ${overlapDays} days. Maximum 1 day overlap is allowed for handover.` },
        { status: 409 }
      );
    }
  }

  try {
    const pin = generateHutLeaderPin();
    const hutLeaderPin = await hashHutLeaderPin(pin);

    const assignment = await prisma.hutLeaderAssignment.create({
      data: {
        memberId: parsed.data.memberId,
        startDate: newStart,
        endDate: newEnd,
        hutLeaderPin,
      },
    });

    let emailSent = true;
    try {
      await sendHutLeaderAssignmentEmail({
        email: member.email,
        firstName: member.firstName,
        startDate: newStart,
        endDate: newEnd,
        pin,
      });
    } catch (err) {
      emailSent = false;
      logger.error(
        { err, assignmentId: assignment.id, memberId: member.id },
        "Failed to send hut leader assignment email"
      );
    }

    logger.info(
      { assignmentId: assignment.id, memberId: parsed.data.memberId },
      "Hut leader assignment created"
    );

    return NextResponse.json(
      { id: assignment.id, emailSent },
      { status: 201 }
    );
  } catch (err) {
    logger.error({ err }, "Error creating hut leader assignment");
    return NextResponse.json({ error: "Failed to create assignment" }, { status: 500 });
  }
}
