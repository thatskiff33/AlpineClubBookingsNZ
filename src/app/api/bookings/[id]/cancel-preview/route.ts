import { CreditType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { loadCancellationPolicy } from "@/lib/cancellation";
import { calculateCancellationPreview } from "@/lib/policies/booking-route-decisions";
import { clubTime } from "@/lib/club-time/server";
import { paymentEligibleForPaidCancelPath } from "@/lib/booking-cancel";
import logger from "@/lib/logger";
import { hasAdminAccess } from "@/lib/access-roles";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";

/**
 * GET /api/bookings/[id]/cancel-preview
 * Returns the refund breakdown for a booking cancellation without actually cancelling.
 * Used by CancelBookingButton to show amounts before the user confirms.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }
    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return inactiveResponse;
    }

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: { payment: true },
    });

    if (!booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    // Issue #1313 (option A2): the owner, a Full Admin, or a Booking Officer
    // (bookings:edit) may see the refund breakdown — the read-only companion to
    // the cancel action, gated on the same bookings:edit predicate so a
    // read-only admin (bookings:view) still cannot preview a cancellation.
    if (
      booking.memberId !== session.user.id &&
      !hasAdminAccess(session.user) &&
      !hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status)) {
      return NextResponse.json(
        { error: "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be cancelled" },
        { status: 400 }
      );
    }

    // PENDING bookings — no payment taken. #1491: paid-path eligibility is
    // shared with cancelBooking (SUCCEEDED, or PARTIALLY_REFUNDED with a
    // captured ledger row) so the preview can never show $0 for a cancel
    // that would refund the policy tier of the remaining captured value —
    // or phantom money for the folded-mirror never-captured population.
    if (
      booking.status === "PENDING" ||
      !booking.payment ||
      !(await paymentEligibleForPaidCancelPath(booking.payment))
    ) {
      // #1547: the no-refund / never-captured executed path restores applied
      // credit at 100% (ledger truth, no override) — so the preview must show
      // the same figure or it would understate the outcome as $0. Derive it
      // straight from the ledger: Σ(−amountCents) over the booking's
      // BOOKING_APPLIED rows, floored at 0.
      const appliedAggregate = await prisma.memberCredit.aggregate({
        where: {
          appliedToBookingId: booking.id,
          type: CreditType.BOOKING_APPLIED,
        },
        _sum: { amountCents: true },
      });
      const creditRestoredCents = Math.max(
        0,
        -(appliedAggregate._sum.amountCents ?? 0)
      );

      return NextResponse.json({
        refundAmountCents: 0,
        keptAmountCents: 0,
        changeFeeCents: 0,
        refundPercentage: 0,
        creditRefundAmountCents: 0,
        creditRefundPercentage: 0,
        creditRestoredCents,
        totalPaidCents: 0,
        hasPayment: false,
        manualRefund: false,
      });
    }

    const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId);
    const preview = calculateCancellationPreview({
      payment: booking.payment,
      finalPriceCents: booking.finalPriceCents,
      checkIn: booking.checkIn,
      policyRules: policy,
      // #3123 — the CLUB's day, from its persisted zone, and the same authority
      // the executed cancel uses. The refund figure below is what the member is
      // shown before they confirm; a day resolved from the container's zone
      // instead could quote them a different tier from the one they are charged.
      // No transaction is open here, and this route is not reachable from a CLI
      // or from instrumentation, so the request-scoped `server-only` binding is
      // the right reader (`docs/CLUB_TIME_KERNEL.md`).
      todayAtClub: (await clubTime()).today(),
    });

    return NextResponse.json({
      ...preview,
      hasPayment: true,
      // B5 (#2262): this booking was settled in cash / by an off-Xero bank
      // transfer, so cancelling raises a hand-back task an admin pays by hand —
      // no card refund and no account credit. The FIGURES are unchanged (the
      // owner-decided tier for a manual settlement is the bank-transfer/credit
      // tier, which is what the executed cancel uses), so preview parity holds;
      // this flag only lets the dialog say honestly what will happen.
      manualRefund: booking.payment.manuallyMarkedPaidAt !== null,
    });
  } catch (error) {
    logger.error({ err: error }, "Error generating cancel preview");
    return NextResponse.json(
      { error: "Failed to generate cancellation preview" },
      { status: 500 }
    );
  }
}
