// #3038 (epic #2943) — the `SAME_GROUP_TRIP` cover evaluator: can a qualifying
// adult travelling on ANOTHER booking in the same Group Trip satisfy the
// required-adult rule for this one?
//
// ENFORCES INV-HOST-043 (group identity and the container's status) and
// INV-HOST-044 (cross-booking Group Trip hosts are host-only, deduplicated and
// bounded) from `docs/invariants/adult-member-hosting.md`. The assertions that
// carry those rules repeat the id in their failure message, so whoever trips one
// is handed the rule rather than having to go and find it (#2691).
//
// WHY A FAKE STORE THAT REALLY APPLIES `where`. This whole child is about which
// bookings are and are not related, so a double that ignored the clauses would
// pass every test below for the wrong reason. `matchesWhere` therefore applies
// the real predicates and THROWS on an operator it does not model, which is what
// makes "this booking supplies no cover" a fact about the query rather than a
// fact about the fake. It is deliberately a sibling of the store in
// `adult-member-hosting-same-owner.test.ts` rather than an import of it: that
// one models one member's own bookings and knows nothing about the two Group
// Trip relations, and widening it would make one file answer for two scopes.
import { AgeTier, type MemberGuestConsentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The store is I/O-free, but the shared evaluator asks the club for its #2543
// subscription-lockout mode through the MODULE Prisma client rather than the
// injected `db`. Against the unreachable test DATABASE_URL that read costs
// seconds of connection retries on EVERY evaluation with a member-linked
// participant. Stub it: the mode is a club setting, not part of what this file
// asserts, and `HARD_BLOCK` is the default that makes
// `loadUnpaidSubscriptionMemberIds` a no-op.
vi.mock("@/lib/member-subscription-eligibility", () => ({
  peekSubscriptionLockoutMode: async () => "HARD_BLOCK",
  resolveSubscriptionLockoutMode: async () => "HARD_BLOCK",
}));

import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { HostingGroupTripSourceCeilingExceededError } from "@/lib/adult-member-hosting-coverage-ceilings";
import { evaluateProposedAdultMemberHosting } from "@/lib/adult-member-hosting-proposed";
import {
  evaluateBookingAdultMemberHosting,
  evaluatePersistedBookingAdultMemberHostingReadOnly,
} from "@/lib/adult-member-hosting-review";
import { groupTripCoverageSourceWhere } from "@/lib/group-trip-identity";

const LODGE = "lodge-a";
const OTHER_LODGE = "lodge-b";
const TRIP = "group-trip-1";
const OTHER_TRIP = "group-trip-2";

/**
 * A club-wide policy row. `ADMIN_REVIEW_REQUIRED` so an uncovered night produces
 * a violation to inspect rather than a throw, with `SAME_BOOKING` on (the
 * built-in rule) and the two cross-booking scopes off unless a test turns one on.
 */
function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "policy-club",
    scopeKey: "club-wide",
    lodgeId: null,
    mode: "ADMIN_REVIEW_REQUIRED",
    capacityMode: "NO_HOLD",
    version: 7,
    hostScopeSameBooking: true,
    hostScopeSameBookingOwner: false,
    hostScopeSameGroupTrip: false,
    ...overrides,
  };
}

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "adult-1",
    ageTier: AgeTier.ADULT,
    active: true,
    cancelledAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function guestRow(
  id: string,
  nights: string[],
  member: ReturnType<typeof memberRow> | null = null,
  consentStatus: MemberGuestConsentStatus | null = null,
) {
  return {
    id,
    firstName: id,
    lastName: "Person",
    memberId: member?.id ?? null,
    stayStart: new Date(`${nights[0]}T00:00:00.000Z`),
    stayEnd: new Date(`${nights[nights.length - 1]}T00:00:00.000Z`),
    consentStatus,
    nights: nights.map((night) => ({
      stayDate: new Date(`${night}T00:00:00.000Z`),
    })),
    member,
  };
}

type FakeBooking = Record<string, unknown>;

/**
 * A booking row with every column and relation the coverage predicates read.
 *
 * `groupBookingAsOrganiser` and `groupBookingJoin` are the two authoritative
 * Group Trip relations; `parentBookingId` is present and deliberately unrelated
 * to them, so a test can set a `parentBookingId` link across two DIFFERENT trips
 * and still expect no cover — a store that omitted the column could not tell
 * "the predicate ignores this" from "the column was never there".
 */
function booking(overrides: FakeBooking = {}): FakeBooking {
  return {
    id: "b-main",
    memberId: "owner-1",
    parentBookingId: null,
    groupBookingAsOrganiser: null,
    groupBookingJoin: null,
    lodgeId: LODGE,
    status: "CONFIRMED",
    deletedAt: null,
    checkIn: new Date("2026-08-03T00:00:00.000Z"),
    checkOut: new Date("2026-08-05T00:00:00.000Z"),
    adultMemberHostingReview: null,
    adultMemberHostingReviewStatus: null,
    guests: [],
    ...overrides,
  };
}

/** The organiser's booking in `trip`. */
function organiserOf(trip: string, overrides: FakeBooking = {}): FakeBooking {
  return booking({
    id: `organiser-${trip}`,
    memberId: `organiser-member-${trip}`,
    groupBookingAsOrganiser: { id: trip },
    ...overrides,
  });
}

