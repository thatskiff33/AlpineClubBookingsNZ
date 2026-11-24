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
vi.mock("@/lib/subscription-billing-season-lock", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/subscription-billing-season-lock")),
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
import {
  SUBSCRIPTION_BILLING_CONFIRM_TIMEOUT_MS,
  SUBSCRIPTION_BILLING_SEASON_WAITER_TIMEOUT_MS,
} from "@/lib/subscription-billing-season-lock";

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

// #5190 (owner decision 23 Nov 2026): choosing the rule needs both areas.
const liabilitySession = {
  user: { id: "admin-1", adminPermissionMatrix: { membership: "edit", finance: "edit" } },
};

describe("membership lockout settings route: the subscription liability rule (#5190)", () => {
  beforeEach(() => {
    setUpMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: liabilitySession });
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

  it("opts in inside one transaction: season lock, then the settings, then the clear-up", async () => {
    const response = await putLockoutSettings(request(chosen));
    expect(response.status).toBe(200);
    // The frozen test clock is 1 July 2026: season 2026. The save takes no
    // rule key of its own (#5190 review): the clear-up takes it, after the
    // upsert, so the save never holds it while waiting on the settings row.
    expect(mocks.order).toEqual(["lock:2026", "upsert", "clear:2026"]);
    expect(mocks.lockRule).not.toHaveBeenCalled();
    // The save waits on the season key, which a billing confirm may hold for
    // its whole budget, so its transaction outlasts confirm's (P2028 otherwise).
    expect(mocks.transaction.mock.calls[0]?.[1]).toEqual({
      timeout: SUBSCRIPTION_BILLING_SEASON_WAITER_TIMEOUT_MS,
    });
    expect(SUBSCRIPTION_BILLING_SEASON_WAITER_TIMEOUT_MS).toBeGreaterThan(
      SUBSCRIPTION_BILLING_CONFIRM_TIMEOUT_MS,
    );
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
    expect(mocks.order).toEqual(["lock:2026", "upsert", "clear:2026"]);
  });

  it("a save on a NOT_CHOSEN club runs no clear-up and opens no transaction", async () => {
    const response = await putLockoutSettings(request({ mode: "NO_BLOCK" }));
    expect(response.status).toBe(200);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.clearStale).not.toHaveBeenCalled();
  });
});

