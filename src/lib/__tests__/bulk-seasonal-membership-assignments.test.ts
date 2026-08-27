import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

// #2107: the bulk wrapper must SUPPRESS the per-member synchronous Xero sync and
// instead run ONE deferred batched reconcile of the changed members. Mock both so
// the suppression + single reconcile can be asserted.
const mockTriggerGroupSync = vi.fn();
const mockReconcileGroups = vi
  .fn()
  .mockResolvedValue({ processed: 0, failed: 0, haltedByDailyLimit: false });
vi.mock("@/lib/xero-contact-groups", () => ({
  triggerMemberXeroContactGroupSync: (...args: unknown[]) =>
    mockTriggerGroupSync(...args),
  reconcileMembersXeroContactGroups: (...args: unknown[]) =>
    mockReconcileGroups(...args),
}));

const mockSweep = vi.fn().mockResolvedValue([]);
const mockAcquireFuturePartnerSharedAllocationLocks = vi
  .fn()
  .mockResolvedValue(undefined);
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  acquireFuturePartnerSharedAllocationLocks: (...args: unknown[]) =>
    mockAcquireFuturePartnerSharedAllocationLocks(...args),
  sweepFuturePartnerSharedAllocationsWithLocksHeld: (...args: unknown[]) =>
    mockSweep(...args),
  describePartnerSharedSweepReason: vi.fn(() => "age tier changed"),
  partnerShareSweepCounterpartNames: vi.fn(() => "Partner"),
  partnerShareSweepNights: vi.fn(() => 0),
}));
vi.mock("@/lib/email", () => ({
  sendAdminPartnerShareSweptAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn(() => new Date("2026-04-01")),
}));

import {
  bulkSaveSeasonalMembershipAssignments,
  getSeasonalMembershipChangePreview,
  SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION,
  SEASONAL_MEMBERSHIP_BULK_ASSIGNMENT_ACTION,
} from "@/lib/seasonal-membership-assignments";

const personTiers = [
  { ageTier: "INFANT" },
  { ageTier: "CHILD" },
  { ageTier: "YOUTH" },
  { ageTier: "ADULT" },
];

const TYPES: Record<string, any> = {
  "type-full": {
    id: "type-full",
    key: "FULL",
    name: "Full",
    description: null,
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 0,
    allowedAgeTiers: personTiers,
  },
  "type-associate": {
    id: "type-associate",
    key: "ASSOCIATE",
    name: "Associate",
    description: null,
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "NON_MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    sortOrder: 1,
    allowedAgeTiers: personTiers,
  },
  "type-exempt": {
    id: "type-exempt",
    key: "EXEMPT",
    name: "Age Exempt",
    description: null,
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "NON_MEMBER_RATE",
    subscriptionBehavior: "NOT_REQUIRED",
    sortOrder: 2,
    allowedAgeTiers: [{ ageTier: "NOT_APPLICABLE" }],
  },
};

interface MemberConfig {
  prevTypeId: string;
  ageTier?: string;
  linkedGuests?: number;
  /** Force the per-member save to THROW (DB deadlock etc.) to exercise the
   *  wrapper's loop exception boundary. */
  throwOnSave?: boolean;
}

function linkedGuest(memberId: string) {
  return {
    id: `bg-${memberId}`,
    bookingId: `booking-${memberId}`,
    stayStart: new Date("2099-08-01T00:00:00.000Z"),
    stayEnd: new Date("2099-08-03T00:00:00.000Z"),
    booking: {
      id: `booking-${memberId}`,
      memberId: "someone-else",
      checkIn: new Date("2099-08-01T00:00:00.000Z"),
      checkOut: new Date("2099-08-03T00:00:00.000Z"),
    },
  };
}

