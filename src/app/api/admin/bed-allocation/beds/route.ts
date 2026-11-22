import { NextResponse } from "next/server";
import {
  createBedAllocationBed,
} from "@/lib/bed-allocation-beds";
import {
  bedAllocationErrorResponse,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { bedAllocationBedCreateBodySchema } from "@/lib/admin-bookings-schemas/beds";
import { ADMIN_LODGE_BED_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

// requireAdmin() is enforced by requireBedInventoryWrite().

/** Also the AI app action `create_lodge_bed` (ALP-719). */
export async function POST(request: Request) {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationBedCreateBodySchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const bed = await createBedAllocationBed(body.data);
    revalidatePublicSite();
    logAudit({
      action: "BED_ALLOCATION_BED_CREATED",
      memberId: guard.session.user.id,
      entityType: "LodgeBed",
      entityId: bed.id,
      category: "lodge",
      outcome: "success",
      summary: "Bed allocation bed created",
      metadata: {
        bedId: bed.id,
        roomId: bed.roomId,
        name: bed.name,
        bedType: bed.bedType,
        bunkGroup: bed.bunkGroup,
      },
    });

    return connectionJson(request, { bed }, ADMIN_LODGE_BED_CONNECTION_SHAPE, { status: 201 });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
