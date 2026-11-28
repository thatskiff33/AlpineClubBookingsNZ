import { NextRequest, NextResponse } from "next/server";

import { getBookingImportBatch } from "@/lib/booking-import/batches";
import { bookingImportClubContext, bookingImportBookingsRefusal } from "@/lib/booking-import/request";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/bookings/import/batches/[id]
 * One import batch: its totals, and for each booking what a reversal would do
 * and why (#5005, child C). Needs finance view and bookings view.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  const noBookingsAccess = bookingImportBookingsRefusal(guard.session.user, "view");
  if (noBookingsAccess) return noBookingsAccess;
  const { id } = await params;
  try {
    const { today } = await bookingImportClubContext();
    const batch = await getBookingImportBatch({ batchId: id, today });
    if (!batch) return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
    return NextResponse.json(batch);
  } catch (error) {
    logger.error({ err: error, batchId: id }, "Failed to load a paid-booking import batch");
    return NextResponse.json({ error: "Failed to load the import batch" }, { status: 500 });
  }
}
