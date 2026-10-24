// #3372 / #3924 money review (round 3): which recorded refund belongs to which
// card refund operation. Each scenario is the reviewer's, asserted in cents.
import { describe, expect, it } from "vitest";

import {
  cardRefundSentAfterPaidAnotherWay,
  cardRefundSliceFilledBy,
  parseRefundAllocationPlan,
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

let refundSeq = 0;
function refund(overrides: Partial<RecordedCardRefundRow>): RecordedCardRefundRow {
  return { stripeRefundId: `re-${(refundSeq += 1)}`, paymentTransactionId: "txn-a", amountCents: 0, status: "succeeded", createdAt: at(20), ...overrides };
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

    // #3924 round 7 (money M3): one clock at both ends of the window.
    it("MUTATION: round 7: a refund Stripe made BEFORE an operation was raised, recorded after it, is never that operation's", () => {
      // A dashboard refund Stripe made at minute 15, before op2 was raised at
      // 20, that the sync recorded at 25 - inside op2's window by the app's clock.
      const dashboard = refund({ paymentTransactionId: "txn-a", amountCents: 5_000, stripeCreatedAt: at(15), createdAt: at(25) });
      const owing = payment([op1, op2Closed], [dashboard], { amountCents: 50_000, refundedAmountCents: 10_000 });
      // It is op1's slice, the only operation raised before Stripe made it.
      expect(Object.fromEntries(openCardRefundOwedByOperation(owing))).toEqual({ op1: 3_000 });
      expect(cardRefundSentAfterPaidAnotherWay(owing, new Set(["op2"])).size).toBe(0);
    });

    it("round 7: the raise is floored to its second, so a refund Stripe dates in that same second is still the operation's", () => {
      const raisedMidSecond = { ...op2Closed, createdAt: new Date(at(20).getTime() + 700) };
      const sameSecond = refund({ paymentTransactionId: "txn-a", amountCents: 5_000, stripeCreatedAt: at(20), createdAt: at(21) });
      const owing = payment([op1, raisedMidSecond], [sameSecond], { amountCents: 50_000, refundedAmountCents: 5_000 });
      expect(Object.fromEntries(openCardRefundOwedByOperation(owing))).toEqual({ op1: 8_000 });
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

/*
  #4083 review: a row whose attempt met a refusal keeps the slice Stripe made
  beside it, marked with its refund (`madeRefundId`), rather than dropping it.
  The marked slice is still this row's, so its refund fills it - and is never
  taken as an OLDER open row's unsent slice of the same transaction and amount.
*/
describe("a slice made beside a refusal stays its row's (#4083)", () => {
  const older = () =>
    operation({
      id: "op-older",
      status: "PENDING",
      amountCents: 5_000,
      allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000 }],
      createdAt: at(1),
    });
  const madeRefund = refund({ stripeRefundId: "re_made", paymentTransactionId: "txn-a", amountCents: 5_000, createdAt: at(20) });

  it("the made refund fills the marked slice of the row that made it; the older row's slice stays owed", () => {
    const retried = operation({
      id: "op-retried",
      status: "FAILED",
      amountCents: 8_000,
      allocationPlan: [
        { paymentTransactionId: "txn-a", amountCents: 5_000, madeRefundId: "re_made" },
        { paymentTransactionId: "txn-b", amountCents: 3_000, stripeKeySuffix: "refused1" },
      ],
      createdAt: at(10),
    });

    const owed = openCardRefundOwedByOperation(payment([older(), retried], [madeRefund], { refundedAmountCents: 5_000 }));

    expect(owed.get("op-retried")).toBe(3_000);
    expect(owed.get("op-older")).toBe(5_000);
  });

  // #4117 (money F1): a refund request raises its row AFTER its inline attempt,
  // so a slice it made predates the row - outside the row's window. It is filled
  // by its refund id all the same, and that refund fills nothing else.
  it("a marked slice made BEFORE its row was raised is filled by that refund, and the older row's same slice stays owed", () => {
    const raisedAfter = operation({
      id: "op-appeal",
      status: "PENDING",
      amountCents: 8_000,
      allocationPlan: [
        { paymentTransactionId: "txn-a", amountCents: 5_000, madeRefundId: "re_made" },
        { paymentTransactionId: "txn-b", amountCents: 3_000, stripeKeySuffix: "refused1" },
      ],
      createdAt: at(30),
    });

    const owed = openCardRefundOwedByOperation(payment([older(), raisedAfter], [madeRefund], { refundedAmountCents: 5_000 }));

    expect(owed.get("op-appeal")).toBe(3_000);
    expect(owed.get("op-older")).toBe(5_000);
  });

  it("a marked slice takes only its own refund: one of the same transaction and amount under another id leaves it owed", () => {
    const marked = operation({
      id: "op-marked",
      status: "PENDING",
      amountCents: 5_000,
      allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000, madeRefundId: "re_made" }],
      createdAt: at(10),
    });
    const someoneElses = refund({ stripeRefundId: "re_other", paymentTransactionId: "txn-a", amountCents: 5_000, createdAt: at(20) });

    expect(openCardRefundOwedByOperation(payment([marked], [someoneElses], { refundedAmountCents: 5_000 })).get("op-marked")).toBe(5_000);
  });

  it("CONTROL: had the made slice been dropped from the plan, the older row would have taken its refund", () => {
    const dropped = operation({
      id: "op-retried",
      status: "FAILED",
      amountCents: 3_000,
      allocationPlan: [{ paymentTransactionId: "txn-b", amountCents: 3_000, stripeKeySuffix: "refused1" }],
      createdAt: at(10),
    });

    const owed = openCardRefundOwedByOperation(payment([older(), dropped], [madeRefund], { refundedAmountCents: 5_000 }));

    expect(owed.get("op-older")).toBe(0);
  });
});

