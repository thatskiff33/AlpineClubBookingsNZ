import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  // Real StaleDryRunError-shaped class so the route's `instanceof` check matches
  // (the whole resync module is mocked, so this stands in for the real export).
  class StaleDryRunError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.name = "StaleDryRunError";
      this.reason = reason;
    }
  }
  return {
    requireAdmin: vi.fn(),
    recordXeroMemberGroupingDryRun: vi.fn(),
    runXeroMemberGroupingBulkResyncChunk: vi.fn(),
    getXeroGroupingMode: vi.fn(),
    getXeroContactGroups: vi.fn(),
    getXeroContactGroupCacheLastRefreshedAt: vi.fn(),
    isXeroConnected: vi.fn(),
    logAudit: vi.fn(),
    ruleFindMany: vi.fn(),
    ruleFindFirst: vi.fn(),
    ruleCreate: vi.fn(),
    ruleUpdate: vi.fn(),
    ruleDelete: vi.fn(),
    settingsUpsert: vi.fn(),
    membershipTypeFindMany: vi.fn(),
    StaleDryRunError,
  };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/xero-member-grouping-resync", () => ({
  recordXeroMemberGroupingDryRun: mocks.recordXeroMemberGroupingDryRun,
  runXeroMemberGroupingBulkResyncChunk: mocks.runXeroMemberGroupingBulkResyncChunk,
  StaleDryRunError: mocks.StaleDryRunError,
}));
vi.mock("@/lib/xero-member-grouping", () => ({
  getXeroGroupingMode: mocks.getXeroGroupingMode,
}));
vi.mock("@/lib/xero-contact-groups", () => ({
  getXeroContactGroups: mocks.getXeroContactGroups,
  getXeroContactGroupCacheLastRefreshedAt:
    mocks.getXeroContactGroupCacheLastRefreshedAt,
}));
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroContactGroupRule: {
      findMany: mocks.ruleFindMany,
      findFirst: mocks.ruleFindFirst,
      create: mocks.ruleCreate,
      update: mocks.ruleUpdate,
      delete: mocks.ruleDelete,
    },
    xeroGroupingSettings: { upsert: mocks.settingsUpsert },
    membershipType: { findMany: mocks.membershipTypeFindMany },
  },
}));

import { GET, POST } from "@/app/api/admin/xero/member-grouping/route";

// Real admin-permissions resolution: FINANCE_USER -> finance:view,
// FINANCE_ADMIN -> finance:edit. The route's per-action edit check runs
// against these for real.
const financeViewUser = {
  id: "admin_view",
  role: "USER",
  accessRoles: [{ role: "FINANCE_USER" }],
};
const financeEditUser = {
  id: "admin_edit",
  role: "USER",
  accessRoles: [{ role: "FINANCE_ADMIN" }],
};

function grantSession(user: typeof financeViewUser) {
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user } });
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/xero/member-grouping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const snapshot = {
  mode: "MEMBERSHIP_TYPE_AND_AGE",
  cacheReady: true,
  lastRefreshedAt: "2026-07-16T00:00:00.000Z",
  activeRuleCount: 2,
  membersConsidered: 5,
  mismatchCount: 1,
  addCount: 1,
  removeCount: 0,
  estimatedXeroCalls: 3,
  skippedNoContact: [],
  mismatches: [],
  informationalCount: 0,
  informational: [],
};

