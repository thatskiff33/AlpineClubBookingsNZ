import { NextResponse } from "next/server";
import {
  deleteBedAllocationBed,
  updateBedAllocationBed,
} from "@/lib/bed-allocation-beds";
import {
  bedAllocationErrorResponse,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { bedAllocationBedUpdateBodySchema } from "@/lib/admin-bookings-schemas/beds";
import { ADMIN_LODGE_BED_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

// requireAdmin() is enforced by requireBedInventoryWrite().

/** Also the AI app action `update_lodge_bed` (ALP-719). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationBedUpdateBodySchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const { id } = await params;
    const bed = await updateBedAllocationBed({ id, ...body.data });
    revalidatePublicSite();
    logAudit({
      action: "BED_ALLOCATION_BED_UPDATED",
      memberId: guard.session.user.id,
      entityType: "LodgeBed",
      entityId: bed.id,
      category: "lodge",
      outcome: "success",
      summary: "Bed allocation bed updated",
      metadata: { bedId: bed.id, changes: body.data },
    });

    return connectionJson(request, { bed }, ADMIN_LODGE_BED_CONNECTION_SHAPE);
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}

/** Also the AI app action `delete_lodge_bed` (ALP-719). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const { id } = await params;
    const bed = await deleteBedAllocationBed({ id });
    revalidatePublicSite();
    logAudit({
      action: "BED_ALLOCATION_BED_DELETED",
      memberId: guard.session.user.id,
      entityType: "LodgeBed",
      entityId: bed.id,
      category: "lodge",
      outcome: "success",
      summary: "Bed allocation bed deleted",
      metadata: {
        bedId: bed.id,
        roomId: bed.roomId,
        name: bed.name,
        bedType: bed.bedType,
        bunkGroup: bed.bunkGroup,
      },
    });

    return connectionJson(request, { bed }, ADMIN_LODGE_BED_CONNECTION_SHAPE);
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
