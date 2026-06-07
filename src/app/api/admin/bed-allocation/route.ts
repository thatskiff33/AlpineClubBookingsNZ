import { NextRequest, NextResponse } from "next/server";
import {
  getBedAllocationDashboard,
  parseBedAllocationDateRange,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";

// requireAdmin() is enforced by requireBedAllocationAdmin().
export async function GET(request: NextRequest) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const range = parseBedAllocationDateRange({
      from: request.nextUrl.searchParams.get("from"),
      to: request.nextUrl.searchParams.get("to"),
    });
    return NextResponse.json(await getBedAllocationDashboard({ range }));
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
