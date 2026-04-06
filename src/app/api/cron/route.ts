import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { confirmPendingBookings } from "@/lib/cron-confirm-pending";
import logger from "@/lib/logger";

/**
 * Manual trigger for the pending booking confirmation cron job.
 * Secured with CRON_SECRET header.
 */
export async function POST(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET;
  if (
    !cronSecret ||
    !expected ||
    cronSecret.length !== expected.length ||
    !timingSafeEqual(Buffer.from(cronSecret), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const result = await confirmPendingBookings();
    return NextResponse.json({
      success: true,
      confirmed: result.confirmedBookingIds,
      bumped: result.bumpedBookingIds,
      failed: result.failedBookingIds,
    });
  } catch (err) {
    logger.error({ err }, "Cron endpoint error");
    return NextResponse.json(
      { error: "Failed to process pending bookings" },
      { status: 500 }
    );
  }
}
