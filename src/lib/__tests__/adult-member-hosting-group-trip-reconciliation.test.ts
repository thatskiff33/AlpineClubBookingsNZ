// #3039 (epic #2943) — reconciling the OTHER accounts in a Group Trip when a
// change may have taken away the adult they were relying on.
//
// ENFORCES INV-HOST-046 (allow the actor's change, escalate the sibling, disclose
// nothing) and INV-LOCK-002 (the per-trip key is taken before the sorted owner
// keys) from `docs/invariants/`. Every assertion that carries one of those rules
// repeats the id in its failure message, so whoever trips it is handed the rule
// rather than having to go and find it (#2691).
//
// WHAT A UNIT TEST CAN AND CANNOT DO HERE. It cannot prove two PostgreSQL
// transactions serialise — `adult-member-hosting-group-trip-races.realdb.test.ts`
// does that against a real database. What it CAN pin is everything that would
// silently disable the machinery while leaving the rest of the tree green: the
// key's namespace and SQL shape, the ORDER of the two families' acquisitions, the
// re-read under the key, the exact queue item shape the participant fence demands,
// and the fact that the cross-account path can refuse nothing at all. Each of
// those is a one-line mutation somebody could make in good faith.
//
// THE STORE REALLY APPLIES `where`. This child is entirely about which bookings
// are and are not related, so a double that ignored the clauses would pass every
// test below for the wrong reason. `matchesWhere` applies the real predicates and
// THROWS on an operator it does not model.
import { AgeTier } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The evaluator asks the club for its #2543 subscription-lockout mode through the
// MODULE Prisma client rather than the injected `db`. Against the unreachable test
// DATABASE_URL that costs seconds of connection retries per evaluation. The mode is
// a club setting and is not what this file asserts; `HARD_BLOCK` is the default that
// makes `loadUnpaidSubscriptionMemberIds` a no-op.
vi.mock("@/lib/member-subscription-eligibility", () => ({
  peekSubscriptionLockoutMode: async () => "HARD_BLOCK",
  resolveSubscriptionLockoutMode: async () => "HARD_BLOCK",
}));

import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import {
  GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT,
  SAME_GROUP_TRIP_COVERAGE_SOURCE_LIMIT,
} from "@/lib/adult-member-hosting-coverage-ceilings";
import {
  HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS,
  HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS,
  lockHostingCoverageGroup,
  lockHostingCoverageGroups,
  tryLockHostingCoverageGroups,
} from "@/lib/adult-member-hosting-coverage-lock";
import { HOSTING_COVERAGE_RETRY_CODE } from "@/lib/adult-member-hosting-queue-participants";
import {
  loadGroupTripCoverageDependentOwnerIds,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";

const LODGE = "lodge-a";
const TRIP = "group-trip-1";
const OTHER_TRIP = "group-trip-2";

function readRepoCode(relativePath: string): string {
  return stripComments(readFileSync(path.resolve(process.cwd(), relativePath), "utf8"));
}

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * A club-wide policy row. `ENFORCED` because the cross-account questions this file
 * asks — would a member be refused, would an officer be prompted, is an incident
 * owed — only exist at an enforcing club, and answering them under
 * `ADMIN_REVIEW_REQUIRED` would be answering an easier question.
 */
function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "policy-club",
    scopeKey: "club-wide",
    lodgeId: null,
    mode: "ENFORCED",
    capacityMode: "NO_HOLD",
    version: 7,
    hostScopeSameBooking: true,
    hostScopeSameBookingOwner: false,
    hostScopeSameGroupTrip: true,
    ...overrides,
  };
}

const GROUP_TRIP_OFF = [policyRow({ hostScopeSameGroupTrip: false })];

function guestRow(id: string, nights: string[], memberId: string | null = null) {
  return {
    id,
    firstName: id,
    lastName: "Person",
    memberId,
    stayStart: new Date(`${nights[0]}T00:00:00.000Z`),
    stayEnd: new Date(`${nights[nights.length - 1]}T00:00:00.000Z`),
    consentStatus: null,
    nights: nights.map((night) => ({
      stayDate: new Date(`${night}T00:00:00.000Z`),
    })),
    member: memberId
      ? {
          id: memberId,
          ageTier: AgeTier.ADULT,
          active: true,
          cancelledAt: null,
          archivedAt: null,
        }
      : null,
  };
}

