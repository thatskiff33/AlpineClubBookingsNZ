import { NextRequest, NextResponse } from "next/server";
import { bookingMessageWordingSchema } from "@/lib/admin-support-api/messages";
import {
  BOOKING_MESSAGE_PREVIEW_CONNECTION_SHAPE,
  type BookingMessagePreviewAnswer,
} from "@/lib/connection-shapes/support-messages";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  BOOKING_MESSAGE_KEYS,
  renderBookingMessageTemplate,
  validateBookingMessageContent,
  type BookingMessageKey,
} from "@/lib/booking-message-definitions";
import { buildSampleBookingMessageData } from "@/lib/booking-message-settings";
import { requireAdmin } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";

const bookingMessageKeySet = new Set<string>(BOOKING_MESSAGE_KEYS);

// The same body the save takes (admin-support-api/messages.ts), which the AI
// app action `preview_booking_message` offers too (ALP-724).

export async function POST(request: NextRequest) {
  // Preview only renders a message with sample data (no mutation), so a
  // support:view admin may use it (issue #1940). Explicit view keeps it usable
  // for viewers even though the method is POST (which would infer edit).
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = bookingMessageWordingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!bookingMessageKeySet.has(parsed.data.messageKey)) {
    return NextResponse.json({ error: "Unknown booking message" }, { status: 400 });
  }

  const validation = validateBookingMessageContent(parsed.data.bodyText);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "Invalid booking message", issues: validation.errors },
      { status: 400 },
    );
  }

  const messageKey = parsed.data.messageKey as BookingMessageKey;
  const sampleData = await buildSampleBookingMessageData();

  const answer: BookingMessagePreviewAnswer = {
    messageKey,
    bodyText: validation.bodyText,
    rendered: renderBookingMessageTemplate(validation.bodyText, sampleData),
  };
  return connectionJson(request, answer, BOOKING_MESSAGE_PREVIEW_CONNECTION_SHAPE);
}
