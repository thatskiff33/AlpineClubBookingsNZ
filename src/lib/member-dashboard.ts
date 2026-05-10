import { isPaymentOwedBookingStatus } from "@/lib/booking-status";

export interface DashboardPaymentSnapshot {
  status: string;
  finalPriceCents: number;
  payment: {
    status: string;
    additionalAmountCents: number;
    additionalPaymentStatus: string | null;
  } | null;
}

export interface DashboardPaymentSummary {
  bookingCount: number;
  totalCents: number;
}

export function summarizeMemberPaymentOwed(
  bookings: DashboardPaymentSnapshot[]
): DashboardPaymentSummary {
  return bookings.reduce<DashboardPaymentSummary>(
    (summary, booking) => {
      let bookingOwedCents = 0;

      if (isPaymentOwedBookingStatus(booking.status) && booking.payment?.status !== "SUCCEEDED") {
        bookingOwedCents += booking.finalPriceCents;
      }

      if (
        booking.payment &&
        booking.payment.additionalAmountCents > 0 &&
        booking.payment.additionalPaymentStatus !== "SUCCEEDED"
      ) {
        bookingOwedCents += booking.payment.additionalAmountCents;
      }

      if (bookingOwedCents > 0) {
        summary.bookingCount += 1;
        summary.totalCents += bookingOwedCents;
      }

      return summary;
    },
    { bookingCount: 0, totalCents: 0 }
  );
}
