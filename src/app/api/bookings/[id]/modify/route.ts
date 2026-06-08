import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { ageTierEnum } from "@/lib/age-tier-schema";
import {
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
} from "@/lib/booking-guests";
import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { nameField } from "@/lib/zod-helpers";

const batchModifySchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: ageTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
      }),
    )
    .optional(),
  removeGuestIds: z.array(z.string()).optional(),
  guestStayRanges: z
    .array(
      z.object({
        guestId: z.string().min(1),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
      }),
    )
    .optional(),
  guestUpdates: z
    .array(
      z.object({
        guestId: z.string().min(1),
        firstName: nameField(),
        lastName: nameField(),
      }),
    )
    .optional(),
  promoCode: z.string().optional(),
  promoGuestIndexes: z.array(z.number().int().min(0)).optional(),
  removePromoCode: z.boolean().optional(),
  memberReviewJustification: z.string().trim().min(1).max(1000).optional(),
  settlementMethod: z.enum(["card", "credit"]).optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId } = await params;

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

  const parsed = batchModifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  try {
    const result = await modifyBookingBatch({
      bookingId,
      actor: { id: session.user.id, role: session.user.role },
      input: parsed.data,
      ipAddress,
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BookingGuestValidationError) {
      return NextResponse.json(getBookingGuestValidationErrorResponse(err), {
        status: err.status,
      });
    }
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Failed to modify booking";
    logger.error({ err, bookingId }, "Batch modify failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
