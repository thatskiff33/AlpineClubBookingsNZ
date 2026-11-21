/**
 * THE CASH A REFUND CREDIT NOTE MAY ANSWER (#3635 round-3 R1, `INV-PAY-110`).
 *
 * The one figure every refund-note sizing and gap reads: the enqueue's cap
 * (`enqueueXeroRefundCreditNoteOperation`), the note's execution-time cap
 * (`createXeroCreditNote`), the refund-gap reader behind the self-heal list and
 * the booking page (`readRefundCreditNoteGap`), the hardening report's
 * over-coverage count, and the refund-note link-repair script's coverage
 * target (`xero-refund-note-link-repair.ts`, #3635 C3). It is the payment's provider-backed CASH refund evidence
 * (`resolveStripeCashRefundEvidence`, #2902) LESS the refunds of late captures
 * the app never recorded in Xero, and (#4383) of each late capture whose
 * receipt recorded only part of it, the refunds above what it recorded
 * (`lateCaptureNotableRefundCents`).
 *
 * WHY. A late capture on a cancelled booking is a receipt Xero does not hold
 * until the app records it (`readLateCaptureXeroReceipt`): refunded before
 * then - on a treasurer's approval, after a withdrawal, in the dashboard and
 * then closed, or automatically by the webhook - it deliberately gets no note,
 * because the note's Stripe-account refund payment would take out money that
 * never went in. Counted as ordinary cash, that deliberate gap read as a
 * missing note, and the nightly self-heal raised it 24 hours later against the
 * booking's cleared pre-cancel invoice. A receipt resolved by hand is excluded
 * too: its refunds are recorded by hand, and the repair tool says so. A
 * receipt capped at its invoice's room (`INV-PAY-139`) puts only part of the
 * capture in Xero's Stripe account, so a note above that part would take out
 * more than went in; the rest is the officer's, as the receipt's alert says.
 *
 * Refund rows are matched to their capture by `PaymentRefund.stripePaymentIntentId`;
 * which intents are late captures is `findLateCapturePaymentIntents`, plus
 * (#4170), on a cancelled booking, any capture that landed after the cancel
 * (`findCapturesLandedAfterCancellation`) while it has no record row yet. A
 * pre-ledger payment (no `PaymentRefund` rows) predates late-capture holds and
 * is left to the evidence's legacy rule.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { isLateCaptureRefundedBookingStatus } from "@/lib/additional-payment-chase";
import { findCapturesLandedAfterCancellation } from "@/lib/late-capture-landed-after";
import {
  resolveStripeCashRefundEvidence,
  type StripeCashRefundEvidence,
} from "@/lib/stripe-cash-refund-evidence";
import {
  findLateCapturePaymentIntents,
  lateCaptureNotableRefundCents,
  readLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";

export interface RefundNoteEligibleCash {
  /** The payment's cash refund evidence, as `resolveStripeCashRefundEvidence` reads it. */
  evidence: StripeCashRefundEvidence;
  /** Cash refunds of late captures the app never recorded in Xero, or above what it recorded: no note answers them. */
  lateCaptureExcludedCents: number;
  /** What refund credit notes on this payment may cover. Never negative. */
  eligibleCashCents: number;
}

export async function resolveRefundNoteEligibleCash(
  payment: { id: string; bookingId: string; refundedAmountCents: number },
  db: Prisma.TransactionClient = prisma,
): Promise<RefundNoteEligibleCash> {
  const evidence = await resolveStripeCashRefundEvidence(payment, db);
  if (evidence.source !== "provider-ledger" || evidence.cashRefundCents <= 0) {
    return { evidence, lateCaptureExcludedCents: 0, eligibleCashCents: evidence.cashRefundCents };
  }
  const centsByIntent = await readRecordedRefundCentsByIntent(payment.id, db);
  const intents = [...centsByIntent.keys()];
  const lateIntents = await findLateCapturePaymentIntents(intents, db);
  // #4170: on a cancelled booking, a capture that landed after the cancel is a
  // late capture before its record row exists too (lost, or refunded outside
  // the app) - `readCaptureLandedAfterCancellation`'s rule, for many at once.
  for (const intent of await findUnrecordedLateCaptureIntents(payment.id, intents.filter((i) => !lateIntents.has(i)), db)) {
    lateIntents.add(intent);
  }
  let lateCaptureExcludedCents = 0;
  for (const intent of lateIntents) {
    const refundedCents = centsByIntent.get(intent) ?? 0;
    const receipt = await readLateCaptureXeroReceipt(intent, db);
    lateCaptureExcludedCents += refundedCents - lateCaptureNotableRefundCents(receipt, refundedCents);
  }
  return {
    evidence,
    lateCaptureExcludedCents,
    eligibleCashCents: Math.max(0, evidence.cashRefundCents - lateCaptureExcludedCents),
  };
}

/**
 * The payment's recorded refunds, summed per payment intent - which capture
 * each refunded, by `PaymentRefund.stripePaymentIntentId`. Shared with the
 * nightly lost-record check (#4149), which asks about exactly these intents.
 */
export async function readRecordedRefundCentsByIntent(
  paymentId: string,
  db: Pick<Prisma.TransactionClient, "paymentRefund"> = prisma,
): Promise<Map<string, number>> {
  const rows = await db.paymentRefund.findMany({
    where: { paymentId, stripePaymentIntentId: { not: null } },
    select: { stripePaymentIntentId: true, amountCents: true, status: true },
  });
  const centsByIntent = new Map<string, number>();
  for (const row of rows ?? []) {
    if (!row.stripePaymentIntentId || !isRecordedRefundStatus(row.status)) continue;
    centsByIntent.set(
      row.stripePaymentIntentId,
      (centsByIntent.get(row.stripePaymentIntentId) ?? 0) + Math.max(0, row.amountCents),
    );
  }
  return centsByIntent;
}

/**
 * The intents among these, on a payment whose booking is cancelled, whose
 * capture landed after the cancel (`findCapturesLandedAfterCancellation`). None
 * on a booking that is not cancelled: a superseded intent's cancel claim there
 * says nothing about a late capture.
 */
async function findUnrecordedLateCaptureIntents(
  paymentId: string,
  paymentIntentIds: readonly string[],
  db: Prisma.TransactionClient,
): Promise<Set<string>> {
  if (paymentIntentIds.length === 0) return new Set();
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: { booking: { select: { status: true } } },
  });
  if (!isLateCaptureRefundedBookingStatus(payment?.booking?.status)) return new Set();
  return findCapturesLandedAfterCancellation(paymentIntentIds, db);
}
