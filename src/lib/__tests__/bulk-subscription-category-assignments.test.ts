import { beforeEach, describe, expect, it, vi } from "vitest";

// #5248: bulk set / clear of a subscription category. The wrapper must reuse
// the single-member preview and save (same token, no-op suppression and
// per-member critical audit), keep each member's own membership type, skip the
// members it cannot change with a reason, and write one summary audit.
vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

const mockTriggerGroupSync = vi.fn();
const mockReconcileGroups = vi
  .fn()
  .mockResolvedValue({ processed: 0, failed: 0, haltedByDailyLimit: false });
vi.mock("@/lib/xero-contact-groups", () => ({
  triggerMemberXeroContactGroupSync: (...args: unknown[]) => mockTriggerGroupSync(...args),
  reconcileMembersXeroContactGroups: (...args: unknown[]) => mockReconcileGroups(...args),
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  acquireFuturePartnerSharedAllocationLocks: vi.fn().mockResolvedValue(undefined),
  sweepFuturePartnerSharedAllocationsWithLocksHeld: vi.fn().mockResolvedValue([]),
  describePartnerSharedSweepReason: vi.fn(() => "age tier changed"),
  partnerShareSweepCounterpartNames: vi.fn(() => "Partner"),
  partnerShareSweepNights: vi.fn(() => 0),
}));
vi.mock("@/lib/email", () => ({
  sendAdminPartnerShareSweptAlert: vi.fn().mockResolvedValue(undefined),
}));
const mockLoggerError = vi.fn();
vi.mock("@/lib/logger", () => ({
  default: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));
// The season-row reconcile reads the club's age-tier settings for the shared
// liability rule (#5190); with no rows the real reader returns the documented
// defaults, so the mock does the same, as the bulk seasonal test does.
vi.mock("@/lib/age-tier", async () => {
  const { AGE_TIER_DEFAULTS, cloneAgeTierSettings } = (await vi.importActual(
    "@/lib/policies/age-tier",
  )) as typeof import("@/lib/policies/age-tier");
  return {
    computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
    getSeasonStartDate: vi.fn(() => new Date("2026-04-01")),
    getAgeTierSettingsStrict: vi.fn(async () =>
      cloneAgeTierSettings(AGE_TIER_DEFAULTS),
    ),
  };
});

import {
  bulkSaveSubscriptionCategory,
  previewBulkSubscriptionCategory,
  SUBSCRIPTION_CATEGORY_BULK_CHANGE_ACTION,
} from "@/lib/bulk-subscription-category-assignments";
import { SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION } from "@/lib/seasonal-membership-assignments";
import { BULK_SEASONAL_SAVE_THREW_MESSAGE } from "@/lib/bulk-seasonal-save";

// The frozen clock is 1 July 2026: season 2026 on the default 31-March year-end.
const SEASON = 2026;
const NOW = new Date("2026-07-01T00:00:00.000Z");

const personTiers = [
  { ageTier: "INFANT" },
  { ageTier: "CHILD" },
  { ageTier: "YOUTH" },
  { ageTier: "ADULT" },
];

function membershipType(id: string, isActive = true) {
  return {
    id,
    key: id.toUpperCase(),
    name: id,
    description: null,
    isActive,
    isBuiltIn: false,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 0,
    allowedAgeTiers: personTiers,
  };
}

const CATEGORIES: Record<string, any> = {
  "cat-couple": { id: "cat-couple", key: "couple", name: "Couple", isActive: true, isBuiltIn: false },
  "cat-family": { id: "cat-family", key: "family", name: "Family", isActive: true, isBuiltIn: false },
  "cat-old": { id: "cat-old", key: "old", name: "Old", isActive: false, isBuiltIn: false },
  "cat-individual": { id: "cat-individual", key: "individual", name: "Individual", isActive: true, isBuiltIn: true },
};

interface MemberConfig {
  /** null = no assignment for the season. */
  typeId: string | null;
  typeActive?: boolean;
  categoryId?: string | null;
  ageTier?: string;
  archived?: boolean;
  subscriptionStatus?: string;
  /** The assignment upsert rejects, as a deadlock would. */
  throwOnSave?: boolean;
}

function makeDb(members: Record<string, MemberConfig>) {
  const assignments = new Map<string, any>();
  for (const [memberId, cfg] of Object.entries(members)) {
    if (!cfg.typeId) continue;
    assignments.set(memberId, {
      id: `assignment-${memberId}`,
      memberId,
      seasonYear: SEASON,
      membershipTypeId: cfg.typeId,
      subscriptionCategoryId: cfg.categoryId ?? null,
      applyFrom: null,
      assignedByMemberId: "admin-old",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
  }
  const withRelations = (row: any) =>
    row && {
      ...row,
      membershipType: membershipType(row.membershipTypeId, members[row.memberId]?.typeActive ?? true),
      subscriptionCategory: row.subscriptionCategoryId ? CATEGORIES[row.subscriptionCategoryId] : null,
    };

  const db: any = {
    member: {
      findUnique: vi.fn(async ({ where }: any) => {
        const cfg = members[where.id];
        if (!cfg) return null;
        return {
          id: where.id,
          ageTier: cfg.ageTier ?? "ADULT",
          dateOfBirth: null,
          role: "USER",
          canLogin: true,
          accessRoles: [{ role: "USER" }],
          firstName: "Member",
          lastName: where.id,
        };
      }),
      findMany: vi.fn(async ({ where, select }: any) => {
        if (select?.inheritEmailChoiceId) return [];
        return (where.id.in as string[])
          .filter((id) => members[id])
          .map((id) => ({
            id,
            firstName: "Member",
            lastName: id,
            email: `${id}@test.example`,
            archivedAt: members[id]!.archived ? new Date("2026-01-01") : null,
          }));
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    membershipType: {
      findUnique: vi.fn(async ({ where }: any) => {
        const owner = Object.values(members).find((cfg) => cfg.typeId === where.id);
        return membershipType(where.id, owner?.typeActive ?? true);
      }),
    },
    subscriptionCategory: {
      findUnique: vi.fn(async ({ where }: any) => CATEGORIES[where.id] ?? null),
    },
    seasonalMembershipAssignment: {
      findMany: vi.fn(async ({ where }: any) =>
        (where.memberId.in as string[])
          .map((id) => assignments.get(id))
          .filter(Boolean)
          .map(withRelations),
      ),
      findUnique: vi.fn(async ({ where }: any) =>
        withRelations(assignments.get(where.memberId_seasonYear.memberId)) ?? null,
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: any) =>
        withRelations(assignments.get(where.memberId_seasonYear.memberId)),
      ),
      upsert: vi.fn(async ({ where, update }: any) => {
        if (members[where.memberId_seasonYear.memberId]?.throwOnSave) {
          throw new Error(`DB deadlock saving ${where.memberId_seasonYear.memberId}`);
        }
        const memberId = where.memberId_seasonYear.memberId;
        const next = { ...assignments.get(memberId), ...update };
        assignments.set(memberId, next);
        return withRelations(next);
      }),
    },
    booking: { findMany: vi.fn().mockResolvedValue([]) },
    bookingGuest: { findMany: vi.fn().mockResolvedValue([]) },
    memberSubscription: {
      findMany: vi.fn(async ({ where }: any) => {
        const status = members[where.memberId]?.subscriptionStatus;
        return status
          ? [{ id: "sub", seasonYear: SEASON, status, xeroInvoiceId: "inv", xeroInvoiceNumber: "INV-1", paidAt: null }]
          : [];
      }),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // #5190: the club's liability rule; a missing row is NOT_CHOSEN.
    membershipLockoutSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(async (cb: any) => cb(db)),
  };
  return { db, assignments };
}

async function preview(db: any, ids: string[], subscriptionCategoryId: string | null) {
  return previewBulkSubscriptionCategory({
    ids,
    seasonYear: SEASON,
    subscriptionCategoryId,
    now: NOW,
    clubCurrentSeasonYear: SEASON,
    db,
  });
}

async function tokensFor(db: any, ids: string[], subscriptionCategoryId: string | null) {
  const body = (await preview(db, ids, subscriptionCategoryId)).body as any;
  return Object.fromEntries(
    body.members.map((row: any) => [row.memberId, row.previewToken]),
  ) as Record<string, string>;
}

function save(db: any, ids: string[], subscriptionCategoryId: string | null, previewTokens: Record<string, string>) {
  return bulkSaveSubscriptionCategory({
    ids,
    seasonYear: SEASON,
    subscriptionCategoryId,
    adminMemberId: "admin-1",
    reason: "Moving couples to the Couple category",
    previewTokens,
    db,
  });
}

function auditActions(db: any): string[] {
  return db.auditLog.create.mock.calls.map((call: any[]) => call[0].data.action);
}

describe("bulk subscription category (#5248)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReconcileGroups.mockResolvedValue({ processed: 0, failed: 0, haltedByDailyLimit: false });
    process.env.AUTH_SECRET = "bulk-category-test-secret";
  });

  it("previews who changes, from what to what, and flags members already billed", async () => {
    const { db } = makeDb({
      "m-1": { typeId: "full" },
      "m-2": { typeId: "full", categoryId: "cat-couple" },
      "m-3": { typeId: "full", subscriptionStatus: "PAID" },
    });

    const body = (await preview(db, ["m-1", "m-2", "m-3"], "cat-couple")).body as any;

    expect(body.members.map((row: any) => [row.memberId, row.currentCategory?.name ?? null, row.newCategory?.name, row.changed])).toEqual([
      ["m-1", null, "Couple", true],
      ["m-2", "Couple", "Couple", false],
      ["m-3", null, "Couple", true],
    ]);
    expect(body.summary).toMatchObject({ requested: 3, changed: 2, unchanged: 1, alreadyBilled: 1 });
  });

  it("sets the category, keeps each member's own membership type, and audits per member plus one summary", async () => {
    const { db, assignments } = makeDb({
      "m-1": { typeId: "full" },
      "m-2": { typeId: "associate", categoryId: "cat-family" },
    });
    const tokens = await tokensFor(db, ["m-1", "m-2"], "cat-couple");

    const body = (await save(db, ["m-1", "m-2"], "cat-couple", tokens)).body as any;

    expect(body.results.map((r: any) => r.outcome)).toEqual(["changed", "changed"]);
    expect(body.changedMemberIds).toEqual(["m-1", "m-2"]);
    expect(assignments.get("m-1")).toMatchObject({ membershipTypeId: "full", subscriptionCategoryId: "cat-couple" });
    expect(assignments.get("m-2")).toMatchObject({ membershipTypeId: "associate", subscriptionCategoryId: "cat-couple" });

    const actions = auditActions(db);
    expect(actions.filter((a) => a === SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION)).toHaveLength(2);
    expect(actions.filter((a) => a === SUBSCRIPTION_CATEGORY_BULK_CHANGE_ACTION)).toHaveLength(1);
    const memberAudit = db.auditLog.create.mock.calls
      .map((call: any[]) => call[0].data)
      .find((data: any) => data.action === SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION && data.subjectMemberId === "m-2");
    expect(memberAudit.metadata).toMatchObject({
      previousSubscriptionCategory: { id: "cat-family" },
      newSubscriptionCategory: { id: "cat-couple" },
      subscriptionCategoryChanged: true,
    });
    const summary = db.auditLog.create.mock.calls
      .map((call: any[]) => call[0].data)
      .find((data: any) => data.action === SUBSCRIPTION_CATEGORY_BULK_CHANGE_ACTION);
    expect(summary).toMatchObject({ severity: "important", metadata: { outcomeCounts: { changed: 2 } } });

    // A category-only change does not move Xero grouping today.
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
    expect(mockReconcileGroups).not.toHaveBeenCalled();
  });

  it("clears the category back to Individual with null", async () => {
    const { db, assignments } = makeDb({ "m-1": { typeId: "full", categoryId: "cat-couple" } });
    const tokens = await tokensFor(db, ["m-1"], null);

    const body = (await save(db, ["m-1"], null, tokens)).body as any;

    expect(body.results[0].outcome).toBe("changed");
    expect(assignments.get("m-1")).toMatchObject({ membershipTypeId: "full", subscriptionCategoryId: null });
  });

  it("writes nothing and no per-member audit for a member already in the target category", async () => {
    const { db } = makeDb({ "m-1": { typeId: "full", categoryId: "cat-couple" } });
    const tokens = await tokensFor(db, ["m-1"], "cat-couple");

    const body = (await save(db, ["m-1"], "cat-couple", tokens)).body as any;

    expect(body.results[0].outcome).toBe("unchanged");
    expect(db.seasonalMembershipAssignment.upsert).not.toHaveBeenCalled();
    expect(auditActions(db)).toEqual([SUBSCRIPTION_CATEGORY_BULK_CHANGE_ACTION]);
  });

  it("skips archived, missing, unassigned and archived-type members with a reason, in preview and save", async () => {
    const { db } = makeDb({
      "m-ok": { typeId: "full" },
      "m-archived": { typeId: "full", archived: true },
      "m-unassigned": { typeId: null },
      "m-oldtype": { typeId: "retired", typeActive: false },
    });
    const ids = ["m-ok", "m-archived", "m-gone", "m-unassigned", "m-oldtype"];

    const previewBody = (await preview(db, ids, "cat-couple")).body as any;
    expect(previewBody.members.map((row: any) => row.memberId)).toEqual(["m-ok"]);
    expect(previewBody.skipped.map((s: any) => [s.memberId, s.reason])).toEqual([
      ["m-archived", "archived"],
      ["m-gone", "not_found"],
      ["m-unassigned", "no_membership_type"],
      ["m-oldtype", "membership_type_archived"],
    ]);

    const tokens = await tokensFor(db, ids, "cat-couple");
    const saveBody = (await save(db, ids, "cat-couple", tokens)).body as any;
    expect(saveBody.results.map((r: any) => [r.memberId, r.outcome, r.skipReason ?? null])).toEqual([
      ["m-ok", "changed", null],
      ["m-archived", "skipped", "archived"],
      ["m-gone", "skipped", "not_found"],
      ["m-unassigned", "skipped", "no_membership_type"],
      ["m-oldtype", "skipped", "membership_type_archived"],
    ]);
    expect(saveBody.outcomeCounts).toMatchObject({ changed: 1, skipped: 4 });
  });

  it("isolates a stale token (previewed for another category) without aborting the rest", async () => {
    const { db, assignments } = makeDb({
      "m-good": { typeId: "full" },
      "m-stale": { typeId: "full" },
    });
    const goodTokens = await tokensFor(db, ["m-good"], "cat-couple");
    const otherTokens = await tokensFor(db, ["m-stale"], "cat-family");

    const body = (await save(db, ["m-good", "m-stale"], "cat-couple", {
      ...goodTokens,
      ...otherTokens,
    })).body as any;

    expect(body.results.map((r: any) => [r.memberId, r.outcome])).toEqual([
      ["m-good", "changed"],
      ["m-stale", "stale"],
    ]);
    expect(assignments.get("m-stale").subscriptionCategoryId).toBeNull();
  });

  it("isolates a member whose save throws: the rest still save, the admin sees a generic message", async () => {
    const { db, assignments } = makeDb({
      "m-throw": { typeId: "full", throwOnSave: true },
      "m-after": { typeId: "full" },
    });
    const tokens = await tokensFor(db, ["m-throw", "m-after"], "cat-couple");

    const body = (await save(db, ["m-throw", "m-after"], "cat-couple", tokens)).body as any;

    expect(body.results.map((r: any) => [r.memberId, r.outcome])).toEqual([
      ["m-throw", "error"],
      ["m-after", "changed"],
    ]);
    expect(body.results[0].error).toBe(BULK_SEASONAL_SAVE_THREW_MESSAGE);
    expect(body.results[0].error).not.toMatch(/deadlock/i);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "m-throw", err: expect.any(Error) }),
      expect.any(String),
    );
    expect(assignments.get("m-after").subscriptionCategoryId).toBe("cat-couple");
    expect(body.changedMemberIds).toEqual(["m-after"]);
    const summary = db.auditLog.create.mock.calls
      .map((call: any[]) => call[0].data)
      .find((data: any) => data.action === SUBSCRIPTION_CATEGORY_BULK_CHANGE_ACTION);
    expect(summary).toMatchObject({
      outcome: "success",
      metadata: { outcomeCounts: { changed: 1, error: 1 } },
    });
  });

  it("records the summary audit as a failure when nothing changed and a member failed", async () => {
    const { db } = makeDb({
      "m-stale": { typeId: "full" },
      "m-same": { typeId: "full", categoryId: "cat-couple" },
    });
    const sameTokens = await tokensFor(db, ["m-same"], "cat-couple");

    await save(db, ["m-stale", "m-same"], "cat-couple", sameTokens);

    const summary = db.auditLog.create.mock.calls
      .map((call: any[]) => call[0].data)
      .find((data: any) => data.action === SUBSCRIPTION_CATEGORY_BULK_CHANGE_ACTION);
    expect(summary).toMatchObject({
      outcome: "failure",
      metadata: { outcomeCounts: { changed: 0, unchanged: 1, stale: 1 } },
    });
  });

  it("records the summary audit as a success when nothing changed and nothing failed", async () => {
    const { db } = makeDb({ "m-same": { typeId: "full", categoryId: "cat-couple" } });
    const tokens = await tokensFor(db, ["m-same"], "cat-couple");

    await save(db, ["m-same"], "cat-couple", tokens);

    const summary = db.auditLog.create.mock.calls
      .map((call: any[]) => call[0].data)
      .find((data: any) => data.action === SUBSCRIPTION_CATEGORY_BULK_CHANGE_ACTION);
    expect(summary.outcome).toBe("success");
  });

  it("treats a member with no token as stale", async () => {
    const { db } = makeDb({ "m-1": { typeId: "full" } });

    const body = (await save(db, ["m-1"], "cat-couple", {})).body as any;

    expect(body.results[0]).toMatchObject({ outcome: "stale", status: 409 });
    expect(db.seasonalMembershipAssignment.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["an archived category", "cat-old", 409],
    ["the built-in Individual row", "cat-individual", 409],
    ["an unknown category", "cat-nope", 404],
  ])("refuses the whole request for %s", async (_label, categoryId, status) => {
    const { db } = makeDb({ "m-1": { typeId: "full" } });

    expect((await preview(db, ["m-1"], categoryId)).init?.status).toBe(status);
    expect((await save(db, ["m-1"], categoryId, { "m-1": "x" })).init?.status).toBe(status);
    expect(db.seasonalMembershipAssignment.upsert).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("reconciles Xero grouping only for members whose age tier the save repaired", async () => {
    const { db } = makeDb({
      "m-plain": { typeId: "full" },
      // N/A on a type that does not allow it: the save restores a person tier.
      "m-drift": { typeId: "full", ageTier: "NOT_APPLICABLE" },
    });
    const tokens = await tokensFor(db, ["m-plain", "m-drift"], "cat-couple");

    const body = (await save(db, ["m-plain", "m-drift"], "cat-couple", tokens)).body as any;

    expect(body.changedMemberIds).toEqual(["m-plain", "m-drift"]);
    expect(mockReconcileGroups).toHaveBeenCalledTimes(1);
    expect(mockReconcileGroups).toHaveBeenCalledWith(["m-drift"], {
      createdByMemberId: "admin-1",
      reason: "subscription_category_bulk",
    });
  });

  it("requires a reason", async () => {
    const { db } = makeDb({ "m-1": { typeId: "full" } });
    const result = await bulkSaveSubscriptionCategory({
      ids: ["m-1"],
      seasonYear: SEASON,
      subscriptionCategoryId: "cat-couple",
      adminMemberId: "admin-1",
      reason: "   ",
      previewTokens: {},
      db,
    });
    expect(result.init?.status).toBe(400);
  });
});
