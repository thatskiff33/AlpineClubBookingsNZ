import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getBookingRequestSettings,
  updateBookingRequestSettings,
} from "@/lib/booking-request";
import { requireAdmin } from "@/lib/session-guards";

const settingsSchema = z.object({
  showPricingToNonMembers: z.boolean(),
});

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const settings = await getBookingRequestSettings();
  return NextResponse.json(settings);
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const settings = await updateBookingRequestSettings({
    showPricingToNonMembers: parsed.data.showPricingToNonMembers,
    adminMemberId: session.user.id,
  });

  return NextResponse.json(settings);
}
