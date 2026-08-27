import { NextResponse } from "next/server";
import { z } from "zod";
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

// requireAdmin() is enforced by requireBedAllocationWrite().
/*
  #2887 (owner decision 7): approve must name its lodge. Always.

  This was the last board mutation with no server-side lodge refusal — its
  sibling `auto-allocate` already required one. Omitting `lodgeId` made the
  service lock EVERY lodge plus the global key and approve across all of them.

  I first required it only for the broad `from`/`to` sweep, reasoning that
  `allocationIds` and `bookingId` have already enumerated the rows they touch
  so a lodge adds no authorization safety. That reasoning is correct and it is
  also beside the point: absent a lodge the service still takes every lodge's
  key plus the global one, so ANY `bookings:edit` admin could stop the whole
  club's booking and allocation writers with a hand-made body naming two row
  ids. Contention, not authorization, is what makes it required — and it costs
  callers nothing, because every caller already sends it.
*/
const approveSchema = z
  .object({
    allocationIds: z.array(z.string().min(1)).max(250).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    // One booking's draft rows; sufficient without either broader selector.
    bookingId: z.string().min(1).optional(),
    // Board lodge scope. Required — see above.
    lodgeId: z.string().min(1),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = approveSchema.safeParse(json.body);
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

    return NextResponse.json({ approvedCount: result.count });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
