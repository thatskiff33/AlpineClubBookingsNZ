// #2576 — the `SAME_BOOKING_OWNER` host scope: which OTHER booking may supply an
// adult member, and what happens when a change takes that cover away.
//
// The owner's decision is almost entirely about a RELATIONSHIP, so most of these
// tests are about which bookings are and are not related. A test double that
// ignored the `where` clauses would pass every one of them for the wrong reason, so
// the fake store below really applies them — see `matchesWhere`. That is the whole
// reason this file does not reuse the single-row `makeDb` in
// adult-member-hosting-review.test.ts.
import { bookingsOverlap } from "@/lib/booking-night-overlap";
import { AgeTier, type MemberGuestConsentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The fake store below is deliberately I/O-free, but the shared evaluator asks the
// club for its #2543 subscription-lockout mode through the MODULE Prisma client, not
// through the injected `db`. Against the unreachable test DATABASE_URL that read
// costs ~2.7 seconds of connection retries on EVERY evaluation that has a
// member-linked participant, which is what pushed several of these tests past the
// default 5s timeout as soon as they gained a second evaluation. Stub it: the mode
// is a club setting, not part of what this file is asserting, and `HARD_BLOCK` is
// the default that makes `loadUnpaidSubscriptionMemberIds` a no-op.
vi.mock("@/lib/member-subscription-eligibility", () => ({
  peekSubscriptionLockoutMode: async () => "HARD_BLOCK",
  resolveSubscriptionLockoutMode: async () => "HARD_BLOCK",
}));

import {
  evaluateBookingAdultMemberHosting,
  evaluatePersistedBookingAdultMemberHostingReadOnly,
  enqueueHostingCoverageReevaluationForMember,
  reconcileSameOwnerCoverageIncident,
  reconcileAdultMemberHostingReviewWithSiblings,
  hostingCoverageActorOptions,
  isHostingCoverageSourceBookingTerminal,
  loadSameOwnerCoverageDependentIds,
} from "@/lib/adult-member-hosting-review";
import { HostingSameOwnerSourceCeilingExceededError } from "@/lib/adult-member-hosting-coverage-ceilings";
import { hostingCoverageStateKey } from "@/lib/adult-member-hosting-coverage-incidents";
import { HostingCoverageParticipantRetryError } from "@/lib/adult-member-hosting-queue-participants";
import { reconcileHostingReviewForSystemCancellation } from "@/lib/adult-member-hosting-system-cancellation";
import { AdultMemberHostingRequiredError } from "@/lib/adult-member-hosting-refusal";

/**
 * #3123 — the club's day now arrives at these lock-bound entry points as a
 * REQUIRED argument, resolved by the caller outside its transaction
 * (`INV-LOCK-004`). This is the same day the frozen clock's default instant
 * produced before the migration, so every assertion below is unchanged.
 */
const CLUB_TODAY_DATE_ONLY = new Date("2026-07-01T00:00:00.000Z");
import {
  SameOwnerCoverageOverrideRequiredError,
  SameOwnerCoverageWouldBreakError,
  buildSameOwnerCoverageOverrideRequiredBody,
  formatStrandedCoverageMessage,
  hostingCoverageOverrideSchema,
  readHostingCoverageOverride,
  sameBookingOwnerCoverageSourceWhere,
  sameOwnerCoverageDependentOverStayUnionWhere,
  sameOwnerCoverageDependentWhere,
  strandedCoverageReference,
  dependentNeedsOwnQueueItem,
  strandedCoverageStateKey,
} from "@/lib/adult-member-hosting-same-owner";
import {
  describeHostingCoverageIncidentCause,
  LINKED_MOVE_DECLINED_INCIDENT_REASON,
} from "@/lib/adult-member-hosting-coverage-incidents";

const LODGE = "lodge-a";
const OTHER_LODGE = "lodge-b";

/** A club-wide policy row. `ENFORCED` + both scopes unless overridden. */
function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "policy-club",
    scopeKey: "club-wide",
    lodgeId: null,
    mode: "ENFORCED",
    capacityMode: "NO_HOLD",
    version: 7,
    hostScopeSameBooking: true,
    hostScopeSameBookingOwner: true,
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
    nights: nights.map((night) => ({ stayDate: new Date(`${night}T00:00:00.000Z`) })),
    member,
  };
}

type FakeBooking = Record<string, unknown>;

/**
 * A booking row with every column the coverage predicates read, plus the three the
 * owner's decision says must NOT link bookings (`createdById`, `memberEmail`,
 * `familyGroupId`). They are here so the "does not link" tests can set them
 * identically on two rows and still expect no coverage — a store that did not carry
 * them could not tell the difference between "the predicate ignores this column"
 * and "the column was never there".
 */
function booking(overrides: FakeBooking = {}): FakeBooking {
  return {
    id: "b-main",
    memberId: "owner-1",
    parentBookingId: null,
    // #3038 added these two to `BOOKING_HOSTING_SELECT`, so production hands the
    // identity resolver whatever the row carries. A fixture that omitted them
    // would hand it `undefined` — benign today, since undefined and null both
    // resolve to "no Group Trip", and exactly the silent-omission shape
    // `GroupTripIdentityRow` is required-and-nullable to prevent. Modelled here
    // so this file's store keeps matching the select it is standing in for.
    groupBookingAsOrganiser: null,
    groupBookingJoin: null,
    lodgeId: LODGE,
    status: "CONFIRMED",
    deletedAt: null,
    createdById: "admin-1",
    memberEmail: "owner@example.test",
    familyGroupId: "family-1",
    checkIn: new Date("2026-07-03T00:00:00.000Z"),
    checkOut: new Date("2026-07-05T00:00:00.000Z"),
    adultMemberHostingReview: null,
    adultMemberHostingReviewStatus: null,
    guests: [],
    ...overrides,
  };
}

/**
 * Apply a Prisma-shaped `where` to a plain row.
 *
 * Supports exactly the operators the coverage predicates use — equality, `not`,
 * `in`, `notIn`, `lt`, `gt`, `gte`, the `guests: { some: ... }` relation filter, and
 * a top-level `OR` — and THROWS on anything else. Throwing rather than ignoring is
 * deliberate: a clause this fake silently skipped would make a "not related" test
 * pass while the production query related the two bookings.
 *
 * `gte` and `some` are here for the §8 member fan-out, which asks a different
 * question from the coverage predicates: not "which of this owner's bookings overlap"
 * but "which live current-or-future bookings does this PERSON attend".
 */
