import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  BookingRequestError,
  declineBookingRequest,
  serializeBookingRequestForAdmin,
} from "@/lib/booking-request";
import { requireAdmin } from "@/lib/session-guards";

const declineSchema = z.object({
  reason: z.string().max(2000).optional().nullable(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const parsed = declineSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const updated = await declineBookingRequest({
      requestId: id,
      adminMemberId: session.user.id,
      reason: parsed.data.reason,
    });

    return NextResponse.json(serializeBookingRequestForAdmin(updated!));
  } catch (err) {
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
