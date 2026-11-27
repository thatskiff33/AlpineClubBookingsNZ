import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import {
  MembershipTypeBookingPolicyError,
  getMembershipTypeBookingPolicyErrorBody,
  priceBookingGuestsWithMembershipTypePolicy,
  requiresPaidSubscriptionForMemberForBooking,
  resolveGuestRateMembershipTypes,
  resolveMembershipTypePoliciesForMembers,
} from "@/lib/membership-type-policy";

// The club enforces subscriptions; each test may set its liability rule (#5190).
const lockoutPolicy = vi.hoisted(() => ({
  liabilitySettings: {
    requiredTypeAgeRule: "NOT_CHOSEN",
    liabilityAgeSource: "NOT_CHOSEN",
  } as { requiredTypeAgeRule: string; liabilityAgeSource: string },
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  resolveSubscriptionLockoutPolicy: vi.fn(async () => ({
    mode: "HARD_BLOCK",
    liabilitySettings: lockoutPolicy.liabilitySettings,
  })),
}));
// ADULT and YOUTH owe a subscription; CHILD is age-exempt.
vi.mock("@/lib/age-tier", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/age-tier")),
  getAgeTierSettings: vi.fn(async () => [
    { tier: "CHILD", minAge: 5, maxAge: 12, label: "Child", sortOrder: 1, subscriptionRequiredForBooking: false },
    { tier: "YOUTH", minAge: 13, maxAge: 17, label: "Youth", sortOrder: 2, subscriptionRequiredForBooking: true },
    { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3, subscriptionRequiredForBooking: true },
  ]),
}));

function readRepoFile(path: string) {
  return readFileSync(`${process.cwd()}/${path}`, "utf8");
}

type PolicyMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: "MEMBER" | "LIFE" | "LODGE" | "ADMIN";
  ageTier: "ADULT" | "YOUTH" | "CHILD";
};

type PolicyType = {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
  subscriptionBehavior: "REQUIRED" | "NOT_REQUIRED" | "BASED_ON_AGE_TIER";
};

const fullType: PolicyType = {
  id: "type-full",
  key: "FULL",
  name: "Full",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
};

const associateType: PolicyType = {
  id: "type-associate",
  key: "ASSOCIATE",
  name: "Associate",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "NON_MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
};

const renamedAssociateBlockType: PolicyType = {
  id: "type-associate",
  key: "ASSOCIATE",
  name: "Reserve",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "BLOCK_BOOKING",
  subscriptionBehavior: "REQUIRED",
};

const lifeType: PolicyType = {
  id: "type-life",
  key: "LIFE",
  name: "Life",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "NOT_REQUIRED",
};

// The built-in NON_MEMBER type the rate resolver (#1930, E4) resolves
// non-members and TYPE_POLICY_FORCED members to.
const nonMemberType: PolicyType = {
  id: "type-nonmember",
  key: "NON_MEMBER",
  name: "Non-Member",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "NON_MEMBER_RATE",
  subscriptionBehavior: "NOT_REQUIRED",
};

function makeMember(overrides: Partial<PolicyMember> = {}): PolicyMember {
  return {
    id: "member-1",
    firstName: "Alex",
    lastName: "Member",
    email: "alex@example.test",
    role: "MEMBER",
    ageTier: "ADULT",
    ...overrides,
  };
}

function makePolicyDb(options: {
  members: PolicyMember[];
  assignments?: Array<{ memberId: string; seasonYear: number; membershipType: PolicyType }>;
  membershipTypes?: PolicyType[];
}) {
  return {
    member: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        options.members.filter((member) => args.where.id.in.includes(member.id)),
      ),
    },
    seasonalMembershipAssignment: {
      findMany: vi.fn(
        async (args: { where: { memberId: { in: string[] }; seasonYear: number } }) =>
          (options.assignments ?? []).filter(
            (assignment) =>
              args.where.memberId.in.includes(assignment.memberId) &&
              assignment.seasonYear === args.where.seasonYear,
          ),
      ),
    },
    membershipType: {
      findMany: vi.fn(async (args: { where: { key: { in: string[] }; isActive?: boolean } }) =>
        (options.membershipTypes ?? []).filter((type) =>
          args.where.key.in.includes(type.key) &&
          (args.where.isActive === undefined || type.isActive === args.where.isActive),
        ),
      ),
    },
  };
}

