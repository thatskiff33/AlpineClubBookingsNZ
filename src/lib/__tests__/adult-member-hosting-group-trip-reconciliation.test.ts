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
// THROWS on an operator it does not model. It lives in
// `support/hosting-fake-booking-store.ts` rather than in this file: #3037 wrote it,
// #3038 copied it and this child copied it again, and by then the copies had already
// diverged (`guestRow` took a member id in one and a member row in another). See
// that module for why divergence in a coverage double is silent and dangerous.
//
// THE PER-TRIP LOCK'S OWN UNIT TESTS ARE NOT HERE either: they sit beside the
// per-owner key's in `adult-member-hosting-coverage-lock.test.ts`, which already owns
// the `topLevelFunctionBody` census helper and the reasoning that makes it correct.
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

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  booking as bookingRow,
  guestRow,
  joinerOf as joinerOfLodge,
  matchesWhere,
  memberRow,
  organiserOf as organiserOfLodge,
  policyRow as basePolicyRow,
  project,
  orderAndTake,
  type FakeBooking,
} from "@/lib/__tests__/support/hosting-fake-booking-store";
import { stripComments } from "@/lib/__tests__/support/strip-comments";
import {
  GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT,
  SAME_GROUP_TRIP_COVERAGE_SOURCE_LIMIT,
} from "@/lib/adult-member-hosting-coverage-ceilings";
import {
  HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS,
  HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS,
} from "@/lib/adult-member-hosting-coverage-lock";
import { HOSTING_COVERAGE_RETRY_CODE } from "@/lib/adult-member-hosting-queue-participants";
import {
  GROUP_TRIP_COVERAGE_SOURCE_SELECT,
  enqueueHostingCoverageReevaluationForMember,
  loadGroupTripCoverageDependentBookingIds,
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
 * Every tracked `.ts`/`.tsx` file under `src/`, excluding tests.
 *
 * `git ls-files` rather than a directory walk: an untracked scratch file must not be
 * able to fail the build, and a tracked file must not be able to hide from the scan
 * by living somewhere the walk did not think to look.
 */
function trackedSourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (file) =>
        (file.endsWith(".ts") || file.endsWith(".tsx")) &&
        !file.includes("__tests__"),
    );
}

/**
 * A club-wide policy row, over the shared column list.
 *
 * `ENFORCED` because the cross-account questions this file asks — would a member be
 * refused, would an officer be prompted, is an incident owed — only exist at an
 * enforcing club, and answering them under `ADMIN_REVIEW_REQUIRED` would be
 * answering an easier question. `SAME_GROUP_TRIP` on, for the obvious reason.
 *
 * `SAME_BOOKING_OWNER` STAYS OFF BY DEFAULT AND THAT IS DELIBERATE: it isolates the
 * Group Trip fan-out from the same-owner one, so an assertion about sibling items
 * cannot be satisfied by same-owner machinery. The dominant production configuration
 * has it ON, though, so it is not enough on its own — `BOTH_CROSS_BOOKING_SCOPES`
 * below runs the fan-out assertions again with both scopes live.
 */
function policyRow(overrides: Record<string, unknown> = {}) {
  return basePolicyRow({
    mode: "ENFORCED",
    hostScopeSameGroupTrip: true,
    ...overrides,
  });
}

const GROUP_TRIP_OFF = [policyRow({ hostScopeSameGroupTrip: false })];

/** The same club with `SAME_BOOKING_OWNER` on as well: the dominant real config. */
const BOTH_CROSS_BOOKING_SCOPES = [
  policyRow({ hostScopeSameBookingOwner: true }),
];

/** An adult member travelling, as a guest row: `memberRow` supplies the standing. */
function adultGuest(id: string, nights: string[], memberId: string) {
  return guestRow(id, nights, memberRow({ id: memberId }));
}

function booking(overrides: FakeBooking = {}): FakeBooking {
  return bookingRow(LODGE, overrides);
}

function organiserOf(trip: string, overrides: FakeBooking = {}): FakeBooking {
  return organiserOfLodge(LODGE, trip, overrides);
}