/** A joined booking in `trip`. */
function joinerOf(
  trip: string,
  id: string,
  overrides: FakeBooking = {},
): FakeBooking {
  return booking({
    id,
    memberId: `joiner-member-${id}`,
    groupBookingJoin: { groupBookingId: trip },
    ...overrides,
  });
}

/**
 * Apply a Prisma-shaped `where` to a plain row.
 *
 * Supports exactly the operators the Group Trip coverage predicates use, and
 * THROWS on anything else. Throwing rather than ignoring is the point: a clause
 * this fake silently skipped would make a "not related" test pass while the
 * production query related the two bookings.
 */
function matchesWhere(row: FakeBooking, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "AND") {
      const clauses = condition as Array<Record<string, unknown>>;
      if (!clauses.every((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (key === "OR") {
      const clauses = condition as Array<Record<string, unknown>>;
      if (!clauses.some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    const value = row[key];
    if (condition === null || typeof condition !== "object") {
      if (value !== condition) return false;
      continue;
    }
    const operators = condition as Record<string, unknown>;
    // A to-one relation filter: `groupBookingJoin: { is: { groupBookingId } }`.
    // A null relation matches nothing, which is the whole reason a booking in no
    // Group Trip supplies no Group Trip cover.
    if ("is" in operators) {
      const nested = operators.is as Record<string, unknown> | null;
      if (nested === null) {
        if (value != null) return false;
        continue;
      }
      if (value == null) return false;
      if (!matchesWhere(value as FakeBooking, nested)) return false;
      continue;
    }
    for (const [operator, operand] of Object.entries(operators)) {
      switch (operator) {
        case "not":
          if (value === operand) return false;
          break;
        case "in":
          if (!(operand as unknown[]).includes(value)) return false;
          break;
        case "notIn":
          if ((operand as unknown[]).includes(value)) return false;
          break;
        case "lt":
          if (!((value as Date) < (operand as Date))) return false;
          break;
        case "gt":
          if (!((value as Date) > (operand as Date))) return false;
          break;
        case "gte":
          if (!((value as Date) >= (operand as Date))) return false;
          break;
        default:
          throw new Error(`fake store cannot apply operator ${operator}`);
      }
    }
  }
  return true;
}

/**
 * Return only the columns and relations a `select` asked for.
 *
 * NOT A DETAIL. The Group Trip relations reach the evaluator through
 * `BOOKING_HOSTING_SELECT`, and Prisma does not typecheck `select` keys through
 * the hand-written client interfaces the hosting paths use — so a select that
 * quietly stopped naming them would hand the resolver `undefined` and every
 * booking would read as belonging to no Group Trip, with a green typecheck. A
 * store that returned whole rows regardless of the select cannot see that at
 * all: it answers with data the production query never asked for.
 */
function project(row: FakeBooking, select: Record<string, unknown> | undefined) {
  if (!select) return row;
  const out: FakeBooking = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
}

function makeStore(rows: FakeBooking[], policies?: unknown[]) {
  const byId = new Map(rows.map((row) => [row.id as string, { ...row }]));
  /** Every `where` the evaluator handed the booking table, for structural checks. */
  const bookingWheres: Array<Record<string, unknown>> = [];

  const db = {
    $executeRaw: vi.fn(async () => 1),
    booking: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const row = byId.get(where.id);
        return row ? project(row, select) : null;
      }),
      findMany: vi.fn(async ({ where, select, orderBy, take }: any) => {
        bookingWheres.push(where);
        let matched = [...byId.values()].filter((row) =>
          matchesWhere(row, where),
        );
        // ORDER THEN TRUNCATE, in that sequence, because that is what a bounded
        // read does and the point of the ordered reads is that the truncation is
        // reproducible.
        if (Array.isArray(orderBy)) {
          for (const clause of [...orderBy].reverse()) {
            const [field, direction] = Object.entries(clause)[0] as [
              string,
              string,
            ];
            matched = [...matched].sort((left, right) => {
              const a = left[field] as never;
              const b = right[field] as never;
              const cmp = a < b ? -1 : a > b ? 1 : 0;
              return direction === "desc" ? -cmp : cmp;
            });
          }
        }
        if (typeof take === "number") matched = matched.slice(0, take);
        // The cross-booking SOURCE reads narrow the guest relation to
        // member-linked rows. Honour it: a fake that returned non-member guests
        // too would hide a loader that had stopped narrowing.
        const guestWhere = select?.guests?.where;
        return matched.map((row) => {
          const projected = project(row, select);
          if (!guestWhere) return projected;
          return {
            ...projected,
            guests: (row.guests as Array<Record<string, unknown>>).filter(
              (guest) => matchesWhere(guest, guestWhere),
            ),
          };
        });
      }),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 0),
    },
    adultMemberHostingPolicy: {
      findMany: vi.fn().mockResolvedValue(policies ?? [policyRow()]),
    },
    lodge: { findFirst: vi.fn().mockResolvedValue({ name: "Ruapehu Lodge" }) },
    member: {
      findMany: vi.fn(async ({ where }: any) => {
        const ids: string[] = where?.id?.in ?? [];
        return [...ids].sort().map((id) => ({ id }));
      }),
      findUnique: vi.fn(async ({ where }: any) => ({ id: where.id })),
    },
    hostingCoverageIncident: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "incident-1" })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    hostingCoverageReevaluation: {
      create: vi.fn(async () => ({ id: "queue-1" })),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  } as any;

  return { db, bookingWheres };
}

