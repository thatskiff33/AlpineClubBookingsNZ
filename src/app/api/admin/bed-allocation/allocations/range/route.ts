import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS,
  assignBedRange,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";

// Shape-checked here so a malformed range is refused by the schema, before the
// lib is called at all (#2251 review C2): `.min(1)` accepted "9999999-01-01".
const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

// requireAdmin() is enforced by requireBedAllocationAdmin().
const rangeAllocationSchema = z
  .object({
    bookingGuestId: z.string().min(1),
    bedId: z.string().min(1),
    // Date-only lodge nights: `from` is the first night, `to` the check-out
    // date (exclusive), matching every other bed-allocation endpoint.
    from: DATE_ONLY,
    to: DATE_ONLY,
    /*
     * The admin's explicit SECOND action after a refusal (#2251): the exact
     * nights they were shown as free and chose to assign. Never a default — the
     * first attempt is always all-or-nothing — and never a flag the server
     * re-interprets: it assigns this set or refuses it with a fresh report, so
     * a night freed by someone else between the report and the click cannot be
     * written without the admin ever seeing it.
     */
    nights: z
      .array(DATE_ONLY)
      .min(1)
      .max(MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS)
      .optional(),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = rangeAllocationSchema.safeParse(json.body);
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
    const payload = {
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
      return NextResponse.json({ result: payload });
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
