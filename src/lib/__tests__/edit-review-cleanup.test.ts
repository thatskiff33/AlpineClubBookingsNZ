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
import { requireCalendarDate, requireClubTimeZone } from "@/lib/club-time";
import {
  applyOpenEditReviews,
  planEditReviewCleanup,
  prospectiveEditChangeFeeCents,
  type LoadedEditReview,
} from "@/lib/edit-review-cleanup";
import { EDIT_REVIEW_LATER_REMOVAL_COMPLETION_REFUSAL } from "@/lib/edit-review-guest-removed-since-raised";
import { editReviewHeadlineRebase } from "@/lib/edit-review-cleanup-headline";
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

  it("asks the resolver to refuse a later removal on its completions, and never on its dismissals", async () => {
    const resolveTask = vi.fn<(input: Record<string, unknown>, format: unknown) => Promise<undefined>>(async () => undefined);
    const dismiss = {
      action: "dismiss" as const,
      taskId: "task-2",
      bookingId: "booking-2",
      reason: "nothing-owing" as const,
      note: "nothing owed",
    };
    await applyOpenEditReviews({
      decisions: [complete, dismiss as never],
      actingMemberId: "member-1",
      format: CLUB_FORMAT_TEST,
      resolveTask: resolveTask as never,
    });
    expect(resolveTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ resolution: "completed", refuseIfGuestRemovedSinceRaised: true }),
      CLUB_FORMAT_TEST,
    );
    expect(resolveTask.mock.calls[1]![0]).not.toHaveProperty("refuseIfGuestRemovedSinceRaised");
  });

  it("MUTATION: a removal that lands after the re-read is re-planned and dismissed in the same run, with no money", async () => {
    const resolveTask = vi.fn<(input: { resolution: string }, format: unknown) => Promise<void>>(async (input) => {
      if (input.resolution === "completed") {
        throw new ManualBookingPaymentError(EDIT_REVIEW_LATER_REMOVAL_COMPLETION_REFUSAL, 409);
      }
    });
    const dismiss = {
      action: "dismiss" as const,
      taskId: "task-1",
      bookingId: "booking-1",
      reason: "consent-removed" as const,
      note: "already credited",
      removedGuestIds: ["guest-1"],
      remainingStrandGuestIds: [],
    };
    const refreshDecision = vi
      .fn<(planned: unknown) => Promise<typeof complete | typeof dismiss>>()
      .mockResolvedValueOnce(complete)
      .mockResolvedValueOnce(dismiss);
    const result = await applyOpenEditReviews({
      decisions: [complete],
      actingMemberId: "member-1",
      format: CLUB_FORMAT_TEST,
      resolveTask: resolveTask as never,
      refreshDecision,
    });
    expect(result.settled).toEqual([]);
    expect(result.closedWithNoMoney).toEqual([dismiss]);
    expect(result.leftOpen).toEqual([]);
    expect(resolveTask).toHaveBeenCalledTimes(2);
    expect(resolveTask).toHaveBeenLastCalledWith(expect.objectContaining({ resolution: "dismissed" }), CLUB_FORMAT_TEST);
  });

  it("leaves the review OPEN when the re-plan still wants money, rather than settling it a second way", async () => {
    const resolveTask = vi.fn(async () => {
      throw new ManualBookingPaymentError(EDIT_REVIEW_LATER_REMOVAL_COMPLETION_REFUSAL, 409);
    });
    const result = await applyOpenEditReviews({
      decisions: [complete],
      actingMemberId: "member-1",
      format: CLUB_FORMAT_TEST,
      resolveTask: resolveTask as never,
      refreshDecision: async () => complete,
    });
    expect(result.settled).toEqual([]);
    expect(result.closedWithNoMoney).toEqual([]);
    expect(result.leftOpen).toEqual([
      { bookingId: "booking-1", taskId: "task-1", message: EDIT_REVIEW_LATER_REMOVAL_COMPLETION_REFUSAL },
    ]);
    expect(resolveTask).toHaveBeenCalledTimes(1);
  });

  it("re-reads a consent removal before it settles, and dismisses instead of refunding", async () => {
    const resolveTask = vi.fn(async () => undefined);
    const dismiss = {
      action: "dismiss" as const,
      taskId: "task-1",
      bookingId: "booking-1",
      reason: "consent-removed" as const,
      note: "already credited",
      removedGuestIds: ["guest-1"],
      remainingStrandGuestIds: ["guest-2"],
    };
    const result = await applyOpenEditReviews({
      decisions: [complete],
      actingMemberId: "member-1",
      format: CLUB_FORMAT_TEST,
      resolveTask: resolveTask as never,
      refreshDecision: async () => dismiss,
    });
    expect(result.settled).toEqual([]);
    expect(result.closedWithNoMoney).toEqual([dismiss]);
    expect(resolveTask).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: "dismissed", taskId: "task-1" }),
      CLUB_FORMAT_TEST,
    );
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

/**
 * D8: the change fee the parked edit's own door would have charged. Policy:
 * 30 or more days out refunds 50%, nearer refunds nothing, so moving check-in
 * further out than 30 days from a near day costs half the booking.
 */
describe("pricing the change fee a parked date edit missed (D8)", () => {
  const zone = requireClubTimeZone("Pacific/Auckland");
  const policyDb = {
    bookingPeriod: { findMany: async () => [] },
    bookingDefaults: { findFirst: async () => null },
    lodge: { findFirst: async () => null },
    cancellationPolicy: {
      findMany: async () => [
        { id: "far", lodgeId: null, daysBeforeStay: 30, refundPercentage: 50, creditRefundPercentage: 50 },
        { id: "near", lodgeId: null, daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
      ],
    },
  } as never;
  // Saved on 1 Mar 2026: 10 Mar was 9 days out (0%) and 20 Jul was 141 days
  // out (50%). On the frozen run day, 1 Jul 2026, both sit in the 0% tier.
  const modification = {
    id: "mod-1",
    changeFeeCents: 0,
    previousData: { checkIn: "2026-03-10" },
    newData: { checkIn: "2026-07-20" },
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
  };
  const paid = {
    status: "PAID",
    lodgeId: "lodge-1",
    finalPriceCents: 30_000,
    payment: { id: "pay-1", status: "SUCCEEDED", amountCents: 30_000, xeroInvoiceId: null },
  };

  it("MUTATION: prices the move on the club day the edit was saved, not the day the script runs", async () => {
    await expect(prospectiveEditChangeFeeCents(paid, modification, policyDb, zone)).resolves.toBe(15_000);
  });

  it("MUTATION: charges a confirmed booking whose payment was captured, through the late-notice leaf's own gate", async () => {
    const capturedNotFlipped = { ...paid, status: "CONFIRMED" };
    await expect(prospectiveEditChangeFeeCents(capturedNotFlipped, modification, policyDb, zone)).resolves.toBe(15_000);
    const unpaid = { ...paid, status: "CONFIRMED", payment: null };
    await expect(prospectiveEditChangeFeeCents(unpaid, modification, policyDb, zone)).resolves.toBe(0);
  });

  it("prices nothing when check-in did not move or there is no modification", async () => {
    const sameDay = { ...modification, newData: { checkIn: "2026-03-10" } };
    await expect(prospectiveEditChangeFeeCents(paid, sameDay, policyDb, zone)).resolves.toBe(0);
    await expect(prospectiveEditChangeFeeCents(paid, null, policyDb, zone)).resolves.toBe(0);
  });
});
