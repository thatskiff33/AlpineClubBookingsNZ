import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createBedAllocationRoom,
  getRoomsAndBedsConfiguration,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const roomSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    sortOrder: z.coerce.number().int().min(0).max(10000).default(0),
    active: z.boolean().default(true),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export async function GET() {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    return NextResponse.json(await getRoomsAndBedsConfiguration());
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = roomSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const room = await createBedAllocationRoom(body.data);
    logAudit({
      action: "BED_ALLOCATION_ROOM_CREATED",
      memberId: guard.session.user.id,
      entityType: "LodgeRoom",
      entityId: room.id,
      category: "admin",
      outcome: "success",
      summary: "Bed allocation room created",
      metadata: { roomId: room.id, name: room.name },
    });

    return NextResponse.json({ room }, { status: 201 });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
