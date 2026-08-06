import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MAX_BULK_BEDS_PER_ROOM,
  MAX_BULK_ROOMS,
  createBedAllocationRoomsBulk,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const bulkSchema = z
  .object({
    roomCount: z.coerce.number().int().min(1).max(MAX_BULK_ROOMS),
    bedsPerRoom: z.coerce.number().int().min(0).max(MAX_BULK_BEDS_PER_ROOM),
    namePrefix: z.string().trim().min(1).max(80).optional(),
    lodgeId: z.string().min(1).optional(),
  })
  .strict();

/**
 * POST /api/admin/bed-allocation/rooms/bulk
 * Seed N rooms of M beds each in one transaction (ADR-003 bulk seeding).
 */
export async function POST(request: Request) {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bulkSchema.safeParse(json.body);
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

    const result = await createBedAllocationRoomsBulk({
      roomCount: body.data.roomCount,
      bedsPerRoom: body.data.bedsPerRoom,
      namePrefix: body.data.namePrefix,
      lodgeId,
    });
    revalidatePublicSite();

    logAudit({
      action: "BED_ALLOCATION_ROOMS_BULK_CREATED",
      memberId: guard.session.user.id,
      entityType: "LodgeRoom",
      entityId: lodgeId,
      category: "admin",
      outcome: "success",
      summary: "Bed allocation rooms bulk created",
      metadata: {
        lodgeId,
        roomCount: result.createdRoomCount,
        bedCount: result.createdBedCount,
        namePrefix: body.data.namePrefix ?? "Room",
      },
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
