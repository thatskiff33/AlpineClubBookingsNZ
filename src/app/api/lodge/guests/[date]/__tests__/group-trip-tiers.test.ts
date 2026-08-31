// #3040 (epic #2943) — the kiosk guest-list ROUTE, end to end, once per tier.
//
// ENFORCES INV-PRIV-015 (docs/invariants/analytics-and-privacy.md).
//
// The unit suite (`src/lib/__tests__/kiosk-group-trip-privacy.test.ts`) proves
// the tier split in the module that owns it. This suite proves the ROUTE is
// wired to it: that the guest list really derives its capabilities from the
// caller's own kiosk tier rather than from a constant, that it really selects
// canonical Group Trip identity, and that the JSON body an ordinary staying
// guest receives really does not carry the private halves.
//
// A PAYLOAD TEST, deliberately. What is asserted is `await response.json()` —
// the bytes that reach the browser — because the design the issue rejected was
// "send it all and hide the private fields in JSX", which any screen-level test
// would pass.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// `vi.hoisted`, because `vi.mock`'s factory is hoisted above every `const` in
// this file and the route's import graph reaches `@/lib/audit` -> `@/lib/prisma`
// while the mocks are still being resolved.
const harness = vi.hoisted(() => ({
  prisma: {
    adultMemberHostingPolicy: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
    groupBooking: { findMany: vi.fn() },
    hostingCoverageReevaluation: { findMany: vi.fn() },
    hostingCoverageIncident: { findMany: vi.fn() },
  },
  tier: "staying-guest",
}));
const mockPrisma = harness.prisma;
vi.mock("@/lib/prisma", () => ({ prisma: harness.prisma }));
vi.mock("@/lib/lodge-auth", () => ({
  checkLodgeAuth: async () => ({ tier: harness.tier }),
  resolveKioskLodgeId: async () => "lodge-a",
  kioskLodgeAuthErrorResponse: () => null,
}));

import { GET } from "../route";

const utc = (day: string) => new Date(`${day}T00:00:00.000Z`);
const DAY = "2026-08-01";
const TRIP = "group-trip-1";
const JOIN_CODE = "ZZ9TRP";

/** The club-wide policy row with the Group Trip cover option ON. */
const SCOPE_ON_POLICY = {
  id: "policy-club",
  scopeKey: "club-wide",
  lodgeId: null,
  mode: "ADMIN_REVIEW_REQUIRED",
  capacityMode: "NO_HOLD",
  version: 7,
  hostScopeSameBooking: true,
  hostScopeSameBookingOwner: false,
  hostScopeSameGroupTrip: true,
};

function guest(id: string) {
  return {
    id,
    firstName: "Gwen",
    lastName: "Guest",
    ageTier: "ADULT",
    isMember: false,
    memberId: null,
    member: null,
    arrivedAt: null,
    departedAt: null,
    stayStart: utc(DAY),
    stayEnd: utc("2026-08-02"),
    nights: [{ stayDate: utc(DAY) }],
    consentStatus: null,
  };
}

/**
 * A frozen hosting violation in a shape a REAL WRITER CAN PERSIST.
 *
 * The first version of this fixture recorded every night covered with
 * `uncovered: []`, which the canonical evaluator never produces — it returns
 * `null` when nothing is uncovered, and the reconciler then clears the column —
 * and covered them by `SAME_GROUP_TRIP`, a claim the kiosk withholds while
 * #3039's re-evaluation fan-out is unbuilt. Both halves made the route
 * assertions below agree with behaviour the kiosk should not have had.
 *
 * So: one night covered by an adult on this booking, one night uncovered, and
 * the `uncovered` list that goes with it.
 */
const HOSTING_VIOLATION = {
  reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
  policyId: "policy-club",
  policyVersion: 7,
  requirements: {
    kind: "ADULT_MEMBER_HOSTING",
    requiredAdultMemberParticipantsPerGuestNight: 1,
    uncoveredNonMemberGuestNights: 1,
    uncovered: [{ night: "2026-08-02", guestRef: "g1", guestName: "Gwen" }],
    qualifyingHostsByNight: [
      {
        night: DAY,
        memberIds: ["adult-secret"],
        coveredByScopes: ["SAME_BOOKING"],
      },
      { night: "2026-08-02", memberIds: [], coveredByScopes: [] },
    ],
  },
};

