/**
 * THE ACCOUNT MAPPING SAVE CHECKS THE ACCOUNT'S CLASS, AND WRITES UNDER ONE LOCK
 * (#5235, with #5391 folded in), through the real
 * `PUT /api/admin/xero/account-mappings`, the real registry rule
 * (`mappingCodeClassViolation`) and the real Opening Credits rules.
 *
 * Owner decision on #5235 (22 Nov 2026): the class is checked on save, not only
 * in the picker. Hut Fee Refunds accepts a revenue or an expense account; a
 * bank, asset or liability account is refused.
 *
 * Only Prisma, the session, the cached chart of accounts and Xero's tax-rate
 * read are doubles. A refused save writes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CLUB_TAX_SETTINGS_DEFAULTS, type ClubTaxSchedule } from "@/lib/club-tax-settings";
import { requireCalendarDate } from "@/lib/club-time";

type Row = { key: string; code: string | null; itemCode: string | null };

const h = vi.hoisted(() => {
  const state = {
    rows: [] as Array<{ key: string; code: string | null; itemCode: string | null }>,
    /** Runs once, when the save takes its lock: another writer committing first. */
    whileWaitingForLock: null as null | (() => void),
    calls: [] as string[],
  };
  const upsert = vi.fn(
    async ({ where, update, create }: {
      where: { key: string };
      update: { code?: string | null; itemCode?: string | null };
      create: { key: string; code: string | null; itemCode: string | null };
    }) => {
      state.calls.push(`upsert:${where.key}`);
      const existing = state.rows.find((row) => row.key === where.key);
      if (existing) Object.assign(existing, update);
      else state.rows.push({ ...create });
      return {};
    },
  );
  const findMany = vi.fn(async () => {
    state.calls.push("findMany");
    return state.rows.map((row) => ({ ...row }));
  });
  const prisma = {
    xeroAccountMapping: { findMany, upsert },
    xeroTaxCategoryMapping: { findMany: vi.fn(async () => []) },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      state.calls.push(`lock:${strings.join("?")}`);
      state.whileWaitingForLock?.();
      state.whileWaitingForLock = null;
      return 1;
    }),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      state.calls.push("transaction");
      return run(prisma);
    }),
  };
  return { state, upsert, prisma, chart: vi.fn(), schedule: vi.fn(), logAudit: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("@/lib/__tests__/helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: async () => null,
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/xero-admin-cache", () => ({ getCachedChartOfAccounts: h.chart }));
vi.mock("@/lib/xero-tax-anchors", () => import("@/lib/__tests__/support/xero-tax-anchors-baseline"));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/club-tax-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-tax-settings")),
  loadClubTaxSchedule: h.schedule,
}));
vi.mock("@/lib/xero-connection", () => ({
  readXeroConnection: async () => ({ tenantId: "tenant-1", expiresAt: new Date() }),
}));
vi.mock("@/lib/xero-tax-rates", () => ({ readXeroTaxRates: vi.fn(async () => []) }));

import { auth } from "@/lib/auth";
import { MAPPINGS_CHANGED_WHILE_SAVING } from "@/lib/xero-account-mapping-save";
import { PUT } from "@/app/api/admin/xero/account-mappings/route";

// Not GST-registered, so mapping Opening Credits asks nothing of the Exempt category.
const NOT_REGISTERED: ClubTaxSchedule = [
  CLUB_TAX_SETTINGS_DEFAULTS,
  { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: requireCalendarDate("2026-01-01") },
];

const CHART = [
  { code: "200", name: "Hut Fees", type: "REVENUE", class: "REVENUE" },
  { code: "404", name: "Refunds Paid", type: "EXPENSE", class: "EXPENSE" },
  { code: "429", name: "General Expenses", type: "OVERHEADS", class: "EXPENSE" },
  { code: "606", name: "Business Bank Account", type: "BANK", class: "ASSET" },
  { code: "620", name: "Prepayments", type: "PREPAYMENT", class: "ASSET" },
  { code: "820", name: "Member Credits Held", type: "CURRLIAB", class: "LIABILITY" },
];

function cacheChart(accounts: typeof CHART | null) {
  h.chart.mockResolvedValue(
    accounts === null
      ? null
      : { values: accounts, metadata: { source: "database", lastRefreshedAt: "", expiresAt: "" } },
  );
}

function store(codes: Record<string, string | null>) {
  h.state.rows = Object.entries(codes).map(([key, code]): Row => ({ key, code, itemCode: null }));
}

const storedCode = (key: string) => h.state.rows.find((row) => row.key === key)?.code;