type FakeBooking = Record<string, unknown>;

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

function organiserOf(trip: string, overrides: FakeBooking = {}): FakeBooking {
  return booking({
    id: `organiser-${trip}`,
    memberId: `organiser-member-${trip}`,
    groupBookingAsOrganiser: { id: trip },
    ...overrides,
  });
}

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
    if ("some" in operators) {
      const nested = operators.some as Record<string, unknown>;
      const list = (value ?? []) as FakeBooking[];
      if (!list.some((entry) => matchesWhere(entry, nested))) return false;
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

function project(row: FakeBooking, select: Record<string, unknown> | undefined) {
  if (!select) return row;
  const out: FakeBooking = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
}

interface StoreOptions {
  policies?: unknown[];
  /**
   * Mutate the store the first time the Group Trip dependent read runs, so the
   * under-lock re-read sees a different world. This is the only way to model
   * "somebody else committed between the plan and the lock" without a real
   * database, and the re-read is the requirement it exists to prove.
   */
  onFirstDependentRead?: (rows: Map<string, FakeBooking>) => void;
  /** Fail the try-lock for this trip, as a conflicting transaction would. */
  contendedGroupKeys?: readonly string[];
}

function makeStore(rows: FakeBooking[], options: StoreOptions = {}) {
  const byId = new Map(rows.map((row) => [row.id as string, { ...row }]));
  /** Every advisory-lock statement, in acquisition order, with its key values. */
  const locks: Array<{ namespace: string; key: string; blocking: boolean }> = [];
  const queued: Array<Record<string, unknown>> = [];
  const bookingWheres: Array<Record<string, unknown>> = [];
  let dependentReads = 0;

  function recordLock(sql: string, values: unknown[], blocking: boolean) {
    if (!sql.includes("advisory")) return;
    const [namespace, key] = values as [string, string];
    locks.push({ namespace, key, blocking });
  }

  const db = {
    $executeRaw: vi.fn(
      async (strings: TemplateStringsArray | { sql?: string }, ...values: unknown[]) => {
        const sql = Array.isArray(strings)
          ? (strings as unknown as string[]).join("?")
          : String((strings as { sql?: string }).sql ?? "");
        const args = Array.isArray(strings)
          ? values
          : ((strings as { values?: unknown[] }).values ?? []);
        recordLock(sql, args, true);
        return 1;
      },
    ),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      recordLock(sql, values, false);
      const [namespace, key] = values as [string, string];
      if (
        namespace === HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS &&
        (options.contendedGroupKeys ?? []).includes(key)
      ) {
        return [{ locked: false }];
      }
      return [{ locked: true }];
    }),
    booking: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const row = byId.get(where.id);
        return row ? project(row, select) : null;
      }),
      findMany: vi.fn(async ({ where, select, orderBy, take }: any) => {
        bookingWheres.push(where);
        const isDependentRead =
          Array.isArray(where?.AND) &&
          where.AND.some((clause: any) => Array.isArray(clause?.OR));
        if (isDependentRead) dependentReads += 1;
        let matched = [...byId.values()].filter((row) => matchesWhere(row, where));
        // AFTER the rows for THIS read are chosen, so the plan read returns the old
        // world and the under-lock re-read returns the new one. Mutating first would
        // let both reads see the same thing and the test would pass vacuously.
        if (isDependentRead && dependentReads === 1) {
          options.onFirstDependentRead?.(byId);
        }
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
        const guestWhere = select?.guests?.where;
        return matched.map((row) => {
          const projected = project(row, select);
          if (!guestWhere) return projected;
          return {
            ...projected,
            guests: (row.guests as Array<Record<string, unknown>>).filter((guest) =>
              matchesWhere(guest, guestWhere),
            ),
          };
        });
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = byId.get(where.id);
        if (row) byId.set(where.id, { ...row, ...data });
        return {};
      }),
      count: vi.fn(async ({ where }: any) => {
        return [...byId.values()].filter((row) => matchesWhere(row, where)).length;
      }),
    },
    adultMemberHostingPolicy: {
      findMany: vi.fn(async () => options.policies ?? [policyRow()]),
    },
    lodge: { findFirst: vi.fn(async () => ({ name: "Ruapehu Lodge" })) },
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
      create: vi.fn(async ({ data }: any) => {
        queued.push(data);
        return { id: `queue-${queued.length}` };
      }),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  } as any;

  return { db, locks, queued, bookingWheres, byId };
}

