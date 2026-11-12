// #4992 / INV-PAY-146: the edit reserves its own-card debt before commit.
// Provider attempts consume that exact plan; a planning failure keeps the debt.
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  plan: vi.fn(), refund: vi.fn(), enqueue: vi.fn(), reserveOrganiser: vi.fn(),
  close: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { paymentRecoveryOperation: { updateMany: h.updateMany, findUnique: h.findUnique } } }));
vi.mock("@/lib/logger", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/payment-transactions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-transactions")),
  planStripeRefundAllocation: h.plan,
  refundPaymentTransactions: h.refund,
}));
vi.mock("@/lib/organiser-child-refund", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/organiser-child-refund")),
  reserveOrganiserChildModificationRefund: h.reserveOrganiser,
}));
vi.mock("@/lib/payment-recovery", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-recovery")),
  enqueueBookingModificationRefundRecovery: h.enqueue,
  markBookingModificationRefundRecoverySucceeded: h.close,
}));

import { executeBookingModificationRefund, reserveModificationRefundDebts } from "@/lib/booking-modification-settlement";
import { STRIPE_REFUND_EXCEEDS_CAPTURED_MESSAGE } from "@/lib/payment-transaction-status";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const plan = [{ paymentTransactionId: "txn-1", amountCents: 4000 }];
const tx = {} as Prisma.TransactionClient;
const args = () => ({ door: "dateChange" as const, plan: null, bookingId: "booking-1",
  payment: { id: "pay-1" } as never, bookingModificationId: "mod-1", pendingRefundAmountCents: 4000 });
const execute = (ownCardRefund: { plan: typeof plan | null } | null = { plan }) => executeBookingModificationRefund({
  format: CLUB_FORMAT_TEST, bookingId: "booking-1", door: "dateChange", failureMessage: "refund failed",
  result: { pendingRefundAmountCents: 4000, paymentId: "pay-1", bookingModificationId: "mod-1", organiserChildRefund: null, ownCardRefund } as never,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.plan.mockResolvedValue({ slices: plan, plannedAmountCents: 4000, totalRefundableCents: 4000 });
  h.reserveOrganiser.mockResolvedValue(null);
  h.enqueue.mockResolvedValue({ created: true });
  h.close.mockResolvedValue({ count: 1 });
  h.findUnique.mockResolvedValue({ id: "op-1", status: "PROCESSING", attempts: 1 });
  h.refund.mockResolvedValue({ refunds: [{ slice: plan[0], refundId: "re-1", paymentIntentId: "pi-1", amountCents: 4000, status: "succeeded" }] });
});

describe("reserveModificationRefundDebts", () => {
  it("reserves the frozen allocation with the edit's transaction and original key", async () => {
    expect(await reserveModificationRefundDebts(tx, args())).toEqual({ plan });
    expect(h.reserveOrganiser).toHaveBeenCalledWith(tx, args());
    expect(h.plan).toHaveBeenCalledWith({ paymentId: "pay-1", amountCents: 4000, store: tx });
    expect(h.enqueue).toHaveBeenCalledWith({ bookingId: "booking-1", paymentId: "pay-1", bookingModificationId: "mod-1",
      amountCents: 4000, allocationPlan: plan, stripeKeyPrefix: "mod_dates_refund_booking-1_mod-1", store: tx });
    expect(h.refund).not.toHaveBeenCalled();
  });

  it.each([
    ["no own-card debt (credit or Internet Banking)", { pendingRefundAmountCents: 0 }],
    ["no payment", { payment: null }],
    ["organiser-paid child", { plan: { amountCents: 4000, settlement: {} } }],
  ])("does not reserve an own-card row for %s", async (_label, changes) => {
    expect(await reserveModificationRefundDebts(tx, { ...args(), ...changes } as never)).toBeNull();
    expect(h.reserveOrganiser).toHaveBeenCalledOnce();
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each(["shortfall", "planning error"])("keeps the whole debt without a plan after a %s", async (kind) => {
    if (kind === "shortfall") h.plan.mockResolvedValue({ slices: [], plannedAmountCents: 0, totalRefundableCents: 0 });
    else h.plan.mockRejectedValue(new Error(STRIPE_REFUND_EXCEEDS_CAPTURED_MESSAGE));
    expect(await reserveModificationRefundDebts(tx, args())).toEqual({ plan: null });
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4000, store: tx }));
    expect(h.enqueue.mock.calls[0]![0]).not.toHaveProperty("allocationPlan");
    expect(h.refund).not.toHaveBeenCalled();
  });

  it.each([
    new Prisma.PrismaClientKnownRequestError("transaction aborted", { code: "P2028", clientVersion: "test" }),
    new Prisma.PrismaClientUnknownRequestError("database disconnected", { clientVersion: "test" }),
  ])("propagates database planning errors so the edit rolls back", async (error) => {
    h.plan.mockRejectedValue(error);
    await expect(reserveModificationRefundDebts(tx, args())).rejects.toBe(error);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("propagates a failed debt write so the edit cannot commit without it", async () => {
    const error = new Error("debt insert failed");
    h.enqueue.mockRejectedValue(error);
    await expect(reserveModificationRefundDebts(tx, args())).rejects.toBe(error);
  });
});

describe("executeBookingModificationRefund consumes the pre-persisted plan", () => {
  it("closes only on the allocation it sent and preserves the own-card email outcome", async () => {
    expect(await execute()).toEqual({ stripeRefundId: "re-1", refundDestination: "own" });
    expect(h.refund).toHaveBeenCalledWith(expect.objectContaining({ allocation: plan, idempotencyKeyPrefix: "mod_dates_refund_booking-1_mod-1" }));
    expect(h.close).toHaveBeenCalledWith({ idempotencyKey: "payment_recovery_modification_refund_mod-1", sentPlan: plan });
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("a lost close leaves the pre-persisted row for replay without planning or enqueueing", async () => {
    h.close.mockResolvedValue({ count: 0 });
    expect((await execute()).refundDestination).toBe("own");
    expect(h.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { idempotencyKey: "payment_recovery_modification_refund_mod-1" } }));
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("a failed close still reports the refund Stripe made and leaves recovery open", async () => {
    h.close.mockRejectedValue(new Error("close failed"));
    expect(await execute()).toEqual({ stripeRefundId: "re-1", refundDestination: "own" });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each([null, { plan: null }])("a planning-failed row is pending and never attempted or planned again", async (ownCardRefund) => {
    expect(await execute(ownCardRefund)).toEqual({ stripeRefundId: undefined, refundDestination: "own_card_pending" });
    expect(h.refund).not.toHaveBeenCalled();
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });
});