describe("membership lockout settings route: who may choose the liability rule (#5190)", () => {
  beforeEach(setUpMocks);

  const chosen = { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" };
  const asAdmin = (membership: string, finance: string) =>
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1", adminPermissionMatrix: { membership, finance } } },
    });

  it.each([
    ["membership edit only", "edit", "view"],
    ["membership edit, no finance", "edit", "none"],
    ["finance edit with membership view", "view", "edit"],
  ])("refuses a rule change for %s, writing nothing", async (_label, membership, finance) => {
    asAdmin(membership, finance);
    // The route's own guard is membership edit; a finance-only caller stops there.
    if (membership !== "edit") {
      mocks.requireAdmin.mockResolvedValueOnce({
        ok: false,
        response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      });
    }
    const response = await putLockoutSettings(request(chosen));
    expect(response.status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("refuses even an invalid half-change from a membership-only admin (fails closed)", async () => {
    asAdmin("edit", "view");
    const response = await putLockoutSettings(request({ requiredTypeAgeRule: "ALWAYS_OWES" }));
    expect(response.status).toBe(403);
  });

  it("lets an admin with membership edit and finance edit choose the rule", async () => {
    asAdmin("edit", "edit");
    mocks.upsert.mockImplementation(async (args: { update: object }) => ({ id: "default", ...args.update }));
    const response = await putLockoutSettings(request(chosen));
    expect(response.status).toBe(200);
    expect(mocks.upsert.mock.calls[0]?.[0]?.update).toMatchObject(chosen);
  });

  it("lets an admin with membership edit and finance edit change one chosen rule to another", async () => {
    asAdmin("edit", "edit");
    const changed = { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_END" };
    mocks.findUnique.mockResolvedValue({ id: "default", mode: "HARD_BLOCK", ...chosen });
    // The clear-up must see the new pair already written, not the stored one.
    let committedRow: Record<string, unknown> = { id: "default", mode: "HARD_BLOCK", ...chosen };
    let rowAtClearUp: Record<string, unknown> | undefined;
    mocks.upsert.mockImplementation(async (args: { update: Record<string, unknown> }) => {
      committedRow = { ...committedRow, ...args.update };
      return committedRow;
    });
    mocks.clearStale.mockImplementation(async (_tx: unknown, seasonYear: number) => {
      mocks.order.push(`clear:${seasonYear}`);
      rowAtClearUp = { ...committedRow };
      return { clearedCount: 0, clearedMemberIds: [] };
    });
    const response = await putLockoutSettings(request(changed));
    expect(response.status).toBe(200);
    expect(mocks.upsert.mock.calls[0]?.[0]?.update).toMatchObject(changed);
    expect(mocks.order).toEqual(["lock:2026", "upsert", "clear:2026"]);
    expect(rowAtClearUp).toMatchObject(changed);
  });

  it("a membership-only admin may still save other settings, echoing the stored pair", async () => {
    asAdmin("edit", "view");
    mocks.findUnique.mockResolvedValue({ id: "default", mode: "HARD_BLOCK", ...chosen });
    const response = await putLockoutSettings(request({ mode: "NO_BLOCK", ...chosen }));
    expect(response.status).toBe(200);
    expect(mocks.upsert.mock.calls[0]?.[0]?.update).toMatchObject({ mode: "NO_BLOCK" });
  });

  it("never writes back the pair a membership-only admin echoed, so a rule changed after its read stands (#5190 review)", async () => {
    // Interleaving: the membership-only save reads `chosen`; a membership and
    // finance admin's change to `changed` commits before its upsert runs. The
    // echo passed the permission check against the earlier read, so writing it
    // would undo a rule choice this admin may not make (owner decision 23 Nov
    // 2026). The row the upsert lands on is modelled as already holding `changed`.
    asAdmin("edit", "view");
    const changed = { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_END" };
    mocks.findUnique.mockResolvedValue({ id: "default", mode: "HARD_BLOCK", ...chosen });
    let committedRow: Record<string, unknown> = { id: "default", mode: "HARD_BLOCK", ...changed };
    mocks.upsert.mockImplementation(async (args: { update: Record<string, unknown> }) => {
      committedRow = { ...committedRow, ...args.update };
      return committedRow;
    });
    const response = await putLockoutSettings(request({ mode: "NO_BLOCK", ...chosen }));
    expect(response.status).toBe(200);
    const update = mocks.upsert.mock.calls[0]?.[0]?.update as Record<string, unknown>;
    expect(update).not.toHaveProperty("requiredTypeAgeRule");
    expect(update).not.toHaveProperty("liabilityAgeSource");
    expect(committedRow).toMatchObject({ mode: "NO_BLOCK", ...changed });
    // The clear-up still runs, and reads the committed rule under its own lock.
    expect(mocks.order).toEqual(["lock:2026", "upsert", "clear:2026"]);
  });
});

describe("membership lockout settings route: contention (#5190 review)", () => {
  beforeEach(() => {
    setUpMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: liabilitySession });
  });

  const contention = (code: string) => Object.assign(new Error(code), { code });

  it.each(["P2028", "P2034"])(
    "answers a chosen-rule save's %s with 503 and writes no audit row",
    async (code) => {
      mocks.transaction.mockRejectedValueOnce(contention(code));
      const response = await putLockoutSettings(
        request({ requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" }),
      );
      expect(response.status).toBe(503);
      expect((await response.json()).error).toMatch(/try again/i);
      expect(mocks.auditLogCreate).not.toHaveBeenCalled();
      expect(mocks.refreshFinancialYearConfig).not.toHaveBeenCalled();
    },
  );

  it("answers the singleton create race (P2002) on a plain save with 503", async () => {
    mocks.upsert.mockRejectedValueOnce(contention("P2002"));
    const response = await putLockoutSettings(request({ mode: "NO_BLOCK" }));
    expect(response.status).toBe(503);
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("rethrows anything else", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("boom"));
    await expect(
      putLockoutSettings(
        request({ requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" }),
      ),
    ).rejects.toThrow("boom");
  });
});
