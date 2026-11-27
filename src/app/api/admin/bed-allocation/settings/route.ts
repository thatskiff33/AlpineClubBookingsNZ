import { NextResponse } from "next/server";
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
  bedAllocationSettingsBodySchema,
  bedAllocationSettingsQuerySchema,
} from "@/lib/admin-bookings-schemas/beds";
import { parseBedAllocationPriorityOrder } from "@/lib/bed-allocation-settings";
import { ADMIN_BED_ALLOCATION_SETTINGS_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

// Explicit bookings:view / bookings:edit is enforced by the split guards.
// The PUT schema's compile-time tie to the editor's write contract (#2931)
// lives with the schema in `admin-bookings-schemas/beds.ts`.

/** Also the AI app action `get_bed_allocation_settings` (ALP-719). */
export async function GET(request: Request) {
  const guard = await requireBedAllocationRead();
  if (!guard.ok) return guard.response;

  try {
    const lodgeIdResult = bedAllocationSettingsQuerySchema.safeParse({
      lodgeId: new URL(request.url).searchParams.get("lodgeId") ?? undefined,
    });
    if (!lodgeIdResult.success) {
      return NextResponse.json(
        { error: "A lodgeId is required." },
        { status: 400 },
      );
    }
    const lodgeId = lodgeIdResult.data.lodgeId;
    if (!(await resolveOptionalActiveLodgeId(prisma, lodgeId))) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      );
    }
    const settings = await getEffectiveBedAllocationSettings(undefined, lodgeId);
    return connectionJson(request, { settings }, ADMIN_BED_ALLOCATION_SETTINGS_CONNECTION_SHAPE);
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}

/** Also the AI app action `update_bed_allocation_settings` (ALP-719). */
export async function PUT(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationSettingsBodySchema.safeParse(json.body);
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

    return connectionJson(request, { settings }, ADMIN_BED_ALLOCATION_SETTINGS_CONNECTION_SHAPE);
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
