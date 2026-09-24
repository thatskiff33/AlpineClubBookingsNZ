/**
 * WHICH SETTLEMENT LINES A PAYMENT'S TRANSACTIONS AND REFUNDS IMPLY (#3581,
 * programme #3527; design `docs/design/booking-ledger.md` §5.2).
 *
 * Pure: given the payment's rows as they stand and the settlement lines already
 * posted for it, it returns what must be posted to make the two agree — and
 * nothing else. It reads nothing and writes nothing.
 *
 * IT CONVERGES RATHER THAN RECORDING EVENTS. The sync runs where the `Payment`
 * mirror is derived from these same rows (`reconcilePaymentAggregates`) and
 * from the three writers that set the mirror themselves (the manual settle, its
 * reversal, the Xero receipt path), so the ledger is re-derived from the rows
 * each time rather than from each writer's idea of what happened. Keys
 * (`INV-MONEY-033`) make a re-run post nothing. "Every writer" is a claim to
 * CHECK, not to assume: review of #3604 traced them all and found one the
 * first cut had missed.
 *
 * INSERT-ONLY WOULD NOT BE SOUND, and that was checked, not assumed. A captured
 * transaction can stop being captured: reversing a manual mark-paid flips the
 * row from SUCCEEDED to FAILED (`INV-PAY-045`), and a Stripe refund can fail
 * after it was recorded. So a posted line whose source no longer holds is
 * REVERSED — a new line, the original never touched, keyed by that line's id.
 *
 * AND A SOURCE CAN HOLD AGAIN. The first cut assumed each source flips at most
 * once; review of #3604 showed a reversed mark-paid row can be paid through
 * Xero later (the inbound path revives a FAILED Internet Banking row). So each
 * source's lines form a chain — capture, reversal, capture again — and the
 * planner walks it to find the one line live now (see `walk`).
 */
import type { PaymentSource, PaymentStatus } from "@prisma/client";

import type { BookingLedgerPosting } from "@/lib/booking-ledger-write";
import {
  afterReversalKey,
  captureKey,
  refundKey,
  reversalKey,
} from "@/lib/booking-ledger-posting-keys";
import { isCapturedTransactionStatus, isRecordedRefundStatus } from "@/lib/payment-transaction-status";

export type SettlementSourceTransaction = {
  id: string;
  source: PaymentSource;
  status: PaymentStatus;
  amountCents: number;
};

export type SettlementSourceRefund = {
  id: string;
  status: string;
  amountCents: number;
};

/** A settlement line already on the ledger, with what a reversal must copy. */
export type PostedSettlementLine = {
  id: string;
  postingKey: string | null;
  reversesLineId: string | null;
  kind: BookingLedgerPosting["kind"];
  sign: 1 | -1;
  quantity: number;
  unitCents: number;
  anchorKind: BookingLedgerPosting["anchorKind"];
  anchorId: string;
  settlementMethod: NonNullable<BookingLedgerPosting["settlementMethod"]> | null;
  narration: string;
};

export type SettlementPlanInput = {
  bookingId: string;
  lodgeId: string;
  /**
   * `Payment.manuallyMarkedPaidAt IS NOT NULL` — the provenance predicate
   * `INV-PAY-001` makes the only one. A manually settled payment carries no
   * genuine bank receipt (mark-paid is refused on any Xero evidence,
   * `INV-PAY-039`), so every captured Internet Banking row on it is the
   * officer's cash.
   */
  manuallySettled: boolean;
  manualActorMemberId: string | null;
  transactions: readonly SettlementSourceTransaction[];
  refunds: readonly SettlementSourceRefund[];
  postedLines: readonly PostedSettlementLine[];
};

export type SettlementPlan = {
  postings: BookingLedgerPosting[];
  /**
   * A line already posted under a source's key whose amount no longer matches
   * the source. Not corrected here — a line is never edited, and re-posting
   * under the same key is a no-op by design — but surfaced, for the caller to
   * log and for C4's census (#3583) to count.
   */
  amountDrift: Array<{ postingKey: string; postedCents: number; sourceCents: number }>;
};

