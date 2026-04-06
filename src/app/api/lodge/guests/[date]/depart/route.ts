import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bodySchema = z.object({
  bookingGuestId: z.string().min(1),
});

/**
 * PUT /api/lodge/guests/[date]/depart
 * Mark a guest as departed (sets departedAt timestamp).
 * Sending again toggles off (clears departedAt).
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  if (session.user.role !== "LODGE" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const guest = await prisma.bookingGuest.findUnique({
      where: { id: parsed.data.bookingGuestId },
    });

    if (!guest) {
      return NextResponse.json({ error: "Guest not found" }, { status: 404 });
    }

    // Toggle: if already departed, clear; otherwise set
    const departedAt = guest.departedAt ? null : new Date();

    await prisma.bookingGuest.update({
      where: { id: parsed.data.bookingGuestId },
      data: { departedAt },
    });

    return NextResponse.json({ success: true, departedAt: departedAt?.toISOString() ?? null });
  } catch (err) {
    logger.error({ err }, "Error marking guest departure");
    return NextResponse.json({ error: "Failed to update guest" }, { status: 500 });
  }
}
