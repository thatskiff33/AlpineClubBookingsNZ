import { NextResponse } from "next/server";
import { z } from "zod";
import { updateBedAllocationRoom } from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { logAudit } from "@/lib/audit";

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
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const body = roomPatchSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const { id } = await params;
    const room = await updateBedAllocationRoom({ id, ...body.data });
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
