// #3811 (owner review: a cancelled booking counts only money the club kept; the
// owner's decision on #3372, 3 Oct 2026: an open hand-back refund is subtracted
// straight away). The booking detail's "Non-refundable amount retained" line is
// that booking's cash part of Net Collected (`getNetCollectedCashParts`), so it
// can never read higher than what Net Collected counts for the same booking.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BookingCancellationOutcome } from "@/app/(authenticated)/bookings/[id]/_components/booking-cancellation-outcome";
import { resolveBookingDetailPayment } from "@/app/(authenticated)/bookings/[id]/_lib/booking-detail-payment";
import type { BookingDetailRecord } from "@/app/(authenticated)/bookings/[id]/_lib/load-booking-detail";
import { bindClubFormat } from "@/lib/club-format-bound";
import { summarizeCollectedCash } from "@/lib/payment-net-collected";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const money = bindClubFormat(CLUB_FORMAT_TEST);

const handBack = (status: string, amountCents: number) => ({
  status,
  kind: "CANCELLED_BOOKING_HAND_BACK",
  amountCents,
  partPaymentReviewPaymentId: null,
});

// A cancelled booking marked paid by hand for $100.00 (Internet Banking, one
// captured ledger row), $10.00 of it already refunded, whose $60.00 hand-back
// refund is still an OPEN officer task.
function cancelledMarkedPaid(
  manualRefundTasks: ReturnType<typeof handBack>[],
  payment: Partial<{ status: string; refundedAmountCents: number; _count: { transactions: number } }> = {},
) {
  return {
    id: "b-cancelled",
    status: "CANCELLED",
    deletedAt: null,
    finalPriceCents: 10_000,
    organiserSettled: false,
    parentBooking: null,
    refundRequests: [],
    creditsApplied: [],
    creditsFromCancellation: [],
    manualRefundTasks,
    payment: {
      status: "PARTIALLY_REFUNDED",
      source: "INTERNET_BANKING",
      amountCents: 10_000,
      refundedAmountCents: 1_000,
      creditAppliedCents: 0,
      changeFeeCents: 0,
      _count: { transactions: 1 },
      recoveryOperations: [],
      refunds: [],
      ...payment,
    },
  };
}

const OFFICER = { canManageBooking: true, isBookingOwner: false, nonOwnerAdminViewer: true };
const OWNER = { canManageBooking: true, isBookingOwner: true, nonOwnerAdminViewer: false };
// A guest on the booking viewing it read-only (`isLinkedGuestViewer`).
const LINKED_GUEST = { canManageBooking: false, isBookingOwner: false, nonOwnerAdminViewer: false };

function project(booking: ReturnType<typeof cancelledMarkedPaid>, viewer = OFFICER) {
  return resolveBookingDetailPayment({
    booking: booking as unknown as BookingDetailRecord,
    modules: { xeroIntegration: false, internetBankingPayments: false } as never,
    viewer: viewer as never,
    access: { isDeleted: false } as never,
    party: { hasProvisionalChildren: false, isProvisionalChild: false, isFlaggedProvisional: false } as never,
  });
}

describe("the cancellation outcome's retained line (#3811)", () => {
  it("is paid less refunded less an open hand-back, and never above Net Collected", () => {
    const booking = cancelledMarkedPaid([handBack("OPEN", 6_000)]);
    const payment = project(booking);

    // 100 - 10 - 60 = 30.
    expect(payment.retainedAfterCancellationCents).toBe(3_000);
    expect(payment.handBackOwedAfterCancellationCents).toBe(6_000);
    expect(
      summarizeCollectedCash([{ ...booking.payment, booking }]).netCollectedCents,
    ).toBe(payment.retainedAfterCancellationCents);

    const html = renderToStaticMarkup(
      <BookingCancellationOutcome
        booking={booking as unknown as BookingDetailRecord}
        money={money}
        payment={payment}
      />,
    );
    expect(html).toContain("Non-refundable amount retained:");
    expect(html).toContain("$30.00");
    expect(html).toContain("(after $60.00 still being paid back by hand)");
  });

  it("holds steady through completion: the refund lands in refundedAmountCents and the note goes", () => {
    // Completing the task raises `refundedAmountCents` by what was handed back
    // (`manual-refund-task-resolution.ts`): $10.00 + $60.00 = $70.00.
    const booking = cancelledMarkedPaid([handBack("COMPLETED", 6_000)], {
      refundedAmountCents: 7_000,
    });
    const payment = project(booking);

    expect(payment.retainedAfterCancellationCents).toBe(3_000);
    expect(payment.handBackOwedAfterCancellationCents).toBe(0);
    const html = renderToStaticMarkup(
      <BookingCancellationOutcome
        booking={booking as unknown as BookingDetailRecord}
        money={money}
        payment={payment}
      />,
    );
    expect(html).toContain("$30.00");
    expect(html).not.toContain("still being paid back by hand");
  });

  it("shows the hand-back note to the booker and officers, never to a linked guest", () => {
    const booking = cancelledMarkedPaid([handBack("OPEN", 6_000)]);
    const render = (viewer: typeof OFFICER) =>
      renderToStaticMarkup(
        <BookingCancellationOutcome
          booking={booking as unknown as BookingDetailRecord}
          money={money}
          payment={project(booking, viewer)}
        />,
      );
    expect(render(OWNER)).toContain("(after $60.00 still being paid back by hand)");
    expect(render(OFFICER)).toContain("(after $60.00 still being paid back by hand)");
    const guest = render(LINKED_GUEST);
    expect(guest).not.toContain("still being paid back by hand");
    // The figure itself is the same for everyone.
    expect(project(booking, LINKED_GUEST).retainedAfterCancellationCents).toBe(3_000);
  });

  it("does not show a never-paid payment folded to PARTIALLY_REFUNDED as an original payment", () => {
    // An Internet Banking payment never paid: a Xero credit note folded into
    // its mirror marks it PARTIALLY_REFUNDED, but no captured ledger row exists.
    const booking = cancelledMarkedPaid([], { _count: { transactions: 0 } });
    const payment = project(booking);

    expect(payment.originalPaymentCaptured).toBe(false);
    expect(payment.retainedAfterCancellationCents).toBe(0);
    const html = renderToStaticMarkup(
      <BookingCancellationOutcome
        booking={booking as unknown as BookingDetailRecord}
        money={money}
        payment={payment}
      />,
    );
    expect(html).toContain("No original payment captured");
    expect(html).not.toContain("$100.00");
    expect(html).not.toContain("Non-refundable amount retained:");

    // With its captured ledger row it is a real payment again.
    expect(project(cancelledMarkedPaid([])).originalPaymentCaptured).toBe(true);
  });
});
