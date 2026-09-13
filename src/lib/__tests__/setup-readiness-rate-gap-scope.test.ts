import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";

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
    seasons: [] as Array<{ id: string; name: string; endDate: Date; active: boolean }>,
    clubTimeZone: null as string | null,
    /** Every `where` the snapshot filtered its membership-type read by. */
    membershipTypeWheres: [] as unknown[],
    /** Every `where` the snapshot filtered its SEASON read by. */
    seasonWheres: [] as unknown[],
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
      findMany: async (args: { where?: unknown }) => {
        state.seasonWheres.push(args?.where);
        /*
          The fake HONOURS the scope clause, so a bound that excludes a season
          the club can still take a booking on loses that season's gaps here —
          which is the behaviour, not a shape assertion about the query.
        */
        const clause = args?.where as
          | { OR?: Array<{ active?: boolean; endDate?: { gte?: Date } }> }
          | undefined;
        const bound = clause?.OR?.find((part) => part.endDate)?.endDate?.gte;
        return state.seasons
          .filter(
            (row) =>
              row.active || bound === undefined || row.endDate >= bound,
          )
          .map((row) => ({ id: row.id, name: row.name }));
      },
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
    // The club's persisted timezone. The real runtime reader resolves the zone
    // through this very delegate, so a case can pin the club's zone here and
    // the snapshot's season bound is derived from it for real.
    clubTimeSettings: {
      findUnique: async () =>
        state.clubTimeZone === null ? null : { timeZone: state.clubTimeZone },
    },
    // The public {{hut-fees}} embed opt-in is off, so that half of the snapshot
    // asks nothing further and cannot colour these assertions.
    publicContentSettings: { findUnique: nothing },
    pageContent: { count: none },
    membershipType: {
      findMany: async (args: { where?: unknown }) => {
        state.membershipTypeWheres.push(args?.where);
        const where = args?.where as
          | {
              isActive?: boolean;
              bookingBehavior?: string;
              subscriptionBehavior?: string;
            }
          | undefined;
        // The #2041 soft-check reads the same table for a different question.
        // It is the only other caller and it names the behaviour it wants.
        if (where?.subscriptionBehavior) return [];
        /*
          The fake HONOURS the filter, which is the whole point of it. A fake
          that ignored `where` would answer a narrowed query with every row and
          the behavioural cases below would pass against the very defect they
          exist to catch — measured, when the mutation proof for this suite
          restored `bookingBehavior: "MEMBER_RATE"` and only the shape
          assertion noticed.
        */
        return state.membershipTypes.filter(
          (type) =>
            (where?.isActive === undefined || type.isActive === where.isActive) &&
            (where?.bookingBehavior === undefined ||
              type.bookingBehavior === where.bookingBehavior),
        );
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

const WINTER_2026 = {
  id: "season-1",
  name: "Winter 2026",
  // The frozen clock puts "today" at 2026-07-01; this season is open.
  endDate: new Date("2026-09-30T00:00:00.000Z"),
  active: true,
};

describe("setup readiness sees every rate-bearing type (#2933)", () => {
  beforeEach(() => {
    db.state.membershipTypes = [FULL, NON_MEMBER, ASSOCIATE, ADMIN];
    db.state.rateRows = [];
    db.state.seasons = [WINTER_2026];
    db.state.clubTimeZone = "Pacific/Auckland";
    db.state.membershipTypeWheres = [];
    db.state.seasonWheres = [];
  });

  // A case that pins its own instant is left alone by the root re-freeze, so it
  // would leak into every case after it. Put the default back by hand.
  afterEach(() => {
    vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
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

  it("skips an archived ordinary rate-bearing type, which prices only history", async () => {
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

  it("still asks about an ARCHIVED Non-Member, which still prices every guest", async () => {
    // The engine resolves the built-in NON_MEMBER by key with no active filter,
    // so archiving it does not stop it pricing — it only hides it from the fee
    // grid, which filters on this same rule. A read narrowed to isActive: true
    // reports nothing here and the club finds out at the first public booking.
    db.state.membershipTypes = [FULL, { ...NON_MEMBER, isActive: false }];
    db.state.rateRows = [
      { seasonId: "season-1", membershipTypeId: FULL.id, ageTier: null },
    ];
    expect(await gaps()).toEqual([
      "Non-Member — Winter 2026 (missing flat all-ages rate)",
    ]);
  });

  /** An inactive season whose last night is 1 July 2026. */
  const ENDS_ON_1_JULY = {
    id: "season-1",
    name: "Winter 2026",
    endDate: new Date("2026-07-01T00:00:00.000Z"),
    active: false,
  };

  it("keeps a season ending on the club's today, as the pricing screen does", async () => {
    /*
      Tonight is still bookable, so a missing rate on this season is still work.
      The Hut Fees screen says so because it compares CALENDAR DATES against the
      club's today; this bound used to be `new Date()`, an INSTANT, against a
      `@db.Date` column holding UTC midnight.

      02:00 UTC on 1 July is 2pm on 1 July in Auckland — the club's today is the
      season's last day, and the instant is already past that column's midnight.
      So the raw-instant bound dropped the season out of the snapshot while the
      screen kept it, and three published sentences said the two surfaces could
      not disagree.
    */
    vi.setSystemTime(new Date("2026-07-01T02:00:00.000Z"));
    db.state.seasons = [ENDS_ON_1_JULY];
    db.state.rateRows = [
      { seasonId: "season-1", membershipTypeId: FULL.id, ageTier: null },
    ];
    expect(await gaps()).toEqual([
      "Non-Member — Winter 2026 (missing flat all-ages rate)",
    ]);
  });

  it("asks what day it is at the CLUB, not on the host", async () => {
    // Same instant-shaped trap from the other side. 13:00 UTC on 1 July is
    // already 2 July in Auckland, so the season above has ended and its gaps
    // are nothing an officer can act on. A host-clock or UTC reading would
    // still call it today and report them.
    vi.setSystemTime(new Date("2026-07-01T13:00:00.000Z"));
    db.state.seasons = [ENDS_ON_1_JULY];
    expect(await gaps()).toEqual([]);
  });

  it("falls back to the four tiers the runtime prices when none are configured", async () => {
    /*
      A club that has not configured its age tiers still prices, from the four
      bookable tiers the runtime falls back to — so an age-keyed type with no
      rows owes all four and the checklist must say so.

      The fallback is a caller-side `?:` in the snapshot, and the coverage rule
      takes no default of its own: handed an EMPTY tier list it finds nothing
      missing and every age-keyed gap disappears in silence. This is the case
      that notices.
    */
    db.state.membershipTypes = [
      { ...FULL, ageGroupsApply: true },
      { ...NON_MEMBER, ageGroupsApply: true },
    ];
    db.state.rateRows = [
      { seasonId: "season-1", membershipTypeId: NON_MEMBER.id, ageTier: null },
    ];
    expect(await gaps()).toEqual([
      "Full — Winter 2026 (missing INFANT, CHILD, YOUTH, ADULT)",
    ]);
  });

  it("leaves a season that ended before the club's today alone", async () => {
    db.state.seasons = [
      {
        id: "season-1",
        name: "Winter 2025",
        endDate: new Date("2025-09-30T00:00:00.000Z"),
        active: false,
      },
    ];
    expect(await gaps()).toEqual([]);
  });

  it("does not narrow the rate-gap read by activity either", async () => {
    // Which types owe rates is INV-MOD-007 and the predicate owns every case of
    // it, including the archived key-resolved holders above. A `where` here can
    // only take a case away before the predicate sees it.
    await gaps();
    const rateGapWheres = db.state.membershipTypeWheres.filter(
      (where) =>
        (where as { subscriptionBehavior?: unknown } | undefined)
          ?.subscriptionBehavior === undefined,
    );
    expect(rateGapWheres.length).toBeGreaterThan(0);
    for (const where of rateGapWheres) {
      expect(
        (where as { isActive?: unknown } | undefined)?.isActive,
        "The membership-type read for rate gaps must not filter by isActive. An archived NON_MEMBER or FULL is still resolved by key and still prices; requiresHutRates in @/lib/membership-type-rate-coverage is what decides.",
      ).toBeUndefined();
    }
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
