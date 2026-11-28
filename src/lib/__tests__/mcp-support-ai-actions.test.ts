/**
 * ALP-724 (`INV-MCP-006`): the Support area's AI settings actions an
 * officer's AI app connection may run: the page-help assistant's spend cap
 * and usage, AI Diagnostics' readiness and budget, and the conversion rate.
 * Each route answers the browser as before; the connection gets exactly the
 * action's `returns` fields (`expectActionContract`). Every handler runs twice
 * (connection, then browser), so the mocks answer both runs.
 *
 * What a connection must never be sent here: the id of the member who last
 * saved a setting, or the page a failed help question was asked on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    aiAssistantSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    diagnosticsSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    aiSpendCurrencySettings: { findUnique: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    prisma,
    requireAdmin: vi.fn(),
    usageSummary: vi.fn(),
    diagnosticsUsage: vi.fn(),
    readiness: vi.fn(),
    moduleFlag: vi.fn(),
    loadCurrency: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/ai-assistant-usage", () => ({ DEFAULT_MONTHLY_BUDGET_CENTS: 1000, getAiUsageSummary: h.usageSummary }));
vi.mock("@/lib/ai-diagnostics-usage", () => ({
  DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS: 0,
  DIAGNOSTICS_SETTINGS_ID: "default",
  getDiagnosticsUsageSummary: h.diagnosticsUsage,
}));
vi.mock("@/lib/ai-diagnostics-config", () => ({
  getDiagnosticsReadiness: h.readiness,
  readDiagnosticsModuleFlag: h.moduleFlag,
}));
vi.mock("@/lib/ai-spend-currency-settings", () => ({
  AI_SPEND_CURRENCY_SETTINGS_ID: "default",
  loadAiSpendCurrency: h.loadCurrency,
}));

import { GET as getHelpSettings, PUT as putHelpSettings } from "@/app/api/admin/ai-assistant/settings/route";
import { GET as getHelpUsage } from "@/app/api/admin/ai-assistant/usage/route";
import { GET as getReadiness } from "@/app/api/admin/ai-diagnostics/readiness/route";
import { GET as getDiagnosticsSettings, PUT as putDiagnosticsSettings } from "@/app/api/admin/ai-diagnostics/settings/route";
import { GET as getSpendRate, PUT as putSpendRate } from "@/app/api/admin/ai-spend-currency/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { findMcpAction, mcpActionInputSchema } from "@/lib/mcp/catalogue";
import { SUPPORT_AI_MCP_ACTIONS } from "@/lib/mcp/catalogue/support-ai";

const STAMP = new Date("2026-06-30T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));
  h.prisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
});

describe("the AI settings entries", () => {
  it("are officer actions: reads for GET, destructive otherwise, none core", () => {
    for (const action of SUPPORT_AI_MCP_ACTIONS) {
      expect(action.summary.startsWith("Officer: "), action.id).toBe(true);
      expect(action.kind, action.id).toBe(action.method === "GET" ? "read" : "destructive");
      expect(action.core, action.id).toBe(false);
    }
  });

  it("never names who last saved a setting", () => {
    for (const action of SUPPORT_AI_MCP_ACTIONS) {
      expect(JSON.stringify(action.returns), action.id).not.toMatch(/ByMemberId/);
    }
  });

  it("offers each cap only up to the ceiling the route enforces", () => {
    const help = mcpActionInputSchema(findMcpAction("update_help_assistant_budget")!);
    expect(help.safeParse({ monthlyBudgetCents: 100_000 }).success).toBe(true);
    expect(help.safeParse({ monthlyBudgetCents: 100_001 }).success).toBe(false);
    const diagnostics = mcpActionInputSchema(findMcpAction("update_ai_diagnostics_budget")!);
    expect(diagnostics.safeParse({ monthlyBudgetCents: 500_000 }).success).toBe(true);
    expect(diagnostics.safeParse({ monthlyBudgetCents: 500_001 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The page-help assistant
// ---------------------------------------------------------------------------

const HELP_ROW = { id: "default", monthlyBudgetCents: 2500, updatedAt: STAMP, updatedByMemberId: "officer-9" };

describe("get_help_assistant_budget and update_help_assistant_budget", () => {
  it("reads the cap without who saved it, the browser's answer unchanged", async () => {
    h.prisma.aiAssistantSettings.findUnique.mockResolvedValue(HELP_ROW);
    const { connection, browser } = await expectActionContract({
      actionId: "get_help_assistant_budget",
      handler: getHelpSettings,
    });
    expect(connection).toEqual({ monthlyBudgetCents: 2500, updatedAt: STAMP.toISOString() });
    expect(browser).toEqual({ monthlyBudgetCents: 2500, updatedAt: STAMP.toISOString(), updatedByMemberId: "officer-9" });
  });

  it("saves the cap the app sends", async () => {
    h.prisma.aiAssistantSettings.findUnique.mockResolvedValue(HELP_ROW);
    h.prisma.aiAssistantSettings.upsert.mockResolvedValue({ ...HELP_ROW, monthlyBudgetCents: 0 });
    const { connection } = await expectActionContract({
      actionId: "update_help_assistant_budget",
      handler: putHelpSettings,
      args: { monthlyBudgetCents: 0 },
    });
    expect(connection).toEqual({ monthlyBudgetCents: 0, updatedAt: STAMP.toISOString() });
    expect(h.prisma.aiAssistantSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { monthlyBudgetCents: 0, updatedByMemberId: "officer-1" } }),
    );
  });
});

describe("get_help_assistant_usage", () => {
  it("sends the month's figures and failures without the page each was asked on", async () => {
    h.usageSummary.mockResolvedValue({
      budget: { limitCents: 1000, warningThresholds: [0.7, 0.85, 0.95] },
      month: {
        month: "2026-07",
        requestCount: 12,
        failedCount: 1,
        inputTokens: 900,
        outputTokens: 300,
        cacheWriteTokens: 10,
        cacheReadTokens: 20,
        costCents: 45,
        usagePercent: 0.045,
        budgetStatus: "healthy",
      },
      recentFailures: [
        {
          id: "event-1",
          surface: "page-help",
          pathname: "/admin/members/member-7",
          model: "claude",
          errorCode: "timeout",
          statusCode: 504,
          errorMessage: "Timed out",
          createdAt: STAMP,
        },
      ],
      bySurface: [{ surface: "page-help", count: 12, successCount: 11, failureCount: 1 }],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "get_help_assistant_usage",
      handler: getHelpUsage,
    });
    expect(JSON.stringify(connection)).not.toContain("/admin/members/member-7");
    expect(JSON.stringify(browser)).toContain("/admin/members/member-7");
  });
});

// ---------------------------------------------------------------------------
// AI Diagnostics
// ---------------------------------------------------------------------------

describe("get_ai_diagnostics_readiness", () => {
  it("sends the readiness states whole", async () => {
    const readiness = {
      ready: false,
      moduleEnabled: null,
      keyState: "needs_reentry",
      monthlyBudgetCents: 0,
      databaseState: "not_provisioned",
      blockers: ["module_flags_unreadable", "zero_budget"],
    };
    h.moduleFlag.mockResolvedValue(null);
    h.readiness.mockResolvedValue(readiness);
    const { connection, browser } = await expectActionContract({
      actionId: "get_ai_diagnostics_readiness",
      handler: getReadiness,
    });
    expect(connection).toEqual(readiness);
    expect(browser).toEqual(readiness);
  });
});

const DIAGNOSTICS_USAGE = {
  budget: { limitCents: 5000, warningThresholds: [0.7, 0.85, 0.95], worstCaseRoundtripCents: 40, maxToolRounds: 8 },
  month: {
    month: "2026-07",
    requestCount: 3,
    roundtripCount: 9,
    failedCount: 0,
    inputTokens: 100,
    outputTokens: 50,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    settledCents: 120,
    activeReservedCents: 40,
    usagePercent: 0.024,
    budgetStatus: "healthy",
  },
  recentFailures: [
    {
      id: "failure-1",
      surface: "diagnostics",
      model: "claude",
      errorCode: "overloaded",
      statusCode: 529,
      errorMessage: "Overloaded",
      createdAt: STAMP,
    },
  ],
};

describe("get_ai_diagnostics_budget and update_ai_diagnostics_budget", () => {
  it("reads the budget, its ceiling and the month's usage", async () => {
    h.prisma.diagnosticsSettings.findUnique.mockResolvedValue({
      id: "default", monthlyBudgetCents: 5000, updatedAt: STAMP, updatedByMemberId: "officer-9",
    });
    h.diagnosticsUsage.mockResolvedValue(DIAGNOSTICS_USAGE);
    const { connection, browser } = await expectActionContract({
      actionId: "get_ai_diagnostics_budget",
      handler: getDiagnosticsSettings,
    });
    expect(connection).toMatchObject({ monthlyBudgetCents: 5000, maxMonthlyBudgetCents: 500_000 });
    expect(browser).toMatchObject({ updatedByMemberId: "officer-9" });
  });

  it("saves the budget the app sends", async () => {
    h.prisma.diagnosticsSettings.findUnique.mockResolvedValue(null);
    h.prisma.diagnosticsSettings.upsert.mockResolvedValue({
      id: "default", monthlyBudgetCents: 2000, updatedAt: STAMP, updatedByMemberId: "officer-1",
    });
    const { connection } = await expectActionContract({
      actionId: "update_ai_diagnostics_budget",
      handler: putDiagnosticsSettings,
      args: { monthlyBudgetCents: 2000 },
    });
    expect(connection).toEqual({ monthlyBudgetCents: 2000, updatedAt: STAMP.toISOString() });
  });
});

// ---------------------------------------------------------------------------
// The conversion rate
// ---------------------------------------------------------------------------

describe("get_ai_spend_rate and set_ai_spend_rate", () => {
  const currency = {
    clubCurrency: "AUD",
    isNzd: false,
    isConfigured: true,
    clubUnitsPerNzdMicros: 920_000,
    rateSetAt: STAMP,
    rateSetByMemberId: "officer-9",
  };

  it("reads the rate without who set it", async () => {
    h.loadCurrency.mockResolvedValue(currency);
    const { connection, browser } = await expectActionContract({ actionId: "get_ai_spend_rate", handler: getSpendRate });
    expect(connection).toEqual({
      clubCurrency: "AUD",
      isNzd: false,
      isConfigured: true,
      clubUnitsPerNzdMicros: 920_000,
      clubUnitsPerNzd: "0.92",
      rateSetAt: STAMP.toISOString(),
    });
    expect(browser).toMatchObject({ rateSetByMemberId: "officer-9" });
  });

  it("saves the rate as typed", async () => {
    h.loadCurrency.mockResolvedValue(currency);
    h.prisma.aiSpendCurrencySettings.findUnique.mockResolvedValue(null);
    h.prisma.aiSpendCurrencySettings.upsert.mockResolvedValue({
      id: "default", clubUnitsPerNzdMicros: 950_000, rateSetAt: STAMP, rateSetByMemberId: "officer-1",
    });
    const { connection } = await expectActionContract({
      actionId: "set_ai_spend_rate",
      handler: putSpendRate,
      args: { clubUnitsPerNzd: "0.95" },
    });
    expect(connection).toMatchObject({ clubUnitsPerNzd: "0.95", clubUnitsPerNzdMicros: 950_000 });
  });
});
