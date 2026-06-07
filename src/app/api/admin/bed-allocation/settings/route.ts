import { NextResponse } from "next/server";
import { z } from "zod";
import { updateBedAllocationSettings } from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { logAudit } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const settingsSchema = z
  .object({
    autoAllocationEnabled: z.boolean(),
  })
  .strict();

export async function PUT(request: Request) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const body = settingsSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const settings = await updateBedAllocationSettings({
      autoAllocationEnabled: body.data.autoAllocationEnabled,
      updatedByMemberId: guard.session.user.id,
    });

    logAudit({
      action: "BED_ALLOCATION_SETTINGS_UPDATED",
      memberId: guard.session.user.id,
      entityType: "BedAllocationSettings",
      entityId: "default",
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
