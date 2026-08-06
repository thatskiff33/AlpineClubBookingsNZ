import { NextResponse } from "next/server";
import { z } from "zod";
import {
  parseBedAllocationDateRange,
  runAutoBedAllocation,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const autoAllocateSchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    // Board lodge scope (ADR-003): suggestions only place guests of this
    // lodge's bookings into this lodge's beds. Omitted = club-wide.
    lodgeId: z.string().min(1).optional(),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = autoAllocateSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const range = parseBedAllocationDateRange(body.data);
    const result = await runAutoBedAllocation({
      range,
      lodgeId: body.data.lodgeId,
    });
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
