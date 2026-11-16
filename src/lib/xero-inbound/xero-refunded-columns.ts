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
 * - the status the total implies (`getNextRefundedPaymentStatus`) from the
 *   status the writer leaves the payment in. A total falling to nothing never
 *   un-refunds a card payment (F5, #1353), and on any other payment never
 *   captured returns it to its uncaptured state (`uncapturedPrimaryStatus`,
 *   #3979), never SUCCEEDED, unless it is an organiser-settled child (#3653).
 *
 * A card payment's raise-only floor and organiser-child cap move cents the
 * recount alone decides; it applies them to `decidedCents` before this step.
 * Reads on the caller's client; writes nothing and takes no lock.
 */
import { PaymentSource, PaymentStatus, type Prisma } from "@prisma/client";
import { getNextRefundedPaymentStatus } from "./amounts";
import { type BankTransferFloorAlert, bankTransferFloorCents } from "./credit-note-bank-transfer-floor";
import { uncapturedPrimaryStatus } from "./modification-note-refunds";

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
    payment: { id: string; bookingId: string; source: PaymentSource; amountCents: number; refundedAmountCents: number; status: PaymentStatus };
    /** Asked only when a total falls to nothing on a refunded payment, as the recount always asked it. */
    isOrganiserSettled: () => boolean;
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
  let status = getNextRefundedPaymentStatus(payment.status, payment.amountCents, floored.cents);
  if (status === PaymentStatus.SUCCEEDED && (payment.status === PaymentStatus.REFUNDED || payment.status === PaymentStatus.PARTIALLY_REFUNDED)) {
    if (payment.source === PaymentSource.STRIPE) {
      status = null;
    } else if (!input.isOrganiserSettled()) {
      status = (await uncapturedPrimaryStatus(payment.id, store)) ?? status;
    }
  }
  return { refundedAmountCents: floored.cents, status, floorAlert: floored.alert };
}
