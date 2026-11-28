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
    // The earliest refundable booking (`readRefundableTaxTypes`): none, unless a case says otherwise.
    booking: { findFirst: vi.fn(async () => null) },
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
  return {
    state,
    upsert,
    prisma,
    chart: vi.fn(),
    fetchChart: vi.fn(),
    connection: vi.fn(),
    rates: vi.fn(),
    schedule: vi.fn(),
    logAudit: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("@/lib/__tests__/helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: async () => null,
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/xero-admin-cache", () => ({ readStoredChartOfAccounts: h.chart }));
// #5235 review (owner decision, 28 Nov 2026): with no fresh stored chart the save asks Xero.
vi.mock("@/lib/xero-chart-of-accounts-fetch", () => ({ fetchChartOfAccountsFromXero: h.fetchChart }));
vi.mock("@/lib/xero-tax-anchors", () => import("@/lib/__tests__/support/xero-tax-anchors-baseline"));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/club-tax-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-tax-settings")),
  loadClubTaxSchedule: h.schedule,
}));
vi.mock("@/lib/xero-connection", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-connection")),
  readXeroConnection: h.connection,
}));
vi.mock("@/lib/xero-tax-rates", () => ({ readXeroTaxRates: h.rates }));

import { auth } from "@/lib/auth";
import { MAPPINGS_CHANGED_WHILE_SAVING, MAPPINGS_SAVE_CONTENDED } from "@/lib/xero-account-mapping-save";
import { XERO_CHART_UNAVAILABLE_FOR_SAVE } from "@/lib/xero-account-mapping-write-checks";
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
  h.chart.mockResolvedValue(accounts);
}

function store(codes: Record<string, string | null>) {
  h.state.rows = Object.entries(codes).map(([key, code]): Row => ({ key, code, itemCode: null }));
}

const storedCode = (key: string) => h.state.rows.find((row) => row.key === key)?.code;

