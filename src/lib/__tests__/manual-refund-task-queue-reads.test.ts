import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readDismissedManualRefundTasks } from "@/lib/manual-refund-task-queue-reads";

const findMany = vi.fn();

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

describe("dismissed tasks the finance queue offers to reopen", () => {
  it("does not offer an edit review, and still offers a legacy row with no kind", async () => {
    await readDismissedManualRefundTasks(
      { manualRefundTask: { findMany } } as never,
      new Date("2026-07-01T00:00:00.000Z"),
    );

    // #4344: the NULL arm is load-bearing - `kind` is nullable, and a bare
    // `kind: { not: ... }` is `kind <> ...` in SQL, which drops every NULL row.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "DISMISSED",
          OR: [{ kind: null }, { kind: { not: "EDIT_FINANCIAL_REVIEW" } }],
        }),
      }),
    );
    const where = findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where).not.toHaveProperty("kind");
  });
});