/**
 * The queue items written for OTHER bookings in the trip.
 *
 * The changed booking's OWN item is not one of them and is not noise: at an
 * enforcing lodge `settleSameOwnerDependentCoverage` records it on every write
 * regardless of scope, because confirmation can turn this booking into a live
 * incident source and a later correction must close it. Filtering it out is what
 * keeps these assertions about the FAN-OUT.
 */
function siblingSources(queued: Array<Record<string, unknown>>): string[] {
  return queued
    .map((item) => item.sourceBookingId as string)
    .filter((id) => id !== `organiser-${TRIP}` && id !== "b-main")
    .sort();
}

/** Only the two coverage families, in acquisition order. */
function coverageLockOrder(
  locks: Array<{ namespace: string; key: string }>,
): string[] {
  return locks
    .filter((lock) =>
      [
        HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS,
        HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS,
      ].includes(lock.namespace),
    )
    .map((lock) => `${lock.namespace}:${lock.key}`);
}

/**
 * The trip: an organiser whose adult member is travelling, plus two joined
 * bookings on OTHER accounts that carry non-member guests and nobody who can host
 * them. The organiser's booking is the one under change, so removing its adult is
 * what strands the two joiners.
 */
function tripRows(overrides: { organiser?: FakeBooking } = {}) {
  return [
    organiserOf(TRIP, {
      guests: [
        guestRow("organiser-adult", ["2026-08-03", "2026-08-04"], "adult-source"),
      ],
      ...overrides.organiser,
    }),
    joinerOf(TRIP, "joiner-a", {
      guests: [guestRow("kid-a", ["2026-08-03", "2026-08-04"])],
    }),
    joinerOf(TRIP, "joiner-b", {
      guests: [guestRow("kid-b", ["2026-08-03", "2026-08-04"])],
    }),
  ];
}

const OFFICER = {
  dependentCoverage: "ESCALATE" as const,
  coverageActorMemberId: "officer-1",
  coverageChange: {
    cause: "SYSTEM_CHANGE" as const,
    actorMemberId: "officer-1",
    reason: null,
  },
};