describe("admin Xero member-grouping route (view/edit gating, #1934)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantSession(financeEditUser);
    mocks.getXeroGroupingMode.mockResolvedValue("MEMBERSHIP_TYPE_AND_AGE");
    mocks.ruleFindMany.mockResolvedValue([]);
    mocks.ruleFindFirst.mockResolvedValue(null);
    mocks.getXeroContactGroups.mockResolvedValue([]);
    mocks.getXeroContactGroupCacheLastRefreshedAt.mockResolvedValue(null);
    mocks.membershipTypeFindMany.mockResolvedValue([]);
    mocks.recordXeroMemberGroupingDryRun.mockResolvedValue({ snapshot, dryRunId: "dr1" });
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.settingsUpsert.mockResolvedValue({});
    mocks.logAudit.mockResolvedValue(undefined);
  });

  it("guards GET with finance:view", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "view" },
    });
  });

  it("guards POST with finance:view (not the path-inferred finance:edit)", async () => {
    grantSession(financeViewUser);
    const res = await POST(postRequest({ action: "dry-run" }));
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "view" },
    });
  });

  it("allows a finance:view admin to run the dry-run (200) and persists its provenance", async () => {
    grantSession(financeViewUser);
    const res = await POST(postRequest({ action: "dry-run", limit: 50 }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ snapshot, dryRunId: "dr1" });
    expect(mocks.recordXeroMemberGroupingDryRun).toHaveBeenCalledWith({
      limit: 50,
      createdByMemberId: "admin_view",
    });
  });

  it("rejects set-mode for a finance:view admin (403), no write", async () => {
    grantSession(financeViewUser);
    const res = await POST(postRequest({ action: "set-mode", mode: "NONE" }));
    expect(res.status).toBe(403);
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("rejects a bulk-resync missing dryRunId at the schema (400)", async () => {
    const res = await POST(
      postRequest({ action: "bulk-resync", confirmDryRunReviewed: true }),
    );
    expect(res.status).toBe(400);
    expect(mocks.runXeroMemberGroupingBulkResyncChunk).not.toHaveBeenCalled();
  });

  it("rejects bulk-resync for a finance:view admin (403), no run", async () => {
    grantSession(financeViewUser);
    const res = await POST(
      postRequest({ action: "bulk-resync", dryRunId: "dr1", confirmDryRunReviewed: true }),
    );
    expect(res.status).toBe(403);
    expect(mocks.runXeroMemberGroupingBulkResyncChunk).not.toHaveBeenCalled();
  });

  it("returns a clean 409 for bulk-resync when Xero is not connected", async () => {
    mocks.isXeroConnected.mockResolvedValue(false);
    const res = await POST(
      postRequest({ action: "bulk-resync", dryRunId: "dr1", confirmDryRunReviewed: true }),
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Xero is not connected. Connect Xero before running a bulk re-sync.",
    });
    expect(mocks.runXeroMemberGroupingBulkResyncChunk).not.toHaveBeenCalled();
  });

  it("caps the bulk-resync chunk limit at 100", async () => {
    const res = await POST(
      postRequest({ action: "bulk-resync", dryRunId: "dr1", confirmDryRunReviewed: true, limit: 500 }),
    );
    expect(res.status).toBe(400);
    expect(mocks.runXeroMemberGroupingBulkResyncChunk).not.toHaveBeenCalled();
  });

  it("runs bulk-resync with the dry-run reference + resume cursor and returns the chunk result", async () => {
    const result = {
      mode: "MEMBERSHIP_TYPE_AND_AGE",
      processed: 1,
      added: 1,
      removed: 0,
      noop: 0,
      failed: 0,
      failures: [],
      nextCursorMemberId: "m9",
      done: false,
      haltedByDailyLimit: false,
    };
    mocks.runXeroMemberGroupingBulkResyncChunk.mockResolvedValue(result);
    const res = await POST(
      postRequest({
        action: "bulk-resync",
        dryRunId: "dr1",
        confirmDryRunReviewed: true,
        limit: 25,
        afterMemberId: "m5",
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ result });
    expect(mocks.runXeroMemberGroupingBulkResyncChunk).toHaveBeenCalledWith({
      dryRunId: "dr1",
      limit: 25,
      afterMemberId: "m5",
      createdByMemberId: "admin_edit",
    });
  });

  it("maps a stale dry-run rejection to 409 and audit-logs the refusal", async () => {
    mocks.runXeroMemberGroupingBulkResyncChunk.mockRejectedValue(
      new mocks.StaleDryRunError(
        "cache_cursor_changed",
        "The Xero group cache was refreshed since this dry-run. Re-run the dry-run and review the diff before re-syncing.",
      ),
    );
    const res = await POST(
      postRequest({ action: "bulk-resync", dryRunId: "dr_old", confirmDryRunReviewed: true }),
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("cache_cursor_changed");
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "XERO_GROUPING_BULK_RESYNC_REJECTED" }),
    );
  });

  it("maps an absent dry-run rejection to 422", async () => {
    mocks.runXeroMemberGroupingBulkResyncChunk.mockRejectedValue(
      new mocks.StaleDryRunError("not_found", "No matching dry-run was found."),
    );
    const res = await POST(
      postRequest({ action: "bulk-resync", dryRunId: "missing", confirmDryRunReviewed: true }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.reason).toBe("not_found");
  });

  it("maps a forged-resume rejection (not_started) to 409 with the reason", async () => {
    mocks.runXeroMemberGroupingBulkResyncChunk.mockRejectedValue(
      new mocks.StaleDryRunError(
        "not_started",
        "This bulk re-sync was never started, so it cannot be resumed.",
      ),
    );
    const res = await POST(
      postRequest({
        action: "bulk-resync",
        dryRunId: "dr1",
        confirmDryRunReviewed: true,
        afterMemberId: "m1",
      }),
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ reason: "not_started" });
  });

  it("maps a double-initiate rejection (already_started) to 409 with the reason", async () => {
    mocks.runXeroMemberGroupingBulkResyncChunk.mockRejectedValue(
      new mocks.StaleDryRunError(
        "already_started",
        "A bulk re-sync was already started from this dry-run.",
      ),
    );
    const res = await POST(
      postRequest({ action: "bulk-resync", dryRunId: "dr1", confirmDryRunReviewed: true }),
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ reason: "already_started" });
  });

  it("still returns the typed 409/422 when audit-logging the rejection throws (no 500, FIX 3)", async () => {
    mocks.runXeroMemberGroupingBulkResyncChunk.mockRejectedValue(
      new mocks.StaleDryRunError("cache_cursor_changed", "stale"),
    );
    mocks.logAudit.mockRejectedValue(new Error("audit sink down"));
    const res = await POST(
      postRequest({ action: "bulk-resync", dryRunId: "dr1", confirmDryRunReviewed: true }),
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ reason: "cache_cursor_changed" });
  });

  it("create-rule canonical-sorts the tier set before persisting (#2093)", async () => {
    mocks.ruleCreate.mockResolvedValue({ id: "rule-new" });
    const res = await POST(
      postRequest({
        action: "create-rule",
        // Deliberately reversed + duplicated tier order.
        ageTiers: ["YOUTH", "ADULT", "YOUTH"],
        mode: "MANAGED",
        groupId: "g1",
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.ruleCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ ageTiers: ["YOUTH", "ADULT"] }),
    });
  });

  it("create-rule collapses a full-tier selection to [] (all age tiers)", async () => {
    mocks.ruleCreate.mockResolvedValue({ id: "rule-new" });
    const res = await POST(
      postRequest({
        action: "create-rule",
        ageTiers: ["INFANT", "CHILD", "YOUTH", "ADULT", "NOT_APPLICABLE"],
        mode: "MANAGED",
        groupId: "g1",
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.ruleCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ ageTiers: [] }),
    });
  });

  it("create-rule with no ageTiers defaults to [] (all age tiers)", async () => {
    mocks.ruleCreate.mockResolvedValue({ id: "rule-new" });
    const res = await POST(
      postRequest({ action: "create-rule", mode: "MANAGED", groupId: "g1" }),
    );
    expect(res.status).toBe(200);
    expect(mocks.ruleCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ ageTiers: [] }),
    });
  });

  it("rejects a duplicate rule shape via canonical-array dedupe (409)", async () => {
    // findFirst is queried with the canonical (sorted) tier set.
    mocks.ruleFindFirst.mockResolvedValue({ id: "existing" });
    const res = await POST(
      postRequest({
        action: "create-rule",
        ageTiers: ["YOUTH", "ADULT"],
        mode: "MANAGED",
        groupId: "g1",
      }),
    );
    expect(res.status).toBe(409);
    expect(mocks.ruleFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        // Canonical order is INFANT < CHILD < YOUTH < ADULT < NOT_APPLICABLE.
        where: expect.objectContaining({ ageTiers: { equals: ["YOUTH", "ADULT"] } }),
      }),
    );
    expect(mocks.ruleCreate).not.toHaveBeenCalled();
  });

  it("rejects an all-tiers duplicate when a full-tick selection collapses to [] (friendly 409)", async () => {
    // An existing "all age tiers" rule is stored as []. A create that ticks all
    // five tiers collapses to [] in normalizeRule, so isDuplicateRuleShape must
    // query findFirst with the empty array and return the friendly 409 — never
    // falling through to the DB unique-index P2002.
    mocks.ruleFindFirst.mockResolvedValue({ id: "existing-all-tiers" });
    const res = await POST(
      postRequest({
        action: "create-rule",
        ageTiers: ["INFANT", "CHILD", "YOUTH", "ADULT", "NOT_APPLICABLE"],
        mode: "MANAGED",
        groupId: "g1",
      }),
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error:
        "A rule with the same membership type, age tiers, mode, and Xero group already exists.",
    });
    expect(mocks.ruleFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ageTiers: { equals: [] } }),
      }),
    );
    expect(mocks.ruleCreate).not.toHaveBeenCalled();
  });

  it("allows set-mode for a finance:edit admin", async () => {
    const res = await POST(postRequest({ action: "set-mode", mode: "NONE" }));
    expect(res.status).toBe(200);
    expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        update: { mode: "NONE", updatedByMemberId: "admin_edit" },
      }),
    );
  });
});
