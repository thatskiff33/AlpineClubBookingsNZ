import { NextResponse } from "next/server";
import { z } from "zod";
import {
  parseBedAllocationDateRange,
  runAutoBedAllocation,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { logAudit } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const autoAllocateSchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const body = autoAllocateSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const range = parseBedAllocationDateRange(body.data);
    const result = await runAutoBedAllocation({ range });
    logAudit({
      action: "BED_ALLOCATION_AUTO_RUN",
      memberId: guard.session.user.id,
      entityType: "BedAllocation",
      category: "admin",
      outcome: "success",
      summary: "Bed allocation auto allocation run",
      metadata: { range, createdCount: result.count },
    });

    return NextResponse.json({ createdCount: result.count });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
