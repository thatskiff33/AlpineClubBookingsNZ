import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
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

const previewSchema = z
  .object({
    messageKey: z.string().trim().min(1),
    bodyText: z.string(),
  })
  .strict();

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

  const parsed = previewSchema.safeParse(body);
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

  return NextResponse.json({
    messageKey,
    bodyText: validation.bodyText,
    rendered: renderBookingMessageTemplate(validation.bodyText, sampleData),
  });
}
