import { NextResponse } from "next/server";
import { deleteBedAllocation } from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { logAudit } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const { id } = await params;
    const allocation = await deleteBedAllocation({ id });
    logAudit({
      action: "BED_ALLOCATION_DELETED",
      memberId: guard.session.user.id,
      targetId: allocation.bookingId,
      entityType: "BedAllocation",
      entityId: allocation.id,
      category: "admin",
      outcome: "success",
      summary: "Bed allocation removed",
      metadata: { allocationId: allocation.id },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
