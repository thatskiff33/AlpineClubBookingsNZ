import { describe, expect, it, vi } from "vitest";

import { openClientTransactionsElsewhere } from "./support/open-client-transactions";

const backend = { pid: 123, query: "COMMIT", xact_start: new Date(), application_name: "test-app" };

describe("provider-call transaction probe settling (#4695)", () => {
  it("rechecks in-flight work before reporting an open transaction", async () => {
    const query = vi.fn().mockResolvedValueOnce([backend]).mockResolvedValue([]);
    expect(await openClientTransactionsElsewhere({ $queryRaw: query })).toBe(0);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed activity read instead of treating it as settled", async () => {
    const error = new Error("database unavailable");
    const query = vi.fn().mockResolvedValueOnce([backend]).mockRejectedValue(error);
    await expect(openClientTransactionsElsewhere({ $queryRaw: query })).rejects.toThrow(error);
  });
});
