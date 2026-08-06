import { NextRequest, NextResponse } from "next/server";
import {
  getBedAllocationDashboard,
  parseBedAllocationDateRange,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationRead,
} from "@/lib/admin-bed-allocation-routes";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";

// requireAdmin() is enforced by requireBedAllocationAdmin().
export async function GET(request: NextRequest) {
  const guard = await requireBedAllocationRead();
  if (!guard.ok) return guard.response;

  try {
    const range = parseBedAllocationDateRange({
      from: request.nextUrl.searchParams.get("from"),
      to: request.nextUrl.searchParams.get("to"),
    });
    // Scope the board to one lodge (ADR-003); omitted = club-wide, which
    // preserves single-lodge behaviour.
    const lodgeId = request.nextUrl.searchParams.get("lodgeId") ?? undefined;
    // Validate an explicit lodge scope the way the write paths do (400 on
    // unknown/inactive); omitted stays club-wide.
    if (lodgeId && !(await resolveOptionalActiveLodgeId(prisma, lodgeId))) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      );
    }
    return NextResponse.json(
      await getBedAllocationDashboard({
        range,
        lodgeId,
        bookingId: request.nextUrl.searchParams.get("bookingId"),
      }),
    );
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
