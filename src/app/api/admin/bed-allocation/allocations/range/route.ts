import { NextResponse } from "next/server";
import {
  assignBedRange,
} from "@/lib/bed-allocation-range-assign";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { bedAllocationRangeBodySchema } from "@/lib/admin-bookings-schemas/beds";
import {
  ADMIN_BED_ALLOCATION_RANGE_CONNECTION_SHAPE,
  type BedAllocationRangeAnswer,
} from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

// requireAdmin() is enforced by requireBedAllocationWrite().
// The body's rules (date-only nights, the explicit second-try `nights`, #2251)
// sit with the schema in `admin-bookings-schemas/beds.ts`.

/** Also the AI app action `assign_guest_bed_range` (ALP-719). */
export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationRangeBodySchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    /*
     * The single BED_ALLOCATION_RANGE_SET audit entry — and the single batched
     * BED_ALLOCATION_PARTNERS_PROMOTED entry, when the move stranded partners on
     * shared doubles — are written by assignBedRange INSIDE its own transaction
     * (#2251 review A4), not here: rows and record must commit or roll back
     * together, or a committed range can surface to the admin as an unrecorded
     * 500.
     */
    const result = await assignBedRange({
      ...body.data,
      approvedByMemberId: guard.session.user.id,
    });

    // The refusal report names the occupying guest and member so the admin can
    // act on it. That detail stays HERE, in the answer to the admin who asked;
    // the audit row records counts, night runs and booking ids only.
    const payload: BedAllocationRangeAnswer["result"] = {
      applied: result.applied,
      partialByConsent: result.partialByConsent,
      bookingId: result.bookingId,
      bookingGuestId: result.bookingGuestId,
      guestName: result.guestName,
      bedId: result.bedId,
      bedName: result.bedName,
      roomName: result.roomName,
      fromDate: result.fromDate,
      toDate: result.toDate,
      requestedNights: result.requestedNights,
      freeNights: result.freeNights,
      writtenNights: result.writtenNights,
      refusals: result.refusals,
    };

    if (result.applied) {
      return connectionJson(request, { result: payload }, ADMIN_BED_ALLOCATION_RANGE_CONNECTION_SHAPE);
    }

    /*
     * Nothing was written. "Guest is not booked that night" is a BAD REQUEST —
     * the range or the guest is wrong — so it answers 400; a pure clash or
     * whole-lodge hold is a genuine conflict and answers 409. Both carry the
     * SAME refusal report, because the report is the thing the admin acts on.
     */
    const badRequest = result.refusals.some(
      (refusal) => refusal.category === "GUEST_NOT_BOOKED",
    );
    return NextResponse.json(
      {
        error: badRequest
          ? "Nothing was written: the guest is not booked on some of those nights."
          : "Nothing was written: some nights in that range are blocked.",
        result: payload,
      },
      { status: badRequest ? 400 : 409 },
    );
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