describe("the per-trip coverage lock (#3039, INV-LOCK-002)", () => {
  function recordingClient() {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    return {
      calls,
      $executeRaw: vi.fn(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          calls.push({ sql: strings.join("?"), values });
          return 1;
        },
      ),
    };
  }

  it("takes a transaction-scoped advisory lock in its own namespace, keyed on the trip", async () => {
    const db = recordingClient();
    await lockHostingCoverageGroup(db, TRIP);
    expect(db.calls).toHaveLength(1);
    const [call] = db.calls;
    // TRANSACTION-scoped: a session lock would outlive the transaction and never be
    // released by a pooled connection.
    expect(call.sql).toContain("pg_advisory_xact_lock");
    expect(call.sql).not.toContain("pg_advisory_lock(");
    expect(call.values).toEqual([
      HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS,
      TRIP,
    ]);
    expect(HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS).toBe(
      "hosting-coverage-group",
    );
    // Its own keyspace. A namespace shared with the owner key would make one
    // member's account collide with an unrelated trip whose id happened to hash the
    // same, and would silently serialise them against each other.
    expect(HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS).not.toBe(
      HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS,
    );
  });

  it("acquires several trips in sorted order, so composing can never deadlock", async () => {
    const db = recordingClient();
    await lockHostingCoverageGroups(db, ["trip-z", "trip-a", "trip-m"]);
    expect(db.calls.map((call) => call.values[1])).toEqual([
      "trip-a",
      "trip-m",
      "trip-z",
    ]);
  });

  it("de-duplicates and ignores absent trips", async () => {
    const db = recordingClient();
    await lockHostingCoverageGroups(db, [TRIP, TRIP, null, undefined, ""]);
    expect(db.calls).toHaveLength(1);
    const empty = recordingClient();
    await lockHostingCoverageGroups(empty, [null, undefined]);
    expect(empty.calls).toHaveLength(0);
  });

  it("is a no-op on a client that cannot run raw SQL, rather than throwing", async () => {
    await expect(lockHostingCoverageGroup({}, TRIP)).resolves.toBeUndefined();
    await expect(lockHostingCoverageGroup(null, TRIP)).resolves.toBeUndefined();
    await expect(tryLockHostingCoverageGroups({}, [TRIP])).resolves.toBe(true);
  });

  it("reports a lost race as false rather than waiting", async () => {
    const db = {
      $queryRaw: vi.fn(async () => [{ locked: false }]),
    };
    await expect(tryLockHostingCoverageGroups(db, [TRIP])).resolves.toBe(false);
    // One statement, not three: a lost key stops the sequence, so the caller never
    // holds a partial set it would then have to release in order.
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("the Group Trip reconciliation fan-out (#3039, INV-HOST-046)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("takes the trip key BEFORE the owner keys", async () => {
    // INV-LOCK-002. Group before owner because the trip's membership is what decides
    // WHICH owners the fan-out will name — so the owner set is not even known until
    // the trip key is held. Reversing these two lines is the mutation this pins.
    const { db, locks } = makeStore(tripRows(), {
      policies: [policyRow({ hostScopeSameBookingOwner: true })],
    });
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      OFFICER,
    );
    const order = coverageLockOrder(locks);
    const firstGroup = order.findIndex((entry) =>
      entry.startsWith(HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS),
    );
    const firstOwner = order.findIndex((entry) =>
      entry.startsWith(HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS),
    );
    expect(
      firstGroup,
      "INV-LOCK-002 (docs/invariants/operations.md): no per-trip coverage key was taken at all",
    ).toBeGreaterThan(-1);
    expect(
      firstOwner,
      "INV-LOCK-002: no per-owner coverage key was taken, so this test cannot speak to the order",
    ).toBeGreaterThan(-1);
    expect(
      firstGroup,
      "INV-LOCK-002 (docs/invariants/operations.md): the hosting-coverage-group key must be acquired BEFORE any hosting-coverage-owner key",
    ).toBeLessThan(firstOwner);
  });

  it("tries the trip key fail-fast before it takes it blocking", async () => {
    // A trip key is shared with other accounts, and two transactions can discover
    // two trip keys in opposite orders, so a blocking-only acquisition is a real
    // hold-and-wait edge. Deleting the try form leaves every other test green.
    const { db, locks } = makeStore(tripRows());
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      OFFICER,
    );
    const group = locks.filter(
      (lock) => lock.namespace === HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS,
    );
    expect(group.length).toBeGreaterThan(1);
    expect(
      group[0]?.blocking,
      "INV-LOCK-002: the first hosting-coverage-group acquisition must be the fail-fast pg_try_advisory_xact_lock form",
    ).toBe(false);
    expect(group.some((lock) => lock.blocking)).toBe(true);
  });

  it("rolls the whole change back with the stable retry when the trip key is contended", async () => {
    const { db, queued } = makeStore(tripRows(), {
      contendedGroupKeys: [TRIP],
    });
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        `organiser-${TRIP}`,
        db,
        OFFICER,
      ),
    ).rejects.toMatchObject({ code: HOSTING_COVERAGE_RETRY_CODE });
    // Nothing queued: a lost race must not half-record the obligation.
    expect(queued).toEqual([]);
  });

  it("enqueues one bounded item per sibling booking, each naming ITSELF as its source", async () => {
    // THE SHAPE IS NOT A STYLE CHOICE. `assertHostingCoverageQueueParticipantsLocked`
    // demands a proof source whose `bookingId` is the item's `sourceBookingId` AND
    // whose `ownerMemberId` is the item's `memberId`, so an item naming the actor's
    // own booking as the source of a sibling owner's work is REFUSED by the fence.
    const { db, queued } = makeStore(tripRows());
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      OFFICER,
    );
    const siblingItems = queued.filter((item) =>
      siblingSources(queued).includes(item.sourceBookingId as string),
    );
    expect(
      siblingItems.map((item) => [item.sourceBookingId, item.memberId]).sort(),
      "INV-HOST-046 (docs/invariants/adult-member-hosting.md): every Group Trip sibling owner must receive its own bounded re-evaluation item",
    ).toEqual([
      ["joiner-a", "joiner-member-joiner-a"],
      ["joiner-b", "joiner-member-joiner-b"],
    ]);
    for (const item of siblingItems) {
      expect(item.lodgeId).toBe(LODGE);
      // A third party's incident is a SYSTEM_CHANGE. An officer's override is
      // authority over stranding on the account they were working on, and recording
      // it here would put their name and reason against an incident they never
      // considered.
      expect(item.cause).toBe("SYSTEM_CHANGE");
      expect(item.reason).toBeNull();
      expect(item.actorMemberId).toBe("officer-1");
      // The CHANGED booking's nights, not the dependent's: a change cannot affect a
      // night it never touched, so this is the bound rather than a narrowing.
      expect(item.nights).toEqual(["2026-08-03", "2026-08-04"]);
    }
  });

  it("never refuses, whoever the actor is and whatever it would strand", async () => {
    // The epic's settled lifecycle rule: allow the actor's valid change, escalate the
    // affected booking to officers, and disclose nothing about the other account. A
    // refusal would let one account control another AND would itself disclose that
    // somebody else depends on them. So there is no group counterpart to
    // `SameOwnerCoverageWouldBreakError` and none to the officer override prompt.
    for (const actor of [
      // An ordinary member editing their own booking: the disposition that DOES
      // refuse for a same-owner dependent.
      {
        dependentCoverage: "BLOCK" as const,
        coverageActorMemberId: `organiser-member-${TRIP}`,
        coverageChange: {
          cause: "SYSTEM_CHANGE" as const,
          actorMemberId: `organiser-member-${TRIP}`,
          reason: null,
        },
      },
      // An officer with no override captured: the disposition that DOES prompt.
      {
        dependentCoverage: "REQUIRE_OVERRIDE" as const,
        coverageActorMemberId: "officer-1",
        coverageChange: {
          cause: "SYSTEM_CHANGE" as const,
          actorMemberId: "officer-1",
          reason: null,
        },
      },
    ]) {
      const { db, queued } = makeStore(tripRows());
      await expect(
        reconcileAdultMemberHostingReviewWithSiblings(
          `organiser-${TRIP}`,
          db,
          actor,
        ),
        "INV-HOST-046: a change that strands another account's Group Trip booking must proceed, not refuse",
      ).resolves.toBeDefined();
      expect(queued.length).toBeGreaterThan(0);
    }
  });

  it("re-reads the sibling set under the trip key and retries if it moved", async () => {
    // The issue's explicit reasoning: a re-read WITHOUT the shared serialisation
    // point is insufficient, because at READ COMMITTED each of two writers can
    // observe a state the other has already invalidated. The plan runs unlocked
    // because the owners it finds are what the participant fence must lock — so the
    // plan is a hypothesis and the under-lock read is what makes it a fact.
    const { db, queued } = makeStore(tripRows(), {
      onFirstDependentRead: (rows) => {
        rows.set(
          "joiner-c",
          joinerOf(TRIP, "joiner-c", {
            guests: [guestRow("kid-c", ["2026-08-03", "2026-08-04"])],
          }),
        );
      },
    });
    await expect(
      reconcileAdultMemberHostingReviewWithSiblings(
        `organiser-${TRIP}`,
        db,
        OFFICER,
      ),
    ).rejects.toMatchObject({ code: HOSTING_COVERAGE_RETRY_CODE });
    expect(
      queued,
      "INV-HOST-046: a sibling set that moved between the plan and the trip key must roll the change back, never enqueue against an unlocked owner",
    ).toEqual([]);
  });

  it("fans out to the trip even when the changed booking is being cancelled", async () => {
    // Cancellation is the headline case: the source stops supplying cover, so the
    // siblings are exactly the bookings that need re-evaluating. The dependent read
    // is keyed on the SIBLINGS' status, never the source's, so a terminal source
    // still fans out.
    const rows = tripRows();
    rows[0] = { ...rows[0], status: "CANCELLED" };
    const { db, queued } = makeStore(rows);
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      OFFICER,
    );
    expect(
      siblingSources(queued),
      "INV-HOST-046: cancelling a Group Trip booking must still re-evaluate its siblings",
    ).toEqual(["joiner-a", "joiner-b"]);
  });

  it("takes no trip key and writes no sibling item when the scope is off", async () => {
    const { db, locks, queued } = makeStore(tripRows(), {
      policies: GROUP_TRIP_OFF,
    });
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      OFFICER,
    );
    expect(
      locks.filter(
        (lock) =>
          lock.namespace === HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS,
      ),
    ).toEqual([]);
    expect(siblingSources(queued)).toEqual([]);
  });

  it("takes no trip key for a booking that is in no Group Trip", async () => {
    // The scope ON, at a club that uses it, for an ordinary booking: still nothing.
    // A booking in no trip has no key to take and no sibling to tell. The booking is
    // compliant on its own so the enforced consequence does not throw first — the
    // question here is the key, not the refusal.
    const { db, locks, queued } = makeStore([
      booking({
        guests: [
          guestRow("kid", ["2026-08-03", "2026-08-04"]),
          guestRow("adult", ["2026-08-03", "2026-08-04"], "adult-own"),
        ],
      }),
    ]);
    await reconcileAdultMemberHostingReviewWithSiblings("b-main", db, OFFICER);
    expect(
      locks.filter(
        (lock) =>
          lock.namespace === HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS,
      ),
    ).toEqual([]);
    expect(siblingSources(queued)).toEqual([]);
  });

  it("ignores a booking in a DIFFERENT trip", async () => {
    const rows = [
      ...tripRows(),
      joinerOf(OTHER_TRIP, "outsider", {
        guests: [guestRow("kid-x", ["2026-08-03", "2026-08-04"])],
      }),
    ];
    const { db, queued } = makeStore(rows);
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      OFFICER,
    );
    expect(queued.map((item) => item.sourceBookingId)).not.toContain("outsider");
  });

  it("bounds the fan-out at the trip ceiling", async () => {
    const rows: FakeBooking[] = [
      organiserOf(TRIP, {
        guests: [
          guestRow("organiser-adult", ["2026-08-03", "2026-08-04"], "adult-source"),
        ],
      }),
    ];
    for (let index = 0; index < GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT + 5; index += 1) {
      rows.push(
        joinerOf(TRIP, `joiner-${String(index).padStart(3, "0")}`, {
          guests: [guestRow(`kid-${index}`, ["2026-08-03", "2026-08-04"])],
        }),
      );
    }
    const { db, queued } = makeStore(rows);
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      OFFICER,
    );
    expect(siblingSources(queued)).toHaveLength(
      GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT,
    );
  });

  it("keeps the dependent ceiling at the source ceiling, and as its own constant", () => {
    // Same population read from the other end: if a trip may hold this many
    // overlapping live bookings as SOURCES, a change to one of them may owe
    // re-evaluation to that many DEPENDENTS. It stays a SEPARATE constant because
    // the safe-failure direction inverts — a truncated source read errs towards the
    // rule, a truncated dependent read loses a stranded booking silently.
    expect(GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT).toBe(
      SAME_GROUP_TRIP_COVERAGE_SOURCE_LIMIT,
    );
    const ceilings = readRepoCode(
      "src/lib/adult-member-hosting-coverage-ceilings.ts",
    );
    expect(ceilings).toContain("export const GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT");
    expect(ceilings).toContain(
      "export const SAME_GROUP_TRIP_COVERAGE_SOURCE_LIMIT",
    );
  });

  it("is idempotent: a second identical reconciliation records the same shape", async () => {
    // Items dedupe downstream rather than at insert (`enqueueHostingCoverageReevaluation`
    // is a plain create; idempotency lives in the incident `stateKey` and the
    // notification lease), so "idempotent" here means the fan-out is a pure function
    // of the rows and never widens on a second pass.
    const rows = tripRows();
    const first = makeStore(rows);
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      first.db,
      OFFICER,
    );
    const second = makeStore(rows);
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      second.db,
      OFFICER,
    );
    expect(second.queued).toEqual(first.queued);
  });
});

