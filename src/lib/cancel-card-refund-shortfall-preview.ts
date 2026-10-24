import "server-only";

import type { PaymentSource, PrismaClient } from "@prisma/client";

import { cancelRaisesCardShortfall, sizeCancelCardShortfall, sumHeadroomCents, type CancelCardRefundSplit } from "@/lib/cancel-card-refund-shortfall";
import { nonCardChargeHeadroom } from "@/lib/cancel-card-refund-shortfall-settle";
import { cancelRefundDisposition } from "@/lib/cancel-refund-method";
import { foldMirrorRefundIntoLedger } from "@/lib/mirror-refund-fold";
import { paidCancellationBranch } from "@/lib/paid-cancellation-event";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import {
  legacyBackfillRows,
  loadPaymentWithTransactions,
  planCardRefundFromLedger,
  refundHeadroomIncrementCents,
  type PaymentStore,
} from "@/lib/payment-transactions";

/**
 * #4119 (`INV-PAY-131`): the card refund plan a card cancel would freeze right
 * now, and its split, WITHOUT writing. The claim's steps, each from its one
 * home, in its order, on an in-memory copy of the payment's ledger:
 *
 * 1. a partly refunded mirror's unattributed refund is folded onto the captured
 *    rows (`foldMirrorRefundIntoLedger`, capped by `refundHeadroomIncrementCents`),
 *    in the claim's row order (`LEDGER_ROWS_OLDEST_FIRST`, through the loader);
 * 2. a pre-ledger payment's charges are read as its backfill would write them
 *    (`legacyBackfillRows`) - a GET must not write them, racing the cancel's own;
 * 3. the card plan is the claim's own planner (`planCardRefundFromLedger`);
 * 4. the rest is split by the non-card charges' headroom (`nonCardChargeHeadroom`,
 *    `sizeCancelCardShortfall`).
 *
 * So the preview and the cancel differ only if the payment's records move in
 * between. Null when the plan carries the whole refund.
 */
export async function previewCancelCardRefundSplit(
  db: PaymentStore,
  params: { paymentId: string; refundAmountCents: number },
): Promise<CancelCardRefundSplit | null> {
  const payment = await loadPaymentWithTransactions(db, params.paymentId);
  if (!payment) throw new Error("Payment not found");
  const rows = payment.transactions.map((row) => ({ ...row }));
  const captured = () => rows.filter((row) => isCapturedTransactionStatus(row.status));
  await foldMirrorRefundIntoLedger(payment, captured, (row, cents) => {
    const taken = refundHeadroomIncrementCents(row, cents);
    row.refundedAmountCents += taken;
    return taken;
  });
  // A backfilled row is the newest (inserted after every stored row, #4132); only the planned total is read here,
  // and it does not depend on the order.
  const lastSeq = rows.reduce((max, row) => Math.max(max, row.insertionSeq), 0);
  const ledger = [
    ...rows,
    ...legacyBackfillRows(payment).map((row, index) => ({
      ...row,
      id: `legacy-backfill-${index}`,
      createdAt: new Date(),
      insertionSeq: lastSeq + 1 + index,
    })),
  ];
  const { plannedAmountCents: plannedCardRefundCents } = planCardRefundFromLedger(ledger, params.refundAmountCents);
  return sizeCancelCardShortfall(
    { refundAmountCents: params.refundAmountCents, plannedCardRefundCents },
    () => sumHeadroomCents(nonCardChargeHeadroom(ledger.filter((row) => isCapturedTransactionStatus(row.status)))),
  );
}

/**
 * #4119 (`INV-PAY-131`): the cancel preview's card line, sized as the cancel
 * will size it. Since #4097 a card cancel refunds to the card only what its
 * card refund plan carries and owes the rest by hand, so a preview quoting the
 * policy's whole refund as "to card" promised more than the cancel sends.
 *
 * Asked only where the cancel raises those parts (`cancelRaisesCardShortfall`,
 * on the branch `paidCancellationBranch` gives the method the cancel would be
 * forced to, `cancelRefundDisposition`). Read in ONE read-only `RepeatableRead`
 * snapshot, so the payment's record and its ledger rows - two statements - are
 * read as of one moment; it takes no lock, writes nothing and calls no
 * provider. Advisory, like the rest of the preview: the cancel re-plans under
 * its locks.
 *
 * Returns `{ cardShortfall }` to spread into the preview's answer when the plan
 * is short, or nothing when the card carries the whole refund.
 */
export async function cancelPreviewCardShortfall(
  client: Pick<PrismaClient, "$transaction">,
  params: {
    payment: { id: string; source: PaymentSource | string | null; manuallyMarkedPaidAt: Date | null };
    /** The joiner's booking the group organiser paid by card (`organiserChildCancelBasis` answered). */
    organiserCard: boolean;
    /** #3949: the joiner's booking the group organiser paid by Internet Banking (`paidByOrganiserInternetBanking`). */
    organiserByBank: boolean;
    /** The preview's card-tier refund. */
    refundAmountCents: number;
  },
): Promise<{ cardShortfall?: CancelCardRefundSplit }> {
  const { payment, organiserCard, refundAmountCents } = params;
  // The cancel's own method and disposition (`cancelRefundDisposition`, #3949), so the preview asks this only where
  // the cancel raises the card's parts. The card is the method a preview asks about.
  const { refundMethod, manualDisposition } = cancelRefundDisposition({
    paymentSource: payment.source,
    organiserCard,
    organiserByBank: params.organiserByBank,
    manuallyMarkedPaid: Boolean(payment.manuallyMarkedPaidAt),
    requested: "card",
  });
  const branch = paidCancellationBranch({ manualDisposition, refundMethod, refundAmountCents });
  if (!cancelRaisesCardShortfall({ branch, organiserCard })) return {};
  const cardShortfall = await client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return previewCancelCardRefundSplit(tx, { paymentId: payment.id, refundAmountCents });
    },
    { isolationLevel: "RepeatableRead" },
  );
  return cardShortfall ? { cardShortfall } : {};
}
