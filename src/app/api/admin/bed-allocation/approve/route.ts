import { NextResponse } from "next/server";
import {
  approveBedAllocations,
} from "@/lib/bed-allocation-approval";
import {
  parseBedAllocationDateRange,
} from "@/lib/bed-allocation-date-range";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { clubTime } from "@/lib/club-time/server";
import { bedAllocationApproveBodySchema } from "@/lib/admin-bookings-schemas/beds";
import { ADMIN_BED_ALLOCATION_APPROVE_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

// requireAdmin() is enforced by requireBedAllocationWrite().
// #2887 (owner decision 7): approve must name its lodge, always. The reason
// sits with the schema in `admin-bookings-schemas/beds.ts`.

/** Also the AI app action `approve_bed_allocations` (ALP-719). */
export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationApproveBodySchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    // A named lodge must be a real, ACTIVE one — same treatment the
    // `auto-allocate` sibling gives it, so the two doors agree.
    const lodgeId = await resolveOptionalActiveLodgeId(prisma, body.data.lodgeId);
    if (!lodgeId) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      );
    }

    // ONE club day, resolved BEFORE `approveBedAllocations` opens its
    // transaction — which takes `pg_advisory_xact_lock(1)` and the lodge
    // capacity key. `INV-LOCK-004`: the club's timezone cannot be read on a
    // transaction client, so it is resolved out here and threaded in (#3123).
    const clubToday = (await clubTime()).today();
    const range =
      body.data.from || body.data.to
        ? parseBedAllocationDateRange(
            {
              from: body.data.from,
              to: body.data.to,
            },
            clubToday,
          )
        : undefined;
    // The service owns the approval and its audit in the same transaction.
    const result = await approveBedAllocations({
      approvedByMemberId: guard.session.user.id,
      allocationIds: body.data.allocationIds,
      range,
      bookingId: body.data.bookingId,
      lodgeId,
    });

    return connectionJson(
      request,
      { approvedCount: result.count },
      ADMIN_BED_ALLOCATION_APPROVE_CONNECTION_SHAPE,
    );
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