describe("what the actor is told, and what the owner queue resolves (#3039)", () => {
  it("returns the actor's own outcome and nothing about the other account", async () => {
    const { db, queued } = makeStore(tripRows());
    const outcome = await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      {
        dependentCoverage: "BLOCK",
        coverageActorMemberId: `organiser-member-${TRIP}`,
        coverageChange: {
          cause: "SYSTEM_CHANGE",
          actorMemberId: `organiser-member-${TRIP}`,
          reason: null,
        },
      },
    );
    // The returned outcome names the actor's own booking's hazard state and carries
    // no sibling field at all — there is nowhere in the shape for one to appear.
    expect(Object.keys(outcome).sort()).toEqual(["action", "mode", "violation"]);
    const serialised = JSON.stringify(outcome);
    for (const secret of [
      "joiner-a",
      "joiner-b",
      "joiner-member-joiner-a",
      "joiner-member-joiner-b",
      TRIP,
    ]) {
      expect(
        serialised,
        "INV-HOST-046: the actor's answer must not carry a sibling booking's identity or compliance state",
      ).not.toContain(secret);
    }
    // ...while the officer queue does get told.
    expect(siblingSources(queued)).toEqual(["joiner-a", "joiner-b"]);
  });

  it("raises no group-specific refusal class anywhere in the tree", () => {
    // #3038's `resolveDependentDisposition` already downgrades BLOCK to ESCALATE for
    // an actor who is not the booking's owner, which IS the non-disclosure rule. So
    // #3039 needed no new refusal type, no new error body and no new member-facing
    // sentence — and this asserts that none appeared, because a later lane adding a
    // "your group is affected" message would reintroduce exactly the disclosure the
    // owner's contract forbids.
    const engine = readRepoCode("src/lib/adult-member-hosting-review.ts");
    const settleStart = engine.indexOf(
      "async function settleGroupTripDependentCoverage(",
    );
    expect(settleStart).toBeGreaterThan(-1);
    const settleEnd = engine.indexOf("\n}", settleStart);
    const body = engine.slice(settleStart, settleEnd);
    for (const name of [
      "throw",
      "SameOwnerCoverageWouldBreakError",
      "SameOwnerCoverageOverrideRequiredError",
      "formatStrandedCoverageMessage",
      "resolveDependentDisposition",
    ]) {
      expect(
        body,
        `INV-HOST-046: the Group Trip fan-out must not ${
          name === "throw" ? "throw at all" : `reach ${name}`
        } — it can refuse nothing`,
      ).not.toContain(name);
    }
    // And no such class was added anywhere: the two same-owner refusals are still the
    // only cross-booking coverage refusals in the tree.
    const sameOwner = readRepoCode("src/lib/adult-member-hosting-same-owner.ts");
    expect(sameOwner.match(/extends ApiError/g) ?? []).toHaveLength(2);
    expect(sameOwner).not.toContain("GroupTripCoverage");
  });
});