async function save(body: unknown): Promise<{ status: number; error: string; key?: string; payload: Record<string, { code: string | null }> }> {
  const response = await PUT(
    new NextRequest("http://localhost/api/admin/xero/account-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const payload = await response.json();
  return { status: response.status, error: payload.error ?? "", key: payload.key, payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.rows = [];
  h.state.calls = [];
  h.state.whileWaitingForLock = null;
  h.schedule.mockResolvedValue(NOT_REGISTERED);
  h.connection.mockResolvedValue({ tenantId: "tenant-1", expiresAt: new Date() });
  h.fetchChart.mockRejectedValue(new Error("no Xero in this suite unless a case asks"));
  h.rates.mockResolvedValue([]);
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

  it("judges against the fresh stored chart without asking Xero", async () => {
    expect((await save({ hutFeeRefunds: { code: "404" } })).status).toBe(200);
    expect(h.fetchChart).not.toHaveBeenCalled();
  });

  it("MUTATION (owner decision, 28 Nov 2026): with no fresh stored chart, asks Xero first and judges by its answer", async () => {
    cacheChart(null);
    h.fetchChart.mockResolvedValue({ accounts: CHART, cache: null });
    const { status, error, key } = await save({ hutFeeRefunds: { code: "606" } });
    expect(status).toBe(400);
    expect(error).toContain("Hut Fee Refunds needs a revenue or expense account");
    expect(key).toBe("hutFeeRefunds");
    expect(h.fetchChart).toHaveBeenCalledTimes(1);
    expect(h.upsert).not.toHaveBeenCalled();
    // The fetched chart is asked before the transaction opens, never inside it.
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect((await save({ hutFeeRefunds: { code: "404" } })).status).toBe(200);
  });

  it("MUTATION: refuses with a 503 when Xero is connected but cannot be asked, and writes nothing", async () => {
    cacheChart(null);
    const { status, error } = await save({ hutFeeRefunds: { code: "404" } });
    expect(status).toBe(503);
    expect(error).toBe(XERO_CHART_UNAVAILABLE_FOR_SAVE);
    expect(error).not.toMatch(/\b403\b|forbidden/i);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(storedCode("hutFeeRefunds")).toBe("200");
  });

  it("accepts any code unchecked only while Xero is not connected, and asks Xero nothing", async () => {
    h.connection.mockResolvedValue(null);
    cacheChart(null);
    expect((await save({ hutFeeRefunds: { code: "606" } })).status).toBe(200);
    expect(storedCode("hutFeeRefunds")).toBe("606");
    expect(h.fetchChart).not.toHaveBeenCalled();
    expect(h.chart).not.toHaveBeenCalled();
  });

  it("MUTATION: refuses a code the fresh chart does not list, such as an archived account, naming the mapping", async () => {
    const { status, error, key } = await save({ hutFeeRefunds: { code: "431" } });
    expect(status).toBe(400);
    expect(error).toBe(
      "The code chosen for Hut Fee Refunds is not an active account in the connected Xero organisation; refresh the chart of accounts and choose again. No account mapping was saved.",
    );
    expect(key).toBe("hutFeeRefunds");
    expect(h.upsert).not.toHaveBeenCalled();
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
    // Not connected, so the liability code is not judged by kind and the save reaches the lock.
    h.connection.mockResolvedValue(null);
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

  it("keeps the retry messages free of anything the screen reads as 'not permitted'", () => {
    expect(MAPPINGS_CHANGED_WHILE_SAVING).not.toMatch(/\b403\b|forbidden/i);
    expect(MAPPINGS_SAVE_CONTENDED).not.toMatch(/\b403\b|forbidden/i);
  });

  it.each(["P2028", "P2034"])(
    "answers a transaction that timed out behind an import's lock, or lost a conflict (%s), with a 409 to retry",
    async (code) => {
      h.prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("Transaction API error"), { code }));
      const { status, error } = await save({ hutFeeRefunds: { code: "404" } });
      expect(status).toBe(409);
      expect(error).toBe(MAPPINGS_SAVE_CONTENDED);
      expect(h.logAudit).not.toHaveBeenCalled();
    },
  );
});

describe("Hut Fee Refunds on an expense account Xero's tax code cannot sit on (#5235 review)", () => {
  const OUTPUT2 = { taxType: "OUTPUT2", name: "15% GST on Income", rateBasisPoints: 1500, active: true, revenue: true, expenses: false };
  const REGISTERED: ClubTaxSchedule = [CLUB_TAX_SETTINGS_DEFAULTS];

  beforeEach(() => {
    h.schedule.mockResolvedValue(REGISTERED);
    h.rates.mockResolvedValue([OUTPUT2]);
  });

  it("MUTATION: refuses a registered club's expense refunds account with a 409 on that row, before any write", async () => {
    const { status, error, key } = await save({ hutFeeRefunds: { code: "429" } });
    expect(status).toBe(409);
    expect(key).toBe("hutFeeRefunds");
    expect(error).toBe(
      "Hut Fee Refunds cannot use that expense account: Xero's tax rate OUTPUT2 (15% GST on Income), which refund credit notes carry, cannot be used on expenses, so Xero would reject them. Choose a revenue account, or ask your accountant which account and tax rate refunds should use. No account mapping was saved.",
    );
    expect(h.rates).toHaveBeenCalledWith({ fresh: true });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("accepts it when Xero lets the code sit on expenses", async () => {
    h.rates.mockResolvedValue([{ ...OUTPUT2, expenses: true }]);
    expect((await save({ hutFeeRefunds: { code: "429" } })).status).toBe(200);
  });

  it("answers 503 when Xero's rates cannot be read", async () => {
    h.rates.mockRejectedValue(new Error("Xero down"));
    const { status, error } = await save({ hutFeeRefunds: { code: "429" } });
    expect(status).toBe(503);
    expect(error).toBe(XERO_CHART_UNAVAILABLE_FOR_SAVE);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("asks nothing of the rates for a revenue account, an unchanged code, or a club never registered", async () => {
    expect((await save({ hutFeeRefunds: { code: "200" } })).status).toBe(200);
    store({ hutFeesIncome: "200", hutFeeRefunds: "429" });
    expect((await save({ hutFeeRefunds: { code: "429" }, stripeFees: { code: "404" } })).status).toBe(200);
    h.schedule.mockResolvedValue([{ gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: requireCalendarDate("2010-01-01") }]);
    store({ hutFeesIncome: "200", hutFeeRefunds: "200" });
    expect((await save({ hutFeeRefunds: { code: "429" } })).status).toBe(200);
    expect(h.rates).not.toHaveBeenCalled();
  });
});
