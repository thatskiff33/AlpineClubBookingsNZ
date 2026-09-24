/**
 * POST THE LINE FOR MONEY AN OFFICER HANDED BACK (#3599, programme #3527).
 *
 * Called once, from `completeManualRefundTask`, inside its transaction and
 * after its status-guarded claim, whenever the completion took the
 * `local-allocation` route — the one on which the club sends money it holds
 * back by hand and `applyLocalRefundAllocation` records it. That is every
 * cancelled Internet Banking or cash booking's hand-back (#3529) and every
 * edit-review refund settled the same way; the Stripe route posts through its
 * `PaymentRefund` row (#3581) and the account-credit route through its credit
 * row (`booking-ledger-credit-sync.ts`), so each completion posts exactly once.
 *
 * Build in pure code, caught and logged; write unwrapped (#3590's review). The
 * key is the task id, and a task completes at most once, so a replay of the
 * same completion posts nothing (`INV-MONEY-033`).
 */
import type { Prisma } from "@prisma/client";

import { planHandBackLine } from "@/lib/booking-ledger-credit-posting";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
import logger from "@/lib/logger";
import type { RefundMethod } from "@/lib/xero-refund-method";

/** The ledger's name for each refund method (`INV-PAY-101`: the settlement decides it). */
const SETTLEMENT_METHOD_FOR_REFUND = {
  card: "CARD",
  "internet-banking": "INTERNET_BANKING",
  "account-credit": "ACCOUNT_CREDIT",
} as const satisfies Record<RefundMethod, string>;

export async function postHandBackLedgerLine({
  bookingId,
  lodgeId,
  manualRefundTaskId,
  amountCents,
  refundMethod,
  officerMemberId,
  store,
}: {
  bookingId: string;
  lodgeId: string;
  manualRefundTaskId: string;
  amountCents: number;
  /** From `refundMethodForEditReviewRoute`, the one home of route → method. */
  refundMethod: RefundMethod;
  officerMemberId: string;
  store: Pick<Prisma.TransactionClient, "bookingLedgerLine">;
}): Promise<void> {
  let rows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    rows = buildBookingLedgerRows([
      planHandBackLine({
        bookingId,
        lodgeId,
        manualRefundTaskId,
        amountCents,
        settlementMethod: SETTLEMENT_METHOD_FOR_REFUND[refundMethod],
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