/** Evaluate the FIRST row against the rest of the store. */
async function evaluate(rows: FakeBooking[], policies?: unknown[]) {
  const { db, bookingWheres } = makeStore(rows, policies);
  const { violation } = await evaluateBookingAdultMemberHosting(
    rows[0] as never,
    db,
  );
  return { violation, db, bookingWheres };
}

const GROUP_TRIP_ON = [policyRow({ hostScopeSameGroupTrip: true })];

/**
 * The dependent booking: a joined booking carrying two non-member guest-nights
 * and nobody on it who can host them.
 */
function joinerNeedingCover(overrides: FakeBooking = {}) {
  return joinerOf(TRIP, "b-main", {
    guests: [guestRow("kid", ["2026-08-03", "2026-08-04"])],
    ...overrides,
  });
}

/** A source booking whose qualifying adult member attends `nights`. */
function withAdult(
  row: FakeBooking,
  nights: string[],
  memberId = "adult-source",
): FakeBooking {
  return {
    ...row,
    checkIn: new Date(`${nights[0]}T00:00:00.000Z`),
    checkOut: new Date(
      new Date(`${nights[nights.length - 1]}T00:00:00.000Z`).getTime() +
        86_400_000,
    ),
    guests: [guestRow(`adult-of-${row.id}`, nights, memberRow({ id: memberId }))],
  };
}

describe("SAME_GROUP_TRIP supplies cover from a sibling booking (#3038)", () => {
  it("lets the organiser's qualifying adult cover a joined booking's guest-nights", async () => {
    const rows = [
      joinerNeedingCover(),
      withAdult(organiserOf(TRIP), ["2026-08-03", "2026-08-04"]),
    ];
    expect((await evaluate(rows, GROUP_TRIP_ON)).violation).toBeNull();
  });

  it("names SAME_GROUP_TRIP as the scope that covered each night", async () => {
    // One night covered, one not, so the snapshot has to carry both a covered
    // night with its scope and an uncovered one. `coveredByScopes` is the field
    // #3040's kiosk cover-source display reads, so it is asserted rather than
    // inferred from the absence of a violation.
    const rows = [
      joinerNeedingCover(),
      withAdult(organiserOf(TRIP), ["2026-08-03"]),
    ];
    const { violation } = await evaluate(rows, GROUP_TRIP_ON);
    expect(violation?.affectedNights).toEqual(["2026-08-04"]);
    expect(violation?.requirements.qualifyingHostsByNight).toEqual([
      {
        night: "2026-08-03",
        memberIds: ["adult-source"],
        coveredByScopes: ["SAME_GROUP_TRIP"],
      },
      { night: "2026-08-04", memberIds: [], coveredByScopes: [] },
    ]);
  });

  it("resolves group identity from the columns the booking read actually selects", async () => {
    // THE ONE PATH THAT LOADS THE DEPENDENT ITSELF, rather than being handed an
    // already-loaded row. It reads through `BOOKING_HOSTING_SELECT`, and the
    // store honours that select — so if the select ever stopped naming the two
    // Group Trip relations, this booking would resolve to no Group Trip and the
    // cover below would vanish. Prisma does not typecheck select keys through
    // the hand-written client interfaces these paths use, so nothing else would
    // notice.
    const { db } = makeStore(
      [
        joinerNeedingCover(),
        withAdult(organiserOf(TRIP), ["2026-08-03", "2026-08-04"]),
      ],
      GROUP_TRIP_ON,
    );
    const result = await evaluatePersistedBookingAdultMemberHostingReadOnly(
      "b-main",
      db,
      { seasonYear: 2026, subscriptionLockoutMode: "HARD_BLOCK" },
    );
    expect(
      result?.violation,
      "INV-HOST-043 (docs/invariants/adult-member-hosting.md): group identity " +
        "is GroupBooking.organiserBookingId and GroupBookingJoin.bookingId. A " +
        "booking read that omits them resolves every booking to no Group Trip, " +
        "silently and with a green typecheck.",
    ).toBeNull();
  });

  it("covers a joined booking from ANOTHER joiner, not only from the organiser", async () => {
    // Membership is membership: the identity module gives an organiser and a
    // joiner the same `groupBookingId`, and `role` carries no policy weight in
    // the hosting rule.
    const rows = [
      joinerNeedingCover(),
      withAdult(joinerOf(TRIP, "b-sibling"), ["2026-08-03", "2026-08-04"]),
    ];
    expect((await evaluate(rows, GROUP_TRIP_ON)).violation).toBeNull();
  });

  it("covers the ORGANISER's own booking from a joiner's adult", async () => {
    const rows = [
      organiserOf(TRIP, {
        id: "b-main",
        guests: [guestRow("kid", ["2026-08-03", "2026-08-04"])],
      }),
      withAdult(joinerOf(TRIP, "b-sibling"), ["2026-08-03", "2026-08-04"]),
    ];
    expect((await evaluate(rows, GROUP_TRIP_ON)).violation).toBeNull();
  });

  it("gives a member-owned and a non-member-owned join the identical answer", async () => {
    // The owner's contract in as many words: "member-owned and non-member-owned
    // joins consume qualifying group cover on the same lodge/date/status terms".
    // The two dependents differ ONLY in whether their owner is a login member
    // with a member-linked guest row of their own, and the joined booking's own
    // ownership is never consulted by the source query.
    const source = withAdult(organiserOf(TRIP), ["2026-08-03"]);

    const memberOwned = await evaluate(
      [
        joinerOf(TRIP, "b-main", {
          memberId: "login-member",
          guests: [
            guestRow("kid", ["2026-08-03", "2026-08-04"]),
            // A member-linked guest who is NOT an adult, so this party still
            // cannot host itself: the difference under test is ownership, not
            // whether the booking has its own adult.
            guestRow(
              "child-member",
              ["2026-08-03", "2026-08-04"],
              memberRow({ id: "child-1", ageTier: AgeTier.CHILD }),
            ),
          ],
        }),
        source,
      ],
      GROUP_TRIP_ON,
    );
    const nonMemberOwned = await evaluate(
      [
        joinerOf(TRIP, "b-main", {
          memberId: "non-login-contact",
          guests: [guestRow("kid", ["2026-08-03", "2026-08-04"])],
        }),
        source,
      ],
      GROUP_TRIP_ON,
    );

    expect(memberOwned.violation?.affectedNights).toEqual(["2026-08-04"]);
    expect(nonMemberOwned.violation?.affectedNights).toEqual(["2026-08-04"]);
    expect(
      memberOwned.violation?.requirements.qualifyingHostsByNight,
    ).toEqual(nonMemberOwned.violation?.requirements.qualifyingHostsByNight);
  });
});

