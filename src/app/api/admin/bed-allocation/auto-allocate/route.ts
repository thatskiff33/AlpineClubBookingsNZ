import { NextResponse } from "next/server";
import {
  runAutoBedAllocation,
} from "@/lib/bed-allocation-auto-allocate";
import {
  parseBedAllocationDateRange,
} from "@/lib/bed-allocation-date-range";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { clubTime } from "@/lib/club-time/server";
import { bedAllocationAutoAllocateBodySchema } from "@/lib/admin-bookings-schemas/beds";
import { ADMIN_BED_ALLOCATION_AUTO_ALLOCATE_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

// requireAdmin() with bookings:edit is enforced by requireBedAllocationWrite().

/** Also the AI app action `auto_allocate_beds` (ALP-719). */
export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationAutoAllocateBodySchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const lodgeId = await resolveOptionalActiveLodgeId(
      prisma,
      body.data.lodgeId,
    );
    if (!lodgeId) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      );
    }

    // ONE club day, resolved BEFORE `runAutoBedAllocation` opens its
    // transaction under `pg_advisory_xact_lock(1)` and the lodge capacity key
    // (#3123, `INV-LOCK-004`).
    const range = parseBedAllocationDateRange(
      body.data,
      (await clubTime()).today(),
    );
    const result = await runAutoBedAllocation({
      range,
      lodgeId,
    });
    logAudit({
      action: "BED_ALLOCATION_AUTO_RUN",
      memberId: guard.session.user.id,
      entityType: "BedAllocation",
      category: "lodge",
      outcome: "success",
      summary: "Bed allocation auto allocation run",
      metadata: { range, createdCount: result.count },
    });

    return connectionJson(
      request,
      { createdCount: result.count },
      ADMIN_BED_ALLOCATION_AUTO_ALLOCATE_CONNECTION_SHAPE,
    );
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