function matchesWhere(row: FakeBooking, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      const clauses = condition as Array<Record<string, unknown>>;
      if (!clauses.some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    // #3232: the union dependent envelope composes its two night-overlap tests as
    // `AND: [{ OR: [ ... ] }]`, because a flat spread of two objects that both set
    // `checkIn` and `checkOut` would silently keep only one of them. Before this
    // arm the fake THREW on the array, which is the behaviour that matters most —
    // an unknown clause must never be silently skipped, or a "not related" test
    // would pass while the real query related the two bookings.
    if (key === "AND") {
      const clauses = condition as Array<Record<string, unknown>>;
      if (!clauses.every((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    const value = row[key];
    if (condition === null || typeof condition !== "object") {
      if (value !== condition) return false;
      continue;
    }
    // `guests: { some: { memberId } }` — the relation filter the member fan-out uses
    // to find the bookings one person actually ATTENDS. Ownership is a different
    // column and deliberately not consulted here (#2576 §2: ownership is never
    // attendance evidence).
    if (key === "guests" && "some" in (condition as Record<string, unknown>)) {
      const some = (condition as { some: Record<string, unknown> }).some;
      const guests = (value ?? []) as Array<Record<string, unknown>>;
      if (!guests.some((guest) => matchesWhere(guest, some))) return false;
      continue;
    }
    const operators = condition as Record<string, unknown>;
    for (const [operator, operand] of Object.entries(operators)) {
      switch (operator) {
        case "gte":
          if (!((value as Date) >= (operand as Date))) return false;
          break;
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
        default:
          throw new Error(`fake store cannot apply operator ${operator}`);
      }
    }
  }
  return true;
}

/**
 * A whole club behind one fake client: bookings that answer the real predicates,
 * a policy row, a lodge name, an incident table and a re-evaluation queue.
 */
function makeStore(
  rows: FakeBooking[],
  options: {
    policies?: unknown[];
    incidents?: Array<{ id: string; bookingId: string; stateKey: string }>;
  } = {},
) {
  const byId = new Map(rows.map((row) => [row.id as string, { ...row }]));
  const queued: Array<Record<string, unknown>> = [];
  const incidents = [...(options.incidents ?? [])];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

  const db = {
    $executeRaw: vi.fn(async (_query: unknown, actorMemberId?: string) =>
      actorMemberId === "missing-officer" ? 0 : 1,
    ),
    booking: {
      findUnique: vi.fn(async ({ where }: any) => byId.get(where.id) ?? null),
      findMany: vi.fn(async ({ where, select, orderBy, take }: any) => {
        let matched = [...byId.values()].filter((row) => matchesWhere(row, where));
        // ORDER THEN TRUNCATE, in that sequence, because that is what a bounded read
        // does and the whole point of the dependent reads' `orderBy` is that the
        // truncation is reproducible. A fake that truncated in insertion order could
        // not tell a deterministic ceiling from an arbitrary one.
        if (Array.isArray(orderBy)) {
          for (const clause of [...orderBy].reverse()) {
            const [field, direction] = Object.entries(clause)[0] as [string, string];
            matched = [...matched].sort((left, right) => {
              const a = left[field] as never;
              const b = right[field] as never;
              const cmp = a < b ? -1 : a > b ? 1 : 0;
              return direction === "desc" ? -cmp : cmp;
            });
          }
        }
        if (typeof take === "number") matched = matched.slice(0, take);
        // The same-owner SOURCE read narrows the guest relation to member-linked
        // rows. Honour it: a fake that returned non-member guests too would hide a
        // loader that had stopped narrowing.
        const guestWhere = select?.guests?.where;
        if (!guestWhere) return matched;
        return matched.map((row) => ({
          ...row,
          guests: (row.guests as Array<Record<string, unknown>>).filter((guest) =>
            matchesWhere(guest, guestWhere),
          ),
        }));
      }),
      update: vi.fn(async ({ where, data }: any) => {
        Object.assign(byId.get(where.id)!, data);
        updates.push({ id: where.id, data });
        return {};
      }),
      count: vi.fn(async ({ where }: any) =>
        [...byId.values()].filter((row) => matchesWhere(row, where)).length,
      ),
    },
    adultMemberHostingPolicy: {
      findMany: vi.fn().mockResolvedValue(options.policies ?? [policyRow()]),
    },
    lodge: { findFirst: vi.fn().mockResolvedValue({ name: "Ruapehu Lodge" }) },
    member: {
      // #2597: the participant fence takes FOR KEY SHARE NOWAIT and then
      // re-reads those exact Member rows, requiring every one to exist in
      // sorted id order. This double must model a real Member table for that
      // check to mean anything — returning `[]` would make the fence report
      // contention on every call, which is how these suites previously ran
      // with the fence effectively disabled.
      findMany: vi.fn(async ({ where }: any) => {
        const ids: string[] = where?.id?.in ?? [];
        return [...ids].sort().map((id) => ({ id }));
      }),
      findUnique: vi.fn(async ({ where }: any) => ({ id: where.id })),
    },
    hostingCoverageIncident: {
      findMany: vi.fn(async ({ where }: any) =>
        incidents.filter((incident) =>
          Array.isArray(where.bookingId?.in)
            ? where.bookingId.in.includes(incident.bookingId)
            : true,
        ),
      ),
      findFirst: vi.fn(async ({ where }: any) =>
        incidents.find((incident) => incident.bookingId === where.bookingId) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const created = { id: `incident-${incidents.length + 1}`, ...data };
        incidents.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        Object.assign(incidents.find((row: any) => row.id === where.id)!, data);
        return {};
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matched = (incidents as any[]).filter(
          (row) =>
            (where.id === undefined || row.id === where.id) &&
            (where.bookingId === undefined || row.bookingId === where.bookingId) &&
            (where.resolvedAt !== null || row.resolvedAt == null) &&
            (where.NOT?.notifiedStateKey === undefined ||
              row.notifiedStateKey !== where.NOT.notifiedStateKey),
        );
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      }),
    },
    hostingCoverageReevaluation: {
      create: vi.fn(async ({ data }: any) => {
        queued.push({ id: `queue-${queued.length + 1}`, attempts: 0, ...data });
        return { id: `queue-${queued.length}` };
      }),
      findMany: vi.fn(async ({ take }: any) =>
        queued
          .filter((item) => item.processedAt == null)
          .slice(0, take)
          .map((item) => ({ ...item })),
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = queued.find((item) => item.id === where.id);
        if (!row || row.processedAt != null) return { count: 0 };
        if (where.attempts !== undefined && row.attempts !== where.attempts) {
          return { count: 0 };
        }
        for (const [key, value] of Object.entries(data)) {
          row[key] =
            value && typeof value === "object" && "increment" in (value as any)
              ? (row[key] as number) + (value as any).increment
              : value;
        }
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  } as any;

  db.__rows = byId;
  return { db, queued, incidents, updates, rowFor: (id: string) => byId.get(id)! };
}

/** The main booking: two non-member guest-nights, nobody on it to host them. */
function mainWithTwoUncoveredNights(overrides: FakeBooking = {}) {
  return booking({
    guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
    ...overrides,
  });
}

/** A source booking with a qualifying adult member attending `nights`. */
function sourceWithAdult(
  id: string,
  nights: string[],
  overrides: FakeBooking = {},
) {
  return booking({
    id,
    checkIn: new Date(`${nights[0]}T00:00:00.000Z`),
    checkOut: new Date(
      new Date(`${nights[nights.length - 1]}T00:00:00.000Z`).getTime() + 86400000,
    ),
    guests: [guestRow("adult", nights, memberRow({ id: `adult-${id}` }))],
    ...overrides,
  });
}

async function uncoveredNights(rows: FakeBooking[], policies?: unknown[]) {
  const { db } = makeStore(rows, policies ? { policies } : {});
  const { violation } = await evaluateBookingAdultMemberHosting(
    rows[0] as never,
    db,
  );
  return violation?.affectedNights ?? [];
}

describe("persisted read-only same-owner evidence (#2376)", () => {
  it("cannot use this booking itself as SAME_BOOKING_OWNER cover", async () => {
    const rows = [
      booking({
        guests: [
          guestRow("kid", ["2026-07-03"]),
          guestRow("adult", ["2026-07-03"], memberRow()),
        ],
      }),
    ];
    const { db } = makeStore(rows, {
      policies: [
        policyRow({
          hostScopeSameBooking: false,
          hostScopeSameBookingOwner: true,
        }),
      ],
    });

    const result = await evaluatePersistedBookingAdultMemberHostingReadOnly(
      "b-main",
      db,
    );
    expect(result?.violation).toMatchObject({
      reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
      affectedNights: ["2026-07-03"],
    });
    // Read-only evidence does not join the per-owner advisory-lock cohort.
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

describe("the relationship is the exact Booking.memberId and nothing else (#2576 §1)", () => {
  it("names only the owner, the lodge, the lifecycle and the dates", () => {
    // The structural half of §1's list. Behaviour tests below prove each column is
    // not consulted; this proves none of them is even mentioned, so a future edit
    // cannot reintroduce one by adding a clause nobody tests.
    const forbidden = [
      "createdById",
      "email",
      "familyGroup",
      "parentBookingId",
      "organiser",
      "payment",
    ];
    const source = JSON.stringify(
      sameBookingOwnerCoverageSourceWhere(booking() as never),
    );
    const dependent = JSON.stringify(
      sameOwnerCoverageDependentWhere(booking() as never),
    );
    for (const column of forbidden) {
      expect(source, column).not.toContain(column);
      expect(dependent, column).not.toContain(column);
    }
    expect(Object.keys(sameOwnerCoverageDependentWhere(booking() as never)).sort())
      .toEqual([
        "checkIn",
        "checkOut",
        "deletedAt",
        "id",
        "lodgeId",
        "memberId",
        "status",
      ]);
  });

  it("keeps active pre-confirmation bookings in the dependent cohort", () => {
    const where = sameOwnerCoverageDependentWhere(booking() as never) as Record<
      string,
      unknown
    >;
    const candidate = (status: string) =>
      booking({ id: `dependent-${status}`, status });

    for (const status of [
      "PENDING",
      "PAYMENT_PENDING",
      "AWAITING_REVIEW",
      "CONFIRMED",
      "PAID",
    ]) {
      expect(matchesWhere(candidate(status), where), status).toBe(true);
    }
    for (const status of [
      "DRAFT",
      "WAITLISTED",
      "WAITLIST_OFFERED",
      "BUMPED",
      "CANCELLED",
      "COMPLETED",
    ]) {
      expect(matchesWhere(candidate(status), where), status).toBe(false);
    }
  });

  it("covers a night from another booking with the same memberId", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"]),
      ]),
    ).toEqual([]);
  });

  it("does not cover from a booking with a different memberId", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          memberId: "owner-2",
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("does not link two bookings by createdById", async () => {
    // The administrator who keyed both bookings in is the SAME person; the members
    // they were keyed in for are not. §1 says in as many words that this must not
    // relate them.
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights({ createdById: "officer-9" }),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          memberId: "owner-2",
          createdById: "officer-9",
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("does not link two bookings by matching email address", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights({ memberEmail: "shared@example.test" }),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          memberId: "owner-2",
          memberEmail: "shared@example.test",
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("does not link two bookings by Family Group membership alone", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights({ familyGroupId: "family-7" }),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          memberId: "owner-2",
          familyGroupId: "family-7",
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("does not link a parent and child booking owned by different members", async () => {
    // A group joiner's booking hangs off the organiser's. `parentBookingId` alone
    // must not relate them, and the split-sibling borrow is same-member too, so
    // NEITHER half of the rule may reach across the two accounts.
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights({ parentBookingId: "b-other" }),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          memberId: "owner-2",
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });
});

describe("the same lodge and the exact night (#2576 §4)", () => {
  it("does not cover from the same owner at a different lodge", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          lodgeId: OTHER_LODGE,
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("does not cover a night the source's adult member is not staying", async () => {
    // Overlapping stays, so the envelope clause admits the source; the per-night
    // decision still refuses, because the adult member's own guest-nights are what
    // count. This is the test that would pass on a booking-range implementation and
    // must not.
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        booking({
          id: "b-other",
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-05T00:00:00.000Z"),
          guests: [guestRow("adult", ["2026-07-04"], memberRow())],
        }),
      ]),
    ).toEqual(["2026-07-03"]);
  });

  it("reports exactly the uncovered nights of a partially covered stay", async () => {
    expect(
      await uncoveredNights([
        booking({
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-06T00:00:00.000Z"),
          guests: [guestRow("kid", ["2026-07-03", "2026-07-04", "2026-07-05"])],
        }),
        sourceWithAdult("b-other", ["2026-07-04"]),
      ]),
    ).toEqual(["2026-07-03", "2026-07-05"]);
  });

  it("records which scope covered each night in the evidence (#2576 §5)", async () => {
    const rows = [
      booking({
        checkIn: new Date("2026-07-03T00:00:00.000Z"),
        checkOut: new Date("2026-07-06T00:00:00.000Z"),
        guests: [
          guestRow("kid", ["2026-07-03", "2026-07-04", "2026-07-05"]),
          // On the booking itself, so 07-05 is same-booking cover.
          guestRow("own-adult", ["2026-07-05"], memberRow({ id: "adult-own" })),
        ],
      }),
      sourceWithAdult("b-other", ["2026-07-04"]),
    ];
    const { db } = makeStore(rows);
    const { violation } = await evaluateBookingAdultMemberHosting(
      rows[0] as never,
      db,
    );
    const byNight = new Map(
      violation!.requirements.qualifyingHostsByNight.map((row) => [
        row.night,
        row.coveredByScopes,
      ]),
    );
    expect(byNight.get("2026-07-03")).toEqual([]);
    expect(byNight.get("2026-07-04")).toEqual(["SAME_BOOKING_OWNER"]);
    expect(byNight.get("2026-07-05")).toEqual(["SAME_BOOKING"]);
    expect(violation!.affectedNights).toEqual(["2026-07-03"]);
  });
});

describe("who may host, and ownership is never attendance (#2576 §2)", () => {
  it("accepts a qualifying adult member who is not the booking owner", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        booking({
          id: "b-other",
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-05T00:00:00.000Z"),
          // A friend of the family, not the account holder.
          guests: [
            guestRow(
              "friend",
              ["2026-07-03", "2026-07-04"],
              memberRow({ id: "adult-friend" }),
            ),
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it("refuses a source booking that has no attending adult member", async () => {
    // Owned by an adult member, and that is all. §2: "booking ownership by itself is
    // never attendance evidence."
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        booking({
          id: "b-other",
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-05T00:00:00.000Z"),
          guests: [guestRow("their-kid", ["2026-07-03", "2026-07-04"])],
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("refuses a source adult whose membership has lapsed or been archived", async () => {
    for (const lapse of [
      { active: false },
      { cancelledAt: new Date("2026-06-01T00:00:00.000Z") },
      { archivedAt: new Date("2026-06-01T00:00:00.000Z") },
      { ageTier: AgeTier.CHILD },
    ]) {
      expect(
        await uncoveredNights([
          mainWithTwoUncoveredNights(),
          booking({
            id: "b-other",
            checkIn: new Date("2026-07-03T00:00:00.000Z"),
            checkOut: new Date("2026-07-05T00:00:00.000Z"),
            guests: [
              guestRow(
                "adult",
                ["2026-07-03", "2026-07-04"],
                memberRow({ id: "adult-x", ...lapse }),
              ),
            ],
          }),
        ]),
        JSON.stringify(lapse),
      ).toEqual(["2026-07-03", "2026-07-04"]);
    }
  });

  it("refuses a source adult whose member-guest consent is not settled", async () => {
    // D-12: a member guest who has not accepted is not operationally present, so
    // they are not at the lodge and cannot host. Losing consent therefore removes
    // cover, which is what makes it one of §6's change classes.
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        booking({
          id: "b-other",
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-05T00:00:00.000Z"),
          guests: [
            guestRow(
              "adult",
              ["2026-07-03", "2026-07-04"],
              memberRow({ id: "adult-x" }),
              "PENDING" as MemberGuestConsentStatus,
            ),
          ],
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("never counts the source's own guest-nights as this booking's problem (§15)", async () => {
    // The adult arrives as a `hostOnly` participant, so their attendance is
    // evidence and nothing else: they are not duplicated as a guest of this
    // booking, and no bed is counted twice. A non-member guest on the SOURCE
    // booking is likewise that booking's own question.
    const rows = [
      mainWithTwoUncoveredNights(),
      booking({
        id: "b-other",
        checkIn: new Date("2026-07-03T00:00:00.000Z"),
        checkOut: new Date("2026-07-05T00:00:00.000Z"),
        guests: [
          guestRow("adult", ["2026-07-03", "2026-07-04"], memberRow()),
          guestRow("their-kid", ["2026-07-03", "2026-07-04"]),
        ],
      }),
    ];
    const { db } = makeStore(rows);
    const { violation } = await evaluateBookingAdultMemberHosting(
      rows[0] as never,
      db,
    );
    expect(violation).toBeNull();
  });
});

describe("only confirmed active attendance may supply cover (#2576 §3)", () => {
  const EXCLUDED = [
    "DRAFT",
    "PENDING",
    "PAYMENT_PENDING",
    "AWAITING_REVIEW",
    "WAITLISTED",
    "WAITLIST_OFFERED",
    "BUMPED",
    "CANCELLED",
    "COMPLETED",
  ];

  it.each(EXCLUDED)("refuses a %s source booking", async (status) => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], { status }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it.each(["CONFIRMED", "PAID"])("accepts a %s source booking", async (status) => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], { status }),
      ]),
    ).toEqual([]);
  });

  it("refuses an archived (soft-deleted) source booking", async () => {
    expect(
      await uncoveredNights([
        mainWithTwoUncoveredNights(),
        sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"], {
          deletedAt: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ]),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });
});

describe("the scope is opt-in (#2576 §12, §13)", () => {
  it("ignores another same-owner booking while the scope is off", async () => {
    expect(
      await uncoveredNights(
        [
          mainWithTwoUncoveredNights(),
          sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"]),
        ],
        [policyRow({ hostScopeSameBookingOwner: false })],
      ),
    ).toEqual(["2026-07-03", "2026-07-04"]);
  });

  it("still satisfies the policy from the same booking with the scope off", async () => {
    expect(
      await uncoveredNights(
        [
          booking({
            guests: [
              guestRow("kid", ["2026-07-03", "2026-07-04"]),
              guestRow("adult", ["2026-07-03", "2026-07-04"], memberRow()),
            ],
          }),
        ],
        [policyRow({ hostScopeSameBookingOwner: false })],
      ),
    ).toEqual([]);
  });

  it("costs no same-owner query while the scope is off", async () => {
    const rows = [
      mainWithTwoUncoveredNights(),
      sourceWithAdult("b-other", ["2026-07-03", "2026-07-04"]),
    ];
    const { db } = makeStore(rows, {
      policies: [policyRow({ hostScopeSameBookingOwner: false })],
    });
    await evaluateBookingAdultMemberHosting(rows[0] as never, db);
    // One read only: the split-sibling borrow, which predates this scope.
    expect(db.booking.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("a change that would strand another booking (#2576 §6, §7, §14)", () => {
  /** The nights `b-main`'s non-member child stays in the pair below. */
  const KID_NIGHTS_FOR_STRANDING = ["2026-07-03", "2026-07-04"];

  /**
   * What `b-source` is left carrying once the adult member has gone: a MEMBER child.
   *
   * Deliberately a member rather than a plain guest, so `b-source` has no uncovered
   * non-member guest-night of its OWN. Otherwise #2569's enforced refusal fires for
   * `b-source` itself before the same-owner question is ever reached, and every test
   * below would pass on the wrong error.
   */
  const REMAINING_MEMBER_CHILD = guestRow(
    "their-child",
    ["2026-07-03", "2026-07-04"],
    memberRow({ id: "member-child", ageTier: AgeTier.CHILD }),
  );

  /**
   * The account holds two bookings at one lodge over the same two nights: `b-main`
   * carries a non-member child, `b-source` carries the adult member covering them.
   * Removing the adult from `b-source` is the shape §6 is about.
   */
  function strandingPair(sourceGuests: Array<Record<string, unknown>>) {
    return [
      booking({
        id: "b-source",
        guests: sourceGuests,
      }),
      booking({
        id: "b-main",
        guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
      }),
    ];
  }

  it("refuses an ordinary member's change and names their own booking and nights", async () => {
    const rows = strandingPair([REMAINING_MEMBER_CHILD]);
    const { db, queued } = makeStore(rows);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({ vacatedRange: null, actorRole: "MEMBER", actorMemberId: "owner-1" }),
      ),
    ).rejects.toBeInstanceOf(SameOwnerCoverageWouldBreakError);

    // Nothing was queued: the throw rolls the caller's transaction back, so a queue
    // row would describe work for a change that never happened.
    expect(queued).toEqual([]);

    // Caught rather than asserted through `rejects`, because the body of the
    // refusal — the member's own bookings, lodge and nights — is the point.
    let error: SameOwnerCoverageWouldBreakError | null = null;
    try {
      await reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          // #3232: this fixture's change does not move a stay.
          vacatedRange: null,
          actorRole: "MEMBER",
          actorMemberId: "owner-1",
        }),
      );
    } catch (err) {
      error = err as SameOwnerCoverageWouldBreakError;
    }
    expect(error).toBeInstanceOf(SameOwnerCoverageWouldBreakError);
    if (error === null) throw new Error("unreachable");
    expect(error.status).toBe(409);
    expect(error.code).toBe("SAME_OWNER_COVERAGE_WOULD_BREAK");
    expect(error.stranded).toHaveLength(1);
    expect(error.stranded[0]).toMatchObject({
      bookingId: "b-main",
      lodgeName: "Ruapehu Lodge",
      nights: ["2026-07-03", "2026-07-04"],
    });
    expect(error.message).toContain(
      "This change would leave another booking on your account without the " +
        "required adult member coverage",
    );
    expect(error.message).toContain("Ruapehu Lodge");
  });

  it("allows a member's change that leaves alternative coverage (§14)", async () => {
    const rows = [
      ...strandingPair([guestRow("nobody", ["2026-07-03"])]),
      // A SECOND eligible source still covering both nights.
      sourceWithAdult("b-spare", ["2026-07-03", "2026-07-04"]),
    ];
    const { db, queued } = makeStore(rows);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({ vacatedRange: null, actorRole: "MEMBER", actorMemberId: "owner-1" }),
      ),
    ).resolves.toBeTruthy();
    // Existential coverage: nothing stranded, nothing to settle, no queue row, so
    // no incident and no misleading loss-of-cover email.
    expect(queued).toEqual([]);
  });

  it("does not refuse over a hazard the change did not cause", async () => {
    // `b-main` is uncovered before and after: an unrelated edit to `b-source` cannot
    // fix it, so refusing would trap the member on every future edit.
    const rows = [
      booking({ id: "b-source", guests: [REMAINING_MEMBER_CHILD] }),
      booking({
        id: "b-main",
        guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
        adultMemberHostingReviewStatus: "PENDING",
        adultMemberHostingReview: {
          reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
          policyId: "policy-club",
          policyVersion: 7,
          affectedNights: ["2026-07-03", "2026-07-04"],
          requirements: {
            uncovered: [
              { guestRef: "kid", guestName: "kid Person", night: "2026-07-03" },
              { guestRef: "kid", guestName: "kid Person", night: "2026-07-04" },
            ],
          },
        },
      }),
    ];
    const { db } = makeStore(rows);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({ vacatedRange: null, actorRole: "MEMBER", actorMemberId: "owner-1" }),
      ),
    ).resolves.toBeTruthy();
  });

  it("does not refuse over a hazard recorded ONLY on an open incident", async () => {
    // The sibling of the test above, and a DIFFERENT branch of the same comparison.
    // A dependent whose cover was removed by an officer last week carries an open
    // INCIDENT, and its review snapshot may have been cleared or reset since — the
    // incident is what survives a review reset, which is the whole reason it exists
    // as a separate row. Refusing today's unrelated member edit over it would trap
    // them exactly as the stored-snapshot case would.
    //
    // Mutation-found: dropping the incident half of the comparison left every other
    // test in this file green.
    const rows = [
      booking({ id: "b-source", guests: [REMAINING_MEMBER_CHILD] }),
      booking({
        id: "b-main",
        guests: [guestRow("kid", KID_NIGHTS_FOR_STRANDING)],
      }),
    ];
    const { db } = makeStore(rows);
    // Evaluate the dependent exactly as the reconciler will, so the seeded incident
    // carries the key its CURRENT uncovered state produces — an independently
    // written literal would only prove the two happened to differ.
    const { violation } = await evaluateBookingAdultMemberHosting(
      rows[1] as never,
      db,
    );
    expect(violation).not.toBeNull();
    const seeded = makeStore(rows, {
      incidents: [
        {
          id: "incident-1",
          bookingId: "b-main",
          stateKey: hostingCoverageStateKey(violation!),
        },
      ],
    });
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        seeded.db,
        hostingCoverageActorOptions({ vacatedRange: null, actorRole: "MEMBER", actorMemberId: "owner-1" }),
      ),
    ).resolves.toBeTruthy();
    // The change is permitted, AND the standing incident is still queued for
    // re-examination — that arm is what closes it if cover ever comes back.
    expect(seeded.queued).toHaveLength(1);
  });

  it("allows an officer's change and records the bounded work instead (§7, §8)", async () => {
    const rows = strandingPair([REMAINING_MEMBER_CHILD]);
    const first = makeStore(rows);
    const prompt = await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      first.db,
      hostingCoverageActorOptions({ vacatedRange: null, actorRole: "ADMIN", actorMemberId: "officer-1" }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(prompt).toBeInstanceOf(SameOwnerCoverageOverrideRequiredError);
    if (!(prompt instanceof SameOwnerCoverageOverrideRequiredError)) {
      throw new Error("expected the first attempt to return an override prompt");
    }
    const { db, queued } = makeStore(rows);
    await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      db,
      hostingCoverageActorOptions({
        // #3232: this fixture's change does not move a stay.
        vacatedRange: null,
        actorRole: "ADMIN",
        actorMemberId: "officer-1",
        override: {
          acknowledged: true,
          reason: "Member rang; taking the adult off at their request",
          strandedStateKey: prompt.strandedStateKey,
        },
      }),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      memberId: "owner-1",
      lodgeId: LODGE,
      cause: "OFFICER_OVERRIDE",
      actorMemberId: "officer-1",
      sourceBookingId: "b-source",
    });
    // Bounded to the nights this booking actually touched (§10).
    expect(queued[0].nights).toEqual(["2026-07-03", "2026-07-04"]);
    expect(queued[0].reason).toContain("Member rang");
    // NO AUTOMATIC CANCELLATION anywhere (§7, §16): nothing wrote a booking status.
    expect(
      db.booking.update.mock.calls.some((call: any) => "status" in call[0].data),
    ).toBe(false);
  });

  it("protects a pending dependent without promising or opening a false urgent incident", async () => {
    const rows = strandingPair([REMAINING_MEMBER_CHILD]);
    rows[1] = booking({
      ...rows[1],
      id: "b-main",
      status: "PENDING",
      guests: [guestRow("kid", KID_NIGHTS_FOR_STRANDING)],
    });

    const first = makeStore(rows);
    const prompt = await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      first.db,
      hostingCoverageActorOptions({ vacatedRange: null, actorRole: "ADMIN", actorMemberId: "officer-1" }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(prompt).toBeInstanceOf(SameOwnerCoverageOverrideRequiredError);
    if (!(prompt instanceof SameOwnerCoverageOverrideRequiredError)) {
      throw new Error("expected the pending dependent to require an officer override");
    }
    expect(prompt.message).not.toContain("will stay confirmed");
    expect(prompt.message).toContain("subject to the hosting check before confirmation");

    const accepted = makeStore(rows);
    await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      accepted.db,
      hostingCoverageActorOptions({
        // #3232: this fixture's change does not move a stay.
        vacatedRange: null,
        actorRole: "ADMIN",
        actorMemberId: "officer-1",
        override: {
          acknowledged: true,
          reason: "Member rang; pending booking will be reviewed before confirmation",
          strandedStateKey: prompt.strandedStateKey,
        },
      }),
    );
    expect(accepted.queued).toHaveLength(1);

    const incident = await reconcileSameOwnerCoverageIncident(
      {
        bookingId: "b-main",
        cause: "OFFICER_OVERRIDE",
        actorMemberId: "officer-1",
        reason: "Member rang; pending booking will be reviewed before confirmation",
      },
      accepted.db,
    );
    expect(incident.action).toBe("none");
    expect(accepted.incidents).toEqual([]);
    expect(rowFromStore(accepted.db, "b-main")).toMatchObject({
      status: "PENDING",
      adultMemberHostingReviewStatus: "PENDING",
    });
  });

  it("refuses to record an officer override with no reason (§7)", async () => {
    const rows = strandingPair([REMAINING_MEMBER_CHILD]);
    const { db, queued } = makeStore(rows);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings("b-source", db, {
        dependentCoverage: "ESCALATE",
        coverageChange: { cause: "OFFICER_OVERRIDE", actorMemberId: "officer-1" },
      }),
    ).rejects.toThrow(/requires an explicit reason/);
    expect(queued).toEqual([]);
  });

  it("asks an officer to confirm an unexplained change rather than taking it (§7)", () => {
    // §7 requires the override to carry an explicit confirmation AND a mandatory
    // reason. An officer surface that captured neither has not taken an override, so
    // it is ASKED for one — which is the only way the reason can exist. Recording it
    // as an override with an invented reason, or as an anonymous system change
    // indistinguishable from a cron sweep, were both worse answers, and the second is
    // what this helper used to do: OFFICER_OVERRIDE and the incident's
    // `overrideReason` / `overriddenByMemberId` columns were unreachable outside
    // tests, because no caller ever supplied a reason.
    expect(
      hostingCoverageActorOptions({ vacatedRange: null, actorRole: "ADMIN", actorMemberId: "officer-1" }),
    ).toEqual({
      dependentCoverage: "REQUIRE_OVERRIDE",
      coverageActorMemberId: "officer-1",
      // #3232: the vacated window travels with the disposition, so the dependent
      // fan-out can look at where the booking WAS as well as where it now is.
      coverageChangeVacatedRange: null,
      coverageChange: {
        cause: "SYSTEM_CHANGE",
        actorMemberId: "officer-1",
        reason: null,
      },
    });
    // Half an override is not an override, in either direction.
    for (const half of [
      { acknowledged: true },
      { reason: "Member rang about it" },
      { acknowledged: false, reason: "Member rang about it" },
      { acknowledged: true, reason: "   " },
      {
        acknowledged: true,
        reason: "Member rang about it",
        strandedStateKey: "",
      },
    ]) {
      expect(
        hostingCoverageActorOptions({
          // #3232: this fixture's change does not move a stay.
          vacatedRange: null,
          actorRole: "ADMIN",
          actorMemberId: "officer-1",
          override: half as never,
        }).dependentCoverage,
        JSON.stringify(half),
      ).toBe("REQUIRE_OVERRIDE");
    }
    // A complete one is, and it records who and why.
    expect(
      hostingCoverageActorOptions({
        // #3232: this fixture's change does not move a stay.
        vacatedRange: null,
        actorRole: "ADMIN",
        actorMemberId: "officer-1",
        override: {
          acknowledged: true,
          reason: "Member rang about it",
          strandedStateKey: `v1:${"a".repeat(64)}`,
        },
      }),
    ).toEqual({
      dependentCoverage: "ESCALATE",
      coverageActorMemberId: "officer-1",
      // #3232: the vacated window travels with every disposition, not only BLOCK.
      coverageChangeVacatedRange: null,
      coverageChange: {
        cause: "OFFICER_OVERRIDE",
        actorMemberId: "officer-1",
        reason: "Member rang about it",
        strandedStateKey: `v1:${"a".repeat(64)}`,
      },
    });
    expect(
      hostingCoverageActorOptions({ vacatedRange: null, actorRole: "MEMBER", actorMemberId: "owner-1" })
        .dependentCoverage,
    ).toBe("BLOCK");
    // A delegated bookings-edit permission is officer authority too.
    expect(
      hostingCoverageActorOptions({
        // #3232: this fixture's change does not move a stay.
        vacatedRange: null,
        actorRole: "MEMBER",
        hasBookingsEditAccess: true,
      }).dependentCoverage,
    ).toBe("REQUIRE_OVERRIDE");
  });

  it("shows the officer what would be stranded instead of silently allowing it (§7)", async () => {
    const { db, queued } = makeStore(strandingPair([REMAINING_MEMBER_CHILD]));
    // Resolve-or-reject captured explicitly, then narrowed with `instanceof`. A bare
    // `.catch(err => err as ...)` types the result as the UNION of the outcome and the
    // error, so `error.stranded` does not exist on it — and casting the union away
    // would have let a version of this that stopped throwing pass with `undefined`.
    const thrown = await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      db,
      hostingCoverageActorOptions({ vacatedRange: null, actorRole: "ADMIN", actorMemberId: "officer-1" }),
    ).then(
      () => null,
      (err: unknown) => err,
    );
    if (!(thrown instanceof SameOwnerCoverageOverrideRequiredError)) {
      throw new Error(
        `expected the officer to be asked to confirm the override, got ${String(thrown)}`,
      );
    }
    const error = thrown;
    // Rolled back with the change, so nothing was recorded for a change that did not
    // happen.
    expect(queued).toEqual([]);
    // And the prompt identifies the affected bookings and nights, which is the item
    // on §7's list an officer cannot act on without.
    expect(error.stranded).toEqual([
      {
        bookingId: "b-main",
        reference: expect.any(String),
        lodgeName: "Ruapehu Lodge",
        nights: ["2026-07-03", "2026-07-04"],
        // #3232: the dependent's OWN stay, which the linked-move offer proposes
        // new dates for. Its uncovered nights above are a subset of it.
        checkIn: "2026-07-03",
        checkOut: "2026-07-05",
      },
    ]);
    const body = buildSameOwnerCoverageOverrideRequiredBody(error);
    expect(body.code).toBe("SAME_OWNER_COVERAGE_OVERRIDE_REQUIRED");
    expect(body.requiresOverrideReason).toBe(true);
    expect(body.strandedStateKey).toBe(error.strandedStateKey);
    expect(body.strandedStateKey).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(body.strandedBookings[0]?.nights).toEqual(["2026-07-03", "2026-07-04"]);
    expect(body.error).toContain(
      "affected booking's lifecycle, existing bed allocation and payment records " +
        "will remain unchanged",
    );
    expect(body.error).toContain(
      "If it is already confirmed, it will be raised as an urgent " +
        "hosting-compliance incident",
    );
    expect(body.error).toContain(
      "otherwise, it remains subject to the hosting check before confirmation",
    );
    expect(body.error).not.toContain("will stay confirmed");
  });

  it("re-prompts instead of overriding when the exact stranded set changed", async () => {
    const original = makeStore(strandingPair([REMAINING_MEMBER_CHILD]));
    const first = await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      original.db,
      hostingCoverageActorOptions({ vacatedRange: null, actorRole: "ADMIN", actorMemberId: "officer-1" }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    if (!(first instanceof SameOwnerCoverageOverrideRequiredError)) {
      throw new Error("expected the first attempt to return an override prompt");
    }

    const changedRows = [
      booking({ id: "b-source", guests: [REMAINING_MEMBER_CHILD] }),
      booking({ id: "b-main", guests: [guestRow("kid", ["2026-07-03"])] }),
    ];
    const changed = makeStore(changedRows);
    const fresh = await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      changed.db,
      hostingCoverageActorOptions({
        // #3232: this fixture's change does not move a stay.
        vacatedRange: null,
        actorRole: "ADMIN",
        actorMemberId: "officer-1",
        override: {
          acknowledged: true,
          reason: "Member rang; taking the adult off at their request",
          strandedStateKey: first.strandedStateKey,
        },
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(fresh).toBeInstanceOf(SameOwnerCoverageOverrideRequiredError);
    if (!(fresh instanceof SameOwnerCoverageOverrideRequiredError)) {
      throw new Error("expected changed evidence to return a fresh prompt");
    }
    expect(fresh.stranded).toMatchObject([{ nights: ["2026-07-03"] }]);
    expect(fresh.strandedStateKey).not.toBe(first.strandedStateKey);
    expect(changed.queued).toEqual([]);
    expect(changed.db.hostingCoverageIncident.findFirst).not.toHaveBeenCalled();
    expect(changed.db.hostingCoverageIncident.updateMany).not.toHaveBeenCalled();
  });

  it("does not manufacture an override or empty prompt when coverage improved to zero", async () => {
    const original = makeStore(strandingPair([REMAINING_MEMBER_CHILD]));
    const first = await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      original.db,
      hostingCoverageActorOptions({ vacatedRange: null, actorRole: "ADMIN", actorMemberId: "officer-1" }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    if (!(first instanceof SameOwnerCoverageOverrideRequiredError)) {
      throw new Error("expected the first attempt to return an override prompt");
    }

    const improved = makeStore([
      booking({ id: "b-source", guests: [REMAINING_MEMBER_CHILD] }),
      booking({
        id: "b-main",
        guests: [
          guestRow("kid", KID_NIGHTS_FOR_STRANDING),
          guestRow(
            "new-adult",
            KID_NIGHTS_FOR_STRANDING,
            memberRow({ id: "new-adult" }),
          ),
        ],
      }),
    ]);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        improved.db,
        hostingCoverageActorOptions({
          // #3232: this fixture's change does not move a stay.
          vacatedRange: null,
          actorRole: "ADMIN",
          actorMemberId: "officer-1",
          override: {
            acknowledged: true,
            reason: "Member rang; taking the adult off at their request",
            strandedStateKey: first.strandedStateKey,
          },
        }),
      ),
    ).resolves.toBeTruthy();
    expect(improved.queued).toEqual([]);
  });

  it("keys the stranded set deterministically and rejects loose override bodies", () => {
    const one = {
      bookingId: "b-main",
      reference: "BK-MAIN",
      lodgeName: "Example Lodge",
      nights: ["2026-07-04", "2026-07-03", "2026-07-03"],
      checkIn: "2026-07-03",
      checkOut: "2026-07-05",
    };
    const two = {
      bookingId: "b-second",
      reference: "BK-SECOND",
      lodgeName: "Example Lodge",
      nights: ["2026-07-05"],
      checkIn: "2026-07-05",
      checkOut: "2026-07-06",
    };
    expect(strandedCoverageStateKey([one, two])).toBe(
      strandedCoverageStateKey([
        two,
        { ...one, nights: ["2026-07-03", "2026-07-04"] },
      ]),
    );
    expect(strandedCoverageStateKey([one])).not.toBe(
      strandedCoverageStateKey([{ ...one, nights: ["2026-07-03"] }]),
    );

    const complete = {
      acknowledged: true,
      reason: "Confirmed alternate supervision plan.",
      strandedStateKey: `v1:${"b".repeat(64)}`,
    } as const;
    expect(hostingCoverageOverrideSchema.safeParse(complete).success).toBe(true);
    for (const malformed of [
      { acknowledged: true, reason: complete.reason },
      { ...complete, strandedStateKey: "not-a-state-key" },
      { ...complete, unexpectedAuthority: true },
    ]) {
      expect(hostingCoverageOverrideSchema.safeParse(malformed).success).toBe(false);
      expect(
        readHostingCoverageOverride({ hostingCoverageOverride: malformed }),
      ).toBeNull();
    }
  });

  it("never refuses an officer whose change strands nobody", async () => {
    // The confirmation is asked for only when there is something to confirm, so an
    // ordinary officer edit at an enforcing lodge is not put behind a reason prompt.
    const { db, queued } = makeStore([
      sourceWithAdult("b-source", ["2026-07-03", "2026-07-04"]),
      booking({
        id: "b-main",
        guests: [
          guestRow(
            "adult-own",
            ["2026-07-03", "2026-07-04"],
            memberRow({ id: "adult-own" }),
          ),
        ],
      }),
    ]);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({ vacatedRange: null, actorRole: "ADMIN", actorMemberId: "officer-1" }),
      ),
    ).resolves.toBeTruthy();
    expect(queued).toEqual([]);
  });

  it("escalates rather than refusing when the actor is not the booking owner (§6, §11)", async () => {
    // The guest DELETE route deliberately admits a member from ANOTHER account: a
    // member-linked guest may take their own row off somebody else's CONFIRMED or
    // PAID booking. `BLOCK`'s refusal names the OWNER's other bookings — reference,
    // lodge and exact nights — so answering it to that actor hands them another
    // account's booking details in a sentence addressed as though it were their own,
    // which §6 and §11 both forbid. It also trapped them: every remedy the message
    // offers belongs to the owner.
    const { db, queued } = makeStore(strandingPair([REMAINING_MEMBER_CHILD]));
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          // #3232: this fixture's change does not move a stay.
          vacatedRange: null,
          actorRole: "MEMBER",
          // A DIFFERENT account from `owner-1`, who owns both bookings.
          actorMemberId: "guest-member-9",
        }),
      ),
    ).resolves.toBeTruthy();
    // Allowed and escalated: the owner is emailed, the incident is raised, the
    // officer queue shows it — and the actor is told nothing about the other booking.
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      memberId: "owner-1",
      cause: "SYSTEM_CHANGE",
      actorMemberId: "guest-member-9",
    });
  });

  it("still refuses the owner's own change, and only theirs", async () => {
    // The mutation that matters for the guard above: if the ownership test were
    // dropped, or inverted, §6's block would stop working for the person it is for.
    const { db } = makeStore(strandingPair([REMAINING_MEMBER_CHILD]));
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({ vacatedRange: null, actorRole: "MEMBER", actorMemberId: "owner-1" }),
      ),
    ).rejects.toThrow(SameOwnerCoverageWouldBreakError);
    // A site that forgot to pass the actor at all fails towards escalation — an
    // allowed change plus an incident — rather than towards disclosure.
    const bare = makeStore(strandingPair([REMAINING_MEMBER_CHILD]));
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings("b-source", bare.db, {
        dependentCoverage: "BLOCK",
      }),
    ).resolves.toBeTruthy();
    expect(bare.queued).toHaveLength(1);
  });

  it("resolves the AFFECTED booking's own incident when the change fixes it (§7)", async () => {
    // The gap this closes was total. Every list the settle step computes comes from
    // `sameOwnerCoverageDependentWhere`, which excludes the booking being changed, so
    // nothing done TO an affected booking could reach its own incident: amending it
    // cleared its review row and left a `critical` stuck-state card standing against
    // a booking whose guest list plainly showed an adult member, and there is no
    // admin route, no UI action and no periodic sweep that could ever clear it.
    const { db, incidents, queued } = makeStore(
      [
        booking({
          id: "b-main",
          guests: [
            guestRow("kid", ["2026-07-03", "2026-07-04"]),
            guestRow(
              "adult-own",
              ["2026-07-03", "2026-07-04"],
              memberRow({ id: "adult-own" }),
            ),
          ],
        }),
      ],
      {
        incidents: [
          { id: "incident-1", bookingId: "b-main", stateKey: "v1:old" },
        ],
      },
    );
    await reconcileAdultMemberHostingReviewWithSiblings(
      "b-main",
      db,
      hostingCoverageActorOptions({ vacatedRange: null, actorRole: "MEMBER", actorMemberId: "owner-1" }),
    );
    expect(incidents[0]).toMatchObject({
      resolvedAt: expect.any(Date),
      resolution: "BOOKING_AMENDED",
    });
    // And the account is re-read after commit, because freeing cover can change what
    // the owner's other bookings may conclude.
    expect(queued).toHaveLength(1);
  });

  it("resolves it as CANCELLED, not AMENDED, when the stay is no longer happening (§7)", async () => {
    // The label is a fact the caller knows. Reporting a cancelled stay as amended, or
    // as `COVERAGE_RESTORED`, would tell an officer cover came back when nothing of
    // the kind happened.
    const { db, incidents } = makeStore(
      [
        booking({
          id: "b-main",
          status: "CANCELLED",
          guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
        }),
      ],
      {
        incidents: [{ id: "incident-1", bookingId: "b-main", stateKey: "v1:old" }],
      },
    );
    await reconcileAdultMemberHostingReviewWithSiblings(
      "b-main",
      db,
      hostingCoverageActorOptions({ vacatedRange: null, actorRole: "MEMBER", actorMemberId: "owner-1" }),
    );
    expect(incidents[0]).toMatchObject({ resolution: "BOOKING_CANCELLED" });
  });

  it("resolves it as EXCEPTION_APPROVED when an officer has authorised the hazard (§7)", async () => {
    // An approved exception does not REMOVE the hazard, it authorises it — so the
    // drain's "is the violation gone" test could never see it, and the next
    // reconciliation re-affirmed a critical incident against the officer's own
    // decision, permanently, with no route or UI able to clear it.
    const plain = makeStore([
      booking({
        id: "b-main",
        guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
      }),
    ]);
    // Seed the APPROVED review with the snapshot its CURRENT uncovered state
    // produces, because that is what "approved for THIS hazard" means: a snapshot
    // that no longer matches reopens as PENDING and drops the decision, which is the
    // guard that stops a stale approval suppressing a new problem.
    const { violation } = await evaluateBookingAdultMemberHosting(
      plain.rowFor("b-main") as never,
      plain.db,
    );
    const { db, incidents } = makeStore(
      [
        booking({
          id: "b-main",
          adultMemberHostingReview: violation as never,
          adultMemberHostingReviewStatus: "APPROVED",
          guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
        }),
      ],
      {
        incidents: [{ id: "incident-1", bookingId: "b-main", stateKey: "v1:old" }],
      },
    );
    await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );
    expect(incidents[0]).toMatchObject({ resolution: "EXCEPTION_APPROVED" });
  });

  it("re-affirms the incident when the approval no longer matches the hazard", async () => {
    // The mutation that matters for the test above. If the APPROVED arm ignored
    // material identity it would silence a genuinely NEW uncovered state on any
    // booking an officer had ever approved. Here the stored approval covers one
    // night and the booking now has two, so the reconciliation reopens the review as
    // PENDING and the incident is updated rather than closed.
    const { db, incidents } = makeStore(
      [
        booking({
          id: "b-main",
          adultMemberHostingReview: {
            reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
            policyId: "policy-club",
            policyVersion: 7,
            affectedNights: ["2026-07-03"],
            requirements: {
              uncovered: [
                { guestRef: "kid", guestName: "kid Person", night: "2026-07-03" },
              ],
            },
          } as never,
          adultMemberHostingReviewStatus: "APPROVED",
          guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
        }),
      ],
      {
        incidents: [{ id: "incident-1", bookingId: "b-main", stateKey: "v1:old" }],
      },
    );
    await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );
    expect(incidents[0]).not.toHaveProperty("resolution", "EXCEPTION_APPROVED");
    expect((incidents[0] as Record<string, unknown>).resolvedAt).toBeUndefined();
  });

  it("queues the resolution when a change RESTORES another booking's cover", async () => {
    // `b-main` carries an open incident and is now covered again. Even under BLOCK —
    // a member fixing the problem themselves — the incident must be re-examined, or
    // it stands forever because the fix was permitted.
    const rows = [
      sourceWithAdult("b-source", ["2026-07-03", "2026-07-04"]),
      booking({
        id: "b-main",
        guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
      }),
    ];
    const { db, queued } = makeStore(rows, {
      incidents: [{ id: "incident-1", bookingId: "b-main", stateKey: "v1:old" }],
    });
    await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      db,
      hostingCoverageActorOptions({ vacatedRange: null, actorRole: "MEMBER", actorMemberId: "owner-1" }),
    );
    expect(queued).toHaveLength(1);
  });

  it("never refuses under the review consequence, but still re-reads the dependents", async () => {
    const rows = strandingPair([REMAINING_MEMBER_CHILD]);
    const { db, queued } = makeStore(rows, {
      policies: [policyRow({ mode: "ADMIN_REVIEW_REQUIRED" })],
    });
    // An uncovered booking is a permitted state with a pending review under this
    // consequence, so neither a refusal nor an officer-facing incident is something
    // the club asked for.
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({ vacatedRange: null, actorRole: "MEMBER", actorMemberId: "owner-1" }),
      ),
    ).resolves.toBeTruthy();
    // ...but the dependent's own snapshot DOES have to be refreshed, and this is the
    // one staleness the new scope introduces that the review consequence cannot catch
    // by itself: with SAME_BOOKING alone a booking's cover can only move through its
    // own rows or its split siblings, both reconciled on every write, whereas here a
    // change to a DIFFERENT booking stranded it and nothing else will ever look.
    // Returning early left it recorded as compliant indefinitely.
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      memberId: "owner-1",
      lodgeId: LODGE,
      cause: "SYSTEM_CHANGE",
      sourceBookingId: "b-source",
    });
  });

  it("opens no incident from a review-mode re-read, however uncovered the dependent is", async () => {
    // The other half of the same rule: the queue row exists to refresh the SNAPSHOT,
    // and `reconcileSameOwnerCoverageIncident` must still open nothing while the mode
    // is not ENFORCED — doubling a normal pending review into an urgent incident
    // would double the officer's queue for a state the club merely wants to see.
    const rows = strandingPair([REMAINING_MEMBER_CHILD]);
    const { db, incidents } = makeStore(rows, {
      policies: [policyRow({ mode: "ADMIN_REVIEW_REQUIRED" })],
    });
    await expect(
      reconcileSameOwnerCoverageIncident(
        { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
        db,
      ),
    ).resolves.toEqual({ action: "none" });
    expect(incidents).toEqual([]);
  });
});

