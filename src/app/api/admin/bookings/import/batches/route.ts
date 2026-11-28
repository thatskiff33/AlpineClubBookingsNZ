import { NextResponse } from "next/server";

import { listBookingImportBatches } from "@/lib/booking-import/batches";
import { bookingImportBookingsRefusal } from "@/lib/booking-import/request";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/bookings/import/batches
 * The paid-booking import batches so far, newest first, with imported,
 * refused and reversed totals (#5005, child C). Needs finance view and
 * bookings view.
 */
export async function GET() {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  const noBookingsAccess = bookingImportBookingsRefusal(guard.session.user, "view");
  if (noBookingsAccess) return noBookingsAccess;
  try {
    return NextResponse.json({ batches: await listBookingImportBatches() });
  } catch (error) {
    logger.error({ err: error }, "Failed to list paid-booking import batches");
    return NextResponse.json({ error: "Failed to load the import batches" }, { status: 500 });
  }
}
