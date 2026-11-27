import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { nameField } from "@/lib/zod-helpers";
import {
  DISPLAY_POLL_MAX_SECONDS,
  DISPLAY_POLL_MIN_SECONDS,
} from "@/lib/lodge-display/poll-interval";

// Admin device update (fork issue hoppers99/AlpineClubBookingsNZ#33; v2-only binding since LTV-038): rename
// and template assignment. A device binds to a v2 DisplayTemplate (`templateId`,
// validated to exist) or to the club default (`templateId: null`). The legacy
// code built-ins are now seeded v2 Template rows (LTV-038) and the vestigial
// `templateKey` device column was removed in hoppers99/AlpineClubBookingsNZ#86, so a request carrying
// `templateKey` is rejected by the strict schema. The binding is validated
// before persisting (never a dangling id) and a change is audit-logged.

const patchSchema = z
  .object({
    name: nameField().optional(),
    templateId: z.string().max(80).nullable().optional(),
    // Per-device state-poll cadence override (LTV-039): whole seconds in
    // [15, 600], or null to reset to the client default (~60s). Out-of-range
    // values are REJECTED with a 400 (not silently clamped) so the admin learns
    // the bound; the state route still clamps defensively on read.
    pollSeconds: z
      .number()
      .int()
      .min(DISPLAY_POLL_MIN_SECONDS)
      .max(DISPLAY_POLL_MAX_SECONDS)
      .nullable()
      .optional(),
  })
  // Reject any unexpected field — notably the retired `templateKey`, which a
  // stale client might still send (LTV-038): it must fail rather than silently
  // no-op, so the caller learns the binding surface changed.
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.templateId !== undefined ||
      value.pollSeconds !== undefined,
    { message: "Nothing to update" }
  );

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof patchSchema>;
  const jsonBody = await parseJsonRequestBody(req);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    body = patchSchema.parse(jsonBody.body);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { id } = await params;
  const device = await prisma.lodgeDisplayDevice.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  // v2 template id: must name an existing DisplayTemplate row.
  if (typeof body.templateId === "string") {
    const template = await prisma.displayTemplate.findUnique({
      where: { id: body.templateId },
      select: { id: true },
    });
    if (!template) {
      return NextResponse.json(
        { error: "Unknown display template" },
        { status: 400 }
      );
    }
  }

  const data: {
    name?: string;
    templateId?: string | null;
    pollSeconds?: number | null;
  } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.templateId !== undefined) {
    data.templateId = body.templateId;
  }
  if (body.pollSeconds !== undefined) data.pollSeconds = body.pollSeconds;

  const updated = await prisma.lodgeDisplayDevice.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      templateId: true,
      pollSeconds: true,
    },
  });

  if (body.templateId !== undefined) {
    const binding =
      typeof body.templateId === "string"
        ? `template ${body.templateId}`
        : "club default";
    logAudit({
      action: "DISPLAY_DEVICE_TEMPLATE_ASSIGNED",
      category: "lodge",
      entityType: "LodgeDisplayDevice",
      entityId: updated.id,
      targetId: updated.id,
      actorMemberId: guard.session.user.id,
      details: `Bound lobby display device "${updated.name}" to ${binding}`,
    });
  }

  if (body.pollSeconds !== undefined) {
    logAudit({
      action: "DISPLAY_DEVICE_POLL_INTERVAL_SET",
      category: "lodge",
      entityType: "LodgeDisplayDevice",
      entityId: updated.id,
      targetId: updated.id,
      actorMemberId: guard.session.user.id,
      details:
        body.pollSeconds === null
          ? `Reset lobby display device "${updated.name}" refresh interval to the default`
          : `Set lobby display device "${updated.name}" refresh interval to ${body.pollSeconds}s`,
    });
  }

  return NextResponse.json({ device: updated });
}
