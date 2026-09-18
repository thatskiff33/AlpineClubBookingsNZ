import { outstandingAdditionalAskCents } from "@/lib/additional-payment-ask";
import { isPaymentOwedBookingStatus } from "@/lib/booking-status";

export interface DashboardPaymentSnapshot {
  id: string;
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

export function getDashboardPaymentOwedCents(booking: DashboardPaymentSnapshot) {
  let owedCents = 0;

  if (
    isPaymentOwedBookingStatus(booking.status) &&
    booking.payment?.status !== "SUCCEEDED"
  ) {
    owedCents += booking.finalPriceCents;
  }

  // #3340 (`INV-SSOT-001`): the unpaid balance of an extra is read through the
  // one function that knows what "still owed" means, not restated here. This was
  // a hand-written copy of the same two conditions, and a copy is how the
  // member's dashboard total comes to disagree with the chase and with the ask.
  owedCents += outstandingAdditionalAskCents(booking.payment);

  return owedCents;
}

export function isDashboardPaymentOwed(booking: DashboardPaymentSnapshot) {
  return getDashboardPaymentOwedCents(booking) > 0;
}

export function summarizeMemberPaymentOwed(
  bookings: DashboardPaymentSnapshot[],
): DashboardPaymentSummary {
  return bookings.reduce<DashboardPaymentSummary>(
    (summary, booking) => {
      const owedCents = getDashboardPaymentOwedCents(booking);

      if (owedCents > 0) {
        summary.bookingCount += 1;
        summary.totalCents += owedCents;
      }

      return summary;
    },
    { bookingCount: 0, totalCents: 0 },
  );
}
