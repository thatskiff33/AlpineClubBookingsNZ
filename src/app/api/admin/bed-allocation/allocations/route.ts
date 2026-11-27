import { NextResponse } from "next/server";
import {
  manuallyAllocateBed,
  moveBedAllocationsSameDate,
} from "@/lib/bed-allocation-manual-writes";
import { formatDateOnly } from "@/lib/date-only";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import {
  applyBedAllocationMove,
  BedAllocationMoveError,
  type BedAllocationMoveApplyRequest,
} from "@/lib/bed-allocation-move";
import {
  bedAllocationManualBodySchema,
  bedAllocationMoveRequestSchema,
} from "@/lib/admin-bookings-schemas/beds";
import {
  ADMIN_BED_ALLOCATION_CONNECTION_SHAPE,
  ADMIN_BED_ALLOCATION_MOVE_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-beds";
import { connectionJson } from "@/lib/mcp-connection-request";

// requireAdmin() is enforced by requireBedAllocationWrite().

function moveErrorResponse(error: unknown) {
  if (error instanceof BedAllocationMoveError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        ...(error.refreshedPreview
          ? { refreshedPreview: error.refreshedPreview }
          : {}),
      },
      { status: error.status },
    );
  }
  return bedAllocationErrorResponse(error);
}

/** Also the AI app action `allocate_guest_bed_night` (ALP-719). */
export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationManualBodySchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const { allocation, promotedPartner } = await manuallyAllocateBed(body.data);
    await createAuditLog({
      action: "BED_ALLOCATION_MANUAL_SET",
      memberId: guard.session.user.id,
      targetId: allocation.bookingId,
      entityType: "BedAllocation",
      entityId: allocation.id,
      category: "lodge",
      outcome: "success",
      summary: "Manual bed allocation set",
      metadata: {
        allocationId: allocation.id,
        bookingGuestId: allocation.bookingGuestId,
        bedId: allocation.bedId,
        stayDate: allocation.stayDate,
      },
    });
    // Moving a shared double's primary onto another bed auto-promotes the
    // partner left on the OLD bed-night (#1750). The partner may belong to a
    // different booking, so it gets its own audit entry against that booking.
    if (promotedPartner) {
      await createAuditLog({
        action: "BED_ALLOCATION_PARTNER_PROMOTED",
        memberId: guard.session.user.id,
        targetId: promotedPartner.bookingId,
        entityType: "BedAllocation",
        entityId: promotedPartner.id,
        category: "lodge",
        outcome: "success",
        summary:
          "Second occupant auto-promoted to primary after the shared double's primary was moved to another bed",
        metadata: {
          allocationId: promotedPartner.id,
          bedId: promotedPartner.bedId,
          stayDate: promotedPartner.stayDate,
          movedAllocationId: allocation.id,
        },
      });
    }

    return connectionJson(request, { allocation }, ADMIN_BED_ALLOCATION_CONNECTION_SHAPE);
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}

/**
 * Also the AI app action `move_bed_allocation` (ALP-719), which offers the
 * typed, previewed move only. The older id-list move answers a connection
 * through the same projection, so it too sends only `noop`.
 */
export async function PATCH(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedAllocationMoveRequestSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    if ("anchorAllocationId" in body.data) {
      return connectionJson(
        request,
        await applyBedAllocationMove({
          request: body.data as BedAllocationMoveApplyRequest,
          actorMemberId: guard.session.user.id,
        }),
        ADMIN_BED_ALLOCATION_MOVE_CONNECTION_SHAPE,
      );
    }

    // The legacy service owns the transaction and writes both allocation changes and
    // audit rows inside it. Keeping the route audit-free avoids the old
    // committed-write/missing-audit window and makes server-side no-ops silent.
    const result = await moveBedAllocationsSameDate({
      ...body.data,
      actorMemberId: guard.session.user.id,
    });

    return connectionJson(request, {
      noop: result.noop,
      allocations: result.allocations.map((allocation) => ({
        id: allocation.id,
        bookingId: allocation.bookingId,
        bookingGuestId: allocation.bookingGuestId,
        roomId: allocation.roomId,
        bedId: allocation.bedId,
        stayDate: formatDateOnly(allocation.stayDate),
        source: allocation.source,
      })),
    }, ADMIN_BED_ALLOCATION_MOVE_CONNECTION_SHAPE);
  } catch (error) {
    return moveErrorResponse(error);
  }
}
