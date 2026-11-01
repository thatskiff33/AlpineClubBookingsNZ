import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  enqueueInvoice: vi.fn(),
  enqueueAllocation: vi.fn(),
  kick: vi.fn(),
  isXeroConnected: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { booking: { findUnique: mocks.findUnique } } }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueInvoice,
  enqueueXeroAppliedCreditAllocationOperation: mocks.enqueueAllocation,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kick,
}));
vi.mock("@/lib/xero", () => ({ isXeroConnected: mocks.isXeroConnected }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn() } }));

import {
  alreadySwitchedBody,
  isLiveSwitchState,
  queueSwitchInvoiceAfterCommit,
} from "@/lib/internet-banking-switch-replay";

const LIVE = { status: "PAYMENT_PENDING", deletedAt: null, organiserSettled: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(LIVE);
  mocks.enqueueInvoice.mockResolvedValue({ queueOperationId: "op-1" });
  mocks.enqueueAllocation.mockResolvedValue({ queueOperationId: null });
  mocks.isXeroConnected.mockResolvedValue(true);
  mocks.kick.mockResolvedValue(undefined);
});

describe("queueSwitchInvoiceAfterCommit (#4019 review)", () => {
  it.each(["PAYMENT_PENDING", "CONFIRMED"])("queues the invoice and the allocation for a %s booking", async (status) => {
    mocks.findUnique.mockResolvedValue({ ...LIVE, status });
    await queueSwitchInvoiceAfterCommit("booking-1", "member-1");
    expect(mocks.enqueueInvoice).toHaveBeenCalledWith("booking-1", { createdByMemberId: "member-1", invoiceEmailDelivery: null });
    expect(mocks.enqueueAllocation).toHaveBeenCalledWith("booking-1", { createdByMemberId: "member-1" });
    expect(mocks.kick).toHaveBeenCalledWith({ limit: 2 });
  });

  it.each([
    ["cancelled", { ...LIVE, status: "CANCELLED" }],
    ["paid", { ...LIVE, status: "PAID" }],
    ["deleted", { ...LIVE, deletedAt: new Date("2026-06-30T00:00:00.000Z") }],
    ["organiser-settled", { ...LIVE, organiserSettled: true }],
    ["gone", null],
  ])("queues nothing for a booking %s after the caller read it live", async (_label, current) => {
    // The caller (an unlocked early replay) read the booking live; a cancel
    // committed before this helper ran. The outbox enqueue reads no status.
    mocks.findUnique.mockResolvedValue(current);
    await queueSwitchInvoiceAfterCommit("booking-1", "member-1");
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      select: { status: true, deletedAt: true, organiserSettled: true },
    });
    expect(mocks.enqueueInvoice).not.toHaveBeenCalled();
    expect(mocks.enqueueAllocation).not.toHaveBeenCalled();
    expect(mocks.kick).not.toHaveBeenCalled();
  });

  it("logs and swallows an enqueue failure, as the first switch always did", async () => {
    mocks.enqueueInvoice.mockRejectedValue(new Error("outbox down"));
    await expect(queueSwitchInvoiceAfterCommit("booking-1", "member-1")).resolves.toBeUndefined();
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });
});

describe("isLiveSwitchState and alreadySwitchedBody", () => {
  it("is live only for an undeleted, self-paid PAYMENT_PENDING or CONFIRMED booking", () => {
    expect(isLiveSwitchState(LIVE)).toBe(true);
    expect(isLiveSwitchState({ ...LIVE, status: "CONFIRMED" })).toBe(true);
    expect(isLiveSwitchState({ ...LIVE, status: "CANCELLED" })).toBe(false);
    expect(isLiveSwitchState({ ...LIVE, deletedAt: new Date() })).toBe(false);
    expect(isLiveSwitchState({ ...LIVE, organiserSettled: true })).toBe(false);
  });

  it("offers the persisted hold until it is released, and the persisted reference over the computed one", () => {
    const holdUntil = new Date("2026-07-20T12:00:00.000Z");
    const payment = { reference: "PERSISTED", internetBankingHoldSlots: true, internetBankingHoldUntil: holdUntil, internetBankingHoldReleasedAt: null };
    expect(alreadySwitchedBody(payment, "COMPUTED")).toEqual({ reference: "PERSISTED", holdBedSlots: true, holdUntil });
    expect(alreadySwitchedBody({ ...payment, reference: null, internetBankingHoldReleasedAt: new Date() }, "COMPUTED"))
      .toEqual({ reference: "COMPUTED", holdBedSlots: false, holdUntil: null });
  });
});
