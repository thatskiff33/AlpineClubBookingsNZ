// #3040 (epic #2943) — the kiosk's Group Trip tier split: linkage for everybody
// staying, organiser and adult-cover source only behind their own explicit
// capability, and the group's join credential nowhere at all.
//
// ENFORCES INV-PRIV-015 (the three-tier kiosk Group Trip disclosure) and
// INV-HOST-045 (kiosk cover-source display is derived from the canonical
// evaluation and never renders stale, failed or unrecorded evaluation as cover).
// Every assertion that carries one of those rules repeats its id in the failure
// message, so whoever trips it is handed the rule rather than having to go and
// find it (#2691).
//
// WHY THESE ARE PAYLOAD TESTS AND NOT RENDER TESTS. The design the issue
// REJECTED was "send the full Group Trip object and hide the private fields in
// JSX". In a React application anything reachable from a client component's
// props is in the browser whether it is rendered or not, so a test that only
// looks at the screen would pass against exactly the shape the issue forbids.
// Every check below therefore asserts on the SERIALIZED payload an ordinary
// viewer receives — `JSON.stringify` of the object the route returns — and the
// leak checks search that string for the forbidden names and values rather than
// asking about a specific key.
//
// WHY A FAKE STORE THAT REALLY APPLIES `where`. The split-pair carve-out (owner
// decision D2 on #3038) is reached through the canonical seam
// `readInheritedSplitPairGroupTrip`, which issues a real query. A double that
// ignored the clauses would make "a booking related only by `parentBookingId`
// inherits nothing" pass as a fact about the fake instead of a fact about the
// rule, so `matchBookingWhere` applies the predicates and THROWS on an operator
// it does not model.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import {
  attachKioskGroupTrip,
  deriveKioskAdultCoverSource,
  KIOSK_SPLIT_PAIR_IDENTITY_LOOKUP_LIMIT,
  type KioskGroupTripBookingRow,
} from "@/lib/kiosk-group-trip";
import {
  kioskGroupTripCapabilities,
  type KioskTier,
} from "@/lib/kiosk-access";

const LODGE = "lodge-a";
const TRIP = "group-trip-1";
const OTHER_TRIP = "group-trip-2";

/** The join credential. It may never appear in a kiosk payload or source file. */
const JOIN_CODE = "ZZ9TRP";

/**
 * A club-wide policy row with the hosting requirement ACTIVE and the Group Trip
 * scope ON, which is what every test below assumes unless it is about the club's
 * settings themselves.
 *
 * Owner decision D1 on #3040: the ordinary linkage badge is NOT behind this
 * option — it appears whenever a club uses group bookings. What the policy still
 * governs is the privileged COVER-SOURCE line, and only through its `mode`: with
 * the requirement not in force there is no evaluation of any booking to report.
 */
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

type StoreBooking = KioskGroupTripBookingRow & {
  status: string;
  deletedAt: Date | null;
};

function bookingRow(overrides: Partial<StoreBooking> = {}): StoreBooking {
  return {
    id: "booking-1",
    memberId: "member-1",
    parentBookingId: null,
    adultMemberHostingReview: null,
    groupBookingAsOrganiser: null,
    groupBookingJoin: null,
    status: "CONFIRMED",
    deletedAt: null,
    ...overrides,
  };
}

const organiserOf = (groupBookingId: string) => ({
  groupBookingAsOrganiser: { id: groupBookingId },
  groupBookingJoin: null,
});
const joinerOf = (groupBookingId: string) => ({
  groupBookingAsOrganiser: null,
  groupBookingJoin: { groupBookingId },
});

/**
 * A frozen hosting violation snapshot in the shape the canonical evaluator
 * writes. Only the fields the kiosk reads are varied; the rest are the real
 * shape so `parseStoredHostingReview` accepts it.
 */
function snapshot(
  qualifyingHostsByNight: unknown,
  uncovered: Array<{ night: string; guestRef: string }> = [],
) {
  return {
    reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
    policyId: "policy-club",
    policyVersion: 7,
    policyName: "Adult member hosting requirement",
    requirements: {
      kind: "ADULT_MEMBER_HOSTING",
      requiredAdultMemberParticipantsPerGuestNight: 1,
      uncoveredNonMemberGuestNights: uncovered.length,
      uncovered: uncovered.map((row) => ({ ...row, guestName: "Guest" })),
      qualifyingHostsByNight,
    },
  };
}

