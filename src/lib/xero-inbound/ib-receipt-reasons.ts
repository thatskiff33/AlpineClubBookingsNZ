/**
 * What a bank-transfer PRIMARY receipt's `reason` says about its figure
 * (#3979, `INV-PAY-125`, `INV-PAY-126`): recorded from the invoice's cash, or
 * at the stored figure the payment was born with. A leaf, read by the inbound
 * settle (`settle-from-cash.ts`), the refunded-total decision
 * (`linked-refunded-total.ts`) and the Xero repair tool, so none of them
 * imports another for it.
 */
import { PaymentSource, PaymentTransactionKind, type PaymentStatus } from "@prisma/client";
import { isCapturedTransactionStatus, LEGACY_PRIMARY_BACKFILL_REASON } from "@/lib/payment-transaction-status";

/**
 * The `reason` on a bank-transfer PRIMARY receipt the settle recorded at the
 * invoice's cash. The refunded-total repair reads it (`INV-PAY-126`): an invoice
 * correction counts as refunded only against a receipt recorded at the stored
 * figure (before #3979, or kept), never against one recorded from cash.
 */
export const IB_RECEIPT_FROM_CASH_REASON = "xero_invoice_paid_cash";

/** The `reason` on a PRIMARY receipt the settle creates when none exists and it keeps the stored figure. */
export const IB_RECEIPT_KEPT_REASON = "xero_invoice_paid_reconciliation";

/**
 * The reasons a bank-transfer PRIMARY receipt carries when it holds the figure
 * the payment was BORN with, not cash read from Xero: the payment's creation
 * (`booking-create.ts`, the switch to bank transfer), the settle before #3979 or
 * when it keeps the stored figure (`xero_invoice_paid_reconciliation`), the
 * legacy backfill, and none. An explicit allowlist (#3979 final review): any
 * other reason - the cash marker above, a part payment recognised at cancel
 * (`PART_PAYMENT_RECOGNISED_REASON`), an officer's cash - is cash-sized.
 */
const STORED_FIGURE_RECEIPT_REASONS: ReadonlySet<string | null> = new Set([
  null,
  "internet_banking_booking_payment",
  "internet_banking_switch_at_pay",
  IB_RECEIPT_KEPT_REASON,
  LEGACY_PRIMARY_BACKFILL_REASON,
]);

export function isInternetBankingPrimary(row: { kind: PaymentTransactionKind; source: PaymentSource }): boolean {
  return row.kind === PaymentTransactionKind.PRIMARY && row.source === PaymentSource.INTERNET_BANKING;
}

/**
 * #3979 (`INV-PAY-126`): whether an invoice correction still counts as refunded
 * against this payment - a bank-transfer PRIMARY receipt is captured, and every
 * captured one holds the stored figure (`STORED_FIGURE_RECEIPT_REASONS`). Such a
 * receipt is the figure the payment was born with (settled before #3979, or
 * kept by the settle), so it still includes the corrected amount, and counting
 * the correction keeps the payment's net at the cash. A payment never
 * captured, or with a cash-sized receipt, never counts one. Pure, over the
 * payment's rows: the refunded-total repair and the Xero repair tool both read it.
 */
export function receiptCountsInvoiceCorrections(
  rows: ReadonlyArray<{ kind: PaymentTransactionKind; source: PaymentSource; status: PaymentStatus; reason: string | null }>,
): boolean {
  const receipts = rows.filter(isCapturedInternetBankingPrimary);
  return receipts.length > 0 && receipts.every((row) => STORED_FIGURE_RECEIPT_REASONS.has(row.reason));
}

/**
 * A captured bank-transfer PRIMARY receipt: the one row filter both
 * `receiptCountsInvoiceCorrections` and `isStoredFigureBankReceipt` apply
 * before asking about the stored figure, so it is written once.
 */
function isCapturedInternetBankingPrimary(row: {
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
}): boolean {
  return isInternetBankingPrimary(row) && isCapturedTransactionStatus(row.status);
}

/**
 * #4069 (`INV-PAY-159`): a captured bank-transfer PRIMARY receipt holding the
 * figure its payment was born with (`STORED_FIGURE_RECEIPT_REASONS`), not cash
 * read from Xero. The cash-cover reader (`booking-cash-evidence.ts`) cannot
 * prove what such a receipt took, so it reads it as unknown.
 */
export function isStoredFigureBankReceipt(row: {
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
  reason: string | null;
}): boolean {
  return isCapturedInternetBankingPrimary(row) && STORED_FIGURE_RECEIPT_REASONS.has(row.reason);
}
