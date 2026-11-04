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
 *
 * #4735: a card booking has no payment row until its pay step mints an intent,
 * so an edit before then opens one carrying only the fee
 * (`recordFeeOnNewPayment`), the shape a finished-stay correction already
 * writes. Every pay step refreshes that row's amount and keeps its fee, so the
 * fee is collected once, through the same amount-owed read.
 */
import { BookingStatus } from "@prisma/client";

import { hasCapturedPayment, type BookingPaymentState } from "@/lib/booking-payment-state";
import { PAYMENT_OWED_BOOKING_STATUSES } from "@/lib/booking-status";
import type { PrismaTransactionClient } from "@/lib/db-transaction";

/** The statuses whose pay step is still ahead: held, awaiting payment, or invoiced and unpaid. */
const AWAITING_PAYMENT_STATUSES: ReadonlySet<string> = new Set<string>([
  BookingStatus.PENDING,
  ...PAYMENT_OWED_BOOKING_STATUSES,
]);

/**
 * #4735: the statuses of a card booking whose pay step is still ahead - held
 * for its saved card, or awaiting payment. With no payment row, these are the
 * bookings a fee-only row is opened for. An unpaid CONFIRMED booking with no
 * row (a whole-lodge approval, #4019) is not: it is recognised as unpaid by
 * having no row (`isUnpaidConfirmedWholeLodge`), which a fee-only row would hide.
 */
const CARD_PAY_STEP_AHEAD_STATUSES: ReadonlySet<string> = new Set<string>([
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
]);

/**
 * Whether an edit's change fee on this booking goes on its amount owed. Never
 * a joiner the group organiser settles, whose increases are billed to the
 * organiser instead. With no payment row, only a card booking still at its pay
 * step (#4735), which the fee opens a row for.
 */
export function changeFeeGoesOnAmountOwed(booking: {
  status: string;
  organiserSettled: boolean;
  payment: BookingPaymentState | null | undefined;
}): boolean {
  if (booking.organiserSettled) return false;
  if (booking.payment == null) return CARD_PAY_STEP_AHEAD_STATUSES.has(booking.status);
  return AWAITING_PAYMENT_STATUSES.has(booking.status) && !hasCapturedPayment(booking.payment);
}

/**
 * Records a fee owed by a booking that has no payment row yet, on a new row
 * carrying only the fee until its pay step fills in the rest (#3750, #4735).
 * An upsert, so a row a pay step opened without the edit's locks (the saved
 * card's setup intent) takes the fee rather than failing the edit.
 */
export async function recordFeeOnNewPayment(
  tx: PrismaTransactionClient,
  input: { bookingId: string; changeFeeCents: number },
): Promise<void> {
  await tx.payment.upsert({
    where: { bookingId: input.bookingId },
    create: { bookingId: input.bookingId, amountCents: 0, changeFeeCents: input.changeFeeCents },
    update: { changeFeeCents: { increment: input.changeFeeCents } },
  });
}

/** The `newData` path of an ordinary edit's marker; a finished-stay correction keeps its own (#3750). */
export const CHANGE_FEE_ADDED_TO_AMOUNT_OWED_PATH = ["changeFeeAddedToAmountOwed"] as const;

/** The `newData` field an edit writes when it added its fee to the amount owed, or none. */
export function changeFeeAddedToAmountOwedHistory(
  feeAddedCents: number,
): { changeFeeAddedToAmountOwed?: true } {
  return feeAddedCents > 0 ? { changeFeeAddedToAmountOwed: true } : {};
}
