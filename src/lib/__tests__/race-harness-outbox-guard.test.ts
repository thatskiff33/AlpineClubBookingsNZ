import { describe, expect, it, vi } from "vitest";

import { assertNoForeignPendingXeroOperations } from "./support/race-harness-outbox-guard";

type PendingRow = { id: string; localModel: string | null; localId: string | null; queueType: string | null };
function storeWith(pending: PendingRow[]) {
  const findMany = vi.fn().mockResolvedValue(pending);
  return { store: { xeroSyncOperation: { findMany } } as unknown as Parameters<typeof assertNoForeignPendingXeroOperations>[0], findMany };
}

describe("race-harness Xero outbox isolation (#4234)", () => {
  it("passes a clean boundary and reads all pending rows without changing them", async () => {
    const { store, findMany } = storeWith([]);
    await expect(assertNoForeignPendingXeroOperations(store)).resolves.toBeUndefined();
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: { status: "PENDING" },
      select: { id: true, localModel: true, localId: true, queueType: true },
      orderBy: { id: "asc" },
    });
  });

  it("reports a foreign pending fixture before a consumer can hide it", async () => {
    const foreign = { id: "leaked-op", localModel: "Payment", localId: "race-3583-bank-appeal-payment", queueType: "ACCOUNT_CREDIT_NOTE" };
    const { store } = storeWith([foreign]);
    await expect(assertNoForeignPendingXeroOperations(store, ["race-3880-payment"]))
      .rejects.toThrow(`#4234: race-harness suites leaked PENDING Xero operations; clean them in the owning suite's teardown: ${JSON.stringify([foreign])}`);
  });

  it("allows exact owned pending ids inside a suite, but not at the final boundary", async () => {
    const { store } = storeWith([{ id: "own-op", localModel: "Payment", localId: "race-3880-payment", queueType: "REFUND_CREDIT_NOTE" }]);
    await expect(assertNoForeignPendingXeroOperations(store, ["race-3880-payment"])).resolves.toBeUndefined();
    await expect(assertNoForeignPendingXeroOperations(store)).rejects.toThrow("own-op");
    await expect(assertNoForeignPendingXeroOperations(store, ["race-3880-pay"])).rejects.toThrow("own-op");
  });

  it("fails closed for a pending row without a local id", async () => {
    const { store } = storeWith([{ id: "unowned-op", localModel: null, localId: null, queueType: null }]);
    await expect(assertNoForeignPendingXeroOperations(store, ["race-3880-payment"])).rejects.toThrow("unowned-op");
  });
});
