import { NextRequest, NextResponse } from "next/server";

import { parseJsonRequestBody } from "@/lib/api-json";
import { previewBookingImport } from "@/lib/booking-import/batches";
import {
  bookingImportClubContext,
  bookingImportFileSchema,
  readBookingImportFile,
  bookingImportBookingsRefusal,
} from "@/lib/booking-import/request";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { applyRateLimit } from "@/lib/rate-limit";
import { requireRecentAuth } from "@/lib/require-recent-auth";

/**
 * POST /api/admin/bookings/import/preview
 * The dry run of a paid-booking import (#5005, child C): every booking's
 * outcome and reasons, the totals and the beds per night. Writes nothing.
 * Needs finance edit and bookings edit (O4), as confirming does.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  const noBookingsAccess = bookingImportBookingsRefusal(guard.session.user, "edit");
  if (noBookingsAccess) return noBookingsAccess;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  const limited = await applyRateLimit({ id: "booking-import-preview", limit: 60, windowSeconds: 60 * 60 }, request);
  if (limited) return limited;

  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = bookingImportFileSchema.safeParse(jsonBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Choose a lodge, a CSV file and its date format to preview" }, { status: 400 });
  }
  const file = readBookingImportFile(parsed.data);
  if (!file.ok) return NextResponse.json({ error: file.error }, { status: 400 });
  try {
    const preview = await previewBookingImport({
      lodgeId: parsed.data.lodgeId,
      bookings: file.bookings,
      ...(await bookingImportClubContext()),
    });
    if (!preview) return NextResponse.json({ error: "Choose a lodge to import into" }, { status: 400 });
    return NextResponse.json(preview);
  } catch (error) {
    // Row numbers and reasons only, never names or emails (`INV-PRIV-011`).
    logger.error({ err: error }, "Failed to preview a paid-booking import");
    return NextResponse.json({ error: "The file could not be previewed" }, { status: 500 });
  }
}