describe("privacy: the member sees their own account and nothing else (#2576 §11)", () => {
  it("names no person in the refusal, only the member's own bookings", () => {
    const message = formatStrandedCoverageMessage([
      {
        bookingId: "b-main",
        reference: "BK-ABC123",
        lodgeName: "Ruapehu Lodge",
        nights: ["2026-07-03"],
        checkIn: "2026-08-01",
        checkOut: "2026-08-03",
      },
    ]);
    expect(message).toContain("BK-ABC123");
    expect(message).toContain("Ruapehu Lodge");
    expect(message).not.toContain("adult-");
    expect(message).not.toContain("owner-");
    expect(message).not.toContain("@");
  });

  it("cannot reach a booking on another account, because the predicate cannot", () => {
    // The privacy boundary is the `where` itself rather than a filter applied
    // afterwards, which is why it is asserted here rather than on a response body.
    const where = sameOwnerCoverageDependentWhere(booking() as never) as any;
    expect(where.memberId).toBe("owner-1");
    expect(typeof where.memberId).toBe("string");
  });
});

describe("the re-evaluation bound is a property of the item (#2576 §10)", () => {
  it("reads only that owner, that lodge and those nights", async () => {
    const rows = [
      booking({ id: "b-main" }),
      booking({ id: "b-other-owner", memberId: "owner-2" }),
      booking({ id: "b-other-lodge", lodgeId: OTHER_LODGE }),
      booking({
        id: "b-other-nights",
        checkIn: new Date("2026-08-03T00:00:00.000Z"),
        checkOut: new Date("2026-08-05T00:00:00.000Z"),
      }),
    ];
    const { db } = makeStore(rows);
    expect(
      await loadSameOwnerCoverageDependentIds(
        { memberId: "owner-1", lodgeId: LODGE, nights: ["2026-07-03", "2026-07-04"] },
        db,
      ),
    ).toEqual(["b-main"]);
  });

  it("treats an item with no nights as no work", async () => {
    const { db } = makeStore([booking()]);
    expect(
      await loadSameOwnerCoverageDependentIds(
        { memberId: "owner-1", lodgeId: LODGE, nights: [] },
        db,
      ),
    ).toEqual([]);
    expect(db.booking.findMany).not.toHaveBeenCalled();
  });

  it("includes a booking arriving on the item's last night and not the morning after", async () => {
    const rows = [
      booking({
        id: "b-last-night",
        checkIn: new Date("2026-07-04T00:00:00.000Z"),
        checkOut: new Date("2026-07-05T00:00:00.000Z"),
      }),
      booking({
        id: "b-morning-after",
        checkIn: new Date("2026-07-05T00:00:00.000Z"),
        checkOut: new Date("2026-07-06T00:00:00.000Z"),
      }),
    ];
    const { db } = makeStore(rows);
    expect(
      await loadSameOwnerCoverageDependentIds(
        { memberId: "owner-1", lodgeId: LODGE, nights: ["2026-07-03", "2026-07-04"] },
        db,
      ),
    ).toEqual(["b-last-night"]);
  });
});