describe("the container's own status governs joining, not cover (#3039, INV-HOST-043)", () => {
  it("needs no hosting reconciliation hook on close or reopen", () => {
    // Closing a group stops NEW bookings joining; it takes no adult off any booking
    // that already joined, so there is nothing to re-evaluate. A hook here would
    // strip cover from live, compliant bookings whose party has not changed at all.
    const groupBooking = readRepoCode("src/lib/group-booking.ts");
    for (const writer of ["closeGroupBooking", "reopenGroupBooking"]) {
      const start = groupBooking.indexOf(`export async function ${writer}(`);
      expect(start, writer).toBeGreaterThan(-1);
      const body = groupBooking.slice(start, groupBooking.indexOf("\n}", start));
      expect(
        body,
        `INV-HOST-043: ${writer} must not reach the hosting rule — a container's status decides joining, not cover`,
      ).not.toContain("HostingCoverage");
      expect(body).not.toContain("reconcileAdultMemberHostingReview");
    }
  });

  it("keeps the container's status out of the group coverage predicates", () => {
    const identity = readRepoCode("src/lib/group-trip-identity.ts");
    expect(
      identity,
      "INV-HOST-043: GroupBooking.status must appear in no coverage predicate",
    ).not.toContain("GroupBookingStatus");
  });
});

