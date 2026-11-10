import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The headline pass and the apply loop. The pricing cases live in
 * `edit-review-cleanup-plan.test.ts`; this file checks that apply calls the
 * existing settlement and re-base, rolls a dry-run back, and does not write
 * a payment, credit or Xero row of its own.
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  record: vi.fn(),
  executeRaw: vi.fn(),
  bookingFind: vi.fn(),
  taskFind: vi.fn(),
  modCount: vi.fn(),
  modFind: vi.fn(),
  ledgerCount: vi.fn(),
  paymentCreate: vi.fn(),
  creditCreate: vi.fn(),
  xeroCreate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (...args: unknown[]) => mocks.transaction(...args) },
}));
vi.mock("@/lib/stored-night-price-repair-store", () => ({
  recordReviewClosurePricing: (...args: unknown[]) => mocks.record(...args),
}));

import { ManualRefundTaskDirection } from "@prisma/client";
import { requireCalendarDate } from "@/lib/club-time";
import {
  applyOpenEditReviews,
  editReviewHeadlineRebase,
  planEditReviewCleanup,
  type LoadedEditReview,
} from "@/lib/edit-review-cleanup";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const TODAY = requireCalendarDate("2026-07-01");

const state = {
  totalPriceCents: 60_000,
  finalPriceCents: 60_000,
  guests: [{ id: "sam", priceCents: 30_000 }],
  reviews: [{ id: "task-1", bookingId: "booking-1", status: "DISMISSED" }] as Array<{
    id: string;
    bookingId: string;
    status: string;
  }>,
  history: 0,
  ledger: 0,
};

let committed = false;

const tx = {
  $executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  booking: {
    findUnique: () => mocks.bookingFind(),
  },
  manualRefundTask: { findMany: () => mocks.taskFind() },
  bookingModification: {
    count: () => mocks.modCount(),
    findFirst: () => mocks.modFind(),
  },
  bookingLedgerLine: { count: () => mocks.ledgerCount() },
  paymentTransaction: { create: (...args: unknown[]) => mocks.paymentCreate(...args) },
  memberCredit: { create: (...args: unknown[]) => mocks.creditCreate(...args) },
  xeroSyncOperation: { create: (...args: unknown[]) => mocks.xeroCreate(...args) },
};

function bookingRow() {
  return {
    id: "booking-1",
    status: "CONFIRMED",
    lodgeId: "lodge-1",
    memberId: "member-1",
    totalPriceCents: state.totalPriceCents,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: state.finalPriceCents,
    guests: state.guests,
    payment: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  committed = false;
  state.totalPriceCents = 60_000;
  state.finalPriceCents = 60_000;
  state.guests = [{ id: "sam", priceCents: 30_000 }];
  state.reviews = [{ id: "task-1", bookingId: "booking-1", status: "DISMISSED" }];
  state.history = 0;
  state.ledger = 0;
  mocks.executeRaw.mockResolvedValue(1);
  mocks.bookingFind.mockImplementation(async () => bookingRow());
  mocks.taskFind.mockImplementation(async () => state.reviews);
  mocks.modCount.mockImplementation(async () => state.history);
  mocks.modFind.mockResolvedValue({ id: "hist-1" });
  mocks.ledgerCount.mockImplementation(async () => state.ledger);
  mocks.record.mockImplementation(async () => {
    state.totalPriceCents = 30_000;
    state.finalPriceCents = 30_000;
    state.history += 1;
    state.ledger += 1;
  });
  mocks.transaction.mockImplementation(async (fn: (store: typeof tx) => Promise<unknown>) => {
    try {
      const result = await fn(tx);
      committed = true;
      return result;
    } catch (error) {
      committed = false;
      throw error;
    }
  });
});

const rebaseArgs = {
  bookingId: "booking-1",
  anchorTaskId: "task-1",
  actingMemberId: "member-1",
  todayAtClub: TODAY,
  format: CLUB_FORMAT_TEST,
  journal: {} as never,
};

