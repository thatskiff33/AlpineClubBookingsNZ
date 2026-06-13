import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MAX_BED_ALLOCATION_RANGE_NIGHTS,
  manuallyAllocateBedForNights,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
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
  const guard = await requireBedAllocationAdmin();
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
