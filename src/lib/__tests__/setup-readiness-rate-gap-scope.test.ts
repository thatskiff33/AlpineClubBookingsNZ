import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The setup-readiness snapshot asks about EVERY rate-bearing membership type,
 * including the built-in `NON_MEMBER` (`INV-MOD-007`, #2933).
 *
 * This is the defect #2933 fixed, and it is invisible to every source-text
 * census: the snapshot filtered its membership-type read to
 * `bookingBehavior: "MEMBER_RATE"`, which is not a copy of the rule so much as
 * the rule with its one exception left out. `NON_MEMBER` carries
 * `NON_MEMBER_RATE` exactly like `ASSOCIATE` and `SCHOOL` do, and is
 * nonetheless the type every non-member guest the club takes is priced from —
 * so a season with no Non-Member rates was the one gap nothing warned about,
 * and an ordinary public booking is the first thing that reaches it.
 *
 * So this suite drives the real `getSetupDatabaseSnapshot` over a fake database
 * and reads the gaps it publishes. A narrowed query fails the first case; a
 * widened one that forgot to EXCLUDE the types that owe nothing fails the
 * second.
 */

const db = vi.hoisted(() => {
  interface MembershipTypeRow {
    id: string;
    name: string;
    key: string;
    bookingBehavior: string;
    isActive: boolean;
    ageGroupsApply: boolean;
  }
  interface RateRow {
    seasonId: string;
    membershipTypeId: string;
    ageTier: string | null;
  }
  const state = {
    membershipTypes: [] as MembershipTypeRow[],
    rateRows: [] as RateRow[],
    /** Every `where` the snapshot filtered its membership-type read by. */
    membershipTypeWheres: [] as unknown[],
  };

  const nothing = async () => null;
  const none = async () => 0;

  const prisma = {
    member: { count: none },
    ageTierSetting: {
      count: none,
      // No configured tiers: the gap computation falls back to the four the
      // runtime would price, which keeps this suite about type SCOPE and not
      // about the club's tier subset (that is #2009's own case elsewhere).
      findMany: async () => [],
    },
    season: {
      count: async () => 1,
      findMany: async () => [{ id: "season-1", name: "Winter 2026" }],
    },
    cancellationPolicy: { count: none },
    bookingDefaults: { findUnique: nothing },
    groupDiscountSetting: { findUnique: nothing },
    membershipCancellationSetting: { findUnique: nothing },
    xeroToken: { findFirst: nothing },
    xeroAccountMapping: { count: none },
    xeroItemCodeMapping: { count: none },
    clubIdentitySettings: { findUnique: nothing },
    emailMessageSetting: { findUnique: nothing },
    lodgeSettings: { findUnique: nothing },
    clubTimeSettings: { findUnique: nothing },
    // The public {{hut-fees}} embed opt-in is off, so that half of the snapshot
    // asks nothing further and cannot colour these assertions.
    publicContentSettings: { findUnique: nothing },
    pageContent: { count: none },
    membershipType: {
      findMany: async (args: { where?: unknown }) => {
        state.membershipTypeWheres.push(args?.where);
        // The #2041 soft-check reads the same table for a different question.
        // It is the only other caller and it names the behaviour it wants.
        const where = args?.where as { subscriptionBehavior?: string } | undefined;
        if (where?.subscriptionBehavior) return [];
        return state.membershipTypes.filter((type) => type.isActive);
      },
    },
    membershipTypeSeasonRate: { findMany: async () => state.rateRows },
  };

  return { state, prisma };
});

vi.mock("@/lib/prisma", () => ({ prisma: db.prisma }));
vi.mock("@/config/modules", () => ({
  readClubModuleSettingsRecord: async () => null,
}));
vi.mock("@/lib/environment-role", () => ({
  resolveEnvironmentRole: async () => ({ role: "UNKNOWN" }),
}));
vi.mock("@/lib/environment-safety-withheld", () => ({
  readWithheldApplicationEmail: async () => ({ available: false }),
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getDefaultLodgeCapacity: async () => 20,
}));
vi.mock("@/lib/xero-token-store", () => ({
  getXeroTokenReadability: async () => ({ readable: false }),
}));
vi.mock("@/lib/stripe-config", () => ({
  getStripeSetupState: async () => ({
    secretKeySet: false,
    publishableKeySet: false,
    webhookSecretSet: false,
    needsReentry: false,
  }),
}));

const FULL = {
  id: "type-full",
  name: "Full",
  key: "FULL",
  bookingBehavior: "MEMBER_RATE",
  isActive: true,
  ageGroupsApply: false,
};
const NON_MEMBER = {
  id: "type-non-member",
  name: "Non-Member",
  key: "NON_MEMBER",
  bookingBehavior: "NON_MEMBER_RATE",
  isActive: true,
  ageGroupsApply: false,
};
const ASSOCIATE = {
  id: "type-associate",
  name: "Associate",
  key: "ASSOCIATE",
  bookingBehavior: "NON_MEMBER_RATE",
  isActive: true,
  ageGroupsApply: false,
};
const ADMIN = {
  id: "type-admin",
  name: "Admin",
  key: "ADMIN",
  bookingBehavior: "BLOCK_BOOKING",
  isActive: true,
  ageGroupsApply: false,
};

async function gaps(): Promise<string[]> {
  const { getSetupDatabaseSnapshot } = await import("@/lib/setup-readiness-db");
  const snapshot = await getSetupDatabaseSnapshot();
  return snapshot.membershipTypeRateGaps ?? [];
}

describe("setup readiness sees every rate-bearing type (#2933)", () => {
  beforeEach(() => {
    db.state.membershipTypes = [FULL, NON_MEMBER, ASSOCIATE, ADMIN];
    db.state.rateRows = [];
    db.state.membershipTypeWheres = [];
  });

  it("warns about a season with no Non-Member rates", async () => {
    // Full is priced; the type every non-member guest prices from is not.
    db.state.rateRows = [
      { seasonId: "season-1", membershipTypeId: FULL.id, ageTier: null },
    ];
    expect(await gaps()).toEqual([
      "Non-Member — Winter 2026 (missing flat all-ages rate)",
    ]);
  });

  it("never warns about a type that owes no rates of its own", async () => {
    // Associate prices from the Non-Member rows and Admin does not book at all,
    // so neither may ever appear here — a widened query that dropped the
    // rate-bearing test would report both.
    db.state.rateRows = [
      { seasonId: "season-1", membershipTypeId: FULL.id, ageTier: null },
      { seasonId: "season-1", membershipTypeId: NON_MEMBER.id, ageTier: null },
    ];
    expect(await gaps()).toEqual([]);
  });

  it("skips an archived rate-bearing type, which prices only history", async () => {
    db.state.membershipTypes = [
      FULL,
      NON_MEMBER,
      { ...FULL, id: "type-retired", name: "Retired", key: "RETIRED", isActive: false },
    ];
    db.state.rateRows = [
      { seasonId: "season-1", membershipTypeId: FULL.id, ageTier: null },
      { seasonId: "season-1", membershipTypeId: NON_MEMBER.id, ageTier: null },
    ];
    expect(await gaps()).toEqual([]);
  });

  it("does not narrow the read by booking behaviour", async () => {
    // The shape of the original defect, pinned where a source census cannot
    // reach: the exception lived in a Prisma filter, so leaving it out looked
    // like any other narrow query rather than like a copied rule.
    await gaps();
    for (const where of db.state.membershipTypeWheres) {
      expect(
        (where as { bookingBehavior?: unknown } | undefined)?.bookingBehavior,
        "The membership-type read for rate gaps must not filter by bookingBehavior. Which types owe hut rates is INV-MOD-007 and has one home — selectTypesRequiringHutRates in @/lib/membership-type-rate-coverage. Filtering here is how the built-in NON_MEMBER type went unwarned about until #2933.",
      ).toBeUndefined();
    }
  });
});
