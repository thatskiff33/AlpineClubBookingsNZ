// #1441: the mismatch panels' Refresh must resync the flagged contacts from
// Xero before recomputing — a fix made inside Xero has to clear locally.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroContactCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    xeroContactGroupMembershipCache: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

const mockIsXeroConnected = vi.fn();
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: (...args: unknown[]) => mockIsXeroConnected(...args),
}));

const mockGetAuthenticatedXeroClient = vi.fn();
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");
  return {
    ...actual,
    getAuthenticatedXeroClient: (...args: unknown[]) =>
      mockGetAuthenticatedXeroClient(...args),
  };
});

const mockFetchContactsByIds = vi.fn();
const mockRefreshCaches = vi.fn();
vi.mock("@/lib/xero-contact-cache", () => ({
  fetchXeroContactsByIdsFromXero: (...args: unknown[]) =>
    mockFetchContactsByIds(...args),
  refreshXeroContactCachesFromContact: (...args: unknown[]) =>
    mockRefreshCaches(...args),
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockGroupSnapshot = vi.fn();
vi.mock("@/lib/xero-member-grouping-resync", () => ({
  getXeroMemberGroupingSnapshot: (...args: unknown[]) =>
    mockGroupSnapshot(...args),
}));

const mockLinkSnapshot = vi.fn();
vi.mock("@/lib/xero-contact-link-mismatches", () => ({
  getXeroContactLinkMismatchSnapshot: (...args: unknown[]) =>
    mockLinkSnapshot(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import { resyncXeroContactCachesByIds } from "@/lib/xero-mismatch-resync";
import { POST as resyncGroupMismatches } from "@/app/api/admin/xero/contact-group-mismatches/route";
import { POST as resyncLinkMismatches } from "@/app/api/admin/xero/contact-link-mismatches/route";

const adminGuard = {
  ok: true,
  session: { user: { id: "admin1", role: "ADMIN", accessRoles: ["ADMIN"] } },
};

function postRequest(url: string, body?: Record<string, unknown>) {
  return new NextRequest(url, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsXeroConnected.mockResolvedValue(true);
  mockGetAuthenticatedXeroClient.mockResolvedValue({
    xero: { accountingApi: {} },
    tenantId: "tenant-1",
  });
  mockRefreshCaches.mockResolvedValue({
    cachedContact: null,
    groupMemberships: null,
  });
});

describe("resyncXeroContactCachesByIds", () => {
  it("returns a zero summary without calling Xero when nothing is flagged", async () => {
    const summary = await resyncXeroContactCachesByIds([], "test-workflow");

    expect(summary.requestedContacts).toBe(0);
    expect(summary.resyncedContacts).toBe(0);
    expect(summary.removedContacts).toBe(0);
    expect(mockIsXeroConnected).not.toHaveBeenCalled();
    expect(mockFetchContactsByIds).not.toHaveBeenCalled();
  });

  it("dedupes contact ids, refreshes each returned contact, and reports counts", async () => {
    mockFetchContactsByIds.mockResolvedValue([
      { contactID: "xc-1" },
      { contactID: "xc-2" },
    ]);

    const summary = await resyncXeroContactCachesByIds(
      ["xc-1", "xc-2", "xc-1", null, undefined],
      "test-workflow"
    );

    expect(mockFetchContactsByIds).toHaveBeenCalledWith(
      expect.objectContaining({
        contactIds: ["xc-1", "xc-2"],
        includeArchived: true,
        workflow: "test-workflow",
      })
    );
    expect(mockRefreshCaches).toHaveBeenCalledTimes(2);
    expect(summary.requestedContacts).toBe(2);
    expect(summary.resyncedContacts).toBe(2);
    expect(summary.removedContacts).toBe(0);
    expect(prisma.xeroContactCache.deleteMany).not.toHaveBeenCalled();
  });

  it("drops stale cache rows for contacts Xero no longer returns", async () => {
    mockFetchContactsByIds.mockResolvedValue([{ contactID: "xc-1" }]);

    const summary = await resyncXeroContactCachesByIds(
      ["xc-1", "xc-gone"],
      "test-workflow"
    );

    expect(summary.resyncedContacts).toBe(1);
    expect(summary.removedContacts).toBe(1);
    expect(prisma.xeroContactCache.deleteMany).toHaveBeenCalledWith({
      where: { contactId: { in: ["xc-gone"] } },
    });
    expect(
      prisma.xeroContactGroupMembershipCache.deleteMany
    ).toHaveBeenCalledWith({
      where: { contactId: { in: ["xc-gone"] } },
    });
  });

  it("throws a 409 unavailable error when Xero is not connected", async () => {
    mockIsXeroConnected.mockResolvedValue(false);

    await expect(
      resyncXeroContactCachesByIds(["xc-1"], "test-workflow")
    ).rejects.toMatchObject({
      name: "XeroResyncUnavailableError",
      status: 409,
    });
    expect(mockFetchContactsByIds).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/xero/contact-group-mismatches (resync)", () => {
  beforeEach(() => {
    mockRequireAdmin.mockResolvedValue(adminGuard);
  });

  it("resyncs the flagged contacts and returns the recomputed snapshot", async () => {
    mockGroupSnapshot
      .mockResolvedValueOnce({
        cacheReady: true,
        lastRefreshedAt: "2026-07-01T00:00:00.000Z",
        mismatchCount: 1,
        mismatches: [{ memberId: "m1", xeroContactId: "xc-1" }],
      })
      // Recompute after the resync: the fix made inside Xero has landed in
      // the caches, so the mismatch clears.
      .mockResolvedValueOnce({
        cacheReady: true,
        lastRefreshedAt: "2026-07-01T00:00:00.000Z",
        mismatchCount: 0,
        mismatches: [],
      });
    mockFetchContactsByIds.mockResolvedValue([{ contactID: "xc-1" }]);

    const res = await resyncGroupMismatches(
      postRequest("http://localhost/api/admin/xero/contact-group-mismatches", {
        limit: 200,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.mismatchCount).toBe(0);
    expect(json.mismatches).toEqual([]);
    expect(json.resync).toMatchObject({
      requestedContacts: 1,
      resyncedContacts: 1,
      removedContacts: 0,
    });
    expect(typeof json.resync.resyncedAt).toBe("string");
    expect(mockFetchContactsByIds).toHaveBeenCalledWith(
      expect.objectContaining({ contactIds: ["xc-1"] })
    );
  });

  it("returns 409 without calling Xero when the cache has never been synced", async () => {
    mockGroupSnapshot.mockResolvedValue({
      cacheReady: false,
      lastRefreshedAt: null,
      mismatchCount: 0,
      mismatches: [],
    });

    const res = await resyncGroupMismatches(
      postRequest("http://localhost/api/admin/xero/contact-group-mismatches")
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/never been synced/i);
    expect(mockFetchContactsByIds).not.toHaveBeenCalled();
  });

  it("surfaces the Xero daily API limit as 429", async () => {
    mockGroupSnapshot.mockResolvedValue({
      cacheReady: true,
      lastRefreshedAt: "2026-07-01T00:00:00.000Z",
      mismatchCount: 1,
      mismatches: [{ memberId: "m1", xeroContactId: "xc-1" }],
    });
    mockFetchContactsByIds.mockRejectedValue(new XeroDailyLimitError(3600));

    const res = await resyncGroupMismatches(
      postRequest("http://localhost/api/admin/xero/contact-group-mismatches")
    );

    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/daily API limit/i);
  });

  it("surfaces a disconnected Xero as 409", async () => {
    mockGroupSnapshot.mockResolvedValue({
      cacheReady: true,
      lastRefreshedAt: "2026-07-01T00:00:00.000Z",
      mismatchCount: 1,
      mismatches: [{ memberId: "m1", xeroContactId: "xc-1" }],
    });
    mockIsXeroConnected.mockResolvedValue(false);

    const res = await resyncGroupMismatches(
      postRequest("http://localhost/api/admin/xero/contact-group-mismatches")
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not connected/i);
  });
});

describe("POST /api/admin/xero/contact-link-mismatches (resync)", () => {
  beforeEach(() => {
    mockRequireAdmin.mockResolvedValue(adminGuard);
  });

  it("resyncs the flagged contacts and returns the recomputed snapshot", async () => {
    mockLinkSnapshot
      .mockResolvedValueOnce({
        cacheReady: true,
        lastRefreshedAt: "2026-07-01T00:00:00.000Z",
        count: 2,
        mismatches: [
          { memberId: "m1", xeroContactId: "xc-1" },
          { memberId: "m2", xeroContactId: "xc-2" },
        ],
      })
      .mockResolvedValueOnce({
        cacheReady: true,
        lastRefreshedAt: "2026-07-01T00:00:00.000Z",
        count: 0,
        mismatches: [],
      });
    // xc-2 was deleted/merged inside Xero: its cache rows get dropped.
    mockFetchContactsByIds.mockResolvedValue([{ contactID: "xc-1" }]);

    const res = await resyncLinkMismatches(
      postRequest("http://localhost/api/admin/xero/contact-link-mismatches", {
        limit: 200,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.count).toBe(0);
    expect(json.resync).toMatchObject({
      requestedContacts: 2,
      resyncedContacts: 1,
      removedContacts: 1,
    });
  });

  it("returns 409 without calling Xero when the cache has never been synced", async () => {
    mockLinkSnapshot.mockResolvedValue({
      cacheReady: false,
      lastRefreshedAt: null,
      count: 0,
      mismatches: [],
    });

    const res = await resyncLinkMismatches(
      postRequest("http://localhost/api/admin/xero/contact-link-mismatches")
    );

    expect(res.status).toBe(409);
    expect(mockFetchContactsByIds).not.toHaveBeenCalled();
  });
});
