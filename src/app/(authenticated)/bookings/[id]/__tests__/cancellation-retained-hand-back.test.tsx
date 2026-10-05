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
function cancelledMarkedPaid(manualRefundTasks: ReturnType<typeof handBack>[]) {
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
    },
  };
}

function project(booking: ReturnType<typeof cancelledMarkedPaid>) {
  return resolveBookingDetailPayment({
    booking: booking as unknown as BookingDetailRecord,
    modules: { xeroIntegration: false, internetBankingPayments: false } as never,
    viewer: { canManageBooking: true, isBookingOwner: false, nonOwnerAdminViewer: true } as never,
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

  it("is paid less refunded, with no note, once the hand-back is completed", () => {
    const booking = cancelledMarkedPaid([handBack("COMPLETED", 6_000)]);
    const payment = project(booking);

    expect(payment.retainedAfterCancellationCents).toBe(9_000);
    expect(payment.handBackOwedAfterCancellationCents).toBe(0);
    const html = renderToStaticMarkup(
      <BookingCancellationOutcome
        booking={booking as unknown as BookingDetailRecord}
        money={money}
        payment={payment}
      />,
    );
    expect(html).not.toContain("still being paid back by hand");
  });
});
