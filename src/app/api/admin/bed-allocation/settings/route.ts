import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getEffectiveBedAllocationSettings,
  updateBedAllocationSettings,
} from "@/lib/bed-allocation-admin-settings";
import {
  bedAllocationErrorResponse,
  requireBedAllocationRead,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import {
  parseBedAllocationPriorityOrder,
  type BedAllocationSettingsWriteBody,
} from "@/lib/bed-allocation-settings";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

// Explicit bookings:view / bookings:edit is enforced by the split guards.
//
// The `satisfies` is a compile-time proof that this schema and the write
// contract the editor builds name the SAME fields (#2931). `Record` requires
// every contract field to be present, and the object literal's excess-property
// check refuses any field the contract does not have — so adding a field on
// either side, or dropping one, fails `npm run typecheck` rather than failing
// in a browser as a 400 "Invalid input" that nobody could read. The write
// contract was previously stated twice, here and by hand in the editor's save.
const settingsSchema = z
  .object({
    autoAllocationEnabled: z.boolean(),
    allocationPriorityOrder: z.array(z.unknown()),
    lodgeId: z.string().min(1),
  } satisfies Record<keyof BedAllocationSettingsWriteBody, z.ZodType>)
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
      category: "lodge",
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
