import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Role } from "@prisma/client";
import {
  assertOtherLodgeExists,
  OTHER_LODGE_RATE_ADMIN_ONLY_MESSAGE,
  OTHER_LODGE_RATE_GUEST_NOT_ON_BOOKING_MESSAGE,
  OTHER_LODGE_RATE_LODGE_NOT_FOUND_MESSAGE,
  OTHER_LODGE_RATE_LODGE_REQUIRED_MESSAGE,
  OTHER_LODGE_RATE_INELIGIBLE_GUEST_MESSAGE,
  resolveOtherLodgeRateElection,
  type OtherLodgeRateBooking,
} from "@/lib/booking-other-lodge-rate";
import {
  priceBookingGuestsWithMembershipTypePolicy,
  resolveGuestRateMembershipTypes,
} from "@/lib/membership-type-policy";

/**
 * The reciprocal "other club member" rate (Other Lodges epic).
 *
 * Two halves are tested here because they are the two halves that can silently
 * disagree: the ELECTION (who is ticked, and who must therefore be repriced) and
 * the RATE RESOLUTION (what a ticked guest is actually priced from).
 */

const ADMIN = "ADMIN" as Role;
const MEMBER = "MEMBER" as Role;

function makeBooking(
  overrides: Partial<OtherLodgeRateBooking> = {},
): OtherLodgeRateBooking {
  return {
    otherLodgeId: null,
    guests: [
      { id: "guest-nonmember", isMember: false, otherLodgeMember: false },
      { id: "guest-member", isMember: true, otherLodgeMember: false },
    ],
    ...overrides,
  };
}

/**
 * The resolver under test, with eligibility defaulted to "every non-member on
 * this booking" - which is exactly the set the pre-#2978 fence hard-coded. Every
 * pre-existing case therefore keeps its original meaning, and the cases that
 * exercise the WIDENED rule pass their own set explicitly.
 */
function elect(args: {
  booking: OtherLodgeRateBooking;
  input: Parameters<typeof resolveOtherLodgeRateElection>[0]["input"];
  role: Role;
  eligibleGuestIds?: ReadonlySet<string>;
}) {
  return resolveOtherLodgeRateElection({
    ...args,
    eligibleGuestIds:
      args.eligibleGuestIds ??
      new Set(
        args.booking.guests.filter((guest) => !guest.isMember).map((guest) => guest.id),
      ),
  });
}

