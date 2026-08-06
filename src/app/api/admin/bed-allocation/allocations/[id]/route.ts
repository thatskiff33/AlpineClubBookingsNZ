import { NextResponse } from "next/server";
import { deleteBedAllocation } from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { createAuditLog } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const { id } = await params;
    const { deleted: allocation, promotedPartner } = await deleteBedAllocation({
      id,
    });
    await createAuditLog({
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
    // The auto-promoted partner (#1743) may belong to a different booking than
    // the deleted row, so that booking gets its own audit entry rather than
    // hiding a cross-booking state change under the delete above.
    if (promotedPartner) {
      await createAuditLog({
        action: "BED_ALLOCATION_PARTNER_PROMOTED",
        memberId: guard.session.user.id,
        targetId: promotedPartner.bookingId,
        entityType: "BedAllocation",
        entityId: promotedPartner.id,
        category: "admin",
        outcome: "success",
        summary:
          "Second occupant auto-promoted to primary after the shared double's primary was removed",
        metadata: {
          allocationId: promotedPartner.id,
          bedId: promotedPartner.bedId,
          stayDate: promotedPartner.stayDate,
          deletedAllocationId: allocation.id,
        },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