function captureShape(
  source: PaymentSource,
  manuallySettled: boolean,
): Pick<BookingLedgerPosting, "kind" | "settlementMethod" | "narration"> {
  if (source === "STRIPE") {
    return { kind: "CARD_CAPTURE", settlementMethod: "CARD", narration: "Card payment" };
  }
  return manuallySettled
    ? { kind: "CASH_RECORDED", settlementMethod: "CASH", narration: "Payment recorded by an officer" }
    : { kind: "BANK_RECEIPT", settlementMethod: "INTERNET_BANKING", narration: "Internet Banking payment received" };
}

export function planSettlementLines(input: SettlementPlanInput): SettlementPlan {
  const postings: BookingLedgerPosting[] = [];
  const amountDrift: SettlementPlan["amountDrift"] = [];

  const byKey = new Map<string, PostedSettlementLine>();
  const reversalOf = new Map<string, PostedSettlementLine>();
  for (const line of input.postedLines) {
    if (line.postingKey) byKey.set(line.postingKey, line);
    if (line.reversesLineId) reversalOf.set(line.reversesLineId, line);
  }

  const base = { bookingId: input.bookingId, lodgeId: input.lodgeId, side: "SETTLEMENT" as const };

  /**
   * THE SOURCE'S CHAIN. A source can hold, stop holding, and hold again — a
   * mark-paid reversed, then the same row paid through Xero (review of #3604).
   * Its lines form a chain: the first under the base key, each later one under
   * `afterReversalKey(base, <the reversal that retired its predecessor>)`.
   * Walking it gives the one line that is live now (if any) and the key the
   * next line would take. Keyed by the reversal, so a replay finds its own
   * line and posts nothing.
   */
  const walk = (baseKey: string): { live: PostedSettlementLine | null; nextKey: string } => {
    let current = byKey.get(baseKey);
    let nextKey = baseKey;
    while (current) {
      const reversal = reversalOf.get(current.id);
      if (!reversal) return { live: current, nextKey };
      nextKey = afterReversalKey(baseKey, reversal.id);
      current = byKey.get(nextKey);
    }
    return { live: null, nextKey };
  };

  /** Converge one source: post if it holds and nothing live stands; reverse if it does not. */
  const converge = (
    baseKey: string,
    holds: boolean,
    cents: number,
    make: (postingKey: string) => BookingLedgerPosting,
  ): void => {
    const { live, nextKey } = walk(baseKey);
    if (holds) {
      if (live) {
        const postedCents = live.unitCents * live.quantity;
        if (postedCents !== cents) {
          amountDrift.push({ postingKey: live.postingKey ?? baseKey, postedCents, sourceCents: cents });
        }
        return;
      }
      postings.push(make(nextKey));
      return;
    }
    if (!live) return;
    postings.push({
      ...base,
      kind: live.kind,
      sign: live.sign === 1 ? -1 : 1,
      quantity: live.quantity,
      unitCents: live.unitCents,
      anchorKind: live.anchorKind,
      anchorId: live.anchorId,
      // Copied from the line, never re-derived: by now the payment's
      // provenance may have been cleared by the very reversal being recorded.
      settlementMethod: live.settlementMethod,
      narration: `Reversed: ${live.narration}`,
      reversesLineId: live.id,
      postingKey: reversalKey(live.id),
    });
  };

  for (const transaction of input.transactions) {
    // A $0 capture moves no money, so it posts nothing (§9: INV-PAY-007).
    const holds = isCapturedTransactionStatus(transaction.status) && transaction.amountCents > 0;
    converge(captureKey(transaction.id), holds, transaction.amountCents, (postingKey) => ({
      ...base,
      ...captureShape(transaction.source, input.manuallySettled),
      sign: 1,
      quantity: 1,
      unitCents: transaction.amountCents,
      anchorKind: "PAYMENT_TRANSACTION",
      anchorId: transaction.id,
      postedByMemberId:
        transaction.source !== "STRIPE" && input.manuallySettled ? input.manualActorMemberId : null,
      postingKey,
    }));
  }

  for (const refund of input.refunds) {
    const holds = isRecordedRefundStatus(refund.status) && refund.amountCents > 0;
    converge(refundKey(refund.id), holds, refund.amountCents, (postingKey) => ({
      ...base,
      kind: "CARD_REFUND",
      sign: -1,
      quantity: 1,
      unitCents: refund.amountCents,
      anchorKind: "PAYMENT_REFUND",
      anchorId: refund.id,
      settlementMethod: "CARD",
      narration: "Card refund",
      postingKey,
    }));
  }

  return { postings, amountDrift };
}
