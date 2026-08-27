import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

// Best-effort Xero contact-group trigger (E8, #1934): mocked so we can assert
// it fires only for current-season changes and actually-copied candidates.
const mockTriggerGroupSync = vi.fn();
vi.mock("@/lib/xero-contact-groups", () => ({
  triggerMemberXeroContactGroupSync: (...args: unknown[]) =>
    mockTriggerGroupSync(...args),
}));

// #2106: the age-tier reconciliation depends on these; mock them so the tier
// logic can be asserted without a live sweep/DB.
const mockSweep = vi.fn().mockResolvedValue([]);
const mockAcquireFuturePartnerSharedAllocationLocks = vi
  .fn()
  .mockResolvedValue(undefined);
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  sweepFuturePartnerSharedAllocationsWithLocksHeld: (...args: unknown[]) =>
    mockSweep(...args),
  acquireFuturePartnerSharedAllocationLocks: (...args: unknown[]) =>
    mockAcquireFuturePartnerSharedAllocationLocks(...args),
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
const mockComputeAgeTier = vi.fn().mockResolvedValue("ADULT");
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: (...args: unknown[]) => mockComputeAgeTier(...args),
  getSeasonStartDate: vi.fn(() => new Date("2026-04-01")),
}));

/**
 * The season year the code under test computes for "now", WRITTEN OUT.
 *
 * It used to be derived by calling the same function the production paths call,
 * which is an expectation that holds for any implementation — including one that
 * returns a constant (#2870, correctness review). The frozen clock is
 * 2026-07-01T00:00:00Z; in the club's zone that is 1 July 2026, season 2026 on the
 * default 31-March year-end. `club-season-year.test.ts` proves the derivation;
 * these are fixtures.
 */
const CLUB_CURRENT_SEASON_YEAR = 2026;

import {
  getSeasonalMembershipChangePreview,
  rollForwardSeasonalMembershipAssignments,
  saveSeasonalMembershipAssignment,
  SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION,
  SEASONAL_MEMBERSHIP_ASSIGNMENTS_ROLLED_FORWARD_ACTION,
  SEASONAL_MEMBERSHIP_ROLL_FORWARD_TIERS_RECONCILED_ACTION,
} from "@/lib/seasonal-membership-assignments";

const fullType = {
  id: "type-full",
  key: "FULL",
  name: "Full",
  description: "Full membership",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
  sortOrder: 0,
};

const associateType = {
  id: "type-associate",
  key: "ASSOCIATE",
  name: "Associate",
  description: "Associate membership",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "NON_MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
  sortOrder: 1,
};

const inactiveType = {
  ...associateType,
  id: "type-inactive",
  key: "INACTIVE",
  name: "Inactive",
  isActive: false,
};

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    checkIn: new Date("2099-08-01T00:00:00.000Z"),
    checkOut: new Date("2099-08-03T00:00:00.000Z"),
    status: "PAID",
    finalPriceCents: 12345,
    waitlistPosition: null,
    waitlistOfferedAt: null,
    waitlistOfferExpiresAt: null,
    _count: { guests: 2 },
    ...overrides,
  };
}

function previousAssignment() {
  return {
    id: "assignment-1",
    memberId: "member-1",
    seasonYear: 2026,
    membershipTypeId: "type-full",
    applyFrom: new Date("2026-05-15T00:00:00.000Z"),
    assignedByMemberId: "admin-old",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    membershipType: fullType,
  };
}

