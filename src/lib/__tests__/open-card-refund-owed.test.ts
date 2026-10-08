// #3372 / #3924 money review (round 3): which recorded refund belongs to which
// card refund operation. Each scenario is the reviewer's, asserted in cents.
import { describe, expect, it } from "vitest";

import {
  cardRefundSentAfterPaidAnotherWay,
  isOwedCardRefundOperation,
  openCardRefundOwedByOperation,
  openCardRefundOwedCents,
  type CardRefundOperationRow,
  type CardRefundOwedPaymentRow,
  type RecordedCardRefundRow,
} from "@/lib/open-card-refund-owed";

const at = (minute: number) => new Date(Date.UTC(2026, 5, 20, 0, minute));

function operation(overrides: Partial<CardRefundOperationRow>): CardRefundOperationRow {
  return {
    id: "op",
    type: "REFUND_BOOKING_MODIFICATION",
    status: "FAILED",
    idempotencyKey: "refund_request_refund_rr1",
    amountCents: 0,
    allocationPlan: null,
    paymentTransactionId: null,
    createdAt: at(10),
    succeededAt: null,
    ...overrides,
  };
}

function refund(overrides: Partial<RecordedCardRefundRow>): RecordedCardRefundRow {
  return { paymentTransactionId: "txn-a", amountCents: 0, status: "succeeded", createdAt: at(20), ...overrides };
}

function payment(
  recoveryOperations: CardRefundOperationRow[],
  refunds: RecordedCardRefundRow[],
  money: { amountCents?: number; refundedAmountCents?: number } = {},
): CardRefundOwedPaymentRow {
  return {
    status: "PARTIALLY_REFUNDED",
    amountCents: money.amountCents ?? 30_000,
    refundedAmountCents: money.refundedAmountCents ?? 0,
    recoveryOperations,
    refunds,
  };
}

