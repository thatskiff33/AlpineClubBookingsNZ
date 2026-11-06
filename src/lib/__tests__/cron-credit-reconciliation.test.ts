import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  memberCreditGroupBy: vi.fn(),
  memberCreditCount: vi.fn(),
  isXeroConnected: vi.fn(),
  getRefundsMissingXeroCreditNotes: vi.fn(),
  findOrphanedAppliedCredits: vi.fn(),
  queueWaitingPaidAnotherWayNotesForPayment: vi.fn(),
  recoverLostLateCaptureRecordsForPayment: vi.fn(),
  findPaymentsWithUnrecordedLateCaptures: vi.fn(),
  readRefundCreditNoteGap: vi.fn(),
  findUnrecordedRefundNoteOperation: vi.fn(),
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
  readRefundCreditNoteGap: mocks.readRefundCreditNoteGap,
}));

vi.mock("@/lib/orphaned-applied-credit-backfill", () => ({
  findOrphanedAppliedCredits: mocks.findOrphanedAppliedCredits,
}));

vi.mock("@/lib/paid-another-way-receipt-note", () => ({
  queueWaitingPaidAnotherWayNotesForPayment: mocks.queueWaitingPaidAnotherWayNotesForPayment,
}));

// #4149: a late capture's lost record is checked for before any card note.
vi.mock("@/lib/late-capture-record-recovery", () => ({
  recoverLostLateCaptureRecordsForPayment: mocks.recoverLostLateCaptureRecordsForPayment,
}));
vi.mock("@/lib/late-capture-unrecorded-refunds", () => ({
  findPaymentsWithUnrecordedLateCaptures: mocks.findPaymentsWithUnrecordedLateCaptures,
}));

