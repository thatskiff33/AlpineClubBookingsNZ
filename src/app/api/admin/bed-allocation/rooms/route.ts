import { NextResponse } from "next/server";
import {
  createBedAllocationRoom,
  getRoomsAndBedsConfiguration,
} from "@/lib/bed-allocation-rooms";
import {
  bedAllocationErrorResponse,
  requireBedInventoryRead,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import {
  bedAllocationRoomCreateBodySchema,
  bedAllocationRoomsQuerySchema,
} from "@/lib/admin-bookings-schemas/beds";
import {
  ADMIN_LODGE_ROOM_CONNECTION_SHAPE,
  ADMIN_LODGE_ROOMS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

// requireAdmin() is enforced by the route-specific bed-inventory guard.

/** Also the AI app action `list_lodge_rooms_and_beds` (ALP-719). */
export async function GET(request: Request) {
  const guard = await requireBedInventoryRead();
  if (!guard.ok) return guard.response;

  try {
    const query = bedAllocationRoomsQuerySchema.safeParse({
      lodgeId: new URL(request.url).searchParams.get("lodgeId") ?? undefined,
    });
    if (!query.success) {
      return NextResponse.json(
        { error: "Invalid input", details: query.error.flatten() },
        { status: 400 },
      );
    }
    const lodgeId = query.data.lodgeId;
    // Validate an explicit lodge scope the way the POST path does (400 on
    // unknown/inactive); omitted stays club-wide.
    if (lodgeId && !(await resolveOptionalActiveLodgeId(prisma, lodgeId))) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      );
    }
    return connectionJson(
      request,
      await getRoomsAndBedsConfiguration(undefined, lodgeId),
      ADMIN_LODGE_ROOMS_CONNECTION_SHAPE,
    );
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}

/** Also the AI app action `create_lodge_room` (ALP-719). */
export async function POST(request: Request) {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationRoomCreateBodySchema.safeParse(json.body);
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

    const room = await createBedAllocationRoom({ ...body.data, lodgeId });
    revalidatePublicSite();
    logAudit({
      action: "BED_ALLOCATION_ROOM_CREATED",
      memberId: guard.session.user.id,
      entityType: "LodgeRoom",
      entityId: room.id,
      category: "lodge",
      outcome: "success",
      summary: "Bed allocation room created",
      metadata: { roomId: room.id, name: room.name },
    });

    return connectionJson(request, { room }, ADMIN_LODGE_ROOM_CONNECTION_SHAPE, { status: 201 });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