describe("hard delete and the SetNull path (#3039)", () => {
  it("can only delete from a status that never supplied cover", () => {
    // Why the delete paths need no hosting seam, as a PROOF rather than an
    // assumption. `booking-delete.ts` hard-deletes only DRAFT and soft-deletes only
    // CANCELLED. Neither is in `HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES`, so
    // neither was supplying cover to anybody and no sibling's answer changes.
    //
    // The `GroupBookingJoin.bookingId` SetNull and the `GroupBooking` cascade ride
    // on the same gate: both fire only on a HARD delete, which only a DRAFT reaches,
    // and `OPENABLE_ORGANISER_STATUSES` means an organiser's booking was never DRAFT
    // when its group was created — so a cascade cannot destroy a live trip's
    // identity underneath its joiners.
    const deletes = readRepoCode("src/lib/booking-delete.ts");
    expect(deletes).toContain("BookingStatus.DRAFT");
    expect(deletes).toContain("BookingStatus.CANCELLED");
    expect(
      deletes,
      "INV-HOST-046: a booking-delete path that can delete a live booking would need a Group Trip reconciliation seam",
    ).not.toContain("BookingStatus.CONFIRMED");
    const status = readRepoFile("src/lib/booking-status.ts");
    const sourceStatuses = status.slice(
      status.indexOf("HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES = ["),
      status.indexOf("] as const", status.indexOf("HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES = [")),
    );
    expect(sourceStatuses).not.toContain("DRAFT");
    expect(sourceStatuses).not.toContain("CANCELLED");
    const groupBooking = readRepoCode("src/lib/group-booking.ts");
    const openable = groupBooking.slice(
      groupBooking.indexOf("OPENABLE_ORGANISER_STATUSES"),
      groupBooking.indexOf("]", groupBooking.indexOf("OPENABLE_ORGANISER_STATUSES")),
    );
    expect(openable).not.toContain("DRAFT");
  });
});

