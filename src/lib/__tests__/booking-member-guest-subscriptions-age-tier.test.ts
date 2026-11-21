import type { AgeTier, SubscriptionStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// findUnpaidMemberGuests consults enforcement + age-tier settings + the
// membership-type policy. Mock those so we can drive the BASED_ON_AGE_TIER
// NOT_REQUIRED-row dominance (#2041) deterministically.
//
// #2543 moved the shared rule into `subscription-lockout-facts.ts`, which reads
// the real age-tier rule from `@/lib/policies/subscription` rather than the
// re-export on `member-subscription-eligibility`. So the tiers are driven by real
// SETTINGS ROWS here instead of by a stubbed predicate — a strictly stronger
// arrangement, because the rule under test is now the one production runs
// (including its missing-row default of "required").
const lockout = vi.hoisted(() => ({
  liabilitySettings: { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" },
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  resolveSubscriptionLockoutPolicy: vi.fn(async () => ({
    mode: "HARD_BLOCK",
    liabilitySettings: lockout.liabilitySettings,
  })),
}));
vi.mock("@/lib/age-tier", () => ({
  // Age bands too (#5190): a club that has chosen its liability rule derives the
  // tier from the date of birth.
  getAgeTierSettings: vi.fn(async () => [
    { tier: "INFANT", minAge: 0, maxAge: 4, sortOrder: 0, subscriptionRequiredForBooking: false },
    { tier: "CHILD", minAge: 5, maxAge: 9, sortOrder: 1, subscriptionRequiredForBooking: false },
    { tier: "YOUTH", minAge: 10, maxAge: 17, sortOrder: 2, subscriptionRequiredForBooking: true },
    { tier: "ADULT", minAge: 18, maxAge: null, sortOrder: 3, subscriptionRequiredForBooking: true },
  ]),
}));

const mockResolvePolicies = vi.fn();
vi.mock("@/lib/membership-type-policy", () => ({
  resolveMembershipTypePoliciesForMembers: (...args: unknown[]) =>
    mockResolvePolicies(...args),
}));

import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";

type SubRow = { memberId: string; status: SubscriptionStatus; xeroOnlineInvoiceUrl: string | null; xeroInvoiceNumber: string | null };

function makeDb(
  members: Array<{ id: string; ageTier: AgeTier; dateOfBirth?: Date | null }>,
  subs: SubRow[],
) {
  return {
    memberSubscription: {
      findMany: vi.fn(async () => subs),
    },
    member: {
      findMany: vi.fn(async () =>
        members.map((m) => ({
          id: m.id,
          firstName: "Guest",
          lastName: m.id,
          ageTier: m.ageTier,
          dateOfBirth: m.dateOfBirth ?? null,
        })),
      ),
    },
  };
}

const checkIn = new Date("2026-07-13T00:00:00.000Z");

describe("findUnpaidMemberGuests BASED_ON_AGE_TIER dominance (#2041)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockout.liabilitySettings = { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" };
  });

  it("a NOT_REQUIRED season row dominates a Youth stored tier (mid-season age-up stays not-unpaid)", async () => {
    mockResolvePolicies.mockResolvedValue(
      new Map([["g1", { subscriptionBehavior: "BASED_ON_AGE_TIER" }]]),
    );
    const db = makeDb(
      [{ id: "g1", ageTier: "YOUTH" }],
      [{ memberId: "g1", status: "NOT_REQUIRED", xeroOnlineInvoiceUrl: null, xeroInvoiceNumber: null }],
    );
    const result = await findUnpaidMemberGuests(db, {
      bookingMemberId: "owner",
      checkIn,
      guests: [{ isMember: true, memberId: "g1" }],
    });
    expect(result).toEqual([]);
  });

  it("still flags a Youth with no NOT_REQUIRED row as unpaid (defers to the age-tier flag)", async () => {
    mockResolvePolicies.mockResolvedValue(
      new Map([["g1", { subscriptionBehavior: "BASED_ON_AGE_TIER" }]]),
    );
    const db = makeDb(
      [{ id: "g1", ageTier: "YOUTH" }],
      [{ memberId: "g1", status: "NOT_INVOICED", xeroOnlineInvoiceUrl: null, xeroInvoiceNumber: null }],
    );
    const result = await findUnpaidMemberGuests(db, {
      bookingMemberId: "owner",
      checkIn,
      guests: [{ isMember: true, memberId: "g1" }],
    });
    expect(result.map((r) => r.memberId)).toEqual(["g1"]);
  });

  it("an exempt Child tier is never unpaid even without a row", async () => {
    mockResolvePolicies.mockResolvedValue(
      new Map([["g1", { subscriptionBehavior: "BASED_ON_AGE_TIER" }]]),
    );
    const db = makeDb([{ id: "g1", ageTier: "CHILD" }], []);
    const result = await findUnpaidMemberGuests(db, {
      bookingMemberId: "owner",
      checkIn,
      guests: [{ isMember: true, memberId: "g1" }],
    });
    expect(result).toEqual([]);
  });

  it("REQUIRED types are byte-unchanged: a NOT_REQUIRED row does NOT dominate an Adult", async () => {
    mockResolvePolicies.mockResolvedValue(
      new Map([["g1", { subscriptionBehavior: "REQUIRED" }]]),
    );
    const db = makeDb(
      [{ id: "g1", ageTier: "ADULT" }],
      [{ memberId: "g1", status: "NOT_REQUIRED", xeroOnlineInvoiceUrl: null, xeroInvoiceNumber: null }],
    );
    const result = await findUnpaidMemberGuests(db, {
      bookingMemberId: "owner",
      checkIn,
      guests: [{ isMember: true, memberId: "g1" }],
    });
    expect(result.map((r) => r.memberId)).toEqual(["g1"]);
  });
});