describe("source lifecycle resolution is independent of the bounded fan-out (#2596)", () => {
  it.each([
    "DRAFT",
    "PENDING",
    "PAYMENT_PENDING",
    "CONFIRMED",
    "PAID",
    "COMPLETED",
    "WAITLISTED",
    "WAITLIST_OFFERED",
    "AWAITING_REVIEW",
  ])("does not infer an extant %s source was cancelled", async (status) => {
    const { db } = makeStore([booking({ id: "source-active", status })]);

    await expect(
      isHostingCoverageSourceBookingTerminal("source-active", db),
    ).resolves.toBe(false);
    expect(db.booking.findUnique).toHaveBeenCalledWith({
      where: { id: "source-active" },
      select: { status: true, deletedAt: true },
    });
  });

  it.each(["CANCELLED", "BUMPED"])(
    "recognises the terminal %s lifecycle directly",
    async (status) => {
      const { db } = makeStore([booking({ id: "source-terminal", status })]);
      await expect(
        isHostingCoverageSourceBookingTerminal("source-terminal", db),
      ).resolves.toBe(true);
    },
  );

  it("recognises soft-deleted and hard-missing sources as terminal", async () => {
    const { db } = makeStore([
      booking({ id: "source-deleted", deletedAt: new Date("2026-07-02") }),
    ]);

    await expect(
      isHostingCoverageSourceBookingTerminal("source-deleted", db),
    ).resolves.toBe(true);
    await expect(
      isHostingCoverageSourceBookingTerminal("source-missing", db),
    ).resolves.toBe(true);
  });
});

/** The live booking row inside a fake store, for asserting what was written. */
function rowFromStore(db: any, id: string): Record<string, unknown> {
  return db.__rows.get(id) as Record<string, unknown>;
}

describe("settling a dependent booking after the change (#2576 §7, §14, §16)", () => {
  const KID_NIGHTS = ["2026-07-03", "2026-07-04"];

  it("takes the policy-set lock before reading policy or writing an incident", async () => {
    const { db } = makeStore([
      booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] }),
    ]);
    const order: string[] = [];
    db.$executeRaw.mockImplementation(async () => {
      order.push("policy-set-lock");
      return 1;
    });
    db.adultMemberHostingPolicy.findMany.mockImplementation(async () => {
      order.push("policy-read");
      return [policyRow()];
    });
    db.hostingCoverageIncident.create.mockImplementation(async ({ data }: any) => {
      order.push("incident-write");
      return { id: "incident-1", ...data };
    });

    await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );

    expect(order[0]).toBe("policy-set-lock");
    expect(order.indexOf("policy-set-lock")).toBeLessThan(
      order.indexOf("policy-read"),
    );
    expect(order.indexOf("policy-read")).toBeLessThan(
      order.indexOf("incident-write"),
    );
  });

  it("opens ONE urgent incident and never touches the booking's lifecycle", async () => {
    const rows = [
      booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] }),
    ];
    const { db, incidents } = makeStore(rows);
    const first = await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );
    expect(first.action).toBe("opened");
    // Idempotent: the drain is at-least-once, so the same facts must write nothing
    // the second time and must not notify again.
    const second = await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );
    expect(second.action).toBe("unchanged");
    expect(incidents).toHaveLength(1);
    // §7 and §16 both forbid automatic cancellation: beds and payments stay.
    expect(
      db.booking.update.mock.calls.some((call: any) => "status" in call[0].data),
    ).toBe(false);
    // The booking's own review IS recorded, so its page and the officer's booking
    // view agree with the incident.
    expect(rowFromStore(db, "b-main").adultMemberHostingReviewStatus).toBe("PENDING");
  });

  it("puts a declined offer's reason in the incident's history, actorless", async () => {
    // #3232 D3, `INV-HOST-052`. The queue item already carried this reason (pinned
    // in the linked-move block below) and the drain already hands it here — and
    // this function used to DROP it, because only an officer override stored a
    // reason. So an officer reading the booking's history was shown a bare cause
    // code that also means "a qualification changed" for a decision a member had
    // deliberately made after being warned.
    //
    // THE WORDS ARE STILL OWED NOW THAT THE CAUSE NAMES THE DECISION (#3241). The
    // label says a member declined; only this sentence says they were asked about
    // THIS booking while editing another one. The history rather than a column,
    // deliberately: an audit row describes ONE event and cannot go stale, while a
    // "why" column would be left describing the decline after a later automatic
    // change moved the same incident's state.
    const rows = [
      booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] }),
    ];
    const { db } = makeStore(rows);
    const outcome = await reconcileSameOwnerCoverageIncident(
      {
        bookingId: "b-main",
        cause: "OWNER_DECLINED_LINKED_MOVE",
        reason: LINKED_MOVE_DECLINED_INCIDENT_REASON,
      },
      db,
    );
    expect(outcome.action).toBe("opened");
    // The cause reaches the stored row at all — this drives the writer directly,
    // so it pins the JOURNEY (nothing else proved `cause` reaches `create`) and
    // NOT that the declined arm chooses it. The arm itself is pinned further
    // down, where the real engine produces the queue item (#3241).
    const created = db.hostingCoverageIncident.create.mock.calls
      .map((call: any) => call[0].data)
      .at(-1);
    expect(created?.cause).toBe("OWNER_DECLINED_LINKED_MOVE");

    const opened = db.auditLog.create.mock.calls
      .map((call: any) => call[0].data)
      .find(
        (data: any) => data.action === "booking.hostingCoverage.incidentOpened",
      );
    expect(opened?.details).toBe(LINKED_MOVE_DECLINED_INCIDENT_REASON);
    // AND THE ONE-LINE SUMMARY READS AS ENGLISH, not as a schema token. This
    // sentence is the primary line on the audit-log page, so it read "after a
    // SYSTEM_CHANGE change" before #3241 and would have read "after a
    // OWNER_DECLINED_LINKED_MOVE change" after it. It renders through the one
    // wording home like both officer surfaces do; the raw label stays in
    // `metadata.cause`, where a machine reader wants it.
    expect(opened?.summary).toContain(
      describeHostingCoverageIncidentCause("OWNER_DECLINED_LINKED_MOVE"),
    );
    expect(opened?.summary).not.toContain("OWNER_DECLINED_LINKED_MOVE");
    expect(opened?.metadata?.cause).toBe("OWNER_DECLINED_LINKED_MOVE");
    // No officer is named, because none was involved. Inventing attribution is
    // the failure this arm exists to avoid.
    expect(opened?.actorMemberId ?? null).toBeNull();
  });

  it("resolves rather than opens when an alternative same-owner source covers it (§14)", async () => {
    const rows = [
      booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] }),
      sourceWithAdult("b-spare", KID_NIGHTS),
    ];
    const { db, incidents } = makeStore(rows, {
      incidents: [{ id: "incident-1", bookingId: "b-main", stateKey: "v1:old" }],
    });
    const outcome = await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );
    // No false incident, no misleading loss-of-cover email, and the standing
    // incident is closed with the reason an officer can read.
    expect(outcome.action).toBe("resolved");
    expect((incidents[0] as Record<string, unknown>).resolution).toBe(
      "COVERAGE_RESTORED",
    );
  });

  it("opens nothing for a booking the club has not confirmed", async () => {
    // The saved-card auto-charge claims PENDING -> CONFIRMED, queues this work, and
    // releases the claim if the charge fails. Arriving after that release must not
    // put a stay nobody confirmed in front of an officer as an emergency.
    for (const status of ["PENDING", "DRAFT", "AWAITING_REVIEW", "WAITLISTED"]) {
      const { db, incidents } = makeStore([
        booking({ id: "b-main", status, guests: [guestRow("kid", KID_NIGHTS)] }),
      ]);
      const outcome = await reconcileSameOwnerCoverageIncident(
        { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
        db,
      );
      expect(outcome.action, status).toBe("none");
      expect(incidents, status).toEqual([]);
    }
  });

  it("closes an incident when the club stops enforcing", async () => {
    const { db, incidents } = makeStore(
      [booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] })],
      {
        policies: [policyRow({ mode: "ADMIN_REVIEW_REQUIRED" })],
        incidents: [{ id: "incident-1", bookingId: "b-main", stateKey: "v1:old" }],
      },
    );
    const outcome = await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );
    // An incident is the ENFORCED instrument; under review mode the pending review
    // is already the officer's signal, so a row they can do nothing with is closed.
    expect(outcome.action).toBe("resolved");
    expect(incidents[0]).toMatchObject({ resolution: "COVERAGE_RESTORED" });
  });

  it("records the officer's reason on the incident it opens (§7)", async () => {
    const { db, incidents } = makeStore([
      booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] }),
    ]);
    await reconcileSameOwnerCoverageIncident(
      {
        bookingId: "b-main",
        cause: "OFFICER_OVERRIDE",
        actorMemberId: "officer-1",
        reason: "Member asked us to cancel the other booking",
      },
      db,
    );
    expect(incidents[0]).toMatchObject({
      cause: "OFFICER_OVERRIDE",
      overriddenByMemberId: "officer-1",
      overrideReason: "Member asked us to cancel the other booking",
    });
  });

  it("degrades a deleted queued actor to null while preserving the mandatory reason", async () => {
    const { db, incidents } = makeStore([
      booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] }),
    ]);

    await expect(
      reconcileSameOwnerCoverageIncident(
        {
          bookingId: "b-main",
          cause: "OFFICER_OVERRIDE",
          actorMemberId: "missing-officer",
          reason: "Queued before the officer profile was deleted",
        },
        db,
      ),
    ).resolves.toMatchObject({ action: "opened" });
    expect(incidents[0]).toMatchObject({
      cause: "OFFICER_OVERRIDE",
      overriddenByMemberId: null,
      overrideReason: "Queued before the officer profile was deleted",
    });
    expect(
      db.$executeRaw.mock.calls.some((call: unknown[]) =>
        call[1] === "missing-officer",
      ),
    ).toBe(true);
    expect(db.member.findUnique).not.toHaveBeenCalled();
  });

  it("does not refuse from inside the drain, however the club is configured", async () => {
    // `reconcileSameOwnerCoverageIncident` runs post-commit against a booking that
    // is ALREADY confirmed, so there is nothing left to refuse; throwing here would
    // abort the sweep and roll back the incident it exists to record.
    const { db } = makeStore([
      booking({ id: "b-main", guests: [guestRow("kid", KID_NIGHTS)] }),
    ]);
    await expect(
      reconcileSameOwnerCoverageIncident(
        { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
        db,
      ),
    ).resolves.toMatchObject({ action: "opened" });
  });
});

