/**
 * WHICH SETTLEMENT LINES A PAYMENT'S TRANSACTIONS AND REFUNDS IMPLY (#3581,
 * programme #3527; design `docs/design/booking-ledger.md` §5.2).
 *
 * Pure: given the payment's rows as they stand and the settlement lines already
 * posted for it, it returns what must be posted to make the two agree — and
 * nothing else. It reads nothing and writes nothing.
 *
 * IT CONVERGES RATHER THAN RECORDING EVENTS. Every capture, receipt and refund
 * writer ends in `reconcilePaymentAggregates`, the one place the `Payment`
 * mirror is derived from these same rows; the sync runs there (and from the two
 * manual paths that bypass it), so the ledger is re-derived from the rows each
 * time and a writer nobody has thought of yet is covered anyway. Keys
 * (`INV-MONEY-033`) make a re-run post nothing.
 *
 * INSERT-ONLY WOULD NOT BE SOUND, and that was checked, not assumed. A captured
 * transaction can stop being captured: reversing a manual mark-paid flips the
 * row from SUCCEEDED to FAILED (`INV-PAY-045`), and a Stripe refund can fail
 * after it was recorded. So a posted line whose source no longer holds is
 * REVERSED — a new line, the original never touched. Each source flips at most
 * once (a reversed mark-paid is never resurrected; the settle mints a new row),
 * so each line is reversed at most once, and the reversal is keyed by the
 * reversed line's id.
 */
import type { PaymentSource, PaymentStatus } from "@prisma/client";

import type { BookingLedgerPosting } from "@/lib/booking-ledger-write";
import { captureKey, refundKey, reversalKey } from "@/lib/booking-ledger-posting-keys";
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
    : { kind: "BANK_RECEIPT", settlementMethod: "INTERNET_BANKING", narration: "Bank transfer received" };
}

export function planSettlementLines(input: SettlementPlanInput): SettlementPlan {
  const postings: BookingLedgerPosting[] = [];
  const amountDrift: SettlementPlan["amountDrift"] = [];

  const byKey = new Map<string, PostedSettlementLine>();
  const reversedIds = new Set<string>();
  for (const line of input.postedLines) {
    if (line.postingKey) byKey.set(line.postingKey, line);
    if (line.reversesLineId) reversedIds.add(line.reversesLineId);
  }

  const base = { bookingId: input.bookingId, lodgeId: input.lodgeId, side: "SETTLEMENT" as const };

  /** Post a line for a source that holds, unless it is already there. */
  const ensure = (
    key: string,
    cents: number,
    make: () => BookingLedgerPosting,
  ): void => {
    const posted = byKey.get(key);
    if (posted) {
      const postedCents = posted.unitCents * posted.quantity;
      if (postedCents !== cents) {
        amountDrift.push({ postingKey: key, postedCents, sourceCents: cents });
      }
      return;
    }
    postings.push(make());
  };

  /** Reverse a posted line whose source no longer holds, unless already reversed. */
  const retire = (key: string): void => {
    const posted = byKey.get(key);
    if (!posted || reversedIds.has(posted.id)) return;
    postings.push({
      ...base,
      kind: posted.kind,
      sign: posted.sign === 1 ? -1 : 1,
      quantity: posted.quantity,
      unitCents: posted.unitCents,
      anchorKind: posted.anchorKind,
      anchorId: posted.anchorId,
      // Copied from the line, never re-derived from the source: by now the
      // source's reason or the payment's provenance may say something else.
      settlementMethod: posted.settlementMethod,
      narration: `Reversed: ${posted.narration}`,
      reversesLineId: posted.id,
      postingKey: reversalKey(posted.id),
    });
  };

  for (const transaction of input.transactions) {
    const key = captureKey(transaction.id);
    // A $0 capture moves no money, so it posts nothing (§9: INV-PAY-007).
    if (isCapturedTransactionStatus(transaction.status) && transaction.amountCents > 0) {
      ensure(key, transaction.amountCents, () => ({
        ...base,
        ...captureShape(transaction.source, input.manuallySettled),
        sign: 1,
        quantity: 1,
        unitCents: transaction.amountCents,
        anchorKind: "PAYMENT_TRANSACTION",
        anchorId: transaction.id,
        postedByMemberId:
          transaction.source !== "STRIPE" && input.manuallySettled
            ? input.manualActorMemberId
            : null,
        postingKey: key,
      }));
    } else {
      retire(key);
    }
  }

  for (const refund of input.refunds) {
    const key = refundKey(refund.id);
    if (isRecordedRefundStatus(refund.status) && refund.amountCents > 0) {
      ensure(key, refund.amountCents, () => ({
        ...base,
        kind: "CARD_REFUND",
        sign: -1,
        quantity: 1,
        unitCents: refund.amountCents,
        anchorKind: "PAYMENT_REFUND",
        anchorId: refund.id,
        settlementMethod: "CARD",
        narration: "Card refund",
        postingKey: key,
      }));
    } else {
      retire(key);
    }
  }

  return { postings, amountDrift };
}