describe("the source set is lodge, night and Booking.status specific (#3038)", () => {
  it("takes no cover from a sibling booking at a DIFFERENT lodge", async () => {
    const rows = [
      joinerNeedingCover(),
      withAdult(organiserOf(TRIP, { lodgeId: OTHER_LODGE }), [
        "2026-08-03",
        "2026-08-04",
      ]),
    ];
    expect((await evaluate(rows, GROUP_TRIP_ON)).violation?.affectedNights).toEqual(
      ["2026-08-03", "2026-08-04"],
    );
  });

  it("covers only the nights the sibling adult actually stays", async () => {
    // Partial overlap, which is the case a booking-level answer would get wrong:
    // the adult is there for the first night and gone for the second.
    const rows = [
      joinerNeedingCover(),
      withAdult(organiserOf(TRIP), ["2026-08-04"]),
    ];
    expect((await evaluate(rows, GROUP_TRIP_ON)).violation?.affectedNights).toEqual(
      ["2026-08-03"],
    );
  });

  it("takes no cover from a sibling whose stay does not overlap at all", async () => {
    // Half-open: a source arriving on this booking's checkout day shares no
    // night with it.
    const rows = [
      joinerNeedingCover(),
      withAdult(organiserOf(TRIP), ["2026-08-05", "2026-08-06"]),
    ];
    expect((await evaluate(rows, GROUP_TRIP_ON)).violation?.affectedNights).toEqual(
      ["2026-08-03", "2026-08-04"],
    );
  });

  it.each([
    ["CONFIRMED", true],
    ["PAID", true],
    ["PENDING", false],
    ["PAYMENT_PENDING", false],
    ["AWAITING_REVIEW", false],
    ["CANCELLED", false],
    ["BUMPED", false],
    ["COMPLETED", false],
  ])("a %s sibling booking supplies cover: %s", async (status, covers) => {
    const rows = [
      joinerNeedingCover(),
      withAdult(organiserOf(TRIP, { status }), ["2026-08-03", "2026-08-04"]),
    ];
    const { violation } = await evaluate(rows, GROUP_TRIP_ON);
    expect(violation === null).toBe(covers);
  });

  it("takes no cover from a soft-deleted sibling booking", async () => {
    const rows = [
      joinerNeedingCover(),
      withAdult(organiserOf(TRIP, { deletedAt: new Date("2026-06-01") }), [
        "2026-08-03",
        "2026-08-04",
      ]),
    ];
    expect((await evaluate(rows, GROUP_TRIP_ON)).violation?.affectedNights).toEqual(
      ["2026-08-03", "2026-08-04"],
    );
  });

  it("takes no cover from a sibling whose only adult is not a qualifying member", async () => {
    // Membership of the trip is not hosting. There is deliberately no second
    // definition of a qualifying adult member in the Group Trip loader: an
    // archived Member fails the shared `participantQualifiesAsHost`.
    const archived = {
      ...withAdult(organiserOf(TRIP), ["2026-08-03", "2026-08-04"]),
    };
    archived.guests = [
      guestRow(
        "adult-archived",
        ["2026-08-03", "2026-08-04"],
        memberRow({ id: "adult-source", archivedAt: new Date("2026-06-01") }),
      ),
    ];
    expect(
      (await evaluate([joinerNeedingCover(), archived], GROUP_TRIP_ON)).violation
        ?.affectedNights,
    ).toEqual(["2026-08-03", "2026-08-04"]);
  });
});

