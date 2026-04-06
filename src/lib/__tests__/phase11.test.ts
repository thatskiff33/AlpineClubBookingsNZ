/**
 * Phase 11 tests: Xero Account Mapping Configuration
 * XAM-01: XeroAccountMapping model (schema only, tested via API mocks)
 * XAM-02: GET /api/admin/xero/chart-of-accounts
 * XAM-03: Account mapping UI (logic only — component tested via API contracts)
 * XAM-04: GET/PUT /api/admin/xero/account-mappings
 * XAM-05: getAccountMapping helper in xero.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroAccountMapping: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

// Partial mock: keep real implementations (including getAccountMapping) but stub
// getAuthenticatedXeroClient so chart-of-accounts tests can control Xero responses.
vi.mock("@/lib/xero", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero")>();
  return {
    ...actual,
    getAuthenticatedXeroClient: vi.fn(),
  };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { getAccountMapping, getAuthenticatedXeroClient } from "@/lib/xero";
import { GET as getMappings, PUT as putMappings } from "@/app/api/admin/xero/account-mappings/route";
import {
  GET as getChartOfAccounts,
  _clearChartOfAccountsCache,
} from "@/app/api/admin/xero/chart-of-accounts/route";

const mockPrisma = prisma as unknown as {
  xeroAccountMapping: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
};

const mockAuth = auth as ReturnType<typeof vi.fn>;
const mockGetXeroClient = getAuthenticatedXeroClient as ReturnType<typeof vi.fn>;

function adminSession() {
  return { user: { id: "admin-1", role: "ADMIN" } };
}

function makePutRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/xero/account-mappings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── XAM-04: GET /api/admin/xero/account-mappings ────────────────────────────

describe("GET /api/admin/xero/account-mappings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession());
  });

  it("returns 401 for non-admin", async () => {
    mockAuth.mockResolvedValue({ user: { role: "MEMBER" } });
    const res = await getMappings();
    expect(res.status).toBe(401);
  });

  it("returns all mapping keys with DB values", async () => {
    mockPrisma.xeroAccountMapping.findMany.mockResolvedValue([
      { key: "hutFeesIncome", code: "201" },
      { key: "hutFeeRefunds", code: "202" },
      { key: "stripeBankAccount", code: "607" },
      { key: "stripeFees", code: "490" },
      { key: "subscriptionIncome", code: "205" },
    ]);
    const res = await getMappings();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hutFeesIncome).toBe("201");
    expect(data.hutFeeRefunds).toBe("202");
    expect(data.stripeBankAccount).toBe("607");
    expect(data.stripeFees).toBe("490");
    expect(data.subscriptionIncome).toBe("205");
  });

  it("returns null for keys not in DB", async () => {
    mockPrisma.xeroAccountMapping.findMany.mockResolvedValue([
      { key: "hutFeesIncome", code: "201" },
    ]);
    const res = await getMappings();
    const data = await res.json();
    expect(data.hutFeesIncome).toBe("201");
    expect(data.hutFeeRefunds).toBeNull();
    expect(data.stripeBankAccount).toBeNull();
    expect(data.stripeFees).toBeNull();
    expect(data.subscriptionIncome).toBeNull();
  });

  it("returns 500 on DB error", async () => {
    mockPrisma.xeroAccountMapping.findMany.mockRejectedValue(new Error("DB down"));
    const res = await getMappings();
    expect(res.status).toBe(500);
  });
});

// ─── XAM-04: PUT /api/admin/xero/account-mappings ────────────────────────────

describe("PUT /api/admin/xero/account-mappings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession());
    mockPrisma.xeroAccountMapping.upsert.mockResolvedValue({});
    mockPrisma.xeroAccountMapping.findMany.mockResolvedValue([
      { key: "hutFeesIncome", code: "201" },
      { key: "hutFeeRefunds", code: "200" },
      { key: "stripeBankAccount", code: "606" },
      { key: "stripeFees", code: null },
      { key: "subscriptionIncome", code: "203" },
    ]);
  });

  it("returns 401 for non-admin", async () => {
    mockAuth.mockResolvedValue({ user: { role: "MEMBER" } });
    const req = makePutRequest({ hutFeesIncome: "201" });
    const res = await putMappings(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new NextRequest("http://localhost/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await putMappings(req);
    expect(res.status).toBe(400);
  });

  it("upserts provided keys and returns updated mappings", async () => {
    const req = makePutRequest({ hutFeesIncome: "201", stripeBankAccount: "607" });
    const res = await putMappings(req);
    expect(res.status).toBe(200);
    expect(mockPrisma.xeroAccountMapping.upsert).toHaveBeenCalledTimes(2);
    const data = await res.json();
    expect(data.hutFeesIncome).toBe("201");
  });

  it("accepts null codes (clears mapping)", async () => {
    const req = makePutRequest({ stripeFees: null });
    const res = await putMappings(req);
    expect(res.status).toBe(200);
    expect(mockPrisma.xeroAccountMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "stripeFees" },
        update: { code: null },
      })
    );
  });

  it("ignores unknown keys (they fail Zod schema)", async () => {
    const req = makePutRequest({ unknownKey: "999", hutFeesIncome: "201" });
    const res = await putMappings(req);
    // unknownKey stripped by Zod, only hutFeesIncome upserted
    expect(res.status).toBe(200);
    expect(mockPrisma.xeroAccountMapping.upsert).toHaveBeenCalledTimes(1);
  });
});

// ─── XAM-02: GET /api/admin/xero/chart-of-accounts ───────────────────────────

describe("GET /api/admin/xero/chart-of-accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession());
    _clearChartOfAccountsCache();
  });

  afterEach(() => {
    _clearChartOfAccountsCache();
  });

  it("returns 401 for non-admin", async () => {
    mockAuth.mockResolvedValue({ user: { role: "MEMBER" } });
    const res = await getChartOfAccounts();
    expect(res.status).toBe(401);
  });

  it("fetches and returns accounts from Xero", async () => {
    const mockAccounts = [
      { code: "200", name: "Sales", type: "REVENUE", class: "INCOME", status: "ACTIVE" },
      { code: "606", name: "Stripe Clearing", type: "BANK", class: "ASSET", status: "ACTIVE" },
      { code: "490", name: "Bank Fees", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" },
    ];
    mockGetXeroClient.mockResolvedValue({
      xero: {
        accountingApi: {
          getAccounts: vi.fn().mockResolvedValue({ body: { accounts: mockAccounts } }),
        },
      },
      tenantId: "tenant-1",
    });

    const res = await getChartOfAccounts();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accounts).toHaveLength(3);
    expect(data.accounts[0]).toMatchObject({ code: "200", name: "Sales", type: "REVENUE" });
  });

  it("filters out inactive accounts", async () => {
    const mockAccounts = [
      { code: "200", name: "Sales", type: "REVENUE", class: "INCOME", status: "ACTIVE" },
      { code: "201", name: "Old Account", type: "REVENUE", class: "INCOME", status: "ARCHIVED" },
    ];
    mockGetXeroClient.mockResolvedValue({
      xero: {
        accountingApi: {
          getAccounts: vi.fn().mockResolvedValue({ body: { accounts: mockAccounts } }),
        },
      },
      tenantId: "tenant-1",
    });

    const res = await getChartOfAccounts();
    const data = await res.json();
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0].code).toBe("200");
  });

  it("returns 500 on Xero error", async () => {
    mockGetXeroClient.mockRejectedValue(new Error("Xero not connected"));
    const res = await getChartOfAccounts();
    expect(res.status).toBe(500);
  });

  it("caches results on second call", async () => {
    const getAccountsFn = vi.fn().mockResolvedValue({
      body: {
        accounts: [
          { code: "200", name: "Sales", type: "REVENUE", class: "INCOME", status: "ACTIVE" },
        ],
      },
    });
    mockGetXeroClient.mockResolvedValue({
      xero: { accountingApi: { getAccounts: getAccountsFn } },
      tenantId: "tenant-1",
    });

    await getChartOfAccounts();
    await getChartOfAccounts();

    // Xero API should only be called once due to caching
    expect(getAccountsFn).toHaveBeenCalledTimes(1);
  });
});

// ─── XAM-05: getAccountMapping helper ────────────────────────────────────────

describe("getAccountMapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns DB code when record exists with non-null code", async () => {
    mockPrisma.xeroAccountMapping.findUnique.mockResolvedValue({ code: "201" });
    const code = await getAccountMapping("hutFeesIncome");
    expect(code).toBe("201");
  });

  it("returns default when DB record has null code", async () => {
    mockPrisma.xeroAccountMapping.findUnique.mockResolvedValue({ code: null });
    const code = await getAccountMapping("hutFeesIncome");
    expect(code).toBe("200"); // falls through to default
  });

  it("returns default when no DB record exists", async () => {
    mockPrisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
    const code = await getAccountMapping("hutFeeRefunds");
    expect(code).toBe("200"); // default
  });

  it("returns correct default for stripeBankAccount", async () => {
    mockPrisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
    const code = await getAccountMapping("stripeBankAccount");
    expect(code).toBe("606");
  });

  it("returns null default for stripeFees (unconfigured)", async () => {
    mockPrisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
    const code = await getAccountMapping("stripeFees");
    expect(code).toBeNull();
  });

  it("returns correct default for subscriptionIncome", async () => {
    mockPrisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
    const code = await getAccountMapping("subscriptionIncome");
    expect(code).toBe("203");
  });

  it("returns null for unknown key", async () => {
    mockPrisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
    const code = await getAccountMapping("unknownKey");
    expect(code).toBeNull();
  });

  it("falls back to default when DB throws", async () => {
    mockPrisma.xeroAccountMapping.findUnique.mockRejectedValue(new Error("DB error"));
    const code = await getAccountMapping("hutFeesIncome");
    expect(code).toBe("200"); // falls back to default
  });
});