describe("the inline drain reaches the sibling owners (#3039)", () => {
  it("resolves the trip's dependent owners for the post-commit claim", async () => {
    const { db } = makeStore(tripRows());
    await expect(
      loadGroupTripCoverageDependentOwnerIds(`organiser-${TRIP}`, db),
    ).resolves.toEqual([
      "joiner-member-joiner-a",
      "joiner-member-joiner-b",
    ]);
  });

  it("resolves nothing when the scope is off, so an unaffected club pays nothing", async () => {
    const { db, locks } = makeStore(tripRows(), { policies: GROUP_TRIP_OFF });
    await expect(
      loadGroupTripCoverageDependentOwnerIds(`organiser-${TRIP}`, db),
    ).resolves.toEqual([]);
    // And it takes no lock: this runs on the response path after the commit, where a
    // wrong answer costs a delay and never a lost obligation.
    expect(locks).toEqual([]);
  });

  it("narrows the inline claim to those owners rather than to one", () => {
    // The defect this closes: `settleHostingCoverageAfterCommit` resolved the written
    // booking to ONE owner and filtered the claim to it, so every sibling item the
    // fan-out had just written was skipped and waited up to three hours for the cron.
    const drain = readRepoCode("src/lib/adult-member-hosting-coverage-drain.ts");
    const start = drain.indexOf(
      "export async function settleHostingCoverageAfterCommit(",
    );
    expect(start).toBeGreaterThan(-1);
    const body = drain.slice(start, drain.indexOf("\n}", start));
    expect(body).toContain("loadGroupTripCoverageDependentOwnerIds(");
    expect(
      body,
      "INV-HOST-046: the inline drain must claim the sibling owners' items, not only the written booking's owner",
    ).toContain("memberIds");
    const queue = readRepoCode("src/lib/adult-member-hosting-coverage-queue.ts");
    expect(queue).toContain("memberId: { in: [...new Set(options.memberIds)] }");
  });
});
