import { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteBedAllocationRoom,
  updateBedAllocationRoom,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const roomPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
    active: z.boolean().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = roomPatchSchema.safeParse(json.body);
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
      category: "admin",
      outcome: "success",
      summary: "Bed allocation room updated",
      metadata: { roomId: room.id, changes: body.data },
    });

    return NextResponse.json({ room });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
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
      category: "admin",
      outcome: "success",
      summary: "Bed allocation room deleted",
      metadata: { roomId: room.id, name: room.name },
    });

    return NextResponse.json({ room });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
