import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2902 (INV-PAY-050): provider-backed Stripe CASH refund evidence.
 *
 * `Payment.refundedAmountCents` mirrors BOTH dispositions — Stripe cash and
 * member account credit — so the Xero refund-note pipeline must never read it
 * as cash. These tests pin the two resolution rules:
 *
 * - ANY PaymentRefund ledger rows → sum of `succeeded` rows, capped at the
 *   mirror ("provider-ledger"); failed/pending rows contribute nothing, and a
 *   ledger of only failures resolves to ZERO cash rather than falling back.
 * - NO ledger rows (pre-2026-05-09 history) → mirror minus the account-credit
 *   disposition ("legacy-mirror"), clamped at zero, excluding restore rows
 *   and non-refund credit types.
 */

const mocks = vi.hoisted(() => ({
  groupBy: vi.fn(),
  aggregate: vi.fn(),
  findTasks: vi.fn(),
  findOperations: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRefund: { groupBy: mocks.groupBy },
    memberCredit: { aggregate: mocks.aggregate },
    manualRefundTask: { findMany: mocks.findTasks },
    paymentRecoveryOperation: { findMany: mocks.findOperations },
  },
}));

import { resolveStripeCashRefundEvidence } from "@/lib/stripe-cash-refund-evidence";

const payment = {
  id: "pay_1",
  bookingId: "book_1",
  refundedAmountCents: 10000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.groupBy.mockResolvedValue([]);
  mocks.aggregate.mockResolvedValue({ _sum: { amountCents: null } });
  mocks.findTasks.mockResolvedValue([]);
  mocks.findOperations.mockResolvedValue([]);
});

describe("resolveStripeCashRefundEvidence — provider-ledger rule", () => {
  it("counts every PaymentRefund row except failed and canceled", async () => {
    // Owner decision, 21 Aug 2026: a refund Stripe has accepted but not yet
    // settled counts as cash, matching the refundedAmountCents mirror this
    // module replaces. `pending` is therefore INCLUDED (6000 + 1000), while
    // `failed` is not. Counting only `succeeded` would fix #2902's
    // account-credit defect and introduce the opposite error: a still-settling
    // refund reported as zero cash, under-stating the note.
    mocks.groupBy.mockResolvedValue([
      { status: "succeeded", _sum: { amountCents: 6000 }, _count: { _all: 2 } },
      { status: "failed", _sum: { amountCents: 4000 }, _count: { _all: 1 } },
      { status: "pending", _sum: { amountCents: 1000 }, _count: { _all: 1 } },
    ]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence).toEqual({
      cashRefundCents: 7000,
      countedRefundCents: 7000,
      refundLedgerRowCount: 4,
      accountCreditCents: 0,
      source: "provider-ledger",
    });
    expect(mocks.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["status"],
        where: { paymentId: "pay_1" },
      })
    );
    // The provider-ledger path never consults the credit disposition.
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it("caps the cash target at the refundedAmountCents mirror", async () => {
    // A ledger anomaly (succeeded rows above the mirror) must not make the
    // pipeline owe MORE notes than the settlement mirror ever recorded.
    mocks.groupBy.mockResolvedValue([
      { status: "succeeded", _sum: { amountCents: 12000 }, _count: { _all: 3 } },
    ]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.cashRefundCents).toBe(10000);
    expect(evidence.countedRefundCents).toBe(12000);
    expect(evidence.source).toBe("provider-ledger");
  });

  it("resolves a failed-only ledger to ZERO cash rather than falling back to the mirror", async () => {
    // The rows prove the ledger era; their statuses prove no cash moved.
    mocks.groupBy.mockResolvedValue([
      { status: "failed", _sum: { amountCents: 10000 }, _count: { _all: 1 } },
    ]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence).toMatchObject({
      cashRefundCents: 0,
      countedRefundCents: 0,
      refundLedgerRowCount: 1,
      source: "provider-ledger",
    });
  });

  it("counts a requires_action refund as cash", async () => {
    // Stripe can park a refund on requires_action; it is accepted, not failed,
    // so the mirror counted it and so must this module.
    mocks.groupBy.mockResolvedValue([
      {
        status: "requires_action",
        _sum: { amountCents: 2500 },
        _count: { _all: 1 },
      },
    ]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence).toMatchObject({
      cashRefundCents: 2500,
      countedRefundCents: 2500,
      source: "provider-ledger",
    });
  });

  it("resolves a canceled-only ledger to ZERO cash", async () => {
    // canceled joins failed in the exclusion list, so the rows still prove the
    // ledger era (no legacy fallback) while proving no cash moved.
    mocks.groupBy.mockResolvedValue([
      { status: "canceled", _sum: { amountCents: 8000 }, _count: { _all: 2 } },
    ]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence).toMatchObject({
      cashRefundCents: 0,
      countedRefundCents: 0,
      refundLedgerRowCount: 2,
      source: "provider-ledger",
    });
  });

  it("still clamps an in-progress overstatement to the mirror", async () => {
    // The one non-fail-safe limit is bounded: counting in-progress cash can
    // never claim more than refundedAmountCents actually records.
    mocks.groupBy.mockResolvedValue([
      { status: "pending", _sum: { amountCents: 99000 }, _count: { _all: 1 } },
    ]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.cashRefundCents).toBe(10000);
    expect(evidence.countedRefundCents).toBe(99000);
  });

  it("clamps a negative succeeded sum to zero", async () => {
    mocks.groupBy.mockResolvedValue([
      { status: "succeeded", _sum: { amountCents: -500 }, _count: { _all: 1 } },
    ]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.cashRefundCents).toBe(0);
    expect(evidence.countedRefundCents).toBe(0);
  });
});

