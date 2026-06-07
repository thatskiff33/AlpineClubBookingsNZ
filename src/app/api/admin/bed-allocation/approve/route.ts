import { NextResponse } from "next/server";
import { z } from "zod";
import {
  approveBedAllocations,
  parseBedAllocationDateRange,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { logAudit } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const approveSchema = z
  .object({
    allocationIds: z.array(z.string().min(1)).max(250).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const body = approveSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const range =
      body.data.from || body.data.to
        ? parseBedAllocationDateRange({
            from: body.data.from,
            to: body.data.to,
          })
        : undefined;
    const result = await approveBedAllocations({
      approvedByMemberId: guard.session.user.id,
      allocationIds: body.data.allocationIds,
      range,
    });

    logAudit({
      action: "BED_ALLOCATION_APPROVED",
      memberId: guard.session.user.id,
      entityType: "BedAllocation",
      category: "admin",
      outcome: "success",
      summary: "Bed allocations approved",
      metadata: {
        approvedCount: result.count,
        allocationIds: body.data.allocationIds,
        range,
      },
    });

    return NextResponse.json({ approvedCount: result.count });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
