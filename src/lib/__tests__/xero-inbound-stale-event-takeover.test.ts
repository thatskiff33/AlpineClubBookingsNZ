import { beforeEach, describe, expect, it, vi } from "vitest";

// INV-INT-039 (#4921): the guarded takeover of a Xero inbound event a dead
// worker left PROCESSING. The concurrent race runs against real Postgres in
// xero-inbound-stale-event-takeover.realdb.test.ts; this suite pins the write
// shapes and the win/lose branches.
const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  txUpdateMany: vi.fn(),
  txDeleteMany: vi.fn(),
  transaction: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroInboundEvent: { findMany: mocks.findMany },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

import {
  takeOverStaleProcessingXeroInboundEvent,
  takeOverStaleProcessingXeroInboundEvents,
} from "@/lib/xero-inbound/stale-event-takeover";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const LEASE_EXPIRY = new Date(NOW.getTime() - 15 * 60_000);

describe("takeOverStaleProcessingXeroInboundEvent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        xeroInboundEvent: { updateMany: mocks.txUpdateMany },
        processedWebhookEvent: { deleteMany: mocks.txDeleteMany },
      }),
    );
    mocks.txDeleteMany.mockResolvedValue({ count: 1 });
  });

  it("resets the row to RECEIVED under the status + stale updatedAt guard, then clears its dedup row", async () => {
    mocks.txUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      takeOverStaleProcessingXeroInboundEvent({ id: "evt_1", correlationKey: "corr_1" }, NOW),
    ).resolves.toBe(true);

    expect(mocks.txUpdateMany).toHaveBeenCalledWith({
      where: { id: "evt_1", status: "PROCESSING", updatedAt: { lt: LEASE_EXPIRY } },
      data: { status: "RECEIVED", errorMessage: null, processedAt: null },
    });
    expect(mocks.txDeleteMany).toHaveBeenCalledWith({
      where: { eventId: "corr_1", source: "xero" },
    });
    expect(mocks.txUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txDeleteMany.mock.invocationCallOrder[0],
    );
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: a lost guard leaves the dedup row, so the winner's reprocess is not disturbed", async () => {
    mocks.txUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      takeOverStaleProcessingXeroInboundEvent({ id: "evt_1", correlationKey: "corr_1" }, NOW),
    ).resolves.toBe(false);

    expect(mocks.txDeleteMany).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe("takeOverStaleProcessingXeroInboundEvents", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        xeroInboundEvent: { updateMany: mocks.txUpdateMany },
        processedWebhookEvent: { deleteMany: mocks.txDeleteMany },
      }),
    );
    mocks.txDeleteMany.mockResolvedValue({ count: 1 });
  });

  it("selects only stale PROCESSING rows, oldest first, capped at the limit", async () => {
    mocks.findMany.mockResolvedValue([]);

    await expect(takeOverStaleProcessingXeroInboundEvents({ limit: 4, now: NOW })).resolves.toEqual({
      takenOver: 0,
      lost: 0,
    });

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { status: "PROCESSING", updatedAt: { lt: LEASE_EXPIRY } },
      select: { id: true, correlationKey: true },
      orderBy: { createdAt: "asc" },
      take: 4,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("counts the rows it took over and the ones another writer moved first", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "evt_a", correlationKey: "corr_a" },
      { id: "evt_b", correlationKey: "corr_b" },
      { id: "evt_c", correlationKey: "corr_c" },
    ]);
    mocks.txUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(takeOverStaleProcessingXeroInboundEvents({ limit: 10, now: NOW })).resolves.toEqual({
      takenOver: 2,
      lost: 1,
    });

    expect(mocks.txDeleteMany).toHaveBeenCalledTimes(2);
    expect(mocks.txDeleteMany).not.toHaveBeenCalledWith({
      where: { eventId: "corr_b", source: "xero" },
    });
  });
});
