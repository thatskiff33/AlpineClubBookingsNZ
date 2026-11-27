import { NextRequest, NextResponse } from "next/server";
import { bookingRequestSettingsBodySchema } from "@/lib/admin-bookings-schemas/setup";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  getBookingRequestSettings,
  updateBookingRequestSettings,
} from "@/lib/booking-request";
import { ADMIN_BOOKING_REQUEST_SETTINGS_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-setup";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";

// The body schema lives in admin-bookings-schemas/setup.ts so the AI app
// action `update_booking_request_settings` offers the same fields (ALP-719).

export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const settings = await getBookingRequestSettings();
  return connectionJson(req, settings, ADMIN_BOOKING_REQUEST_SETTINGS_CONNECTION_SHAPE);
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const jsonBody = await parseJsonRequestBody(req, {
    error: "Invalid JSON payload",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = bookingRequestSettingsBodySchema.safeParse(body);
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

  return connectionJson(req, settings, ADMIN_BOOKING_REQUEST_SETTINGS_CONNECTION_SHAPE);
}
