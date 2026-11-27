/**
 * `readStoredChartOfAccounts` (#5235): the chart the mapping save and the
 * configuration import judge a code against, and, with `evenIfExpired`, the one
 * the Xero health check reads. A write must not be refused on a chart older
 * than its hour; a warning must not vanish because the chart is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/xero-connection", () => ({ readXeroConnection: connection }));

import { readStoredChartOfAccounts } from "@/lib/xero-admin-cache";

const CHART = [{ code: "429", name: "General Expenses", type: "OVERHEADS", class: "EXPENSE" }];
const HOUR_MS = 60 * 60 * 1000;

function dbHolding(record: { payload: unknown; expiresAt: Date } | null) {
  const findUnique = vi.fn(async () => record);
  const db = { xeroAdminCache: { findUnique } } as unknown as Parameters<typeof readStoredChartOfAccounts>[0];
  return { db, findUnique };
}

describe("readStoredChartOfAccounts", () => {
  beforeEach(() => {
    connection.mockReset();
    connection.mockResolvedValue({ tenantId: "tenant-1" });
  });

  it("returns the stored chart while it is fresh", async () => {
    const { db, findUnique } = dbHolding({ payload: CHART, expiresAt: new Date(Date.now() + HOUR_MS) });
    await expect(readStoredChartOfAccounts(db)).resolves.toEqual(CHART);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cacheKey_tenantId: { cacheKey: expect.any(String), tenantId: "tenant-1" } },
      }),
    );
  });

  it("MUTATION: returns nothing once the chart has expired, unless asked for it even so", async () => {
    const { db } = dbHolding({ payload: CHART, expiresAt: new Date(Date.now() - HOUR_MS) });
    await expect(readStoredChartOfAccounts(db)).resolves.toBeNull();
    await expect(readStoredChartOfAccounts(db, { evenIfExpired: true })).resolves.toEqual(CHART);
  });

  it("returns nothing when Xero is not connected, nothing is stored, or the payload is not a chart", async () => {
    const stored = dbHolding({ payload: CHART, expiresAt: new Date(Date.now() + HOUR_MS) });
    connection.mockResolvedValue(null);
    await expect(readStoredChartOfAccounts(stored.db, { evenIfExpired: true })).resolves.toBeNull();
    expect(stored.findUnique).not.toHaveBeenCalled();

    connection.mockResolvedValue({ tenantId: "tenant-1" });
    await expect(readStoredChartOfAccounts(dbHolding(null).db, { evenIfExpired: true })).resolves.toBeNull();
    const malformed = dbHolding({ payload: [{ code: "429" }], expiresAt: new Date(Date.now() + HOUR_MS) });
    await expect(readStoredChartOfAccounts(malformed.db, { evenIfExpired: true })).resolves.toBeNull();
  });
});
