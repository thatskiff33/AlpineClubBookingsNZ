import { NextRequest, NextResponse } from "next/server";

import { parseJsonRequestBody } from "@/lib/api-json";
import {
  BOOKING_IMPORT_SLICE,
  bookingImportClubContext,
  bookingImportConfirmSchema,
  readBookingImportFile,
  bookingImportBookingsRefusal,
} from "@/lib/booking-import/request";
import { confirmBookingImport } from "@/lib/booking-import/write";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { applyRateLimit } from "@/lib/rate-limit";
import { requireRecentAuth } from "@/lib/require-recent-auth";

/**
 * POST /api/admin/bookings/import/confirm
 * Write a previewed paid-booking import (#5005, child C; `INV-PAY-161`,
 * `INV-CAP-040`), a bounded slice per call: the screen repeats the call until
 * `remaining` is zero. The batch key means the same file never creates a
 * booking twice. If the fresh preview differs from the digest the officer
 * confirmed, nothing is written and the new preview comes back (409).
 * Needs finance edit and bookings edit (O4).
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  const noBookingsAccess = bookingImportBookingsRefusal(guard.session.user, "edit");
  if (noBookingsAccess) return noBookingsAccess;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  // One file of 500 rows is 25 slices; the limit leaves room for a resume.
  const limited = await applyRateLimit({ id: "booking-import-confirm", limit: 120, windowSeconds: 60 * 60 }, request);
  if (limited) return limited;

  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = bookingImportConfirmSchema.safeParse(jsonBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Preview the file before confirming it" }, { status: 400 });
  }
  const file = readBookingImportFile(parsed.data);
  if (!file.ok) return NextResponse.json({ error: file.error }, { status: 400 });
  try {
    const result = await confirmBookingImport({
      lodgeId: parsed.data.lodgeId,
      bookings: file.bookings,
      digest: parsed.data.digest,
      officerMemberId: guard.session.user.id,
      maxBookings: BOOKING_IMPORT_SLICE,
      ...(await bookingImportClubContext()),
    });
    if (result.outcome === "stale") {
      return NextResponse.json(
        { error: "The preview has changed since you checked it. Nothing was written; check the new preview.", plan: result.plan },
        { status: 409 },
      );
    }
    if (result.outcome === "reversed") {
      return NextResponse.json(
        { error: "This file's batch was reversed, so it cannot be imported again. Change the file to import it as a new batch.", batchId: result.batchId },
        { status: 409 },
      );
    }
    const imported = result.rows.filter((row) => row.outcome === "IMPORTED").length;
    return NextResponse.json({
      batchId: result.batchId,
      remaining: result.remaining,
      imported,
      refused: result.rows.length - imported - result.remaining,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to confirm a paid-booking import");
    return NextResponse.json({ error: "The import stopped. Confirm again to carry on where it stopped." }, { status: 500 });
  }
}
