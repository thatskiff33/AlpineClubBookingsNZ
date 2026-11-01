import "server-only";

import type { Prisma } from "@prisma/client";
import { PaymentTransactionKind } from "@prisma/client";

import { planCreditReleasePayments, type AskLedgerRow } from "@/lib/credit-release-payment-plan";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { prisma } from "@/lib/prisma";

/**
 * HOW MUCH OF ONE CARD CAPTURE THE CREDIT-RELEASE SWEEP RECORDS (#4253,
 * `INV-ADDPAY-046`), so the capture's receipt writer records only the rest.
 *
 * Three writers could otherwise record the same card payment: the sweep
 * (`credit-release-xero-payment.ts`), the additional-capture receipt and the
 * #3980 gap invoice, which pays itself from spare captured cash
 * (`additional-capture-recorder.ts`, #4494). All derive the share from the same
 * ledger chain, so they cannot disagree about it and none depends on another
 * having run. `held` means the sweep will not record this capture and an
 * officer has been told: the receipt stands down too, and the gap invoice treats
 * all of it as taken, rather than record a payment that may include money
 * nobody has worked out.
 */
export type CreditReleaseCaptureShare = { ownCents: number; held: boolean };

export async function readCreditReleaseCaptureShare(
  paymentIntentId: string,
  store: Pick<Prisma.TransactionClient, "paymentTransaction"> = prisma,
): Promise<CreditReleaseCaptureShare> {
  const capture = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { paymentId: true },
  });
  if (!capture) return { ownCents: 0, held: false };
  const rows = await store.paymentTransaction.findMany({
    where: { paymentId: capture.paymentId, kind: PaymentTransactionKind.ADDITIONAL },
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: {
      id: true,
      source: true,
      status: true,
      reason: true,
      amountCents: true,
      carriedAskCents: true,
      withdrawnAt: true,
      stripePaymentIntentId: true,
    },
  });
  const plan = planCreditReleasePayments(rows as AskLedgerRow[]);
  return {
    ownCents: plan.items
      .filter((item) => item.capturedByIntentId === paymentIntentId)
      .reduce((sum, item) => sum + item.ownCents, 0),
    held: plan.unexplainedCaptureIntentIds.includes(paymentIntentId),
  };
}

/**
 * #4494 (`INV-SSOT`): the cents of a capture's NET cash that are the sweep's, so
 * the gap invoice never pays itself from them: all of it where the sweep holds
 * the capture, else its own share, never more than the capture holds.
 */
export function creditReleaseSweptCents(share: CreditReleaseCaptureShare, netCents: number): number {
  const net = Math.max(0, netCents);
  return share.held ? net : Math.min(Math.max(0, share.ownCents), net);
}
