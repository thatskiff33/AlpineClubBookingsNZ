/**
 * POST THE LINE FOR MONEY AN OFFICER HANDED BACK (#3599, programme #3527).
 *
 * Called once, from `resolveManualRefundTask`, inside its transaction and
 * after its status-guarded claim, whenever the completion took the
 * `local-allocation` route — the one on which the club sends money it holds
 * back by hand and `applyLocalRefundAllocation` records it. That is every
 * cancelled Internet Banking or cash booking's hand-back (#3529) and every
 * edit-review refund settled the same way; the Stripe route posts through its
 * `PaymentRefund` row (#3581) and the account-credit route through its credit
 * row (`booking-ledger-credit-sync.ts`), so each completion posts exactly once.
 *
 * THE METHOD IS INTERNET BANKING BY DECISION, not by inference: the owner's
 * wording decision for #3529 (20 Sep 2026) names a hand-back "Refund requested
 * via internet banking", and `refundMethodForEditReviewRoute` is its one home
 * (`INV-PAY-101`). A booking an officer marked paid in cash is handed back
 * the same way.
 *
 * NOT FOR A CARD PAYMENT (review of #3609). The route is chosen from the task's
 * KIND, so a legacy task on a Stripe capture — a late capture on a deleted
 * booking — also completes on it. That money goes back on the card, and the
 * refund posts `CARD_REFUND` from its `PaymentRefund` row when Stripe reports
 * it (#3581); a `BANK_REFUND` here as well would record one refund twice, the
 * second by the wrong method. So a Stripe payment's completion posts nothing.
 *
 * Build in pure code, caught and logged; write unwrapped (#3590's review). The
 * key is the task id, and a task completes at most once, so a replay of the
 * same completion posts nothing (`INV-MONEY-033`).
 */
import type { PaymentSource, Prisma } from "@prisma/client";

import { planHandBackLine } from "@/lib/booking-ledger-credit-posting";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
import logger from "@/lib/logger";
import type { RefundMethod } from "@/lib/xero-refund-method";

export async function postHandBackLedgerLine({
  bookingId,
  lodgeId,
  manualRefundTaskId,
  amountCents,
  refundMethod,
  paymentSource,
  officerMemberId,
  store,
}: {
  bookingId: string;
  lodgeId: string;
  manualRefundTaskId: string;
  amountCents: number;
  /** From `refundMethodForEditReviewRoute`, the one home of route → method. */
  refundMethod: RefundMethod;
  /** The source of the payment the money comes back out of; null when the task has none. */
  paymentSource: PaymentSource | null;
  officerMemberId: string;
  store: Pick<Prisma.TransactionClient, "bookingLedgerLine">;
}): Promise<void> {
  if (paymentSource === "STRIPE") return;
  let rows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    // Money handed back by hand is a bank transfer and nothing else: a card
    // refund or account credit arriving here would be a routing bug, refused
    // in pure code where refusing is safe (review of #3609).
    if (refundMethod !== "internet-banking") {
      throw new Error(`INV-MONEY-035: a hand-back cannot be a ${refundMethod} refund`);
    }
    rows = buildBookingLedgerRows([
      planHandBackLine({
        bookingId,
        lodgeId,
        manualRefundTaskId,
        amountCents,
        settlementMethod: "INTERNET_BANKING",
        officerMemberId,
      }),
    ]);
  } catch (error) {
    logger.error(
      { err: error, bookingId, manualRefundTaskId },
      "Booking ledger: could not build the hand-back line; the completion stands and the gap is the census's to report (#3599)",
    );
    return;
  }
  await writeBookingLedgerRows(store, rows);
}