/*
  #4104 (`INV-PAY-128`): a refund Stripe failed later is owed once. The owner
  search asks which slice the owed figure fills with it, and a slice a door
  marked made after the failure was handed to a row of its own reads filled.
*/
describe("a refund Stripe failed later (#4104)", () => {
  it("names the slice a recorded refund fills: a marked one by its id, an unmarked one by the attribution", () => {
    const marked = operation({ id: "op-marked", amountCents: 5_000, allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000, madeRefundId: "re_m" }] });
    const unmarked = operation({ id: "op-plain", amountCents: 3_000, createdAt: at(11), allocationPlan: [{ paymentTransactionId: "txn-b", amountCents: 1_000 }, { paymentTransactionId: "txn-a", amountCents: 3_000 }] });
    const row = payment([marked, unmarked], [
      refund({ stripeRefundId: "re_m", amountCents: 5_000, createdAt: at(15) }),
      refund({ stripeRefundId: "re_u", amountCents: 3_000, createdAt: at(16) }),
    ]);
    expect(cardRefundSliceFilledBy(row, "re_m")).toMatchObject({ operation: { id: "op-marked" }, sliceIndex: 0 });
    expect(cardRefundSliceFilledBy(row, "re_u")).toMatchObject({ operation: { id: "op-plain" }, sliceIndex: 1 });
    expect(cardRefundSliceFilledBy(row, "re_none")).toBeNull();
  });

  it("MUTATION (concurrency B): a marked slice whose refund failed and was handed to a row of its own reads filled, so it is owed once", () => {
    const doorRow = operation({ id: "op-door", amountCents: 5_000, allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000, madeRefundId: "re_a" }] });
    const handed = operation({
      id: "op-failed-later",
      idempotencyKey: "card_refund_failed_later_re_a",
      status: "PENDING",
      amountCents: 5_000,
      createdAt: at(30),
      allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 5_000 }],
    });
    const failed = refund({ stripeRefundId: "re_a", amountCents: 5_000, status: "failed", createdAt: at(15) });
    const owed = openCardRefundOwedByOperation(payment([doorRow, handed], [failed]));
    expect(owed.get("op-door")).toBe(0);
    expect(owed.get("op-failed-later")).toBe(5_000);
    // Without the row of its own, the door's row owes it.
    expect(openCardRefundOwedByOperation(payment([doorRow], [failed])).get("op-door")).toBe(5_000);
  });

  it("keeps the failures a slice records, and refuses a malformed list", () => {
    expect(parseRefundAllocationPlan([{ paymentTransactionId: "txn-a", amountCents: 100, stripeKeySuffix: "refused1", failedRefundIds: ["re_1"] }])).toEqual([
      { paymentTransactionId: "txn-a", amountCents: 100, stripeKeySuffix: "refused1", failedRefundIds: ["re_1"] },
    ]);
    expect(parseRefundAllocationPlan([{ paymentTransactionId: "txn-a", amountCents: 100, failedRefundIds: [""] }])).toBeNull();
    expect(parseRefundAllocationPlan([{ paymentTransactionId: "txn-a", amountCents: 100, failedRefundIds: "re_1" }])).toBeNull();
  });
});

// #4312 round 8 (F4): the replay marks a re-sent slice with the refund Stripe made for it (`markResentSlices`). A
// marked slice takes its own refund before the newest-row-first matching, so the re-send fills the row that sent it
// and a newer row's unsent slice of the same charge and amount reads as owed - before the mark, the newer row took it.
describe("a re-sent slice marked with its refund fills its own row first (#4312 round 8)", () => {
  const resentSlice = { paymentTransactionId: "txn-a", amountCents: 4_000, stripeKeySuffix: "refused1", failedRefundIds: ["re_failed"] };
  const failed = refund({ stripeRefundId: "re_failed", amountCents: 4_000, status: "failed", createdAt: at(12) });
  const resend = refund({ stripeRefundId: "re_resend", amountCents: 4_000, createdAt: at(30) });
  const owed = (mark: boolean) => {
    const older = operation({ id: "op-older", amountCents: 4_000, createdAt: at(10), allocationPlan: [mark ? { ...resentSlice, madeRefundId: "re_resend" } : resentSlice] });
    const newer = operation({ id: "op-newer", amountCents: 4_000, createdAt: at(20), idempotencyKey: "refund_request_refund_rr2", allocationPlan: [{ paymentTransactionId: "txn-a", amountCents: 4_000 }] });
    return Object.fromEntries(openCardRefundOwedByOperation(payment([older, newer], [failed, resend], { refundedAmountCents: 4_000 })));
  };

  it("MUTATION: marked, the re-send is its own row's and the newer row still owes its slice", () => {
    expect(owed(true)).toEqual({ "op-older": 0, "op-newer": 4_000 });
  });

  it("unmarked, as before the mark: the newest row raised before the re-send takes it", () => {
    expect(owed(false)).toEqual({ "op-older": 4_000, "op-newer": 0 });
  });
});
