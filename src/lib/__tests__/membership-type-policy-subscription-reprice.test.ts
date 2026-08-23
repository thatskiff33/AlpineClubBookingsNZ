import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2543 — the money. An unpaid member's own nights price at the built-in
 * NON_MEMBER rate when, and only when, the club runs `NON_MEMBER_PRICING`.
 *
 * WHY THIS TESTS THE PRICING GATE AND NOT THE FIVE ROUTES. The reprice is applied
 * inside `resolveGuestRateMembershipTypes`, the single function every one of the
 * ~25 places that price a booking already passes through (create, confirm, quote,
 * modify preview, modify apply, guest add/removal, group join, waitlist and
 * cross-lodge promotion, booking and school requests, promo validation). Asserting
 * it here is what makes "consistent across every write path" a structural
 * property rather than a review checklist.
 *
 * Every assertion is in INTEGER CENTS, against the same NON_MEMBER rate row AND the
 * same `NON_MEMBER_DEFAULT` rateSource a real non-member resolves to.
 *
 * THE rateSource IS NOT COSMETIC, and the earlier wording of this header
 * ("the same TYPE_POLICY_FORCED rateSource any other non-member resolves to") was
 * wrong in a way that hid a real overcharge: a real non-member resolves
 * NON_MEMBER_DEFAULT, never TYPE_POLICY_FORCED, and the group discount substitutes
 * its cheaper rate type ONLY for NON_MEMBER_DEFAULT. Labelling the reprice
 * TYPE_POLICY_FORCED therefore charged the repriced member the raw NON_MEMBER rate
 * on every discounted night while the genuine non-member beside them paid the
 * substituted FULL rate. The parity test at the bottom of this file is the pin.
 */

const mocks = vi.hoisted(() => ({
  peekSubscriptionLockoutMode: vi.fn(),
  requiresPaidSubscriptionForBooking: vi.fn(async () => true),
}));

vi.mock("@/lib/member-subscription-eligibility", () => ({
  peekSubscriptionLockoutMode: mocks.peekSubscriptionLockoutMode,
  requiresPaidSubscriptionForBooking: mocks.requiresPaidSubscriptionForBooking,
}));

vi.mock("@/lib/age-tier", () => ({
  getAgeTierSettings: vi.fn(async () => [
    { tier: "CHILD", subscriptionRequiredForBooking: false },
    { tier: "YOUTH", subscriptionRequiredForBooking: true },
    { tier: "ADULT", subscriptionRequiredForBooking: true },
  ]),
}));

import {
  priceBookingGuestsWithMembershipTypePolicy,
  resolveGuestRateMembershipTypes,
  resolveOtherLodgeRateEligibleGuestIds,
} from "@/lib/membership-type-policy";
import { selectPromoDiscountGuests } from "@/lib/policies/pricing";

const MEMBER_RATE_CENTS = 1000;
const NON_MEMBER_RATE_CENTS = 2400;

type TestMembershipType = {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
  subscriptionBehavior: "REQUIRED" | "NOT_REQUIRED" | "BASED_ON_AGE_TIER";
};

const fullType: TestMembershipType = {
  id: "type-full",
  key: "FULL",
  name: "Full",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
};

const nonMemberType: TestMembershipType = {
  id: "type-nonmember",
  key: "NON_MEMBER",
  name: "Non-member",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "NON_MEMBER_RATE",
  subscriptionBehavior: "NOT_REQUIRED",
};

/** Member rates, and a subscription is never required — a LIFE member. */
const lifeType: TestMembershipType = {
  id: "type-life",
  key: "LIFE",
  name: "Life",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "NOT_REQUIRED",
};

const seasonRates = [
  {
    seasonId: "season-2026",
    startDate: new Date("2026-04-01T00:00:00.000Z"),
    endDate: new Date("2026-10-31T00:00:00.000Z"),
    rates: [
      {
        membershipTypeId: "type-full",
        ageTier: "ADULT" as const,
        pricePerNightCents: MEMBER_RATE_CENTS,
      },
      {
        membershipTypeId: "type-nonmember",
        ageTier: "ADULT" as const,
        pricePerNightCents: NON_MEMBER_RATE_CENTS,
      },
    ],
  },
];

