import { PaymentSource, PaymentStatus } from "@prisma/client";

import {
  CREDIT_RELEASE_ASK_REASON,
} from "@/lib/credit-release-ask-keys";

/**
 * WHICH CARD CAPTURES PAID FOR CREDIT-RELEASE MONEY, AND HOW MUCH OF EACH
 * (#4253, `INV-ADDPAY-045`). Pure: no client, no clock.
 *
 * A payment carries ONE live ask. A request for released credit can therefore be
 * superseded by a later one - an edit's, or another release's - which absorbs its
 * unpaid balance (`carriedAskCents`, `INV-PAY-098`), and it is the LAST request of
 * the chain that the member pays. The released money was never invoiced on its own
 * (it stands on the booking's own invoice), so when any request in the chain is
 * captured, the part of the capture that is credit-release money is recorded in
 * Xero against that invoice. An edit's own money is its supplementary invoice's.
 *
 * THE CHAIN is the ADDITIONAL rows after the previous captured one, withdrawn
 * rows aside - the same chain a price reduction reads (`unpaidChain`). Each row
 * absorbed the one before it, so a credit-release row's own money
 * (`amountCents - carriedAskCents`) is inside the capture exactly when every row
 * after it carried at least the full figure of the row before. Anything else -
 * a gap in that carrying, a bank-cash row mid-chain - is NOT guessed at: the row
 * comes back as `unexplained`, and an officer is told, because recording a payment
 * the member did not make, or missing one they did, are both worse than a prompt.
 */
export type AskLedgerRow = {
  id: string;
  source: PaymentSource;
  status: PaymentStatus;
  reason: string | null;
  amountCents: number;
  carriedAskCents: number;
  withdrawnAt: Date | null;
  stripePaymentIntentId: string | null;
};

export type CreditReleasePaymentItem = {
  /** The credit-release request row whose own money was captured. */
  askRowId: string;
  /** Its own money: what is recorded against the booking's invoice. */
  ownCents: number;
  /** The captured row that collected it, and its intent (the payment's date and reference). */
  capturedByRowId: string;
  capturedByIntentId: string;
};

export type CreditReleasePaymentPlan = {
  items: CreditReleasePaymentItem[];
  /**
   * Credit-release rows a capture followed whose carrying cannot be traced, and
   * rows a PARTIALLY refunded capture holds (what the club kept is not guessed).
   */
  unexplainedRowIds: string[];
  /** The captures those rows belong to: no other Xero writer records them either. */
  unexplainedCaptureIntentIds: string[];
};

/** Captured and not given back in full: money the club holds. */
export function isHeldCapture(status: PaymentStatus): boolean {
  return status === PaymentStatus.SUCCEEDED || status === PaymentStatus.PARTIALLY_REFUNDED;
}

export function planCreditReleasePayments(rows: readonly AskLedgerRow[]): CreditReleasePaymentPlan {
  const items: CreditReleasePaymentItem[] = [];
  const unexplainedRowIds: string[] = [];
  const unexplainedCaptureIntentIds = new Set<string>();
  let chain: AskLedgerRow[] = [];

  for (const row of rows) {
    if (row.withdrawnAt) continue;
    if (!isHeldCapture(row.status)) {
      // A fully refunded capture holds nothing and ends the chain like any paid row.
      if (row.status === PaymentStatus.REFUNDED) chain = [];
      else chain.push(row);
      continue;
    }
    const captured = [...chain, row];
    chain = [];
    // Bank cash is recorded in Xero by its own invoice; it never carries card money.
    if (row.source !== PaymentSource.STRIPE || !row.stripePaymentIntentId) continue;
    captured.forEach((ask, index) => {
      if (ask.reason !== CREDIT_RELEASE_ASK_REASON) return;
      const ownCents = ask.amountCents - ask.carriedAskCents;
      if (ownCents <= 0) return;
      const rest = captured.slice(index + 1);
      const carriedThrough = rest.every((later, offset) => {
        const before = offset === 0 ? ask : rest[offset - 1]!;
        return later.carriedAskCents >= before.amountCents;
      });
      // A capture partly given back holds an amount nobody has worked out for this money:
      // fail closed, as for a chain that cannot be traced.
      if (!carriedThrough || row.status !== PaymentStatus.SUCCEEDED) {
        unexplainedRowIds.push(ask.id);
        unexplainedCaptureIntentIds.add(row.stripePaymentIntentId as string);
      } else {
        items.push({
          askRowId: ask.id,
          ownCents,
          capturedByRowId: row.id,
          capturedByIntentId: row.stripePaymentIntentId as string,
        });
      }
    });
  }
  return { items, unexplainedRowIds, unexplainedCaptureIntentIds: [...unexplainedCaptureIntentIds] };
}

/**
 * #4494 (`INV-SSOT`): ONE CAPTURE'S CREDIT-RELEASE SHARE, read off a plan - the
 * own money of every request it collected, and whether the sweep holds it for
 * an officer. The one fold the share reader (`readCreditReleaseCaptureShare`)
 * and the sweep's overlap hold both use, so they cannot disagree.
 */
export function creditReleaseShareFromPlan(
  plan: CreditReleasePaymentPlan,
  paymentIntentId: string,
): { ownCents: number; held: boolean } {
  return {
    ownCents: plan.items
      .filter((item) => item.capturedByIntentId === paymentIntentId)
      .reduce((sum, item) => sum + item.ownCents, 0),
    held: plan.unexplainedCaptureIntentIds.includes(paymentIntentId),
  };
}
