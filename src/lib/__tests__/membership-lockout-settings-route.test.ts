import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-focused test for the membership-lockout-settings route (#1940). Mirrors
// the fee-configuration-route pattern: mock `requireAdmin` so we can assert the
// exact per-area permission each verb requires and that a denial short-circuits
// with 403 before any write.
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  auditLogCreate: vi.fn(),
  getFinancialYearResolution: vi.fn(),
  refreshFinancialYearConfig: vi.fn(),
  transaction: vi.fn(),
  lockSeason: vi.fn(),
  lockRule: vi.fn(),
  clearStale: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipLockoutSettings: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
    auditLog: { create: mocks.auditLogCreate },
    $transaction: mocks.transaction,
  },
}));

// #5190: the liability clear-up and its season key.
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: async () => "Pacific/Auckland" }));
vi.mock("@/lib/subscription-billing-season-lock", () => ({
  lockSubscriptionBillingSeason: mocks.lockSeason,
}));
vi.mock("@/lib/subscription-liability-rule-lock", () => ({
  lockSubscriptionLiabilityRuleExclusive: mocks.lockRule,
}));
vi.mock("@/lib/member-subscription-defaults", async (importOriginal) => ({
  // The real audit shaper, so the route's audit row is checked as written.
  clearedRowsAuditMetadata: (
    (await importOriginal()) as typeof import("@/lib/member-subscription-defaults")
  ).clearedRowsAuditMetadata,
  clearStaleNotRequiredRows: mocks.clearStale,
}));

vi.mock("@/lib/financial-year-server", () => ({
  getFinancialYearResolution: mocks.getFinancialYearResolution,
  refreshFinancialYearConfig: mocks.refreshFinancialYearConfig,
}));

import {
  GET as getLockoutSettings,
  PUT as putLockoutSettings,
} from "@/app/api/admin/membership-lockout-settings/route";

const session = {
  user: {
    id: "admin-1",
    // Finance view is required for the fee-schedule preview (#2109 FIX-4b); the
    // default session holds it so the preview assertions below see the code
    // lists. A finance-less admin is covered by its own case.
    adminPermissionMatrix: { membership: "edit", finance: "view" },
  },
};

function request(body: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/membership-lockout-settings",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function setUpMocks() {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session });
  mocks.findUnique.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue({
    id: "default",
    mode: "HARD_BLOCK",
    financialYearEndMonthOverride: null,
    textFallbackEnabled: true,
    useFeeScheduleItemCodes: false,
  });
  mocks.auditLogCreate.mockResolvedValue({});
  mocks.getFinancialYearResolution.mockResolvedValue({});
  mocks.refreshFinancialYearConfig.mockResolvedValue(3);
  mocks.order.length = 0;
  const tx = {
    membershipLockoutSettings: {
      upsert: async (args: unknown) => {
        mocks.order.push("upsert");
        return mocks.upsert(args);
      },
    },
  };
  mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
    callback(tx),
  );
  mocks.lockSeason.mockImplementation(async (_tx: unknown, seasonYear: number) => {
    mocks.order.push(`lock:${seasonYear}`);
  });
  mocks.lockRule.mockImplementation(async () => {
    mocks.order.push("rule-lock");
  });
  mocks.clearStale.mockImplementation(async (_tx: unknown, seasonYear: number) => {
    mocks.order.push(`clear:${seasonYear}`);
    return { clearedCount: 3, clearedMemberIds: ["m1", "m2", "m3"] };
  });
}

