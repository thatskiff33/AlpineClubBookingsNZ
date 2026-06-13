import { NextResponse } from "next/server";
import { importRoomsAndBedsFromClubConfig } from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { logAudit } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
export async function POST() {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const result = await importRoomsAndBedsFromClubConfig();
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
