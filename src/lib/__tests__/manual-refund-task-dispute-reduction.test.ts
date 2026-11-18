/**
 * #4516 (owner decision, 15 Nov 2026, comment 6893252570): the reduce action on a disputed card payment's hand-back.
 * The door's order, its guards and what it writes, against a fake transaction; the journal's part withdrawal is
 * proved on the in-memory journal (`member-money-hand-backs.test.ts`) and on PostgreSQL
 * (`member-money-hand-backs.realdb.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(async () => 1),
  taskFindUnique: vi.fn(),
  taskFindUniqueOrThrow: vi.fn(),
  taskUpdateMany: vi.fn(async () => ({ count: 1 })),
  taskFindMany: vi.fn(async (): Promise<unknown[]> => []),
  disputeFindMany: vi.fn(async (): Promise<unknown[]> => []),
  lockBookingRow: vi.fn(async () => undefined),
  lockPayment: vi.fn(async () => undefined),
  withdraw: vi.fn(async () => true),
  audit: vi.fn(async () => undefined),
  transactionOptions: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown, options?: unknown) => (mocks.transactionOptions(options), fn({
      $executeRaw: (...a: unknown[]) => mocks.executeRaw(...(a as [])),
      manualRefundTask: { findUnique: mocks.taskFindUnique, findUniqueOrThrow: mocks.taskFindUniqueOrThrow, updateMany: mocks.taskUpdateMany, findMany: mocks.taskFindMany },
      stripeDispute: { findMany: mocks.disputeFindMany },
    })),
  },
}));
vi.mock("@/lib/member-money/doors", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-money/doors")),
  resolveBookingDoorClock: vi.fn(async () => ({ zone: "Pacific/Auckland", journal: { stub: "journal" } })),
  lockBookingRowForOwnerRead: mocks.lockBookingRow,
  withdrawRefundObligation: mocks.withdraw,
  postHandBackPayment: vi.fn(),
  postRefundObligation: vi.fn(),
}));
vi.mock("@/lib/payment-transactions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-transactions")),
  lockPaymentForRefundedTotal: mocks.lockPayment,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/booking-row-lock", () => ({ lockBookingRowForOwnerRead: mocks.lockBookingRow }));

import { DISPUTED_HAND_BACK_REDUCTION_STALE_MESSAGE, reduceDisputedHandBack } from "@/lib/manual-refund-task-dispute-reduction";
import {
  DISPUTED_HAND_BACK_FULLY_LOST_REDUCTION_REFUSAL, DISPUTED_HAND_BACK_NOTHING_TO_REDUCE, disputedHandBackReductionRefusal, NOT_A_DISPUTED_HAND_BACK_REDUCTION_REFUSAL,
} from "@/lib/manual-refund-task-copy";
import { memberMoneyEventKeys } from "@/lib/member-money";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";

const TASK = {
  id: "task-1", bookingId: "booking-1", paymentId: "payment-1", kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null as string | null, partPaymentReviewPaymentId: null,
  reason: "Booking booking-1 cancelled while its card payment is disputed", status: "OPEN", amountCents: 10_000, raisedAmountCents: 10_000, booking: { memberId: "member-1" },
};
const dispute = (status: string, amountCents: number, id = "dp_1", paymentId: string | null = "payment-1") => ({ bookingId: "booking-1", stripeDisputeId: id, status, amountCents, paymentId });
const reduce = (expectedAmountCents = 10_000, expectedReducedByCents = 3_000) =>
  reduceDisputedHandBack({ taskId: "task-1", actingMemberId: "officer-1", expectedAmountCents, expectedReducedByCents });
const withTask = (facts: Partial<typeof TASK>) => mocks.taskFindUniqueOrThrow.mockResolvedValue({ ...TASK, ...facts });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskFindUnique.mockResolvedValue({ bookingId: "booking-1" });
  withTask({});
  mocks.taskUpdateMany.mockResolvedValue({ count: 1 });
  mocks.disputeFindMany.mockResolvedValue([dispute("LOST", 3_000)]);
});

describe("reducing a disputed card payment's hand-back by a dispute lost for part of it", () => {
  it("reduces by exactly the lost cents, in order: lock(1), booking row, task, Payment row, disputes, guarded claim, journal, audit", async () => {
    expect(await reduce()).toEqual({ taskId: "task-1", wasCents: 10_000, reducedByCents: 3_000, stillOwedCents: 7_000 });

    expect(String((mocks.executeRaw.mock.calls[0] as unknown[])[0])).toContain("pg_advisory_xact_lock(1)");
    expect(mocks.taskUpdateMany).toHaveBeenCalledExactlyOnceWith({ where: { id: "task-1", status: "OPEN", amountCents: 10_000 }, data: { amountCents: 7_000 } });
    expect(mocks.withdraw).toHaveBeenCalledExactlyOnceWith(expect.anything(), { stub: "journal" }, expect.objectContaining({
      bookingId: "booking-1", scope: "hand-back", id: "task-1",
      part: { eventKey: memberMoneyEventKeys.handBackReduced("task-1", ["dp_1"]), amountCents: 3_000, debtorRead: "booking-row" },
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "booking-payment.manual-refund-task.reduce-by-lost-dispute", category: "payment",
      metadata: expect.objectContaining({ wasCents: 10_000, reducedByCents: 3_000, stillOwedCents: 7_000, lostDisputeIds: "dp_1" }) }), expect.anything());
    const order = [mocks.executeRaw, mocks.lockBookingRow, mocks.taskFindUniqueOrThrow, mocks.lockPayment, mocks.disputeFindMany, mocks.taskUpdateMany, mocks.withdraw, mocks.audit]
      .map((m) => m.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  // INV-LOCK-006 (#4998 merged after the lock(1) budget follow-up): it waits for lock(1) behind the same holders as
  // the dismissal it shares its decision with, so it opens on the shared budget, not Prisma's 2 s / 5 s defaults.
  it("opens its one transaction on the shared lock(1) budget", async () => {
    await reduce();
    expect(mocks.transactionOptions).toHaveBeenCalledExactlyOnceWith(LOCK1_HOLDER_TRANSACTION_BUDGET);
  });

  it("review: a legacy row with no raised amount records its original with the first reduction, so the same loss never reduces twice", async () => {
    withTask({ raisedAmountCents: null as unknown as number });
    await reduce();
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { amountCents: 7_000, raisedAmountCents: 10_000 } }));
  });

  it("a second lost dispute reduces again, by only what is not yet applied", async () => {
    withTask({ amountCents: 7_000 });
    mocks.disputeFindMany.mockResolvedValue([dispute("LOST", 3_000, "dp_1"), dispute("LOST", 2_000, "dp_2")]);

    expect(await reduce(7_000, 2_000)).toMatchObject({ reducedByCents: 2_000, stillOwedCents: 5_000 });
    expect(mocks.withdraw).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      part: expect.objectContaining({ eventKey: memberMoneyEventKeys.handBackReduced("task-1", ["dp_1", "dp_2"]), amountCents: 2_000 }) }));
  });

  it.each([
    ["the amount the officer saw has changed (a second click, a retry, a replay)", () => reduce(9_999, 3_000), DISPUTED_HAND_BACK_REDUCTION_STALE_MESSAGE],
    ["the reduction the officer confirmed is no longer the one the disputes give", () => reduce(10_000, 2_500), DISPUTED_HAND_BACK_REDUCTION_STALE_MESSAGE],
  ])("MUTATION: refuses when %s, writing nothing", async (_label, run, message) => {
    await expect(run()).rejects.toMatchObject({ status: 409, message });
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.withdraw).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ["the dispute is open", [dispute("OPEN", 3_000)], disputedHandBackReductionRefusal("OPEN")],
    ["the dispute was won", [dispute("WON", 3_000)], disputedHandBackReductionRefusal("WON")],
    ["the lost disputes cover all of it (dismiss instead)", [dispute("LOST", 10_000)], DISPUTED_HAND_BACK_FULLY_LOST_REDUCTION_REFUSAL],
    ["the only lost dispute is a group settlement's, not this payment's", [dispute("LOST", 3_000, "dp_s", null)], NOT_A_DISPUTED_HAND_BACK_REDUCTION_REFUSAL],
  ])("MUTATION: refuses while %s, writing nothing", async (_label, disputes, message) => {
    mocks.disputeFindMany.mockResolvedValue(disputes);
    await expect(reduce()).rejects.toMatchObject({ status: 409, message });
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it("refuses when every lost dispute has already reduced it", async () => {
    withTask({ amountCents: 7_000 });
    await expect(reduce(7_000, 3_000)).rejects.toMatchObject({ status: 409, message: DISPUTED_HAND_BACK_NOTHING_TO_REDUCE });
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("#4516 (owner, 18 Nov 2026): reduces a dispute-held edit's hand-back the same way, Payment row before the disputes", async () => {
    withTask({ occurrenceKey: "edit-refund-hand-back:mod-1" });
    expect(await reduce()).toEqual({ taskId: "task-1", wasCents: 10_000, reducedByCents: 3_000, stillOwedCents: 7_000 });
    expect(mocks.lockPayment.mock.invocationCallOrder[0]).toBeLessThan(mocks.disputeFindMany.mock.invocationCallOrder[0]!);
  });

  it("refuses a hand-back that is not a disputed card payment's (an appeal's bank part), reading no disputes", async () => {
    withTask({ occurrenceKey: "refund-request-hand-back:req-1" });
    await expect(reduce()).rejects.toMatchObject({ status: 409, message: NOT_A_DISPUTED_HAND_BACK_REDUCTION_REFUSAL });
    expect(mocks.disputeFindMany).not.toHaveBeenCalled();
  });

  it("refuses a closed task", async () => {
    withTask({ status: "COMPLETED" });
    await expect(reduce()).rejects.toMatchObject({ status: 409 });
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("MUTATION: a lost claim (another officer changed it first) withdraws and audits nothing", async () => {
    mocks.taskUpdateMany.mockResolvedValue({ count: 0 });
    await expect(reduce()).rejects.toMatchObject({ status: 409, message: DISPUTED_HAND_BACK_REDUCTION_STALE_MESSAGE });
    expect(mocks.withdraw).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
