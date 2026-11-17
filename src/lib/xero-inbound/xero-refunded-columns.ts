/**
 * A PAYMENT'S REFUNDED COLUMNS FROM THE CENTS ITS XERO LINKS DECIDE (#4449,
 * `INV-SSOT`, `INV-PAY-126`): the one step after the shared decision
 * (`decideLinkedRefundedTotalCents`) that every writer of a refunded total
 * from Xero takes - the inbound recount, the kept settle and the note sync's
 * allocation write. In order:
 *
 * - clamped to 0 and to the payment's amount;
 * - a bank transfer is held at its own refund detail (`bankTransferFloorCents`,
 *   `INV-ADDPAY-021`), the alert returned, never sent, so a writer inside a
 *   transaction sends it after its commit; any other source passes through;
 * - the status, from the status the writer leaves the payment in, by the one
 *   refunded-total status rule (`refundedTotalStatus`: a total falling to
 *   nothing on a payment never captured returns it to its uncaptured state,
 *   #3979), except that a total falling to nothing never un-refunds a card
 *   payment (F5, #1353).
 *
 * A card payment's raise-only floor and organiser-child cap move cents the
 * recount alone decides; it applies them to `decidedCents` before this step.
 * Reads on the caller's client; writes nothing and takes no lock.
 */
import { PaymentSource, PaymentStatus, type Prisma } from "@prisma/client";
import { type BankTransferFloorAlert, bankTransferFloorCents } from "./credit-note-bank-transfer-floor";
import { refundedTotalStatus } from "./modification-note-refunds";

export type XeroRefundedColumns = {
  refundedAmountCents: number;
  /** Null: the status stays as the writer leaves it. */
  status: PaymentStatus | null;
  floorAlert: BankTransferFloorAlert | null;
};

export async function decideXeroRefundedColumns(
  store: Prisma.TransactionClient,
  input: {
    /** `status` is the one the writer leaves the payment in (the kept settle: SUCCEEDED, as it captures). */
    /** `booking` is read only when a total falls to nothing on a refunded payment (`refundedTotalStatus`). */
    payment: {
      id: string;
      bookingId: string;
      source: PaymentSource;
      amountCents: number;
      refundedAmountCents: number;
      status: PaymentStatus;
      booking: { organiserSettled: boolean };
    };
    /** The links' figure: `decideLinkedRefundedTotalCents`, plus a recount's note being synced and its card-only rules. */
    decidedCents: number;
    creditNoteId: string | null;
    creditNoteNumber?: string | null;
  },
): Promise<XeroRefundedColumns> {
  const { payment } = input;
  const clamped = Math.min(Math.max(input.decidedCents, 0), payment.amountCents);
  const floored = await bankTransferFloorCents(store, {
    payment,
    xeroDerivedCents: clamped,
    creditNoteId: input.creditNoteId,
    creditNoteNumber: input.creditNoteNumber ?? null,
  });
  const unrefundsCardPayment =
    payment.source === PaymentSource.STRIPE &&
    floored.cents <= 0 &&
    (payment.status === PaymentStatus.REFUNDED || payment.status === PaymentStatus.PARTIALLY_REFUNDED);
  const status = unrefundsCardPayment ? null : await refundedTotalStatus(payment, floored.cents, store);
  return { refundedAmountCents: floored.cents, status, floorAlert: floored.alert };
}
