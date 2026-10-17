import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentRecoveryOperationStatus } from "@prisma/client";

import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";

/**
 * #4166 (`INV-PAY-134`): `readCancelledCardRefund` finds the cancel's card
 * refunds that Stripe failed after a close recorded them - owed again on rows of
 * their own (`card_refund_failed_later_<refund>`, #4104) - and says where each
 * stands, for the narrative.
 *
 * MUTATION PROOF. Read every failed-later row of the booking and an edit's
 * failed refund is told as the cancel's; skip the marked slice and a slice made
 * beside a refusal is lost; skip the chain and a retry that failed too reads as
 * made again; drop the add-back and a paid-another-way close's made figure
 * loses the failed part twice.
 */
const db = vi.hoisted(() => ({ findMany: vi.fn(), findClose: vi.fn(), payments: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: { findMany: db.findMany },
    manualRefundTask: { findFirst: db.findClose },
    payment: { findMany: db.payments },
  },
}));

import { readCancelledCardRefund } from "@/lib/cancel-card-refund-shortfall-status";

const BOOKING = "booking-1";
const CANCEL_KEY = `booking_cancel_refund_recovery_${BOOKING}`;
const RAISED = new Date("2026-06-20T00:00:00.000Z");
const CLOSED = new Date("2026-06-20T00:00:10.000Z");
const MADE = new Date("2026-06-20T00:00:05.000Z");
const FAILED_AT = new Date("2026-06-25T00:00:00.000Z");
const RETRIED = new Date("2026-06-26T00:00:00.000Z");

type Op = {
  id: string;
  idempotencyKey: string;
  status: PaymentRecoveryOperationStatus;
  amountCents: number;
  allocationPlan: unknown;
  createdAt: Date;
  succeededAt: Date | null;
  attempts?: number;
  nextRetryAt?: Date | null;
};

/** The cancel's own row, closed by the close that recorded its REFUNDED event. */
const cancelRow = (plan: unknown = [{ paymentTransactionId: "txn-1", amountCents: 9_000 }], status: PaymentRecoveryOperationStatus = PaymentRecoveryOperationStatus.SUCCEEDED): Op => ({
  id: "op-cancel",
  idempotencyKey: CANCEL_KEY,
  status,
  amountCents: 9_000,
  allocationPlan: plan,
  createdAt: RAISED,
  succeededAt: status === PaymentRecoveryOperationStatus.SUCCEEDED ? CLOSED : null,
});

/** A failed-later row as the writer raises it: one slice, exactly the failed refund. */
const failedLaterRow = (refundId: string, extra: Partial<Op> = {}): Op => ({
  id: `op-fl-${refundId}`,
  idempotencyKey: `card_refund_failed_later_${refundId}`,
  status: PaymentRecoveryOperationStatus.PENDING,
  amountCents: 9_000,
  allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 9_000 }],
  createdAt: FAILED_AT,
  succeededAt: null,
  attempts: 0,
  nextRetryAt: new Date("2026-07-01T00:05:00.000Z"),
  ...extra,
});

const asRow = (op: Op) => ({ paymentId: "pay-1", attempts: 0, nextRetryAt: null, ...op });

type Refund = { stripeRefundId: string; amountCents: number; status: string; createdAt: Date; stripeCreatedAt?: Date };
const refund = (stripeRefundId: string, status: string, createdAt = MADE, amountCents = 9_000): Refund => ({ stripeRefundId, amountCents, status, createdAt });

function payment(ops: Op[], refunds: Refund[]) {
  return {
    id: "pay-1",
    status: "PARTIALLY_REFUNDED",
    amountCents: 12_000,
    refundedAmountCents: 0,
    recoveryOperations: ops.map((op) => ({ type: "REFUND_BOOKING_MODIFICATION", paymentTransactionId: null, ...op })),
    refunds: refunds.map((each) => ({ ...each, paymentTransactionId: "txn-1", stripeCreatedAt: each.stripeCreatedAt ?? each.createdAt })),
  };
}

/** The booking's cancel rows, then its failed-later rows, then their payment. */
function rows(own: Op[], failedLater: Op[], refunds: Refund[], others: Op[] = []) {
  db.findMany.mockResolvedValueOnce(own.map(asRow)).mockResolvedValueOnce(failedLater.map(asRow));
  db.payments.mockResolvedValue([payment([...own, ...others, ...failedLater], refunds)]);
}