function makePreviewDb() {
  const confirmedBookings = [
    booking({ id: "confirmed-1", status: "PAID" }),
    booking({ id: "confirmed-2", status: "CONFIRMED" }),
  ];
  const draftBookings = [booking({ id: "draft-1", status: "DRAFT" })];
  const waitlistBookings = [
    booking({
      id: "waitlist-1",
      status: "WAITLISTED",
      waitlistPosition: 1,
    }),
  ];
  const subscriptions = [
    {
      id: "subscription-current",
      seasonYear: 2026,
      status: "PAID",
      xeroInvoiceId: "xero-invoice-id-not-returned",
      xeroInvoiceNumber: "INV-2026",
      paidAt: new Date("2026-05-01T00:00:00.000Z"),
    },
    {
      id: "subscription-old",
      seasonYear: 2025,
      status: "UNPAID",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      paidAt: null,
    },
  ];

  // Person tiers only → DISALLOWED exemption unless a test overrides it.
  const personAllowedAgeTiers = [
    { ageTier: "INFANT" },
    { ageTier: "CHILD" },
    { ageTier: "YOUTH" },
    { ageTier: "ADULT" },
  ];

  const db: any = {
    member: {
      findUnique: vi.fn().mockResolvedValue({
        id: "member-1",
        ageTier: "ADULT",
        dateOfBirth: null,
        role: "USER",
        canLogin: true,
        accessRoles: [{ role: "USER" }],
        firstName: "Member",
        lastName: "One",
      }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    membershipType: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.id === "type-associate")
          return { ...associateType, allowedAgeTiers: personAllowedAgeTiers };
        if (where.id === "type-inactive")
          return { ...inactiveType, allowedAgeTiers: personAllowedAgeTiers };
        // Age-exempt (FORCED) type used by the #2106 tests.
        if (where.id === "type-exempt")
          return {
            ...associateType,
            id: "type-exempt",
            key: "EXEMPT",
            name: "Age Exempt",
            subscriptionBehavior: "NOT_REQUIRED",
            allowedAgeTiers: [{ ageTier: "NOT_APPLICABLE" }],
          };
        return { ...fullType, allowedAgeTiers: personAllowedAgeTiers };
      }),
    },
    seasonalMembershipAssignment: {
      findUnique: vi.fn().mockResolvedValue(previousAssignment()),
      findUniqueOrThrow: vi.fn().mockResolvedValue(previousAssignment()),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({
        ...previousAssignment(),
        id: "assignment-saved",
        membershipTypeId: "type-associate",
        assignedByMemberId: "admin-1",
        updatedAt: new Date("2026-06-02T00:00:00.000Z"),
        membershipType: associateType,
      }),
      createMany: vi.fn(),
    },
    booking: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.status === "DRAFT") return draftBookings;
        if (where.status?.in?.includes("WAITLISTED")) return waitlistBookings;
        return confirmedBookings;
      }),
    },
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    memberSubscription: {
      findMany: vi.fn().mockResolvedValue(subscriptions),
      // #2149 assignment reconcile: no stale seed row by default, so it is a
      // no-op that leaves the existing save assertions unchanged.
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(async (callback: any) => callback(db)),
  };

  return db;
}

function makeRollForwardDb() {
  const sourceAssignments = [
    {
      id: "assignment-copy",
      memberId: "member-copy",
      seasonYear: 2026,
      membershipTypeId: "type-full",
      member: {
        id: "member-copy",
        firstName: "Casey",
        lastName: "Copy",
        email: "copy@example.test",
        active: true,
        archivedAt: null,
        cancelledAt: null,
      },
      membershipType: fullType,
    },
    {
      id: "assignment-inactive",
      memberId: "member-inactive",
      seasonYear: 2026,
      membershipTypeId: "type-inactive",
      member: {
        id: "member-inactive",
        firstName: "Ivy",
        lastName: "Inactive",
        email: "inactive@example.test",
        active: true,
        archivedAt: null,
        cancelledAt: null,
      },
      membershipType: inactiveType,
    },
    {
      id: "assignment-existing",
      memberId: "member-existing",
      seasonYear: 2026,
      membershipTypeId: "type-full",
      member: {
        id: "member-existing",
        firstName: "Tara",
        lastName: "Target",
        email: "target@example.test",
        active: true,
        archivedAt: null,
        cancelledAt: null,
      },
      membershipType: fullType,
    },
  ];

  const db = {
    seasonalMembershipAssignment: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.seasonYear === 2026) return sourceAssignments;
        return [{ memberId: "member-existing" }];
      }),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([
        sourceAssignments[0].member,
        sourceAssignments[1].member,
        sourceAssignments[2].member,
        {
          id: "member-missing",
          firstName: "Mia",
          lastName: "Missing",
          email: "missing@example.test",
          active: true,
          archivedAt: null,
          cancelledAt: null,
        },
      ]),
      update: vi.fn().mockResolvedValue({}),
    },
    memberSubscription: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(async (callback: any) => callback(db)),
  };

  return db;
}

