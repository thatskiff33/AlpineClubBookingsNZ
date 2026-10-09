import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  memberCreditGroupBy: vi.fn(),
  memberCreditCount: vi.fn(),
  isXeroConnected: vi.fn(),
  getRefundsMissingXeroCreditNotes: vi.fn(),
  findOrphanedAppliedCredits: vi.fn(),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberCredit: {
      groupBy: mocks.memberCreditGroupBy,
      count: mocks.memberCreditCount,
    },
  },
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroRefundCreditNoteOperation:
    mocks.enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected:
    mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));

vi.mock("@/lib/xero-admin-health", () => ({
  REFUND_CREDIT_NOTE_GRACE_HOURS: 24,
  getRefundsMissingXeroCreditNotes: mocks.getRefundsMissingXeroCreditNotes,
}));

vi.mock("@/lib/orphaned-applied-credit-backfill", () => ({
  findOrphanedAppliedCredits: mocks.findOrphanedAppliedCredits,
}));

vi.mock("@/lib/logger", () => ({
  default: mocks.logger,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from "@sentry/nextjs";
import { reconcileCreditBalances } from "@/lib/cron-credit-reconciliation";
import { resetObservabilityBridgeForTests } from "@/lib/observability-bridge";

beforeEach(() => {
  vi.clearAllMocks();
  resetObservabilityBridgeForTests();
  mocks.memberCreditGroupBy.mockResolvedValue([]);
  mocks.memberCreditCount.mockResolvedValue(0);
  mocks.isXeroConnected.mockResolvedValue(false);
  mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
    count: 0,
    payments: [],
  });
  mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
    queueOperationId: "op_heal_1",
    message: "queued",
  });
  mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue({
    found: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  });
  mocks.findOrphanedAppliedCredits.mockResolvedValue({ scanned: 0, findings: [] });
});