async function save(body: unknown): Promise<{ status: number; error: string; payload: Record<string, { code: string | null }> }> {
  const response = await PUT(
    new NextRequest("http://localhost/api/admin/xero/account-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const payload = await response.json();
  return { status: response.status, error: payload.error ?? "", payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.rows = [];
  h.state.calls = [];
  h.state.whileWaitingForLock = null;
  h.schedule.mockResolvedValue(NOT_REGISTERED);
  cacheChart(CHART);
  store({ hutFeesIncome: "200", hutFeeRefunds: "200" });
  vi.mocked(auth).mockResolvedValue({
    user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
  } as never);
});

describe("Hut Fee Refunds takes a revenue or an expense account (#5235)", () => {
  it.each([
    ["an expense account", "404"],
    ["an expense-class account of another type", "429"],
    ["a revenue account", "200"],
  ])("accepts %s", async (_kind, code) => {
    store({ hutFeesIncome: "200", hutFeeRefunds: "999" });
    const { status, payload } = await save({ hutFeeRefunds: { code } });
    expect(status).toBe(200);
    expect(storedCode("hutFeeRefunds")).toBe(code);
    expect(payload.hutFeeRefunds.code).toBe(code);
    expect(h.logAudit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a bank account", "606", "an asset account"],
    ["another asset account", "620", "an asset account"],
    ["a liability account", "820", "a liability account"],
  ])("MUTATION: refuses %s with a 400 naming the mapping and what it accepts", async (_kind, code, actual) => {
    const { status, error } = await save({ hutFeeRefunds: { code }, stripeFees: { code: "404" } });
    expect(status).toBe(400);
    expect(error).toBe(
      `Hut Fee Refunds needs a revenue or expense account, and the code chosen for it is ${actual} in the connected Xero organisation. No account mapping was saved.`,
    );
    // Nothing is written, the other valid key included, and no transaction opens.
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(storedCode("hutFeeRefunds")).toBe("200");
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("names every refused mapping when one save carries several", async () => {
    const { status, error } = await save({ hutFeeRefunds: { code: "606" }, goodwillWriteOffs: { code: "200" } });
    expect(status).toBe(400);
    expect(error).toContain("Hut Fee Refunds needs a revenue or expense account");
    expect(error).toContain("Goodwill & Write-Offs needs an expense account");
  });

  it("accepts any code while no chart of accounts is cached", async () => {
    cacheChart(null);
    expect((await save({ hutFeeRefunds: { code: "606" } })).status).toBe(200);
    expect(storedCode("hutFeeRefunds")).toBe("606");
  });

  it("accepts a code the cached chart does not list, which may be newer than the cache", async () => {
    expect((await save({ hutFeeRefunds: { code: "431" } })).status).toBe(200);
  });

  it("does not judge a code the save leaves as it is stored, so the other mappings can still be saved", async () => {
    // A bank code stored before the check existed; the screen resends every key.
    store({ hutFeesIncome: "200", hutFeeRefunds: "606" });
    const { status } = await save({ hutFeeRefunds: { code: "606" }, stripeFees: { code: "404" } });
    expect(status).toBe(200);
    expect(storedCode("stripeFees")).toBe("404");
    // Changing it to another wrong account is still refused.
    expect((await save({ hutFeeRefunds: { code: "620" } })).status).toBe(400);
  });

  it("applies the same registry rule to every account key", async () => {
    expect((await save({ stripeBankAccount: { code: "200" } })).error).toContain("Stripe Bank Account needs a bank account");
    expect((await save({ hutFeesIncome: { code: "404" } })).error).toContain("Hut Fees Income needs a revenue account");
    expect((await save({ stripeBankAccount: { code: "606" } })).status).toBe(200);
  });

  it("does not read the chart for an item code, which names a Xero Item and not an account", async () => {
    expect((await save({ hutFeeItem: { itemCode: "606" } })).status).toBe(200);
    expect(h.chart).not.toHaveBeenCalled();
  });
});

describe("the checks and the writes are one decision, under the config-import key (#5391)", () => {
  it("MUTATION: takes the config-import key, then re-reads the rows, then writes", async () => {
    expect((await save({ hutFeeRefunds: { code: "429" }, stripeFees: { code: "404" } })).status).toBe(200);
    expect(h.state.calls).toEqual([
      "findMany",
      "transaction",
      "lock:SELECT pg_advisory_xact_lock(hashtext('config-transfer-import'))",
      "findMany",
      "upsert:hutFeeRefunds",
      "upsert:stripeFees",
      "findMany",
    ]);
  });

  it("MUTATION: refuses a shared Opening Credits account that only exists once the lock is held", async () => {
    // Another save maps Opening Credits to 820 after this one's first read.
    h.state.whileWaitingForLock = () => h.state.rows.push({ key: "openingCredits", code: "820", itemCode: null });
    cacheChart(null);
    const { status, error } = await save({ goodwillWriteOffs: { code: "820" } });
    expect(status).toBe(409);
    expect(error).toBe(
      "Opening Credits cannot use the same Xero account as Goodwill & Write-Offs. Choose an account for Opening Credits that no other mapping uses, or change the other mapping first. No account mapping was saved.",
    );
    expect(h.upsert).not.toHaveBeenCalled();
    expect(storedCode("goodwillWriteOffs")).toBeUndefined();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("MUTATION: refuses when a code this save writes changed while it waited, and asks for a retry", async () => {
    // The first pass saw Hut Fee Refunds at 200 and so judged this save as
    // changing it; by the time the lock is held another save has moved it.
    h.state.whileWaitingForLock = () => {
      h.state.rows.find((row) => row.key === "hutFeeRefunds")!.code = "429";
    };
    const { status, error } = await save({ hutFeeRefunds: { code: "404" } });
    expect(status).toBe(409);
    expect(error).toBe(MAPPINGS_CHANGED_WHILE_SAVING);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(storedCode("hutFeeRefunds")).toBe("429");
  });

  it("does not refuse for a change to a key this save does not write", async () => {
    h.state.whileWaitingForLock = () => h.state.rows.push({ key: "stripeFees", code: "429", itemCode: null });
    expect((await save({ hutFeeRefunds: { code: "404" } })).status).toBe(200);
    expect(storedCode("stripeFees")).toBe("429");
    expect(storedCode("hutFeeRefunds")).toBe("404");
  });

  it("keeps the retry message free of anything the screen reads as 'not permitted'", () => {
    expect(MAPPINGS_CHANGED_WHILE_SAVING).not.toMatch(/\b403\b|forbidden/i);
  });
});
