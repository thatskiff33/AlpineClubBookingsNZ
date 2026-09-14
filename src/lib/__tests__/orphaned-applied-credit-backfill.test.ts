import { beforeEach, describe, expect, it, vi } from "vitest";

// The heal path's collaborators are mocked; the DETECTION predicate uses the
// REAL paymentHasCaptureEvidence (imported transitively from
// cancel-flattened-payment-backfill) so capture evidence is exercised for real.
const mocks = vi.hoisted(() => ({
  restoreCreditFromBooking: vi.fn(),
  lockMemberCreditLedger: vi.fn(),
  createAuditLog: vi.fn(),
  recordBookingEvent: vi.fn(),
}));

vi.mock("@/lib/member-credit", () => ({
  restoreCreditFromBooking: mocks.restoreCreditFromBooking,
  lockMemberCreditLedger: mocks.lockMemberCreditLedger,
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
}));

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));

import {
  findOrphanedAppliedCredits,
  formatOrphanedAppliedCreditReport,
  healOrphanedAppliedCredits,
} from "@/lib/orphaned-applied-credit-backfill";

type CandidateOverrides = Record<string, unknown>;

function candidate(overrides: CandidateOverrides = {}) {
  return {
    id: "bk",
    memberId: "m",
    status: "CANCELLED",
    deletedAt: null,
    creditsApplied: [{ amountCents: -5000 }],
    creditsFromCancellation: [],
    payment: null,
    ...overrides,
  };
}

function payment(overrides: CandidateOverrides = {}) {
  return {
    id: "pay",
    bookingId: "bk",
    source: "STRIPE",
    status: "PROCESSING",
    amountCents: 5000,
    refundedAmountCents: 0,
    transactions: [],
    ...overrides,
  };
}

const orphanNeverCaptured = candidate({
  id: "bk1",
  memberId: "m1",
  creditsApplied: [{ amountCents: -5000 }],
  payment: payment({ id: "pay1", bookingId: "bk1", transactions: [] }),
});
const orphanNoPayment = candidate({
  id: "bk2",
  memberId: "m2",
  creditsApplied: [{ amountCents: -3000 }],
  payment: null,
});
const orphanSoftDeleted = candidate({
  id: "bk3",
  memberId: "m3",
  deletedAt: new Date("2026-06-01T00:00:00.000Z"),
  creditsApplied: [{ amountCents: -2000 }],
  payment: null,
});
const excludedCaptured = candidate({
  id: "bk4",
  memberId: "m4",
  creditsApplied: [{ amountCents: -4000 }],
  // 0%-tier paid cancel: captured money, restore amount 0 wrote no row.
  payment: payment({
    id: "pay4",
    bookingId: "bk4",
    status: "SUCCEEDED",
    transactions: [{ status: "SUCCEEDED" }],
  }),
});
const excludedRestored = candidate({
  id: "bk5",
  memberId: "m5",
  creditsApplied: [{ amountCents: -6000 }],
  // A healthy restore row already exists.
  creditsFromCancellation: [{ id: "r5" }],
  payment: null,
});
const excludedHeldCredit = candidate({
  id: "bk6",
  memberId: "m6",
  creditsApplied: [{ amountCents: -7000 }],
  // held-as-credit refund: CANCELLATION_REFUND row + captured payment.
  creditsFromCancellation: [{ id: "r6" }],
  payment: payment({
    id: "pay6",
    bookingId: "bk6",
    status: "SUCCEEDED",
    transactions: [{ status: "SUCCEEDED" }],
  }),
});
const excludedNonCancelled = candidate({
  id: "bk7",
  memberId: "m7",
  status: "PAID",
  creditsApplied: [{ amountCents: -8000 }],
  payment: null,
});
const excludedZeroDollarCreditCovered = candidate({
  id: "bk8",
  memberId: "m8",
  // Fully-credit-covered booking: $0 SUCCEEDED payment with NO transaction
  // ledger rows (booking-create), settled straight to PAID. A 0%-tier /
  // fee-swallowed cancel writes no restore row — the policy retained the
  // credit; healing it would hand it back.
  creditsApplied: [{ amountCents: -9000 }],
  payment: payment({
    id: "pay8",
    bookingId: "bk8",
    status: "SUCCEEDED",
    amountCents: 0,
    transactions: [],
  }),
});

