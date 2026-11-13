import { buildRefundCreditNotePayment } from "../../xero-invoice-payments";
import type { CashRefundMethod } from "../../xero-refund-method";
import { coverRefundExportComponent, refundExportPayloadHash, type RefundExportComponent, type RefundExportPlan, type RefundExportProblem } from "./refund-note-plan";

/**
 * THE CASH PAYMENT ON A REFUND NOTE, AS AN EXPORT PLAN (#4525, Ledger M13).
 * Pure. `settleRefundCreditNote` keeps building and sending its own payment; this
 * rebuilds the same body with the same builder (`buildRefundCreditNotePayment`,
 * `INV-SSOT`) from what it sent, and covers the whole cash slice the payment
 * records: a card refund's R12 on STRIPE_CLEARING (`memberMoneyEventKeys.refund`),
 * or a bank close's R14 on BANK (`paidAnotherWay`, `handBackPaid`).
 *
 * A note left unsettled (`resolveRefundSettlement` said `unsettled`) sent no
 * payment, so it has no plan: the caller records nothing.
 */
export interface RefundNotePaymentPlanInput {
  paymentId: string;
  creditNoteId: string;
  /** What the payment paid, as sent. */
  amountCents: number;
  bankCode: string;
  paymentDate: string;
  refundMethod: CashRefundMethod;
  /** `refundCreditNotePaymentIdempotencyKey(paymentId, creditNoteId)`, the key the payment was sent under. */
  legacyKey: string;
  /** The cash leg the payment records, or why none could be named. */
  cash: RefundExportComponent | RefundExportProblem;
}

/** Plan the refund note's payment: it covers its whole cash slice, or a conflict. */
export function planRefundNotePayment(input: RefundNotePaymentPlanInput): RefundExportPlan {
  const body = buildRefundCreditNotePayment({
    paymentId: input.paymentId,
    creditNoteId: input.creditNoteId,
    refundAmountCents: input.amountCents,
    bankCode: input.bankCode,
    paymentDate: input.paymentDate,
    refundMethod: input.refundMethod,
  });
  return coverRefundExportComponent({
    rendering: {
      legacyKey: input.legacyKey,
      payloadHash: refundExportPayloadHash([body]),
      frozenMapping: { bankCode: input.bankCode, refundMethod: input.refundMethod, creditNoteId: input.creditNoteId },
      lineTotalCents: input.amountCents,
    },
    component: input.cash,
    allowedAccounts: ["STRIPE_CLEARING", "BANK"],
  });
}
