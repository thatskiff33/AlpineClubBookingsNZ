import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventCreate: vi.fn(),
  monthlyUpsert: vi.fn(),
  monthlyFindUnique: vi.fn(),
  settingsFindUnique: vi.fn(),
  eventFindMany: vi.fn(),
  transaction: vi.fn(),
  reportAiError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aiAssistantUsageEvent: {
      create: mocks.eventCreate,
      findMany: mocks.eventFindMany,
    },
    aiAssistantUsageMonthly: {
      upsert: mocks.monthlyUpsert,
      findUnique: mocks.monthlyFindUnique,
    },
    aiAssistantSettings: { findUnique: mocks.settingsFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/observability-bridge", () => ({
  reportAiError: mocks.reportAiError,
}));

// #3354: the NZD -> club-currency rate, identity unless a test sets otherwise.
// Mocked at the reader so the conversion seam is exercised without a currency
// env; the reader itself has its own suites.
const rateMocks = vi.hoisted(() => ({
  loadAiSpendCurrency: vi.fn(),
  identity: () => ({
    clubCurrency: "NZD",
    isNzd: true,
    clubUnitsPerNzdMicros: 1_000_000,
    rateSetAt: null,
    rateSetByMemberId: null,
    isConfigured: false,
  }),
  aud: (micros: number) => ({
    clubCurrency: "AUD",
    isNzd: false,
    clubUnitsPerNzdMicros: micros,
    rateSetAt: new Date("2026-06-01T00:00:00.000Z"),
    rateSetByMemberId: "admin-1",
    isConfigured: true,
  }),
}));
vi.mock("@/lib/ai-spend-currency-settings", () => ({
  AI_SPEND_CURRENCY_SETTINGS_ID: "default",
  loadAiSpendCurrency: rateMocks.loadAiSpendCurrency,
}));

import {
  aiUsageMonthKey,
  checkAiBudget,
  estimateAiCostCents,
  getAiUsageSummary,
  isAiMeteringHealthy,
  recordAiUsage,
  resetAiMeteringHealthForTests,
  WORST_CASE_CALL_CENTS,
} from "@/lib/ai-assistant-usage";

const USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheWriteTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetAiMeteringHealthForTests();
  rateMocks.loadAiSpendCurrency.mockResolvedValue(rateMocks.identity());
  // $transaction executes the array of pending ops (which are already-resolved
  // promises from the create/upsert mocks).
  mocks.transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));
  mocks.eventCreate.mockResolvedValue({});
  mocks.monthlyUpsert.mockResolvedValue({});
});

describe("aiUsageMonthKey (Pacific/Auckland)", () => {
  it("returns YYYY-MM in NZ time", () => {
    // 15 Jul 2026 12:00 UTC → 16 Jul NZST, still July.
    expect(aiUsageMonthKey(new Date("2026-07-15T12:00:00Z"))).toBe("2026-07");
  });

  it("crosses the month at the NZ boundary, not the UTC boundary", () => {
    // 30 Jun 2026 13:00 UTC is 1 Jul 01:00 NZST → the NZ month is July.
    expect(aiUsageMonthKey(new Date("2026-06-30T13:00:00Z"))).toBe("2026-07");
    // 31 Jul 2026 11:59 UTC is still 31 Jul 23:59 NZST → July.
    expect(aiUsageMonthKey(new Date("2026-07-31T11:59:00Z"))).toBe("2026-07");
  });
});

