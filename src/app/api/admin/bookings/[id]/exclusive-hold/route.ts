import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import {
  acquireLodgeCapacityLock,
  findOverlappingCapacityHoldingBookings,
  findOverlappingOverriddenNonHoldingBookings,
} from "@/lib/capacity";
import {
  bookingHoldsCapacity,
  capacityHoldingBookingFilter,
} from "@/lib/booking-status";
import {
  MAX_AUDITED_PRUNED_ALLOCATIONS,
  reconcileBedAllocationsForBooking,
} from "@/lib/bed-allocation-lifecycle";
import { formatDateOnly } from "@/lib/date-only";
import logger from "@/lib/logger";
import { z } from "zod";

const exclusiveHoldSchema = z.object({
  hold: z.boolean(),
});

/**
 * POST /api/admin/bookings/[id]/exclusive-hold — set/clear the exclusive
 * whole-lodge hold on ANY booking (issue #121, ADR-001).
 *
 * The hold (`Booking.wholeLodgeHold`) reserves the whole lodge and hard-blocks
 * new admissions on the booking's nights (the capacity side of the rule lives
 * in #118). This route only writes the authoritative flag + who/when audit
 * fields; it is the admin entry point that complements the school request path.
 *
 * ADR-001 decision 1: setting a hold has NO empty-lodge precondition — it is
 * allowed regardless of existing overlapping bookings and is NEVER refused.
 * Conflicts are surfaced and resolved by the officer, never auto-displaced, and
 * no bed-arithmetic capacity engine runs here. But per ADR-001's Security/safety
 * section the two-sided rule must be lock-serialised (issue #154): the flag
 * write and the conflict read run inside the per-lodge capacity lock
 * (`acquireLodgeCapacityLock`), the same key every admission takes, so a hold
 * set cannot race an in-flight admission at the lodge. (confirm-pending-guests
 * was the last admission path still on the legacy club-wide key; #172 moved it
 * onto this per-lodge key so the guarantee holds again.) Authorisation mirrors the
 * sibling capacity-hold route (requireAdmin: admin/full-admin); both set and
 * clear are audited.
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
  const parsed = exclusiveHoldSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const { hold } = parsed.data;
  const auditRequest = getAuditRequestContext(request);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Read only the immutable lock key before taking the lock. A concurrent
      // date/status writer may commit while this transaction waits, so no
      // mutable field from this first read may drive a decision.
      const lockTarget = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { lodgeId: true },
      });
      if (!lockTarget) {
        return { error: "Booking not found", status: 404 as const };
      }

      // ADR-001 Security/safety: the two-sided hold rule must be lock-serialised.
      // Take the per-lodge capacity lock — the same key every admission and
      // capacity writer takes (acquireLodgeCapacityLock, booking-create.ts,
      // approveSchoolBookingRequest) — then re-read the mutable booking below.
      // This serialises a hold set against both admissions and date changes at
      // this lodge: either the other writer commits first and its current state
      // is consumed by the post-lock read, or this hold commits first and the
      // other writer observes it. Booking.lodgeId is immutable and NOT NULL.
      await acquireLodgeCapacityLock(tx, lockTarget.lodgeId);

      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          memberId: true,
          lodgeId: true,
          status: true,
          deletedAt: true,
          checkIn: true,
          checkOut: true,
          wholeLodgeHold: true,
          wholeLodgeHoldAt: true,
          wholeLodgeHoldByMemberId: true,
          // Inputs to bookingHoldsCapacity() (issue #173): the relation-based
          // #1254 PENDING-with-originBookingRequest rule and the #1764
          // PAYMENT_PENDING-with-adminCapacityHoldAt rule both live outside the
          // pure status check, so the guard below needs both signals.
          adminCapacityHoldAt: true,
          originBookingRequest: { select: { id: true } },
        },
      });
      if (!booking || booking.deletedAt) {
        return { error: "Booking not found", status: 404 as const };
      }

      if (hold && booking.wholeLodgeHold) {
        return {
          error: "This booking already has an exclusive whole-lodge hold.",
          status: 409 as const,
        };
      }
      if (!hold && !booking.wholeLodgeHold) {
        return {
          error: "This booking has no exclusive whole-lodge hold to clear.",
          status: 409 as const,
        };
      }

      // Status guard (issue #173, H2): only SETTING is gated — clearing must
      // never be blocked, so a stale hold on any status can always be cleaned
      // up. ADR-001's capacity rule (§ "Capacity rule", decision 1) hard-blocks
      // new admissions only where a *capacity-holding* booking overlapping a
      // night has wholeLodgeHold = true; every enforcement/masking index is
      // built from the capacity-holding population (capacityHoldingBookingFilter).
      // So a hold set on a non-capacity-holding booking (WAITLISTED / DRAFT /
      // generic PENDING / PAYMENT_PENDING without an admin hold) is never
      // consulted by enforcement: it blocks nothing while the route would return
      // success and the UI would show sole occupancy — false assurance. Reject
      // with 409 and no write/audit; the caller must first put the booking into a
      // capacity-holding state (bookingHoldsCapacity semantics: a holding status,
      // an accepted-quote PENDING with originBookingRequest #1254, or a
      // PAYMENT_PENDING with an admin capacity hold #1764).
      if (
        hold &&
        !bookingHoldsCapacity({
          status: booking.status,
          isRequestConverted: booking.originBookingRequest != null,
          hasAdminCapacityHold: booking.adminCapacityHoldAt != null,
        })
      ) {
        return {
          error:
            booking.status === BookingStatus.PAYMENT_PENDING
              ? "This booking is payment-pending and holds no lodge capacity, so an exclusive whole-lodge hold would block nothing. Apply an admin capacity hold first (Hold capacity), then set the exclusive hold."
              : "This booking does not hold lodge capacity, so an exclusive whole-lodge hold would block nothing while the calendar stays bookable. Only capacity-holding bookings (paid/confirmed, an accepted quote, or a payment-pending booking with an admin capacity hold) can take an exclusive hold.",
          status: 409 as const,
        };
      }

      // No capacity refusal (ADR-001 decision 1): the hold is settable over
      // existing overlapping bookings — the lock above serialises the write, it
      // never refuses. Mirror capacity-hold's clear semantics — null the
      // who/when audit columns when clearing.
      //
      // Compare-and-set on SET (issue #186, extends #173/#177): the per-lodge
      // lock serialises writers on THIS lodge's key, but a cancel path serialises
      // on the DISJOINT club-wide key — booking-cancel clears the hold via
      // RELEASE_WHOLE_LODGE_HOLD_UPDATE while never taking the per-lodge lock. So
      // a concurrent cancel can move the row to a terminal, non-capacity-holding
      // status between our post-lock read and our write; an unconditional
      // update-by-id would then plant an inert stale hold on a CANCELLED row.
      // Make the SET a conditional updateMany whose predicate re-checks
      // capacity-holding at write
      // time (the same filter capacity.ts composes). Either commit ordering then
      // converges: if the cancel wins the row no longer matches → zero rows → 409
      // and no audit; if the set wins the cancel's later hold-clear still lands.
      // CLEAR stays unconditional-by-id: clearing a stale hold on any status must
      // never be blocked (issue #173, H2).
      const heldAt = new Date();
      const writeResult = hold
        ? await tx.booking.updateMany({
            where: { id: booking.id, AND: [capacityHoldingBookingFilter()] },
            data: {
              wholeLodgeHold: true,
              wholeLodgeHoldAt: heldAt,
              wholeLodgeHoldByMemberId: session.user.id,
            },
          })
        : await tx.booking.updateMany({
            where: { id: booking.id },
            data: {
              wholeLodgeHold: false,
              wholeLodgeHoldAt: null,
              wholeLodgeHoldByMemberId: null,
            },
          });

      // Zero rows on SET means the CAS predicate no longer matched — a
      // concurrent writer moved the booking out of the capacity-holding
      // population after our guard read. Refuse with 409 and write NO audit;
      // nothing changed. (CLEAR always matches its id-only predicate for an
      // existing row, so this only trips on SET.)
      if (writeResult.count === 0) {
        return {
          error:
            "The booking changed while the hold was being set (it no longer holds capacity). Refresh and retry.",
          status: 409 as const,
        };
      }

      // ADR-001 bed-allocation short-circuit (#2285): a held booking owns NO
      // BedAllocation rows — it implicitly occupies the whole lodge. Reconcile
      // on BOTH toggle directions, on this same transaction, so the flag and
      // the allocation rows can never commit apart:
      // - SET: the lifecycle now treats the booking as held, so reconcile
      //   prunes every existing per-bed row (including legacy rows an older
      //   lifecycle wrongly created) and creates none.
      // - CLEAR: the booking is ordinary again, so reconcile re-plans its
      //   guests' missing bed-nights exactly like any other lifecycle change.
      // DB-only work (the same in-transaction pattern as force-confirm /
      // booking-cancel); no external provider is called here.
      //
      // Recoverability (#2285 review): the SET prune destroys rows an officer
      // may have placed by hand or approved, and a deleted row leaves no trace
      // of WHAT it was. Read the booking's rows first, on this same tx, and
      // record them compactly in the audit metadata below so the placement can
      // be reconstructed by hand if the hold turns out to have been a mistake.
      // Read-only and SET-only (a CLEAR destroys nothing).
      const prunedAllocations = hold
        ? await tx.bedAllocation.findMany({
            where: { bookingId: booking.id },
            select: {
              bookingGuestId: true,
              roomId: true,
              bedId: true,
              stayDate: true,
              source: true,
              approvedAt: true,
            },
            orderBy: [{ stayDate: "asc" }, { bedId: "asc" }],
            take: MAX_AUDITED_PRUNED_ALLOCATIONS + 1,
          })
        : [];

      const allocationReconcile = await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      // ADR-001 decision 1 conflict surfacing (issue #119): when SETTING the
      // hold, list the existing capacity-holding bookings that overlap its
      // nights so the officer sees the clash. Read-only and informational —
      // the set already succeeded above; nothing is refused or displaced. Never
      // runs the capacity engine (decision 1). On clear there is nothing to
      // surface. lodgeId is NOT NULL for real bookings; guard defensively.
      const holdingConflicts =
        hold && booking.lodgeId
          ? await findOverlappingCapacityHoldingBookings(tx, {
              lodgeId: booking.lodgeId,
              checkIn: booking.checkIn,
              checkOut: booking.checkOut,
              excludeBookingId: booking.id,
            })
          : [];

      // Override-settle blind spot (ADR-001 decision 1, issue #177): additionally
      // surface overlapping bookings that carry a persisted capacity override but
      // are NOT yet capacity-holding (chiefly overridden PAYMENT_PENDING). They
      // are invisible to the capacity-holding conflict read above, yet the
      // settlement carve-out (#1771, unchanged) will later admit them onto the
      // held nights — so the officer must see them now, marked `overridden`.
      // Never-refuse semantics unchanged: this is read-only and informational.
      const overriddenConflicts =
        hold && booking.lodgeId
          ? await findOverlappingOverriddenNonHoldingBookings(tx, {
              lodgeId: booking.lodgeId,
              checkIn: booking.checkIn,
              checkOut: booking.checkOut,
              excludeBookingId: booking.id,
            })
          : [];

      const conflicts = [...holdingConflicts, ...overriddenConflicts];

      await createAuditLog(
        {
          action: hold
            ? "booking.exclusiveHold.set"
            : "booking.exclusiveHold.cleared",
          memberId: session.user.id,
          actorMemberId: session.user.id,
          subjectMemberId: booking.memberId,
          targetId: booking.id,
          entityType: "Booking",
          entityId: booking.id,
          category: "booking",
          severity: "important",
          outcome: "success",
          summary: hold
            ? "Exclusive whole-lodge hold set"
            : "Exclusive whole-lodge hold cleared",
          details: hold
            ? "Admin set the exclusive whole-lodge hold on a booking; the lodge is reserved for sole occupancy and new admissions are blocked on its nights."
            : "Admin cleared the exclusive whole-lodge hold on a booking; the lodge is no longer reserved for sole occupancy.",
          metadata: {
            bookingStatus: booking.status,
            hold,
            checkIn: booking.checkIn.toISOString(),
            checkOut: booking.checkOut.toISOString(),
            // #2285: allocation reconcile on the hold toggle — rows pruned on
            // SET (held bookings own no per-bed rows), rows re-planned on
            // CLEAR. enabled=false means the bed-allocation module is off and
            // nothing was touched.
            bedAllocationReconcile: {
              enabled: allocationReconcile.enabled,
              deletedCount: allocationReconcile.deletedCount,
              createdCount: allocationReconcile.createdCount,
              promotedCount: allocationReconcile.promotedCount,
              // #2285 review: what the SET prune destroyed, compactly, so a
              // mistaken hold can be undone by hand. Only present when rows
              // were actually removed.
              ...(hold && allocationReconcile.deletedCount > 0
                ? {
                    removedAllocations: prunedAllocations
                      .slice(0, MAX_AUDITED_PRUNED_ALLOCATIONS)
                      .map((row) => ({
                        bookingGuestId: row.bookingGuestId,
                        roomId: row.roomId,
                        bedId: row.bedId,
                        stayDate: formatDateOnly(row.stayDate),
                        source: row.source,
                        approvedAt: row.approvedAt?.toISOString() ?? null,
                      })),
                    removedAllocationsTruncated:
                      prunedAllocations.length >
                      MAX_AUDITED_PRUNED_ALLOCATIONS,
                  }
                : {}),
            },
            ...(hold
              ? {
                  // Conflict surfacing (issue #119): record how many existing
                  // overlapping capacity-holding bookings the officer must
                  // resolve, plus their ids for the audit trail.
                  overlappingConflictCount: holdingConflicts.length,
                  overlappingConflictBookingIds: holdingConflicts.map((c) => c.id),
                  // Override-settle blind-spot surfacing (issue #177): the
                  // overridden-but-not-yet-holding overlaps recorded distinctly
                  // so the audit shows the officer was warned about the future
                  // settle onto the held nights.
                  overriddenNonHoldingConflictCount: overriddenConflicts.length,
                  overriddenNonHoldingConflictBookingIds: overriddenConflicts.map(
                    (c) => c.id,
                  ),
                }
              : {
                  previouslyHeldAt: booking.wholeLodgeHoldAt?.toISOString() ?? null,
                  previouslyHeldByMemberId: booking.wholeLodgeHoldByMemberId,
                }),
          },
          requestId: auditRequest?.id,
          ipAddress: auditRequest?.ipAddress,
          userAgent: auditRequest?.userAgent,
        },
        tx,
      );

      // updateMany returns only a count, so build the response from the values
      // we just wrote: SET stamped `heldAt`, CLEAR nulled the timestamp.
      return {
        success: true as const,
        wholeLodgeHold: hold,
        wholeLodgeHoldAt: hold ? heldAt : null,
        conflicts,
        // #2285 review: the toggle silently rewrote the booking's bed
        // assignments and told the officer nothing. Return the counts so the
        // UI can say what it did.
        bedAllocationReconcile: {
          enabled: allocationReconcile.enabled,
          deletedCount: allocationReconcile.deletedCount,
          createdCount: allocationReconcile.createdCount,
          promotedCount: allocationReconcile.promotedCount,
        },
      };
    });

    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({
      success: true,
      wholeLodgeHold: result.wholeLodgeHold,
      wholeLodgeHoldAt: result.wholeLodgeHoldAt,
      // Overlapping capacity-holding bookings the officer should resolve
      // (issue #119); empty on clear or when the held nights are clear.
      conflicts: result.conflicts,
      // What the toggle did to the booking's bed assignments (#2285): rows
      // removed on SET, rows re-planned on CLEAR, partners promoted either way.
      // `enabled: false` means the bed-allocation module is off and nothing was
      // touched. Surfaced in the admin toast so the change is never silent.
      bedAllocationReconcile: result.bedAllocationReconcile,
    });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to update exclusive whole-lodge hold");
    return NextResponse.json(
      { error: "Failed to update exclusive whole-lodge hold" },
      { status: 500 },
    );
  }
}