describe("group identity is the two canonical relations (INV-HOST-043)", () => {
  it("takes no cover from a booking in a DIFFERENT Group Trip", async () => {
    const rows = [
      joinerNeedingCover(),
      withAdult(organiserOf(OTHER_TRIP), ["2026-08-03", "2026-08-04"]),
    ];
    expect((await evaluate(rows, GROUP_TRIP_ON)).violation?.affectedNights).toEqual(
      ["2026-08-03", "2026-08-04"],
    );
  });

  it("takes no cover from a booking in NO Group Trip", async () => {
    const rows = [
      joinerNeedingCover(),
      withAdult(booking({ id: "b-unrelated", memberId: "someone-else" }), [
        "2026-08-03",
        "2026-08-04",
      ]),
    ];
    expect((await evaluate(rows, GROUP_TRIP_ON)).violation?.affectedNights).toEqual(
      ["2026-08-03", "2026-08-04"],
    );
  });

  const PARENT_ID_RULE =
    "INV-HOST-043 (docs/invariants/adult-member-hosting.md): Booking." +
    "parentBookingId is the #738 split-booking relationship, never Group Trip " +
    "identity. It is neither necessary nor sufficient, so reading grouping off " +
    "it produces a sibling set that is wrong in BOTH directions.";

  // Two ways a `parentBookingId`-based implementation could be written, and both
  // must be refused. In each case the dependent carries a `parentBookingId`
  // pointing INTO the other Group Trip — once at that trip's container id, once
  // at that trip's organiser booking id — while its own real Group Trip holds no
  // qualifying adult at all. A loader reading either as identity picks up the
  // other trip's adult and reports the booking covered.
  it.each([
    ["the group id itself", OTHER_TRIP],
    ["the other trip's organiser booking", `organiser-${OTHER_TRIP}`],
  ])(
    "takes no cover through a parentBookingId pointing at %s",
    async (_label, parentBookingId) => {
      const { violation } = await evaluate(
        [
          joinerNeedingCover({ parentBookingId }),
          withAdult(organiserOf(OTHER_TRIP), ["2026-08-03", "2026-08-04"]),
        ],
        GROUP_TRIP_ON,
      );
      expect(violation?.affectedNights, PARENT_ID_RULE).toEqual([
        "2026-08-03",
        "2026-08-04",
      ]);
    },
  );

  it("still finds the real siblings, which carry no parentBookingId link at all", async () => {
    // The other direction of the same claim: two bookings in one Group Trip are
    // not parent and child, so an implementation reading grouping off that
    // column MISSES them.
    const { violation } = await evaluate(
      [
        joinerNeedingCover(),
        withAdult(organiserOf(TRIP), ["2026-08-03", "2026-08-04"]),
      ],
      GROUP_TRIP_ON,
    );
    expect(violation, PARENT_ID_RULE).toBeNull();
  });

  it("keeps the container's own status out of the source query entirely", async () => {
    // Structural, because a behavioural test can only prove the container status
    // this store happens to carry is ignored. The claim is that no clause names
    // one at all, so a later edit cannot reintroduce a gate nobody tests.
    const where = groupTripCoverageSourceWhere(
      {
        id: "b-main",
        lodgeId: LODGE,
        checkIn: new Date("2026-08-03T00:00:00.000Z"),
        checkOut: new Date("2026-08-05T00:00:00.000Z"),
      },
      { groupBookingId: TRIP, role: "JOINER" },
    );
    const serialised = JSON.stringify(where);
    expect(
      serialised,
      "INV-HOST-043 (docs/invariants/adult-member-hosting.md): GroupBooking." +
        "status governs JOINING, not cover. A CLOSED container is the normal " +
        "state of a settled party and a cancelled container does not cancel " +
        "the joiners' own bookings.",
    ).not.toContain("CLOSED");
    expect(serialised).not.toContain("CANCELLED");
    // And `Booking.status` IS still filtered, so the assertion above cannot be
    // satisfied by a query that had simply stopped filtering lifecycle at all.
    expect(serialised).toContain("CONFIRMED");
  });

  it("still supplies cover when the Group Trip container is closed or cancelled", async () => {
    // The behavioural half. The store carries a container status the production
    // query never asks for; cover is unchanged either way.
    for (const containerStatus of ["OPEN", "CLOSED", "CANCELLED"]) {
      const rows = [
        joinerNeedingCover({
          groupBookingJoin: { groupBookingId: TRIP, status: containerStatus },
        }),
        withAdult(
          organiserOf(TRIP, {
            groupBookingAsOrganiser: { id: TRIP, status: containerStatus },
          }),
          ["2026-08-03", "2026-08-04"],
        ),
      ];
      expect(
        (await evaluate(rows, GROUP_TRIP_ON)).violation,
        `container status ${containerStatus} must not change cover`,
      ).toBeNull();
    }
  });
});