type Sub = { memberId: string; status: "PAID" | "NOT_INVOICED" | "NOT_REQUIRED" };

/**
 * A client carrying EVERY delegate the reprice reads. Deliberately complete: the
 * reprice returns an empty set for a client it cannot read from, so a narrow
 * double would make this whole file pass vacuously while the rule did nothing.
 */
function makeDb(options: {
  members: string[];
  subscriptions: Sub[];
  /** The membership type every listed member is assigned; FULL by default. */
  type?: TestMembershipType;
}) {
  const assignedType = options.type ?? fullType;
  const members = options.members.map((id) => ({
    id,
    firstName: "Alex",
    lastName: id,
    email: `${id}@example.test`,
    role: "MEMBER" as const,
    ageTier: "ADULT" as const,
  }));

  return {
    member: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        members.filter((member) => args.where.id.in.includes(member.id)),
      ),
    },
    seasonalMembershipAssignment: {
      findMany: vi.fn(async (args: { where: { memberId: { in: string[] } } }) =>
        options.members
          .filter((id) => args.where.memberId.in.includes(id))
          .map((memberId) => ({
            memberId,
            seasonYear: 2026,
            membershipType: assignedType,
          })),
      ),
    },
    membershipType: {
      findMany: vi.fn(async (args: { where: { key: { in: string[] } } }) =>
        [nonMemberType, fullType, lifeType].filter((type) =>
          args.where.key.in.includes(type.key),
        ),
      ),
    },
    memberSubscription: {
      findMany: vi.fn(async (args: { where: { memberId: { in: string[] } } }) =>
        options.subscriptions.filter((sub) =>
          args.where.memberId.in.includes(sub.memberId),
        ),
      ),
      findFirst: vi.fn(async () => null),
    },
  };
}

/** One paid-up member, one member whose required subscription is unpaid. */
function twoMemberDb() {
  return makeDb({
    members: ["m-paid", "m-unpaid"],
    subscriptions: [{ memberId: "m-paid", status: "PAID" }],
  });
}

const guests = [
  { ageTier: "ADULT" as const, isMember: true, memberId: "m-paid" },
  { ageTier: "ADULT" as const, isMember: true, memberId: "m-unpaid" },
];

const CHECK_IN = new Date("2026-05-01T00:00:00.000Z");
/** Two nights, so a per-night error cannot hide behind a one-night total. */
const CHECK_OUT = new Date("2026-05-03T00:00:00.000Z");
const NIGHTS = 2;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requiresPaidSubscriptionForBooking.mockResolvedValue(true);
});

