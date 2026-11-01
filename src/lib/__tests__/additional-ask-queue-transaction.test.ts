import { PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), lockPayment: vi.fn(), read: vi.fn(), global: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/payment-transactions", () => ({ lockPaymentForRefundedTotal: mocks.lockPayment }));

import {
  NO_ADDITIONAL_ASK,
  raiseReviewChargeAsk,
  reissueUnpaidAdditionalAsk,
  restateAdditionalAsk,
  sizeAdditionalAsk,
  sizeReviewChargeAsk,
} from "@/lib/additional-payment-ask";
import { sizeReissuedAskReplay } from "@/lib/additional-ask-recovery-replay";
import {
  CarriedAskChangedError,
  lockAdditionalAskQueue,
  withAdditionalAskQueueTransaction,
} from "@/lib/additional-ask-queue-transaction";

const unpaid = { additionalAmountCents: 7000, additionalPaymentStatus: PaymentStatus.PENDING };
const captured = { ...unpaid, additionalPaymentStatus: PaymentStatus.SUCCEEDED };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (write) => write({
    $executeRaw: mocks.global,
    payment: { findUnique: mocks.read },
  }));
  mocks.read.mockResolvedValue(unpaid);
});

/** Every constructor of an ask that carries the payment's live ask, sized while that ask is unpaid. */
const CARRYING_ASKS = [
  ["ordinary increase", () => sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid })],
  ["review charge", () => sizeReviewChargeAsk({ shareTotalCents: 3000, payment: unpaid })],
  ["re-issued reduction", () => sizeReissuedAskReplay({ frozenAmountCents: 3000, payment: unpaid })],
  ["currency re-issue", () => restateAdditionalAsk({ amountCents: 7000, carriedAskCents: 2000 }, unpaid)],
  ["raised ask currency re-issue", () => raiseReviewChargeAsk({ shareTotalCents: 6000, request: { amountCents: 7000, carriedAskCents: 2000 }, payment: unpaid })],
] as const;

describe("additional ask queue's sizing fence (#4442)", () => {
  it.each(CARRYING_ASKS)("records the live balance %s was sized on", (_name, size) => {
    expect(size().paymentBalanceCents).toBe(7000);
  });

  it.each(CARRYING_ASKS)("queues %s when the live balance is unchanged under the locks", async (_name, size) => {
    const write = vi.fn().mockResolvedValue("queued");
    await expect(withAdditionalAskQueueTransaction("payment", size(), write)).resolves.toBe("queued");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each(CARRYING_ASKS)("refuses %s when A captures after sizing, before any B write or cancellation", async (_name, size) => {
    const ask = size();
    mocks.read.mockResolvedValue(captured);
    const write = vi.fn();
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).rejects.toThrow("retry and re-plan");
    expect(write).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "payment" } }));
  });

  it("locks global, then Payment, then re-reads before queueing an unchanged balance", async () => {
    const order: string[] = [];
    mocks.global.mockImplementation(async () => { order.push("global"); });
    mocks.lockPayment.mockImplementation(async () => { order.push("payment"); });
    mocks.read.mockImplementation(async () => { order.push("read"); return unpaid; });
    const ask = sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid });
    await withAdditionalAskQueueTransaction("payment", ask, async () => { order.push("write-and-queue"); });
    expect(order).toEqual(["global", "payment", "read", "write-and-queue"]);
  });

  it("sizes a re-issue's balance from the Payment mirror, not the intent's own figure (review M1, M3)", async () => {
    // The intent asks 7500 while the mirror reads 7000: the re-issue keeps the
    // intent's figure, and its queue compares the mirror with the mirror.
    const ask = restateAdditionalAsk({ amountCents: 7500, carriedAskCents: 0 }, unpaid);
    expect(ask.amountCents).toBe(7500);
    expect(ask.paymentBalanceCents).toBe(7000);
    const write = vi.fn().mockResolvedValue("queued");
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).resolves.toBe("queued");
  });

  it("refuses with the typed error a door can answer", async () => {
    const ask = sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid });
    mocks.read.mockResolvedValue(captured);
    const refusal = await withAdditionalAskQueueTransaction("payment", ask, vi.fn()).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(CarriedAskChangedError);
    expect(refusal).toMatchObject({ code: "CARRIED_ASK_CHANGED" });
  });

  it("lockAdditionalAskQueue takes the global key, then the Payment row", async () => {
    const order: string[] = [];
    mocks.global.mockImplementation(async () => { order.push("global"); });
    mocks.lockPayment.mockImplementation(async (_store: unknown, paymentId: string) => { order.push(`payment:${paymentId}`); });
    await lockAdditionalAskQueue({ $executeRaw: mocks.global } as unknown as Parameters<typeof lockAdditionalAskQueue>[0], "payment");
    expect(order).toEqual(["global", "payment:payment"]);
    expect(String(mocks.global.mock.calls[0]?.[0])).toContain("pg_advisory_xact_lock(1)");
  });

  it("refuses when another ask was minted since sizing: it would be superseded without being carried", async () => {
    const ask = sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid });
    mocks.read.mockResolvedValue({ additionalAmountCents: 9000, additionalPaymentStatus: PaymentStatus.PENDING });
    const write = vi.fn();
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).rejects.toThrow("retry and re-plan");
    expect(write).not.toHaveBeenCalled();
  });

  it("treats a declined live ask as still owed: a decline alone does not refuse", async () => {
    const ask = sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid });
    mocks.read.mockResolvedValue({ ...unpaid, additionalPaymentStatus: PaymentStatus.FAILED });
    const write = vi.fn().mockResolvedValue("queued");
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).resolves.toBe("queued");
  });

  it.each([
    ["no ask", () => NO_ADDITIONAL_ASK],
    ["a reduction's re-issue sized in its own edit", () => reissueUnpaidAdditionalAsk({ askLeftCents: 3000 })],
  ])("reads nothing for %s, which carries no live ask", async (_name, size) => {
    const ask = size();
    expect(ask.paymentBalanceCents).toBeNull();
    mocks.read.mockResolvedValue(captured);
    const write = vi.fn().mockResolvedValue("queued");
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).resolves.toBe("queued");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("keeps folded waiting re-issues separate from the live balance", async () => {
    const ask = sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid, waitingReissuedAskCents: 2500 });
    const write = vi.fn().mockResolvedValue("queued");
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).resolves.toBe("queued");
    expect(ask.amountCents).toBe(12500);
    expect(ask.carriedCents).toBe(9500);
    mocks.read.mockResolvedValue(captured);
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).rejects.toThrow("retry and re-plan");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing payment without writing the replacement", async () => {
    mocks.read.mockResolvedValue(null);
    const ask = sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid });
    const write = vi.fn();
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).rejects.toThrow("not found");
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a failed sizing re-read without queueing anything", async () => {
    mocks.read.mockRejectedValue(new Error("database unavailable"));
    const ask = sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid });
    const write = vi.fn();
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).rejects.toThrow("database unavailable");
    expect(write).not.toHaveBeenCalled();
  });
});