describe("membership lockout settings route guards (#1940)", () => {
  beforeEach(setUpMocks);

  it("requires membership view for reads", async () => {
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValueOnce({ ok: false, response: forbidden });

    expect((await getLockoutSettings()).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "membership", level: "view" },
    });
  });

  it("requires membership edit before parsing writes", async () => {
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValueOnce({ ok: false, response: forbidden });

    // A denied write is rejected before the body is ever parsed/persisted.
    expect(
      (await putLockoutSettings(request({ mode: "NO_BLOCK" }))).status,
    ).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "membership", level: "edit" },
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("persists the update for a membership edit admin", async () => {
    const response = await putLockoutSettings(request({ mode: "NO_BLOCK" }));

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // #2543 — the three-way mode, now the only column (#2561 dropped the boolean).
  // ---------------------------------------------------------------------------

  it.each(["NO_BLOCK", "HARD_BLOCK", "NON_MEMBER_PRICING"] as const)(
    "persists mode %s, and writes NO legacy column with it",
    async (mode) => {
      const response = await putLockoutSettings(request({ mode }));

      expect(response.status).toBe(200);
      const upsertArgs = mocks.upsert.mock.calls[0][0];
      expect(upsertArgs.update).toEqual(expect.objectContaining({ mode }));
      expect(upsertArgs.create).toEqual(expect.objectContaining({ mode }));
      // Asserted as an ABSENCE, deliberately. The dual write is gone with the
      // column, and reintroducing it would make Prisma raise on an unknown field
      // at runtime — a 500 on the admin panel — rather than fail a type check,
      // because these mocks accept any shape.
      expect(upsertArgs.update).not.toHaveProperty("enabled");
      expect(upsertArgs.create).not.toHaveProperty("enabled");
    },
  );

  it("refuses a legacy `enabled` body rather than silently ignoring it", async () => {
    // Still valuable after the column is dropped (#2561), and arguably more so: the
    // schema is .strict(), and a silent ignore is the dangerous direction — an old
    // client's "turn the lockout off" click would report success while the club
    // carried on hard-blocking members.
    const response = await putLockoutSettings(request({ enabled: false }));

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a mode outside the three-way vocabulary", async () => {
    const response = await putLockoutSettings(request({ mode: "MAYBE_BLOCK" }));

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("an unrelated field save PRESERVES the stored mode", async () => {
    // This club deliberately switched the lockout OFF. Saving a DIFFERENT field on
    // the same panel must not resurrect it — the regression this case exists to
    // catch is `before.mode ?? "HARD_BLOCK"`, which would, and which survives the
    // #2561 drop unchanged as a hazard.
    mocks.findUnique.mockResolvedValue({
      id: "default",
      mode: "NO_BLOCK",
      financialYearEndMonthOverride: null,
      textFallbackEnabled: true,
      useFeeScheduleItemCodes: false,
    });

    const response = await putLockoutSettings(
      request({ useFeeScheduleItemCodes: true }),
    );

    expect(response.status).toBe(200);
    expect(mocks.upsert.mock.calls[0][0].update).toEqual(
      expect.objectContaining({ mode: "NO_BLOCK", useFeeScheduleItemCodes: true }),
    );
  });

  it("accepts and persists useFeeScheduleItemCodes (#2109)", async () => {
    const response = await putLockoutSettings(
      request({ useFeeScheduleItemCodes: true }),
    );

    expect(response.status).toBe(200);
    const upsertArgs = mocks.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toEqual(
      expect.objectContaining({ useFeeScheduleItemCodes: true }),
    );
    expect(upsertArgs.create).toEqual(
      expect.objectContaining({ useFeeScheduleItemCodes: true }),
    );
  });

  it("rejects an unknown field via the strict schema", async () => {
    const response = await putLockoutSettings(request({ bogusField: true }));
    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("GET returns the fee-schedule detection preview for a finance-view admin (#2109)", async () => {
    const response = await getLockoutSettings();
    expect(response.status).toBe(200);
    const body = await response.json();
    // The resolver/overlap reads degrade to [] under the route's minimal prisma
    // mock, but the preview keys are present for a finance-view admin.
    expect(body).toEqual(
      expect.objectContaining({
        feeScheduleItemCodes: expect.any(Array),
        overlappingCodes: expect.any(Array),
      }),
    );
  });

  it("GET omits the fee-schedule preview for an admin without finance view (#2109 FIX-4b)", async () => {
    // A membership-only admin gets the settings without the finance-domain code
    // lists; the panel hides the detection card for them and defaults to [].
    mocks.requireAdmin.mockResolvedValueOnce({
      ok: true,
      session: {
        user: { id: "admin-1", adminPermissionMatrix: { membership: "edit" } },
      },
    });

    const response = await getLockoutSettings();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.settings).toBeDefined();
    expect(body.feeScheduleItemCodes).toBeUndefined();
    expect(body.overlappingCodes).toBeUndefined();
  });
});

describe("membership lockout settings route: the subscription liability rule (#5190)", () => {
  beforeEach(() => {
    setUpMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockImplementation(async (args: { update: object }) => ({
      id: "default",
      ...args.update,
    }));
  });

  const chosen = { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_START" };

  it.each([
    ["only one answer", { requiredTypeAgeRule: "ALWAYS_OWES" }],
    ["the other answer alone", { liabilityAgeSource: "SEASON_END" }],
    ["half not chosen", { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "NOT_CHOSEN" }],
    ["age today, until part-season invoices ship", { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "CURRENT_AGE" }],
  ])("refuses %s, writing nothing", async (_label, body) => {
    const response = await putLockoutSettings(request(body));
    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.clearStale).not.toHaveBeenCalled();
  });

  it("refuses to move a chosen club back to NOT_CHOSEN", async () => {
    mocks.findUnique.mockResolvedValue({ id: "default", mode: "HARD_BLOCK", ...chosen });
    const response = await putLockoutSettings(
      request({ requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("accepts an unchanged NOT_CHOSEN pair from a club still on it, without writing the columns", async () => {
    const response = await putLockoutSettings(
      request({ requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" }),
    );
    expect(response.status).toBe(200);
    const update = mocks.upsert.mock.calls[0]?.[0]?.update as Record<string, unknown>;
    expect(update).not.toHaveProperty("requiredTypeAgeRule");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("opts in inside one transaction: season lock, then the rule lock, then the settings, then the clear-up", async () => {
    const response = await putLockoutSettings(request(chosen));
    expect(response.status).toBe(200);
    // The frozen test clock is 1 July 2026: season 2026.
    expect(mocks.order).toEqual(["lock:2026", "rule-lock", "upsert", "clear:2026"]);
    expect(mocks.upsert.mock.calls[0]?.[0]?.update).toMatchObject(chosen);
    const audit = mocks.auditLogCreate.mock.calls[0]?.[0] as { data: { metadata: unknown } };
    expect(JSON.stringify(audit)).toContain("clearedStaleNotRequiredRows");
    // The audit names the members the clear-up moved, not just a count.
    expect(JSON.stringify(audit)).toContain(
      JSON.stringify({ seasonYear: 2026, total: 3, memberIds: ["m1", "m2", "m3"], memberIdsTruncated: false }),
    );
  });

  it("a save that omits the pair leaves it out of the write, and re-runs the clear-up for a chosen club", async () => {
    mocks.findUnique.mockResolvedValue({ id: "default", mode: "HARD_BLOCK", ...chosen });
    const response = await putLockoutSettings(request({ mode: "NO_BLOCK" }));
    expect(response.status).toBe(200);
    const update = mocks.upsert.mock.calls[0]?.[0]?.update as Record<string, unknown>;
    expect(update).not.toHaveProperty("requiredTypeAgeRule");
    expect(update).not.toHaveProperty("liabilityAgeSource");
    expect(mocks.order).toEqual(["lock:2026", "rule-lock", "upsert", "clear:2026"]);
  });

  it("a save on a NOT_CHOSEN club runs no clear-up and opens no transaction", async () => {
    const response = await putLockoutSettings(request({ mode: "NO_BLOCK" }));
    expect(response.status).toBe(200);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.clearStale).not.toHaveBeenCalled();
  });
});
