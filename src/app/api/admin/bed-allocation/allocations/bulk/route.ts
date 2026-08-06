import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MAX_BED_ALLOCATION_RANGE_NIGHTS,
  manuallyAllocateBedForNights,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { formatDateOnly } from "@/lib/date-only";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const bulkAllocationSchema = z
  .object({
    bookingGuestId: z.string().min(1),
    bedId: z.string().min(1),
    stayDates: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BED_ALLOCATION_RANGE_NIGHTS),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bulkAllocationSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const result = await manuallyAllocateBedForNights(body.data);

    if (result.allocations.length > 0) {
      await createAuditLog({
        action: "BED_ALLOCATION_BULK_SET",
        memberId: guard.session.user.id,
        targetId: result.allocations[0].bookingId,
        entityType: "BedAllocation",
        category: "admin",
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
        category: "admin",
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

    return NextResponse.json({
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
    });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