describe("cross-booking hosts are host-only and counted once (INV-HOST-044)", () => {
  it("does not make the sibling booking's own uncovered guests this booking's problem", async () => {
    // THE FIXTURE HAS TO BE THIS SHAPE OR IT PROVES NOTHING. The source read is
    // narrowed to member-linked guest rows, so a plain non-member child on the
    // sibling is never loaded at all and could not appear here whether or not
    // the participants were marked host-only. What CAN appear is a member-linked
    // guest the rule treats as a non-member — one whose Member is archived — so
    // that is what this source carries, on a night its qualifying adult does not
    // cover.
    //
    // With `hostOnly`, this booking's answer names only its own guest. Without
    // it, the sibling's archived guest becomes an uncovered guest-night on a
    // booking that is not responsible for them, which is a stranger's name in
    // this owner's review as well as a wrong answer.
    const source = withAdult(organiserOf(TRIP), ["2026-08-03"]);
    source.guests = [
      ...(source.guests as unknown[]),
      guestRow(
        "siblings-archived-guest",
        ["2026-08-04"],
        memberRow({ id: "archived-1", archivedAt: new Date("2026-06-01") }),
      ),
      // The plain non-member guest too, on the same uncovered night. The
      // narrowing keeps this row out of the read entirely, so its absence from
      // the answer below survives BOTH mistakes: dropping the narrowing alone
      // (the row loads but stays host-only) and dropping host-only alone (the
      // archived row above appears). Only removing both puts a stranger's plain
      // guest into this booking's review, and this assertion is what says so.
      guestRow("siblings-own-kid", ["2026-08-04"]),
    ];
    const { violation } = await evaluate(
      [joinerNeedingCover(), source],
      GROUP_TRIP_ON,
    );
    expect(
      violation?.requirements.uncovered,
      "INV-HOST-044 (docs/invariants/adult-member-hosting.md): a Group Trip " +
        "host participant is host-only — their own booking's nights are that " +
        "booking's responsibility, judged when it is reconciled, and must " +
        "never become uncovered guest-nights on the booking they are covering.",
    ).toEqual([
      { guestRef: "kid", guestName: "kid Person", night: "2026-08-04" },
    ]);
    expect(violation?.requirements.uncoveredNonMemberGuestNights).toBe(1);
  });

  it("narrows the sibling guest read to member-linked rows", async () => {
    // The narrowing is a real query clause, not a post-filter, so a source
    // booking's non-member guests are never loaded at all. Asserted on the
    // `where` the loader actually issued, because the behavioural consequence
    // (they are ignored) is also true of a loader that read and then dropped
    // them — and reading them is the fan-out this bound exists to avoid.
    const { bookingWheres, db } = makeStore(
      [joinerNeedingCover(), withAdult(organiserOf(TRIP), ["2026-08-03"])],
      GROUP_TRIP_ON,
    );
    await evaluateBookingAdultMemberHosting(
      joinerNeedingCover() as never,
      db,
    );
    const groupRead = db.booking.findMany.mock.calls.find(
      ([args]: [any]) => args?.select?.guests?.where,
    );
    expect(groupRead?.[0].select.guests.where).toEqual({
      memberId: { not: null },
    });
    expect(bookingWheres.length).toBeGreaterThan(0);
  });

  it("counts a booking that is BOTH a split sibling and a Group Trip member once, under SAME_BOOKING", async () => {
    // A #738 split pair can perfectly well be inside a Group Trip. Its adult is
    // already a `SAME_BOOKING` host-only participant, and loading it again as a
    // Group Trip source would put one person in the participant list twice and
    // report the night as covered by two scopes when one booking supplied it.
    const sibling = withAdult(
      booking({
        id: "b-split-parent",
        memberId: "owner-1",
        groupBookingJoin: { groupBookingId: TRIP },
      }),
      ["2026-08-03", "2026-08-04"],
    );
    const dependent = joinerNeedingCover({
      memberId: "owner-1",
      parentBookingId: "b-split-parent",
    });
    const { violation } = await evaluate(
      [
        // One uncovered night forces a violation so the evidence is inspectable.
        { ...dependent, guests: [guestRow("kid", ["2026-08-03", "2026-08-06"])] },
        sibling,
      ],
      GROUP_TRIP_ON,
    );
    expect(
      violation?.requirements.qualifyingHostsByNight.find(
        (row) => row.night === "2026-08-03",
      )?.coveredByScopes,
      "INV-HOST-044 (docs/invariants/adult-member-hosting.md): one adult must " +
        "not be counted through two host scopes. A split sibling already " +
        "supplies cover under SAME_BOOKING and must not be re-read as a Group " +
        "Trip source.",
    ).toEqual(["SAME_BOOKING"]);
  });

  it("counts a booking that is BOTH same-owner and a Group Trip member once, under SAME_BOOKING_OWNER", async () => {
    const bothScopes = [
      policyRow({
        hostScopeSameBookingOwner: true,
        hostScopeSameGroupTrip: true,
      }),
    ];
    const source = withAdult(
      booking({
        id: "b-other-of-mine",
        memberId: "owner-1",
        groupBookingJoin: { groupBookingId: TRIP },
      }),
      ["2026-08-03", "2026-08-04"],
    );
    const { violation } = await evaluate(
      [
        joinerNeedingCover({
          memberId: "owner-1",
          guests: [guestRow("kid", ["2026-08-03", "2026-08-06"])],
        }),
        source,
      ],
      bothScopes,
    );
    expect(
      violation?.requirements.qualifyingHostsByNight.find(
        (row) => row.night === "2026-08-03",
      )?.coveredByScopes,
      "INV-HOST-044: a same-owner source is already loaded under " +
        "SAME_BOOKING_OWNER and must not be re-read as a Group Trip source.",
    ).toEqual(["SAME_BOOKING_OWNER"]);
  });

  it("still covers through the Group Trip when the same-owner scope is OFF", async () => {
    // The exclusion is keyed on the rows the same-owner loader ACTUALLY read, so
    // with that scope off it excludes nothing and the booking is picked up as a
    // Group Trip source instead. Union coverage is the same either way; what
    // changes is which scope is credited.
    const source = withAdult(
      booking({
        id: "b-other-of-mine",
        memberId: "owner-1",
        groupBookingJoin: { groupBookingId: TRIP },
      }),
      ["2026-08-03", "2026-08-04"],
    );
    const { violation } = await evaluate(
      [
        joinerNeedingCover({
          memberId: "owner-1",
          guests: [guestRow("kid", ["2026-08-03", "2026-08-06"])],
        }),
        source,
      ],
      GROUP_TRIP_ON,
    );
    expect(
      violation?.requirements.qualifyingHostsByNight.find(
        (row) => row.night === "2026-08-03",
      )?.coveredByScopes,
    ).toEqual(["SAME_GROUP_TRIP"]);
  });

  it("cannot use the booking being evaluated as its own Group Trip cover", async () => {
    // Self-exclusion belongs to the shared envelope, and it matters here: a
    // booking is in its own Group Trip, so without it every booking would be its
    // own cross-booking source and the scope would be vacuous.
    const rows = [
      joinerOf(TRIP, "b-main", {
        guests: [
          guestRow("kid", ["2026-08-03"]),
          guestRow("adult", ["2026-08-03"], memberRow()),
        ],
      }),
    ];
    const { violation } = await evaluate(rows, [
      policyRow({ hostScopeSameBooking: false, hostScopeSameGroupTrip: true }),
    ]);
    expect(violation?.affectedNights).toEqual(["2026-08-03"]);
  });
});