describe("seasonal membership assignment preview and save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = "seasonal-membership-test-secret";
  });

  it("previews affected bookings, waitlist records, and subscription summary without provider IDs", async () => {
    const db = makePreviewDb();

    const result = await getSeasonalMembershipChangePreview({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      applyFrom: "2026-07-15",
      now: new Date("2026-07-01T00:00:00.000Z"),
      // #3123 - required now, so the preview makes NO ClubTimeSettings read of
      // its own. The frozen clock is 1 July 2026 = season 2026.
      clubCurrentSeasonYear: 2026,
      db: db as never,
    });

    expect(result.init?.status).toBeUndefined();
    const preview = (result.body as { preview: Record<string, unknown> })
      .preview;
    expect(preview).toMatchObject({
      memberId: "member-1",
      seasonYear: 2026,
      applyFrom: "2026-07-15",
      resultingBookingBehavior: "NON_MEMBER_RATE",
      resultingSubscriptionBehavior: "REQUIRED",
      bookingBehaviorChanged: true,
      subscriptionBehaviorChanged: false,
      affectedCounts: {
        futureConfirmedBookings: 2,
        draftBookings: 1,
        waitlistRecords: 1,
      },
      currentSeasonSubscription: {
        status: "PAID",
        hasInvoice: true,
        xeroInvoiceNumber: "INV-2026",
      },
    });
    expect(preview.previewToken).toEqual(expect.any(String));
    expect(JSON.stringify(preview)).not.toContain("xero-invoice-id-not-returned");
  });

  it("fails closed for preview tokens in production without an auth secret", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAuthSecret = process.env.AUTH_SECRET;
    const originalNextAuthSecret = process.env.NEXTAUTH_SECRET;
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const db = makePreviewDb();

    try {
      await expect(
        getSeasonalMembershipChangePreview({
          memberId: "member-1",
          seasonYear: 2026,
          membershipTypeId: "type-associate",
          now: new Date("2026-07-01T00:00:00.000Z"),
          clubCurrentSeasonYear: 2026,
          db: db as never,
        }),
      ).rejects.toThrow(
        "AUTH_SECRET or NEXTAUTH_SECRET is required for seasonal membership preview tokens",
      );
    } finally {
      if (originalNodeEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).NODE_ENV;
      } else {
        (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
      }
      if (originalAuthSecret === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = originalAuthSecret;
      }
      if (originalNextAuthSecret === undefined) {
        delete process.env.NEXTAUTH_SECRET;
      } else {
        process.env.NEXTAUTH_SECRET = originalNextAuthSecret;
      }
    }
  });

  it("requires an admin reason before saving", async () => {
    const db = makePreviewDb();

    const result = await saveSeasonalMembershipAssignment({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "  ",
      previewToken: "unused",
      db: db as never,
    });

    expect(result.init?.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rejects stale preview tokens", async () => {
    const db = makePreviewDb();

    const result = await saveSeasonalMembershipAssignment({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "member changed category",
      previewToken: "not-the-preview-token",
      db: db as never,
    });

    expect(result.init?.status).toBe(409);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("saves with a matching preview token and audits old/new policy impact", async () => {
    const db = makePreviewDb();
    const previewResult = await getSeasonalMembershipChangePreview({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      applyFrom: "2026-07-15",
      now: new Date("2026-07-01T00:00:00.000Z"),
      // #3123 - required now, so the preview makes NO ClubTimeSettings read of
      // its own. The frozen clock is 1 July 2026 = season 2026.
      clubCurrentSeasonYear: 2026,
      db: db as never,
    });
    const preview = (previewResult.body as { preview: { previewToken: string } })
      .preview;

    const result = await saveSeasonalMembershipAssignment({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      applyFrom: "2026-07-15",
      adminMemberId: "admin-1",
      reason: "member changed category",
      previewToken: preview.previewToken,
      request: { id: "req-1", ipAddress: "127.0.0.1", userAgent: "vitest" },
      db: db as never,
    });

    expect(result.init?.status).toBeUndefined();
    expect(db.seasonalMembershipAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberId_seasonYear: { memberId: "member-1", seasonYear: 2026 },
        },
        update: {
          membershipTypeId: "type-associate",
          applyFrom: new Date("2026-07-15T00:00:00.000Z"),
          assignedByMemberId: "admin-1",
          source: "ADMIN",
        },
      }),
    );
    // seasonYear 2026 is not necessarily the CURRENT season when this test
    // runs; the dedicated trigger tests below pin current vs future.
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION,
          actorMemberId: "admin-1",
          subjectMemberId: "member-1",
          category: "admin",
          severity: "critical",
          metadata: expect.objectContaining({
            seasonYear: 2026,
            adminReason: "member changed category",
            previousApplyFrom: "2026-05-15",
            newApplyFrom: "2026-07-15",
            affectedCounts: {
              futureConfirmedBookings: 2,
              draftBookings: 1,
              waitlistRecords: 1,
            },
            bookingBehaviorChanged: true,
            subscriptionBehaviorChanged: false,
            resultingBookingBehavior: "NON_MEMBER_RATE",
            resultingSubscriptionBehavior: "REQUIRED",
          }),
        }),
      }),
    );
  });

  it("#2106 forces N/A, sweeps ADULT shares and audits old/new tier on a FORCED flip", async () => {
    const db = makePreviewDb();
    const previewResult = await getSeasonalMembershipChangePreview({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-exempt",
      now: new Date("2026-07-01T00:00:00.000Z"),
      // #3123 - required now, so the preview makes NO ClubTimeSettings read of
      // its own. The frozen clock is 1 July 2026 = season 2026.
      clubCurrentSeasonYear: 2026,
      db: db as never,
    });
    const preview = (
      previewResult.body as {
        preview: { previewToken: string; resultingAgeTier: string; ageTierChanged: boolean };
      }
    ).preview;
    expect(preview.resultingAgeTier).toBe("NOT_APPLICABLE");
    expect(preview.ageTierChanged).toBe(true);

    const result = await saveSeasonalMembershipAssignment({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-exempt",
      adminMemberId: "admin-1",
      reason: "moved to age-exempt type",
      previewToken: preview.previewToken,
      db: db as never,
    });

    expect(result.init?.status).toBeUndefined();
    expect(db.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "member-1" },
        data: { ageTier: "NOT_APPLICABLE" },
      }),
    );
    expect(mockSweep).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "member-1", reason: "member_age_tier_changed" }),
    );
    expect(mockAcquireFuturePartnerSharedAllocationLocks).toHaveBeenCalledWith(
      db,
      ["member-1"],
      // #3123: the club's day, resolved before the transaction opened.
      expect.any(Date),
    );
    const acquireOrder =
      mockAcquireFuturePartnerSharedAllocationLocks.mock.invocationCallOrder[0];
    const memberLockOrder = db.$executeRaw.mock.invocationCallOrder[0];
    const memberWriteOrder = db.member.update.mock.invocationCallOrder[0];
    const heldSweepOrder = mockSweep.mock.invocationCallOrder[0];
    expect(acquireOrder).toBeLessThan(memberLockOrder);
    expect(memberLockOrder).toBeLessThan(memberWriteOrder);
    expect(memberWriteOrder).toBeLessThan(heldSweepOrder);
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            previousAgeTier: "ADULT",
            newAgeTier: "NOT_APPLICABLE",
            ageTierChanged: true,
          }),
        }),
      }),
    );
  });

  it("#2106 repairs a drifted age tier on an otherwise-unchanged save without rewriting the assignment", async () => {
    const db = makePreviewDb();
    // Member wrongly holds N/A while assigned to a person-only (DISALLOWED) type.
    db.member.findUnique.mockResolvedValue({
      id: "member-1",
      ageTier: "NOT_APPLICABLE",
      dateOfBirth: null,
      role: "USER",
      canLogin: true,
      accessRoles: [{ role: "USER" }],
      firstName: "Member",
      lastName: "One",
    });

    const previewResult = await getSeasonalMembershipChangePreview({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-full",
      applyFrom: "2026-05-15",
      now: new Date("2026-07-01T00:00:00.000Z"),
      // #3123 - required now, so the preview makes NO ClubTimeSettings read of
      // its own. The frozen clock is 1 July 2026 = season 2026.
      clubCurrentSeasonYear: 2026,
      db: db as never,
    });
    const preview = (
      previewResult.body as { preview: { previewToken: string; resultingAgeTier: string } }
    ).preview;
    expect(preview.resultingAgeTier).toBe("ADULT");

    const result = await saveSeasonalMembershipAssignment({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-full",
      applyFrom: "2026-05-15",
      adminMemberId: "admin-1",
      reason: "repair drifted tier",
      previewToken: preview.previewToken,
      db: db as never,
    });

    expect((result.body as { changed: boolean }).changed).toBe(true);
    expect(db.seasonalMembershipAssignment.upsert).not.toHaveBeenCalled();
    expect(db.seasonalMembershipAssignment.findUniqueOrThrow).toHaveBeenCalled();
    expect(db.member.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ageTier: "ADULT" } }),
    );
  });

  it("#2106 blocks a flip to N/A while the member is a future linked guest on others' bookings", async () => {
    const db = makePreviewDb();
    db.bookingGuest.findMany.mockResolvedValue([
      {
        id: "guest-1",
        bookingId: "booking-x",
        stayStart: new Date("2099-08-01T00:00:00.000Z"),
        stayEnd: new Date("2099-08-03T00:00:00.000Z"),
        booking: {
          id: "booking-x",
          memberId: "someone-else",
          checkIn: new Date("2099-08-01T00:00:00.000Z"),
          checkOut: new Date("2099-08-03T00:00:00.000Z"),
        },
      },
    ]);

    const previewResult = await getSeasonalMembershipChangePreview({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-exempt",
      now: new Date("2026-07-01T00:00:00.000Z"),
      // #3123 - required now, so the preview makes NO ClubTimeSettings read of
      // its own. The frozen clock is 1 July 2026 = season 2026.
      clubCurrentSeasonYear: 2026,
      db: db as never,
    });
    const preview = (
      previewResult.body as {
        preview: { previewToken: string; linkedGuestBookings: { count: number } };
      }
    ).preview;
    expect(preview.linkedGuestBookings.count).toBe(1);

    const result = await saveSeasonalMembershipAssignment({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-exempt",
      adminMemberId: "admin-1",
      reason: "moved to age-exempt type",
      previewToken: preview.previewToken,
      db: db as never,
    });

    expect(result.init?.status).toBe(409);
    expect((result.body as { error: string }).error).toMatch(/linked guest/i);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("#2106 invalidates a preview token when the resulting age tier drifts", async () => {
    const db = makePreviewDb();
    const previewResult = await getSeasonalMembershipChangePreview({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      now: new Date("2026-07-01T00:00:00.000Z"),
      // #3123 - required now, so the preview makes NO ClubTimeSettings read of
      // its own. The frozen clock is 1 July 2026 = season 2026.
      clubCurrentSeasonYear: 2026,
      db: db as never,
    });
    const preview = (previewResult.body as { preview: { previewToken: string } }).preview;

    // The member becomes an organisation after the preview: the save recomputes
    // resultingAgeTier = N/A, so the ADULT-bound token no longer verifies.
    db.member.findUnique.mockResolvedValue({
      id: "member-1",
      ageTier: "ADULT",
      dateOfBirth: null,
      role: "SCHOOL",
      canLogin: true,
      accessRoles: [{ role: "ORG" }],
      firstName: "Member",
      lastName: "One",
    });

    const result = await saveSeasonalMembershipAssignment({
      memberId: "member-1",
      seasonYear: 2026,
      membershipTypeId: "type-associate",
      adminMemberId: "admin-1",
      reason: "member changed category",
      previewToken: preview.previewToken,
      db: db as never,
    });

    expect(result.init?.status).toBe(409);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("fires the Xero contact-group trigger only for current-season saves", async () => {
    const currentSeason = CLUB_CURRENT_SEASON_YEAR;

    async function saveForSeason(seasonYear: number) {
      const db = makePreviewDb();
      const previewResult = await getSeasonalMembershipChangePreview({
        memberId: "member-1",
        seasonYear,
        membershipTypeId: "type-associate",
        now: new Date("2026-07-01T00:00:00.000Z"),
        clubCurrentSeasonYear: 2026,
        db: db as never,
      });
      const preview = (
        previewResult.body as { preview: { previewToken: string } }
      ).preview;
      return saveSeasonalMembershipAssignment({
        memberId: "member-1",
        seasonYear,
        membershipTypeId: "type-associate",
        adminMemberId: "admin-1",
        reason: "member changed category",
        previewToken: preview.previewToken,
        db: db as never,
      });
    }

    // Future season: grouping resolves at "now", so no trigger.
    const futureResult = await saveForSeason(currentSeason + 1);
    expect(futureResult.init?.status).toBeUndefined();
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();

    // Current season: the effective type may change now -> trigger fires.
    const currentResult = await saveForSeason(currentSeason);
    expect(currentResult.init?.status).toBeUndefined();
    expect(mockTriggerGroupSync).toHaveBeenCalledTimes(1);
    expect(mockTriggerGroupSync).toHaveBeenCalledWith("member-1", {
      createdByMemberId: "admin-1",
      reason: "seasonal_membership_assignment",
    });
  });
});

describe("seasonal membership assignment roll-forward", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("previews idempotent copies and reports missing/inactive exceptions", async () => {
    const db = makeRollForwardDb();

    const result = await rollForwardSeasonalMembershipAssignments({
      fromSeasonYear: 2026,
      toSeasonYear: 2027,
      adminMemberId: "admin-1",
      dryRun: true,
      db: db as never,
    });

    expect(result.init?.status).toBeUndefined();
    expect(result.body).toMatchObject({
      dryRun: true,
      sourceAssignmentCount: 3,
      wouldCopyCount: 2,
      copiedCount: 0,
      skippedExistingCount: 1,
      exceptionCount: 2,
      exceptions: expect.arrayContaining([
        expect.objectContaining({ code: "missing_prior_assignment" }),
        expect.objectContaining({
          code: "inactive_membership_type",
          membershipTypeName: "Inactive",
        }),
      ]),
    });
    expect(db.seasonalMembershipAssignment.createMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("runs roll-forward with skipDuplicates and writes a summary audit", async () => {
    const db = makeRollForwardDb();

    const result = await rollForwardSeasonalMembershipAssignments({
      fromSeasonYear: 2026,
      toSeasonYear: 2027,
      adminMemberId: "admin-1",
      request: { id: "req-1", ipAddress: "127.0.0.1", userAgent: "vitest" },
      db: db as never,
    });

    expect(result.body).toMatchObject({
      dryRun: false,
      wouldCopyCount: 2,
      copiedCount: 2,
      skippedExistingCount: 1,
    });
    expect(db.seasonalMembershipAssignment.createMany).toHaveBeenCalledWith({
      data: [
        {
          memberId: "member-copy",
          seasonYear: 2027,
          membershipTypeId: "type-full",
          applyFrom: null,
          assignedByMemberId: "admin-1",
        },
        {
          memberId: "member-inactive",
          seasonYear: 2027,
          membershipTypeId: "type-inactive",
          applyFrom: null,
          assignedByMemberId: "admin-1",
        },
      ],
      skipDuplicates: true,
    });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: SEASONAL_MEMBERSHIP_ASSIGNMENTS_ROLLED_FORWARD_ACTION,
          actorMemberId: "admin-1",
          category: "admin",
          severity: "important",
          metadata: expect.objectContaining({
            fromSeasonYear: 2026,
            toSeasonYear: 2027,
            copiedCount: 2,
            sourceAssignmentCount: 3,
            skippedExistingCount: 1,
            exceptionCount: 2,
          }),
        }),
      }),
    );
  });

  it("does not fire the Xero contact-group trigger when rolling forward to a non-current season", async () => {
    const db = makeRollForwardDb();

    await rollForwardSeasonalMembershipAssignments({
      // 2026 -> 2027 in the fixture; ensure 2027 is NOT the current season
      // for this assertion to be meaningful.
      fromSeasonYear: 2026,
      toSeasonYear: 2027,
      adminMemberId: "admin-1",
      db: db as never,
    });

    // The premise this case rests on, stated as a fact about the FROZEN CLOCK
    // rather than as a property of the test's own helper. Asserting the helper
    // against itself passed under every mutation, including one that returned 1999
    // (#2870, correctness review).
    expect(CLUB_CURRENT_SEASON_YEAR).toBe(2026);
    expect(CLUB_CURRENT_SEASON_YEAR).not.toBe(2027);
    expect(mockTriggerGroupSync).not.toHaveBeenCalled();
  });

  it("fires the trigger only for actually-copied candidates when rolling forward to the current season", async () => {
    const currentSeason = CLUB_CURRENT_SEASON_YEAR;
    const priorSeason = currentSeason - 1;
    const candidates = ["member-copy", "member-race"].map((memberId, index) => ({
      id: `assignment-${memberId}`,
      memberId,
      seasonYear: priorSeason,
      membershipTypeId: "type-full",
      member: {
        id: memberId,
        firstName: `M${index}`,
        lastName: "Member",
        email: `${memberId}@example.test`,
        active: true,
        archivedAt: null,
        cancelledAt: null,
      },
      membershipType: fullType,
    }));

    const db = {
      seasonalMembershipAssignment: {
        findMany: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where.seasonYear === priorSeason) return candidates;
          if (where.memberId?.in) {
            // Post-copy verification: member-race lost the createMany
            // skipDuplicates race (a concurrent writer was rolled back), so
            // only member-copy holds a current-season assignment now.
            return [{ memberId: "member-copy" }];
          }
          // Target-season pre-read: nothing assigned yet.
          return [];
        }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      member: {
        findMany: vi.fn().mockImplementation(async ({ select }: any) =>
          // #2821: see above — the inheritance re-resolution reads through this
          // same double and must not be served the candidate list.
          select?.inheritEmailChoiceId
            ? []
            : candidates.map((candidate) => candidate.member),
        ),
        update: vi.fn().mockResolvedValue({}),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
      $transaction: vi.fn(async (callback: any) => callback(db)),
    };

    await rollForwardSeasonalMembershipAssignments({
      fromSeasonYear: priorSeason,
      toSeasonYear: currentSeason,
      adminMemberId: "admin-1",
      db: db as never,
    });

    expect(mockTriggerGroupSync).toHaveBeenCalledTimes(1);
    expect(mockTriggerGroupSync).toHaveBeenCalledWith("member-copy", {
      createdByMemberId: "admin-1",
      reason: "seasonal_membership_roll_forward",
    });
  });

  // #2106 (MAJOR-3/4): current-season roll-forward reconciles tiers post-copy,
  // in chunks, and writes a critical reconcile summary audit.
  it("reconciles copied members' tiers post-copy and writes the reconcile summary audit", async () => {
    mockSweep.mockResolvedValueOnce([
      { bookingId: "bk-1", stayDate: new Date("2099-08-01") },
    ]);
    const currentSeason = CLUB_CURRENT_SEASON_YEAR;
    const priorSeason = currentSeason - 1;
    const personTiers = [
      { ageTier: "INFANT" },
      { ageTier: "CHILD" },
      { ageTier: "YOUTH" },
      { ageTier: "ADULT" },
    ];
    const candidateMembers = [
      {
        id: "member-forced",
        firstName: "Fay",
        lastName: "Forced",
        email: "forced@example.test",
        active: true,
        archivedAt: null,
        cancelledAt: null,
      },
      {
        id: "member-keep",
        firstName: "Kay",
        lastName: "Keep",
        email: "keep@example.test",
        active: true,
        archivedAt: null,
        cancelledAt: null,
      },
    ];
    const candidates = candidateMembers.map((member) => ({
      id: `a-${member.id}`,
      memberId: member.id,
      seasonYear: priorSeason,
      membershipTypeId: member.id === "member-forced" ? "type-exempt" : "type-full",
      member,
      membershipType: { ...fullType, isActive: true },
    }));
    const freshById: Record<string, unknown> = {
      "member-forced": {
        id: "member-forced",
        ageTier: "ADULT",
        dateOfBirth: null,
        role: "USER",
        accessRoles: [{ role: "USER" }],
        firstName: "Fay",
        lastName: "Forced",
        email: "forced@example.test",
      },
      "member-keep": {
        id: "member-keep",
        ageTier: "ADULT",
        dateOfBirth: null,
        role: "USER",
        accessRoles: [{ role: "USER" }],
        firstName: "Kay",
        lastName: "Keep",
        email: "keep@example.test",
      },
    };
    const exemptionByMember: Record<string, Array<{ ageTier: string }>> = {
      "member-forced": [{ ageTier: "NOT_APPLICABLE" }],
      "member-keep": personTiers,
    };

    const db: any = {
      seasonalMembershipAssignment: {
        findMany: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where.memberId?.in) {
            return where.memberId.in.map((id: string) => ({
              memberId: id,
              membershipType: {
                subscriptionBehavior:
                  id === "member-forced" ? "FORCED" : "REQUIRED",
                allowedAgeTiers: exemptionByMember[id],
              },
            }));
          }
          if (where.seasonYear === priorSeason) return candidates;
          return [];
        }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      member: {
        findMany: vi.fn().mockImplementation(async ({ where, select }: any) => {
          // #2821: the age-tier write now re-resolves email inheritance in the
          // same transaction, and that read uses the SAME `where.id.in` shape
          // as this suite's own candidate read. The select is what tells them
          // apart. `[]` is the honest answer here: these fixtures have no
          // dependants, so nothing needs re-pointing.
          if (select?.inheritEmailChoiceId) return [];
          if (where?.id?.in) {
            return where.id.in.map((id: string) => freshById[id]);
          }
          return candidateMembers;
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      memberSubscription: {
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $executeRaw: vi.fn().mockResolvedValue(1),
      $transaction: vi.fn(async (callback: any) => callback(db)),
    };

    const result = await rollForwardSeasonalMembershipAssignments({
      fromSeasonYear: priorSeason,
      toSeasonYear: currentSeason,
      adminMemberId: "admin-1",
      db: db as never,
    });

    expect(result.body).toMatchObject({ copiedCount: 2 });
    // The FORCED-type member flips ADULT -> N/A; the person-tier member is left.
    expect(db.member.update).toHaveBeenCalledWith({
      where: { id: "member-forced" },
      data: { ageTier: "NOT_APPLICABLE" },
    });
    expect(db.member.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "member-keep" } }),
    );

    const reconcileAudit = db.auditLog.create.mock.calls.find(
      ([arg]: [any]) =>
        arg.data.action === SEASONAL_MEMBERSHIP_ROLL_FORWARD_TIERS_RECONCILED_ACTION,
    );
    expect(reconcileAudit).toBeTruthy();
    expect(reconcileAudit[0].data.severity).toBe("critical");
    expect(reconcileAudit[0].data.metadata).toMatchObject({
      ageTierReconciledCount: 1,
      partnerSharesSweptCount: 1,
      ageTierReconciled: [
        {
          memberId: "member-forced",
          previousAgeTier: "ADULT",
          newAgeTier: "NOT_APPLICABLE",
        },
      ],
    });
  });

  it("continues past a failed reconcile chunk without rolling back the copy", async () => {
    const currentSeason = CLUB_CURRENT_SEASON_YEAR;
    const priorSeason = currentSeason - 1;
    const ids = Array.from({ length: 30 }, (_, i) => `member-${i}`);
    const candidateMembers = ids.map((id) => ({
      id,
      firstName: id,
      lastName: "M",
      email: `${id}@example.test`,
      active: true,
      archivedAt: null,
      cancelledAt: null,
    }));
    const candidates = candidateMembers.map((member) => ({
      id: `a-${member.id}`,
      memberId: member.id,
      seasonYear: priorSeason,
      membershipTypeId: "type-exempt",
      member,
      membershipType: { ...fullType, isActive: true },
    }));
    const freshById = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          id,
          ageTier: "ADULT",
          dateOfBirth: null,
          role: "USER",
          accessRoles: [{ role: "USER" }],
          firstName: id,
          lastName: "M",
          email: `${id}@example.test`,
        },
      ]),
    );

    const db: any = {
      seasonalMembershipAssignment: {
        findMany: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where.memberId?.in) {
            return where.memberId.in.map((id: string) => ({
              memberId: id,
              membershipType: {
                subscriptionBehavior: "FORCED",
                allowedAgeTiers: [{ ageTier: "NOT_APPLICABLE" }],
              },
            }));
          }
          if (where.seasonYear === priorSeason) return candidates;
          return [];
        }),
        createMany: vi.fn().mockResolvedValue({ count: 30 }),
      },
      member: {
        findMany: vi.fn().mockImplementation(async ({ where, select }: any) => {
          // #2821: the age-tier write now re-resolves email inheritance in the
          // same transaction, and that read uses the SAME `where.id.in` shape
          // as this suite's own candidate read. The select is what tells them
          // apart. `[]` is the honest answer here: these fixtures have no
          // dependants, so nothing needs re-pointing.
          if (select?.inheritEmailChoiceId) return [];
          if (where?.id?.in) {
            return where.id.in.map((id: string) => freshById[id]);
          }
          return candidateMembers;
        }),
        // The first chunk (members 0-24) throws when it reaches member-0; the
        // second chunk (25-29) must still reconcile.
        update: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where.id === "member-0") throw new Error("update failed");
          return {};
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $executeRaw: vi.fn().mockResolvedValue(1),
      $transaction: vi.fn(async (callback: any) => callback(db)),
    };

    const result = await rollForwardSeasonalMembershipAssignments({
      fromSeasonYear: priorSeason,
      toSeasonYear: currentSeason,
      adminMemberId: "admin-1",
      db: db as never,
    });

    // The copy is untouched by the failed chunk.
    expect(result.body).toMatchObject({ copiedCount: 30 });
    const reconcileAudit = db.auditLog.create.mock.calls.find(
      ([arg]: [any]) =>
        arg.data.action === SEASONAL_MEMBERSHIP_ROLL_FORWARD_TIERS_RECONCILED_ACTION,
    );
    expect(reconcileAudit).toBeTruthy();
    // Only the surviving second chunk's 5 members reconciled.
    expect(reconcileAudit[0].data.metadata.ageTierReconciledCount).toBe(5);
  });
});