describe("readCancelledCardRefund reads the cancel's refunds that failed later (#4166)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.findClose.mockResolvedValue(null);
  });

  it("MUTATION: the refund the cancel's closed row made, failed later, is told by its row - found by an exact prefix on the booking", async () => {
    rows([cancelRow()], [failedLaterRow("re_cancel")], [refund("re_cancel", "failed")]);

    expect(await readCancelledCardRefund(BOOKING)).toEqual({
      cardRefundState: "settled",
      cardRefundFailedLater: [{ amountCents: 9_000, state: "on-its-way" }],
    });
    expect(db.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      // On the bookingId index; `_` escaped so LIKE matches it literally (#4146).
      where: { bookingId: BOOKING, idempotencyKey: { startsWith: "card\\_refund\\_failed\\_later\\_" } },
    }));
  });

  it.each([
    ["dead (retries spent, or raised dead)", { attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS }, null, { state: "stalled" }],
    ["made again", { status: PaymentRecoveryOperationStatus.SUCCEEDED, succeededAt: RETRIED, nextRetryAt: null }, null, { state: "settled", madeAt: RETRIED }],
    [
      "closed paid another way, in part",
      { status: PaymentRecoveryOperationStatus.SUCCEEDED, succeededAt: RETRIED, nextRetryAt: null },
      { amountCents: 5_000, raisedAmountCents: 9_000 },
      { state: "paid-another-way", paidBackCents: 5_000, unpaidCents: 4_000 },
    ],
  ] as const)("its row %s", async (_label, extra, close, expected) => {
    rows([cancelRow()], [failedLaterRow("re_cancel", extra)], [refund("re_cancel", "failed")]);
    db.findClose.mockImplementation(async ({ where }: { where: { occurrenceKey: { in: string[] } } }) =>
      where.occurrenceKey.in.some((key) => key.includes("op-fl-re_cancel")) ? close : null,
    );

    expect((await readCancelledCardRefund(BOOKING)).cardRefundFailedLater).toEqual([{ amountCents: 9_000, ...expected }]);
  });

  it("MUTATION: another door's refund on the booking that failed later (an edit's) is not the cancel's", async () => {
    const edit: Op = {
      id: "op-edit",
      idempotencyKey: "payment_recovery_modification_refund_mod-1",
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      amountCents: 2_000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 2_000 }],
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
      succeededAt: new Date("2026-06-10T00:00:10.000Z"),
    };
    rows(
      [cancelRow()],
      [failedLaterRow("re_edit", { amountCents: 2_000, allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 2_000 }] })],
      [refund("re_edit", "failed", new Date("2026-06-10T00:00:05.000Z"), 2_000), refund("re_cancel", "succeeded")],
      [edit],
    );

    expect(await readCancelledCardRefund(BOOKING)).toEqual({ cardRefundState: "settled" });
  });

  it("MUTATION: a slice the cancel marked made beside a refusal, failed later, is the cancel's", async () => {
    const plan = [
      { paymentTransactionId: "txn-1", amountCents: 3_000, madeRefundId: "re_marked" },
      { paymentTransactionId: "txn-1", amountCents: 6_000, stripeKeySuffix: "refused1" },
    ];
    rows(
      [cancelRow(plan)],
      [failedLaterRow("re_marked", { amountCents: 3_000, allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 3_000 }] })],
      [refund("re_marked", "failed", MADE, 3_000), refund("re_rest", "succeeded", MADE, 6_000)],
    );

    expect((await readCancelledCardRefund(BOOKING)).cardRefundFailedLater).toEqual([{ amountCents: 3_000, state: "on-its-way" }]);
  });

  it("MUTATION: a retry that failed later too is told by the row that owes it - stalled, not made again", async () => {
    const first = failedLaterRow("re_cancel", { status: PaymentRecoveryOperationStatus.SUCCEEDED, succeededAt: RETRIED, nextRetryAt: null });
    const second = failedLaterRow("re_retry", { createdAt: new Date("2026-06-28T00:00:00.000Z"), attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS });
    rows([cancelRow()], [first, second], [refund("re_cancel", "failed"), refund("re_retry", "failed", new Date("2026-06-26T00:00:00.000Z"))]);

    expect((await readCancelledCardRefund(BOOKING)).cardRefundFailedLater).toEqual([{ amountCents: 9_000, state: "stalled" }]);
  });

  it("MUTATION: a retry failed in Stripe's same second is still the chain's - the row owing it never made it", async () => {
    const first = failedLaterRow("re_cancel", { status: PaymentRecoveryOperationStatus.SUCCEEDED, succeededAt: RETRIED, nextRetryAt: null });
    const second = failedLaterRow("re_retry", { createdAt: RETRIED, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS });
    rows([cancelRow()], [first, second], [refund("re_cancel", "failed"), refund("re_retry", "failed", RETRIED)]);

    expect((await readCancelledCardRefund(BOOKING)).cardRefundFailedLater).toEqual([{ amountCents: 9_000, state: "stalled" }]);
  });

  it("a row the LIKE wildcard matched that is not a failed-later key is ignored", async () => {
    rows([cancelRow()], [failedLaterRow("re_cancel", { idempotencyKey: "cardXrefund_failed_later_re_cancel" })], [refund("re_cancel", "failed")]);

    expect(await readCancelledCardRefund(BOOKING)).toEqual({ cardRefundState: "settled" });
    expect(db.payments).not.toHaveBeenCalled();
  });

  it("an open cancel row reads no failed-later rows: it moves its own slice instead (#4104)", async () => {
    db.findMany.mockResolvedValueOnce([asRow(cancelRow(undefined, PaymentRecoveryOperationStatus.PENDING))]);

    expect(await readCancelledCardRefund(BOOKING)).toEqual({ cardRefundState: "on-its-way" });
    expect(db.findMany).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: a paid-another-way close's made figure counts its part that failed later, which the narrative says by its own row", async () => {
    const plan = [
      { paymentTransactionId: "txn-1", amountCents: 6_000, madeRefundId: "re_marked" },
      { paymentTransactionId: "txn-1", amountCents: 3_000 },
    ];
    rows(
      [cancelRow(plan)],
      [failedLaterRow("re_marked", { amountCents: 6_000, allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 6_000 }] })],
      [refund("re_marked", "failed", MADE, 6_000)],
    );
    db.findClose.mockImplementation(async ({ where }: { where: { occurrenceKey: { in: string[] } } }) =>
      where.occurrenceKey.in.some((key) => key.includes("op-cancel")) ? { amountCents: 3_000, raisedAmountCents: 3_000 } : null,
    );

    expect(await readCancelledCardRefund(BOOKING)).toEqual({
      cardRefundState: "paid-another-way",
      cardRefundFailedLater: [{ amountCents: 6_000, state: "on-its-way" }],
      cardRefundClose: { paidBackCents: 3_000, unpaidCents: 0, madeCents: 6_000 },
    });
  });
});