function makeBulkDb(members: Record<string, MemberConfig>) {
  function prevAssignment(memberId: string, seasonYear: number) {
    const cfg = members[memberId];
    if (!cfg) return null;
    return {
      id: `assignment-${memberId}`,
      memberId,
      seasonYear,
      membershipTypeId: cfg.prevTypeId,
      applyFrom: null,
      assignedByMemberId: "admin-old",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      membershipType: TYPES[cfg.prevTypeId],
    };
  }

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
        // #2821: the tier write now re-resolves email inheritance in the same
        // transaction, and that read uses the same `where.id.in` shape as this
        // suite's own. The select tells them apart; `[]` is honest here because
        // these fixtures have no dependants to re-point.
        if (select?.inheritEmailChoiceId) return [];
        const idList: string[] = where.id.in;
        return idList
          .filter((id) => members[id])
          .map((id) => ({
            id,
            firstName: "Member",
            lastName: id,
            email: `${id}@test.example`,
          }));
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    membershipType: {
      findUnique: vi.fn(async ({ where }: any) => TYPES[where.id] ?? null),
    },
    seasonalMembershipAssignment: {
      findUnique: vi.fn(async ({ where }: any) =>
        prevAssignment(where.memberId_seasonYear.memberId, where.memberId_seasonYear.seasonYear),
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: any) =>
        prevAssignment(where.memberId_seasonYear.memberId, where.memberId_seasonYear.seasonYear),
      ),
      upsert: vi.fn(async ({ where, update }: any) => {
        const memberId = where.memberId_seasonYear.memberId;
        if (members[memberId]?.throwOnSave) {
          throw new Error(`DB deadlock saving ${memberId}`);
        }
        return {
        id: `assignment-${where.memberId_seasonYear.memberId}`,
        memberId: where.memberId_seasonYear.memberId,
        seasonYear: where.memberId_seasonYear.seasonYear,
        membershipTypeId: update.membershipTypeId,
        applyFrom: null,
        assignedByMemberId: update.assignedByMemberId,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-02T00:00:00.000Z"),
        membershipType: TYPES[update.membershipTypeId],
        };
      }),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    bookingGuest: {
      findMany: vi.fn(async ({ where }: any) => {
        const cfg = members[where.memberId];
        return cfg?.linkedGuests
          ? Array.from({ length: cfg.linkedGuests }, () => linkedGuest(where.memberId))
          : [];
      }),
    },
    memberSubscription: {
      findMany: vi.fn().mockResolvedValue([]),
      // #2149 assignment reconcile: no stale seed row by default (no-op).
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(async (cb: any) => cb(db)),
  };
  return db;
}

async function tokenFor(
  db: any,
  memberId: string,
  seasonYear: number,
  membershipTypeId: string,
) {
  const result = await getSeasonalMembershipChangePreview({
    memberId,
    seasonYear,
    membershipTypeId,
    // #3123 - both are REQUIRED now, so the preview performs no
    // `ClubTimeSettings` read of its own on any path. The frozen clock is
    // 1 July 2026, which is season 2026 on the default 31-March year-end.
    now: new Date("2026-07-01T00:00:00.000Z"),
    clubCurrentSeasonYear: 2026,
    db,
  });
  return (result.body as { preview: { previewToken: string } }).preview.previewToken;
}

