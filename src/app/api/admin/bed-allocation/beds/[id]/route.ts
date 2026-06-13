import { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteBedAllocationBed,
  updateBedAllocationBed,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const bedPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
    active: z.boolean().optional(),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedPatchSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const { id } = await params;
    const bed = await updateBedAllocationBed({ id, ...body.data });
    logAudit({
      action: "BED_ALLOCATION_BED_UPDATED",
      memberId: guard.session.user.id,
      entityType: "LodgeBed",
      entityId: bed.id,
      category: "admin",
      outcome: "success",
      summary: "Bed allocation bed updated",
      metadata: { bedId: bed.id, changes: body.data },
    });

    return NextResponse.json({ bed });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const { id } = await params;
    const bed = await deleteBedAllocationBed({ id });
    logAudit({
      action: "BED_ALLOCATION_BED_DELETED",
      memberId: guard.session.user.id,
      entityType: "LodgeBed",
      entityId: bed.id,
      category: "admin",
      outcome: "success",
      summary: "Bed allocation bed deleted",
      metadata: { bedId: bed.id, roomId: bed.roomId, name: bed.name },
    });

    return NextResponse.json({ bed });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