describe("estimateAiCostCents", () => {
  it("ceils the summed per-token cost and counts cache tokens", () => {
    // haiku row: 180/900/225/18 cents per MTok. At 1M each: 180+900+225+18 = 1323.
    expect(estimateAiCostCents("claude-haiku-4-5", USAGE)).toBe(1323);
  });

  it("returns 0 when there is no usage", () => {
    expect(
      estimateAiCostCents("claude-haiku-4-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(0);
  });

  it("charges a minimum of 1 cent for a tiny non-zero call", () => {
    expect(
      estimateAiCostCents("claude-haiku-4-5", {
        inputTokens: 1,
        outputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(1);
  });

  it("prices an unknown model at the highest known row (fail-expensive)", () => {
    // Only one known row, so an unknown model matches it (never cheaper).
    expect(estimateAiCostCents("some-future-model", USAGE)).toBe(1323);
  });
});

describe("checkAiBudget (fails closed)", () => {
  it("allows when spent + worst-case is within budget", async () => {
    mocks.monthlyFindUnique.mockResolvedValue({ costCents: 100 });
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
    const result = await checkAiBudget();
    expect(result).toEqual({ allowed: true, spentCents: 100, budgetCents: 1000 });
  });

  it("denies at the boundary where spent + WORST_CASE > budget", async () => {
    mocks.monthlyFindUnique.mockResolvedValue({
      costCents: 1000 - WORST_CASE_CALL_CENTS + 1,
    });
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
    const result = await checkAiBudget();
    expect(result.allowed).toBe(false);
  });

  it("uses the default budget when no settings row is stored", async () => {
    mocks.monthlyFindUnique.mockResolvedValue({ costCents: 0 });
    mocks.settingsFindUnique.mockResolvedValue(null);
    const result = await checkAiBudget();
    expect(result.budgetCents).toBe(1000);
    expect(result.allowed).toBe(true);
  });

  it("FAILS CLOSED on a DB read error", async () => {
    mocks.monthlyFindUnique.mockRejectedValue(new Error("db down"));
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
    const result = await checkAiBudget();
    expect(result.allowed).toBe(false);
  });
});

describe("recordAiUsage", () => {
  it("writes an event + monthly upsert in one transaction with the right shape", async () => {
    await recordAiUsage({
      memberId: "m-1",
      surface: "member",
      pathname: "/bookings",
      model: "claude-haiku-4-5",
      success: true,
      usage: USAGE,
      questionChars: 42,
      now: new Date("2026-07-15T12:00:00Z"),
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const eventArg = mocks.eventCreate.mock.calls[0][0];
    expect(eventArg.data).toMatchObject({
      month: "2026-07",
      memberId: "m-1",
      surface: "member",
      pathname: "/bookings",
      model: "claude-haiku-4-5",
      success: true,
      questionChars: 42,
      costCents: 1323,
    });
    const monthlyArg = mocks.monthlyUpsert.mock.calls[0][0];
    expect(monthlyArg.where).toEqual({ month: "2026-07" });
    expect(monthlyArg.update.requestCount).toEqual({ increment: 1 });
    expect(monthlyArg.update.costCents).toEqual({ increment: 1323 });
    expect(monthlyArg.update.failedCount).toEqual({ increment: 0 });
  });

  it("redacts + truncates the error message and never stores question text", async () => {
    await recordAiUsage({
      surface: "member",
      pathname: "/x",
      model: "claude-haiku-4-5",
      success: false,
      errorCode: "unknown",
      errorMessage: "failed for user alice@example.com with token abc",
      questionChars: 10,
    });
    const eventArg = mocks.eventCreate.mock.calls[0][0];
    expect(eventArg.data.errorMessage).not.toContain("alice@example.com");
    expect(eventArg.data).not.toHaveProperty("question");
    // failure increments failedCount
    expect(mocks.monthlyUpsert.mock.calls[0][0].update.failedCount).toEqual({
      increment: 1,
    });
  });

  it("bills the input on a refusal (usage present) but 0 for a token-free error", async () => {
    await recordAiUsage({
      surface: "member",
      pathname: "/x",
      model: "claude-haiku-4-5",
      success: false,
      errorCode: "refusal",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
    });
    expect(mocks.eventCreate.mock.calls[0][0].data.costCents).toBe(180);

    mocks.eventCreate.mockClear();
    await recordAiUsage({
      surface: "member",
      pathname: "/x",
      model: "claude-haiku-4-5",
      success: false,
      errorCode: "timeout",
      // no usage object → token-free error → 0 cost
    });
    expect(mocks.eventCreate.mock.calls[0][0].data.costCents).toBe(0);
  });

  it("FAILS CLOSED and reports when the delegate is missing", async () => {
    vi.resetModules();
    vi.doMock("@/lib/prisma", () => ({ prisma: {} }));
    vi.doMock("@/lib/observability-bridge", () => ({
      reportAiError: mocks.reportAiError,
    }));
    const mod = await import("@/lib/ai-assistant-usage");
    mod.resetAiMeteringHealthForTests();
    await mod.recordAiUsage({
      surface: "member",
      pathname: "/x",
      model: "claude-haiku-4-5",
      success: true,
    });
    expect(mocks.reportAiError).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/lib/prisma");
    vi.resetModules();
  });
});

describe("metering circuit breaker", () => {
  it("trips unhealthy after 3 consecutive failures and recovers on a success", async () => {
    mocks.transaction.mockRejectedValue(new Error("write failed"));
    expect(isAiMeteringHealthy()).toBe(true);
    for (let i = 0; i < 3; i++) {
      await recordAiUsage({
        surface: "member",
        pathname: "/x",
        model: "claude-haiku-4-5",
        success: true,
      });
    }
    expect(isAiMeteringHealthy()).toBe(false);
    expect(mocks.reportAiError).toHaveBeenCalledTimes(3);

    // A successful write clears the breaker.
    mocks.transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));
    await recordAiUsage({
      surface: "member",
      pathname: "/x",
      model: "claude-haiku-4-5",
      success: true,
    });
    expect(isAiMeteringHealthy()).toBe(true);
  });
});

describe("getAiUsageSummary", () => {
  it("summarises the month, budget status, and recent failures without question text", async () => {
    mocks.monthlyFindUnique.mockResolvedValue({
      requestCount: 10,
      failedCount: 2,
      inputTokens: 5,
      outputTokens: 6,
      cacheWriteTokens: 7,
      cacheReadTokens: 8,
      costCents: 900,
    });
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
    mocks.eventFindMany.mockResolvedValue([
      {
        id: "e1",
        surface: "admin",
        pathname: "/admin/x",
        model: "claude-haiku-4-5",
        success: false,
        errorCode: "unknown",
        statusCode: null,
        errorMessage: "redacted",
        createdAt: new Date("2026-07-15T00:00:00Z"),
      },
      { id: "e2", surface: "member", success: true },
    ]);

    const summary = await getAiUsageSummary(new Date("2026-07-15T12:00:00Z"));
    expect(summary.budget.limitCents).toBe(1000);
    // 900/1000 = 0.9 → ≥ 0.85 (critical) but < 0.95 (exhausted).
    expect(summary.month.budgetStatus).toBe("critical");
    expect(summary.month.usagePercent).toBeCloseTo(0.9);
    expect(summary.recentFailures).toHaveLength(1);
    expect(JSON.stringify(summary)).not.toContain("question");
    expect(summary.bySurface.length).toBeGreaterThan(0);
  });
});

describe("club-currency conversion (#3354)", () => {
  it("compares the cap against the worst-case reserve CONVERTED at the rate", async () => {
    // 16c NZD x 0.5 = 8c AUD. Spent 992 + 8 = 1000 <= 1000: admitted where the
    // unconverted 16c would have denied.
    rateMocks.loadAiSpendCurrency.mockResolvedValue(rateMocks.aud(500_000));
    mocks.monthlyFindUnique.mockResolvedValue({ costCents: 1000 - 8 });
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
    expect((await checkAiBudget()).allowed).toBe(true);
    // ...and one more cent spent is denied: the boundary moved WITH the rate.
    mocks.monthlyFindUnique.mockResolvedValue({ costCents: 1000 - 8 + 1 });
    expect((await checkAiBudget()).allowed).toBe(false);
  });

  it("reads the rate once per budget check, alongside the settings", async () => {
    mocks.monthlyFindUnique.mockResolvedValue({ costCents: 0 });
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
    await checkAiBudget();
    expect(rateMocks.loadAiSpendCurrency).toHaveBeenCalledTimes(1);
  });

  it("FAILS CLOSED when the rate cannot be read", async () => {
    rateMocks.loadAiSpendCurrency.mockRejectedValue(new Error("db down"));
    mocks.monthlyFindUnique.mockResolvedValue({ costCents: 0 });
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
    expect((await checkAiBudget()).allowed).toBe(false);
  });

  it("books the CONVERTED cost, rounded up, to the event and the month", async () => {
    // haiku at 1M of everything = 1323c NZD; x 0.92 = 1217.16 -> 1218c AUD.
    rateMocks.loadAiSpendCurrency.mockResolvedValue(rateMocks.aud(920_000));
    await recordAiUsage({
      surface: "member",
      pathname: "/bookings",
      model: "claude-haiku-4-5",
      success: true,
      usage: USAGE,
    });
    expect(mocks.eventCreate.mock.calls[0][0].data.costCents).toBe(1218);
    expect(mocks.monthlyUpsert.mock.calls[0][0].update.costCents).toEqual({
      increment: 1218,
    });
    expect(rateMocks.loadAiSpendCurrency).toHaveBeenCalledTimes(1);
  });

  it("books the NZD estimate unchanged at the identity rate", async () => {
    await recordAiUsage({
      surface: "member",
      pathname: "/bookings",
      model: "claude-haiku-4-5",
      success: true,
      usage: USAGE,
    });
    expect(mocks.eventCreate.mock.calls[0][0].data.costCents).toBe(1323);
  });

  it("treats a failed rate read as a metering failure (can't-meter => don't-spend)", async () => {
    rateMocks.loadAiSpendCurrency.mockRejectedValue(new Error("db down"));
    await recordAiUsage({
      surface: "member",
      pathname: "/bookings",
      model: "claude-haiku-4-5",
      success: true,
      usage: USAGE,
    });
    expect(mocks.eventCreate).not.toHaveBeenCalled();
    expect(mocks.reportAiError).toHaveBeenCalledTimes(1);
  });
});