function makeScanStore(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
  return { store: { booking: { findMany } }, findMany };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findOrphanedAppliedCredits — predicate precision", () => {
  it("includes never-captured, no-payment, and soft-deleted orphans and excludes the legitimate shapes", async () => {
    const { store } = makeScanStore([
      orphanNeverCaptured,
      orphanNoPayment,
      orphanSoftDeleted,
      excludedCaptured,
      excludedRestored,
      excludedHeldCredit,
      excludedNonCancelled,
      excludedZeroDollarCreditCovered,
    ]);

    const result = await findOrphanedAppliedCredits({ store: store as never });

    expect(result.scanned).toBe(8);
    expect(result.findings.map((f) => f.bookingId)).toEqual([
      "bk1",
      "bk2",
      "bk3",
    ]);
    // The soft-deleted orphan carries its deletedAt into the finding.
    const softDeleted = result.findings.find((f) => f.bookingId === "bk3");
    expect(softDeleted?.bookingDeletedAt).toBe("2026-06-01T00:00:00.000Z");
    // Positive Σ|amountCents| per finding.
    expect(
      result.findings.find((f) => f.bookingId === "bk1")?.appliedCreditCents
    ).toBe(5000);
    // A find is read-only: no ledger, audit, or event writes.
    expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });
});

describe("healOrphanedAppliedCredits", () => {
  it("restores the credit and writes the audit + CREDITED event for each orphan", async () => {
    const txFindUnique = vi.fn().mockResolvedValue(orphanNeverCaptured);
    const store = {
      booking: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([orphanNeverCaptured])
          .mockResolvedValue([]),
      },
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
        cb({ booking: { findUnique: txFindUnique } })
      ),
    };
    mocks.restoreCreditFromBooking.mockResolvedValue(5000);

    const result = await healOrphanedAppliedCredits({ store: store as never });

    expect(result.healed).toEqual([
      { bookingId: "bk1", memberId: "m1", restoredCents: 5000 },
    ]);
    expect(result.skipped).toHaveLength(0);
    // The heal ran under the member-credit ledger lock and re-checked the row.
    expect(mocks.lockMemberCreditLedger).toHaveBeenCalledTimes(1);
    expect(txFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bk1" } })
    );
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledWith(
      "m1",
      "bk1",
      expect.anything()
    );
    // Critical money audit with a null actor and the member as subject.
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.credit.orphan-restore.backfill",
        memberId: null,
        subjectMemberId: "m1",
        category: "payment",
        severity: "critical",
        metadata: { restoredCents: 5000, appliedRowCount: 1 },
      }),
      expect.anything()
    );
    // The CREDITED narrative event is written AFTER the tx commits.
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "bk1",
        type: "CREDITED",
        amountCents: 5000,
      })
    );
  });

  it("is idempotent: a second run whose under-lock re-check finds a restore row skips and writes nothing", async () => {
    // The scan still returns the orphan shape, but under the lock a prior heal
    // has already written the CANCELLATION_REFUND row -> re-check fails -> skip.
    const restoredUnderLock = {
      ...orphanNeverCaptured,
      creditsFromCancellation: [{ id: "r1" }],
    };
    const txFindUnique = vi.fn().mockResolvedValue(restoredUnderLock);
    const store = {
      booking: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([orphanNeverCaptured])
          .mockResolvedValue([]),
      },
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
        cb({ booking: { findUnique: txFindUnique } })
      ),
    };

    const result = await healOrphanedAppliedCredits({ store: store as never });

    expect(result.healed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].bookingId).toBe("bk1");
    expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });
});

describe("formatOrphanedAppliedCreditReport", () => {
  it("summarises a dry run with a per-finding line and the re-run tail", () => {
    const report = formatOrphanedAppliedCreditReport(
      {
        scanned: 3,
        findings: [
          {
            bookingId: "bk1",
            memberId: "m1",
            appliedCreditCents: 5000,
            appliedRowCount: 1,
            paymentId: "pay1",
            paymentSource: "STRIPE",
            paymentStatus: "PROCESSING",
            bookingDeletedAt: null,
          },
        ],
      },
      "dry-run"
    );
    expect(report).toContain("dry-run");
    expect(report).toContain("booking=bk1 member=m1 appliedCreditCents=5000");
    expect(report).toContain("Re-run with --apply");
  });

  it("reports a clean scan", () => {
    const report = formatOrphanedAppliedCreditReport(
      { scanned: 0, findings: [] },
      "apply"
    );
    expect(report).toContain("No orphaned applied credit found");
  });
});
