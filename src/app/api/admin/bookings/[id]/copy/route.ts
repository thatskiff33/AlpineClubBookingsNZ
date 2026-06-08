import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { copyBookingToDraft } from "@/lib/admin-booking-copy";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

const copyBookingSchema = z.object({
  checkIn: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON",
        details: { body: ["Request body must be valid JSON"] },
      },
      { status: 400 },
    );
  }

  const parsed = copyBookingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { id: bookingId } = await params;
  try {
    const result = await copyBookingToDraft({
      sourceBookingId: bookingId,
      targetCheckIn: parsed.data.checkIn,
      adminMemberId: guard.session.user.id,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, bookingId }, "Failed to copy booking");
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to copy booking" },
      { status: 400 },
    );
  }
}