// #4166 round 2: the writer records which row made the refund (`madeByOperationId`),
// and the page prefers that record to matching by amount.
describe("readCancelledCardRefund prefers the row the writer recorded as the refund's maker (#4166, F1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.findClose.mockResolvedValue(null);
  });
  const recordedBy = (maker: string | null) => [{ paymentTransactionId: "txn-1", amountCents: 9_000, madeByOperationId: maker }];
  /** R, another door's refund of the same amount on the same charge, recorded before X, the cancel's - both inside the cancel row's window. */
  const R_AT = new Date("2026-06-20T00:00:02.000Z");

  it("MUTATION: X (the cancel's) failed while R holds the cancel slice by amount - the recorded maker says it is the cancel's", async () => {
    rows([cancelRow()], [failedLaterRow("re_cancel", { allocationPlan: recordedBy("op-cancel") })], [refund("re_appeal", "succeeded", R_AT), refund("re_cancel", "failed")]);

    expect((await readCancelledCardRefund(BOOKING)).cardRefundFailedLater).toEqual([{ amountCents: 9_000, state: "on-its-way" }]);
  });

  it("MUTATION: R (the other door's) failed and fills the cancel slice by amount - the writer recorded no maker, so it is not the cancel's", async () => {
    rows([cancelRow()], [failedLaterRow("re_appeal", { allocationPlan: recordedBy(null) })], [refund("re_appeal", "failed", R_AT), refund("re_cancel", "succeeded")]);

    expect(await readCancelledCardRefund(BOOKING)).toEqual({ cardRefundState: "settled" });
  });
});

