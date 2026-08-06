import { NextResponse } from "next/server";
import { importRoomsAndBedsFromClubConfig } from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";
import { logAudit } from "@/lib/audit";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";

// requireAdmin() is enforced by requireBedAllocationAdmin().
export async function POST() {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const result = await importRoomsAndBedsFromClubConfig();
    revalidatePublicSite();
    logAudit({
      action: "BED_ALLOCATION_CONFIG_IMPORTED",
      memberId: guard.session.user.id,
      entityType: "LodgeRoom",
      category: "admin",
      outcome: "success",
      summary: "Rooms and beds imported from club config",
      metadata: {
        createdRoomCount: result.createdRoomCount,
        createdBedCount: result.createdBedCount,
      },
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
