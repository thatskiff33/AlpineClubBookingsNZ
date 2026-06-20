import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      count: mocks.count,
    },
  },
}));

import {
  STALE_RUNNING_XERO_OPERATION_MINUTES,
  countStaleRunningXeroOperations,
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
