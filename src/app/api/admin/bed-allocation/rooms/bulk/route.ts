import { NextResponse } from "next/server";
import { createBedAllocationRoomsBulk } from "@/lib/bed-allocation-rooms";
import {
  bedAllocationErrorResponse,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { bedAllocationRoomsBulkBodySchema } from "@/lib/admin-bookings-schemas/beds";
import { ADMIN_LODGE_ROOMS_BULK_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

// requireAdmin() is enforced by requireBedInventoryWrite().

/**
 * POST /api/admin/bed-allocation/rooms/bulk
 * Seed N rooms of M beds each in one transaction (ADR-003 bulk seeding).
 * Also the AI app action `create_lodge_rooms_in_bulk` (ALP-719).
 */
export async function POST(request: Request) {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationRoomsBulkBodySchema.safeParse(json.body);
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
      category: "lodge",
      outcome: "success",
      summary: "Bed allocation rooms bulk created",
      metadata: {
        lodgeId,
        roomCount: result.createdRoomCount,
        bedCount: result.createdBedCount,
        namePrefix: body.data.namePrefix ?? "Room",
      },
    });

    return connectionJson(request, result, ADMIN_LODGE_ROOMS_BULK_CONNECTION_SHAPE, { status: 201 });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
