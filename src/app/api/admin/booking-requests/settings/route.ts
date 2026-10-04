import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getBookingRequestSettings,
  updateBookingRequestSettings,
} from "@/lib/booking-request";
import { requireAdmin } from "@/lib/session-guards";

const settingsSchema = z
  .object({
    showPricingToNonMembers: z.boolean(),
    quoteResponseTtlDays: z.number().int().min(1).max(60),
    quoteReminderLeadDays: z.number().int().min(0).max(30),
    attendeeConfirmationLeadDays: z.number().int().min(0).max(90),
    attendeeConfirmationReminderDays: z.number().int().min(1).max(30),
  })
  .refine((value) => value.quoteReminderLeadDays < value.quoteResponseTtlDays, {
    message:
      "The reminder lead time must be shorter than the quote response window.",
    path: ["quoteReminderLeadDays"],
  });

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const settings = await getBookingRequestSettings();
  return NextResponse.json(settings);
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
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
    quoteResponseTtlDays: parsed.data.quoteResponseTtlDays,
    quoteReminderLeadDays: parsed.data.quoteReminderLeadDays,
    attendeeConfirmationLeadDays: parsed.data.attendeeConfirmationLeadDays,
    attendeeConfirmationReminderDays:
      parsed.data.attendeeConfirmationReminderDays,
    adminMemberId: session.user.id,
  });

  return NextResponse.json(settings);
}
