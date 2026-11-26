import { NextResponse } from "next/server";
import {
  deleteBedAllocationRoom,
  updateBedAllocationRoom,
} from "@/lib/bed-allocation-rooms";
import {
  bedAllocationErrorResponse,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { bedAllocationRoomUpdateBodySchema } from "@/lib/admin-bookings-schemas/beds";
import { ADMIN_LODGE_ROOM_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

// requireAdmin() is enforced by requireBedInventoryWrite().

/** Also the AI app action `update_lodge_room` (ALP-719). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationRoomUpdateBodySchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const { id } = await params;
    const room = await updateBedAllocationRoom({ id, ...body.data });
    revalidatePublicSite();
    logAudit({
      action: "BED_ALLOCATION_ROOM_UPDATED",
      memberId: guard.session.user.id,
      entityType: "LodgeRoom",
      entityId: room.id,
      category: "lodge",
      outcome: "success",
      summary: "Bed allocation room updated",
      metadata: { roomId: room.id, changes: body.data },
    });

    return connectionJson(request, { room }, ADMIN_LODGE_ROOM_CONNECTION_SHAPE);
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}

/** Also the AI app action `delete_lodge_room` (ALP-719). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const { id } = await params;
    const room = await deleteBedAllocationRoom({ id });
    revalidatePublicSite();
    logAudit({
      action: "BED_ALLOCATION_ROOM_DELETED",
      memberId: guard.session.user.id,
      entityType: "LodgeRoom",
      entityId: room.id,
      category: "lodge",
      outcome: "success",
      summary: "Bed allocation room deleted",
      metadata: { roomId: room.id, name: room.name },
    });

    return connectionJson(request, { room }, ADMIN_LODGE_ROOM_CONNECTION_SHAPE);
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
