// #3040 (epic #2943) — the kiosk guest-list ROUTE, end to end, once per tier.
//
// ENFORCES INV-PRIV-016 (docs/invariants/analytics-and-privacy.md).
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
    booking: { findMany: vi.fn(), count: vi.fn() },
    groupBooking: { findMany: vi.fn() },
    hostingCoverageReevaluation: { findMany: vi.fn() },
    hostingCoverageIncident: { findMany: vi.fn() },
  },
  tier: "staying-guest",
  /** `GroupBooking.coverageInvalidationRevision` for TRIP, as stored now. */
  tripRevision: 3,
}));
const mockPrisma = harness.prisma;
vi.mock("@/lib/prisma", () => ({ prisma: harness.prisma }));
// The club's today for the policy re-queue cohort (#5239): the frozen test day.
vi.mock("@/lib/club-time/server", () => ({
  clubTodayDateOnlyInstant: async () => new Date("2026-07-01T00:00:00.000Z"),
}));
vi.mock("@/lib/lodge-auth", () => ({
  checkLodgeAuth: async () => ({ tier: harness.tier }),
  resolveKioskLodgeId: async () => "lodge-a",
  kioskLodgeAuthErrorResponse: () => null,
  // #3029: the day list asks who the actor is for the dietary grant.
  getLodgeAuthActorMemberId: () => "actor-1",
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

/** The same club, ENFORCED: the only mode whose re-check queue is verified. */
const ENFORCED_POLICY = { ...SCOPE_ON_POLICY, mode: "ENFORCED" };

/**
 * A snapshot whose covered night rests on a Group Trip sibling, as the writer
 * persists it: stamped with the trip and the trip's cover-invalidation revision
 * read under the trip key (`null` = a snapshot written before the stamp existed).
 */
function siblingCoveredReview(
  revision: number | null,
  nights: { first: "SAME_GROUP_TRIP" | null } = { first: "SAME_GROUP_TRIP" },
) {
  const firstCovered = nights.first !== null;
  return {
    ...HOSTING_VIOLATION,
    requirements: {
      ...HOSTING_VIOLATION.requirements,
      uncoveredNonMemberGuestNights: firstCovered ? 1 : 2,
      uncovered: [
        ...(firstCovered ? [] : [{ night: DAY, guestRef: "g1", guestName: "Gwen" }]),
        { night: "2026-08-02", guestRef: "g1", guestName: "Gwen" },
      ],
      qualifyingHostsByNight: [
        firstCovered
          ? { night: DAY, memberIds: ["adult-secret"], coveredByScopes: ["SAME_GROUP_TRIP"] }
          : { night: DAY, memberIds: [], coveredByScopes: [] },
        { night: "2026-08-02", memberIds: [], coveredByScopes: [] },
      ],
    },
    ...(revision === null
      ? {}
      : { groupTripCoverFreshness: { groupBookingId: TRIP, revision } }),
  };
}

/** What a hut leader sees for `siblingCoveredReview` once it is verified. */
const SIBLING_FIGURES = {
  status: "EVALUATED",
  nights: [
    { night: DAY, covered: true, scopes: ["SAME_GROUP_TRIP"] },
    { night: "2026-08-02", covered: false, scopes: [] },
  ],
  scopes: ["SAME_GROUP_TRIP"],
  decision: null,
};

const STALE = { status: "STALE", nights: [], scopes: [] };

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
        throw new Error("INV-PRIV-016: the kiosk route selected joinCode");
      }
      return [
        {
          id: TRIP,
          joinCode: JOIN_CODE,
          organiserMember: { firstName: "Olivia", lastName: "Organiser" },
          coverageInvalidationRevision: harness.tripRevision,
        },
      ];
    },
  );
  mockPrisma.hostingCoverageReevaluation.findMany.mockResolvedValue([]);
  mockPrisma.hostingCoverageIncident.findMany.mockResolvedValue([]);
  // The trip's dependent population around each card: the other card only.
  mockPrisma.booking.count.mockResolvedValue(1);
  harness.tripRevision = 3;
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
        `INV-PRIV-016 (docs/invariants/analytics-and-privacy.md): the ordinary ` +
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
      "INV-PRIV-016: even the privileged tier gets the cover SOURCE CATEGORY, " +
        "never the covering member's identity",
    ).not.toContain("adult-secret");
  });

  it("withholds sibling cover while the sibling's change is still queued for re-checking", async () => {
    // THE STALENESS CLASS THIS EPIC ITSELF INTRODUCES. A change to a sibling in
    // ANOTHER account owes this card a re-check (#3039's fan-out queues it under
    // THIS card's owner), and until the drain has run the recorded answer is
    // behind the facts.
    harness.tier = "admin";
    mockPrisma.adultMemberHostingPolicy.findMany.mockResolvedValue([
      ENFORCED_POLICY,
    ]);
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b-organiser", organiser, {
        adultMemberHostingReview: siblingCoveredReview(3),
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
        "resting on a sibling booking with a re-check still queued is not shown " +
        "as cover",
    ).toEqual({ status: "STALE", nights: [], scopes: [] });
    expect(
      JSON.stringify(body),
      "INV-PRIV-016: a withheld cover claim carries no scope either",
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
      "INV-PRIV-016: the two privileged lines belong to the Group Trip surface " +
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
      "INV-PRIV-016 (docs/invariants/analytics-and-privacy.md): owner decision " +
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

// #5239: #3039's fan-out shipped, so sibling cover is shown once it can be
// verified as current, and withheld whenever it cannot. Each scenario walks a
// real history: the state while the re-check is owed, then the state after it
// has run. The second half is what keeps the first from passing vacuously — a
// kiosk that still withheld every sibling claim would fail every recovery.
describe("#5239 Group Trip sibling cover on the kiosk (INV-HOST-045)", () => {
  function day(review: unknown, overrides: Record<string, unknown> = {}) {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking("b-organiser", organiser, {
        adultMemberHostingReview: review,
        ...overrides,
      }),
      booking("b-joiner", joiner),
    ]);
  }
  const queuedFor = (owner: string) =>
    mockPrisma.hostingCoverageReevaluation.findMany.mockResolvedValue([
      { memberId: owner },
    ]);
  const drained = () =>
    mockPrisma.hostingCoverageReevaluation.findMany.mockResolvedValue([]);

  beforeEach(() => {
    harness.tier = "hut-leader";
    mockPrisma.adultMemberHostingPolicy.findMany.mockResolvedValue([
      ENFORCED_POLICY,
    ]);
  });

  it("shows real figures for a night a sibling covers, once verified current", async () => {
    day(siblingCoveredReview(3));
    const body = await callRoute();
    expect(
      body.bookings[0].adultCoverSource,
      "INV-HOST-045: verified sibling cover is shown as N of M nights covered",
    ).toEqual(SIBLING_FIGURES);
    const payload = JSON.stringify(body);
    expect(payload, "INV-PRIV-016: the freshness stamp never ships").not.toContain(TRIP);
    expect(payload).not.toContain("groupTripCoverFreshness");
    expect(payload).not.toContain("adult-secret");
  });

  it("withholds while a sibling's edit is queued, then shows the re-checked figures", async () => {
    day(siblingCoveredReview(3));
    queuedFor("owner-of-b-organiser");
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(STALE);

    drained();
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(
      SIBLING_FIGURES,
    );
  });

  it("withholds while a sibling's cancellation is queued, then shows the night as uncovered", async () => {
    day(siblingCoveredReview(3));
    queuedFor("owner-of-b-organiser");
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(STALE);

    // The drain re-evaluated: the cancelled sibling no longer covers DAY.
    drained();
    day(siblingCoveredReview(3, { first: null }), {
      adultMemberHostingReviewStatus: "PENDING",
    });
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual({
      status: "EVALUATED",
      nights: [
        { night: DAY, covered: false, scopes: [] },
        { night: "2026-08-02", covered: false, scopes: [] },
      ],
      scopes: [],
      decision: "PENDING",
    });
  });

  it("withholds under review-only mode, and shows again once ENFORCED is re-checked", async () => {
    // Review-only lodges keep the warning: their confirming and membership
    // seams queue nothing, so a matching stamp proves nothing there.
    day(siblingCoveredReview(3));
    mockPrisma.adultMemberHostingPolicy.findMany.mockResolvedValue([
      SCOPE_ON_POLICY,
    ]);
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(STALE);

    // Back to ENFORCED: policy reconciliation queues every affected booking.
    mockPrisma.adultMemberHostingPolicy.findMany.mockResolvedValue([
      ENFORCED_POLICY,
    ]);
    queuedFor("owner-of-b-organiser");
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(STALE);

    drained();
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(
      SIBLING_FIGURES,
    );
  });

  it("withholds sibling cover while the Group Trip scope is off, and shows it once back on and re-checked", async () => {
    day(siblingCoveredReview(3));
    mockPrisma.adultMemberHostingPolicy.findMany.mockResolvedValue([
      { ...ENFORCED_POLICY, hostScopeSameGroupTrip: false },
    ]);
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(STALE);
    // The scope only gates SIBLING claims: a same-booking snapshot still shows.
    expect((await callRoute()).bookings[1].adultCoverSource).toMatchObject({
      status: "EVALUATED",
    });

    mockPrisma.adultMemberHostingPolicy.findMany.mockResolvedValue([
      ENFORCED_POLICY,
    ]);
    queuedFor("owner-of-b-organiser");
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(STALE);
    drained();
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(
      SIBLING_FIGURES,
    );
  });

  it("keeps withholding after a truncated fan-out even once the trip has shrunk, until re-checked", async () => {
    // A fan-out hit the ceiling and bumped the trip's revision; the trip has
    // since shrunk, so its present size proves nothing about who was missed.
    day(siblingCoveredReview(3));
    harness.tripRevision = 4;
    mockPrisma.booking.count.mockResolvedValue(1);
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(STALE);

    // A canonical re-evaluation stamped the new revision.
    day(siblingCoveredReview(4));
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(
      SIBLING_FIGURES,
    );
  });

  it("withholds while the trip is at the fan-out ceiling, whatever the stamp says", async () => {
    day(siblingCoveredReview(3));
    mockPrisma.booking.count.mockResolvedValue(100);
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(STALE);
  });

  it("withholds a snapshot written before the freshness stamp existed", async () => {
    day(siblingCoveredReview(null));
    expect((await callRoute()).bookings[0].adultCoverSource).toEqual(STALE);
  });
});
