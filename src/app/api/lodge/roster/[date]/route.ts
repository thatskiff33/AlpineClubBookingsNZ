import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, getLodgeAuthActorMemberId } from "@/lib/lodge-auth";
import { getBookingGuestDisplayAgeTier } from "@/lib/booking-guests";
import { parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import logger from "@/lib/logger";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const rosterActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("complete"),
    assignmentId: z.string().min(1),
  }),
  z.object({
    action: z.literal("uncomplete"),
    assignmentId: z.string().min(1),
  }),
]);

/**
 * GET /api/lodge/roster/[date]
 * Returns the roster for a date (assignments only, no auto-suggest).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const authResult = await checkLodgeAuth(dateStr, {
    request: req,
  });
  const { error, status } = authResult;
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const assignments = await prisma.choreAssignment.findMany({
    where: { date },
    include: {
      choreTemplate: true,
      bookingGuest: {
        include: {
          member: {
            select: { ageTier: true },
          },
        },
      },
    },
    orderBy: [
      { choreTemplate: { sortOrder: "asc" } },
    ],
  });

  return NextResponse.json({
    date: dateStr,
    assignments: assignments.map((a) => ({
      id: a.id,
      choreTemplateId: a.choreTemplateId,
      choreTemplateName: a.choreTemplate.name,
      choreDescription: a.choreTemplate.description,
      choreSortOrder: a.choreTemplate.sortOrder,
      choreTimeOfDay: a.choreTemplate.timeOfDay,
      bookingGuestId: a.bookingGuestId,
      guestName: a.bookingGuest
        ? `${a.bookingGuest.firstName} ${a.bookingGuest.lastName}`
        : null,
      guestAgeTier: a.bookingGuest ? getBookingGuestDisplayAgeTier(a.bookingGuest) : null,
      bookingId: a.bookingId,
      status: a.status,
      completedAt: a.completedAt?.toISOString() ?? null,
      completedVia: a.completedVia ?? null,
    })),
  });
}

/**
 * PUT /api/lodge/roster/[date]
 * Limited actions: complete and uncomplete only (kiosk use).
 * Requires tier >= lodge (staying-guest cannot toggle chores).
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const authResult = await checkLodgeAuth(dateStr, { request: req });
  const { error, status, tier } = authResult;
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  // Staying guests cannot toggle chores
  if (tier === "staying-guest") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }
  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = rosterActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;

  try {
    const assignment = await prisma.choreAssignment.findFirst({
      where: { id: data.assignmentId, date },
      select: {
        id: true,
        choreTemplateId: true,
        bookingId: true,
        bookingGuestId: true,
        bookingGuest: {
          select: {
            memberId: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });
    if (!assignment) {
      return NextResponse.json(
        { error: "Assignment not found for this date" },
        { status: 404 }
      );
    }

    if (data.action === "complete") {
      await prisma.choreAssignment.update({
        where: { id: data.assignmentId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          completedVia: "KIOSK",
        },
      });
    } else {
      await prisma.choreAssignment.update({
        where: { id: data.assignmentId },
        data: {
          status: "CONFIRMED",
          completedAt: null,
          completedVia: null,
        },
      });
    }

    const completed = data.action === "complete";
    logAudit({
      action: completed ? "lodge.chore.completed" : "lodge.chore.uncompleted",
      memberId: getLodgeAuthActorMemberId(authResult),
      targetId: data.assignmentId,
      subjectMemberId: assignment.bookingGuest?.memberId ?? null,
      entityType: "ChoreAssignment",
      entityId: data.assignmentId,
      category: "lodge",
      outcome: "success",
      summary: completed ? "Lodge chore completed" : "Lodge chore reopened",
      details: `${completed ? "Completed" : "Reopened"} chore assignment for ${dateStr}`,
      metadata: {
        date: dateStr,
        tier,
        bookingId: assignment.bookingId,
        bookingGuestId: assignment.bookingGuestId,
        choreTemplateId: assignment.choreTemplateId,
        completedVia: completed ? "KIOSK" : null,
        guestName: assignment.bookingGuest
          ? `${assignment.bookingGuest.firstName} ${assignment.bookingGuest.lastName}`
          : null,
      },
    });
  } catch (err) {
    logger.error({ err }, "Error toggling chore completion");
    return NextResponse.json(
      { error: "Failed to update assignment" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