describe("resolveGuestRateMembershipTypes — the #2543 reprice", () => {
  it("NON_MEMBER_PRICING forces the unpaid member onto the NON_MEMBER type", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    const rated = await resolveGuestRateMembershipTypes(twoMemberDb(), {
      seasonYear: 2026,
      guests,
    });

    expect(rated[0]).toMatchObject({
      memberId: "m-paid",
      rateSource: "OWN_TYPE",
      rateMembershipTypeId: "type-full",
    });
    // The SAME rateSource and the SAME built-in type a REAL non-member gets, so the
    // existing non-member Xero item code is reused verbatim and the group discount
    // treats them identically.
    expect(rated[1]).toMatchObject({
      memberId: "m-unpaid",
      rateSource: "NON_MEMBER_DEFAULT",
      rateMembershipTypeId: "type-nonmember",
    });
  });

  it.each(["HARD_BLOCK", "NO_BLOCK"] as const)(
    "%s leaves pricing byte-identical to pre-#2543",
    async (mode) => {
      mocks.peekSubscriptionLockoutMode.mockResolvedValue(mode);
      const db = twoMemberDb();

      const rated = await resolveGuestRateMembershipTypes(db, {
        seasonYear: 2026,
        guests,
      });

      expect(rated.map((guest) => guest.rateMembershipTypeId)).toEqual([
        "type-full",
        "type-full",
      ]);
      expect(rated.map((guest) => guest.rateSource)).toEqual([
        "OWN_TYPE",
        "OWN_TYPE",
      ]);
      // Not merely the same answer — no subscription read happened at all.
      expect(db.memberSubscription.findMany).not.toHaveBeenCalled();
    },
  );

  it("the reprice overrides the member's own MEMBER_RATE type", async () => {
    // Placed before the type is consulted, deliberately: a member whose type says
    // MEMBER_RATE is exactly the member this rule is about, so reading the type
    // first would leave the rule with no effect on anyone.
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    const rated = await resolveGuestRateMembershipTypes(twoMemberDb(), {
      seasonYear: 2026,
      guests: [guests[1]],
    });

    expect(rated[0].rateMembershipTypeId).toBe("type-nonmember");
  });

  it("a NOT_REQUIRED season row does NOT rescue a REQUIRED membership type (#2041)", async () => {
    // The reprice follows the shared settlement rule rather than re-deriving it:
    // #2041 scopes NOT_REQUIRED-row dominance to BASED_ON_AGE_TIER types, so on a
    // REQUIRED type the row does not dominate and the member is still repriced.
    // This case pins that boundary, because it is the one an author would be
    // tempted to "simplify" into "any NOT_REQUIRED row means exempt".
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    const rated = await resolveGuestRateMembershipTypes(
      makeDb({
        members: ["m-req"],
        subscriptions: [{ memberId: "m-req", status: "NOT_REQUIRED" }],
      }),
      {
        seasonYear: 2026,
        guests: [
          { ageTier: "ADULT" as const, isMember: true, memberId: "m-req" },
        ],
      },
    );

    expect(rated[0].rateSource).toBe("NON_MEMBER_DEFAULT");
  });

  it("does NOT reprice a member whose type never owes a subscription", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    // A LIFE member: member rates, and no subscription is ever required of them.
    // They have no subscription row at all, and must keep member rates.
    const rated = await resolveGuestRateMembershipTypes(
      makeDb({ members: ["m-life"], subscriptions: [], type: lifeType }),
      {
        seasonYear: 2026,
        guests: [
          { ageTier: "ADULT" as const, isMember: true, memberId: "m-life" },
        ],
      },
    );

    expect(rated[0]).toMatchObject({
      rateSource: "OWN_TYPE",
      rateMembershipTypeId: "type-life",
    });
  });

  it("never asks about a row whose isMember snapshot is false", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");
    const db = makeDb({ members: [], subscriptions: [] });

    const rated = await resolveGuestRateMembershipTypes(db, {
      seasonYear: 2026,
      guests: [{ ageTier: "ADULT" as const, isMember: false, memberId: null }],
    });

    expect(rated[0]).toMatchObject({ rateSource: "NON_MEMBER_DEFAULT" });
    expect(db.memberSubscription.findMany).not.toHaveBeenCalled();
  });
});