describe("resolveStripeCashRefundEvidence — legacy-mirror fallback", () => {
  it("subtracts the account-credit disposition from the mirror when no ledger rows exist", async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { amountCents: 3500 } });

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence).toEqual({
      cashRefundCents: 6500,
      countedRefundCents: 0,
      refundLedgerRowCount: 0,
      accountCreditCents: 3500,
      source: "legacy-mirror",
    });
    // The disposition query is scoped to the payment's booking, to the two
    // refund credit types, to positive rows, and excludes restores.
    expect(mocks.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceBookingId: "book_1",
          type: {
            in: ["CANCELLATION_REFUND", "BOOKING_MODIFICATION_REFUND"],
          },
          amountCents: { gt: 0 },
          restoredFromBookingId: null,
        }),
      })
    );
  });

  it("resolves an account-credit-only cancellation to ZERO cash (#2902 defect shape)", async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { amountCents: 10000 } });

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.cashRefundCents).toBe(0);
    expect(evidence.accountCreditCents).toBe(10000);
    expect(evidence.source).toBe("legacy-mirror");
  });

  it("clamps at zero when the credit disposition exceeds the mirror", async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { amountCents: 15000 } });

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.cashRefundCents).toBe(0);
  });

  it("treats a creditless legacy payment as fully cash-refunded", async () => {
    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence).toMatchObject({
      cashRefundCents: 10000,
      accountCreditCents: 0,
      source: "legacy-mirror",
    });
  });

  it("clamps a negative mirror to zero", async () => {
    const evidence = await resolveStripeCashRefundEvidence({
      ...payment,
      refundedAmountCents: -100,
    });

    expect(evidence.cashRefundCents).toBe(0);
  });
});

describe("resolveStripeCashRefundEvidence — transaction client", () => {
  it("queries through the provided transaction client, not the global one", async () => {
    const tx = {
      paymentRefund: {
        groupBy: vi.fn().mockResolvedValue([
          {
            status: "succeeded",
            _sum: { amountCents: 2500 },
            _count: { _all: 1 },
          },
        ]),
      },
      memberCredit: { aggregate: vi.fn() },
      // #3924 round 4: a close written in the caller's own transaction is seen.
      manualRefundTask: { findMany: vi.fn().mockResolvedValue([]) },
      paymentRecoveryOperation: { findMany: vi.fn() },
    };

    const evidence = await resolveStripeCashRefundEvidence(
      payment,
      tx as never
    );

    expect(evidence.cashRefundCents).toBe(2500);
    expect(tx.paymentRefund.groupBy).toHaveBeenCalledTimes(1);
    expect(tx.manualRefundTask.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.groupBy).not.toHaveBeenCalled();
    expect(mocks.findTasks).not.toHaveBeenCalled();
  });
});

/**
 * #3924 round 4 (money review, M1; `INV-PAY-121`): a card refund closed as
 * "Paid another way" raised the mirror with no refund row. Read from its
 * persisted record (a COMPLETED task under its own key), never `lastError`.
 * Round 5 (owner, 8 Oct 2026: "Raise a refund note for all"): every kind's
 * close takes a note where there is an invoice to credit, and the key records
 * whether it did.
 */
describe("resolveStripeCashRefundEvidence - a card refund closed as paid another way", () => {
  const noted = { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "card-refund-paid-another-way:op-edit", amountCents: 3000 };
  const unnoted = {
    kind: "CANCELLED_BOOKING_HAND_BACK",
    occurrenceKey: "card-refund-paid-another-way:op-no-invoice:no-xero-note",
    amountCents: 4000,
  };

  it("legacy mirror: a close with no invoice to credit (no note) is not cash the self-heal may note", async () => {
    // $100 refunded on the mirror, no refund rows: $40 of it went back by bank
    // with no invoice to credit, so no note was queued. Counted as cash, the
    // nightly self-heal would raise a card note settled from the Stripe account.
    mocks.findTasks.mockResolvedValue([unnoted]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.source).toBe("legacy-mirror");
    expect(evidence.cashRefundCents).toBe(6000);
    expect(mocks.findTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paymentId: "pay_1",
          status: "COMPLETED",
          occurrenceKey: { startsWith: "card-refund-paid-another-way:" },
        }),
      }),
    );
  });

  it("MUTATION: legacy mirror: a noted close of any kind keeps its cash - its own note answers it", async () => {
    mocks.findTasks.mockResolvedValue([noted, unnoted]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.cashRefundCents).toBe(6000);
  });

  it("MUTATION: provider ledger: a noted close is added to the card rows, so its note is sized against it", async () => {
    mocks.groupBy.mockResolvedValue([{ status: "succeeded", _sum: { amountCents: 2000 }, _count: { _all: 1 } }]);
    mocks.findTasks.mockResolvedValue([noted, unnoted]);

    const evidence = await resolveStripeCashRefundEvidence(payment);

    expect(evidence.source).toBe("provider-ledger");
    expect(evidence.countedRefundCents).toBe(2000);
    // $20 by card + the noted close's $30 by bank; the un-noted $40 never.
    expect(evidence.cashRefundCents).toBe(5000);
  });

  it("reads the record only: never the operation", async () => {
    mocks.findTasks.mockResolvedValue([noted]);
    await resolveStripeCashRefundEvidence(payment);
    expect(mocks.findOperations).not.toHaveBeenCalled();
  });
});