describe("resolveOtherLodgeRateElection", () => {
  it("is inert when the request says nothing about the rate, and reports the stored state", () => {
    const election = elect({
      booking: makeBooking({
        otherLodgeId: "lodge-1",
        guests: [
          { id: "guest-a", isMember: false, otherLodgeMember: true },
          { id: "guest-b", isMember: false, otherLodgeMember: false },
        ],
      }),
      input: {},
      // A member's own edit reaches this path on every ordinary save, so an
      // inert election must NOT trip the admin gate.
      role: MEMBER,
    });

    expect(election.requested).toBe(false);
    expect(election.otherLodgeId).toBe("lodge-1");
    expect([...election.flaggedGuestIds]).toEqual(["guest-a"]);
    // Nothing to reprice: an unrelated edit must never disturb a settled stay.
    expect(election.repriceGuestIds.size).toBe(0);
  });

  it("refuses a non-admin actor who does carry an election", () => {
    expect(() =>
      elect({
        booking: makeBooking(),
        input: { otherLodgeId: "lodge-1", otherLodgeMemberGuestIds: ["guest-nonmember"] },
        role: MEMBER,
      }),
    ).toThrowError(
      expect.objectContaining({
        message: OTHER_LODGE_RATE_ADMIN_ONLY_MESSAGE,
        status: 403,
      }),
    );
  });

  it("refuses a tick naming a guest who is not on this booking", () => {
    expect(() =>
      elect({
        booking: makeBooking(),
        input: { otherLodgeId: "lodge-1", otherLodgeMemberGuestIds: ["guest-elsewhere"] },
        role: ADMIN,
      }),
    ).toThrowError(
      expect.objectContaining({
        message: OTHER_LODGE_RATE_GUEST_NOT_ON_BOOKING_MESSAGE,
        status: 400,
      }),
    );
  });

  it("refuses a tick on somebody already priced at this club's member rate", () => {
    expect(() =>
      elect({
        booking: makeBooking(),
        input: { otherLodgeId: "lodge-1", otherLodgeMemberGuestIds: ["guest-member"] },
        role: ADMIN,
      }),
    ).toThrowError(
      expect.objectContaining({
        message: OTHER_LODGE_RATE_INELIGIBLE_GUEST_MESSAGE,
        status: 400,
      }),
    );
  });

  /**
   * #2978. The fence is the server's eligibility set, not `isMember`, so a
   * member-flagged guest who prices at the non-member rate is accepted here -
   * the case the old fence refused and the screen therefore never offered.
   */
  it("accepts a tick on a member-flagged guest the eligibility set includes", () => {
    const election = elect({
      booking: makeBooking(),
      input: { otherLodgeId: "lodge-1", otherLodgeMemberGuestIds: ["guest-member"] },
      role: ADMIN,
      eligibleGuestIds: new Set(["guest-nonmember", "guest-member"]),
    });

    expect([...election.flaggedGuestIds]).toEqual(["guest-member"]);
    // And they are repriced, because their stored flag changed.
    expect([...election.repriceGuestIds]).toEqual(["guest-member"]);
  });

  it("refuses a tick on anybody the eligibility set leaves out, member or not", () => {
    // The set is the whole rule: a NON-member the server withheld is refused
    // just as firmly as a member. That is what stops a stale screen - or a
    // hand-made request - from re-rating somebody the server judged ineligible.
    expect(() =>
      elect({
        booking: makeBooking(),
        input: {
          otherLodgeId: "lodge-1",
          otherLodgeMemberGuestIds: ["guest-nonmember"],
        },
        role: ADMIN,
        eligibleGuestIds: new Set<string>(),
      }),
    ).toThrowError(
      expect.objectContaining({
        message: OTHER_LODGE_RATE_INELIGIBLE_GUEST_MESSAGE,
        status: 400,
      }),
    );
  });

  /**
   * #2978 review: NAME the person. On a six-guest booking "that guest cannot be
   * priced…" leaves an officer unticking boxes one at a time to find out who,
   * and the refusal is only ever read by an officer — the admin-only 403 is
   * raised before it.
   */
  it("names the guest the refusal is about", () => {
    expect(() =>
      elect({
        booking: makeBooking({
          guests: [
            {
              id: "guest-lapsed",
              isMember: true,
              otherLodgeMember: false,
              firstName: "Ada",
              lastName: "Lovelace",
            },
          ],
        }),
        input: {
          otherLodgeId: "lodge-1",
          otherLodgeMemberGuestIds: ["guest-lapsed"],
        },
        role: ADMIN,
        eligibleGuestIds: new Set<string>(),
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("Ada Lovelace cannot be priced"),
        status: 400,
      }),
    );
  });

  it("does not disclose WHICH of the two reasons applies", () => {
    // Both reasons stay behind one "or". Which one it is would be the difference
    // between "they are a member" and "their subscription is unpaid", and the
    // sentence has no business asserting the second about a named person.
    let message = "";
    try {
      elect({
        booking: makeBooking({
          guests: [
            {
              id: "guest-lapsed",
              isMember: true,
              otherLodgeMember: false,
              firstName: "Ada",
              lastName: "Lovelace",
            },
          ],
        }),
        input: {
          otherLodgeId: "lodge-1",
          otherLodgeMemberGuestIds: ["guest-lapsed"],
        },
        role: ADMIN,
        eligibleGuestIds: new Set<string>(),
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(" or ");
    expect(message).toContain("owes this club a subscription");
    expect(message).toContain("already on this club's member rate");
  });

  it("falls back to the un-named sentence when the row carries no name", () => {
    expect(() =>
      elect({
        booking: makeBooking(),
        input: { otherLodgeId: "lodge-1", otherLodgeMemberGuestIds: ["guest-member"] },
        role: ADMIN,
      }),
    ).toThrowError(
      expect.objectContaining({
        message: OTHER_LODGE_RATE_INELIGIBLE_GUEST_MESSAGE,
        status: 400,
      }),
    );
    expect(OTHER_LODGE_RATE_INELIGIBLE_GUEST_MESSAGE).toContain("That guest");
  });

  it("refuses ticks with no lodge behind them", () => {
    expect(() =>
      elect({
        booking: makeBooking(),
        input: { otherLodgeId: null, otherLodgeMemberGuestIds: ["guest-nonmember"] },
        role: ADMIN,
      }),
    ).toThrowError(
      expect.objectContaining({
        message: OTHER_LODGE_RATE_LODGE_REQUIRED_MESSAGE,
        status: 400,
      }),
    );
  });

  it("reprices a guest the officer has just ticked", () => {
    const election = elect({
      booking: makeBooking(),
      input: { otherLodgeId: "lodge-1", otherLodgeMemberGuestIds: ["guest-nonmember"] },
      role: ADMIN,
    });

    expect(election.requested).toBe(true);
    expect(election.otherLodgeId).toBe("lodge-1");
    expect(election.otherLodgeIdChanged).toBe(true);
    expect([...election.flaggedGuestIds]).toEqual(["guest-nonmember"]);
    expect([...election.repriceGuestIds]).toEqual(["guest-nonmember"]);
  });

  it("reprices a guest the officer has just UNticked — the direction a delta would miss", () => {
    const election = elect({
      booking: makeBooking({
        otherLodgeId: "lodge-1",
        guests: [{ id: "guest-a", isMember: false, otherLodgeMember: true }],
      }),
      // Present but empty: the end state is "nobody", which is how unticking
      // travels. A delta-shaped payload could not express this at all.
      input: { otherLodgeId: "lodge-1", otherLodgeMemberGuestIds: [] },
      role: ADMIN,
    });

    expect(election.flaggedGuestIds.size).toBe(0);
    expect([...election.repriceGuestIds]).toEqual(["guest-a"]);
    expect(election.otherLodgeIdChanged).toBe(false);
  });

  it("clearing the lodge unticks everybody, and reprices them", () => {
    const election = elect({
      booking: makeBooking({
        otherLodgeId: "lodge-1",
        guests: [
          { id: "guest-a", isMember: false, otherLodgeMember: true },
          { id: "guest-b", isMember: false, otherLodgeMember: true },
        ],
      }),
      input: { otherLodgeId: null, otherLodgeMemberGuestIds: [] },
      role: ADMIN,
    });

    expect(election.otherLodgeId).toBeNull();
    expect(election.otherLodgeIdChanged).toBe(true);
    expect(election.flaggedGuestIds.size).toBe(0);
    expect([...election.repriceGuestIds].sort()).toEqual(["guest-a", "guest-b"]);
  });

  it("reprices nobody when the election is re-sent unchanged", () => {
    // The panel sends the fields only when they differ, but a client that
    // re-asserts the stored election must still be a no-op: repricing here would
    // re-rate settled guests at today's season rates on an unrelated save.
    const election = elect({
      booking: makeBooking({
        otherLodgeId: "lodge-1",
        guests: [{ id: "guest-a", isMember: false, otherLodgeMember: true }],
      }),
      input: { otherLodgeId: "lodge-1", otherLodgeMemberGuestIds: ["guest-a"] },
      role: ADMIN,
    });

    expect(election.requested).toBe(true);
    expect(election.otherLodgeIdChanged).toBe(false);
    expect(election.repriceGuestIds.size).toBe(0);
  });
});

describe("assertOtherLodgeExists", () => {
  it("refuses a lodge id that names nothing, rather than letting the FK fail", async () => {
    const db = { otherLodge: { findUnique: vi.fn(async () => null) } };
    await expect(
      assertOtherLodgeExists(db as never, "lodge-gone"),
    ).rejects.toThrowError(
      expect.objectContaining({
        message: OTHER_LODGE_RATE_LODGE_NOT_FOUND_MESSAGE,
        status: 400,
      }),
    );
  });

  it("reads nothing when no lodge is named", async () => {
    const findUnique = vi.fn(async () => null);
    await expect(
      assertOtherLodgeExists({ otherLodge: { findUnique } } as never, null),
    ).resolves.toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

// --- Rate resolution -------------------------------------------------------

const fullType = { id: "type-full", key: "FULL" };
const nonMemberType = { id: "type-nonmember", key: "NON_MEMBER" };

function makeRateDb() {
  return {
    member: { findMany: vi.fn(async () => []) },
    seasonalMembershipAssignment: { findMany: vi.fn(async () => []) },
    membershipType: {
      findMany: vi.fn(async (args: { where: { key: { in: string[] } } }) =>
        [fullType, nonMemberType].filter((type) =>
          args.where.key.in.includes(type.key),
        ),
      ),
    },
  };
}

// FULL is the club's own member rate; NON_MEMBER is what a visitor pays.
const seasonRates = [
  {
    seasonId: "season-2026",
    startDate: new Date("2026-04-01T00:00:00.000Z"),
    endDate: new Date("2026-10-31T00:00:00.000Z"),
    rates: [
      { membershipTypeId: "type-full", ageTier: "ADULT" as const, pricePerNightCents: 1000 },
      { membershipTypeId: "type-nonmember", ageTier: "ADULT" as const, pricePerNightCents: 2400 },
      { membershipTypeId: "type-full", ageTier: "CHILD" as const, pricePerNightCents: 500 },
      { membershipTypeId: "type-nonmember", ageTier: "CHILD" as const, pricePerNightCents: 1200 },
    ],
  },
];

describe("resolveGuestRateMembershipTypes — other-lodge members", () => {
  it("prices a ticked non-member from the FULL member rows", async () => {
    const rated = await resolveGuestRateMembershipTypes(makeRateDb(), {
      seasonYear: 2026,
      guests: [
        { isMember: false, memberId: null, otherLodgeMember: true },
        { isMember: false, memberId: null, otherLodgeMember: false },
      ],
    });

    expect(rated[0]).toMatchObject({
      rateMembershipTypeId: "type-full",
      rateSource: "OTHER_LODGE_MEMBER",
    });
    // The untickled guest beside them is untouched — the flag is per person.
    expect(rated[1]).toMatchObject({
      rateMembershipTypeId: "type-nonmember",
      rateSource: "NON_MEMBER_DEFAULT",
    });
  });

  it("leaves a guest with no flag exactly as it was before the field existed", async () => {
    const rated = await resolveGuestRateMembershipTypes(makeRateDb(), {
      seasonYear: 2026,
      guests: [{ isMember: false, memberId: null }],
    });

    expect(rated[0]).toMatchObject({
      rateMembershipTypeId: "type-nonmember",
      rateSource: "NON_MEMBER_DEFAULT",
    });
  });

  it("never lets the flag override a MEMBER of this club", async () => {
    // The API boundary refuses this combination; the resolver is the second
    // fence, so a row that somehow carries both still resolves through the
    // member's own membership type rather than the other-lodge branch.
    const rated = await resolveGuestRateMembershipTypes(makeRateDb(), {
      seasonYear: 2026,
      guests: [{ isMember: true, memberId: "member-1", otherLodgeMember: true }],
    });

    expect(rated[0].rateSource).not.toBe("OTHER_LODGE_MEMBER");
    expect(rated[0]).toMatchObject({ rateMembershipTypeId: "type-full", rateSource: "OWN_TYPE" });
  });

  it("charges the member rate for the ticked guest's own age tier, end to end", async () => {
    const price = await priceBookingGuestsWithMembershipTypePolicy(makeRateDb(), {
      ownerMemberId: "member-1",
      checkIn: new Date("2026-05-01T00:00:00.000Z"),
      checkOut: new Date("2026-05-03T00:00:00.000Z"),
      guests: [
        // A visiting club's adult and their child, both ticked, plus an
        // ordinary non-member who is not.
        { ageTier: "ADULT", isMember: false, memberId: null, otherLodgeMember: true },
        { ageTier: "CHILD", isMember: false, memberId: null, otherLodgeMember: true },
        { ageTier: "ADULT", isMember: false, memberId: null },
      ],
      seasons: seasonRates,
      seasonYear: 2026,
    });

    // Two nights each: 1000 and 500 at the member rates, 2400 at non-member.
    expect(price.guests.map((guest) => guest.priceCents)).toEqual([2000, 1000, 4800]);
    expect(price.totalPriceCents).toBe(7800);
  });
});

/**
 * Source-shape pins for the two places the eligibility answer is PRODUCED
 * (#2978 review). Neither can be reached by rendering or by calling a function:
 * one is a conditional spread in a server component, the other is the order of
 * two awaits. Both carry a claim in a comment, and a comment is not a guard.
 */
describe("who the booking page tells about eligibility, and in which season", () => {
  const bookingPage = readFileSync(
    "src/app/(authenticated)/bookings/[id]/page.tsx",
    "utf8",
  );

  it("ships the eligible-guest list ONLY inside the admin-gated spread", () => {
    // Shipping it to every viewer would leak subscription standing over the RSC
    // wire: a guest can be missing from the list because that member's
    // subscription is unpaid. React Flight serialises the KEY as well as the
    // value, so the key has to be absent, not merely undefined — which is what
    // makes this a conditional SPREAD and not a conditional value.
    const occurrences =
      bookingPage.match(/otherLodgeRateEligibleGuestIds/g) ?? [];
    expect(occurrences).toHaveLength(1);

    const key = bookingPage.indexOf("otherLodgeRateEligibleGuestIds:");
    const adminGate = bookingPage.lastIndexOf(
      'viewerAuthorizationRole === "ADMIN"',
      key,
    );
    expect(adminGate).toBeGreaterThan(-1);
    // `: {}),` closes the conditional spread this key must sit inside.
    const spreadEnd = bookingPage.indexOf(": {}),", adminGate);
    expect(spreadEnd).toBeGreaterThan(key);
  });

  it("reseeds the financial-year cache BEFORE it derives the season", () => {
    // `getSeasonYear` reads a process-level cache that serves the March default
    // until something seeds it, and nothing on a page render otherwise does.
    // `modify-quote` reseeds before its own `getSeasonYear`, so without this the
    // page and the quote can disagree about the season for a club whose year end
    // is not March — the screen offers a tick the save then refuses.
    const reseed = bookingPage.indexOf("await refreshFinancialYearConfig()");
    const seasonForFence = bookingPage.indexOf(
      "seasonYear: getSeasonYear(booking.checkIn)",
    );
    expect(reseed).toBeGreaterThan(-1);
    expect(seasonForFence).toBeGreaterThan(reseed);
  });
});