// #5190: the member-guest gate is booking access, so it reads the shared
// liability rule's access side. Both edges, before and after the club chooses.
describe("findUnpaidMemberGuests and the shared liability rule (#5190)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockout.liabilitySettings = { requiredTypeAgeRule: "NOT_CHOSEN", liabilityAgeSource: "NOT_CHOSEN" };
  });

  const unpaidIds = async (
    behavior: string,
    member: { ageTier: AgeTier; dateOfBirth?: Date | null },
    subs: Array<Partial<SubRow> & { chargeCoverage?: Array<{ id: string }> }> = [],
  ) => {
    mockResolvePolicies.mockResolvedValue(new Map([["g1", { subscriptionBehavior: behavior }]]));
    const db = {
      memberSubscription: {
        findMany: vi.fn(async () => subs.map((sub) => ({
          memberId: "g1", status: "NOT_INVOICED", xeroOnlineInvoiceUrl: null, xeroInvoiceNumber: null, ...sub,
        }))),
      },
      member: {
        findMany: vi.fn(async () => [{ id: "g1", firstName: "Guest", lastName: "g1", dateOfBirth: null, ...member }]),
      },
    };
    const result = await findUnpaidMemberGuests(db as never, {
      bookingMemberId: "owner",
      checkIn,
      guests: [{ isMember: true, memberId: "g1" }],
    });
    return result.map((row) => row.memberId);
  };

  describe("Edge 1: a REQUIRED-type child", () => {
    const child = { ageTier: "CHILD" as AgeTier, dateOfBirth: new Date("2019-06-01T00:00:00.000Z") };

    it("books free while the club has not chosen (today's access rule)", async () => {
      expect(await unpaidIds("REQUIRED", child)).toEqual([]);
    });

    it("owes once the club chooses ALWAYS_OWES", async () => {
      lockout.liabilitySettings = { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_START" };
      expect(await unpaidIds("REQUIRED", child)).toEqual(["g1"]);
    });

    it("books free when the club chooses AGE_TIER_EXEMPTS", async () => {
      lockout.liabilitySettings = { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_START" };
      expect(await unpaidIds("REQUIRED", child)).toEqual([]);
    });
  });

  describe("Edge 2: an age-based adult with a saved NOT_REQUIRED row", () => {
    const adult = { ageTier: "ADULT" as AgeTier, dateOfBirth: new Date("1996-06-01T00:00:00.000Z") };

    it("books free while the club has not chosen (the row still exempts)", async () => {
      expect(await unpaidIds("BASED_ON_AGE_TIER", adult, [{ status: "NOT_REQUIRED" }])).toEqual([]);
    });

    it("owes once the club chooses (age wins)", async () => {
      lockout.liabilitySettings = { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", liabilityAgeSource: "SEASON_START" };
      expect(await unpaidIds("BASED_ON_AGE_TIER", adult, [{ status: "NOT_REQUIRED" }])).toEqual(["g1"]);
    });
  });

  it("treats a member covered by a no-invoice fee as settled, whatever the row says", async () => {
    // A REQUIRED-type adult whose NO_INVOICE charge left an active claim; the
    // Xero sync may have rewritten the row to NOT_INVOICED.
    expect(
      await unpaidIds("REQUIRED", { ageTier: "ADULT" }, [{ status: "NOT_INVOICED", chargeCoverage: [{ id: "claim-1" }] }]),
    ).toEqual([]);
    expect(await unpaidIds("REQUIRED", { ageTier: "ADULT" }, [{ status: "NOT_REQUIRED" }])).toEqual(["g1"]);
  });
});
