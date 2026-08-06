import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MAX_BED_ALLOCATION_RANGE_NIGHTS,
  manuallyAllocateBed,
  moveBedAllocationsSameDate,
} from "@/lib/admin-bed-allocation";
import { formatDateOnly } from "@/lib/date-only";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const manualAllocationSchema = z
  .object({
    bookingGuestId: z.string().min(1),
    bedId: z.string().min(1),
    stayDate: z.string().min(1),
  })
  .strict();

const moveAllocationSchema = z
  .object({
    allocationIds: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BED_ALLOCATION_RANGE_NIGHTS),
    bedId: z.string().min(1),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = manualAllocationSchema.safeParse(json.body);
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
      category: "admin",
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
        category: "admin",
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

    return NextResponse.json({ allocation });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = moveAllocationSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    // The service owns the transaction and writes both allocation changes and
    // audit rows inside it. Keeping the route audit-free avoids the old
    // committed-write/missing-audit window and makes server-side no-ops silent.
    const result = await moveBedAllocationsSameDate({
      ...body.data,
      actorMemberId: guard.session.user.id,
    });

    return NextResponse.json({
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
    });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