describe("the price in cents (#2543)", () => {
  it("charges the unpaid member the non-member rate, per night, in integer cents", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    const price = await priceBookingGuestsWithMembershipTypePolicy(
      twoMemberDb(),
      {
        ownerMemberId: "m-paid",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests,
        seasons: seasonRates,
        seasonYear: 2026,
      },
    );

    const expected =
      NIGHTS * MEMBER_RATE_CENTS + NIGHTS * NON_MEMBER_RATE_CENTS;
    expect(price.totalPriceCents).toBe(expected);
    expect(price.totalPriceCents).toBe(6800);
    expect(Number.isInteger(price.totalPriceCents)).toBe(true);
  });

  it.each(["HARD_BLOCK", "NO_BLOCK"] as const)(
    "%s charges both members the member rate, exactly as before #2543",
    async (mode) => {
      mocks.peekSubscriptionLockoutMode.mockResolvedValue(mode);

      const price = await priceBookingGuestsWithMembershipTypePolicy(
        twoMemberDb(),
        {
          ownerMemberId: "m-paid",
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          guests,
          seasons: seasonRates,
          seasonYear: 2026,
        },
      );

      expect(price.totalPriceCents).toBe(2 * NIGHTS * MEMBER_RATE_CENTS);
      expect(price.totalPriceCents).toBe(4000);
    },
  );

  it("the reprice is the whole difference: 1400 cents per night, nothing else", async () => {
    // Guards against the reprice quietly changing anything OTHER than which rate
    // row is read — a second, parallel money computation is exactly the drift
    // #2543 removes.
    const args = {
      ownerMemberId: "m-paid",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guests,
      seasons: seasonRates,
      seasonYear: 2026,
    };

    mocks.peekSubscriptionLockoutMode.mockResolvedValue("HARD_BLOCK");
    const before = await priceBookingGuestsWithMembershipTypePolicy(
      twoMemberDb(),
      args,
    );

    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");
    const after = await priceBookingGuestsWithMembershipTypePolicy(
      twoMemberDb(),
      args,
    );

    expect(after.totalPriceCents - before.totalPriceCents).toBe(
      NIGHTS * (NON_MEMBER_RATE_CENTS - MEMBER_RATE_CENTS),
    );
    expect(after.totalPriceCents - before.totalPriceCents).toBe(2800);
  });
});

describe("the group discount treats a repriced member as a real non-member (#2543)", () => {
  /**
   * THE PINNED OVERCHARGE. With the reprice labelled `TYPE_POLICY_FORCED` this
   * suite failed: the pricing engine substitutes the group discount's cheaper rate
   * type only for `NON_MEMBER_DEFAULT`, so on every night the discount applied the
   * repriced member paid the raw NON_MEMBER rate (2400 c) while the genuine
   * non-member beside them paid the substituted FULL rate (1000 c) — 2.4x the rate
   * the club actually charges non-members on that booking.
   *
   * The discount config is the one the admin route always writes and the read-time
   * fallback always resolves: `rateMembershipTypeId` = the built-in FULL type.
   */
  const groupDiscount = {
    enabled: true,
    minGroupSize: 3,
    summerOnly: false,
    rateMembershipTypeId: "type-full",
  };

  /** A qualifying party: one real non-member, one repriced member, two padding. */
  const partyOfFour = [
    { ageTier: "ADULT" as const, isMember: false, memberId: null },
    { ageTier: "ADULT" as const, isMember: true, memberId: "m-unpaid" },
    { ageTier: "ADULT" as const, isMember: true, memberId: "m-paid" },
    { ageTier: "ADULT" as const, isMember: true, memberId: "m-paid-2" },
  ];

  function fourMemberDb() {
    return makeDb({
      members: ["m-paid", "m-paid-2", "m-unpaid"],
      subscriptions: [
        { memberId: "m-paid", status: "PAID" },
        { memberId: "m-paid-2", status: "PAID" },
      ],
    });
  }

  it("charges the repriced member EXACTLY what the real non-member is charged", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    const price = await priceBookingGuestsWithMembershipTypePolicy(
      fourMemberDb(),
      {
        ownerMemberId: "m-paid",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: partyOfFour,
        seasons: seasonRates,
        groupDiscount,
        seasonYear: 2026,
      },
    );

    const realNonMemberCents = price.guests[0].priceCents;
    const repricedMemberCents = price.guests[1].priceCents;

    expect(repricedMemberCents).toBe(realNonMemberCents);
    // And that shared figure is the DISCOUNTED one, not the raw non-member rate —
    // otherwise the two could agree by the discount silently not applying at all.
    expect(realNonMemberCents).toBe(NIGHTS * MEMBER_RATE_CENTS);
    expect(repricedMemberCents).toBe(2000);
    expect(repricedMemberCents).not.toBe(NIGHTS * NON_MEMBER_RATE_CENTS);
  });

  it("leaves a TYPE_POLICY_FORCED member excluded from the discount, as #1930 decided", async () => {
    // The pre-existing class is untouched by #2543: a membership type the club
    // deliberately configured onto non-member rates keeps paying the raw
    // NON_MEMBER rate on a discounted night. Mode is irrelevant here.
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NO_BLOCK");

    const price = await priceBookingGuestsWithMembershipTypePolicy(
      makeDb({
        members: ["m-forced"],
        subscriptions: [{ memberId: "m-forced", status: "PAID" }],
        type: nonMemberType,
      }),
      {
        ownerMemberId: null,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [
          { ageTier: "ADULT" as const, isMember: false, memberId: null },
          { ageTier: "ADULT" as const, isMember: false, memberId: null },
          { ageTier: "ADULT" as const, isMember: true, memberId: "m-forced" },
        ],
        seasons: seasonRates,
        groupDiscount,
        seasonYear: 2026,
      },
    );

    // The two real non-members are discounted to the FULL rate; the type-forced
    // member is not.
    expect(price.guests[0].priceCents).toBe(NIGHTS * MEMBER_RATE_CENTS);
    expect(price.guests[2].priceCents).toBe(NIGHTS * NON_MEMBER_RATE_CENTS);
  });
});