// #4688: a payment holding an unrecorded refund note gets no note from the self-heal.
vi.mock("@/lib/xero-refund-note-in-flight", () => ({
  findUnrecordedRefundNoteOperation: mocks.findUnrecordedRefundNoteOperation,
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
  mocks.queueWaitingPaidAnotherWayNotesForPayment.mockResolvedValue(0);
  mocks.recoverLostLateCaptureRecordsForPayment.mockResolvedValue({ recovered: [], unresolved: false });
  mocks.findPaymentsWithUnrecordedLateCaptures.mockResolvedValue([]);
  mocks.findUnrecordedRefundNoteOperation.mockResolvedValue(null);
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

  // #3924 round 9: a close whose note waits for a late capture's receipt, and
  // whose note step failed after that receipt reached Xero, is retried here -
  // the one idempotent step, under the approval task's row lock.
  it("MUTATION: runs the waiting note step for each payment its closes' own notes do not cover, and kicks the outbox", async () => {
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
      count: 2,
      payments: [
        { paymentId: "pay_bank", bookingId: "b_1", refundedAmountCents: 9000, cashRefundedCents: 9000, uncoveredCents: 9000, paidAnotherWayUncoveredCents: 9000, refundedAt: new Date("2026-07-01T00:00:00.000Z") },
        { paymentId: "pay_card", bookingId: "b_2", refundedAmountCents: 3000, cashRefundedCents: 3000, uncoveredCents: 3000, paidAnotherWayUncoveredCents: 0, refundedAt: new Date("2026-07-01T00:00:00.000Z") },
      ],
    });
    mocks.queueWaitingPaidAnotherWayNotesForPayment.mockResolvedValue(1);
    mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({ queueOperationId: null, message: "covered" });
    mocks.isXeroConnected.mockResolvedValue(true);

    await reconcileCreditBalances();

    expect(mocks.queueWaitingPaidAnotherWayNotesForPayment).toHaveBeenCalledTimes(1);
    expect(mocks.queueWaitingPaidAnotherWayNotesForPayment).toHaveBeenCalledWith("pay_bank");
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({ limit: 1 });
  });

  it("a failed note step is logged and never stops the payment's card ask", async () => {
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
      count: 1,
      payments: [
        { paymentId: "pay_both", bookingId: "b_2", refundedAmountCents: 12000, cashRefundedCents: 12000, uncoveredCents: 12000, paidAnotherWayUncoveredCents: 4000, refundedAt: new Date("2026-07-01T00:00:00.000Z") },
      ],
    });
    mocks.queueWaitingPaidAnotherWayNotesForPayment.mockRejectedValue(new Error("lock timeout"));

    await reconcileCreditBalances();

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay_both" }),
      "Failed to queue the refund note a paid-another-way close waits for",
    );
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

  it("MUTATION (#4688): queues no note, a close's or a card one, for a payment holding an unrecorded refund note, and still heals the others", async () => {
    const flagged = (paymentId: string) => ({
      paymentId,
      bookingId: `booking_${paymentId}`,
      refundedAmountCents: 8000,
      cashRefundedCents: 8000,
      uncoveredCents: 8000,
      paidAnotherWayUncoveredCents: 3000,
      refundedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({ count: 2, payments: [flagged("pay_fenced"), flagged("pay_open")] });
    mocks.findUnrecordedRefundNoteOperation.mockImplementation(async (paymentId: string) =>
      paymentId === "pay_fenced" ? { id: "op_unrecorded" } : null,
    );
    mocks.isXeroConnected.mockResolvedValue(true);

    const result = await reconcileCreditBalances();

    expect(mocks.findUnrecordedRefundNoteOperation).toHaveBeenCalledWith("pay_fenced");
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("pay_open", 5000);
    expect(mocks.queueWaitingPaidAnotherWayNotesForPayment).toHaveBeenCalledTimes(1);
    expect(mocks.queueWaitingPaidAnotherWayNotesForPayment).toHaveBeenCalledWith("pay_open");
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { paymentId: "pay_fenced", unrecordedOperationId: "op_unrecorded" },
      expect.stringContaining("#4688"),
    );
    // Still in the alert: the divergence stands until the officer resolves it.
    expect(result.refundsMissingXeroCreditNotes).toBe(2);
  });

  describe("a late capture whose automatic refund lost its record (#4149)", () => {
    const flagged = (paymentId: string, paidAnotherWayUncoveredCents = 0) => ({
      paymentId,
      bookingId: `booking_${paymentId}`,
      refundedAmountCents: 12000,
      cashRefundedCents: 12000,
      uncoveredCents: 12000,
      paidAnotherWayUncoveredCents,
      refundedAt: new Date("2026-07-01T00:00:00.000Z"),
    });

    it("checks every flagged payment for one before it queues that payment's card note", async () => {
      mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({ count: 1, payments: [flagged("pay_late")] });
      const order: string[] = [];
      mocks.recoverLostLateCaptureRecordsForPayment.mockImplementation(async (paymentId: string) => {
        order.push(`recover:${paymentId}`);
        return { recovered: ["pi_late"], unresolved: false };
      });
      mocks.readRefundCreditNoteGap.mockImplementation(async ({ id }: { id: string }) => {
        order.push(`gap:${id}`);
        return { uncoveredCents: 12000, paidAnotherWayUncoveredCents: 0 };
      });
      mocks.enqueueXeroRefundCreditNoteOperation.mockImplementation(async (paymentId: string) => {
        order.push(`enqueue:${paymentId}`);
        return { queueOperationId: null, message: "covered" };
      });

      await reconcileCreditBalances();

      // The record comes first, so the gap re-read and the enqueue's own
      // re-cap against the note-eligible cash no longer count its refund.
      expect(order).toEqual(["recover:pay_late", "gap:pay_late", "enqueue:pay_late"]);
    });

    it("checks the payments on its own list, which the gap never shows, before reading the gap - and each payment once", async () => {
      const order: string[] = [];
      mocks.findPaymentsWithUnrecordedLateCaptures.mockResolvedValue(["pay_marked", "pay_both"]);
      mocks.recoverLostLateCaptureRecordsForPayment.mockImplementation(async (paymentId: string) => {
        order.push(`recover:${paymentId}`);
        return { recovered: ["pi_late"], unresolved: paymentId === "pay_both" };
      });
      mocks.getRefundsMissingXeroCreditNotes.mockImplementation(async () => {
        order.push("gap-list");
        return { count: 1, payments: [flagged("pay_both")] };
      });

      await reconcileCreditBalances();

      expect(order).toEqual(["recover:pay_marked", "recover:pay_both", "gap-list"]);
      // Its own answer is kept: unresolved tonight, so no card note.
      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("still reads the gap list when its own list cannot be read", async () => {
      mocks.findPaymentsWithUnrecordedLateCaptures.mockRejectedValue(new Error("database is down"));
      mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({ count: 1, payments: [flagged("pay_ok")] });

      await reconcileCreditBalances();

      expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("pay_ok", 12000);
    });

    it("sizes the card ask from the gap re-read after a recovery, never from the gap read before it", async () => {
      mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
        count: 2,
        payments: [flagged("pay_recovered"), flagged("pay_plain")],
      });
      mocks.recoverLostLateCaptureRecordsForPayment.mockImplementation(async (paymentId: string) => ({
        recovered: paymentId === "pay_recovered" ? ["pi_late"] : [],
        unresolved: false,
      }));
      // The recovered capture's refund left the note-eligible cash: 3000 of the 12000 is still owed a note.
      mocks.readRefundCreditNoteGap.mockResolvedValue({ uncoveredCents: 3000, paidAnotherWayUncoveredCents: 0 });

      await reconcileCreditBalances();

      expect(mocks.readRefundCreditNoteGap).toHaveBeenCalledTimes(1);
      expect(mocks.readRefundCreditNoteGap).toHaveBeenCalledWith({
        id: "pay_recovered",
        bookingId: "booking_pay_recovered",
        refundedAmountCents: 12000,
      });
      expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("pay_recovered", 3000);
      expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("pay_plain", 12000);
    });

    it("queues nothing when the recovered capture was the whole gap", async () => {
      mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({ count: 1, payments: [flagged("pay_late")] });
      mocks.recoverLostLateCaptureRecordsForPayment.mockResolvedValue({ recovered: ["pi_late"], unresolved: false });
      mocks.readRefundCreditNoteGap.mockResolvedValue({ uncoveredCents: 0, paidAnotherWayUncoveredCents: 0 });

      await reconcileCreditBalances();

      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("raises no card note for a payment whose late captures could not be checked tonight, and still heals the others", async () => {
      mocks.getRefundsMissingXeroCreditNotes.mockResolvedValue({
        count: 2,
        payments: [flagged("pay_unchecked", 2000), flagged("pay_ok")],
      });
      mocks.recoverLostLateCaptureRecordsForPayment.mockImplementation(async (paymentId: string) => ({
        recovered: [],
        unresolved: paymentId === "pay_unchecked",
      }));

      await reconcileCreditBalances();

      // A whole-capture card note against the pre-cancel invoice is the
      // over-note #4149 is about; a night's delay on a genuine one is not.
      expect(mocks.enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalledWith("pay_unchecked", expect.anything());
      expect(mocks.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("pay_ok", 12000);
      // The close's own bank-transfer note step is not a card note and still runs.
      expect(mocks.queueWaitingPaidAnotherWayNotesForPayment).toHaveBeenCalledWith("pay_unchecked");
    });
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
