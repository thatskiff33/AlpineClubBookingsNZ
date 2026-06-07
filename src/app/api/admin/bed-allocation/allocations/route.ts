import { NextResponse } from "next/server";
import { z } from "zod";
import { manuallyAllocateBed } from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { logAudit } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const manualAllocationSchema = z
  .object({
    bookingGuestId: z.string().min(1),
    bedId: z.string().min(1),
    stayDate: z.string().min(1),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const body = manualAllocationSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const allocation = await manuallyAllocateBed(body.data);
    logAudit({
      action: "BED_ALLOCATION_MANUAL_SET",
      memberId: guard.session.user.id,
      targetId: allocation.bookingId,
      entityType: "BedAllocation",
      entityId: allocation.id,
      category: "admin",
      outcome: "success",
      summary: "Manual bed allocation set",
      metadata: {
        allocationId: allocation.id,
        bookingGuestId: allocation.bookingGuestId,
        bedId: allocation.bedId,
        stayDate: allocation.stayDate,
      },
    });

    return NextResponse.json({ allocation });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
