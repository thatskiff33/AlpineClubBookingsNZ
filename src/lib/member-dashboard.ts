import { outstandingAdditionalAskCents } from "@/lib/additional-payment-ask";
import { readBookingAmountOwed } from "@/lib/booking-amount-owed";
import { isPaymentOwedBookingStatus } from "@/lib/booking-status";

interface DashboardPaymentAsk {
  status: string;
  additionalAmountCents: number;
  additionalPaymentStatus: string | null;
}

/** A payment-owed booking row as the dashboard reads it from the database. */
export interface DashboardPaymentRow {
  id: string;
  status: string;
  finalPriceCents: number;
  payment: (DashboardPaymentAsk & { changeFeeCents: number | null }) | null;
}

export interface DashboardPaymentSnapshot {
  id: string;
  status: string;
  /**
   * What the booking itself still asks the member to pay: `readBookingAmountOwed`'s
   * floored `dueCents` (price plus recorded change fee, less ledger credit), so
   * the card quotes the booking page's Amount due. Zero when the booking is not
   * payment-owed or its payment has succeeded.
   */
  amountDueCents: number;
  payment: DashboardPaymentAsk | null;
}

export interface DashboardPaymentSummary {
  /** The bookings that owe something, so the card's count and link agree. */
  bookingIds: string[];
  totalCents: number;
}

// The booking's own amount is still owed: a payment-owed status and no
// successful payment. A bank-transfer booking counts — its member still owes
// the transfer.
function bookingAmountIsOwed(booking: {
  status: string;
  payment: { status: string } | null;
}) {
  return (
    isPaymentOwedBookingStatus(booking.status) &&
    booking.payment?.status !== "SUCCEEDED"
  );
}

/**
 * #4944 (`INV-PAY-119`): reads what each payment-owed booking still owes
 * through `readBookingAmountOwed`, the one read the booking page and the card
 * intent share, so the dashboard's Payment Owed card cannot quote a different
 * figure. The floored `dueCents`, never `owedCents`: credit beyond one
 * booking's worth must not lower the total for the member's others.
 */
export async function loadDashboardPaymentSnapshots(
  rows: readonly DashboardPaymentRow[],
): Promise<DashboardPaymentSnapshot[]> {
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      status: row.status,
      amountDueCents: bookingAmountIsOwed(row)
        ? (await readBookingAmountOwed(row)).dueCents
        : 0,
      payment: row.payment,
    })),
  );
}

export function getDashboardPaymentOwedCents(booking: DashboardPaymentSnapshot) {
  let owedCents = 0;

  if (bookingAmountIsOwed(booking)) {
    owedCents += booking.amountDueCents;
  }

  // #3340 (`INV-SSOT-001`): the unpaid balance of an extra is read through the
  // one function that knows what "still owed" means, not restated here. This was
  // a hand-written copy of the same two conditions, and a copy is how the
  // member's dashboard total comes to disagree with the chase and with the ask.
  owedCents += outstandingAdditionalAskCents(booking.payment);

  return owedCents;
}

export function summarizeMemberPaymentOwed(
  bookings: DashboardPaymentSnapshot[],
): DashboardPaymentSummary {
  return bookings.reduce<DashboardPaymentSummary>(
    (summary, booking) => {
      const owedCents = getDashboardPaymentOwedCents(booking);

      if (owedCents > 0) {
        summary.bookingIds.push(booking.id);
        summary.totalCents += owedCents;
      }

      return summary;
    },
    { bookingIds: [], totalCents: 0 },
  );
}