// Membership-type-keyed rates (#1930, E4): FULL member rows and NON_MEMBER
// (non-member) rows for ADULT.
const seasonRates = [
  {
    seasonId: "season-2026",
    startDate: new Date("2026-04-01T00:00:00.000Z"),
    endDate: new Date("2026-10-31T00:00:00.000Z"),
    rates: [
      { membershipTypeId: "type-full", ageTier: "ADULT" as const, pricePerNightCents: 1000 },
      { membershipTypeId: "type-nonmember", ageTier: "ADULT" as const, pricePerNightCents: 2400 },
    ],
  },
];

describe("membership type booking and subscription policy", () => {
  it("resolves explicit seasonal assignments before role defaults", async () => {
    const db = makePolicyDb({
      members: [makeMember()],
      assignments: [
        { memberId: "member-1", seasonYear: 2026, membershipType: associateType },
      ],
      membershipTypes: [fullType],
    });

    const policies = await resolveMembershipTypePoliciesForMembers(db, {
      memberIds: ["member-1"],
      seasonYear: 2026,
    });

    expect(policies.get("member-1")).toMatchObject({
      source: "assignment",
      bookingBehavior: "NON_MEMBER_RATE",
      subscriptionBehavior: "REQUIRED",
      membershipType: { key: "ASSOCIATE" },
    });
  });

  it("falls back to built-in role defaults when the type row is missing", async () => {
    const db = makePolicyDb({
      members: [makeMember({ id: "lodge-1", role: "LODGE" })],
      membershipTypes: [],
    });

    const policies = await resolveMembershipTypePoliciesForMembers(db, {
      memberIds: ["lodge-1"],
      seasonYear: 2026,
    });

    expect(policies.get("lodge-1")).toMatchObject({
      source: "built_in_default",
      subscriptionBehavior: "NOT_REQUIRED",
      membershipType: { key: "LODGE" },
    });
  });

  it("uses an archived stored role default rather than synthesizing the built-in policy", async () => {
    const db = makePolicyDb({
      members: [makeMember()],
      membershipTypes: [{ ...fullType, isActive: false, bookingBehavior: "BLOCK_BOOKING" }],
    });
    const policies = await resolveMembershipTypePoliciesForMembers(db, {
      memberIds: ["member-1"], seasonYear: 2026,
    });
    expect(policies.get("member-1")).toMatchObject({
      source: "role_default", bookingBehavior: "BLOCK_BOOKING",
      membershipType: { id: "type-full", isActive: false },
    });
  });

  it("throws a structured block error for booking owners and member guests", async () => {
    const db = makePolicyDb({
      members: [
        makeMember({ id: "owner-1", firstName: "Blocked", lastName: "Owner" }),
        makeMember({ id: "guest-1", firstName: "Blocked", lastName: "Guest" }),
      ],
      assignments: [
        {
          memberId: "owner-1",
          seasonYear: 2026,
          membershipType: renamedAssociateBlockType,
        },
        {
          memberId: "guest-1",
          seasonYear: 2026,
          membershipType: renamedAssociateBlockType,
        },
      ],
    });

    await expect(
      priceBookingGuestsWithMembershipTypePolicy(db, {
        ownerMemberId: "owner-1",
        checkIn: new Date("2026-05-01T00:00:00.000Z"),
        checkOut: new Date("2026-05-02T00:00:00.000Z"),
        guests: [{ ageTier: "ADULT", isMember: true, memberId: "guest-1" }],
        seasons: seasonRates,
      }),
    ).rejects.toMatchObject({
      code: "MEMBERSHIP_TYPE_BLOCKS_BOOKING",
      status: 403,
    });

    try {
      await priceBookingGuestsWithMembershipTypePolicy(db, {
        ownerMemberId: "owner-1",
        checkIn: new Date("2026-05-01T00:00:00.000Z"),
        checkOut: new Date("2026-05-02T00:00:00.000Z"),
        guests: [{ ageTier: "ADULT", isMember: true, memberId: "guest-1" }],
        seasons: seasonRates,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MembershipTypeBookingPolicyError);
      const body = getMembershipTypeBookingPolicyErrorBody(
        error as MembershipTypeBookingPolicyError,
      );
      expect(body).toMatchObject({
        code: "MEMBERSHIP_TYPE_BLOCKS_BOOKING",
        blockedMembers: [
          { scope: "BOOKING_OWNER", memberId: "owner-1", bookingBehavior: "BLOCK_BOOKING" },
          { scope: "MEMBER_GUEST", memberId: "guest-1", bookingBehavior: "BLOCK_BOOKING" },
        ],
      });
    }
  });

  it("prices NON_MEMBER_RATE members at non-member rates while preserving identity", async () => {
    const db = makePolicyDb({
      members: [makeMember()],
      assignments: [
        { memberId: "member-1", seasonYear: 2026, membershipType: associateType },
      ],
      // The rate resolver (#1930, E4) needs the built-in NON_MEMBER type to map
      // this TYPE_POLICY_FORCED member onto the non-member rate rows.
      membershipTypes: [nonMemberType],
    });

    const price = await priceBookingGuestsWithMembershipTypePolicy(db, {
      ownerMemberId: "member-1",
      checkIn: new Date("2026-05-01T00:00:00.000Z"),
      checkOut: new Date("2026-05-02T00:00:00.000Z"),
      guests: [{ ageTier: "ADULT", isMember: true, memberId: "member-1" }],
      seasons: seasonRates,
      groupDiscount: { enabled: true, minGroupSize: 1, summerOnly: false },
    });

    expect(price.totalPriceCents).toBe(2400);
    expect(price.guests[0]).toMatchObject({
      isMember: true,
      perNightCents: [2400],
    });
  });

  it("classifies rate membership types by rateSource (#1930, E4, D2/D3 invariant)", async () => {
    const db = makePolicyDb({
      members: [
        makeMember({ id: "full-1" }),
        makeMember({ id: "assoc-1" }),
        makeMember({ id: "nonmember-1" }),
      ],
      assignments: [
        { memberId: "full-1", seasonYear: 2026, membershipType: fullType },
        { memberId: "assoc-1", seasonYear: 2026, membershipType: associateType },
      ],
      membershipTypes: [nonMemberType],
    });

    const rated = await resolveGuestRateMembershipTypes(db, {
      seasonYear: 2026,
      guests: [
        { isMember: true, memberId: "full-1" },
        { isMember: true, memberId: "assoc-1" },
        { isMember: false, memberId: null },
      ],
    });

    // OWN_TYPE: a MEMBER_RATE member prices from its own type.
    expect(rated[0]).toMatchObject({
      rateSource: "OWN_TYPE",
      rateMembershipTypeId: "type-full",
    });
    // TYPE_POLICY_FORCED: a NON_MEMBER_RATE member resolves to NON_MEMBER, never
    // its own (rate-less) associate type — the D2 zero-own-rows invariant.
    expect(rated[1]).toMatchObject({
      rateSource: "TYPE_POLICY_FORCED",
      rateMembershipTypeId: "type-nonmember",
    });
    expect(rated[1].rateMembershipTypeId).not.toBe("type-associate");
    // NON_MEMBER_DEFAULT: a true non-member resolves to NON_MEMBER.
    expect(rated[2]).toMatchObject({
      rateSource: "NON_MEMBER_DEFAULT",
      rateMembershipTypeId: "type-nonmember",
    });
  });

  it("exempts NOT_REQUIRED membership types from booking subscription lockout", async () => {
    const db = makePolicyDb({
      members: [makeMember()],
      assignments: [
        { memberId: "member-1", seasonYear: 2026, membershipType: lifeType },
      ],
    });

    await expect(
      requiresPaidSubscriptionForMemberForBooking(db, {
        memberId: "member-1",
        seasonYear: 2026,
      }),
    ).resolves.toBe(false);
  });

  describe("role carries no subscription exemption (#2149)", () => {
    // ADMIN/LODGE built-in fallback types (seeded by migration; resolved from DB
    // via defaultMembershipTypeKeyForRole when a member has no season assignment).
    const adminType: PolicyType = {
      id: "type-admin",
      key: "ADMIN",
      name: "Admin",
      isActive: true,
      isBuiltIn: true,
      bookingBehavior: "BLOCK_BOOKING",
      subscriptionBehavior: "NOT_REQUIRED",
    };
    const lodgeType: PolicyType = {
      id: "type-lodge",
      key: "LODGE",
      name: "Lodge",
      isActive: true,
      isBuiltIn: true,
      bookingBehavior: "MEMBER_RATE",
      subscriptionBehavior: "NOT_REQUIRED",
    };

    it("a fee-paying member holding the ADMIN role with a REQUIRED assignment now owes a subscription", async () => {
      // The bug: the role short-circuit exempted them before the type was read.
      const db = makePolicyDb({
        members: [makeMember({ role: "ADMIN" })],
        assignments: [
          { memberId: "member-1", seasonYear: 2026, membershipType: fullType },
        ],
      });

      await expect(
        requiresPaidSubscriptionForMemberForBooking(db, {
          memberId: "member-1",
          seasonYear: 2026,
        }),
      ).resolves.toBe(true);
    });

    it("a bare ADMIN account (no assignment) falls back to its NOT_REQUIRED built-in type", async () => {
      const db = makePolicyDb({
        members: [makeMember({ role: "ADMIN" })],
        assignments: [],
        membershipTypes: [adminType],
      });

      await expect(
        requiresPaidSubscriptionForMemberForBooking(db, {
          memberId: "member-1",
          seasonYear: 2026,
        }),
      ).resolves.toBe(false);
    });

    it("a bare LODGE kiosk account is not required across a season boundary (rollover with no assignment)", async () => {
      // A LODGE-role kiosk, a season later, with no assignment, must resolve
      // NOT_REQUIRED via the LODGE fallback type so it is never blocked from
      // booking on behalf of members. makeMember's role type does not include
      // LODGE, so build the member row inline.
      const seasonBoundaryDb = {
        member: {
          findMany: vi.fn(async () => [
            {
              id: "lodge-1",
              firstName: "Lodge",
              lastName: "Kiosk",
              email: "lodge@example.test",
              role: "LODGE",
              ageTier: "ADULT",
            },
          ]),
        },
        seasonalMembershipAssignment: { findMany: vi.fn(async () => []) },
        membershipType: {
          findMany: vi.fn(async (args: { where: { key: { in: string[] } } }) =>
            [lodgeType].filter((type) => args.where.key.in.includes(type.key)),
          ),
        },
      };

      await expect(
        requiresPaidSubscriptionForMemberForBooking(seasonBoundaryDb, {
          memberId: "lodge-1",
          seasonYear: 2027,
        }),
      ).resolves.toBe(false);
    });
  });

  describe("BASED_ON_AGE_TIER booking gate (#2041)", () => {
    const ageTierType: PolicyType = {
      id: "type-full",
      key: "FULL",
      name: "Full",
      isActive: true,
      isBuiltIn: true,
      bookingBehavior: "MEMBER_RATE",
      subscriptionBehavior: "BASED_ON_AGE_TIER",
    };

    function makeDbWithSubscription(input: {
      membershipType: PolicyType;
      ageTier: PolicyMember["ageTier"];
      seasonRow?: { status: "NOT_REQUIRED" | "NOT_INVOICED"; noInvoiceCoverage?: boolean };
    }) {
      const findMany = vi.fn(async () =>
        input.seasonRow
          ? [
              {
                memberId: "member-1",
                status: input.seasonRow.status,
                chargeCoverage: input.seasonRow.noInvoiceCoverage ? [{ id: "cov-1" }] : [],
              },
            ]
          : [],
      );
      const db = {
        ...makePolicyDb({
          members: [makeMember({ ageTier: input.ageTier })],
          assignments: [
            { memberId: "member-1", seasonYear: 2026, membershipType: input.membershipType },
          ],
        }),
        memberSubscription: { findMany },
      };
      return { db, findMany };
    }
    const gate = (db: unknown) =>
      requiresPaidSubscriptionForMemberForBooking(db, {
        memberId: "member-1",
        seasonYear: 2026,
      });
    const chooseRule = (requiredTypeAgeRule: string) => {
      lockoutPolicy.liabilitySettings = {
        requiredTypeAgeRule,
        liabilityAgeSource: "SEASON_START",
      };
    };
    afterEach(() => {
      lockoutPolicy.liabilitySettings = {
        requiredTypeAgeRule: "NOT_CHOSEN",
        liabilityAgeSource: "NOT_CHOSEN",
      };
    });

    it("defers to the per-age-tier flag when no NOT_REQUIRED row exists", async () => {
      const { db, findMany } = makeDbWithSubscription({
        membershipType: ageTierType,
        ageTier: "YOUTH",
      });
      await expect(gate(db)).resolves.toBe(true);
      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("Edge 2, while NOT_CHOSEN: a NOT_REQUIRED season row dominates a liable stored tier (#2041)", async () => {
      const { db } = makeDbWithSubscription({
        membershipType: ageTierType,
        ageTier: "YOUTH",
        seasonRow: { status: "NOT_REQUIRED" },
      });
      await expect(gate(db)).resolves.toBe(false);
    });

    it("Edge 2, once the club has chosen: the season row exempts nobody and age decides", async () => {
      chooseRule("AGE_TIER_EXEMPTS");
      const { db } = makeDbWithSubscription({
        membershipType: ageTierType,
        ageTier: "YOUTH",
        seasonRow: { status: "NOT_REQUIRED" },
      });
      await expect(gate(db)).resolves.toBe(true);
    });

    it("Edge 1, while NOT_CHOSEN: a REQUIRED-type member whose stored tier is exempt may book (pre-#5190 access rule)", async () => {
      const { db } = makeDbWithSubscription({ membershipType: fullType, ageTier: "CHILD" });
      await expect(gate(db)).resolves.toBe(false);
    });

    it("Edge 1, once the club has chosen: the club's rule decides for a REQUIRED-type child", async () => {
      chooseRule("ALWAYS_OWES");
      const always = makeDbWithSubscription({ membershipType: fullType, ageTier: "CHILD" });
      await expect(gate(always.db)).resolves.toBe(true);

      chooseRule("AGE_TIER_EXEMPTS");
      const exempts = makeDbWithSubscription({ membershipType: fullType, ageTier: "CHILD" });
      await expect(gate(exempts.db)).resolves.toBe(false);
    });

    it("a member covered by a no-invoice fee is not required to hold a PAID row, whatever the row status (#5190)", async () => {
      const { db } = makeDbWithSubscription({
        membershipType: fullType,
        ageTier: "ADULT",
        seasonRow: { status: "NOT_INVOICED", noInvoiceCoverage: true },
      });
      await expect(gate(db)).resolves.toBe(false);
    });
  });
});

describe("group-discount NULL substitution target fallback (#1930, E4 review F2)", () => {
  // Scenario: the GroupDiscountSetting row was created AFTER the re-key
  // migration (e.g. by the pre-fix admin route's upsert-create), so its
  // rateMembershipTypeId is NULL. The discount must still substitute the
  // built-in FULL type for true non-members, exactly like main's boolean flip.
  it("a row created post-migration (NULL target) still discounts non-members to the FULL rate", async () => {
    const db = makePolicyDb({
      members: [],
      membershipTypes: [fullType, nonMemberType],
    });

    const price = await priceBookingGuestsWithMembershipTypePolicy(db, {
      checkIn: new Date("2026-05-01T00:00:00.000Z"),
      checkOut: new Date("2026-05-02T00:00:00.000Z"),
      guests: [{ ageTier: "ADULT", isMember: false }],
      seasons: seasonRates,
      // NULL target, as stored by a post-migration upsert-create.
      groupDiscount: {
        enabled: true,
        minGroupSize: 1,
        summerOnly: false,
        rateMembershipTypeId: null,
      },
    });

    // Substituted to FULL's 1000 rate, not the NON_MEMBER 2400 rate.
    expect(price.totalPriceCents).toBe(1000);
    // The persisted snapshot stays the resolved NON_MEMBER type.
    expect(price.guests[0].rateMembershipTypeId).toBe("type-nonmember");
  });

  it("resolveGroupDiscountRateType fills only an enabled NULL target and never queries otherwise", async () => {
    const { resolveGroupDiscountRateType } = await import(
      "@/lib/membership-type-policy"
    );
    const db = makePolicyDb({ members: [], membershipTypes: [fullType] });

    // Disabled: untouched, no membership-type query.
    const disabled = await resolveGroupDiscountRateType(db, {
      enabled: false,
      minGroupSize: 5,
      summerOnly: true,
      rateMembershipTypeId: null,
    });
    expect(disabled?.rateMembershipTypeId).toBeNull();
    expect(db.membershipType.findMany).not.toHaveBeenCalled();

    // Explicit target: untouched, no query.
    const targeted = await resolveGroupDiscountRateType(db, {
      enabled: true,
      minGroupSize: 5,
      summerOnly: true,
      rateMembershipTypeId: "type-custom",
    });
    expect(targeted?.rateMembershipTypeId).toBe("type-custom");
    expect(db.membershipType.findMany).not.toHaveBeenCalled();

    // Enabled + NULL: resolved to the built-in FULL type.
    const healed = await resolveGroupDiscountRateType(db, {
      enabled: true,
      minGroupSize: 5,
      summerOnly: true,
      rateMembershipTypeId: null,
    });
    expect(healed?.rateMembershipTypeId).toBe("type-full");
  });
});

describe("membership type booking policy route integration", () => {
  it("preserves policy block errors through generic booking pricing failures", () => {
    const sources = [
      "src/lib/booking-modify-plan.ts",
      "src/lib/booking-date-modification-service.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
    ];

    for (const path of sources) {
      const source = readRepoFile(path);

      expect(source).toContain("MembershipTypeBookingPolicyError");
      expect(source).toContain("error instanceof MembershipTypeBookingPolicyError");
      expect(source).toContain("throw error;");
    }
  });
});