function booking(
  id: string,
  identity: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    memberId: `owner-of-${id}`,
    parentBookingId: null,
    status: "CONFIRMED",
    deletedAt: null,
    checkIn: utc(DAY),
    checkOut: utc("2026-08-02"),
    expectedArrivalTime: null,
    adminReviewStatus: null,
    adultMemberHostingReview: HOSTING_VIOLATION,
    adultMemberHostingReviewStatus: null,
    guests: [guest(`${id}-g1`)],
    member: { firstName: "Mel", lastName: "Member" },
    ...identity,
    ...overrides,
  };
}

const organiser = { groupBookingAsOrganiser: { id: TRIP }, groupBookingJoin: null };
const joiner = { groupBookingAsOrganiser: null, groupBookingJoin: { groupBookingId: TRIP } };

async function callRoute() {
  const response = await GET(
    new Request(`http://localhost/api/lodge/guests/${DAY}`) as never,
    { params: Promise.resolve({ date: DAY }) },
  );
  return (await response.json()) as {
    bookings: Array<Record<string, unknown>>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.adultMemberHostingPolicy.findMany.mockResolvedValue([
    SCOPE_ON_POLICY,
  ]);
  mockPrisma.booking.findMany.mockResolvedValue([
    booking("b-organiser", organiser),
    booking("b-joiner", joiner),
  ]);
  mockPrisma.groupBooking.findMany.mockImplementation(
    async (args: { select: Record<string, unknown> }) => {
      if (JSON.stringify(args.select).includes("joinCode")) {
        throw new Error("INV-PRIV-015: the kiosk route selected joinCode");
      }
      return [
        {
          id: TRIP,
          joinCode: JOIN_CODE,
          organiserMember: { firstName: "Olivia", lastName: "Organiser" },
        },
      ];
    },
  );
  mockPrisma.hostingCoverageReevaluation.findMany.mockResolvedValue([]);
  mockPrisma.hostingCoverageIncident.findMany.mockResolvedValue([]);
});