describe("reconcileCreditBalances", () => {
  it("includes refunds missing Xero credit notes in the daily cron result", async () => {
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
      count: 2,
      payments: [
        {
          paymentId: "pay_1",
          bookingId: "book_1",
          memberName: "Jane Doe",
          memberEmail: "jane@example.com",
          refundedAmountCents: 4200,
          refundedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    });

    const result = await reconcileCreditBalances();

    expect(result).toEqual({
      membersWithCredit: 0,
      totalCreditCents: 0,
      discrepancies: 0,
      refundsMissingXeroCreditNotes: 2,
      orphanedAppliedCredits: 0,
    });
    expect(mocks.getRefundsMissingXeroCreditNotes).toHaveBeenCalledWith({
      // #1354: raised so the self-heal pass re-enqueues a fuller set per tick.
      limit: 50,
    });
  });

  it("emits a structured daily alert without member PII when refunded Stripe payments are missing Xero credit notes", async () => {
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
      count: 1,
      payments: [
        {
          paymentId: "pay_1",
          bookingId: "book_1",
          memberName: "Jane Doe",
          memberEmail: "jane@example.com",
          refundedAmountCents: 4200,
          refundedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    });

    await reconcileCreditBalances();

    // The scoped bridge logs at error with a { scope } binding AND pages Sentry.
    expect(mocks.logger.error).toHaveBeenCalledWith(
      {
        scope: "cron",
        alert: "REFUNDS_MISSING_XERO_CREDIT_NOTES",
        count: 1,
        graceHours: 24,
        samplePayments: [
          {
            paymentId: "pay_1",
            bookingId: "book_1",
            refundedAmountCents: 4200,
            refundedAt: "2026-06-20T00:00:00.000Z",
          },
        ],
        href: "/admin/xero",
      },
      "1 refunded Stripe payment(s) are missing Xero refund credit notes"
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "1 refunded Stripe payment(s) are missing Xero refund credit notes",
      expect.objectContaining({
        level: "error",
        fingerprint: [
          "cron",
          "credit-reconciliation:refunds-missing-credit-notes",
        ],
      })
    );
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain(
      "jane@example.com"
    );
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain(
      "Jane Doe"
    );
    expect(JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls)).not.toContain(
      "jane@example.com"
    );
    expect(JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls)).not.toContain(
      "Jane Doe"
    );
  });

  // #3924 rounds 7 and 8 (money M1, `INV-PAY-122`): the self-heal's note is a
  // CARD note; a paid-another-way close's bank cash is only its own note's. The
  // gap says how much of it the close's own notes do not cover
  // (`paidAnotherWayUncoveredCents`, by the gap's own coverage), and only that
  // comes off - the readers' agreement is `card-refund-paid-another-way.realdb.test.ts`'s.
  it("MUTATION: never fills a paid-another-way close's uncovered bank cash with a card note", async () => {
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
      count: 2,
      payments: [
        // Only the close's own note is missing: nothing for a card note.
        { paymentId: "pay_bank", bookingId: "b_1", refundedAmountCents: 9000, cashRefundedCents: 9000, uncoveredCents: 9000, paidAnotherWayUncoveredCents: 9000, refundedAt: new Date("2026-07-01T00:00:00.000Z") },
        // A card refund is missing too: the card note asks only for that.
        { paymentId: "pay_both", bookingId: "b_2", refundedAmountCents: 12000, cashRefundedCents: 12000, uncoveredCents: 12000, paidAnotherWayUncoveredCents: 4000, refundedAt: new Date("2026-07-01T00:00:00.000Z") },
      ],
    });

    await reconcileCreditBalances();

    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("pay_both", 8000);
  });

  it("re-enqueues the CASH uncovered delta — never the refundedAmountCents mirror — for each flagged payment (#1354, #2902)", async () => {
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
      count: 2,
      payments: [
        {
          paymentId: "pay_1",
          bookingId: "booking_1",
          // Mirror, cash and uncovered all differ: the amount enqueued must
          // be the cash uncovered delta (#2902, INV-PAY-050), because the
          // mirror also counts account-credit dispositions.
          refundedAmountCents: 8000,
          cashRefundedCents: 6000,
          uncoveredCents: 5000,
          paidAnotherWayUncoveredCents: 0,
          refundedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          paymentId: "pay_2",
          bookingId: "booking_2",
          refundedAmountCents: 3000,
          cashRefundedCents: 3000,
          uncoveredCents: 3000,
          paidAnotherWayUncoveredCents: 0,
          refundedAt: new Date("2026-07-02T00:00:00.000Z"),
        },
      ],
    });
    mocks.isXeroConnected.mockResolvedValue(true);

    await reconcileCreditBalances();

    // The enqueue re-caps against the cash evidence internally (and the
    // execution path recomputes again), so passing the cash uncovered delta
    // re-enqueues exactly the missing note; repeats collapse into the
    // existing PENDING operation via the correlation-key dedup.
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "pay_1",
      5000
    );
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "pay_2",
      3000
    );
    expect(
      mocks.kickQueuedXeroOutboxOperationsIfConnected
    ).toHaveBeenCalledWith({ limit: 2 });
  });

  it("continues healing the remaining payments when one enqueue fails", async () => {
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
      count: 2,
      payments: [
        {
          paymentId: "pay_1",
          bookingId: "booking_1",
          refundedAmountCents: 8000,
          refundedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          paymentId: "pay_2",
          bookingId: "booking_2",
          refundedAmountCents: 3000,
          refundedAt: new Date("2026-07-02T00:00:00.000Z"),
        },
      ],
    });
    mocks.enqueueXeroRefundCreditNoteOperation
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce({ queueOperationId: "op_heal_2", message: "queued" });
    mocks.isXeroConnected.mockResolvedValue(true);

    await expect(reconcileCreditBalances()).resolves.toMatchObject({
      refundsMissingXeroCreditNotes: 2,
    });
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledTimes(2);
    expect(
      mocks.kickQueuedXeroOutboxOperationsIfConnected
    ).toHaveBeenCalledWith({ limit: 1 });
  });

  it("keeps existing negative-balance discrepancy behavior", async () => {
    mocks.memberCreditGroupBy.mockResolvedValue([
      { memberId: "member-negative", _sum: { amountCents: -1000 } },
      { memberId: "member-positive", _sum: { amountCents: 2500 } },
    ]);

    const result = await reconcileCreditBalances();

    expect(result).toEqual({
      membersWithCredit: 1,
      totalCreditCents: 2500,
      discrepancies: 1,
      refundsMissingXeroCreditNotes: 0,
      orphanedAppliedCredits: 0,
    });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      {
        count: 1,
        memberIds: ["member-negative"],
      },
      "Members with negative credit balance detected"
    );
  });

  it("alerts (alert-only, no auto-heal) when cancelled bookings hold orphaned applied credit (#1547)", async () => {
    mocks.findOrphanedAppliedCredits.mockResolvedValue({
      scanned: 3,
      findings: [
        { bookingId: "bk_1", memberId: "m_1", appliedCreditCents: 5000 },
        { bookingId: "bk_2", memberId: "m_2", appliedCreditCents: 2000 },
      ],
    });

    const result = await reconcileCreditBalances();

    expect(result.orphanedAppliedCredits).toBe(2);
    // The scoped cron bridge logs the alert at error AND pages Sentry with the
    // fingerprint tag; the sample context carries no PII beyond ids + cents.
    expect(mocks.logger.error).toHaveBeenCalledWith(
      {
        scope: "cron",
        alert: "ORPHANED_APPLIED_CREDITS",
        count: 2,
        sample: [
          { bookingId: "bk_1", memberId: "m_1", appliedCreditCents: 5000 },
          { bookingId: "bk_2", memberId: "m_2", appliedCreditCents: 2000 },
        ],
      },
      expect.stringContaining("a NEW credit-restore regression (#1547)")
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("cancelled booking(s) hold applied account credit"),
      expect.objectContaining({
        level: "error",
        fingerprint: ["cron", "credit-reconciliation:orphaned-applied-credits"],
      })
    );
  });

  it("does not alert on orphaned applied credit when there are none", async () => {
    mocks.findOrphanedAppliedCredits.mockResolvedValue({ scanned: 5, findings: [] });

    const result = await reconcileCreditBalances();

    expect(result.orphanedAppliedCredits).toBe(0);
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("cancelled booking(s) hold applied account credit"),
      expect.anything()
    );
  });
});