function joinerOf(
  trip: string,
  id: string,
  overrides: FakeBooking = {},
): FakeBooking {
  return joinerOfLodge(LODGE, trip, id, overrides);
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
  const audits: Array<Record<string, unknown>> = [];
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
        const filtered = [...byId.values()].filter((row) =>
          matchesWhere(row, where),
        );
        // AFTER the rows for THIS read are chosen, so the plan read returns the old
        // world and the under-lock re-read returns the new one. Mutating first would
        // let both reads see the same thing and the test would pass vacuously.
        if (isDependentRead && dependentReads === 1) {
          options.onFirstDependentRead?.(byId);
        }
        const matched = orderAndTake(filtered, orderBy, take);
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
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audits.push(data);
        return {};
      }),
    },
  } as any;

  return { db, locks, queued, bookingWheres, byId, audits };
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
        adultGuest("organiser-adult", ["2026-08-03", "2026-08-04"], "adult-source"),
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
    expect(group.some((lock) => lock.blocking)).toBe(true);
    // PER ACQUISITION SITE, NOT `group[0]`. That is the mutation this test used to
    // miss: the seam runs before the evaluator, so deleting the try from
    // `acquireHostingCoverageGroupKey` still left `[try, block, block]` — a first
    // entry that is a try, and a green test, with a blocking acquisition of a shared
    // cross-account key taken with no fail-fast in front of it. EVERY blocking
    // acquisition must be immediately preceded by a try for the SAME key.
    group.forEach((lock, index) => {
      if (!lock.blocking) return;
      const previous = group[index - 1];
      expect(
        previous && previous.blocking === false && previous.key === lock.key,
        "INV-LOCK-002 (docs/invariants/operations.md): every blocking hosting-coverage-group " +
          "acquisition must be immediately preceded by pg_try_advisory_xact_lock on the SAME key, " +
          `and acquisition ${index} for key ${lock.key} was not`,
      ).toBe(true);
    });
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
      // The DEPENDENT'S OWN nights, not the changed booking's. This used to be the
      // changed booking's, on the reasoning that a change cannot affect a night it
      // never touched — and that broke on a date move, in two places at once: the
      // dependent set no longer narrows on nights at all, and the item's nights are
      // what the drain turns back into bookings, so an item carrying nights the
      // dependent does not occupy resolves to an empty list and drops the sibling a
      // second time. See the date-move test below.
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
          adultGuest("adult", ["2026-08-03", "2026-08-04"], "adult-own"),
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
          adultGuest("organiser-adult", ["2026-08-03", "2026-08-04"], "adult-source"),
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

  it("fans out after a DATE MOVE, which is the case that used to strand silently", async () => {
    // THE DEFECT THIS PINS, in full, because it was invisible and permanent.
    //
    // Every booking writer calls the hosting seam AFTER it has written the booking —
    // `booking-date-modification-service.ts` updates `checkIn`/`checkOut` and then
    // reconciles — so the dependent read compared against the NEW dates. The
    // dependent envelope's half-open overlap clause then excluded every sibling that
    // had been relying on the OLD ones. Booking A carries the trip's only qualifying
    // adult on 3-4 August, joiners B and C are compliant only through
    // `SAME_GROUP_TRIP`, A moves to 23-24 August, and `checkOut > 23` is false for
    // both joiners: zero queue items, no incident, no email, nothing in the officer
    // queue. B and C stayed marked compliant indefinitely, because nothing
    // re-evaluates them until their own owners touch them and their owners have no
    // reason to.
    //
    // The suite had a CANCELLATION test, which passes precisely because cancelling
    // does not move dates, and no date-move test at all. That is why it escaped.
    const rows = tripRows();
    // The organiser's booking as the modification service leaves it: moved, and
    // overlapping neither joiner.
    rows[0] = {
      ...rows[0],
      checkIn: new Date("2026-08-23T00:00:00.000Z"),
      checkOut: new Date("2026-08-25T00:00:00.000Z"),
      guests: [
        adultGuest("organiser-adult", ["2026-08-23", "2026-08-24"], "adult-source"),
      ],
    };
    const { db, queued } = makeStore(rows);
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      OFFICER,
    );
    expect(
      siblingSources(queued),
      "INV-HOST-046 (docs/invariants/adult-member-hosting.md): a date move takes the cover away from " +
        "the nights the siblings occupy, so both siblings must still be re-evaluated",
    ).toEqual(["joiner-a", "joiner-b"]);
    // AND THE ITEMS MUST NAME THE SIBLINGS' OWN NIGHTS. The changed booking's nights
    // are now 23-24 August, which neither sibling occupies — an item carrying those
    // would be turned back into a booking list by the drain's own owner/lodge/night
    // read, resolve to nothing, and drop the sibling a second time in the background
    // with nothing logged.
    for (const item of queued.filter((entry) =>
      siblingSources(queued).includes(entry.sourceBookingId as string),
    )) {
      expect(
        item.nights,
        "INV-HOST-046: a sibling's item must carry the SIBLING's nights, or the drain's " +
          "owner/lodge/night read cannot find the booking the item is about",
      ).toEqual(["2026-08-03", "2026-08-04"]);
    }
  });

  it("still fans out with SAME_BOOKING_OWNER on, the dominant club configuration", async () => {
    // The default policy row in this file has `SAME_BOOKING_OWNER` OFF, deliberately,
    // so a sibling assertion cannot be satisfied by same-owner machinery. But off is
    // the MINORITY production configuration, so the whole fan-out is re-run with both
    // cross-booking scopes live: the group items must still be exactly the two
    // siblings, still naming themselves, and the owner key must still be taken after
    // the trip key.
    const { db, queued, locks } = makeStore(tripRows(), {
      policies: BOTH_CROSS_BOOKING_SCOPES,
    });
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      OFFICER,
    );
    expect(
      siblingSources(queued),
      "INV-HOST-046: the Group Trip fan-out must not depend on SAME_BOOKING_OWNER being off",
    ).toEqual(["joiner-a", "joiner-b"]);
    const order = coverageLockOrder(locks);
    expect(
      order.findIndex((entry) =>
        entry.startsWith(HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS),
      ),
    ).toBeLessThan(
      order.findIndex((entry) =>
        entry.startsWith(HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS),
      ),
    );
  });

  it("records the bound ceiling DURABLY, not only as a log line", async () => {
    // WHAT A BOUND CEILING COSTS is stated by the constant itself: a booking is
    // missed entirely — no item, so no re-evaluation, no incident, no owner notice
    // and nothing in the officer queue — for a booking that really was stranded.
    // Handling a loss of that shape with `logger.warn` means nobody finds out unless
    // somebody happens to be reading logs at that moment, and the test that used to
    // stand here asserted exactly 100 items for 105 siblings and enshrined the loss
    // of five without a trace. One audit row, keyed on the trip, in the same
    // transaction as the change that caused it.
    const rows: FakeBooking[] = [
      organiserOf(TRIP, {
        guests: [
          adultGuest("organiser-adult", ["2026-08-03", "2026-08-04"], "adult-source"),
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
    const { db, audits } = makeStore(rows);
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      OFFICER,
    );
    const truncations = audits.filter(
      (row) =>
        row.action === "booking.hostingCoverage.groupTripFanoutTruncated",
    );
    expect(
      truncations,
      "INV-HOST-046: a truncated Group Trip fan-out silently loses a stranded booking, so it must " +
        "leave a durable record an officer can find — a log line is not one",
    ).toHaveLength(1);
    expect(truncations[0]?.entityType).toBe("GroupBooking");
    expect(truncations[0]?.entityId).toBe(TRIP);
    // ONE row, not one per read. The dependent read runs at least twice on the way to
    // one fan-out (the unlocked plan, then the under-lock re-verify).
    expect(truncations[0]?.severity).toBe("important");
  });

  it("writes no truncation record when the ceiling does not bind", async () => {
    const { db, audits } = makeStore(tripRows());
    await reconcileAdultMemberHostingReviewWithSiblings(
      `organiser-${TRIP}`,
      db,
      OFFICER,
    );
    expect(
      audits.filter(
        (row) =>
          row.action === "booking.hostingCoverage.groupTripFanoutTruncated",
      ),
    ).toEqual([]);
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

describe("a membership standing change fans out to the trip (#3039, the third seam)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The club's day as the caller resolves it (`INV-LOCK-004`): the fan-out bounds its
   * candidate set on `checkOut >= today`, and the frozen test clock puts "today" at
   * 1 July 2026, so the trip's August stay is future on both passes.
   */
  const TODAY = new Date("2026-07-01T00:00:00.000Z");

  it("enqueues an item for every OTHER account in the trip, not just the ones this person attends", async () => {
    // THE HOLE THIS CLOSES, and it was permanent rather than delayed. Host
    // qualification depends on membership standing — `participantQualifiesAsHost`
    // returns false for an inactive, cancelled or archived member and for an unsettled
    // subscription — so when the adult who was the trip's only qualifying host lapses,
    // is deactivated, is archived, or is marked unpaid by the Xero sync, the cover
    // disappears from bookings on OTHER accounts. This seam is the door every one of
    // those writers arrives through, and before this it enqueued for the bookings the
    // person ATTENDS and nothing else. The drain then expanded each item to that
    // owner's own bookings (or, without SAME_BOOKING_OWNER, to the booking plus its
    // split halves), so the stranded sibling was never reached — and there is no
    // periodic full re-evaluation in this system, only the queue drain, so "never"
    // meant never.
    //
    // The adult travels on the ORGANISER's booking; the two joiners are other
    // accounts carrying non-member guests. A standing change to that adult must reach
    // both joiners.
    const { db, queued, locks } = makeStore(tripRows());
    const count = await enqueueHostingCoverageReevaluationForMember(
      "adult-source",
      db,
      TODAY,
      { cause: "SYSTEM_CHANGE", actorMemberId: "officer-1", reason: null },
    );
    expect(
      siblingSources(queued),
      "INV-HOST-046 (docs/invariants/adult-member-hosting.md): a membership standing change removes " +
        "cover from the trip, so the membership seam owes the same Group Trip fan-out as the two " +
        "booking seams — without it the stranded sibling is never re-evaluated at all",
    ).toEqual(["joiner-a", "joiner-b"]);
    // The attended booking's own item is still recorded, so the count is all three.
    expect(count).toBe(3);
    // Each sibling item names ITSELF as its source and carries its OWN nights, which
    // is the shape the participant fence demands and the shape the drain can resolve.
    for (const item of queued.filter((entry) =>
      siblingSources(queued).includes(entry.sourceBookingId as string),
    )) {
      expect(item.memberId).toBe(`joiner-member-${item.sourceBookingId}`);
      expect(item.cause).toBe("SYSTEM_CHANGE");
      expect(item.nights).toEqual(["2026-08-03", "2026-08-04"]);
    }
    // INV-LOCK-002: the per-trip key before the per-owner keys, here too.
    const order = coverageLockOrder(locks);
    const firstGroup = order.findIndex((entry) =>
      entry.startsWith(HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS),
    );
    expect(
      firstGroup,
      "INV-LOCK-002: the membership seam must take the per-trip key",
    ).toBeGreaterThan(-1);
  });

  it("takes no trip key and writes no sibling item when the scope is off", async () => {
    const { db, queued, locks } = makeStore(tripRows(), {
      policies: GROUP_TRIP_OFF,
    });
    await enqueueHostingCoverageReevaluationForMember("adult-source", db, TODAY);
    expect(siblingSources(queued)).toEqual([]);
    expect(
      locks.filter(
        (lock) =>
          lock.namespace === HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS,
      ),
    ).toEqual([]);
  });

  it("plans one fan-out per TRIP, not one per attended booking", async () => {
    // The adult travels on the organiser's booking AND on a second booking in the same
    // trip. Planning from either reaches every other booking in it, so the trip is
    // de-duplicated by `GroupBooking.id` — otherwise each attended booking would
    // enumerate every other one and write a duplicate item per sibling.
    const rows = tripRows();
    rows.push(
      joinerOf(TRIP, "joiner-c", {
        guests: [
          adultGuest("also-the-adult", ["2026-08-03", "2026-08-04"], "adult-source"),
        ],
      }),
    );
    const { db, queued } = makeStore(rows);
    await enqueueHostingCoverageReevaluationForMember("adult-source", db, TODAY);
    const sources = queued.map((item) => item.sourceBookingId as string).sort();
    // Every booking in the trip appears EXACTLY once: the two attended bookings
    // through their own items, the two joiners through the single trip fan-out.
    expect(sources).toEqual([
      "joiner-a",
      "joiner-b",
      "joiner-c",
      `organiser-${TRIP}`,
    ]);
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
    // AND NO SUCH CLASS WAS ADDED ANYWHERE, which is what this test's title claims
    // and what it used to leave unchecked: it read one function body and one module,
    // so a refusal added in `adult-member-hosting-refusal.ts`, in the review engine,
    // or in a route would have passed it. The scan below is the whole tracked `src/`
    // tree.
    const sameOwner = readRepoCode("src/lib/adult-member-hosting-same-owner.ts");
    expect(sameOwner.match(/extends ApiError/g) ?? []).toHaveLength(2);
    expect(sameOwner).not.toContain("GroupTripCoverage");

    // EVERY Group-Trip-flavoured error class in the tree, named, against a stated
    // allowlist — rather than a "none exist" assertion that a legitimate one would
    // have to be argued away from. A NEW class therefore fails this test and its
    // author has to come here and say why it is not a refusal of a member's change.
    const classes: string[] = [];
    for (const file of trackedSourceFiles()) {
      const code = readRepoCode(file);
      for (const match of code.matchAll(/class\s+(\w*GroupTrip\w*Error)\b/g)) {
        classes.push(`${file}::${match[1]}`);
      }
      // A refusal CODE or a member-facing group sentence is the same disclosure by
      // another route, and neither has any legitimate instance.
      for (const pattern of [
        /GROUP_TRIP_COVERAGE_(?:WOULD_BREAK|OVERRIDE|REFUS)/,
        /throw new \w*GroupTripCoverage\w*/,
      ]) {
        if (pattern.test(code)) classes.push(`${file}::${String(pattern)}`);
      }
    }
    expect(
      classes.sort(),
      "INV-HOST-046 (docs/invariants/adult-member-hosting.md): the cross-account path may refuse " +
        "NOTHING, so a new Group-Trip-specific error class, refusal code or member-facing sentence " +
        "anywhere in the tree is a disclosure — even a refusal tells the actor that somebody else " +
        "depends on them. The ONE allowed class is #3038's evidence-read ceiling refusal, which is " +
        "raised only for a diagnostic caller that asked for host EVIDENCE and cannot be answered " +
        "conclusively; it reaches no member-facing path, no route and no booking write, and it " +
        "refuses to ANSWER rather than refusing a change.",
    ).toEqual([
      "src/lib/adult-member-hosting-coverage-ceilings.ts::HostingGroupTripSourceCeilingExceededError",
    ]);
    // AND THAT ONE REALLY IS EVIDENCE-ONLY. It is constructed in exactly one place,
    // as the `ceilingError` callback of the group source loader, and that callback is
    // reached only when a caller supplied `groupTripSourceCeiling` — which every
    // WRITER omits. So no booking write can raise it.
    expect(
      engine.match(/new HostingGroupTripSourceCeilingExceededError\(/g) ?? [],
    ).toHaveLength(1);
    expect(engine).toContain("ceiling: groupTripSourceCeiling,");
    // AND THE WRITER ENTRY POINT NEVER SUPPLIES ONE. `evaluateBookingAdultMemberHosting`
    // is the function every booking write reaches the evaluator through; the ceiling is
    // threaded only from the read-only evidence form. A `groupTripSourceCeiling`
    // appearing in the writer's own body would make the evidence refusal reachable from
    // a member's change, which is a refusal `INV-HOST-046` does not allow.
    const writerStart = engine.indexOf(
      "export async function evaluateBookingAdultMemberHosting(",
    );
    expect(writerStart).toBeGreaterThan(-1);
    const writerBody = engine.slice(
      writerStart,
      engine.indexOf("\n}", writerStart),
    );
    expect(
      writerBody,
      "INV-HOST-046: a booking-write seam that passed a group source ceiling would make the " +
        "evidence refusal reachable from a member's change",
    ).not.toContain("groupTripSourceCeiling");
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

describe("the inline drain reaches the siblings' items (#3039)", () => {
  /** The written booking as `settleHostingCoverageAfterCommit` loads it. */
  async function writtenBooking(db: any, id: string) {
    return db.booking.findUnique({
      where: { id },
      select: GROUP_TRIP_COVERAGE_SOURCE_SELECT,
    });
  }

  it("resolves the trip's dependent BOOKINGS for the post-commit claim", async () => {
    const { db } = makeStore(tripRows());
    await expect(
      loadGroupTripCoverageDependentBookingIds(
        await writtenBooking(db, `organiser-${TRIP}`),
        db,
      ),
    ).resolves.toEqual(["joiner-a", "joiner-b"]);
  });

  it("resolves nothing when the scope is off, so an unaffected club pays nothing", async () => {
    const { db, locks } = makeStore(tripRows(), { policies: GROUP_TRIP_OFF });
    await expect(
      loadGroupTripCoverageDependentBookingIds(
        await writtenBooking(db, `organiser-${TRIP}`),
        db,
      ),
    ).resolves.toEqual([]);
    // And it takes no lock: this runs on the response path after the commit, where a
    // wrong answer costs a delay and never a lost obligation.
    expect(locks).toEqual([]);
  });

  it("narrows the cross-account claim to this trip's bookings, not to their owners", () => {
    // TWO DEFECTS, ONE PREDICATE.
    //
    // The first: `settleHostingCoverageAfterCommit` resolved the written booking to
    // ONE owner and filtered the claim to it, so every sibling item the fan-out had
    // just written was skipped and waited up to three hours for the cron.
    //
    // The second was introduced by the obvious fix. Widening to the sibling OWNERS
    // put no lower bound on the claim, and the claim is oldest-first — so a sibling
    // owner sitting on a dozen unrelated stale items filled every inline slot with
    // THEIR backlog, each fanning out again and each able to send a synchronous
    // email, inside the actor's request, while the actor's own fresh items went
    // undrained. Keying on `sourceBookingId` bounds it to items about bookings in
    // this trip.
    const drain = readRepoCode("src/lib/adult-member-hosting-coverage-drain.ts");
    const start = drain.indexOf(
      "export async function settleHostingCoverageAfterCommit(",
    );
    expect(start).toBeGreaterThan(-1);
    const body = drain.slice(start, drain.indexOf("\n}", start));
    expect(body).toContain("loadGroupTripCoverageDependentBookingIds(");
    // The OPTION, not merely the local name. `body.toContain("sourceBookingIds")`
    // passed with the option deleted from the claim, because the `const` declaration
    // is still in the body — measured, on a mutation probe. The behavioural test in
    // `adult-member-hosting-coverage-drain-claims.test.ts` caught it; this now does
    // too, so a structural reader is not misled about what is pinned.
    expect(
      body,
      "INV-HOST-046: the inline drain must PASS the trip's dependent bookings to the claim, not only compute them",
    ).toMatch(/sourceBookingIds \? \{ sourceBookingIds \}/);
    expect(
      body,
      "INV-HOST-046: an OWNER-keyed cross-account claim lets a sibling's unrelated backlog starve " +
        "the items this transaction just wrote — the claim must be keyed on the booking",
    ).not.toContain("memberIds");
    const queue = readRepoCode("src/lib/adult-member-hosting-coverage-queue.ts");
    expect(queue).toContain(
      "in: [...new Set(options.sourceBookingIds)]",
    );
    // AND UNDER `AND`, never beside the lease disjunction. Two `OR` keys at one level
    // keep only the last, which would drop the claim-lease filter and let a live
    // worker's in-flight item be re-claimed.
    const claimStart = queue.indexOf(
      "export async function claimHostingCoverageReevaluations(",
    );
    const claimBody = queue.slice(claimStart, queue.indexOf("\n}", claimStart));
    expect(
      claimBody.indexOf("AND: ["),
      "INV-SSOT-002: the scope disjunction must be composed under AND, or it silently replaces the lease OR",
    ).toBeGreaterThan(-1);
  });
});
