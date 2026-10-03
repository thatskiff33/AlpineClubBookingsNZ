/**
 * Has this Internet-Banking payment's CURRENT invoice been paid? Answered from
 * durable settlement evidence, never from the aggregate `Payment.status` mirror
 * (#3632, `INV-PAY-018`).
 *
 * The mirror is not cash evidence on an Internet-Banking payment: the inbound
 * Xero reconcile folds invoice-applied modification credit notes into it, so a
 * payment that never received a cent can read REFUNDED or PARTIALLY_REFUNDED.
 * Two writers do leave evidence:
 *
 * - the Xero invoice-paid reconcile (`xero-inbound/invoice-paid-effects.ts`)
 *   marks or mints the Internet-Banking PRIMARY transaction SUCCEEDED and stamps
 *   it with the invoice it paid; and
 * - the manual cash / off-Xero settlement stamps `manuallyMarkedPaidAt`
 *   (`INV-PAY-001`, whose provenance predicate is that column alone) and mints a
 *   PRIMARY transaction that names no invoice.
 *
 * A captured Stripe PRIMARY (a card-origin payment later switched to bank
 * transfer) or a captured ADDITIONAL row proves money moved for something else,
 * not that this invoice was paid. The receipt must also name the payment's
 * current invoice: a receipt for a superseded invoice does not prove the
 * current one was paid. Every miss reads "unverified", deliberately not
 * "unpaid" — legacy rows written before the ledger carry no transaction at all,
 * so absence of evidence is only that.
 *
 * A pure leaf: no client, no logger, so a census or an audit can import it.
 */
import {
  PaymentSource,
  PaymentTransactionKind,
  type PaymentStatus,
  type Prisma,
} from "@prisma/client";

import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";

export type InternetBankingSettlementEvidence =
  | "xero-primary-receipt"
  | "manual-settlement"
  | "unverified";

export interface InternetBankingSettlementEvidenceInput {
  /** The invoice the current Internet-Banking PRIMARY receipt must name. */
  xeroInvoiceId: string | null;
  /** Durable manual-settlement provenance (`INV-PAY-001`). */
  manuallyMarkedPaidAt: Date | null;
  transactions: ReadonlyArray<{
    status: PaymentStatus;
    source: PaymentSource;
    kind: PaymentTransactionKind;
    xeroInvoiceId: string | null;
  }>;
}

/** The `Payment` columns the classification reads, for a Prisma `select`. */
export const INTERNET_BANKING_SETTLEMENT_EVIDENCE_SELECT = {
  xeroInvoiceId: true,
  manuallyMarkedPaidAt: true,
  transactions: {
    select: { status: true, source: true, kind: true, xeroInvoiceId: true },
  },
} as const satisfies Prisma.PaymentSelect;

export function internetBankingSettlementEvidence(
  payment: InternetBankingSettlementEvidenceInput,
): InternetBankingSettlementEvidence {
  if (payment.manuallyMarkedPaidAt) return "manual-settlement";
  const currentInvoiceId = payment.xeroInvoiceId;
  if (currentInvoiceId === null) return "unverified";
  return payment.transactions.some(
    (transaction) =>
      transaction.source === PaymentSource.INTERNET_BANKING &&
      transaction.kind === PaymentTransactionKind.PRIMARY &&
      transaction.xeroInvoiceId === currentInvoiceId &&
      isCapturedTransactionStatus(transaction.status),
  )
    ? "xero-primary-receipt"
    : "unverified";
}
