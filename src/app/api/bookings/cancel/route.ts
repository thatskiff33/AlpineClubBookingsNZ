import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { CancelBookingSchema } from "@/types/payments";
import { cancelBooking } from "@/lib/booking-cancel";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";

/**
 * @deprecated Use POST /api/bookings/[id]/cancel instead.
 * This body-based route is kept for backwards compatibility.
 */
export async function POST(request: NextRequest) {
  try {
    logger.warn("[DEPRECATION] POST /api/bookings/cancel with body { bookingId } is deprecated. Use POST /api/bookings/{id}/cancel instead.");

    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }

    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return inactiveResponse;
    }

    const body = await request.json();
    const parsed = CancelBookingSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const result = await cancelBooking(
      parsed.data.bookingId,
      session.user.id,
      session.user.role,
      getClientIp(request)
    );

    if (result.status === 200) {
      return NextResponse.json(result.data);
    }
    return NextResponse.json(
      { error: result.error },
      { status: result.status }
    );
  } catch (error) {
    logger.error({ err: error }, "Error cancelling booking");
    return NextResponse.json(
      { error: "Failed to cancel booking" },
      { status: 500 }
    );
  }
}