describe("the scope is OFF unless a club turns it on (#3038)", () => {
  it.each([
    ["explicitly false", policyRow({ hostScopeSameGroupTrip: false })],
    ["NULL on a decided row", policyRow({ hostScopeSameGroupTrip: null })],
    ["absent from the row entirely", policyRow({ hostScopeSameGroupTrip: undefined })],
  ])("takes no Group Trip cover when the scope is %s", async (_label, row) => {
    const rows = [
      joinerNeedingCover(),
      withAdult(organiserOf(TRIP), ["2026-08-03", "2026-08-04"]),
    ];
    const { violation } = await evaluate(rows, [row]);
    expect(violation?.affectedNights).toEqual(["2026-08-03", "2026-08-04"]);
    expect(violation?.requirements.enabledHostScopes).toEqual(["SAME_BOOKING"]);
  });

  it("issues NO Group Trip query at all while the scope is off", async () => {
    // Feature-OFF equivalence is about cost as well as answers: a club that has
    // not ticked the box must pay nothing for the option existing.
    const { db, bookingWheres } = makeStore(
      [joinerNeedingCover(), withAdult(organiserOf(TRIP), ["2026-08-03"])],
      [policyRow()],
    );
    await evaluateBookingAdultMemberHosting(joinerNeedingCover() as never, db);
    const namesTheTrip = bookingWheres.some((where) =>
      JSON.stringify(where).includes("groupBooking"),
    );
    expect(namesTheTrip).toBe(false);
  });

  it("produces a byte-identical violation with the scope off, group or no group", async () => {
    // The equivalence claim in its strongest form: the frozen snapshot a club on
    // the default set gets is the same whether or not the booking is in a Group
    // Trip with a qualifying adult sitting in it.
    const inATrip = await evaluate(
      [joinerNeedingCover(), withAdult(organiserOf(TRIP), ["2026-08-03", "2026-08-04"])],
      [policyRow()],
    );
    const inNoTrip = await evaluate(
      [
        booking({
          id: "b-main",
          memberId: "joiner-member-b-main",
          guests: [guestRow("kid", ["2026-08-03", "2026-08-04"])],
        }),
      ],
      [policyRow()],
    );
    expect(JSON.stringify(inATrip.violation)).toBe(
      JSON.stringify(inNoTrip.violation),
    );
  });
});

describe("the Group Trip source read is bounded (INV-HOST-044)", () => {
  it("refuses an inconclusive answer for an evidence caller when its ceiling binds", async () => {
    const siblings = Array.from({ length: 4 }, (_, index) =>
      withAdult(joinerOf(TRIP, `b-sibling-${index}`), ["2026-08-03"]),
    );
    const { db } = makeStore([joinerNeedingCover(), ...siblings], GROUP_TRIP_ON);
    await expect(
      evaluatePersistedBookingAdultMemberHostingReadOnly("b-main", db, {
        seasonYear: 2026,
        subscriptionLockoutMode: "HARD_BLOCK",
        groupTripSourceCeiling: 3,
      }),
    ).rejects.toBeInstanceOf(HostingGroupTripSourceCeilingExceededError);
  });

  it("answers normally for the same evidence caller when the ceiling does not bind", async () => {
    const siblings = Array.from({ length: 3 }, (_, index) =>
      withAdult(joinerOf(TRIP, `b-sibling-${index}`), ["2026-08-03", "2026-08-04"]),
    );
    const { db } = makeStore([joinerNeedingCover(), ...siblings], GROUP_TRIP_ON);
    const result = await evaluatePersistedBookingAdultMemberHostingReadOnly(
      "b-main",
      db,
      {
        seasonYear: 2026,
        subscriptionLockoutMode: "HARD_BLOCK",
        groupTripSourceCeiling: 3,
      },
    );
    expect(result?.violation).toBeNull();
  });

  it("bounds a WRITER's read without refusing it", async () => {
    // The writer truncates rather than throwing, and truncation errs towards the
    // rule. Proven by the `take` the loader issued rather than by building a
    // hundred-booking store.
    const { db } = makeStore(
      [joinerNeedingCover(), withAdult(organiserOf(TRIP), ["2026-08-03"])],
      GROUP_TRIP_ON,
    );
    await evaluateBookingAdultMemberHosting(joinerNeedingCover() as never, db);
    const groupRead = db.booking.findMany.mock.calls.find(([args]: [any]) =>
      JSON.stringify(args?.where ?? {}).includes("groupBooking"),
    );
    expect(groupRead?.[0].take).toBe(100);
    // And no `orderBy`, which is what tells a reader this is the writer's
    // truncating bound rather than an evidence caller's deterministic one.
    expect(groupRead?.[0].orderBy).toBeUndefined();
  });
});