describe("re-basing a frozen headline", () => {
  it("rewrites it through the closure poster, with an empty repair and no payment, credit or Xero write", async () => {
    const result = await editReviewHeadlineRebase({ ...rebaseArgs, commit: true });

    expect(result).toMatchObject({
      kind: "rebased",
      before: { totalPriceCents: 60_000 },
      after: { totalPriceCents: 30_000 },
      ledgerPosted: true,
    });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ plans: [], resolution: "dismissed" }));
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.bookingFind.mock.invocationCallOrder[0]!);
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
    expect(mocks.creditCreate).not.toHaveBeenCalled();
    expect(mocks.xeroCreate).not.toHaveBeenCalled();
    expect(committed).toBe(true);
  });

  it("leaves a booking that already matches, and one with no review, untouched", async () => {
    state.totalPriceCents = 30_000;
    state.finalPriceCents = 30_000;
    await expect(editReviewHeadlineRebase({ ...rebaseArgs, commit: true })).resolves.toMatchObject({ kind: "unchanged" });

    state.totalPriceCents = 60_000;
    state.finalPriceCents = 60_000;
    state.reviews = [];
    await expect(editReviewHeadlineRebase({ ...rebaseArgs, commit: true })).resolves.toMatchObject({ kind: "unchanged" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("rolls a dry-run back, so the preview is not kept", async () => {
    const result = await editReviewHeadlineRebase({ ...rebaseArgs, commit: false });
    expect(result).toMatchObject({ kind: "rebased", after: { totalPriceCents: 30_000 } });
    expect(committed).toBe(false);
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
  });

  it("lists a compare-and-set miss and keeps the task's booking unwritten by this pass", async () => {
    mocks.record.mockRejectedValue(new ManualBookingPaymentError("The booking changed.", 409));
    await expect(editReviewHeadlineRebase({ ...rebaseArgs, commit: true })).resolves.toMatchObject({
      kind: "raced",
      message: "The booking changed.",
    });
    expect(committed).toBe(false);
  });
});

describe("settling open reviews", () => {
  const complete = {
    action: "complete" as const,
    taskId: "task-1",
    bookingId: "booking-1",
    direction: ManualRefundTaskDirection.REFUND_TO_MEMBER,
    amountCents: 10_000,
    feeCents: 0,
    creditCents: 10_000,
    chargeCents: 0,
    note: "priced",
  };

  it("leaves a resolver refusal OPEN and does not turn it into a dismissal", async () => {
    const resolveTask = vi.fn(async () => {
      throw new ManualBookingPaymentError("The card cannot take this refund.", 409);
    });
    const result = await applyOpenEditReviews({
      decisions: [complete],
      actingMemberId: "member-1",
      format: CLUB_FORMAT_TEST,
      resolveTask: resolveTask as never,
    });
    expect(result.settled).toEqual([]);
    expect(result.closedWithNoMoney).toEqual([]);
    expect(result.leftOpen).toEqual([
      { bookingId: "booking-1", taskId: "task-1", message: "The card cannot take this refund." },
    ]);
    expect(resolveTask).toHaveBeenCalledTimes(1);
  });

  it("does not complete a task again once it is no longer OPEN", () => {
    const row = {
      id: "task-1",
      bookingId: "booking-1",
      status: "OPEN",
      reviewContext: { version: 9 },
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      prospectiveChangeFeeCents: 0,
      modification: null,
      booking: {
        id: "booking-1",
        status: "CONFIRMED",
        lodgeId: "lodge-1",
        memberId: "member-1",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        totalPriceCents: 30_000,
        discountCents: 0,
        promoAdjustmentCents: 0,
        finalPriceCents: 30_000,
        guests: [],
        payment: null,
      },
    } satisfies LoadedEditReview;
    expect(planEditReviewCleanup([row]).decisions).toHaveLength(1);
    expect(planEditReviewCleanup([{ ...row, status: "DISMISSED" }]).decisions).toEqual([]);
  });
});
