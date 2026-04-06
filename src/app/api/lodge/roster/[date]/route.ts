import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import { prisma } from "@/lib/prisma";
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
  _req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { error, status } = await checkLodgeAuth();
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  const { date: dateStr } = await params;
  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const date = new Date(dateStr + "T00:00:00");
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const assignments = await prisma.choreAssignment.findMany({
    where: { date },
    include: {
      choreTemplate: true,
      bookingGuest: true,
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
      guestAgeTier: a.bookingGuest?.ageTier ?? null,
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
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { error, status } = await checkLodgeAuth();
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  const { date: dateStr } = await params;
  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
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
  } catch (err) {
    logger.error({ err }, "Error toggling chore completion");
    return NextResponse.json(
      { error: "Failed to update assignment" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
