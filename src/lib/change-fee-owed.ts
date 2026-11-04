/**
 * #4661 (`INV-MOD-042`, `INV-PAY-119`): an edit's change fee on a booking whose
 * pay step is still ahead goes on the booking's amount owed.
 *
 * Every edit charges the change fee its policy sets (owner decision D8). A
 * booking with money captured collects it through the edit's own settlement
 * (`applyPaymentAdjustments`' settled arm). One still waiting to be paid - an
 * internet-banking booking whose invoice is out, or an open card attempt -
 * has no such arm, so the fee is recorded on its payment like a finished-stay
 * correction's ("Add fee to amount owed", #3750): every pay step collects it
 * through `bookingAmountOwedCents`, the primary invoice built later bills it
 * (`recordedChangeFeeCents`), an already-issued one is joined by the edit's own
 * supplementary invoice or credit note, and the settle posts its `CHANGE_FEE`
 * line under the edit's own key (`loadFeesAddedToAmountOwed`).
 */
import { BookingStatus } from "@prisma/client";

import { hasCapturedPayment, type BookingPaymentState } from "@/lib/booking-payment-state";
import { PAYMENT_OWED_BOOKING_STATUSES } from "@/lib/booking-status";

/** The statuses whose pay step is still ahead: held, awaiting payment, or invoiced and unpaid. */
const AWAITING_PAYMENT_STATUSES: ReadonlySet<string> = new Set<string>([
  BookingStatus.PENDING,
  ...PAYMENT_OWED_BOOKING_STATUSES,
]);

/**
 * Whether an edit's change fee on this booking goes on its amount owed. Needs
 * the payment row the fee is recorded on, and never a joiner the group
 * organiser settles, whose increases are billed to the organiser instead.
 */
export function changeFeeGoesOnAmountOwed(booking: {
  status: string;
  organiserSettled: boolean;
  payment: BookingPaymentState | null | undefined;
}): boolean {
  return (
    booking.payment != null &&
    !booking.organiserSettled &&
    AWAITING_PAYMENT_STATUSES.has(booking.status) &&
    !hasCapturedPayment(booking.payment)
  );
}

/** The `newData` path of an ordinary edit's marker; a finished-stay correction keeps its own (#3750). */
export const CHANGE_FEE_ADDED_TO_AMOUNT_OWED_PATH = ["changeFeeAddedToAmountOwed"] as const;

/** The `newData` field an edit writes when it added its fee to the amount owed, or none. */
export function changeFeeAddedToAmountOwedHistory(
  feeAddedCents: number,
): { changeFeeAddedToAmountOwed?: true } {
  return feeAddedCents > 0 ? { changeFeeAddedToAmountOwed: true } : {};
}