describe("bulkSaveSeasonalMembershipAssignments", () => {
// The season the club is in at the frozen instant, WRITTEN OUT rather than derived
// (#2870, correctness review). Computing it by calling the same function the code
// under test calls, with the same arguments, holds for any implementation at all —
// including one that returns a constant. `club-season-year.test.ts` is where the
// derivation itself is proved; here the literal is the oracle.
  // The frozen clock is 1 July 2026: season 2026 on the default 31-March year-end.
  const currentSeason = 2026;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReconcileGroups.mockResolvedValue({
      processed: 0,
      failed: 0,
      haltedByDailyLimit: false,
    });
    process.env.AUTH_SECRET = "bulk-seasonal-test-secret";
  });

  it("changes each member, suppresses per-member Xero, and runs ONE batched reconcile of the changed members", async () => {
    const db = makeBulkDb({
      "m-1": { prevTypeId: "type-full" },
      "m-2": { prevTypeId: "type-full" },
    });
    const tokens = {
      "m-1": await tokenFor(db, "m-1", currentSeason, "type-associate"),
      "m-2": await tokenFor(db, "m-2", currentSeason, "type-associate"),
    };
    db.auditLog.create.mockClear();

    const result = await bulkSaveSeasonalMembershipAssignments({
      ids: ["m-1", "m-2"],
      seasonYear: currentSeason,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "season start bulk change",
      previewTokens: tokens,
      db: db as never,
    });

    const body = result.body as any;
    expect(body.outcomeCounts).toMatchObject({ changed: 2, unchanged: 0 });
    expect(body.results.map((r: any) => r.outcome)).toEqual(["changed", "changed"]);
    // Every per-member result carries a display name (never a raw id).
    expect(body.results.map((r: any) => r.name)).toEqual([
      "Member m-1",
      "Member m-2",
    ]);
    // Reconcile telemetry is surfaced with the {attempted, succeeded, halted} shape.
    expect(body.xeroReconcile).toEqual({
      attempted: 2,
      succeeded: 0,
      haltedByDailyLimit: false,
    });

    // Per-member sync suppressed; one batched reconcile with exactly the changed ids.
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
    expect(mockReconcileGroups).toHaveBeenCalledTimes(1);
    expect(mockReconcileGroups).toHaveBeenCalledWith(["m-1", "m-2"], {
      createdByMemberId: "admin-1",
      reason: "seasonal_membership_assignment_bulk",
    });

    // Two per-member critical audits + one important summary audit.
    const actions = db.auditLog.create.mock.calls.map(
      (call: any[]) => call[0].data.action,
    );
    expect(
      actions.filter(
        (a: string) => a === SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION,
      ),
    ).toHaveLength(2);
    expect(
      actions.filter((a: string) => a === SEASONAL_MEMBERSHIP_BULK_ASSIGNMENT_ACTION),
    ).toHaveLength(1);
  });

  it("isolates a stale token as its own outcome without aborting the rest", async () => {
    const db = makeBulkDb({
      "m-good": { prevTypeId: "type-full" },
      "m-stale": { prevTypeId: "type-full" },
    });
    const tokens = {
      "m-good": await tokenFor(db, "m-good", currentSeason, "type-associate"),
      "m-stale": "not-the-real-token",
    };
    db.auditLog.create.mockClear();

    const result = await bulkSaveSeasonalMembershipAssignments({
      ids: ["m-good", "m-stale"],
      seasonYear: currentSeason,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "bulk with one stale",
      previewTokens: tokens,
      db: db as never,
    });

    const body = result.body as any;
    expect(body.outcomeCounts).toMatchObject({ changed: 1, stale: 1 });
    const staleEntry = body.results.find((r: any) => r.memberId === "m-stale");
    expect(staleEntry.outcome).toBe("stale");
    // Only the changed member is reconciled.
    expect(mockReconcileGroups).toHaveBeenCalledWith(["m-good"], expect.anything());
  });

  it("treats a missing preview token as stale and does not save that member", async () => {
    const db = makeBulkDb({ "m-1": { prevTypeId: "type-full" } });
    const result = await bulkSaveSeasonalMembershipAssignments({
      ids: ["m-1"],
      seasonYear: currentSeason,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "missing token",
      previewTokens: {},
      db: db as never,
    });

    const body = result.body as any;
    expect(body.outcomeCounts).toMatchObject({ stale: 1, changed: 0 });
    expect(db.seasonalMembershipAssignment.upsert).not.toHaveBeenCalled();
    expect(mockReconcileGroups).not.toHaveBeenCalled();
  });

  it("records an unchanged (no-op) member without a per-member audit and skips the reconcile", async () => {
    const db = makeBulkDb({ "m-noop": { prevTypeId: "type-associate" } });
    const tokens = {
      "m-noop": await tokenFor(db, "m-noop", currentSeason, "type-associate"),
    };
    db.auditLog.create.mockClear();

    const result = await bulkSaveSeasonalMembershipAssignments({
      ids: ["m-noop"],
      seasonYear: currentSeason,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "already on type",
      previewTokens: tokens,
      db: db as never,
    });

    const body = result.body as any;
    expect(body.outcomeCounts).toMatchObject({ unchanged: 1, changed: 0 });
    // Only the summary audit — no per-member critical row for a no-op.
    const actions = db.auditLog.create.mock.calls.map(
      (call: any[]) => call[0].data.action,
    );
    expect(actions).toEqual([SEASONAL_MEMBERSHIP_BULK_ASSIGNMENT_ACTION]);
    expect(mockReconcileGroups).not.toHaveBeenCalled();
  });

  it("maps an N/A-flip blocked by linked-guest bookings to its own outcome", async () => {
    const db = makeBulkDb({
      "m-blocked": { prevTypeId: "type-full", ageTier: "ADULT", linkedGuests: 2 },
    });
    const tokens = {
      "m-blocked": await tokenFor(db, "m-blocked", currentSeason, "type-exempt"),
    };
    db.auditLog.create.mockClear();

    const result = await bulkSaveSeasonalMembershipAssignments({
      ids: ["m-blocked"],
      seasonYear: currentSeason,
      membershipTypeId: "type-exempt",
      adminMemberId: "admin-1",
      reason: "flip to exempt",
      previewTokens: tokens,
      db: db as never,
    });

    const body = result.body as any;
    expect(body.outcomeCounts).toMatchObject({ blocked_linked_guests: 1 });
    const entry = body.results[0];
    expect(entry.outcome).toBe("blocked_linked_guests");
    expect(entry.linkedGuestBookings.count).toBe(2);
    expect(db.seasonalMembershipAssignment.upsert).not.toHaveBeenCalled();
    expect(mockReconcileGroups).not.toHaveBeenCalled();
  });

  it("takes the partner-share lock prefix before the member lock, tier write, and held sweep", async () => {
    const db = makeBulkDb({
      "m-flip": { prevTypeId: "type-full", ageTier: "ADULT" },
    });
    const tokens = {
      "m-flip": await tokenFor(db, "m-flip", currentSeason, "type-exempt"),
    };

    const result = await bulkSaveSeasonalMembershipAssignments({
      ids: ["m-flip"],
      seasonYear: currentSeason,
      membershipTypeId: "type-exempt",
      adminMemberId: "admin-1",
      reason: "flip to exempt",
      previewTokens: tokens,
      db: db as never,
    });

    expect((result.body as any).outcomeCounts).toMatchObject({ changed: 1 });
    expect(mockAcquireFuturePartnerSharedAllocationLocks).toHaveBeenCalledWith(
      db,
      ["m-flip"],
      // #3123: the club's day, resolved before the transaction opened.
      expect.any(Date),
    );
    expect(mockSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: "m-flip",
        reason: "member_age_tier_changed",
        db,
        today: expect.any(Date),
      }),
    );
    const acquireOrder =
      mockAcquireFuturePartnerSharedAllocationLocks.mock.invocationCallOrder[0];
    const memberLockOrder = db.$executeRaw.mock.invocationCallOrder[0];
    const memberWriteOrder = db.member.update.mock.invocationCallOrder[0];
    const heldSweepOrder = mockSweep.mock.invocationCallOrder[0];
    expect(acquireOrder).toBeLessThan(memberLockOrder);
    expect(memberLockOrder).toBeLessThan(memberWriteOrder);
    expect(memberWriteOrder).toBeLessThan(heldSweepOrder);
  });

  it("does not reconcile Xero when the target season is not the current season", async () => {
    const nonCurrent = currentSeason + 5;
    const db = makeBulkDb({ "m-1": { prevTypeId: "type-full" } });
    const tokens = {
      "m-1": await tokenFor(db, "m-1", nonCurrent, "type-associate"),
    };

    const result = await bulkSaveSeasonalMembershipAssignments({
      ids: ["m-1"],
      seasonYear: nonCurrent,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "future season",
      previewTokens: tokens,
      db: db as never,
    });

    expect((result.body as any).outcomeCounts.changed).toBe(1);
    expect(mockReconcileGroups).not.toHaveBeenCalled();
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
  });

  it("isolates a THROWN save (deadlock) as an error and keeps processing the rest", async () => {
    // m-throw's upsert rejects mid-batch; m-after must still be saved, the run
    // must report m-throw as `error`, and the summary audit must still be written.
    const db = makeBulkDb({
      "m-throw": { prevTypeId: "type-full", throwOnSave: true },
      "m-after": { prevTypeId: "type-full" },
    });
    const tokens = {
      "m-throw": await tokenFor(db, "m-throw", currentSeason, "type-associate"),
      "m-after": await tokenFor(db, "m-after", currentSeason, "type-associate"),
    };
    db.auditLog.create.mockClear();

    const result = await bulkSaveSeasonalMembershipAssignments({
      ids: ["m-throw", "m-after"],
      seasonYear: currentSeason,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "one member deadlocks",
      previewTokens: tokens,
      db: db as never,
    });

    const body = result.body as any;
    // The thrower is an `error`; the later member still went through as `changed`.
    expect(body.outcomeCounts).toMatchObject({ error: 1, changed: 1 });
    const throwEntry = body.results.find((r: any) => r.memberId === "m-throw");
    expect(throwEntry.outcome).toBe("error");
    expect(throwEntry.name).toBe("Member m-throw");
    expect(throwEntry.error).toMatch(/deadlock/i);
    const afterEntry = body.results.find((r: any) => r.memberId === "m-after");
    expect(afterEntry.outcome).toBe("changed");

    // The summary audit is written even though a member threw.
    const actions = db.auditLog.create.mock.calls.map(
      (call: any[]) => call[0].data.action,
    );
    expect(
      actions.filter((a: string) => a === SEASONAL_MEMBERSHIP_BULK_ASSIGNMENT_ACTION),
    ).toHaveLength(1);
    // Only the surviving member is reconciled.
    expect(mockReconcileGroups).toHaveBeenCalledWith(["m-after"], expect.anything());
  });

  it("rejects an empty reason before touching the database", async () => {
    const db = makeBulkDb({ "m-1": { prevTypeId: "type-full" } });
    const result = await bulkSaveSeasonalMembershipAssignments({
      ids: ["m-1"],
      seasonYear: currentSeason,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "   ",
      previewTokens: { "m-1": "token" },
      db: db as never,
    });
    expect(result.init?.status).toBe(400);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});
