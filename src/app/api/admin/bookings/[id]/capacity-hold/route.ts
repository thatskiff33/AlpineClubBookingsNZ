import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
// #2930: the confirmable over-capacity set comes from its ONE definition. This
// route carried a private `getOverbookedNights` that spelled the same rule
// inline (`INV-SSOT-001`); `overCapacityNights` also excludes whole-lodge-held
// nights by name, which this copy achieved only as a side effect of a held
// night's available beds being pinned to 0 rather than negative (`INV-CAP-021`,
// ADR-001 decision 5). The hold itself is still reported separately and refused
// before the overbook gate, below.
import {
  overCapacityNights,
  wholeLodgeBlockedNights,
} from "@/lib/over-capacity-confirmation";
import { getDefaultLodgeId } from "@/lib/lodges";
import { bookingHoldsCapacity } from "@/lib/booking-status";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import logger from "@/lib/logger";
import { z } from "zod";

const capacityHoldSchema = z.object({
  allowOverbook: z.boolean().optional(),
});

/**
 * POST /api/admin/bookings/[id]/capacity-hold — Admin Hold (#1764).
 *
 * Reserves lodge capacity for a PAYMENT_PENDING booking (which is otherwise
 * deliberately non-holding, #737) without faking a payment or changing the
 * booking's real status: sets `adminCapacityHoldAt`/`adminCapacityHoldByMemberId`,
 * which `capacityHoldingBookingFilter()` counts while the booking stays
 * PAYMENT_PENDING. Runs under the per-lodge advisory capacity lock with a
 * capacity re-check (#1366 pattern); an over-capacity hold requires the
 * explicit `allowOverbook` confirm, mirroring force-confirm (#1668 semantics,
 * 409 CAPACITY_EXCEEDED).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;

  const body = await request.json().catch(() => ({}));
  const parsed = capacityHoldSchema.safeParse(body);
  const allowOverbook = parsed.success
    ? Boolean(parsed.data.allowOverbook)
    : false;
  const auditRequest = getAuditRequestContext(request);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Pre-lock read of the lock key only; lodgeId is immutable, so keying
      // the advisory lock from it is safe. Every decision below consumes the
      // post-lock re-read.
      const lockTarget = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { lodgeId: true },
      });
      if (!lockTarget) {
        return { error: "Booking not found", status: 404 as const };
      }

      const bookingLodgeId =
        lockTarget.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);

      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          guests: { include: { nights: true } },
          originBookingRequest: { select: { id: true } },
        },
      });
      if (!booking || booking.deletedAt) {
        return { error: "Booking not found", status: 404 as const };
      }

      if (
        bookingHoldsCapacity({
          status: booking.status,
          isRequestConverted: Boolean(booking.originBookingRequest),
        })
      ) {
        return {
          error:
            "This booking already holds capacity through its status; an admin hold is unnecessary.",
          status: 409 as const,
        };
      }

      if (booking.status !== BookingStatus.PAYMENT_PENDING) {
        return {
          error:
            "Only payment-pending bookings can take an admin capacity hold.",
          status: 400 as const,
        };
      }

      if (booking.adminCapacityHoldAt) {
        return {
          error: "This booking already has an admin capacity hold.",
          status: 409 as const,
        };
      }

      // Capacity re-check under the lock (#1366 pattern). The booking itself
      // is excluded: it holds nothing yet, and its own guests are the
      // proposed occupancy.
      const capacity = await checkCapacityForGuestRanges(
        bookingLodgeId,
        booking.checkIn,
        booking.checkOut,
        booking.guests,
        booking.id,
        tx,
      );
      const overbookedNights = overCapacityNights(capacity);
      const overbookDates = overbookedNights.map((night) => night.date);

      // Exclusive whole-lodge hold (ADR-001 decision 5, issue #118): a hold on
      // ANOTHER overlapping booking blocks placing this admin hold's occupancy
      // even under allowOverbook, before the hold is written. Held nights are
      // pinned to 0, so they never surface in overbookDates — this is the only
      // guard that catches them. (Placing a hold is #121; this route sets an
      // adminCapacityHold, which admits the booking's beds — a new admission.)
      const blockedNights = wholeLodgeBlockedNights({
        nightDetails: capacity.nightDetails,
      });
      if (blockedNights.length > 0) {
        return {
          error: "WHOLE_LODGE_HOLD_BLOCKED" as const,
          code: "WHOLE_LODGE_HOLD_BLOCKED" as const,
          blockedNights,
          status: 409 as const,
        };
      }

      if (!capacity.available && !allowOverbook) {
        return {
          error: "CAPACITY_EXCEEDED" as const,
          overbookDates,
          status: 409 as const,
        };
      }

      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: {
          adminCapacityHoldAt: new Date(),
          adminCapacityHoldByMemberId: session.user.id,
          // Persisted capacity override (#1771): a hold placed over the ceiling
          // (allowOverbook past the gate) also records the durable override so a
          // later payment on this booking is never cancelled/bumped. Guarded —
          // never set when the hold fit within capacity.
          ...(!capacity.available
            ? {
                capacityOverriddenAt: new Date(),
                capacityOverriddenByMemberId: session.user.id,
              }
            : {}),
        },
        select: { adminCapacityHoldAt: true },
      });

      const overbooked = !capacity.available;
      await createAuditLog(
        {
          action: overbooked
            ? "booking.admin_capacity_hold.placed_overbook"
            : "booking.admin_capacity_hold.placed",
          memberId: session.user.id,
          actorMemberId: session.user.id,
          subjectMemberId: booking.memberId,
          targetId: booking.id,
          entityType: "Booking",
          entityId: booking.id,
          category: "booking",
          severity: overbooked ? "critical" : "important",
          outcome: "success",
          summary: overbooked
            ? "Admin capacity hold placed with overbook"
            : "Admin capacity hold placed",
          details: overbooked
            ? "Admin reserved lodge capacity for an unpaid booking despite capacity being exceeded."
            : "Admin reserved lodge capacity for an unpaid booking while payment is arranged.",
          metadata: {
            bookingStatus: booking.status,
            allowOverbook,
            overbooked,
            overbookDates,
            checkIn: booking.checkIn.toISOString(),
            checkOut: booking.checkOut.toISOString(),
            guestCount: booking.guests.length,
          },
          requestId: auditRequest?.id,
          ipAddress: auditRequest?.ipAddress,
          userAgent: auditRequest?.userAgent,
          retentionClass: overbooked ? "critical" : undefined,
          incidentPreserved: overbooked,
        },
        tx,
      );

      return {
        success: true as const,
        overbooked,
        overbookDates,
        adminCapacityHoldAt: updated.adminCapacityHoldAt,
      };
    });

    if ("error" in result) {
      return NextResponse.json(
        {
          error: result.error,
          ...("code" in result ? { code: result.code } : {}),
          ...("overbookDates" in result
            ? { overbookDates: result.overbookDates }
            : {}),
          ...("blockedNights" in result
            ? { blockedNights: result.blockedNights }
            : {}),
        },
        { status: result.status },
      );
    }

    return NextResponse.json({
      success: true,
      overbooked: result.overbooked,
      overbookDates: result.overbookDates,
      adminCapacityHoldAt: result.adminCapacityHoldAt,
    });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to place admin capacity hold");
    return NextResponse.json(
      { error: "Failed to place admin capacity hold" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/admin/bookings/[id]/capacity-hold — Admin Unhold (#1764).
 *
 * Releases an admin capacity hold, freeing the beds. Refused once the booking
 * holds capacity naturally (paid/confirmed/etc.): releasing a paid booking's
 * capacity stays impossible — the hold record is then inert and the normal
 * cancel paths clear it. Double-unhold answers a clear 409 without changing
 * state. Releasing capacity cannot overbook, so no capacity lock is needed.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;
  const auditRequest = getAuditRequestContext(request);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { originBookingRequest: { select: { id: true } } },
      });
      if (!booking || booking.deletedAt) {
        return { error: "Booking not found", status: 404 as const };
      }

      if (!booking.adminCapacityHoldAt) {
        return {
          error: "This booking has no admin capacity hold to release.",
          status: 409 as const,
        };
      }

      // Once naturally holding, releasing capacity stays impossible — the
      // beds belong to a paid/confirmed stay, not to the admin hold.
      if (
        bookingHoldsCapacity({
          status: booking.status,
          isRequestConverted: Boolean(booking.originBookingRequest),
        })
      ) {
        return {
          error:
            "This booking now holds capacity through its status; the admin hold can no longer be released.",
          status: 409 as const,
        };
      }

      await tx.booking.update({
        where: { id: booking.id },
        data: {
          adminCapacityHoldAt: null,
          adminCapacityHoldByMemberId: null,
        },
      });

      await createAuditLog(
        {
          action: "booking.admin_capacity_hold.released",
          memberId: session.user.id,
          actorMemberId: session.user.id,
          subjectMemberId: booking.memberId,
          targetId: booking.id,
          entityType: "Booking",
          entityId: booking.id,
          category: "booking",
          severity: "important",
          outcome: "success",
          summary: "Admin capacity hold released",
          details:
            "Admin released the capacity hold on an unpaid booking; the beds are bookable again.",
          metadata: {
            bookingStatus: booking.status,
            heldAt: booking.adminCapacityHoldAt.toISOString(),
            heldByMemberId: booking.adminCapacityHoldByMemberId,
          },
          requestId: auditRequest?.id,
          ipAddress: auditRequest?.ipAddress,
          userAgent: auditRequest?.userAgent,
        },
        tx,
      );

      return { success: true as const };
    });

    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to release admin capacity hold");
    return NextResponse.json(
      { error: "Failed to release admin capacity hold" },
      { status: 500 },
    );
  }
}