describe("#3040 GET /api/lodge/guests/[date] — Group Trip disclosure by tier", () => {
  it("selects canonical Group Trip identity with the booking", async () => {
    harness.tier = "staying-guest";
    await callRoute();
    const args = mockPrisma.booking.findMany.mock.calls[0][0] as {
      include: Record<string, unknown>;
    };
    expect(args.include).toHaveProperty("groupBookingAsOrganiser");
    expect(args.include).toHaveProperty("groupBookingJoin");
  });

  it("gives an ordinary staying guest the linkage label and NOTHING else", async () => {
    harness.tier = "staying-guest";
    const body = await callRoute();
    expect(body.bookings.map((entry) => entry.groupTrip)).toEqual([
      { label: 1 },
      { label: 1 },
    ]);

    const payload = JSON.stringify(body);
    for (const forbidden of [
      TRIP,
      JOIN_CODE,
      "joinCode",
      "Olivia",
      "groupTripOrganiser",
      "adultCoverSource",
      "SAME_GROUP_TRIP",
      "adult-secret",
    ]) {
      expect(
        payload,
        `INV-PRIV-015 (docs/invariants/analytics-and-privacy.md): the ordinary ` +
          `kiosk tier's JSON body contains "${forbidden}"`,
      ).not.toContain(forbidden);
    }
    // The privileged reads never ran, so there was nothing to leak — and the
    // ordinary tier's own label cost no extra query at all, because the identity
    // relations came back with the booking.
    expect(mockPrisma.groupBooking.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.hostingCoverageIncident.findMany).not.toHaveBeenCalled();
    expect(
      mockPrisma.adultMemberHostingPolicy.findMany,
    ).not.toHaveBeenCalled();
  });

  it("gives the shared LODGE wall device the ordinary tier's disclosure too", async () => {
    harness.tier = "lodge";
    const body = await callRoute();
    for (const entry of body.bookings) {
      expect(entry).not.toHaveProperty("groupTripOrganiser");
      expect(entry).not.toHaveProperty("adultCoverSource");
    }
    expect(JSON.stringify(body)).not.toContain("Olivia");
  });

  it("gives a hut leader the organiser and the cover source, still without a group id or join code", async () => {
    harness.tier = "hut-leader";
    const body = await callRoute();
    expect(body.bookings[0].groupTripOrganiser).toEqual({
      isOrganiser: true,
      organiserName: "Olivia Organiser",
    });
    expect(body.bookings[0].adultCoverSource).toEqual({
      status: "EVALUATED",
      nights: [
        { night: DAY, covered: true, scopes: ["SAME_BOOKING"] },
        { night: "2026-08-02", covered: false, scopes: [] },
      ],
      scopes: ["SAME_BOOKING"],
      decision: null,
    });

    const payload = JSON.stringify(body);
    expect(payload).not.toContain(TRIP);
    expect(payload).not.toContain(JOIN_CODE);
    expect(
      payload,
      "INV-PRIV-015: even the privileged tier gets the cover SOURCE CATEGORY, " +
        "never the covering member's identity",
    ).not.toContain("adult-secret");
  });

  it("withholds a cover claim resting on a Group Trip sibling, and says so plainly", async () => {
    // THE STALENESS CLASS THIS EPIC ITSELF INTRODUCES. Every enqueue site writes
    // the owner of the booking that CHANGED, so a queued re-evaluation caused by
    // a sibling in ANOTHER account names that sibling's owner — and the kiosk's
    // staleness read looks up the visible bookings' own owners. This test used to
    // assert the opposite: it queued a re-evaluation for the organiser's owner
    // and required the joiner's card to keep reporting positive
    // `SAME_GROUP_TRIP` cover. That is the behaviour INV-HOST-045 forbids, and
    // the assertion pinned it as correct.
    harness.tier = "admin";
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b-organiser", organiser, {
        adultMemberHostingReview: {
          ...HOSTING_VIOLATION,
          requirements: {
            ...HOSTING_VIOLATION.requirements,
            qualifyingHostsByNight: [
              {
                night: DAY,
                memberIds: ["adult-secret"],
                coveredByScopes: ["SAME_GROUP_TRIP"],
              },
              { night: "2026-08-02", memberIds: [], coveredByScopes: [] },
            ],
          },
        },
      }),
      booking("b-joiner", joiner),
    ]);
    mockPrisma.hostingCoverageReevaluation.findMany.mockResolvedValue([
      { memberId: "owner-of-b-organiser" },
    ]);
    const body = await callRoute();
    expect(
      body.bookings[0].adultCoverSource,
      "INV-HOST-045 (docs/invariants/adult-member-hosting.md): a cover claim " +
        "resting on a sibling booking cannot be checked for freshness until " +
        "#3039 lands, so it is not shown as cover",
    ).toEqual({ status: "STALE", nights: [], scopes: [] });
    expect(
      JSON.stringify(body),
      "INV-PRIV-015: a withheld cover claim carries no scope either",
    ).not.toContain("SAME_GROUP_TRIP");
  });

  it("shows a hut leader that an officer has APPROVED the recorded exception", async () => {
    // Without it, an approved arrangement and an unapproved violation render
    // identically: the snapshot survives approval, only the status moves.
    harness.tier = "hut-leader";
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b-organiser", organiser, {
        adultMemberHostingReviewStatus: "APPROVED",
      }),
      booking("b-joiner", joiner),
    ]);
    const body = await callRoute();
    expect(body.bookings[0].adultCoverSource).toMatchObject({
      status: "EVALUATED",
      decision: "APPROVED",
    });
    expect(body.bookings[1].adultCoverSource).toMatchObject({
      decision: null,
    });
  });

  it("gives a booking in NO Group Trip neither privileged line", async () => {
    harness.tier = "admin";
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b-organiser", organiser),
      booking("b-joiner", joiner),
      booking("b-alone", {
        groupBookingAsOrganiser: null,
        groupBookingJoin: null,
      }),
    ]);
    const body = await callRoute();
    expect(body.bookings[2]).not.toHaveProperty("groupTrip");
    expect(body.bookings[2]).not.toHaveProperty("groupTripOrganiser");
    expect(
      body.bookings[2],
      "INV-PRIV-015: the two privileged lines belong to the Group Trip surface " +
        "#3040 opened, so a card in no group gets neither",
    ).not.toHaveProperty("adultCoverSource");
  });

  // This test used to assert the route added NOTHING — no chip either — when the
  // club had not enabled Group Trip cover. Owner decision D1 on #3040 overturned
  // that for the chip: group bookings predate the cover scope, so a roster label
  // saying "these guests arrived together" is not conditional on an unrelated
  // supervision setting. The two halves are now pinned separately, because they
  // answer to different facts.
  it("still labels the linkage when the club has not enabled Group Trip cover", async () => {
    harness.tier = "admin";
    mockPrisma.adultMemberHostingPolicy.findMany.mockResolvedValue([
      { ...SCOPE_ON_POLICY, hostScopeSameGroupTrip: false },
    ]);
    const body = await callRoute();
    expect(
      body.bookings.map((entry) => entry.groupTrip),
      "INV-PRIV-015 (docs/invariants/analytics-and-privacy.md): owner decision " +
        "D1 on #3040 — the linkage label follows group membership, not the " +
        "club's shared-cover option",
    ).toEqual([{ label: 1 }, { label: 1 }]);
    // And the scope being off does not withhold the cover line either: it
    // decides whether a SIBLING booking's adult may count, not whether cover is
    // evaluated at all.
    expect(body.bookings[0].adultCoverSource).toMatchObject({
      status: "EVALUATED",
    });
  });

  it("withholds the cover line entirely when the club's hosting requirement is off", async () => {
    harness.tier = "admin";
    mockPrisma.adultMemberHostingPolicy.findMany.mockResolvedValue([
      { ...SCOPE_ON_POLICY, mode: "DISABLED" },
    ]);
    const body = await callRoute();
    for (const entry of body.bookings) {
      expect(entry.groupTrip).toEqual({ label: 1 });
      expect(
        entry,
        "INV-HOST-045 (docs/invariants/adult-member-hosting.md): with the " +
          "adult-member-hosting requirement not in force the canonical " +
          "evaluator writes nothing, so there is no cover to report and the " +
          "key is absent — never a frozen snapshot shown as current cover",
      ).not.toHaveProperty("adultCoverSource");
    }
    expect(JSON.stringify(body)).not.toContain("SAME_GROUP_TRIP");
    expect(
      mockPrisma.hostingCoverageIncident.findMany,
    ).not.toHaveBeenCalled();
    expect(
      mockPrisma.hostingCoverageReevaluation.findMany,
    ).not.toHaveBeenCalled();
  });

  it("never shows a stale evaluation as cover, at any tier", async () => {
    harness.tier = "admin";
    mockPrisma.hostingCoverageReevaluation.findMany.mockResolvedValue([
      { memberId: "owner-of-b-organiser" },
    ]);
    const body = await callRoute();
    expect(body.bookings[0].adultCoverSource).toEqual({
      status: "STALE",
      nights: [],
      scopes: [],
    });
    // And the OTHER owner's card is untouched: the queue signal is routed by
    // owner, so one owner's pending re-evaluation does not blank the day list.
    expect(body.bookings[1].adultCoverSource).toEqual({
      status: "EVALUATED",
      nights: [
        { night: DAY, covered: true, scopes: ["SAME_BOOKING"] },
        { night: "2026-08-02", covered: false, scopes: [] },
      ],
      scopes: ["SAME_BOOKING"],
      decision: null,
    });
  });
});
