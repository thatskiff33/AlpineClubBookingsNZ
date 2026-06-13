import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  BookingRequestError,
  priceBookingRequest,
  serializeBookingRequestForAdmin,
} from "@/lib/booking-request";
import { requireAdmin } from "@/lib/session-guards";

const priceSchema = z.object({
  priceCents: z.number().int().min(0),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = priceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const updated = await priceBookingRequest({
      requestId: id,
      adminMemberId: session.user.id,
      priceCents: parsed.data.priceCents,
    });

    return NextResponse.json(serializeBookingRequestForAdmin(updated!));
  } catch (err) {
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
