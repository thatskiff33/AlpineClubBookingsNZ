import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  inboundCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      count: mocks.count,
    },
    xeroInboundEvent: {
      count: mocks.inboundCount,
    },
  },
}));

import {
  STALE_PROCESSING_XERO_INBOUND_EVENT_MINUTES,
  STALE_RUNNING_XERO_OPERATION_MINUTES,
  countStaleProcessingXeroInboundEvents,
  countStaleRunningXeroOperations,
  isStaleProcessingXeroInboundEvent,
  staleProcessingXeroInboundEventFilter,
  staleRunningXeroOperationFilter,
} from "@/lib/xero-stale-operations";

describe("stale RUNNING Xero operation visibility (issue #819)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a filter for RUNNING rows older than the threshold", () => {
    const now = new Date("2026-06-21T12:00:00.000Z");
    const filter = staleRunningXeroOperationFilter(now);

    expect(filter.status).toBe("RUNNING");
    expect(filter.startedAt.lt).toEqual(
      new Date(now.getTime() - STALE_RUNNING_XERO_OPERATION_MINUTES * 60_000),
    );
    // 15 minutes before noon.
    expect(filter.startedAt.lt.toISOString()).toBe("2026-06-21T11:45:00.000Z");
  });

  it("counts stale RUNNING operations via prisma with the threshold filter", async () => {
    mocks.count.mockResolvedValue(3);
    const now = new Date("2026-06-21T12:00:00.000Z");

    const result = await countStaleRunningXeroOperations(now);

    expect(result).toBe(3);
    expect(mocks.count).toHaveBeenCalledWith({
      where: {
        status: "RUNNING",
        startedAt: {
          lt: new Date("2026-06-21T11:45:00.000Z"),
        },
      },
    });
  });
});

describe("stale PROCESSING Xero inbound event visibility (issue #819/#815)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a filter for PROCESSING rows older than the threshold", () => {
    const now = new Date("2026-06-21T12:00:00.000Z");
    const filter = staleProcessingXeroInboundEventFilter(now);

    expect(filter.status).toBe("PROCESSING");
    expect(filter.updatedAt.lt).toEqual(
      new Date(
        now.getTime() - STALE_PROCESSING_XERO_INBOUND_EVENT_MINUTES * 60_000,
      ),
    );
    expect(filter.updatedAt.lt.toISOString()).toBe("2026-06-21T11:45:00.000Z");
  });

  it("counts stale PROCESSING inbound events via prisma with the threshold filter", async () => {
    mocks.inboundCount.mockResolvedValue(2);
    const now = new Date("2026-06-21T12:00:00.000Z");

    const result = await countStaleProcessingXeroInboundEvents(now);

    expect(result).toBe(2);
    expect(mocks.inboundCount).toHaveBeenCalledWith({
      where: {
        status: "PROCESSING",
        updatedAt: {
          lt: new Date("2026-06-21T11:45:00.000Z"),
        },
      },
    });
  });

  it("treats a claim older than the threshold as stale, and a fresh/null claim as not stale", () => {
    const now = new Date("2026-06-21T12:00:00.000Z");

    // Claimed 16 minutes ago -> stale.
    expect(
      isStaleProcessingXeroInboundEvent(
        new Date("2026-06-21T11:44:00.000Z"),
        now,
      ),
    ).toBe(true);
    // Claimed 5 minutes ago -> still in flight.
    expect(
      isStaleProcessingXeroInboundEvent(
        new Date("2026-06-21T11:55:00.000Z"),
        now,
      ),
    ).toBe(false);
    // No claim timestamp -> never steal it.
    expect(isStaleProcessingXeroInboundEvent(null, now)).toBe(false);
    expect(isStaleProcessingXeroInboundEvent(undefined, now)).toBe(false);
  });
});
