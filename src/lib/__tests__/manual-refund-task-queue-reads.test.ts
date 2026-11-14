import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readDismissedManualRefundTasks } from "@/lib/manual-refund-task-queue-reads";

const findMany = vi.fn();

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

describe("dismissed tasks the finance queue offers to reopen", () => {
  it("does not offer an edit review", async () => {
    await readDismissedManualRefundTasks(
      { manualRefundTask: { findMany } } as never,
      new Date("2026-07-01T00:00:00.000Z"),
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "DISMISSED",
          kind: { not: "EDIT_FINANCIAL_REVIEW" },
        }),
      }),
    );
  });
});
