import { NextRequest, NextResponse } from "next/server";
import { approveBookingRequest, BookingRequestError } from "@/lib/booking-request";
import { requireAdmin } from "@/lib/session-guards";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;

  try {
    const result = await approveBookingRequest({
      requestId: id,
      adminMemberId: session.user.id,
    });

    if (result.type === "capacityExceeded") {
      return NextResponse.json(
        {
          error: "The lodge is at capacity for one or more of the requested nights",
          fullNights: result.fullNights,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      bookingId: result.bookingId,
      memberId: result.memberId,
      priceCents: result.priceCents,
      paymentLinkExpiresAt: result.paymentLinkExpiresAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
