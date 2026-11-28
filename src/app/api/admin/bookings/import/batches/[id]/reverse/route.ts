import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { parseOptionalJsonRequestBody } from "@/lib/api-json";

import {
  BOOKING_IMPORT_SLICE,
  bookingImportClubContext,
  bookingImportBookingsRefusal,
} from "@/lib/booking-import/request";
import { reverseBookingImport } from "@/lib/booking-import/reverse";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { applyRateLimit, getClientIp } from "@/lib/rate-limit";
import { requireRecentAuth } from "@/lib/require-recent-auth";

/**
 * POST /api/admin/bookings/import/batches/[id]/reverse
 * Reverse an import batch's untouched bookings (#5005; `INV-PAY-163`), a
 * bounded slice per call: the screen repeats the call, passing back
 * `nextAfterLineNumber` as `afterLineNumber`, until `remaining` is zero.
 * Touched bookings are kept and named. Needs finance edit and bookings edit
 * (O4).
 */
const reverseSchema = z.object({ afterLineNumber: z.number().int().min(0).optional() }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  const noBookingsAccess = bookingImportBookingsRefusal(guard.session.user, "edit");
  if (noBookingsAccess) return noBookingsAccess;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  const limited = await applyRateLimit({ id: "booking-import-reverse", limit: 120, windowSeconds: 60 * 60 }, request);
  if (limited) return limited;

  const { id } = await params;
  const jsonBody = await parseOptionalJsonRequestBody(request, { whenAbsent: {} });
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = reverseSchema.safeParse(jsonBody.body);
  if (!parsed.success) return NextResponse.json({ error: "Reverse the batch from its page" }, { status: 400 });
  try {
    const { today, format } = await bookingImportClubContext();
    const result = await reverseBookingImport({
      batchId: id,
      officerMemberId: guard.session.user.id,
      today,
      format,
      ipAddress: getClientIp(request),
      maxBookings: BOOKING_IMPORT_SLICE,
      ...(parsed.data.afterLineNumber === undefined ? {} : { afterLineNumber: parsed.data.afterLineNumber }),
    });
    if (result.outcome === "not_found") return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
    if (result.outcome === "not_completed") {
      return NextResponse.json({ error: "This batch is still being imported. Finish the import before reversing it." }, { status: 409 });
    }
    return NextResponse.json(result);
  } catch (error) {
    logger.error({ err: error, batchId: id }, "Failed to reverse a paid-booking import batch");
    return NextResponse.json({ error: "The reversal stopped. Reverse again to carry on where it stopped." }, { status: 500 });
  }
}
