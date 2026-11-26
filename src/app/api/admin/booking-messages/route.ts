import { NextRequest, NextResponse } from "next/server";
import { bookingMessageWordingSchema } from "@/lib/admin-support-api/messages";
import {
  BOOKING_MESSAGE_SAVED_CONNECTION_SHAPE,
  BOOKING_MESSAGE_WORDING_LIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/support-messages";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  BOOKING_MESSAGE_DEFINITION_BY_KEY,
  BOOKING_MESSAGE_KEYS,
  validateBookingMessageContent,
  type BookingMessageKey,
} from "@/lib/booking-message-definitions";
import { loadEffectiveBookingMessages } from "@/lib/booking-message-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";

const bookingMessageKeySet = new Set<string>(BOOKING_MESSAGE_KEYS);

// The body schema lives in admin-support-api/messages.ts, which the AI app
// action `update_booking_message` offers too (ALP-724).

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  return connectionJson(
    request,
    { messages: await loadEffectiveBookingMessages() },
    BOOKING_MESSAGE_WORDING_LIST_CONNECTION_SHAPE,
  );
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

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
  const definition = BOOKING_MESSAGE_DEFINITION_BY_KEY.get(messageKey);
  const before = await prisma.bookingMessageOverride.findUnique({
    where: { messageKey },
  });
  const record = await prisma.bookingMessageOverride.upsert({
    where: { messageKey },
    create: {
      messageKey,
      bodyText: validation.bodyText,
      updatedByMemberId: session.user.id,
    },
    update: {
      bodyText: validation.bodyText,
      updatedByMemberId: session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "BOOKING_MESSAGE_OVERRIDE_UPDATED",
      actor: { memberId: session.user.id },
      entity: { type: "BookingMessageOverride", id: messageKey },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Booking message override updated",
      metadata: {
        messageKey,
        label: definition?.label ?? messageKey,
        previousOverride: before
          ? { bodyText: before.bodyText, updatedAt: before.updatedAt }
          : null,
        newOverride: {
          bodyText: record.bodyText,
          updatedAt: record.updatedAt,
        },
      },
      request: getAuditRequestContext(request),
    }),
  );

  return connectionJson(request, { override: record }, BOOKING_MESSAGE_SAVED_CONNECTION_SHAPE);
}