/** Applies exactly the operators `hostingSiblingWhere` uses; throws on others. */
function matchBookingWhere(
  row: StoreBooking,
  where: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR") {
      const clauses = value as Array<Record<string, unknown>>;
      if (!clauses.some((clause) => matchBookingWhere(row, clause))) return false;
      continue;
    }
    if (key === "id" || key === "status") {
      const actual = row[key as "id" | "status"];
      if (value !== null && typeof value === "object") {
        const op = value as Record<string, unknown>;
        if ("not" in op) {
          if (actual === op.not) return false;
          continue;
        }
        if ("notIn" in op) {
          if ((op.notIn as string[]).includes(actual)) return false;
          continue;
        }
        throw new Error(`unmodelled operator on ${key}: ${JSON.stringify(op)}`);
      }
      if (actual !== value) return false;
      continue;
    }
    if (key === "memberId" || key === "parentBookingId") {
      if (typeof value === "object" && value !== null) {
        throw new Error(`unmodelled operator on ${key}`);
      }
      if (row[key] !== value) return false;
      continue;
    }
    if (key === "deletedAt") {
      if (row.deletedAt !== value) return false;
      continue;
    }
    throw new Error(`unmodelled where key: ${key}`);
  }
  return true;
}

interface FakeStore {
  db: Parameters<typeof attachKioskGroupTrip>[2]["db"];
  calls: {
    policyFindMany: number;
    bookingFindMany: number;
    groupBookingFindMany: number;
    reevaluationFindMany: number;
    incidentFindMany: number;
  };
}

function fakeStore(options: {
  bookings?: StoreBooking[];
  groups?: Array<{ id: string; organiser: string }>;
  queuedOwnerIds?: string[];
  openIncidentBookingIds?: string[];
  /**
   * The club's adult-member-hosting policy rows. Active with every scope on
   * unless a test says otherwise. Read ONLY by the cover-source tier.
   */
  policyRows?: Array<Record<string, unknown>>;
} = {}): FakeStore {
  const bookings = options.bookings ?? [];
  const calls = {
    policyFindMany: 0,
    bookingFindMany: 0,
    groupBookingFindMany: 0,
    reevaluationFindMany: 0,
    incidentFindMany: 0,
  };
  const db = {
    adultMemberHostingPolicy: {
      findMany: async () => {
        calls.policyFindMany += 1;
        return options.policyRows ?? [SCOPE_ON_POLICY];
      },
    },
    lodge: {
      findFirst: async () => {
        throw new Error(
          "the kiosk must pass the resolved lodge, never fall back to the default",
        );
      },
    },
    booking: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        calls.bookingFindMany += 1;
        return bookings
          .filter((row) => matchBookingWhere(row, args.where))
          .map((row) => ({
            id: row.id,
            groupBookingAsOrganiser: row.groupBookingAsOrganiser,
            groupBookingJoin: row.groupBookingJoin,
          }));
      },
    },
    groupBooking: {
      findMany: async (args: {
        where: { id: { in: string[] } };
        select: Record<string, unknown>;
      }) => {
        calls.groupBookingFindMany += 1;
        // The join credential is in the store and is NEVER selected. A select
        // that started asking for it would hand this fake a value the leak
        // assertions below then find in the payload.
        if (JSON.stringify(args.select).includes("joinCode")) {
          throw new Error(
            "INV-PRIV-015 (docs/invariants/analytics-and-privacy.md): the kiosk " +
              "selected GroupBooking.joinCode",
          );
        }
        return (options.groups ?? [])
          .filter((group) => args.where.id.in.includes(group.id))
          .map((group) => ({
            id: group.id,
            joinCode: JOIN_CODE,
            organiserMember: { firstName: group.organiser, lastName: "Organiser" },
          }));
      },
    },
    hostingCoverageReevaluation: {
      findMany: async (args: { where: { memberId: { in: string[] } } }) => {
        calls.reevaluationFindMany += 1;
        return (options.queuedOwnerIds ?? [])
          .filter((id) => args.where.memberId.in.includes(id))
          .map((memberId) => ({ memberId }));
      },
    },
    hostingCoverageIncident: {
      findMany: async (args: { where: { bookingId: { in: string[] } } }) => {
        calls.incidentFindMany += 1;
        return (options.openIncidentBookingIds ?? [])
          .filter((id) => args.where.bookingId.in.includes(id))
          .map((bookingId) => ({ bookingId }));
      },
    },
  };
  // Through `unknown`, because the real delegate type has eighteen methods this
  // store deliberately does not implement. What matters is that the four the
  // module CALLS behave like the database, which is what `matchBookingWhere` and
  // the counters above are for.
  return { db: db as unknown as FakeStore["db"], calls };
}

const card = (bookingId: string) => ({ bookingId, memberName: "A Member" });

