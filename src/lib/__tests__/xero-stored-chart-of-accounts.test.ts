/**
 * `readStoredChartOfAccounts` (#5235): the chart the mapping save and the
 * configuration import judge a code against, and, with `evenIfExpired`, the one
 * the Xero health check and the setup checklist read through
 * `readLastStoredChartOfAccounts`. A write must not be refused on a chart older
 * than its hour; a warning must not vanish because the chart is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => vi.fn());
const moduleClient = vi.hoisted(() => ({ xeroAdminCache: { findUnique: vi.fn() } }));
const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: moduleClient }));
vi.mock("@/lib/logger", () => ({ default: { warn } }));
vi.mock("@/lib/xero-connection", () => ({ readXeroConnection: connection }));

import { readLastStoredChartOfAccounts, readStoredChartOfAccounts } from "@/lib/xero-admin-cache";

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

describe("readLastStoredChartOfAccounts, for a reader that only warns", () => {
  beforeEach(() => {
    connection.mockReset();
    connection.mockResolvedValue({ tenantId: "tenant-1" });
    moduleClient.xeroAdminCache.findUnique.mockReset();
    warn.mockReset();
  });

  it("MUTATION: returns the last chart stored even after its hour is up", async () => {
    moduleClient.xeroAdminCache.findUnique.mockResolvedValue({
      payload: CHART,
      expiresAt: new Date(Date.now() - 30 * 24 * HOUR_MS),
    });
    await expect(readLastStoredChartOfAccounts()).resolves.toEqual(CHART);
    expect(warn).not.toHaveBeenCalled();
  });

  it("MUTATION: logs a failed read and reports no chart, so the report it is part of is still given", async () => {
    const failure = new Error("database unavailable");
    moduleClient.xeroAdminCache.findUnique.mockRejectedValue(failure);
    await expect(readLastStoredChartOfAccounts()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith({ err: failure }, expect.stringContaining("chart of accounts"));
  });
});