describe("the mode is taken from the caller when the caller holds one (#2543)", () => {
  it("uses the passed mode and never reads the settings", async () => {
    // The failure this prevents: the route gate branches on NON_MEMBER_PRICING, an
    // admin saves HARD_BLOCK mid-request, the pricing gate peeks the new value and
    // charges the unpaid member MEMBER rates on a booking nothing will now refuse.
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("HARD_BLOCK");

    const rated = await resolveGuestRateMembershipTypes(twoMemberDb(), {
      seasonYear: 2026,
      guests,
      subscriptionLockoutMode: "NON_MEMBER_PRICING",
    });

    expect(rated[1].rateMembershipTypeId).toBe("type-nonmember");
    expect(mocks.peekSubscriptionLockoutMode).not.toHaveBeenCalled();
  });

  it("a passed HARD_BLOCK wins over a stored NON_MEMBER_PRICING", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");

    const rated = await resolveGuestRateMembershipTypes(twoMemberDb(), {
      seasonYear: 2026,
      guests,
      subscriptionLockoutMode: "HARD_BLOCK",
    });

    expect(rated[1].rateMembershipTypeId).toBe("type-full");
    expect(mocks.peekSubscriptionLockoutMode).not.toHaveBeenCalled();
  });

  it("threads the mode through the price helper too", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NO_BLOCK");

    const price = await priceBookingGuestsWithMembershipTypePolicy(
      twoMemberDb(),
      {
        ownerMemberId: "m-paid",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests,
        seasons: seasonRates,
        seasonYear: 2026,
        subscriptionLockoutMode: "NON_MEMBER_PRICING",
      },
    );

    expect(price.totalPriceCents).toBe(
      NIGHTS * MEMBER_RATE_CENTS + NIGHTS * NON_MEMBER_RATE_CENTS,
    );
    expect(mocks.peekSubscriptionLockoutMode).not.toHaveBeenCalled();
  });

  it("a failed mode read now THROWS instead of silently charging member rates", async () => {
    // The old behaviour swallowed this and returned an empty reprice set, i.e.
    // member rates, permanently snapshotted onto the guest row, on a booking the
    // route gate had already waved through. Failing loud is the safe direction for
    // a money decision.
    mocks.peekSubscriptionLockoutMode.mockRejectedValue(
      new Error("pool timeout"),
    );

    await expect(
      resolveGuestRateMembershipTypes(twoMemberDb(), {
        seasonYear: 2026,
        guests,
      }),
    ).rejects.toThrow("pool timeout");
  });
});

