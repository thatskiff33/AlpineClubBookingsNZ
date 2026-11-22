import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  BOOKING_MESSAGE_DEFINITION_BY_KEY,
  BOOKING_MESSAGE_KEYS,
  type BookingMessageKey,
} from "@/lib/booking-message-definitions";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";

const bookingMessageKeySet = new Set<string>(BOOKING_MESSAGE_KEYS);

const resetSchema = z
  .object({
    messageKey: z.string().trim().min(1),
  })
  .strict();

export async function POST(request: NextRequest) {
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

  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!bookingMessageKeySet.has(parsed.data.messageKey)) {
    return NextResponse.json({ error: "Unknown booking message" }, { status: 400 });
  }

  const messageKey = parsed.data.messageKey as BookingMessageKey;
  const definition = BOOKING_MESSAGE_DEFINITION_BY_KEY.get(messageKey);
  const result = await prisma.bookingMessageOverride.deleteMany({
    where: { messageKey },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "BOOKING_MESSAGE_OVERRIDE_RESET",
      actor: { memberId: session.user.id },
      entity: { type: "BookingMessageOverride", id: messageKey },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Booking message override reset",
      metadata: {
        messageKey,
        label: definition?.label ?? messageKey,
        deletedOverrideCount: result.count,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({ reset: result.count > 0 });
}