describe("openCardRefundOwedCents attributes each recorded refund to the operation that sent it", () => {
  it("F1: a refund request's partial send owes only the unsent slice", () => {
    // $300.00 over two charges; plan a:$200.00 + b:$50.00. Slice a went inline
    // BEFORE the operation existed, b failed. The route now enqueues only b.
    const owed = openCardRefundOwedCents(
      payment(
        [operation({ amountCents: 5_000, allocationPlan: [{ paymentTransactionId: "txn-b", amountCents: 5_000 }] })],
        [refund({ paymentTransactionId: "txn-a", amountCents: 20_000, createdAt: at(5) })],
        { refundedAmountCents: 20_000 },
      ),
    );
    expect(owed).toBe(5_000);
  });

  it("F1: had the whole plan been enqueued, the slice sent before it would read as owed", () => {
    // Documents why the route enqueues the remainder: an operation's slices are
    // unsent when it is raised, so a row older than it is never its own.
    const owed = openCardRefundOwedCents(
      payment(
        [
          operation({
            amountCents: 25_000,
            allocationPlan: [
              { paymentTransactionId: "txn-a", amountCents: 20_000 },
              { paymentTransactionId: "txn-b", amountCents: 5_000 },
            ],
          }),
        ],
        [refund({ paymentTransactionId: "txn-a", amountCents: 20_000, createdAt: at(5) })],
        { refundedAmountCents: 20_000 },
      ),
    );
    expect(owed).toBe(10_000);
  });

  it("nets a slice the operation itself sent after it was raised", () => {
    const owed = openCardRefundOwedCents(
      payment(
        [
          operation({
            amountCents: 25_000,
            allocationPlan: [
              { paymentTransactionId: "txn-a", amountCents: 20_000 },
              { paymentTransactionId: "txn-b", amountCents: 5_000 },
            ],
          }),
        ],
        [refund({ paymentTransactionId: "txn-a", amountCents: 20_000, createdAt: at(11) })],
        { refundedAmountCents: 20_000 },
      ),
    );
    expect(owed).toBe(5_000);
  });

  it("F2: a later unrelated refund of a different amount on the same charge nets nothing", () => {
    // A dead $50.00 operation, then an unrelated $30.00 refund on its charge:
    // still $50.00 owed, never $20.00.
    const owed = openCardRefundOwedCents(
      payment(
        [operation({ amountCents: 5_000, allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000 }] })],
        [refund({ amountCents: 3_000, createdAt: at(30) })],
        { refundedAmountCents: 3_000 },
      ),
    );
    expect(owed).toBe(5_000);
  });

  it("F2: a later operation's own refund is that operation's, even of the same amount", () => {
    // A dead $50.00 operation, then a SECOND $50.00 refund on the same charge
    // that succeeded and closed. Its row goes to the operation raised most
    // recently before it, so the dead one still owes $50.00.
    const owed = openCardRefundOwedByOperation(
      payment(
        [
          operation({ id: "dead", amountCents: 5_000, allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000 }] }),
          operation({
            id: "later",
            status: "SUCCEEDED",
            amountCents: 5_000,
            allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000 }],
            createdAt: at(40),
          }),
        ],
        [refund({ amountCents: 5_000, createdAt: at(41) })],
        { refundedAmountCents: 5_000 },
      ),
    );
    expect(owed).toEqual(new Map([["dead", 5_000]]));
  });

  it("F2: once the dead operation's retry sends its slice too, neither owes", () => {
    const owed = openCardRefundOwedCents(
      payment(
        [
          operation({ id: "dead", status: "PENDING", amountCents: 5_000, allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000 }] }),
          operation({
            id: "later",
            status: "SUCCEEDED",
            amountCents: 5_000,
            allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000 }],
            createdAt: at(40),
          }),
        ],
        [refund({ amountCents: 5_000, createdAt: at(41) }), refund({ amountCents: 5_000, createdAt: at(50) })],
        { refundedAmountCents: 10_000 },
      ),
    );
    expect(owed).toBe(0);
  });

  it("takes a dashboard refund of exactly the unsent slice as that slice", () => {
    // The treasurer refunds the dead $50.00 in the Stripe dashboard; the webhook
    // records it. That is the slice's money gone back.
    const owed = openCardRefundOwedCents(
      payment(
        [operation({ amountCents: 5_000, allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000 }] })],
        [refund({ amountCents: 5_000, createdAt: at(60) })],
        { refundedAmountCents: 5_000 },
      ),
    );
    expect(owed).toBe(0);
  });

  it("a refund Stripe later failed fills nothing", () => {
    const owed = openCardRefundOwedCents(
      payment(
        [operation({ amountCents: 5_000, allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000 }] })],
        [refund({ amountCents: 5_000, status: "failed", createdAt: at(20) })],
      ),
    );
    expect(owed).toBe(5_000);
  });

  it("a superseded intent's refund absorbs any refund on its own transaction after it was raised", () => {
    // The worker sends whatever that transaction still holds, so a part refund
    // made meanwhile is progress on it.
    const owed = openCardRefundOwedCents(
      payment(
        [operation({ type: "REFUND_SUPERSEDED_PAYMENT", idempotencyKey: "superseded", amountCents: 8_000, paymentTransactionId: "txn-a" })],
        [refund({ amountCents: 3_000, createdAt: at(20) }), refund({ amountCents: 1_000, createdAt: at(5) })],
        { refundedAmountCents: 4_000 },
      ),
    );
    expect(owed).toBe(5_000);
  });

  it("a ledger refund with no plan yet owes its amount, capped at what the payment holds", () => {
    const owed = openCardRefundOwedCents(
      payment([operation({ amountCents: 40_000 })], [], { amountCents: 30_000, refundedAmountCents: 5_000 }),
    );
    expect(owed).toBe(25_000);
  });

  it("F3: a group organiser-cancel settlement's refund is not owed against its anchor payment", () => {
    const groupRow = operation({ idempotencyKey: "group_settlement_refund_recovery_settle1", amountCents: 9_000 });
    expect(isOwedCardRefundOperation(groupRow)).toBe(false);
    expect(openCardRefundOwedCents(payment([groupRow], []))).toBe(0);
    expect(isOwedCardRefundOperation(operation({ idempotencyKey: "booking_cancel_refund_recovery_b1" }))).toBe(true);
  });

  it("a closed operation owes nothing", () => {
    const owed = openCardRefundOwedCents(
      payment([operation({ status: "SUCCEEDED", amountCents: 5_000, allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000 }] })], []),
    );
    expect(owed).toBe(0);
  });

  describe("#3924 round 4, M4: a closed operation takes no refund recorded after its close", () => {
    // The lens's scenario: payment $500; op1 open [txnA $50, txnB $30]; op2,
    // newer, closed as paid another way [txnA $50]; op1 then sends txnA $50.
    const op1 = operation({
      id: "op1",
      amountCents: 8_000,
      allocationPlan: [
        { paymentTransactionId: "txn-a", amountCents: 5_000 },
        { paymentTransactionId: "txn-b", amountCents: 3_000 },
      ],
      createdAt: at(10),
    });
    const op2Closed = operation({
      id: "op2",
      status: "SUCCEEDED",
      amountCents: 5_000,
      allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000 }],
      createdAt: at(20),
      succeededAt: at(30),
    });

    it("op1's own later refund is op1's: it owes $30, not $80", () => {
      const owed = openCardRefundOwedByOperation(
        payment([op1, op2Closed], [refund({ paymentTransactionId: "txn-a", amountCents: 5_000, createdAt: at(40) })], {
          amountCents: 50_000,
          refundedAmountCents: 10_000,
        }),
      );
      expect(Object.fromEntries(owed)).toEqual({ op1: 3_000 });
    });

    it("a refund recorded inside the closed operation's window is still its own", () => {
      const owed = openCardRefundOwedByOperation(
        payment([op1, op2Closed], [refund({ paymentTransactionId: "txn-a", amountCents: 5_000, createdAt: at(25) })], {
          amountCents: 50_000,
          refundedAmountCents: 5_000,
        }),
      );
      expect(Object.fromEntries(owed)).toEqual({ op1: 8_000 });
    });

    it("a refund recorded exactly at the close is the closed operation's (at or before)", () => {
      const owed = openCardRefundOwedByOperation(
        payment([op1, op2Closed], [refund({ paymentTransactionId: "txn-a", amountCents: 5_000, createdAt: at(30) })], {
          amountCents: 50_000,
          refundedAmountCents: 5_000,
        }),
      );
      expect(Object.fromEntries(owed)).toEqual({ op1: 8_000 });
    });

    it("a row closed before its close time was written keeps no bound, as before", () => {
      const owed = openCardRefundOwedByOperation(
        payment(
          [op1, { ...op2Closed, succeededAt: null }],
          [refund({ paymentTransactionId: "txn-a", amountCents: 5_000, createdAt: at(40) })],
          { amountCents: 50_000, refundedAmountCents: 5_000 },
        ),
      );
      expect(Object.fromEntries(owed)).toEqual({ op1: 8_000 });
    });
    it("MUTATION: round 5, concurrency F2: a refund Stripe made BEFORE the close and the app recorded after it is the closed operation's, not op1's", () => {
      // op2's own request timed out at minute 25 - Stripe made the refund, the
      // answer was lost - the treasurer closed op2 as paid another way at 30,
      // and the charge.refunded sync recorded the refund at 40.
      const late = refund({ paymentTransactionId: "txn-a", amountCents: 5_000, stripeCreatedAt: at(25), createdAt: at(40) });
      const owing = payment([op1, op2Closed], [late], { amountCents: 50_000, refundedAmountCents: 10_000 });

      expect(Object.fromEntries(openCardRefundOwedByOperation(owing))).toEqual({ op1: 8_000 });
      // The member has op2's money twice: by card, and by the close's bank transfer.
      expect(Object.fromEntries(cardRefundSentAfterPaidAnotherWay(owing, new Set(["op2"])))).toEqual({ op2: 5_000 });
    });

    it("round 5: op1's own refund, made by Stripe after the close, is still op1's and pays no one twice", () => {
      const own = refund({ paymentTransactionId: "txn-a", amountCents: 5_000, stripeCreatedAt: at(40), createdAt: at(40) });
      const owing = payment([op1, op2Closed], [own], { amountCents: 50_000, refundedAmountCents: 10_000 });

      expect(Object.fromEntries(openCardRefundOwedByOperation(owing))).toEqual({ op1: 3_000 });
      expect(cardRefundSentAfterPaidAnotherWay(owing, new Set(["op2"])).size).toBe(0);
    });

    it("round 5: a refund inside the closed operation's window, recorded before its close, is not a double payment", () => {
      const inside = refund({ paymentTransactionId: "txn-a", amountCents: 5_000, stripeCreatedAt: at(25), createdAt: at(26) });
      const owing = payment([op1, op2Closed], [inside], { amountCents: 50_000, refundedAmountCents: 5_000 });
      expect(cardRefundSentAfterPaidAnotherWay(owing, new Set(["op2"])).size).toBe(0);
    });

    it("round 5: asked only of the closes named, and only once every operation is closed too", () => {
      const op1Closed = { ...op1, status: "SUCCEEDED", succeededAt: at(35) };
      const late = refund({ paymentTransactionId: "txn-a", amountCents: 5_000, stripeCreatedAt: at(25), createdAt: at(40) });
      const owing = payment([op1Closed, op2Closed], [late], { amountCents: 50_000, refundedAmountCents: 10_000 });
      expect(Object.fromEntries(cardRefundSentAfterPaidAnotherWay(owing, new Set(["op2"])))).toEqual({ op2: 5_000 });
      expect(cardRefundSentAfterPaidAnotherWay(owing, new Set(["op1"])).size).toBe(0);
    });
  });
});
