import { NextResponse } from "next/server";
import {
  manuallyAllocateBedForNights,
} from "@/lib/bed-allocation-manual-writes";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { formatDateOnly } from "@/lib/date-only";
import { bedAllocationBulkBodySchema } from "@/lib/admin-bookings-schemas/beds";
import {
  ADMIN_BED_ALLOCATION_BULK_CONNECTION_SHAPE,
  type BedAllocationBulkAnswer,
} from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

// requireAdmin() is enforced by requireBedAllocationWrite().

/** Also the AI app action `allocate_guest_bed_nights` (ALP-719). */
export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationBulkBodySchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const result = await manuallyAllocateBedForNights(body.data);

    // The first allocation IS the condition: an audit row is written exactly
    // when this bulk set allocated something, and the booking it names comes
    // from that same allocation (#2801).
    const [firstAllocation] = result.allocations;
    if (firstAllocation) {
      await createAuditLog({
        action: "BED_ALLOCATION_BULK_SET",
        memberId: guard.session.user.id,
        targetId: firstAllocation.bookingId,
        entityType: "BedAllocation",
        category: "lodge",
        outcome: "success",
        summary: "Bed allocation set across multiple nights",
        metadata: {
          bookingGuestId: body.data.bookingGuestId,
          bedId: body.data.bedId,
          allocatedStayDates: result.allocations.map((allocation) =>
            formatDateOnly(allocation.stayDate),
          ),
          conflicts: result.conflicts,
          skipped: result.skipped,
        },
      });
    }

    // Moving a shared double's primary across nights auto-promotes each partner
    // stranded on an old bed-night (#1750). A partner may belong to a different
    // booking, so each gets its own audit entry against that booking.
    for (const promotedPartner of result.promotedPartners) {
      await createAuditLog({
        action: "BED_ALLOCATION_PARTNER_PROMOTED",
        memberId: guard.session.user.id,
        targetId: promotedPartner.bookingId,
        entityType: "BedAllocation",
        entityId: promotedPartner.id,
        category: "lodge",
        outcome: "success",
        summary:
          "Second occupant auto-promoted to primary after the shared double's primary was moved to another bed",
        metadata: {
          allocationId: promotedPartner.id,
          bedId: promotedPartner.bedId,
          bookingGuestId: body.data.bookingGuestId,
          stayDate: formatDateOnly(promotedPartner.stayDate),
        },
      });
    }

    const answer: BedAllocationBulkAnswer = {
      allocations: result.allocations.map((allocation) => ({
        id: allocation.id,
        bookingId: allocation.bookingId,
        bookingGuestId: allocation.bookingGuestId,
        roomId: allocation.roomId,
        bedId: allocation.bedId,
        stayDate: formatDateOnly(allocation.stayDate),
        source: allocation.source,
      })),
      conflicts: result.conflicts,
      skipped: result.skipped,
    };
    return connectionJson(request, answer, ADMIN_BED_ALLOCATION_BULK_CONNECTION_SHAPE);
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