describe("membership, not the subscription, gates member-only promotions (#2543)", () => {
  /**
   * A DECIDED behaviour, pinned so it cannot drift either way by accident.
   *
   * A repriced member keeps `isMember = true`, and `selectPromoDiscountGuests`
   * filters `memberGuestsOnly` promotions on that flag — so a repriced member stays
   * eligible for a member-only promo and can therefore pay LESS than the real
   * non-member beside them. That is deliberate: their MEMBERSHIP is intact and in
   * good standing, only the subscription is unpaid, and the owner's rule speaks to
   * RATES rather than to member benefits. A club that wants the promotion withheld
   * too is asking for a different decision, and the change would be to gate this
   * predicate on `rateSource` — which is why the assertion is here rather than left
   * implicit. See docs/DOMAIN_INVARIANTS.md.
   */
  it("keeps a repriced member eligible for a member-only promotion", () => {
    const selected = selectPromoDiscountGuests(
      { type: "PERCENTAGE" as const, percentOff: 20, memberGuestsOnly: true },
      [
        // The repriced member: isMember true, priced on the NON_MEMBER rows.
        { memberId: "m-unpaid", isMember: true, perNightRates: [2400, 2400] },
        // A real non-member: ineligible, as always.
        { memberId: null, isMember: false, perNightRates: [2400, 2400] },
      ],
    );

    expect(selected).toHaveLength(1);
    expect(selected[0].guest.memberId).toBe("m-unpaid");
  });
  /**
   * #2978, and the pair below is deliberately a PAIR: the widened fence has to
   * let the right people through AND keep the lockout class out, and only a type
   * that is `NON_MEMBER_RATE` for booking while `REQUIRED` for subscriptions can
   * tell those two apart. Under the club's ordinary FULL type the lockout guard
   * is never reached, because the MEMBER_RATE test excludes the member first -
   * which is exactly how the first version of this test passed with the guard
   * deleted.
   */
  const associateType: TestMembershipType = {
    id: "type-associate",
    key: "ASSOCIATE",
    name: "Associate",
    isActive: true,
    isBuiltIn: false,
    // Pays non-member rates, and still owes a subscription. This is the only
    // shape where "priced at the non-member rate" and "locked out" can disagree.
    bookingBehavior: "NON_MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
  };

  it("honours an other-lodge tick for a member whose TYPE prices them as a non-member", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");
    // Paid up, so no lockout is in play - the only reason they are on
    // non-member rates is the type their club gave them.
    const db = makeDb({
      members: ["m-associate"],
      subscriptions: [{ memberId: "m-associate", status: "PAID" }],
      type: associateType,
    });

    const rated = await resolveGuestRateMembershipTypes(db, {
      seasonYear: 2026,
      subscriptionLockoutMode: "NON_MEMBER_PRICING",
      guests: [
        {
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m-associate",
          otherLodgeMember: true,
        },
      ],
    });

    // The whole point of #2978: `isMember` is true, and the tick still applies,
    // because what governs is the RATE they are on.
    expect(rated[0]).toMatchObject({
      rateMembershipTypeId: fullType.id,
      rateSource: "OTHER_LODGE_MEMBER",
    });
  });

  /**
   * The other half. A member repriced by #2543 has been put on non-member rates
   * ON PURPOSE, because their subscription is unpaid - so a tick that reached
   * them would hand back the member rate and undo the lockout silently.
   *
   * `rateSource` cannot separate these two: a repriced member and a true
   * non-member are both `NON_MEMBER_DEFAULT`, deliberately, so the group
   * discount treats them alike. `isMember` plus the unpaid set is what does.
   */
  it("never lets an other-lodge tick undo an unpaid-subscription reprice", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");
    // Same type as the case above, so the ONLY difference between the two is the
    // unpaid subscription. That is what makes this a test of the lockout guard
    // rather than of the type rule.
    const db = makeDb({
      members: ["m-associate-unpaid"],
      subscriptions: [],
      type: associateType,
    });

    const rated = await resolveGuestRateMembershipTypes(db, {
      seasonYear: 2026,
      subscriptionLockoutMode: "NON_MEMBER_PRICING",
      guests: [
        {
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m-associate-unpaid",
          otherLodgeMember: true,
        },
      ],
    });

    expect(rated[0].rateSource).not.toBe("OTHER_LODGE_MEMBER");
    expect(rated[0]).toMatchObject({
      rateMembershipTypeId: nonMemberType.id,
      rateSource: "NON_MEMBER_DEFAULT",
    });
  });
});


