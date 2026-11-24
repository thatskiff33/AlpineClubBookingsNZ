import {
  importRoomsAndBedsFromClubConfig,
} from "@/lib/bed-allocation-rooms";
import {
  bedAllocationErrorResponse,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";
import { logAudit } from "@/lib/audit";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { ADMIN_LODGE_ROOMS_IMPORT_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

// requireAdmin() is enforced by requireBedInventoryWrite().
/** Also the AI app action `import_rooms_and_beds_from_config` (ALP-719). */
export async function POST(request: Request) {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const result = await importRoomsAndBedsFromClubConfig();
    revalidatePublicSite();
    logAudit({
      action: "BED_ALLOCATION_CONFIG_IMPORTED",
      memberId: guard.session.user.id,
      entityType: "LodgeRoom",
      category: "lodge",
      outcome: "success",
      summary: "Rooms and beds imported from club config",
      metadata: {
        createdRoomCount: result.createdRoomCount,
        createdBedCount: result.createdBedCount,
      },
    });

    return connectionJson(request, result, ADMIN_LODGE_ROOMS_IMPORT_CONNECTION_SHAPE, { status: 201 });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
