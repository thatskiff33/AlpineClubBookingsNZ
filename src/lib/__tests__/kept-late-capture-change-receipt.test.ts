// #4381 (`INV-PAY-144`, `INV-PAY-122`; `INV-SSOT`): the one "does Xero still
// owe this late capture its receipt?" check the receipt's enqueue, its worker
// and the kept-capture invoice's enqueue and worker ask. Before #4381 the
// receipt's three asked "is it still kept?" (DISMISSED only), so the worker
// cancelled the receipt a paid-another-way close had queued.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findClose: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
}));

vi.mock("@/lib/late-capture-paid-another-way", () => ({
  findLateCaptureRefundPaidAnotherWay: (...args: unknown[]) => mocks.findClose(...args),
}));

import { lateCaptureReceiptOwed } from "@/lib/kept-late-capture-change-receipt";

const task = vi.fn<(args: unknown) => Promise<{ status: string } | null>>();
const tx = { manualRefundTask: { findUnique: task }, paymentRecoveryOperation: {} } as never;
const CLOSE = { id: "close-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findClose.mockResolvedValue(null);
});

describe("lateCaptureReceiptOwed", () => {
  it("a kept capture owes its receipt", async () => {
    task.mockResolvedValue({ status: "DISMISSED" });
    await expect(lateCaptureReceiptOwed(tx, "pi_late")).resolves.toBe(true);
    expect(task).toHaveBeenCalledWith({ where: { lateCaptureApprovalIntentId: "pi_late" }, select: { status: true } });
  });

  it("MUTATION: an approved capture whose card refund was closed paid another way owes it too - the charge is still in the Stripe account", async () => {
    task.mockResolvedValue({ status: "COMPLETED" });
    mocks.findClose.mockResolvedValue(CLOSE);
    await expect(lateCaptureReceiptOwed(tx, "pi_late")).resolves.toBe(true);
    expect(mocks.findClose).toHaveBeenCalledWith("pi_late", tx);
  });

  it("an approved capture refunded by card, one awaiting a treasurer, and one no task owns owe nothing", async () => {
    task.mockResolvedValue({ status: "COMPLETED" });
    await expect(lateCaptureReceiptOwed(tx, "pi_late")).resolves.toBe(false);
    task.mockResolvedValue({ status: "OPEN" });
    mocks.findClose.mockResolvedValue(CLOSE);
    await expect(lateCaptureReceiptOwed(tx, "pi_late")).resolves.toBe(false);
    task.mockResolvedValue(null);
    await expect(lateCaptureReceiptOwed(tx, "pi_late")).resolves.toBe(false);
  });

  it("a close's plan, read before its record exists, counts the close being planned - on an approved task only", async () => {
    task.mockResolvedValue({ status: "COMPLETED" });
    await expect(lateCaptureReceiptOwed(tx, "pi_late", { closingPaidAnotherWay: true })).resolves.toBe(true);
    expect(mocks.findClose).not.toHaveBeenCalled();
    task.mockResolvedValue({ status: "OPEN" });
    await expect(lateCaptureReceiptOwed(tx, "pi_late", { closingPaidAnotherWay: true })).resolves.toBe(false);
  });
});
