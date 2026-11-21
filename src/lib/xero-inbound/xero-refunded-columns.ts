/**
 * A PAYMENT'S REFUNDED COLUMNS FROM THE CENTS ITS XERO LINKS DECIDE (#4449,
 * `INV-SSOT`, `INV-PAY-126`): the one step after the shared decision
 * (`decideLinkedRefundedTotalCents`) that every writer of a refunded total
 * from Xero takes - the inbound recount, the kept settle, the note sync's
 * allocation write and (#5289 B) the outbound allocation completion. In order:
 *
 * - the Xero-derived figure is clamped to 0 and to the payment's amount, and
 *   only that figure (#5289 E, owner decision D3, the rule before #4449);
 * - a card payment's ledger is never lowered by it: the raise-only floor (F5,
 *   #1353) keeps the stored total, logged at warn, its `refund-ledger-divergence`
 *   alert returned, then (#3653, `INV-PAY-114`) an organiser child's mirror is
 *   capped at the refunds Stripe recorded for it. Nothing clamps after the floor,
 *   so a card total stored above the payment's amount stays as stored;
 * - a bank transfer is held at its own refund detail plus the corrections the
 *   links count (`bankTransferFloorCents`, `INV-ADDPAY-021`);
 * - the status, from the status the writer leaves the payment in, by the one
 *   refunded-total status rule (`refundedTotalStatus`: a total falling to
 *   nothing on a payment never captured returns it to its uncaptured state,
 *   #3979), except that a total falling to nothing never un-refunds a card
 *   payment (F5, #1353).
 *
 * Both floors' alerts are returned, never sent, so a writer inside a
 * transaction sends them after its commit. Reads on the caller's client;
 * writes nothing and takes no lock.
 */
import { PaymentSource, PaymentStatus, type Prisma } from "@prisma/client";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { capOrganiserChildMirrorAtStripeRefunds } from "@/lib/organiser-child-refund";
import { formatCents } from "@/lib/utils";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import { type BankTransferFloorAlert, bankTransferFloorCents } from "./credit-note-bank-transfer-floor";
import { refundedTotalStatus } from "./modification-note-refunds";

/** F5 (#1353): the card ledger kept above what Xero shows, for the writer to alert after its commit. */
export type CardLedgerFloorAlert = { paymentId: string; creditNoteId: string | null; xeroDerivedCents: number; ledgerCents: number };

export type XeroRefundedColumns = {
  refundedAmountCents: number;
  /** Null: the status stays as the writer leaves it. */
  status: PaymentStatus | null;
  floorAlert: BankTransferFloorAlert | null;
  /** #5289 E: a card ledger the raise-only floor kept above the Xero-derived figure. */
  cardFloorAlert: CardLedgerFloorAlert | null;
};

export async function decideXeroRefundedColumns(
  store: Prisma.TransactionClient,
  input: {
    /** `status` is the one the writer leaves the payment in (the kept settle: SUCCEEDED, as it captures). */
    /** `booking` is read only when a total falls to nothing on a refunded payment (`refundedTotalStatus`), or to cap an organiser child. */
    payment: {
      id: string;
      bookingId: string;
      source: PaymentSource;
      amountCents: number;
      refundedAmountCents: number;
      status: PaymentStatus;
      booking: { organiserSettled: boolean };
    };
    /** The links' figure: `decideLinkedRefundedTotalCents`, plus a recount's note being synced. */
    decidedCents: number;
    /** #5289 D: the invoice corrections in `decidedCents` (`LinkedRefundedTotal.correctionCents`), which the bank-transfer floor adds to the detail. */
    correctionCents?: number;
    creditNoteId: string | null;
    creditNoteNumber?: string | null;
  },
): Promise<XeroRefundedColumns> {
  const { payment } = input;
  const clamped = Math.min(Math.max(input.decidedCents, 0), payment.amountCents);
  let cents = clamped;
  let cardFloorAlert: CardLedgerFloorAlert | null = null;
  if (payment.source === PaymentSource.STRIPE) {
    // F5 (#1353): Stripe is the card ledger's truth. A lower Xero figure is a missing
    // refund-delta note or a note voided after Stripe paid out: kept, logged and alerted.
    if (clamped < payment.refundedAmountCents) {
      logger.warn(
        { creditNoteId: input.creditNoteId, paymentId: payment.id, localRefundedAmountCents: payment.refundedAmountCents, xeroDerivedRefundedTotalCents: clamped },
        "Xero-derived refund total is below the local Stripe refund ledger; keeping the local ledger (raise-only floor)",
      );
      cardFloorAlert = { paymentId: payment.id, creditNoteId: input.creditNoteId, xeroDerivedCents: clamped, ledgerCents: payment.refundedAmountCents };
      cents = payment.refundedAmountCents;
    }
    // #3653 (`INV-PAY-114`): a Xero note never raises an organiser child's cash mirror past the refunds Stripe recorded for it.
    if (payment.booking.organiserSettled) cents = await capOrganiserChildMirrorAtStripeRefunds(store, payment, cents);
  }
  const floored = await bankTransferFloorCents(store, {
    payment,
    xeroDerivedCents: cents,
    correctionCents: input.correctionCents ?? 0,
    creditNoteId: input.creditNoteId,
    creditNoteNumber: input.creditNoteNumber ?? null,
  });
  const unrefundsCardPayment =
    payment.source === PaymentSource.STRIPE &&
    floored.cents <= 0 &&
    (payment.status === PaymentStatus.REFUNDED || payment.status === PaymentStatus.PARTIALLY_REFUNDED);
  const status = unrefundsCardPayment ? null : await refundedTotalStatus(payment, floored.cents, store);
  return { refundedAmountCents: floored.cents, status, floorAlert: floored.alert, cardFloorAlert };
}

/** F5 (#1353): the raise-only floor's alert, sent outside any transaction. */
export async function sendCardLedgerFloorAlert(alert: CardLedgerFloorAlert, format: ClubFormat): Promise<void> {
  await notifyXeroSyncError({
    errorType: "refund-ledger-divergence",
    operation: `inbound-credit-note-repair:${alert.creditNoteId ?? `recount:${alert.paymentId}`}`,
    errorMessage: `Xero-derived refund total (${formatCents(alert.xeroDerivedCents, format)}) for payment ${alert.paymentId} is below the local Stripe refund ledger (${formatCents(alert.ledgerCents, format)}). The local ledger was kept (raise-only floor, #1353). Likely causes: a missing refund-delta credit note in Xero, or a refund credit note voided in Xero after Stripe paid the refund out.`,
  });
}