describe("pre-persist Group Trip cover for a join (#3038)", () => {
  const proposedGuests = [
    { firstName: "Non", lastName: "Member", memberId: null },
  ];

  it("finds a sibling booking's adult before the joiner's booking exists", async () => {
    const { db } = makeStore(
      [withAdult(organiserOf(TRIP), ["2026-08-03", "2026-08-04"])],
      GROUP_TRIP_ON,
    );
    const violation = await evaluateProposedAdultMemberHosting(db, {
      bookingOwnerMemberId: "joining-member",
      groupBookingId: TRIP,
      lodgeId: LODGE,
      checkIn: new Date("2026-08-03T00:00:00.000Z"),
      checkOut: new Date("2026-08-05T00:00:00.000Z"),
      guests: proposedGuests,
    });
    expect(violation).toBeNull();
  });

  it("finds nothing when the party is joining no Group Trip", async () => {
    const { db } = makeStore(
      [withAdult(organiserOf(TRIP), ["2026-08-03", "2026-08-04"])],
      GROUP_TRIP_ON,
    );
    const violation = await evaluateProposedAdultMemberHosting(db, {
      bookingOwnerMemberId: "joining-member",
      lodgeId: LODGE,
      checkIn: new Date("2026-08-03T00:00:00.000Z"),
      checkOut: new Date("2026-08-05T00:00:00.000Z"),
      guests: proposedGuests,
    });
    expect(violation?.affectedNights).toEqual(["2026-08-03", "2026-08-04"]);
  });

  it("finds nothing while the club has the scope off", async () => {
    const { db } = makeStore(
      [withAdult(organiserOf(TRIP), ["2026-08-03", "2026-08-04"])],
      [policyRow()],
    );
    const violation = await evaluateProposedAdultMemberHosting(db, {
      bookingOwnerMemberId: "joining-member",
      groupBookingId: TRIP,
      lodgeId: LODGE,
      checkIn: new Date("2026-08-03T00:00:00.000Z"),
      checkOut: new Date("2026-08-05T00:00:00.000Z"),
      guests: proposedGuests,
    });
    expect(violation?.affectedNights).toEqual(["2026-08-03", "2026-08-04"]);
  });
});

describe("the non-member join writes its roster row before it asks the rule", () => {
  // STRUCTURAL, and it has to be. `GroupBookingJoin.bookingId` IS the new
  // booking's Group Trip identity, so a reconciliation running before that write
  // sees a booking in no Group Trip and supplies no cover — for the ONE
  // evaluation that decides whether the join is refused, with every later
  // evaluation of the same booking disagreeing with it. Nothing about the
  // answer's shape reveals the ordering, and a behavioural test would need the
  // whole verify-and-create transaction; the order of two statements inside one
  // function is exactly what a source assertion can state.
  const source = stripComments(
    readFileSync(
      path.resolve(process.cwd(), "src/lib/group-booking.ts"),
      "utf8",
    ),
  );
  const verify = source.slice(
    source.indexOf("export async function verifyAndCreateNonMemberJoin"),
  );

  it("claims the roster row first, and reconciles hosting afterwards", () => {
    const rosterWrite = verify.indexOf("tx.groupBookingJoin.update(");
    const reconcile = verify.indexOf(
      "reconcileAdultMemberHostingReviewWithSiblings(",
    );
    expect(rosterWrite).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(-1);
    expect(
      rosterWrite,
      "INV-HOST-043 (docs/invariants/adult-member-hosting.md): " +
        "GroupBookingJoin.bookingId IS this booking's Group Trip identity. " +
        "Reconciling hosting before that row is written evaluates the joiner " +
        "as belonging to no Group Trip, so a club with SAME_GROUP_TRIP on " +
        "refuses a join that the very next evaluation finds covered.",
    ).toBeLessThan(reconcile);
  });

  it("hands the member join's preflight the Group Trip it is joining", () => {
    // The OTHER join path, and the other half of the same rule. A member join
    // asks the hosting rule BEFORE its booking exists, so the only way it can
    // see a sibling's adult is by passing the container id it already holds. A
    // preflight that omitted it would tell the member their party is short of
    // cover and the reconciler inside the creating transaction would then find
    // it covered — the same booking answered two different ways a second apart,
    // which is a refusal nobody can explain rather than a wrong snapshot.
    const memberJoin = source.slice(
      source.indexOf("export async function joinGroupBookingAsMember"),
      source.indexOf("export async function createNonMemberJoinRequest"),
    );
    const call = memberJoin.indexOf("evaluateProposedAdultMemberHosting(");
    expect(call).toBeGreaterThan(-1);
    const args = memberJoin.slice(call, memberJoin.indexOf("guests:", call));
    expect(
      args,
      "INV-HOST-043 (docs/invariants/adult-member-hosting.md): Group Trip " +
        "identity is available PRE-PERSIST for a join, from the container the " +
        "joiner redeemed a code for. The member join must pass it, or its " +
        "preflight and its own reconciler disagree about the same party.",
    ).toContain("groupBookingId: group.id");
  });

  it("writes the roster row exactly once on that path", () => {
    // A second write would make the assertion above pass on an ordering where
    // the FIRST occurrence is a leftover and the real one still trails the
    // reconciliation.
    const occurrences = verify.split("tx.groupBookingJoin.update(").length - 1;
    expect(occurrences).toBe(1);
  });
});
