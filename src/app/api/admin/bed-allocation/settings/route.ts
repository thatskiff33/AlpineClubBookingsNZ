import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getEffectiveBedAllocationSettings,
  updateBedAllocationSettings,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationRead,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { parseBedAllocationPriorityOrder } from "@/lib/bed-allocation-settings";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

// Explicit bookings:view / bookings:edit is enforced by the split guards.
const settingsSchema = z
  .object({
    autoAllocationEnabled: z.boolean(),
    allocationPriorityOrder: z.array(z.unknown()),
    // Settings editing is always scoped to exactly one lodge.
    lodgeId: z.string().min(1),
  })
  .strict();

export async function GET(request: Request) {
  const guard = await requireBedAllocationRead();
  if (!guard.ok) return guard.response;

  try {
    const lodgeIdResult = z
      .string()
      .min(1)
      .safeParse(new URL(request.url).searchParams.get("lodgeId"));
    if (!lodgeIdResult.success) {
      return NextResponse.json(
        { error: "A lodgeId is required." },
        { status: 400 },
      );
    }
    const lodgeId = lodgeIdResult.data;
    if (!(await resolveOptionalActiveLodgeId(prisma, lodgeId))) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      );
    }
    const settings = await getEffectiveBedAllocationSettings(undefined, lodgeId);
    return NextResponse.json({ settings });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = settingsSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const lodgeId = await resolveOptionalActiveLodgeId(
      prisma,
      body.data.lodgeId,
    );
    if (!lodgeId) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      );
    }

    const settings = await updateBedAllocationSettings({
      autoAllocationEnabled: body.data.autoAllocationEnabled,
      allocationPriorityOrder: parseBedAllocationPriorityOrder(
        body.data.allocationPriorityOrder,
        "allocationPriorityOrder",
        400,
      ),
      updatedByMemberId: guard.session.user.id,
      lodgeId,
    });

    await createAuditLog({
      action: "BED_ALLOCATION_SETTINGS_UPDATED",
      memberId: guard.session.user.id,
      entityType: "BedAllocationSettings",
      entityId: lodgeId,
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Bed allocation settings updated",
      metadata: settings,
    });

    return NextResponse.json({ settings });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
