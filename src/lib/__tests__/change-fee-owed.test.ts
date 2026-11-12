import { describe, expect, it } from "vitest";

import { changeFeeAddedToAmountOwedHistory } from "@/lib/change-fee-owed";

/**
 * The history marker #4661 wrote when an ordinary edit added its fee to an
 * unpaid booking's amount owed. New ordinary edits pass 0 and write nothing.
 * The door-to-ledger behaviour is pinned against PostgreSQL in
 * `unpaid-edit-change-fee-owed.realdb.test.ts`.
 */
describe("changeFeeAddedToAmountOwedHistory", () => {
  it("marks the edit's history row only when it added a fee", () => {
    expect(changeFeeAddedToAmountOwedHistory(2_500)).toEqual({ changeFeeAddedToAmountOwed: true });
    expect(changeFeeAddedToAmountOwedHistory(0)).toEqual({});
  });
});