/**
 * #2978: the single answer to "who may be ticked as an other-lodge member",
 * shared by the edit panel (which rows get a tick box) and both write paths
 * (which ticks are accepted). Tested directly, because a screen and a save that
 * derive this separately is precisely the bug it exists to prevent.
 */
describe("resolveOtherLodgeRateEligibleGuestIds (#2978)", () => {
  const associateType: TestMembershipType = {
    id: "type-associate",
    key: "ASSOCIATE",
    name: "Associate",
    isActive: true,
    isBuiltIn: false,
    bookingBehavior: "NON_MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
  };

  it("costs no query at all when nobody on the booking is a member", async () => {
    const db = makeDb({ members: [], subscriptions: [] });

    const eligible = await resolveOtherLodgeRateEligibleGuestIds(db, {
      seasonYear: 2026,
      guests: [
        { id: "g-1", isMember: false, memberId: null },
        { id: "g-2", isMember: false, memberId: null },
      ],
    });

    expect([...eligible].sort()).toEqual(["g-1", "g-2"]);
    // The ordinary non-member booking is the common case and must not pay for
    // this feature: no policy read, no subscription read.
    expect(db.member.findMany).not.toHaveBeenCalled();
    expect(db.memberSubscription.findMany).not.toHaveBeenCalled();
  });

  /** May not book at all. Not the same thing as "on the non-member rate". */
  const blockedType: TestMembershipType = {
    id: "type-admin",
    key: "ADMIN",
    name: "Admin",
    isActive: true,
    isBuiltIn: true,
    bookingBehavior: "BLOCK_BOOKING",
    subscriptionBehavior: "NOT_REQUIRED",
  };

  it("excludes a member who is already on this club's member rate", async () => {
    const db = makeDb({
      members: ["m-full"],
      subscriptions: [{ memberId: "m-full", status: "PAID" }],
    });

    const eligible = await resolveOtherLodgeRateEligibleGuestIds(db, {
      seasonYear: 2026,
      guests: [{ id: "g-full", isMember: true, memberId: "m-full" }],
    });

    // Nothing to re-rate: they already pay the rate the tick would give them.
    expect(eligible.size).toBe(0);
  });

  it("includes a member whose TYPE prices them at the non-member rate", async () => {
    const db = makeDb({
      members: ["m-associate"],
      subscriptions: [{ memberId: "m-associate", status: "PAID" }],
      type: associateType,
    });

    const eligible = await resolveOtherLodgeRateEligibleGuestIds(db, {
      seasonYear: 2026,
      guests: [{ id: "g-associate", isMember: true, memberId: "m-associate" }],
    });

    expect([...eligible]).toEqual(["g-associate"]);
  });

  /**
   * The fence reads `bookingBehavior === "NON_MEMBER_RATE"`, not
   * `!== "MEMBER_RATE"`. `BLOCK_BOOKING` is the third value and the looser test
   * admitted it — unreachable in production only because
   * `assertMembershipTypeBookingAllowed` refuses such a guest earlier in every
   * pricing path, which is an unrelated guard for a money fence to lean on.
   * Pinned here so the fence keeps meaning what it says.
   */
  it("excludes a member whose type BLOCKS booking, which is not the non-member rate", async () => {
    const db = makeDb({
      members: ["m-blocked"],
      subscriptions: [{ memberId: "m-blocked", status: "PAID" }],
      type: blockedType,
    });

    const eligible = await resolveOtherLodgeRateEligibleGuestIds(db, {
      seasonYear: 2026,
      guests: [{ id: "g-blocked", isMember: true, memberId: "m-blocked" }],
    });

    expect(eligible.size).toBe(0);
  });

  /**
   * Fail-closed when the answer cannot be resolved (#2978 review). Both shapes
   * end at `if (!policy) return false`, which had no test at all: a member whose
   * policy cannot be resolved is REFUSED, never waved through onto the club's
   * member rate.
   */
  it("refuses a member-flagged guest when the client cannot resolve policies at all", async () => {
    // A narrow double, the seam `resolveMembershipTypePoliciesForMembers` uses:
    // no policy for anybody, so no member may be ticked.
    const eligible = await resolveOtherLodgeRateEligibleGuestIds(
      {} as unknown,
      {
        seasonYear: 2026,
        guests: [
          { id: "g-member", isMember: true, memberId: "m-1" },
          // …and the true non-member beside them is still eligible, because that
          // answer needs no database at all.
          { id: "g-visitor", isMember: false, memberId: null },
        ],
      },
    );

    expect([...eligible]).toEqual(["g-visitor"]);
  });

  it("refuses a member-flagged guest whose member record cannot be found", async () => {
    // PAID deliberately, so the subscription guard above cannot be what refuses
    // them: with no member row there is no policy, and `!policy` is the only
    // rule left. Without it a ghost memberId would be handed the club's member
    // rate.
    const db = makeDb({
      members: [],
      subscriptions: [{ memberId: "m-missing", status: "PAID" }],
    });

    const eligible = await resolveOtherLodgeRateEligibleGuestIds(db, {
      seasonYear: 2026,
      guests: [{ id: "g-ghost", isMember: true, memberId: "m-missing" }],
    });

    expect(eligible.size).toBe(0);
  });

  /**
   * OWNER DECISION, 21 Aug 2026: owing a subscription withholds the tick under
   * EVERY lockout mode, and the three cases below are one fixture differing only
   * in the mode. The reasoning is that the debt is the fact that matters and the
   * club's chosen response to it is not — "the lockout exists precisely to chase
   * an unpaid subscription, and a person in that position does still owe this
   * club one". `NO_BLOCK` was considered and deliberately included.
   *
   * Only a type that is `NON_MEMBER_RATE` for booking while `REQUIRED` for
   * subscriptions can tell this rule from the type rule: under the ordinary FULL
   * type the MEMBER_RATE clause excludes the member first, so a test built on it
   * passes with this guard deleted.
   *
   * `HARD_BLOCK` is the SCHEMA DEFAULT, so it is the case that would have shipped
   * broken: eligibility used to consult the mode and return early for anything
   * but `NON_MEMBER_PRICING`, which offered the tick — and the club's own member
   * rate — to an unpaid member in the default configuration.
   */
  it.each(["HARD_BLOCK", "NO_BLOCK", "NON_MEMBER_PRICING"] as const)(
    "withholds the tick from a member who owes a subscription under %s",
    async (mode) => {
      mocks.peekSubscriptionLockoutMode.mockResolvedValue(mode);
      const db = makeDb({
        members: ["m-associate-unpaid"],
        subscriptions: [],
        type: associateType,
      });

      const eligible = await resolveOtherLodgeRateEligibleGuestIds(db, {
        seasonYear: 2026,
        guests: [
          { id: "g-unpaid", isMember: true, memberId: "m-associate-unpaid" },
        ],
      });

      expect(eligible.size).toBe(0);
    },
  );

  it("still includes the true non-members standing beside an excluded member", async () => {
    mocks.peekSubscriptionLockoutMode.mockResolvedValue("NON_MEMBER_PRICING");
    // The excluded member is on the ASSOCIATE shape, NOT the default FULL type.
    // With FULL this assertion held whether or not the subscription guard
    // existed, because MEMBER_RATE excluded them first — so it proved nothing
    // about the rule it was standing next to.
    const db = makeDb({
      members: ["m-unpaid"],
      subscriptions: [],
      type: associateType,
    });

    const eligible = await resolveOtherLodgeRateEligibleGuestIds(db, {
      seasonYear: 2026,
      guests: [
        { id: "g-visitor", isMember: false, memberId: null },
        { id: "g-unpaid", isMember: true, memberId: "m-unpaid" },
      ],
    });

    expect([...eligible]).toEqual(["g-visitor"]);
  });
});