describe("a change to one PERSON's standing (#2576 §8, §17)", () => {
  // §8's FIRST-NAMED change class — "membership becoming inactive, lapsed, cancelled
  // or archived" — and §17's required test that "source membership lapse or archival
  // causes re-evaluation". Only the evaluator half of this existed: a lapsed or
  // archived adult correctly stops counting as a host, while nothing told the club to
  // go and look at the bookings that had been relying on them. So an archive, an
  // officer deactivation or a membership cancellation left a confirmed booking
  // silently non-compliant — no incident, no owner email, no officer-queue entry, and
  // the booking's own review snapshot still reading "compliant". There is no periodic
  // sweep to compensate; the cron drains queue rows and nothing else.
  //
  // The fan-out is driven by ATTENDANCE, not ownership (§2), so these tests set the
  // acting member up as a GUEST on bookings owned by other accounts.
  const TODAY = new Date("2026-07-01T00:00:00.000Z");

  function attendedBooking(
    id: string,
    ownerId: string,
    overrides: FakeBooking = {},
  ): FakeBooking {
    return booking({
      id,
      memberId: ownerId,
      guests: [
        guestRow(
          `adult-on-${id}`,
          ["2026-07-03", "2026-07-04"],
          memberRow({ id: "lapsing-adult" }),
        ),
      ],
      ...overrides,
    });
  }

  it("fails at the subject NOWAIT barrier before even an empty candidate read", async () => {
    const { db } = makeStore([]);
    db.$executeRaw.mockRejectedValueOnce({
      driverAdapterError: { cause: { originalCode: "55P03" } },
    });

    await expect(
      enqueueHostingCoverageReevaluationForMember("lapsing-adult", db, CLUB_TODAY_DATE_ONLY),
    ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
    expect(db.booking.findMany).not.toHaveBeenCalled();
  });

  it("records one bounded item per booking the person actually attends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    try {
      const { db, queued } = makeStore([
        // Two DIFFERENT owners, because one person's standing can strand bookings on
        // several accounts and the item has to name each booking's own owner.
        attendedBooking("b-owner-1", "owner-1"),
        attendedBooking("b-owner-2", "owner-2"),
      ]);
      const count = await enqueueHostingCoverageReevaluationForMember(
        "lapsing-adult",
        db,
        CLUB_TODAY_DATE_ONLY,
        { cause: "SYSTEM_CHANGE", actorMemberId: "officer-1" },
      );
      expect(count).toBe(2);
      // The owner/lodge/night triple every other item carries, so the drain cannot
      // widen it into the lodge-wide sweep #2575 rejected (§10).
      expect(queued).toHaveLength(2);
      expect(queued.map((item) => item.memberId).sort()).toEqual([
        "owner-1",
        "owner-2",
      ]);
      for (const item of queued) {
        expect(item).toMatchObject({
          lodgeId: LODGE,
          cause: "SYSTEM_CHANGE",
          actorMemberId: "officer-1",
          nights: ["2026-07-03", "2026-07-04"],
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a booking the person merely OWNS but does not attend (§2)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    try {
      // Ownership by itself is never attendance evidence, so a lapse cannot make a
      // booking uncovered through a column the rule does not read.
      const { db, queued } = makeStore([
        booking({
          id: "b-owned-only",
          memberId: "lapsing-adult",
          guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
        }),
      ]);
      expect(
        await enqueueHostingCoverageReevaluationForMember("lapsing-adult", db, CLUB_TODAY_DATE_ONLY),
      ).toBe(0);
      expect(queued).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a past stay and a terminal booking (§3)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    try {
      const { db, queued } = makeStore([
        // Checked out before today: a lapse cannot retroactively break a completed
        // attendance record.
        attendedBooking("b-past", "owner-1", {
          checkIn: new Date("2026-06-01T00:00:00.000Z"),
          checkOut: new Date("2026-06-03T00:00:00.000Z"),
        }),
        attendedBooking("b-cancelled", "owner-1", { status: "CANCELLED" }),
        attendedBooking("b-deleted", "owner-1", { deletedAt: TODAY }),
      ]);
      expect(
        await enqueueHostingCoverageReevaluationForMember("lapsing-adult", db, CLUB_TODAY_DATE_ONLY),
      ).toBe(0);
      expect(queued).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records nothing while the club is not enforcing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    try {
      // Incidents exist only under ENFORCED, and that rule is unchanged. Gated on the
      // consequence and NOT on the scope, deliberately: a lapse removes cover under
      // SAME_BOOKING just as surely, and the drain reconciles each booking through the
      // shared evaluator, which honours whichever scopes the lodge actually has on.
      const review = makeStore([attendedBooking("b-owner-1", "owner-1")], {
        policies: [policyRow({ mode: "ADMIN_REVIEW_REQUIRED" })],
      });
      expect(
        await enqueueHostingCoverageReevaluationForMember("lapsing-adult", review.db, CLUB_TODAY_DATE_ONLY),
      ).toBe(0);
      expect(review.queued).toEqual([]);

      const sameBookingOnly = makeStore([attendedBooking("b-owner-1", "owner-1")], {
        policies: [policyRow({ hostScopeSameBookingOwner: false })],
      });
      expect(
        await enqueueHostingCoverageReevaluationForMember(
          "lapsing-adult",
          sameBookingOnly.db,
          CLUB_TODAY_DATE_ONLY,
        ),
      ).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fences the standing subject at a club that enforces nowhere (#2623 T5)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    try {
      // #2623 T5 asked for this seam's fence to be gated on the policy. Its
      // PARTICIPANT fence already is — the per-lodge `ENFORCED` filter returns 0
      // before any proof is acquired. The subject barrier above it must NOT be:
      // it is the shared standing-subject fence every lifecycle writer reaches,
      // and account deletion relies on it to exclude a concurrent
      // booking-request linked-member hold in every mode, `DISABLED` included.
      // Real PostgreSQL refutes the gate directly — see the mode-parameterised
      // hold/deletion interleavings in
      // `adult-member-hosting-queue-merge.realdb.test.ts`.
      const { db, queued } = makeStore([attendedBooking("b-owner-1", "owner-1")], {
        policies: [policyRow({ mode: "DISABLED" })],
      });
      db.$executeRaw.mockRejectedValue({
        driverAdapterError: { cause: { originalCode: "55P03" } },
      });

      await expect(
        enqueueHostingCoverageReevaluationForMember("lapsing-adult", db, CLUB_TODAY_DATE_ONLY),
      ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expect(queued).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the participant fence is not taken for a rule the club is not using (#2623 T5)", () => {
  const TODAY = new Date("2026-07-01T00:00:00.000Z");

  function partyBooking(mode: string) {
    return makeStore(
      [
        booking({
          id: "b-main",
          memberId: "owner-1",
          guests: [
            guestRow("non-member-1", ["2026-07-03", "2026-07-04"]),
          ],
        }),
      ],
      { policies: [policyRow({ mode })] },
    );
  }

  it("does not refuse an ordinary booking write at a DISABLED lodge while a member-lifecycle writer holds the row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    try {
      const { db } = partyBooking("DISABLED");
      // A concurrent member-lifecycle writer already holds the owner's Member row,
      // so the fence's `FOR KEY SHARE NOWAIT` would come back 55P03. Before the
      // gate this turned a plain booking write into
      // `HOSTING_COVERAGE_PARTICIPANT_RETRY` — "reload before trying again, and
      // check payment status if a payment was involved" — for a rule this club has
      // switched off, guarding a queue row that would never be written.
      db.$executeRaw.mockRejectedValue({
        driverAdapterError: { cause: { originalCode: "55P03" } },
      });

      await expect(
        reconcileAdultMemberHostingReviewWithSiblings("b-main", db),
      ).resolves.toMatchObject({ mode: "DISABLED" });
      expect(db.$executeRaw).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still clears a snapshot left behind by a lodge that has since switched the rule off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    try {
      // Skipping the fence must not skip the RECONCILIATION: a review recorded
      // while the rule was on has to be cleared once it is off, which is the one
      // thing the un-fenced path still has to do.
      const { db, updates } = makeStore(
        [
          booking({
            id: "b-main",
            memberId: "owner-1",
            adultMemberHostingReviewStatus: "PENDING",
            guests: [guestRow("non-member-1", ["2026-07-03", "2026-07-04"])],
          }),
        ],
        { policies: [policyRow({ mode: "DISABLED" })] },
      );

      await expect(
        reconcileAdultMemberHostingReviewWithSiblings("b-main", db),
      ).resolves.toMatchObject({ action: "cleared" });
      expect(updates).toHaveLength(1);
      expect(updates[0].data).toMatchObject({
        adultMemberHostingReviewStatus: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fences an ADMIN_REVIEW_REQUIRED lodge, where queue work is real", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    try {
      // The gate is `hostingModeIsActive`, not `ENFORCED`: under review-only the
      // dependants still have to be re-read, so the fence is still owed.
      const { db } = partyBooking("ADMIN_REVIEW_REQUIRED");
      db.$executeRaw.mockRejectedValue({
        driverAdapterError: { cause: { originalCode: "55P03" } },
      });

      await expect(
        reconcileAdultMemberHostingReviewWithSiblings("b-main", db),
      ).rejects.toBeInstanceOf(HostingCoverageParticipantRetryError);
      expect(db.$executeRaw).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the SOURCE read gets an evidence ceiling of its own (#2376)", () => {
  /**
   * The finding this closes. The sibling fan-out was given a deterministic
   * refusing ceiling for evidence callers, and this read — the OTHER host
   * population — was left on the writer's unordered `take: 25`.
   *
   * The writer's own docblock argues correctly that truncating is safe for a
   * WRITER: fewer hosts means a night reads as uncovered, so the booking is flagged
   * or refused rather than quietly allowed. That direction INVERTS for evidence. A
   * diagnostic that misses the booking carrying the covering adult reports
   * `policy_adult_member_hosting` as a live blocker on a booking that is actually
   * covered — a fabricated finding — while `booking-evidence.ts` promises in as
   * many words that it "refuses rather than truncating". #3038 gave both source
   * reads a deterministic order, so two invocations no longer disagree about
   * WHICH 25 they saw — they still agree on a fabricated blocker, which is what
   * this ceiling is for.
   */
  const SAME_OWNER_SCOPE_ONLY = [
    policyRow({ hostScopeSameBooking: false, hostScopeSameBookingOwner: true }),
  ];

  /** The stay under test, plus `count` same-owner bookings that could cover it. */
  function makeSameOwnerStore(count: number) {
    const sources = Array.from({ length: count }, (_unused, index) =>
      booking({
        id: `b-source-${String(index).padStart(2, "0")}`,
        guests: [
          guestRow(
            `adult-${index}`,
            ["2026-07-03", "2026-07-04"],
            memberRow({ id: `member-adult-${index}` }),
          ),
        ],
      }),
    );
    return makeStore(
      [
        booking({ id: "b-main", guests: [guestRow("kid", ["2026-07-03"])] }),
        ...sources,
      ],
      { policies: SAME_OWNER_SCOPE_ONLY },
    );
  }

  /** The SOURCE read, told apart by its member-linked guest narrowing. */
  function sourceReadArgs(db: {
    booking: { findMany: { mock: { calls: [Record<string, unknown>][] } } };
  }): Record<string, unknown> | undefined {
    return db.booking.findMany.mock.calls
      .map(([args]) => args)
      .find(
        (args) =>
          (args as { select?: { guests?: { where?: unknown } } }).select?.guests
            ?.where !== undefined,
      );
  }

  it("leaves the writer's TRUNCATING bound when no ceiling is supplied", async () => {
    // The writer still truncates at 25 rather than refusing — that, and not the
    // presence of an order, is what separates it from an evidence caller.
    //
    // The order used to be deliberately absent here, on the reasoning that a
    // writer's truncation fails towards the rule so reproducibility buys it
    // nothing. #3038 corrected that: it is true of the ANSWER and false of the
    // SNAPSHOT. An unordered `take` lets Postgres return any 25 of the matching
    // rows, so `adultMemberHostingStateKey` moves between two evaluations of an
    // unchanged booking, and the review row is rewritten — reopening the
    // incident and re-notifying the officer — over nothing. Ordering an already
    // indexed, single-owner read costs a writer nothing, so both cross-booking
    // source reads take `COVERAGE_READ_ORDER` unconditionally.
    const { db } = makeSameOwnerStore(1);
    await reconcileAdultMemberHostingReviewWithSiblings("b-main", db);
    const args = sourceReadArgs(db);
    expect(args?.take).toBe(25);
    expect(args?.orderBy).toEqual([{ checkIn: "asc" }, { id: "asc" }]);
  });

  it("bounds the source read to ceiling + 1, in a total order, for an evidence caller", async () => {
    // `+ 1` so "there were more than I may read" is a distinguishable fact rather
    // than a quietly short list, and the order so a bound that binds binds
    // reproducibly.
    const { db } = makeSameOwnerStore(2);
    await evaluatePersistedBookingAdultMemberHostingReadOnly("b-main", db, {
      sameOwnerSourceCeiling: 3,
    });
    const args = sourceReadArgs(db);
    expect(args?.take).toBe(4);
    expect(args?.orderBy).toEqual([{ checkIn: "asc" }, { id: "asc" }]);
  });

  it("REFUSES rather than truncating when the source ceiling binds", async () => {
    // Four sources against a ceiling of three. A short host list and "I cannot tell
    // you" are different answers, and only the second one is honest here.
    const { db } = makeSameOwnerStore(4);
    await expect(
      evaluatePersistedBookingAdultMemberHostingReadOnly("b-main", db, {
        sameOwnerSourceCeiling: 3,
      }),
    ).rejects.toThrow(/same-owner bookings at this lodge/);
  });

  it("names the population that bound, not just that something did", async () => {
    // A shared error class would name the wrong population half the time, and the
    // two remedies differ: a bound sibling read means a split family has grown
    // implausibly wide, this one means one member holds more than the ceiling of
    // active bookings at ONE lodge over ONE window.
    const { db } = makeSameOwnerStore(4);
    const error = await evaluatePersistedBookingAdultMemberHostingReadOnly(
      "b-main",
      db,
      { sameOwnerSourceCeiling: 3 },
    ).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(HostingSameOwnerSourceCeilingExceededError);
    expect((error as Error).message).not.toContain("sibling bookings could cover");
  });

  it("still answers, unrefused, when the population sits inside the ceiling", async () => {
    // Non-vacuous: the ceiling must not turn an ordinary account into a refusal.
    // Three sources, ceiling three, and the covering adult is found — the booking's
    // own non-member child is covered on its single night.
    const { db } = makeSameOwnerStore(3);
    const result = await evaluatePersistedBookingAdultMemberHostingReadOnly(
      "b-main",
      db,
      { sameOwnerSourceCeiling: 3 },
    );
    expect(result?.violation).toBeNull();
  });
});

describe("the dependent reads truncate reproducibly (#2576 §10)", () => {
  it("asks for a deterministic order on both bounded dependent reads", async () => {
    // The safe-failure argument the SOURCE read rests on INVERTS here: a truncated
    // source read sees fewer hosts and errs towards flagging, while a dependent
    // dropped by the ceiling is neither refused under BLOCK nor enqueued, and the
    // drain silently skips it. `take` with no `orderBy` lets Postgres return any 25 of
    // the matching rows, so an over-limit account could refuse a change on one request
    // and allow it on the next. A unit test cannot prove Postgres determinism; what it
    // pins is that both reads ASK for the order, which is the mutation that would
    // silently restore the arbitrary truncation.
    // The same two-booking account the §6 tests use, restated locally because
    // `strandingPair` is scoped to that describe block: `b-source` no longer carries a
    // qualifying adult, so `b-main`'s non-member child is stranded and BOTH bounded
    // dependent reads run.
    const { db } = makeStore([
      booking({
        id: "b-source",
        guests: [
          guestRow(
            "their-child",
            ["2026-07-03", "2026-07-04"],
            memberRow({ id: "member-child", ageTier: AgeTier.CHILD }),
          ),
        ],
      }),
      booking({
        id: "b-main",
        guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
      }),
    ]);
    await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      db,
      hostingCoverageActorOptions({ vacatedRange: null, actorRole: "ADMIN", actorMemberId: "officer-1" }),
    ).catch(() => undefined);
    await loadSameOwnerCoverageDependentIds(
      {
        memberId: "owner-1",
        lodgeId: LODGE,
        nights: ["2026-07-03", "2026-07-04"],
      },
      db,
    );
    // The SOURCE read is bounded too and deliberately has NO order — its truncation
    // fails towards the rule, so reproducibility buys it nothing. It is told apart by
    // the `guests.where` that narrows the relation to member-linked rows; the two
    // dependent reads have no such filter (one selects the whole hosting shape, the
    // other selects `id` alone).
    const dependentReads = db.booking.findMany.mock.calls.filter(
      ([args]: [any]) =>
        typeof args?.take === "number" && !args?.select?.guests?.where,
    );
    // FIVE SINCE #3232, and the two new ones are the plan/verify pair the queue's
    // participant fence forces. #3232 records one item per dependent BOOKING, and
    // the fence demands a proof source for every booking an item names, so the
    // dependent set has to be read BEFORE the fence (unlocked, a hypothesis) and
    // again under the per-owner coverage key (where it becomes a fact or a safe
    // retry). Both are bounded and ordered, which is what the loop below holds them
    // to — an unordered truncation would return a different N under the lock than it
    // did in the plan and every account above the ceiling would fail as a spurious
    // retry.
    //
    // THREE SINCE #3039, and the third one is an improvement rather than a new
    // hazard. `loadHostingSiblingIds` used to run the #738 split-pair relation
    // through its own `findMany` with NEITHER `take` NOR `orderBy` — an unbounded,
    // unordered sibling read on every booking write, which is precisely the shape
    // these ceilings exist to prevent. It now delegates to the batched
    // `loadHostingCoverageSplitSiblingIds`, so the relation has one definition and
    // that read is bounded and ordered like its two siblings. The loop below holds it
    // to the same order.
    expect(dependentReads).toHaveLength(5);
    for (const [args] of dependentReads) {
      expect(args.orderBy, JSON.stringify(args.where)).toEqual([
        { checkIn: "asc" },
        { id: "asc" },
      ]);
    }
    // And the source read is the one that is allowed to stay unordered, stated so a
    // future change that orders it does not look like a failure of this test.
    const sourceReads = db.booking.findMany.mock.calls.filter(
      ([args]: [any]) =>
        typeof args?.take === "number" && args?.select?.guests?.where,
    );
    expect(sourceReads.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * #3123 — the hosting-coverage fan-out bounds its candidate set on the day the
 * CALLER resolved, and resolves nothing itself.
 *
 * `loadHostingCoverageMemberFanoutCandidates` asks for every current-or-future
 * booking this person attends — `checkOut >= today` against a `@db.Date`
 * column. It used to answer "today" from `APP_TIME_ZONE`, the container's zone,
 * and it cannot: `enqueueHostingCoverageReevaluationForMember` takes the
 * standing-subject `Member` row lock on its first line and calls this twice
 * under it, so resolving the club's persisted zone here would be a
 * `clubTimeSettings.findUnique` on a second pooled connection while that lock
 * is held (`INV-LOCK-004`). `today` is therefore a REQUIRED third parameter,
 * ahead of the defaulted `context` so the compiler enumerates all thirteen
 * callers.
 *
 * TWO PROPERTIES, and the second is the one that costs a member a booking.
 * A wrong day drops a stay that ends today out of the candidate set, so nothing
 * records the obligation to re-check the bookings a lapsed host was covering.
 * And the PLAN pass and the post-lock RE-VERIFY pass compare their two results
 * for equality — if each resolved its own day, a request straddling club
 * midnight would raise `HostingCoverageParticipantRetryError` on a merge or a
 * deactivation that nothing was wrong with. One value, threaded to both.
 *
 * DISCRIMINATION: 30 June is supplied and 1 July rejected. 1 July is what
 * `getTodayDateOnly()` answers at the frozen instant under this file's unmocked
 * environment, so it is exactly the value the pre-migration code produced.
 */
describe("the hosting fan-out takes the day it is given (#3123)", () => {
  const SUPPLIED_CLUB_DAY = new Date("2026-06-30T00:00:00.000Z");

  function candidateCheckOutBounds(
    findMany: ReturnType<typeof vi.fn>,
  ): string[] {
    return findMany.mock.calls
      .map((call) => (call[0] as { where?: { checkOut?: { gte?: Date } } }).where)
      .filter(
        (where): where is { checkOut: { gte: Date } } =>
          where?.checkOut?.gte instanceof Date,
      )
      .map((where) => where.checkOut.gte.toISOString());
  }

  it("bounds both the planning read and the post-lock re-verify on that day", async () => {
    const attended = booking({
      id: "b-attended",
      memberId: "owner-1",
      guests: [
        guestRow(
          "adult-on-b-attended",
          ["2026-07-03", "2026-07-04"],
          memberRow({ id: "lapsing-adult" }),
        ),
      ],
    });
    const { db } = makeStore([attended], {
      policies: [policyRow({ hostScopeSameBookingOwner: true })],
    });

    await enqueueHostingCoverageReevaluationForMember(
      "lapsing-adult",
      db,
      SUPPLIED_CLUB_DAY,
      { cause: "SYSTEM_CHANGE", actorMemberId: "officer-1" },
    );

    const bounds = candidateCheckOutBounds(db.booking.findMany);
    // Both passes, and both on the supplied day. A site that read the
    // container's zone would answer 2026-07-01 here; two independent reads
    // would answer inconsistently across club midnight and 409 the caller.
    expect(bounds.length).toBeGreaterThanOrEqual(2);
    for (const bound of bounds) {
      expect(bound).toBe(SUPPLIED_CLUB_DAY.toISOString());
      expect(bound).not.toBe(CLUB_TODAY_DATE_ONLY.toISOString());
    }
    expect(new Set(bounds).size).toBe(1);
  });
});


/**
 * #3209 — the cancelling half, against the REAL reconciler.
 *
 * Everything else written for #3209 mocks the thing in question: the two caller
 * suites mock the seam, and the seam suite mocks the review engine. Between them
 * they prove the wiring and the request, and NOTHING proves what the engine does
 * when a system path cancels a live coverage source — which is the issue's actual
 * acceptance criterion. The fake store in this file applies real `where` clauses
 * and runs the real `reconcileAdultMemberHostingReviewWithSiblings`, so it can.
 *
 * The first fix for #3209 passed every mocked test and still recorded NOTHING at
 * the default host scope. It let the sibling loop refuse and caught the refusal,
 * falling back to an enqueue against the CANCELLED SOURCE — but for a terminal
 * source with `sameBookingOwner` off, the drain computes an empty dependent list,
 * so the fallback was a no-op. The first test below is the one that fails against
 * that fix and passes against the one that ships.
 */
describe("a system cancellation records the hazard instead of refusing it (#3209)", () => {
  /**
   * The club is ENFORCED, and `SAME_BOOKING_OWNER` is OFF — which is
   * `DEFAULT_ADULT_MEMBER_HOST_SCOPES`, so this is what a club that simply turns
   * adult-member hosting on gets. Only the #738 split-sibling relationship
   * survives at this scope, and it is the relationship the sibling loop is about.
   */
  const DEFAULT_SCOPES = [policyRow({ hostScopeSameBookingOwner: false })];
  const NIGHTS = ["2026-07-03", "2026-07-04"];

  /**
   * A #738 split pair: one member, one stay, two rows. The PARENT carries the
   * qualifying adult; the CHILD carries the non-member guest who depends on them.
   */
  function splitPair() {
    return [
      booking({
        id: "b-parent",
        guests: [guestRow("adult", NIGHTS, memberRow({ id: "adult-1" }))],
      }),
      booking({
        id: "b-child",
        parentBookingId: "b-parent",
        guests: [guestRow("kid", NIGHTS)],
      }),
    ];
  }

  it("refuses the split sibling when the bare reconciler is used, which is the hazard", async () => {
    // The premise of the seam, asserted rather than assumed. Cancelling the parent
    // takes the only qualifying adult out of the child's host pool
    // (`hostingSiblingWhere` excludes CANCELLED rows), and the sibling loop's
    // default `REFUSE` throws from inside the caller's transaction — which would
    // roll the cancellation back. If this ever stops throwing, the seam below is
    // solving a problem that no longer exists and should be re-examined rather
    // than kept out of habit.
    const { db, rowFor } = makeStore(splitPair(), { policies: DEFAULT_SCOPES });
    rowFor("b-parent").status = "CANCELLED";

    await expect(
      reconcileAdultMemberHostingReviewWithSiblings("b-parent", db),
    ).rejects.toBeInstanceOf(AdultMemberHostingRequiredError);
  });

  it("records the split sibling's hazard on the booking instead of throwing", async () => {
    // THE FIX. The cancellation completes, and the obligation it would have
    // interrupted is on the child's own row — PENDING, naming the exact nights, so
    // the booking's page and the officer's booking view both show it.
    const { db, rowFor } = makeStore(splitPair(), { policies: DEFAULT_SCOPES });
    rowFor("b-parent").status = "CANCELLED";

    await expect(
      reconcileHostingReviewForSystemCancellation("b-parent", db),
    ).resolves.toBeUndefined();

    const child = rowFor("b-child");
    expect(child.adultMemberHostingReviewStatus).toBe("PENDING");
    expect(child.adultMemberHostingReview).toMatchObject({
      reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
      affectedNights: NIGHTS,
    });
  });

  it("still clears a sibling that another booking covers", async () => {
    // The mutation that matters for the test above: `REVIEW_ONLY` must not turn
    // into "record a hazard on every sibling of every cancellation". Here the
    // child carries a qualifying adult of its OWN, so losing the parent's costs it
    // nothing and nothing is recorded on it at all.
    const rows = splitPair();
    rows[1] = booking({
      ...(rows[1] as Record<string, unknown>),
      guests: [
        guestRow("kid", NIGHTS),
        guestRow("own-adult", NIGHTS, memberRow({ id: "adult-2" })),
      ],
    });
    const { db, rowFor } = makeStore(rows, { policies: DEFAULT_SCOPES });
    rowFor("b-parent").status = "CANCELLED";

    await reconcileHostingReviewForSystemCancellation("b-parent", db);

    expect(rowFor("b-child").adultMemberHostingReviewStatus).toBeNull();
  });

  it("opens a coverage incident against the dependent owner when the scope IS on", async () => {
    // The issue's acceptance criterion, verbatim: "cancelling ... opens a coverage
    // incident against the affected booking's owner, and the officer queue shows
    // it". `b-source` was supplying `SAME_BOOKING_OWNER` cover to `b-main`; a
    // system path cancels it.
    const rows = [
      booking({
        id: "b-source",
        guests: [guestRow("adult", NIGHTS, memberRow({ id: "adult-1" }))],
      }),
      booking({ id: "b-main", guests: [guestRow("kid", NIGHTS)] }),
    ];
    const { db, queued, incidents, rowFor } = makeStore(rows);
    rowFor("b-source").status = "CANCELLED";

    await reconcileHostingReviewForSystemCancellation("b-source", db);

    // The bounded obligation, committed with the cancellation: the owner, the
    // lodge, this booking's own nights, and no actor because nobody did this.
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      memberId: "owner-1",
      lodgeId: LODGE,
      cause: "SYSTEM_CHANGE",
      actorMemberId: null,
      sourceBookingId: "b-source",
    });
    expect(queued[0].nights).toEqual(NIGHTS);

    // And the drain's per-dependent step — the half that reaches the officer queue
    // and the owner's inbox — opens the incident on `b-main`.
    const outcome = await reconcileSameOwnerCoverageIncident(
      { bookingId: "b-main", cause: "SYSTEM_CHANGE" },
      db,
    );
    expect(outcome.action).toBe("opened");
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ bookingId: "b-main" });
    expect(rowFor("b-main").adultMemberHostingReviewStatus).toBe("PENDING");
  });

  it("cancels nothing and refuses nothing on its way through", async () => {
    // §7 and §16: a coverage change never cancels a booking, and this seam is the
    // one place a cancellation and the hosting engine meet — so the only status
    // write in the whole call must be the one the CALLER already made.
    const { db, rowFor } = makeStore(splitPair(), { policies: DEFAULT_SCOPES });
    rowFor("b-parent").status = "CANCELLED";

    await reconcileHostingReviewForSystemCancellation("b-parent", db);

    expect(
      db.booking.update.mock.calls.some((call: any) => "status" in call[0].data),
    ).toBe(false);
  });
});

/**
 * #3209 — WHICH LODGE'S MODE decides that nothing is owed (`INV-HOST-042`).
 *
 * Adult-member hosting is configured PER LODGE, and the fan-out relation this
 * engine reads — `hostingSiblingWhere`, the #738 parent/child of one member — has
 * no lodge clause in it. So "the booking that changed is at a lodge with the rule
 * off" is not an answer about the booking that DEPENDS on it. The mode gate used
 * to return on that half-question, skipping the sibling fan-out entirely.
 *
 * The other half of this block is the property the gate exists to protect
 * (#2623 T5): a club that owes nothing must still pay no `FOR KEY SHARE NOWAIT`
 * row lock. A fix that simply always fenced would repeal that decision and put the
 * `HOSTING_COVERAGE_PARTICIPANT_RETRY` 409 back in front of every booking write at
 * every non-participating lodge, so both halves are asserted here together.
 */
describe("the mode gate reads the RELATED bookings' lodges too (#3209)", () => {
  const NIGHTS = ["2026-07-03", "2026-07-04"];
  const CLUB_OFF = policyRow({ mode: "DISABLED" });
  const OTHER_LODGE_ON = policyRow({
    id: "policy-lodge-b",
    scopeKey: `lodge:${OTHER_LODGE}`,
    lodgeId: OTHER_LODGE,
    mode: "ADMIN_REVIEW_REQUIRED",
  });
  const OTHER_LODGE_OFF = policyRow({
    id: "policy-lodge-b",
    scopeKey: `lodge:${OTHER_LODGE}`,
    lodgeId: OTHER_LODGE,
    mode: "DISABLED",
  });

  /**
   * A #738 split pair, one member, with the child placed at `childLodgeId`.
   *
   * The parent carries the only qualifying adult; the child carries the
   * non-member guest who depends on them. The parent arrives already CANCELLED,
   * which is what a system cancellation has just written in its own transaction —
   * and `hostingSiblingWhere` excludes CANCELLED rows, so the child's host pool is
   * empty from the moment that write lands.
   */
  function cancelledParentWithChildAt(childLodgeId: string) {
    return [
      booking({
        id: "b-parent",
        status: "CANCELLED",
        guests: [guestRow("adult", NIGHTS, memberRow({ id: "adult-1" }))],
      }),
      booking({
        id: "b-child",
        parentBookingId: "b-parent",
        lodgeId: childLodgeId,
        guests: [guestRow("kid", NIGHTS)],
      }),
    ];
  }

  /**
   * The lodges the policy reader actually asked about, in order. The cost claim in
   * the gate's docstring is a claim about this list, so assert the list rather than
   * a count: "one more policy read, and only when a related booking is somewhere
   * else" is checkable, "it is cheap" is not.
   */
  function policyLodgesQueried(db: {
    adultMemberHostingPolicy: { findMany: { mock: { calls: [never][] } } };
  }): string[] {
    return (
      db.adultMemberHostingPolicy.findMany.mock.calls as unknown as Array<
        [{ where?: { OR?: Array<{ lodgeId?: string }> } }]
      >
    ).map(([args]) => args?.where?.OR?.[0]?.lodgeId as string);
  }

  it("reconciles a split sibling at an ACTIVE lodge when the changed booking's lodge is off", async () => {
    // THE DEFECT. The club runs the rule at lodge B and not at lodge A. A system
    // path cancels the half of the split pair that sits at A and carries the
    // adult; the half at B loses its cover. Gating on A alone returned before the
    // sibling loop, so B's booking was never re-read and nothing was recorded on
    // it — no review, no officer signal, and the member never told.
    const { db, rowFor } = makeStore(cancelledParentWithChildAt(OTHER_LODGE), {
      policies: [CLUB_OFF, OTHER_LODGE_ON],
    });

    await reconcileAdultMemberHostingReviewWithSiblings("b-parent", db);

    const child = rowFor("b-child");
    expect(child.adultMemberHostingReviewStatus).toBe("PENDING");
    expect(child.adultMemberHostingReview).toMatchObject({
      reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
      affectedNights: NIGHTS,
    });
    // And the fence WAS taken this time, because real queue work is owed: the
    // sibling's own evaluation can reach for the coverage-owner advisory key under
    // lodge B's policy, and that key may never be acquired before the Member rows
    // it would invert against (`INV-LOCK-002`).
    expect(db.$executeRaw).toHaveBeenCalled();
  });

  it("takes no participant proof for a split pair at one DISABLED lodge", async () => {
    // #2623 T5, preserved exactly. Both halves are at the lodge that has the rule
    // off, so nothing is owed and the gate must skip without locking anything —
    // even while a member-lifecycle writer holds the owner's Member row, which is
    // what the rejecting `$executeRaw` stands in for.
    const { db } = makeStore(cancelledParentWithChildAt(LODGE), {
      policies: [CLUB_OFF],
    });
    db.$executeRaw.mockRejectedValue({
      driverAdapterError: { cause: { originalCode: "55P03" } },
    });

    await expect(
      reconcileAdultMemberHostingReviewWithSiblings("b-parent", db),
    ).resolves.toMatchObject({ mode: "DISABLED" });
    expect(db.$executeRaw).not.toHaveBeenCalled();
    // ZERO extra policy reads, because every related booking is at this same
    // lodge — which is every split pair the product can currently produce. The two
    // reads are the gate's own and the single-booking reconciler's, both for A.
    expect(policyLodgesQueried(db)).toEqual([LODGE, LODGE]);
  });

  it("takes no participant proof when the sibling's other lodge is off as well", async () => {
    // The widened question, answered NO. One extra policy read for lodge B, and
    // then the same skip: a club that has the rule off everywhere its related
    // bookings live still pays no row lock.
    const { db, rowFor } = makeStore(cancelledParentWithChildAt(OTHER_LODGE), {
      policies: [CLUB_OFF, OTHER_LODGE_OFF],
    });
    db.$executeRaw.mockRejectedValue({
      driverAdapterError: { cause: { originalCode: "55P03" } },
    });

    await expect(
      reconcileAdultMemberHostingReviewWithSiblings("b-parent", db),
    ).resolves.toMatchObject({ mode: "DISABLED" });
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(policyLodgesQueried(db)).toEqual([LODGE, OTHER_LODGE, LODGE]);
    expect(rowFor("b-child").adultMemberHostingReviewStatus).toBeNull();
  });

  it("is not tripped by a booking that merely hangs off this one", async () => {
    // The gate asks `hostingSiblingWhere`, not "anything with my id as its parent".
    // A verified group joiner's booking hangs off the organiser's by
    // `parentBookingId` and belongs to a DIFFERENT member, so the organiser's
    // adults are deliberately never borrowed for it — and a joiner at an active
    // lodge must therefore not drag the organiser's cancellation into the fence.
    const { db } = makeStore(
      [
        booking({ id: "b-parent", status: "CANCELLED", guests: [] }),
        booking({
          id: "b-joiner",
          parentBookingId: "b-parent",
          memberId: "owner-2",
          lodgeId: OTHER_LODGE,
          guests: [guestRow("kid", NIGHTS)],
        }),
      ],
      { policies: [CLUB_OFF, OTHER_LODGE_ON] },
    );
    db.$executeRaw.mockRejectedValue({
      driverAdapterError: { cause: { originalCode: "55P03" } },
    });

    await expect(
      reconcileAdultMemberHostingReviewWithSiblings("b-parent", db),
    ).resolves.toMatchObject({ mode: "DISABLED" });
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(policyLodgesQueried(db)).toEqual([LODGE, LODGE]);
  });

  it("keeps the dependent cohort at the changed booking's own lodge", () => {
    // Why the SAME-OWNER half of the gate needs no widening, pinned rather than
    // argued. `settleSameOwnerDependentCoverage` re-reads the changed booking's
    // own lodge and returns when it is inactive; that is only safe because the set
    // it would have looked at cannot contain a booking at any other lodge. Delete
    // the `lodgeId` clause and the gate's docstring becomes false, so this test
    // fails first.
    const where = sameOwnerCoverageDependentWhere(booking() as never) as Record<
      string,
      unknown
    >;
    expect(where.lodgeId).toBe(LODGE);
    expect(
      sameOwnerCoverageDependentWhere(booking({ lodgeId: OTHER_LODGE }) as never)
        .lodgeId,
    ).toBe(OTHER_LODGE);
  });
});

/**
 * #3232 — moving one booking's dates must not silently strand another booking on
 * the same account, and must not deadlock the member either.
 *
 * TWO HALVES, TESTED SEPARATELY AND ON PURPOSE (`INV-HOST-049`). #3039 measured
 * that fixing one and leaving the other still loses the booking, and that the
 * second failure is the quiet one: the refusal path looks fixed while the
 * escalation path drops the booking in the background with nothing logged. A
 * single test that only fails when BOTH are broken would pass over a half-fix, so
 * each half has its own test and each was mutation-verified against its own
 * mutation.
 *
 *  - the READ half: `sameOwnerCoverageDependentOverStayUnionWhere` must match the
 *    window the changed booking VACATED as well as the one it now holds.
 *  - the QUEUE half: the item recorded for a dependent the changed booking's own
 *    window cannot reach must carry the DEPENDENT's nights, not the changed
 *    booking's.
 */
describe("a date move must not strand another of the owner's bookings (#3232)", () => {
  /**
   * The exact scenario from the issue. Booking `b-source` carries the only
   * qualifying adult over 3-4 July and `b-main` is the same owner's booking on the
   * same nights, compliant only through it. `b-source` has just been moved to
   * 20-21 July, so its row already holds the NEW dates — which is the whole point:
   * every dependent read runs after the write.
   */
  function movedAwaySource() {
    return sourceWithAdult("b-source", ["2026-07-20", "2026-07-21"]);
  }

  const VACATED = {
    checkIn: new Date("2026-07-03T00:00:00.000Z"),
    checkOut: new Date("2026-07-05T00:00:00.000Z"),
  };

  it("finds the dependent the move left behind, which the new window cannot see", () => {
    // `INV-HOST-049`, the READ half, at the level of the predicate itself. The
    // single-window builder is asked the same question and must NOT match, which
    // is what makes this a discrimination test rather than a tautology: if both
    // builders matched, the union would be buying nothing.
    const moved = movedAwaySource() as never;
    const left = booking({ id: "b-main" });

    const narrow = sameOwnerCoverageDependentWhere(moved);
    const union = sameOwnerCoverageDependentOverStayUnionWhere(moved, VACATED);

    expect(
      matchesWhere(left, narrow as Record<string, unknown>),
      "the post-move window alone cannot see the booking it left behind — that is the defect",
    ).toBe(false);
    expect(
      matchesWhere(left, union as Record<string, unknown>),
      "INV-HOST-049: the dependent read must match the window the booking VACATED",
    ).toBe(true);
  });

  it("collapses to one overlap test when the stay did not move", () => {
    // Every writer except a date change passes `null`, and the ~40 of them must be
    // byte-identical to their previous behaviour. Asserted as a SHAPE rather than
    // by behaviour, because a union that happened to agree on these fixtures could
    // still be a second query plan for every booking write at every club.
    const still = booking({ id: "b-source" }) as never;
    expect(sameOwnerCoverageDependentOverStayUnionWhere(still, null)).toEqual(
      sameOwnerCoverageDependentWhere(still),
    );
    // And the same when the caller passes the window it holds, unchanged. A writer
    // that restates a window it did not move must not pay for a second clause.
    expect(
      sameOwnerCoverageDependentOverStayUnionWhere(still, {
        checkIn: new Date("2026-07-03T00:00:00.000Z"),
        checkOut: new Date("2026-07-05T00:00:00.000Z"),
      }),
    ).toEqual(sameOwnerCoverageDependentWhere(still));
  });

  it("does not reach a booking that overlaps neither window", () => {
    // The union is EXACT, not merely wide. A booking sharing a night with neither
    // where this one was nor where it now is cannot have been relying on it, and
    // widening the set to reach it would put a booking the change cannot have
    // affected in front of a refusal. This is the test that fails if somebody
    // "simplifies" the union into `coverageDependentEnvelopeAcrossNightsWhere`.
    const moved = movedAwaySource() as never;
    const unrelated = booking({
      id: "b-unrelated",
      checkIn: new Date("2026-07-10T00:00:00.000Z"),
      checkOut: new Date("2026-07-12T00:00:00.000Z"),
    });
    expect(
      matchesWhere(
        unrelated,
        sameOwnerCoverageDependentOverStayUnionWhere(
          moved,
          VACATED,
        ) as Record<string, unknown>,
      ),
      "INV-HOST-049: the union of the two windows, not the gap between them",
    ).toBe(false);
  });

  it("keeps the lodge equality and the self-exclusion across the union", () => {
    // Both are load-bearing elsewhere: the mode gate reads ONE lodge's policy for
    // the whole dependent cohort on the strength of the lodge clause, and dropping
    // the self-exclusion would make a booking its own dependent.
    const moved = movedAwaySource() as never;
    const where = sameOwnerCoverageDependentOverStayUnionWhere(
      moved,
      VACATED,
    ) as Record<string, unknown>;
    expect(where.lodgeId).toBe(LODGE);
    expect(where.id).toEqual({ not: "b-source" });
    expect(where.memberId).toBe("owner-1");
  });

  it("records the stranded dependent's OWN nights, not the moved booking's", async () => {
    // `INV-HOST-049`, the QUEUE half — the one that looks fixed and is not. The
    // item's nights are what `loadSameOwnerCoverageDependentIds` turns back into
    // bookings, so an item carrying 20-21 July resolves to a dependent list that
    // does not contain the booking sitting on 3-4 July. Widen the read, leave the
    // item alone, and the booking is dropped in the background instead.
    const { db, queued } = makeStore([
      movedAwaySource(),
      booking({ id: "b-main", guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])] }),
    ]);

    // An OFFICER's move, so the change is allowed and the durable work is what is
    // being asserted. A member's move raises the linked-move offer instead, which
    // is `INV-HOST-050`'s test below; the queue behaviour is the same either way
    // and this is the disposition that lets it commit.
    await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      db,
      hostingCoverageActorOptions({
        actorRole: "ADMIN",
        actorMemberId: "officer-1",
        vacatedRange: {
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-05T00:00:00.000Z"),
        },
        override: {
          acknowledged: true,
          reason: "Member asked for the whole party to move",
          // The exact stranded state the officer confirmed. A wrong key here
          // re-prompts instead of overriding, and the queue stays empty — which is
          // correct behaviour and would have made this test pass for the wrong
          // reason if it were swallowed.
          strandedStateKey: strandedCoverageStateKey(
            [
              {
                bookingId: "b-main",
                reference: strandedCoverageReference("b-main"),
                lodgeName: "Ruapehu Lodge",
                nights: ["2026-07-03", "2026-07-04"],
                checkIn: "2026-07-03",
                checkOut: "2026-07-05",
              },
            ],
            "b-source",
          ),
        },
      }),
    );

    const dependentItem = queued.find((item) => item.sourceBookingId === "b-main");
    expect(
      dependentItem,
      "INV-HOST-049: the dependent the move left behind owes its own queue item",
    ).toBeDefined();
    expect(
      dependentItem?.nights,
      "INV-HOST-049: the item's nights must be the DEPENDENT's own, or the drain resolves it to nobody",
    ).toEqual(["2026-07-03", "2026-07-04"]);
    // And the item really is findable by the drain, which is the property the
    // nights exist for. Asserting the nights alone would pin the mechanism; this
    // pins the consequence.
    expect(
      await loadSameOwnerCoverageDependentIds(
        {
          memberId: "owner-1",
          lodgeId: LODGE,
          nights: dependentItem?.nights as string[],
        },
        db,
      ),
    ).toContain("b-main");
  });

  it("writes no extra item when the dependent still shares a night", async () => {
    // The cost control, and the reason a club that was never broken pays nothing.
    // An overlapping dependent is already inside the changed booking's own item,
    // so a second one would be duplicate work the drain has to discard.
    const { db, queued } = makeStore([
      sourceWithAdult("b-source", ["2026-07-03", "2026-07-04"]),
      booking({ id: "b-main", guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])] }),
    ]);
    await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      db,
      hostingCoverageActorOptions({
        actorRole: "ADMIN",
        actorMemberId: "officer-1",
        vacatedRange: null,
        override: {
          acknowledged: true,
          reason: "Officer took the adult off at the member's request",
          strandedStateKey: "v1:" + "0".repeat(64),
        },
      }),
    ).catch(() => undefined);
    expect(
      queued.filter((item) => item.sourceBookingId === "b-main"),
      "an overlapping dependent is already covered by the changed booking's own item",
    ).toEqual([]);
  });
});

describe("a member is offered the linked move, never deadlocked (#3232)", () => {
  const VACATED = {
    checkIn: new Date("2026-07-03T00:00:00.000Z"),
    checkOut: new Date("2026-07-05T00:00:00.000Z"),
  };

  async function refuseMemberMove(vacated: { checkIn: Date; checkOut: Date } | null) {
    const { db } = makeStore([
      sourceWithAdult("b-source", ["2026-07-20", "2026-07-21"]),
      booking({ id: "b-main", guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])] }),
    ]);
    try {
      await reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          actorRole: "MEMBER",
          actorMemberId: "owner-1",
          vacatedRange: vacated,
        }),
      );
      return null;
    } catch (error) {
      return error as SameOwnerCoverageWouldBreakError;
    }
  }

  it("marks the refusal as one a linked move would answer", async () => {
    // `INV-HOST-050`. The member has moved AWAY from the booking that was relying
    // on them, so every remedy the refusal's own sentence could offer on that
    // booking is closed to them — moving it is refused by this same rule from the
    // other end. The refusal therefore has to be answerable, and this flag is what
    // makes the date writer price the offer instead of returning a dead end.
    const error = await refuseMemberMove(VACATED);
    expect(error, "the member's move is still refused, and rolled back").toBeInstanceOf(
      SameOwnerCoverageWouldBreakError,
    );
    expect(
      error?.linkedMoveWouldAnswer,
      "INV-HOST-050: a refusal the member cannot act on must be marked as one the linked move answers",
    ).toBe(true);
    expect(error?.stranded.map((row) => row.bookingId)).toEqual(["b-main"]);
  });

  it("keeps the ordinary refusal for a stranding the member CAN fix", async () => {
    // The other side of `INV-HOST-050`, and the reason the flag is conditional
    // rather than always set. Here the dependent still shares a night with the
    // changed booking, so the stranding came from a guest change rather than a
    // move — and the member really can add an adult to the affected booking or
    // cancel it. That refusal is unchanged, and offering a linked move for it
    // would offer to move a booking nothing required to move.
    const { db } = makeStore([
      sourceWithAdult("b-source", ["2026-07-03", "2026-07-04"], { guests: [] }),
      booking({ id: "b-main", guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])] }),
    ]);
    let error: SameOwnerCoverageWouldBreakError | null = null;
    try {
      await reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          actorRole: "MEMBER",
          actorMemberId: "owner-1",
          vacatedRange: null,
        }),
      );
    } catch (caught) {
      error = caught as SameOwnerCoverageWouldBreakError;
    }
    expect(error).toBeInstanceOf(SameOwnerCoverageWouldBreakError);
    expect(
      error?.linkedMoveWouldAnswer,
      "a stranding the member can fix on the affected booking keeps today's refusal",
    ).toBe(false);
  });

  it("does not claim the offer for a shortening the shift cannot answer", async () => {
    // `INV-HOST-050`. "The booking moved away from it" and "a shift can put it
    // back" are different questions, and a SHORTENING is where they come apart. A
    // stay of 10-15 August cut back to 10-12 moves nothing at the arrival end, so
    // the dependent's target is where it already is: its write would be a no-op,
    // it would still be uncovered, and the final supervision pass would throw this
    // very refusal — after two full pricing runs inside a transaction that was
    // always going to be discarded. The arm was being claimed and could not be
    // delivered.
    //
    // The member is not stuck here, which is why the ordinary refusal is the right
    // answer rather than a dead end: the affected booking's nights are outside the
    // shortened stay, so adding a qualifying adult to it, moving it into the
    // remaining nights, or cancelling it are all open to them.
    const { db } = makeStore([
      sourceWithAdult("b-source", ["2026-08-10", "2026-08-11"]),
      booking({
        id: "b-main",
        checkIn: new Date("2026-08-13T00:00:00.000Z"),
        checkOut: new Date("2026-08-14T00:00:00.000Z"),
        guests: [guestRow("kid", ["2026-08-13"])],
      }),
    ]);
    let error: SameOwnerCoverageWouldBreakError | null = null;
    try {
      await reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          actorRole: "MEMBER",
          actorMemberId: "owner-1",
          // Ten to fifteen August, cut back to ten to twelve: the check-out moved
          // and the arrival did not.
          vacatedRange: {
            checkIn: new Date("2026-08-10T00:00:00.000Z"),
            checkOut: new Date("2026-08-15T00:00:00.000Z"),
          },
        }),
      );
    } catch (caught) {
      error = caught as SameOwnerCoverageWouldBreakError;
    }
    expect(
      error,
      "the shortening is still refused, and the dependent is still noticed",
    ).toBeInstanceOf(SameOwnerCoverageWouldBreakError);
    expect(error?.stranded.map((row) => row.bookingId)).toEqual(["b-main"]);
    expect(
      error?.linkedMoveWouldAnswer,
      "INV-HOST-050: an arm that cannot deliver must not be claimed",
    ).toBe(false);
  });

  it("names no impossible action in what the member is told", () => {
    // The second defect #3232 fixed, and it is a product defect rather than a
    // mechanism one: the sentence #2576 shipped told members to "Update the
    // affected booking first", which the same rule refuses from the other end. The
    // product was instructing people to do something the code forbids.
    const message = formatStrandedCoverageMessage([]);
    expect(
      message,
      "INV-HOST-050: never tell a member to update the booking this rule will refuse to let them update",
    ).not.toMatch(/update the affected booking/i);
    // And every action it DOES name is one they can attempt.
    expect(message).toMatch(/adding a qualifying adult member/i);
    expect(message).toMatch(/cancelling it/i);
    expect(message).toMatch(/Booking Officer/);
    // INCLUDING THE THIRD CLAUSE, which the #3232 rewrite briefly turned into a
    // dead end: "A Booking Officer can also authorise this change and record why"
    // is a true statement about officers with no way to reach one, and the member
    // cannot take that override themselves. A refusal that names no way forward
    // is the failure this sentence exists to avoid.
    expect(
      message,
      "INV-HOST-050: the officer clause must be a way forward, not a fact",
    ).toMatch(/contact the club/i);
  });

  it("decides its own queue item with the SAME overlap test the query uses", () => {
    // `INV-SSOT-001`. The queue item's night window is what the drain turns back
    // into bookings, so the predicate deciding whether a dependent needs an item
    // of its own has to agree with the query that found it — and the SQL half of
    // exactly this test is already single-sourced as `nightOverlapClause`. This
    // function hand-wrote the two comparisons a second time, one drift away from
    // #3039's measured failure where the refusal looks fixed and the booking is
    // dropped in the background instead.
    const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
    const changed = { checkIn: day("2026-08-10"), checkOut: day("2026-08-12") };
    const cases = [
      // Overlapping, back-to-back on each side, and clear of it — the half-open
      // boundary included, which is where a second spelling drifts first.
      { checkIn: day("2026-08-11"), checkOut: day("2026-08-13") },
      { checkIn: day("2026-08-12"), checkOut: day("2026-08-14") },
      { checkIn: day("2026-08-08"), checkOut: day("2026-08-10") },
      { checkIn: day("2026-08-20"), checkOut: day("2026-08-22") },
      { checkIn: day("2026-08-10"), checkOut: day("2026-08-12") },
    ];
    for (const dependent of cases) {
      expect(
        dependentNeedsOwnQueueItem(changed, dependent),
        `${dependent.checkIn.toISOString()} must agree with bookingsOverlap`,
      ).toBe(!bookingsOverlap(changed, dependent));
    }
  });

  it("counts the bookings it is talking about, because the cap is not one", () => {
    // `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT` is 25, and a member with one adult
    // and two parties of guests is an ordinary family shape. The singular second
    // sentence told them to add an adult to "that booking", or cancel "it", above
    // a plural "Affected:" list naming three.
    function row(id: string) {
      return {
        bookingId: id,
        reference: strandedCoverageReference(id),
        lodgeName: "Ruapehu Lodge",
        nights: ["2026-07-03"],
        checkIn: "2026-07-03",
        checkOut: "2026-07-04",
      };
    }
    const one = formatStrandedCoverageMessage([row("b-one")]);
    expect(one).toMatch(/leave another booking on your account/);
    expect(one).toMatch(/to that booking, or cancelling it,/);

    const many = formatStrandedCoverageMessage([
      row("b-one"),
      row("b-two"),
      row("b-three"),
    ]);
    expect(many).toMatch(/leave 3 other bookings on your account/);
    expect(many).toMatch(/to those bookings, or cancelling them,/);
    expect(many).not.toMatch(/cancelling it,/);
  });

  it("escalates instead of refusing once the member has declined the offer", async () => {
    // D1's "No" arm. The member was shown the consequence and chose to move only
    // the booking they were editing, so the change PROCEEDS — and the officer
    // queue gets an item whose recorded reason says a member was asked and
    // answered, rather than leaving an officer to infer it from a cause code that
    // also means "a qualification changed".
    const { db, queued } = makeStore([
      sourceWithAdult("b-source", ["2026-07-20", "2026-07-21"]),
      booking({ id: "b-main", guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])] }),
    ]);
    const stranded = [
      {
        bookingId: "b-main",
        reference: strandedCoverageReference("b-main"),
        lodgeName: "Ruapehu Lodge",
        nights: ["2026-07-03", "2026-07-04"],
        checkIn: "2026-07-03",
        checkOut: "2026-07-05",
      },
    ];
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          actorRole: "MEMBER",
          actorMemberId: "owner-1",
          vacatedRange: VACATED,
          linkedMove: {
            answer: {
              choice: "LEAVE_UNCOVERED",
              acknowledged: true,
              stateKey: strandedCoverageStateKey(stranded, "b-source"),
            },
            bookingOwnerMemberId: "owner-1",
          },
        }),
      ),
      "INV-HOST-050: a member who declined the offer is allowed through, not refused",
    ).resolves.toBeTruthy();
    const dependentItem = queued.find((item) => item.sourceBookingId === "b-main");
    expect(dependentItem?.reason).toBe(LINKED_MOVE_DECLINED_INCIDENT_REASON);
    // AND THE CAUSE THE DRAIN WILL STORE (#3241, `INV-HOST-052`). This is the one
    // arm that produces the label, and the queue item is where it starts: a
    // regression to `SYSTEM_CHANGE` here files a member's prompted decision as an
    // automatic change, which is the count the value exists to keep clean.
    expect(dependentItem?.cause).toBe("OWNER_DECLINED_LINKED_MOVE");
  });

  it("does not tell a booking uncovered for its own reason that the member declined it", async () => {
    // #3241, `INV-HOST-053`. `stranded` is NARROWER than the dependent set by
    // design: `inspectSameOwnerDependents` drops a dependent whose uncovered state
    // is already recorded, and those are exactly the bookings uncovered for
    // reasons of their own. The member is never shown them and never asked about
    // them, so a row telling them "you were asked about this and said no" is a
    // story about a different booking — and it is counted as a decline by a club
    // judging its own setting, which is the count `INV-HOST-052` protects.
    const alreadyRecorded = booking({
      id: "b-own-reason",
      guests: [guestRow("kid-two", ["2026-07-03", "2026-07-04"])],
      adultMemberHostingReviewStatus: "PENDING",
      adultMemberHostingReview: {
        reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
        policyId: "policy-club",
        policyVersion: 7,
        affectedNights: ["2026-07-03", "2026-07-04"],
        requirements: {
          uncovered: [
            { guestRef: "kid-two", guestName: "kid-two Person", night: "2026-07-03" },
            { guestRef: "kid-two", guestName: "kid-two Person", night: "2026-07-04" },
          ],
        },
      },
    });
    const rows = [
      sourceWithAdult("b-source", ["2026-07-20", "2026-07-21"]),
      booking({ id: "b-main", guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])] }),
      alreadyRecorded,
    ];
    const declineOptions = (stateKey?: string) =>
      hostingCoverageActorOptions({
        actorRole: "MEMBER",
        actorMemberId: "owner-1",
        vacatedRange: VACATED,
        ...(stateKey
          ? {
              linkedMove: {
                answer: { choice: "LEAVE_UNCOVERED" as const, acknowledged: true, stateKey },
                bookingOwnerMemberId: "owner-1",
              },
            }
          : {}),
      });

    // The key comes from the engine's own refusal, so it covers exactly the set
    // the member would really have been shown.
    const refusal = await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      makeStore(rows).db,
      declineOptions(),
    ).then(
      () => null,
      (err: unknown) => err as SameOwnerCoverageWouldBreakError,
    );
    expect(refusal?.stranded.map((row) => row.bookingId)).toEqual(["b-main"]);
    const stateKey = strandedCoverageStateKey(refusal!.stranded, "b-source");

    const { db, queued } = makeStore(rows);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings("b-source", db, declineOptions(stateKey)),
    ).resolves.toBeTruthy();

    expect(queued.find((item) => item.sourceBookingId === "b-main")).toMatchObject({
      cause: "OWNER_DECLINED_LINKED_MOVE",
      reason: LINKED_MOVE_DECLINED_INCIDENT_REASON,
    });
    const other = queued.find((item) => item.sourceBookingId === "b-own-reason");
    expect(
      other,
      "INV-HOST-053: a booking nobody was asked about must not carry the decision",
    ).toMatchObject({ cause: "SYSTEM_CHANGE", reason: null });
    // The booking the member was EDITING is not asked about either: "move this
    // booking as well" cannot be true of the one they were moving.
    expect(queued.find((item) => item.sourceBookingId === "b-source")).toMatchObject({
      cause: "SYSTEM_CHANGE",
      reason: null,
    });
  });

  it("gives an OVERLAPPING stranded booking its own row, so the decision survives", async () => {
    // #3241, `INV-HOST-053`. A dependent that still shares a night with the new
    // dates used to get no row of its own — the changed booking's row already
    // reached it, so a second one was duplicate work. That reasoning stops
    // holding the moment a row's explanation is confined to the booking the row
    // is ABOUT: reached only by the source's sweep, this booking would be filed
    // as a plain automatic change and the member's decision would be lost for it.
    //
    // A PARTIAL OVERLAP IS EXACTLY THAT CASE and it is an ordinary family shape:
    // the adult's booking still covers one of the kid's nights after the move and
    // leaves the other short.
    const rows = [
      sourceWithAdult("b-source", ["2026-07-04"]),
      booking({
        id: "b-main",
        checkIn: new Date("2026-07-03T00:00:00.000Z"),
        checkOut: new Date("2026-07-05T00:00:00.000Z"),
        guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])],
      }),
    ];
    // The premise, asserted rather than assumed: without a real overlap this
    // test would pass against the old rule too and prove nothing.
    expect(
      bookingsOverlap(
        { checkIn: rows[0].checkIn as Date, checkOut: rows[0].checkOut as Date },
        { checkIn: rows[1].checkIn as Date, checkOut: rows[1].checkOut as Date },
      ),
      "the two bookings must really overlap for this to be the case under test",
    ).toBe(true);

    // THE KEY COMES FROM THE ENGINE'S OWN STRANDED ROWS, not from a hand-built
    // fixture: a key computed from guessed nights would mismatch and the second
    // call would refuse for the wrong reason entirely.
    const refused = makeStore(rows);
    const memberOptions = () =>
      hostingCoverageActorOptions({
        actorRole: "MEMBER",
        actorMemberId: "owner-1",
        vacatedRange: {
          checkIn: new Date("2026-07-03T00:00:00.000Z"),
          checkOut: new Date("2026-07-05T00:00:00.000Z"),
        },
      });
    const error = await reconcileAdultMemberHostingReviewWithSiblings(
      "b-source",
      refused.db,
      memberOptions(),
    ).then(
      () => null,
      (err: unknown) => err as SameOwnerCoverageWouldBreakError,
    );
    expect(error, "a member with no answer is refused, which is where the key comes from").toBeTruthy();
    const stateKey = strandedCoverageStateKey(error!.stranded, "b-source");

    const { db, queued } = makeStore(rows);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          actorRole: "MEMBER",
          actorMemberId: "owner-1",
          vacatedRange: {
            checkIn: new Date("2026-07-03T00:00:00.000Z"),
            checkOut: new Date("2026-07-05T00:00:00.000Z"),
          },
          linkedMove: {
            answer: { choice: "LEAVE_UNCOVERED", acknowledged: true, stateKey },
            bookingOwnerMemberId: "owner-1",
          },
        }),
      ),
    ).resolves.toBeTruthy();

    const ownRow = queued.find((item) => item.sourceBookingId === "b-main");
    expect(
      ownRow,
      "INV-HOST-053: the acknowledged booking needs a row of its own, overlap or not",
    ).toBeTruthy();
    expect(ownRow?.cause).toBe("OWNER_DECLINED_LINKED_MOVE");
    expect(ownRow?.reason).toBe(LINKED_MOVE_DECLINED_INCIDENT_REASON);
  });

  it("refuses an officer the member's answer, so §7's reason is still owed", async () => {
    // THE AUTHORISATION HOLE THIS PINS. `hostingCoverageLinkedMove` is
    // deliberately not one of either save route's admin-gated flags — right,
    // because it is a MEMBER's field — so an officer can send it. An officer
    // refused with `SameOwnerCoverageOverrideRequiredError` is handed the
    // `strandedStateKey` in that refusal body; resubmitting it as a declined
    // linked move used to be honoured, because the decline branch was evaluated
    // above the officer branch and checked neither role nor ownership. The change
    // then proceeded with `overrideReason: null`, `overriddenByMemberId: null` and
    // an incident whose recorded reason says THE MEMBER was asked — about a
    // booking that is not theirs, and a member who was never asked. All three of
    // §7's requirements (explicit confirmation, mandatory reason, officer
    // attribution) defeated at once, and the cause count `INV-HOST-052` protects
    // corrupted quietly.
    const { db } = makeStore([
      sourceWithAdult("b-source", ["2026-07-20", "2026-07-21"]),
      booking({ id: "b-main", guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])] }),
    ]);
    const stranded = [
      {
        bookingId: "b-main",
        reference: strandedCoverageReference("b-main"),
        lodgeName: "Ruapehu Lodge",
        nights: ["2026-07-03", "2026-07-04"],
        checkIn: "2026-07-03",
        checkOut: "2026-07-05",
      },
    ];
    let error: unknown = null;
    try {
      await reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          actorRole: "ADMIN",
          actorMemberId: "officer-1",
          vacatedRange: VACATED,
          // The member's field, sent by somebody who is not the member, carrying
          // the key the officer's own refusal handed them.
          linkedMove: {
            answer: {
              choice: "LEAVE_UNCOVERED",
              acknowledged: true,
              stateKey: strandedCoverageStateKey(stranded, "b-source"),
            },
            bookingOwnerMemberId: "owner-1",
          },
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(
      error,
      "INV-HOST-050: only the booking's own member may answer the offer; an officer still owes §7's override",
    ).toBeInstanceOf(SameOwnerCoverageOverrideRequiredError);
  });

  it("re-prompts rather than honouring an answer about a different situation", async () => {
    // A stale acceptance is another first submission. The member answered about
    // the bookings and nights they were SHOWN; honouring it against a set that has
    // moved would strand something they were never asked about.
    const { db } = makeStore([
      sourceWithAdult("b-source", ["2026-07-20", "2026-07-21"]),
      booking({ id: "b-main", guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])] }),
    ]);
    let error: SameOwnerCoverageWouldBreakError | null = null;
    try {
      await reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          actorRole: "MEMBER",
          actorMemberId: "owner-1",
          vacatedRange: VACATED,
          linkedMove: {
            answer: {
              choice: "LEAVE_UNCOVERED",
              acknowledged: true,
              stateKey: "v1:" + "f".repeat(64),
            },
            bookingOwnerMemberId: "owner-1",
          },
        }),
      );
    } catch (caught) {
      error = caught as SameOwnerCoverageWouldBreakError;
    }
    expect(error).toBeInstanceOf(SameOwnerCoverageWouldBreakError);
    expect(
      error?.linkedMoveWouldAnswer,
      "a stale answer must produce a FRESH offer, not a dead-end refusal",
    ).toBe(true);
  });

  it("does not claim the offer for a STALE answer the shift cannot answer either", async () => {
    // The stale-answer re-throw above passed `linkedMoveWouldAnswer: true`
    // UNCONDITIONALLY, while the first-submission throw computed it. So a member
    // re-submitting a stale decline whose NEW stranding is one a shift cannot fix
    // — a shortening, exactly the case pinned earlier in this file — was offered
    // a move the rule says should stay a plain refusal, and the offer would then
    // fail because the dependent's target is where it already is. Both throws now
    // ask the same question of the same predicate.
    const { db } = makeStore([
      sourceWithAdult("b-source", ["2026-08-10", "2026-08-11"]),
      booking({
        id: "b-main",
        checkIn: new Date("2026-08-13T00:00:00.000Z"),
        checkOut: new Date("2026-08-14T00:00:00.000Z"),
        guests: [guestRow("kid", ["2026-08-13"])],
      }),
    ]);
    let error: SameOwnerCoverageWouldBreakError | null = null;
    try {
      await reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          actorRole: "MEMBER",
          actorMemberId: "owner-1",
          // Ten to fifteen August, cut back to ten to twelve: the arrival did not
          // move, so no shift can carry the 13-14 dependent back under cover.
          vacatedRange: {
            checkIn: new Date("2026-08-10T00:00:00.000Z"),
            checkOut: new Date("2026-08-15T00:00:00.000Z"),
          },
          linkedMove: {
            answer: {
              choice: "LEAVE_UNCOVERED",
              acknowledged: true,
              stateKey: "v1:" + "f".repeat(64),
            },
            bookingOwnerMemberId: "owner-1",
          },
        }),
      );
    } catch (caught) {
      error = caught as SameOwnerCoverageWouldBreakError;
    }
    expect(error).toBeInstanceOf(SameOwnerCoverageWouldBreakError);
    expect(
      error?.linkedMoveWouldAnswer,
      "INV-HOST-050: a stale answer is a fresh first submission, judged by the same predicate",
    ).toBe(false);
  });

  it("still escalates rather than refusing when the actor is not the owner", async () => {
    // §6/§11 unchanged by #3232, and worth pinning here because the offer names
    // the OWNER's other bookings. An actor who is not the owner must never reach
    // the offer at all — they could not act on it, and it would disclose another
    // account's booking to them.
    const { db, queued } = makeStore([
      sourceWithAdult("b-source", ["2026-07-20", "2026-07-21"]),
      booking({ id: "b-main", guests: [guestRow("kid", ["2026-07-03", "2026-07-04"])] }),
    ]);
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        "b-source",
        db,
        hostingCoverageActorOptions({
          actorRole: "MEMBER",
          actorMemberId: "somebody-else",
          vacatedRange: VACATED,
        }),
      ),
    ).resolves.toBeTruthy();
    expect(queued.length).toBeGreaterThan(0);
  });
});