// #4166 round 2 (F2): a "Paid another way" close counted only what Stripe had
// made by then, and dated only what was recorded by then.
describe("readCancelledCardRefund tells a paid-another-way close's failed refund only as that close counted it (#4166, F2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.findClose.mockImplementation(async ({ where }: { where: { occurrenceKey: { in: string[] } } }) =>
      where.occurrenceKey.in.some((key) => key.includes("op-cancel")) ? { amountCents: 9_000, raisedAmountCents: 9_000 } : null,
    );
  });
  const byCancel = [{ paymentTransactionId: "txn-1", amountCents: 9_000, madeByOperationId: "op-cancel" }];

  it("MUTATION: made by Stripe after the close - the close never counted it: not told, and not added to its made figure", async () => {
    const after = new Date("2026-06-21T00:00:00.000Z");
    rows([cancelRow()], [failedLaterRow("re_late", { allocationPlan: byCancel })], [refund("re_late", "failed", after)]);

    expect(await readCancelledCardRefund(BOOKING)).toEqual({
      cardRefundState: "paid-another-way",
      cardRefundClose: { paidBackCents: 9_000, unpaidCents: 0, madeCents: 0 },
    });
  });

  it("MUTATION: made before the close, recorded after it - counted but not dated: told as undated, and added back", async () => {
    rows([cancelRow()], [failedLaterRow("re_late", { allocationPlan: byCancel })], [{ ...refund("re_late", "failed", new Date("2026-06-21T00:00:00.000Z")), stripeCreatedAt: MADE }]);

    expect(await readCancelledCardRefund(BOOKING)).toEqual({
      cardRefundState: "paid-another-way",
      cardRefundFailedLater: [{ amountCents: 9_000, state: "on-its-way", dated: false }],
      cardRefundClose: { paidBackCents: 9_000, unpaidCents: 0, madeCents: 9_000 },
    });
  });

  // #4210 round 3 (UX 5): a row raised to check against the close is a refund
  // that close did NOT count - never told as counted, said as a check of its own.
  describe("#4210: a row raised to check against the close", () => {
    const check = (status: PaymentRecoveryOperationStatus = PaymentRecoveryOperationStatus.PENDING) =>
      failedLaterRow("re_late", {
        status,
        amountCents: 4_000,
        attempts: 5,
        succeededAt: status === PaymentRecoveryOperationStatus.SUCCEEDED ? RETRIED : null,
        allocationPlan: [{ ...byCancel[0], amountCents: 4_000, paidAnotherWayCheck: { closedOperationId: "op-cancel", reason: "part-close" } }],
      });
    const late = [{ ...refund("re_late", "failed", new Date("2026-06-21T00:00:00.000Z")), stripeCreatedAt: MADE }];
    const partClose = { amountCents: 5_000, raisedAmountCents: 9_000 };

    it("MUTATION: still to check - not a failed-later part, not in the made figure, and its amount said as a check", async () => {
      db.findClose.mockImplementation(async ({ where }: { where: { occurrenceKey: { in: string[] } } }) =>
        where.occurrenceKey.in.some((key) => key.includes("op-cancel")) ? partClose : null,
      );
      rows([cancelRow()], [check()], late);
      expect(await readCancelledCardRefund(BOOKING)).toEqual({
        cardRefundState: "paid-another-way",
        cardRefundClose: { paidBackCents: 5_000, unpaidCents: 4_000, madeCents: 0, checkOpenCents: 4_000 },
      });
    });

    it("MUTATION: closed as checked - not owed (no record of its own) says nothing more", async () => {
      db.findClose.mockImplementation(async ({ where }: { where: { occurrenceKey: { in: string[] } } }) =>
        where.occurrenceKey.in.some((key) => key.includes("op-cancel")) && !where.occurrenceKey.in.some((key) => key.includes("op-fl")) ? partClose : null,
      );
      rows([cancelRow()], [check(PaymentRecoveryOperationStatus.SUCCEEDED)], late);
      expect(await readCancelledCardRefund(BOOKING)).toEqual({
        cardRefundState: "paid-another-way",
        cardRefundClose: { paidBackCents: 5_000, unpaidCents: 4_000, madeCents: 0 },
      });
    });
  });
});
