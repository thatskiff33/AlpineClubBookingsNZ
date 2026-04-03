import { NextRequest, NextResponse } from "next/server";
import { confirmPendingBookings } from "@/lib/cron-confirm-pending";

/**
 * Manual trigger for the pending booking confirmation cron job.
 * Secured with CRON_SECRET header.
 */
export async function POST(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
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
    console.error("Cron endpoint error:", err);
    return NextResponse.json(
      { error: "Failed to process pending bookings" },
      { status: 500 }
    );
  }
}