async function attach(
  rows: StoreBooking[],
  capabilities: { organiser: boolean; coverSource: boolean },
  store = fakeStore({ bookings: rows }),
) {
  const cards = rows.map((row) => card(row.id));
  const attached = await attachKioskGroupTrip(cards, rows, {
    db: store.db,
    lodgeId: LODGE,
    capabilities,
  });
  return { attached, calls: store.calls };
}

const ORDINARY = { organiser: false, coverSource: false };
const PRIVILEGED = { organiser: true, coverSource: true };

// ---------------------------------------------------------------------------
// The ordinary staying-guest tier
// ---------------------------------------------------------------------------

describe("#3040 ordinary staying-guest tier: linkage only", () => {
  it("gives two visible bookings in one trip the SAME label and nothing else", async () => {
    const rows = [
      bookingRow({ id: "b-organiser", ...organiserOf(TRIP) }),
      bookingRow({ id: "b-joiner", memberId: "member-2", ...joinerOf(TRIP) }),
    ];
    const { attached } = await attach(rows, ORDINARY);

    expect(attached[0].groupTrip).toEqual({ label: 1 });
    expect(attached[1].groupTrip).toEqual({ label: 1 });
    for (const entry of attached) {
      expect(entry).not.toHaveProperty("groupTripOrganiser");
      expect(entry).not.toHaveProperty("adultCoverSource");
    }
  });

  it("numbers separate trips separately, in order of first appearance", async () => {
    const rows = [
      bookingRow({ id: "b-1", ...organiserOf(TRIP) }),
      bookingRow({ id: "b-2", memberId: "m-2", ...organiserOf(OTHER_TRIP) }),
      bookingRow({ id: "b-3", memberId: "m-3", ...joinerOf(OTHER_TRIP) }),
      bookingRow({ id: "b-4", memberId: "m-4", ...joinerOf(TRIP) }),
    ];
    const { attached } = await attach(rows, ORDINARY);
    expect(attached.map((entry) => entry.groupTrip?.label)).toEqual([1, 2, 2, 1]);
  });

  it("emits NO label when the trip has only one visible card", async () => {
    const rows = [
      bookingRow({ id: "b-lonely", ...joinerOf(TRIP) }),
      bookingRow({ id: "b-ungrouped", memberId: "m-2" }),
    ];
    const { attached } = await attach(rows, ORDINARY);
    expect(attached[0]).not.toHaveProperty("groupTrip");
    expect(attached[1]).not.toHaveProperty("groupTrip");
  });

  it("never puts the container id, an organiser, a cover source or the join code in the payload", async () => {
    const rows = [
      bookingRow({
        id: "b-organiser",
        ...organiserOf(TRIP),
        adultMemberHostingReview: snapshot([
          { night: "2026-08-01", memberIds: ["adult-9"], coveredByScopes: ["SAME_GROUP_TRIP"] },
        ]),
      }),
      bookingRow({ id: "b-joiner", memberId: "member-2", ...joinerOf(TRIP) }),
    ];
    const store = fakeStore({
      bookings: rows,
      groups: [{ id: TRIP, organiser: "Olivia" }],
      openIncidentBookingIds: ["b-organiser"],
    });
    const { attached, calls } = await attach(rows, ORDINARY, store);
    const payload = JSON.stringify(attached);

    for (const forbidden of [
      TRIP,
      JOIN_CODE,
      "joinCode",
      "Olivia",
      "organiserName",
      "groupTripOrganiser",
      "adultCoverSource",
      "SAME_GROUP_TRIP",
      "adult-9",
    ]) {
      expect(
        payload,
        `INV-PRIV-015 (docs/invariants/analytics-and-privacy.md): the ordinary ` +
          `kiosk tier's serialized payload contains "${forbidden}". A field an ` +
          `ordinary viewer may not see must be ABSENT from the payload, not ` +
          `merely unrendered.`,
      ).not.toContain(forbidden);
    }
    // And the reads themselves never happened, so there was nothing to leak.
    // The policy read is one of them: it belongs to the cover-source tier, so an
    // ordinary viewer's response does not issue it either.
    expect(calls.policyFindMany).toBe(0);
    expect(calls.groupBookingFindMany).toBe(0);
    expect(calls.reevaluationFindMany).toBe(0);
    expect(calls.incidentFindMany).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// What the club's hosting settings do and do not gate (owner decision D1)
// ---------------------------------------------------------------------------

// These were four cases asserting that a club without the `SAME_GROUP_TRIP`
// cover option got NOTHING — no chip, no organiser, no cover line. Owner
// decision D1 on #3040 overturned the chip half of that: group bookings predate
// the cover scope, the badge says only "these guests arrived together", and a
// roster label may not be conditional on an unrelated supervision setting. The
// other half is untouched and is the privacy property, so the same four club
// shapes are still driven here — asserting the new rule for the badge, and the
// unchanged rule for the cover line.
describe("#3040 the club's hosting settings gate the cover line, never the badge", () => {
  const rows = () => [
    bookingRow({
      id: "b-organiser",
      ...organiserOf(TRIP),
      adultMemberHostingReview: snapshot([
        { night: "2026-08-01", memberIds: ["adult-1"], coveredByScopes: ["SAME_BOOKING"] },
      ]),
    }),
    bookingRow({ id: "b-joiner", memberId: "member-2", ...joinerOf(TRIP) }),
  ];

  const off = (overrides: Record<string, unknown>) => [
    { ...SCOPE_ON_POLICY, ...overrides },
  ];

  /** The club shapes that leave the hosting REQUIREMENT not in force. */
  const NOT_IN_FORCE: Array<[string, Array<Record<string, unknown>>]> = [
    ["the policy mode is DISABLED", off({ mode: "DISABLED" })],
    ["there is no policy row at all", []],
    [
      "the policy set is malformed, so the resolver throws",
      [SCOPE_ON_POLICY, { ...SCOPE_ON_POLICY, id: "policy-club-2" }],
    ],
  ];

  it.each([
    ["the Group Trip cover scope is off", off({ hostScopeSameGroupTrip: false })],
    ...NOT_IN_FORCE,
  ])(
    "still gives both cards the linkage label, at ANY tier, when %s",
    async (_case, policyRows) => {
      const all = rows();
      for (const capabilities of [ORDINARY, PRIVILEGED]) {
        const store = fakeStore({
          bookings: all,
          policyRows,
          groups: [{ id: TRIP, organiser: "Olivia" }],
        });
        const { attached } = await attach(all, capabilities, store);
        expect(
          attached.map((entry) => entry.groupTrip),
          "INV-PRIV-015 (docs/invariants/analytics-and-privacy.md): owner " +
            "decision D1 on #3040 — the linkage badge follows whether the " +
            "bookings are in one group, NOT the club's shared-cover option",
        ).toEqual([{ label: 1 }, { label: 1 }]);
      }
    },
  );

  it("costs an ordinary viewer no policy read at all, whatever the club's settings", async () => {
    const all = rows();
    for (const [, policyRows] of NOT_IN_FORCE) {
      const store = fakeStore({ bookings: all, policyRows });
      const { attached, calls } = await attach(all, ORDINARY, store);
      // Linkage comes from the identity relations the caller already selected,
      // so decoupling the badge did NOT buy the ordinary tier a query.
      expect(calls.policyFindMany).toBe(0);
      expect(calls.bookingFindMany).toBe(0);
      expect(calls.groupBookingFindMany).toBe(0);
      expect(calls.reevaluationFindMany).toBe(0);
      expect(calls.incidentFindMany).toBe(0);
      for (const entry of attached) {
        expect(entry).not.toHaveProperty("groupTripOrganiser");
        expect(entry).not.toHaveProperty("adultCoverSource");
      }
    }
  });

  it.each(NOT_IN_FORCE)(
    "shows a PRIVILEGED viewer no cover source at all when %s",
    async (_case, policyRows) => {
      const all = rows();
      const store = fakeStore({
        bookings: all,
        policyRows,
        groups: [{ id: TRIP, organiser: "Olivia" }],
      });
      const { attached, calls } = await attach(all, PRIVILEGED, store);
      for (const entry of attached) {
        expect(
          entry,
          "INV-HOST-045 (docs/invariants/adult-member-hosting.md): with the " +
            "adult-member-hosting requirement not in force there is no " +
            "evaluation of this booking to report, so the key is ABSENT — a " +
            "frozen snapshot from a policy since withdrawn is not current cover",
        ).not.toHaveProperty("adultCoverSource");
      }
      // The staleness reads are gated with the payload key, so nothing was read.
      expect(calls.reevaluationFindMany).toBe(0);
      expect(calls.incidentFindMany).toBe(0);
      // Organiser context follows its OWN capability and is unaffected.
      expect(attached[0].groupTripOrganiser).toEqual({
        isOrganiser: true,
        organiserName: "Olivia Organiser",
      });
    },
  );

  it("does show a PRIVILEGED viewer the cover source when the requirement is in force but the Group Trip scope is off", async () => {
    const all = rows();
    const store = fakeStore({
      bookings: all,
      policyRows: off({ hostScopeSameGroupTrip: false }),
      groups: [{ id: TRIP, organiser: "Olivia" }],
    });
    const { attached } = await attach(all, PRIVILEGED, store);
    expect(
      attached[0].adultCoverSource,
      "INV-HOST-045: the SAME_GROUP_TRIP scope decides whether a sibling " +
        "booking's adult may COUNT, not whether cover is evaluated — a club " +
        "with the requirement on still has real SAME_BOOKING evidence to show",
    ).toEqual({
      status: "EVALUATED",
      nights: [{ night: "2026-08-01", covered: true, scopes: ["SAME_BOOKING"] }],
      scopes: ["SAME_BOOKING"],
    });
  });
});

// ---------------------------------------------------------------------------
// The two capabilities, independently
// ---------------------------------------------------------------------------

describe("#3040 the two privileged capabilities are independent", () => {
  const rows = () => [
    bookingRow({
      id: "b-organiser",
      ...organiserOf(TRIP),
      adultMemberHostingReview: snapshot([
        { night: "2026-08-01", memberIds: ["adult-1"], coveredByScopes: ["SAME_BOOKING"] },
      ]),
    }),
    bookingRow({ id: "b-joiner", memberId: "member-2", ...joinerOf(TRIP) }),
  ];

  it.each([
    [{ organiser: false, coverSource: false }, false, false],
    [{ organiser: true, coverSource: false }, true, false],
    [{ organiser: false, coverSource: true }, false, true],
    [{ organiser: true, coverSource: true }, true, true],
  ])(
    "%o yields organiser=%s coverSource=%s and neither implies the other",
    async (capabilities, wantOrganiser, wantCover) => {
      const all = rows();
      const store = fakeStore({
        bookings: all,
        groups: [{ id: TRIP, organiser: "Olivia" }],
      });
      const { attached, calls } = await attach(all, capabilities, store);
      const first = attached[0];

      expect(
        Object.prototype.hasOwnProperty.call(first, "groupTripOrganiser"),
        "INV-PRIV-015: organiser context must follow its OWN capability",
      ).toBe(wantOrganiser);
      expect(
        Object.prototype.hasOwnProperty.call(first, "adultCoverSource"),
        "INV-PRIV-015: adult-cover source must follow its OWN capability, " +
          "separately from organiser context",
      ).toBe(wantCover);

      // A capability nobody holds costs no query — the cover tier's policy read
      // included, which is why the capability is tested before it.
      expect(calls.groupBookingFindMany > 0).toBe(wantOrganiser);
      expect(calls.policyFindMany > 0).toBe(wantCover);
      expect(calls.reevaluationFindMany > 0).toBe(wantCover);
      expect(calls.incidentFindMany > 0).toBe(wantCover);

      // Linkage is unaffected by either capability.
      expect(first.groupTrip).toEqual({ label: 1 });
    },
  );

  it("names the organiser and flags which card is theirs, without an id or contact detail", async () => {
    const all = rows();
    const store = fakeStore({
      bookings: all,
      groups: [{ id: TRIP, organiser: "Olivia" }],
    });
    const { attached } = await attach(all, PRIVILEGED, store);

    expect(attached[0].groupTripOrganiser).toEqual({
      isOrganiser: true,
      organiserName: "Olivia Organiser",
    });
    expect(attached[1].groupTripOrganiser).toEqual({
      isOrganiser: false,
      organiserName: "Olivia Organiser",
    });
    const payload = JSON.stringify(attached);
    expect(payload).not.toContain(TRIP);
    expect(payload).not.toContain(JOIN_CODE);
  });

  it("reports the organiser as unavailable rather than guessing when the container is unreadable", async () => {
    const all = rows();
    const store = fakeStore({ bookings: all, groups: [] });
    const { attached } = await attach(all, PRIVILEGED, store);
    expect(attached[0].groupTripOrganiser).toEqual({
      isOrganiser: true,
      organiserName: null,
    });
  });

  it("asks nothing at all on an empty day", async () => {
    const store = fakeStore({ bookings: [] });
    const attached = await attachKioskGroupTrip([], [], {
      db: store.db,
      lodgeId: LODGE,
      capabilities: PRIVILEGED,
    });
    expect(attached).toEqual([]);
    expect(store.calls.policyFindMany).toBe(0);
    expect(store.calls.reevaluationFindMany).toBe(0);
  });

  it("maps tiers to capabilities: only admin and hut-leader hold either", () => {
    const expected: Record<KioskTier, boolean> = {
      admin: true,
      "hut-leader": true,
      lodge: false,
      "staying-guest": false,
      none: false,
    };
    for (const [tier, privileged] of Object.entries(expected)) {
      expect(
        kioskGroupTripCapabilities(tier as KioskTier),
        `INV-PRIV-015: kiosk tier ${tier}`,
      ).toEqual({ organiser: privileged, coverSource: privileged });
    }
  });
});

// ---------------------------------------------------------------------------
// Cover source: derived from the canonical snapshot, never optimistic
// ---------------------------------------------------------------------------

describe("#3040 adult-cover source is the canonical evaluation, honestly reported", () => {
  const fresh = { queuedReevaluation: false, openIncident: false };

  it("reports NOT_RECORDED, with no nights, when the booking carries no snapshot", () => {
    for (const value of [null, undefined]) {
      expect(deriveKioskAdultCoverSource(value, fresh)).toEqual({
        status: "NOT_RECORDED",
        nights: [],
        scopes: [],
      });
    }
  });

  it("reports UNREADABLE for a snapshot that is not the canonical shape", () => {
    for (const value of [
      {},
      { reasonCode: "SOMETHING_ELSE" },
      snapshot(undefined),
      snapshot("not-an-array"),
      "a string",
      42,
    ]) {
      const derived = deriveKioskAdultCoverSource(value, fresh);
      expect(
        derived.status,
        `INV-HOST-045 (docs/invariants/adult-member-hosting.md): a snapshot the ` +
          `kiosk cannot read is a FAILED evaluation, never cover`,
      ).toBe("UNREADABLE");
      expect(derived.nights).toEqual([]);
    }
  });

  it("reports per-night cover and the scope categories, partial nights included", () => {
    const derived = deriveKioskAdultCoverSource(
      snapshot(
        [
          { night: "2026-08-03", memberIds: [], coveredByScopes: [] },
          {
            night: "2026-08-01",
            memberIds: ["adult-1", "adult-2"],
            coveredByScopes: ["SAME_GROUP_TRIP", "SAME_BOOKING"],
          },
          {
            night: "2026-08-02",
            memberIds: ["adult-1"],
            coveredByScopes: ["SAME_BOOKING_OWNER"],
          },
        ],
        [{ night: "2026-08-03", guestRef: "guest-1" }],
      ),
      fresh,
    );

    expect(derived.status).toBe("EVALUATED");
    // Sorted by night, so the display order is the stay's order.
    expect(derived.nights).toEqual([
      {
        night: "2026-08-01",
        covered: true,
        // Sorted through the canonical scope list, not as stored.
        scopes: ["SAME_BOOKING", "SAME_GROUP_TRIP"],
      },
      { night: "2026-08-02", covered: true, scopes: ["SAME_BOOKING_OWNER"] },
      { night: "2026-08-03", covered: false, scopes: [] },
    ]);
    expect(derived.scopes).toEqual([
      "SAME_BOOKING",
      "SAME_BOOKING_OWNER",
      "SAME_GROUP_TRIP",
    ]);
  });

  it("never carries a covering member's id", () => {
    const derived = deriveKioskAdultCoverSource(
      snapshot([
        { night: "2026-08-01", memberIds: ["adult-secret"], coveredByScopes: ["SAME_GROUP_TRIP"] },
      ]),
      fresh,
    );
    expect(
      JSON.stringify(derived),
      "INV-PRIV-015: the kiosk reports the cover SOURCE CATEGORY, never which " +
        "member on which account supplied it",
    ).not.toContain("adult-secret");
  });

  it("reads a covered night with no recorded scope as SAME_BOOKING, the field's documented meaning", () => {
    const derived = deriveKioskAdultCoverSource(
      snapshot([{ night: "2026-08-01", memberIds: ["adult-1"] }]),
      fresh,
    );
    expect(derived.nights).toEqual([
      { night: "2026-08-01", covered: true, scopes: ["SAME_BOOKING"] },
    ]);
  });

  it("reports STALE, with no nights, when a re-evaluation is queued", () => {
    const derived = deriveKioskAdultCoverSource(
      snapshot([
        { night: "2026-08-01", memberIds: ["adult-1"], coveredByScopes: ["SAME_GROUP_TRIP"] },
      ]),
      { queuedReevaluation: true, openIncident: false },
    );
    expect(
      derived,
      "INV-HOST-045: a snapshot with queued re-evaluation behind it is STALE, " +
        "and stale must never render as positive cover",
    ).toEqual({ status: "STALE", nights: [], scopes: [] });
  });

  it("reports STALE when an OPEN incident contradicts an all-covered snapshot", () => {
    const derived = deriveKioskAdultCoverSource(
      snapshot([
        { night: "2026-08-01", memberIds: ["adult-1"], coveredByScopes: ["SAME_BOOKING"] },
      ]),
      { queuedReevaluation: false, openIncident: true },
    );
    expect(
      derived.status,
      "INV-HOST-045: an open coverage incident says this booking IS carrying " +
        "uncovered nights; a snapshot claiming none disagrees, and the display " +
        "must not choose the optimistic side",
    ).toBe("STALE");
    expect(derived.nights).toEqual([]);
  });

  it("keeps an open incident's own snapshot readable when the two AGREE", () => {
    const derived = deriveKioskAdultCoverSource(
      snapshot(
        [
          { night: "2026-08-01", memberIds: ["adult-1"], coveredByScopes: ["SAME_BOOKING"] },
          { night: "2026-08-02", memberIds: [], coveredByScopes: [] },
        ],
        [{ night: "2026-08-02", guestRef: "guest-1" }],
      ),
      { queuedReevaluation: false, openIncident: true },
    );
    expect(derived.status).toBe("EVALUATED");
    expect(derived.nights.map((night) => night.covered)).toEqual([true, false]);
  });

  it("routes the queue signal by OWNER and lodge, and the incident signal by booking", async () => {
    const rows = [
      bookingRow({
        id: "b-1",
        memberId: "owner-queued",
        ...organiserOf(TRIP),
        adultMemberHostingReview: snapshot([
          { night: "2026-08-01", memberIds: ["adult-1"], coveredByScopes: ["SAME_BOOKING"] },
        ]),
      }),
      bookingRow({
        id: "b-2",
        memberId: "owner-clean",
        ...joinerOf(TRIP),
        adultMemberHostingReview: snapshot([
          { night: "2026-08-01", memberIds: ["adult-2"], coveredByScopes: ["SAME_BOOKING"] },
        ]),
      }),
    ];
    const store = fakeStore({
      bookings: rows,
      groups: [{ id: TRIP, organiser: "Olivia" }],
      queuedOwnerIds: ["owner-queued"],
    });
    const { attached } = await attach(rows, PRIVILEGED, store);
    expect(attached[0].adultCoverSource?.status).toBe("STALE");
    expect(attached[1].adultCoverSource?.status).toBe("EVALUATED");
  });
});

// ---------------------------------------------------------------------------
// Owner decision D2 on #3038: a split pair is one party
// ---------------------------------------------------------------------------

describe("#3040 the split-pair carve-out reaches the kiosk through its one canonical seam", () => {
  it("gives a split child its parent's trip, so the pair reads as one party", async () => {
    const rows = [
      bookingRow({ id: "b-parent", memberId: "member-1", ...joinerOf(TRIP) }),
      bookingRow({
        id: "b-child",
        memberId: "member-1",
        parentBookingId: "b-parent",
      }),
    ];
    const { attached, calls } = await attach(rows, ORDINARY);
    expect(attached[0].groupTrip).toEqual({ label: 1 });
    expect(
      attached[1].groupTrip,
      "INV-HOST-043 (docs/invariants/adult-member-hosting.md): a #738 split pair " +
        "is one party, so the half carrying the non-member guests is in the same " +
        "Group Trip as the half that joined it",
    ).toEqual({ label: 1 });
    // One lookup, for the one booking that needed it.
    expect(calls.bookingFindMany).toBe(1);
  });

  it("asks for no lookup at all when no visible card has a parent booking", async () => {
    const rows = [
      bookingRow({ id: "b-1", ...organiserOf(TRIP) }),
      bookingRow({ id: "b-2", memberId: "m-2", ...joinerOf(TRIP) }),
    ];
    const { calls } = await attach(rows, ORDINARY);
    expect(calls.bookingFindMany).toBe(0);
  });

  it("inherits nothing from a parent owned by a DIFFERENT member", async () => {
    const rows = [
      bookingRow({ id: "b-parent", memberId: "member-1", ...joinerOf(TRIP) }),
      bookingRow({ id: "b-other", memberId: "member-1", ...joinerOf(TRIP) }),
      bookingRow({
        id: "b-child",
        memberId: "member-99",
        parentBookingId: "b-parent",
      }),
    ];
    const { attached } = await attach(rows, ORDINARY);
    expect(
      attached[2],
      "INV-HOST-043: parentBookingId is NOT a Group Trip identity; only the " +
        "same-member split pair inherits",
    ).not.toHaveProperty("groupTrip");
  });

  it("inherits nothing from a CANCELLED parent", async () => {
    const rows = [
      bookingRow({
        id: "b-parent",
        memberId: "member-1",
        status: "CANCELLED",
        ...joinerOf(TRIP),
      }),
      bookingRow({ id: "b-live", memberId: "member-1", ...joinerOf(TRIP) }),
      bookingRow({
        id: "b-child",
        memberId: "member-1",
        parentBookingId: "b-parent",
      }),
    ];
    const { attached } = await attach(rows, ORDINARY);
    expect(attached[2]).not.toHaveProperty("groupTrip");
  });

  it("bounds the lookups and fails CLOSED past the ceiling", async () => {
    const parents = Array.from({ length: 2 }, (_, index) =>
      bookingRow({
        id: `b-parent-${index}`,
        memberId: `member-${index}`,
        ...joinerOf(TRIP),
      }),
    );
    const children = Array.from(
      { length: KIOSK_SPLIT_PAIR_IDENTITY_LOOKUP_LIMIT + 3 },
      (_, index) =>
        bookingRow({
          id: `b-child-${index}`,
          memberId: `member-${index % 2}`,
          parentBookingId: `b-parent-${index % 2}`,
        }),
    );
    const rows = [...parents, ...children];
    const { attached, calls } = await attach(rows, ORDINARY);
    expect(calls.bookingFindMany).toBe(KIOSK_SPLIT_PAIR_IDENTITY_LOOKUP_LIMIT);
    const withoutLinkage = attached.filter(
      (entry) => !Object.prototype.hasOwnProperty.call(entry, "groupTrip"),
    );
    expect(withoutLinkage.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Source-level fences
// ---------------------------------------------------------------------------

const KIOSK_SURFACES = [
  "src/lib/kiosk-group-trip.ts",
  "src/lib/kiosk-access.ts",
  "src/app/api/lodge/guests/[date]/route.ts",
  "src/app/api/lodge/week/route.ts",
  "src/app/(lodge)/lodge/kiosk/page.tsx",
  "src/app/(lodge)/lodge/kiosk/_components/kiosk-group-trip-card.tsx",
] as const;

function readSurface(file: string): string {
  return stripComments(readFileSync(path.resolve(process.cwd(), file), "utf8"));
}

describe("#3040 source fences on the kiosk Group Trip surfaces", () => {
  it("no kiosk surface names joinCode at all", () => {
    for (const file of KIOSK_SURFACES) {
      expect(
        readSurface(file),
        `INV-PRIV-015 (docs/invariants/analytics-and-privacy.md): ${file} names ` +
          `joinCode. The group's join credential is excluded from every kiosk ` +
          `tier, every DTO and every select.`,
      ).not.toContain("joinCode");
    }
  });

  it("resolves Group Trip identity through the canonical helpers only", () => {
    const source = readSurface("src/lib/kiosk-group-trip.ts");
    expect(source).toContain("groupTripIdentityOf(");
    expect(source).toContain("readInheritedSplitPairGroupTrip(");
    // A second identity read would be a second answer to "what group is this
    // booking in?" — the exact thing `INV-SSOT` and the epic's identity rule
    // forbid. The two relation names appear ONLY inside
    // `GROUP_TRIP_IDENTITY_SELECT` and `groupTripIdentityOf`, never here.
    for (const relation of ["groupBookingAsOrganiser", "groupBookingJoin"]) {
      expect(
        source,
        `INV-SSOT-001: kiosk-group-trip.ts reads ${relation} directly instead ` +
          `of going through groupTripIdentityOf`,
      ).not.toContain(relation);
    }
  });

  it("keeps the tier-to-capability decision in exactly one place", () => {
    const access = readSurface("src/lib/kiosk-access.ts");
    expect(access).toContain("kioskGroupTripCapabilities(tier)");
    const route = readSurface("src/app/api/lodge/guests/[date]/route.ts");
    expect(
      route,
      "INV-SSOT-001: the guest-list route must ASK for the capabilities rather " +
        "than restate the tier test, or the access endpoint and the payload can " +
        "disagree about who may see what",
    ).toContain("kioskGroupTripCapabilities(tier)");
  });

  it("renders no private value into a tooltip or an accessible name", () => {
    const component = readSurface(
      "src/app/(lodge)/lodge/kiosk/_components/kiosk-group-trip-card.tsx",
    );
    for (const attribute of ["title=", "aria-label=", "data-"]) {
      expect(
        component,
        `INV-PRIV-015: the kiosk Group Trip card uses ${attribute}. A tooltip ` +
          `and a screen-reader label are as readable as body text, and the ` +
          `issue lists them among the leaks it forbids.`,
      ).not.toContain(attribute);
    }
  });
});
