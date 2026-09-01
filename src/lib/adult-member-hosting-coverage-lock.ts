import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { decodeRawRows } from "@/lib/raw-sql-rows";

/**
 * The per-OWNER advisory lock that makes same-owner coverage deterministic
 * (#2576 §9).
 *
 * WHY A NEW LOCK FAMILY, when the review module's first draft argued none was
 * needed. That argument was that "every path that can confirm a booking and every
 * path that can remove exact-night attendance already takes the per-lodge capacity
 * lock", so two interacting writers always contend for the same key. When #2576
 * introduced this key, it was false in both directions, and measurably so:
 *
 *  - `booking-cancel.ts`'s four claim transactions took `pg_advisory_xact_lock(1)`
 *    and not `acquireLodgeCapacityLock`;
 *  - `booking-create.ts` and the guest-add route took `acquireLodgeCapacityLock`
 *    and not `pg_advisory_xact_lock(1)`.
 *
 * Those keys were different at READ COMMITTED over disjoint rows, so the named
 * create-versus-cancel race was open. #2593 later made the allocation-participating
 * confirmed-create and cancellation paths compose global → lodge. That later
 * overlap does not retire the owner key: coverage is a cross-booking, per-owner
 * invariant, and participant/member/queue producers do not all share those tiers.
 * The coverage-owner key remains the authoritative common serialisation point and
 * stays last.
 *
 * THE INVARIANT IS PER-OWNER, SO THE KEY IS THE OWNER. Same-owner coverage is a
 * property of one `Booking.memberId` at one lodge (§1, §4), and the repository
 * already has this precedent for the same reason: `lockBookingMemberNights`
 * (`booking-member-night-conflicts.ts`) exists because per-lodge locks cannot
 * serialise a per-member invariant. This is the same shape with its own namespace,
 * so it never contends with the per-lodge, global, member-night or credit-ledger
 * locks.
 *
 * ACQUISITION ORDER — LAST, AND SINCE #3039 THE SECOND OF THE LAST TWO. Callers
 * take this AFTER any `pg_advisory_xact_lock(1)`, after `acquireLodgeCapacityLock`,
 * after any roster-date locks, after the applicable member-night and member-credit
 * locks, and — this is the part #3039 changed — after the per-TRIP
 * `hosting-coverage-group` key below. That gives the full tree one consistent order
 * (global → lodge → roster-date → member-night → member-credit → coverage-GROUP →
 * coverage-owner) that cannot deadlock; paths that do not use a tier simply omit it.
 * Where several owners are involved the keys are taken in sorted order, the same
 * discipline the member-night lock uses.
 *
 * "ALWAYS LAST" IS WHAT THIS DOCBLOCK SAID BEFORE #3039, and the sentence is
 * rewritten rather than left standing: an ordering claim that no longer describes
 * the tree is worse than none, because the next lane composing a new key reads it
 * and puts the key on the wrong side. The group key is strictly ABOVE this one —
 * see its own docblock for why the group set has to be frozen before the owner set
 * is even known.
 *
 * RE-ENTRANT, SO CHEAP TO BE THOROUGH. Postgres advisory locks are per-session
 * and re-entrant, so acquiring the same owner key twice inside one transaction is
 * a no-op. That is what lets the evaluator take it before it reads same-owner
 * sources AND the settle step take it before it reads dependents, without either
 * having to know whether the other already did.
 *
 * TAKEN ONLY WHERE THE SCOPE IS ON. Every caller resolves the lodge policy first
 * and skips the lock unless `SAME_BOOKING_OWNER` is enabled, so a club that is not
 * on this scope pays nothing and no unrelated write is serialised per member.
 */

const HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE = "hosting-coverage-owner";

/**
 * The per-GROUP advisory lock that makes CROSS-ACCOUNT Group Trip coverage
 * deterministic (#3039, epic #2943; `INV-LOCK-002` governs its place in the order
 * and `INV-LOCK-003` its registration).
 *
 * WHY THE OWNER KEY CANNOT DO THIS JOB, which is the whole reason a second family
 * exists. The owner key is `Booking.memberId` — the DEPENDENT's own account. Under
 * `SAME_GROUP_TRIP` the booking that supplies the cover belongs to SOMEBODY ELSE,
 * so two transactions changing two different bookings in one trip hold two
 * DIFFERENT owner keys and are not serialised by them at all. READ COMMITTED then
 * lets each observe a state the other has already invalidated: one removes the last
 * qualifying adult while the other reads that adult as cover, and the outcome
 * depends on commit order — the exact non-determinism #2576 §9 forbids. #3038's
 * evaluator says the same thing at the point where it declines to take a key it
 * knows is the wrong one.
 *
 * THE INVARIANT IS PER-TRIP, SO THE KEY IS THE TRIP — `GroupBooking.id`, the
 * canonical identity `group-trip-identity.ts` resolves, and the only thing every
 * booking in the party shares. Not the lodge (one lodge holds many unrelated trips,
 * and a lodge-wide key would serialise all of them against each other), not the
 * organiser's member id (a person, who may hold other bookings in no trip at all),
 * and emphatically not `joinCode` (a credential, never an identity). Its own
 * namespace, so it never contends with the owner, per-lodge, global, roster-date,
 * member-night or credit-ledger keys.
 *
 * ACQUISITION ORDER — IMMEDIATELY BEFORE THE OWNER KEYS. The owner key used to be
 * documented as "always last"; it is now "group then owner are last", and the three
 * places that stated the old form say so. The full tree order is global → lodge →
 * roster-date → member-night → member-credit → queue-participant `Member` rows →
 * **coverage-GROUP** → coverage-owner, with every path omitting the tiers it does
 * not use. Group BEFORE owner rather than after, because the group set is what
 * decides WHICH owners are involved: the fan-out reads the trip's sibling bookings
 * under this key and only then knows whose owner keys it needs, so taking the owner
 * keys first would be taking them against a sibling set that could still move.
 *
 * SEVERAL TRIPS ARE TAKEN IN SORTED ORDER, the same discipline the owner and
 * member-night keys use — and it is not theoretical here: one transaction can
 * reconcile a booking in one trip and then inspect a same-owner dependent that sits
 * in a DIFFERENT trip.
 *
 * AND EVERY ACQUISITION IS TRIED FAIL-FAST FIRST. Sorting inside one call cannot
 * order keys discovered in two separate calls, which is exactly the hold-and-wait
 * edge #2597 closed for the owner key: a transaction already holding trip A's key
 * must not WAIT for trip B's while another holds B and wants A. So every caller
 * tries the key with `pg_try_advisory_xact_lock` and rolls its WHOLE outer
 * transaction back on a conflict rather than waiting inside a booking transaction.
 * The blocking form that follows is then re-entrant on the same PostgreSQL session
 * and costs nothing.
 *
 * RE-ENTRANT, SO CHEAP TO BE THOROUGH — the same property the owner key relies on.
 * The evaluator takes it before it reads a sibling as cover and the reconciliation
 * fan-out takes it before it reads the dependents, without either having to know
 * whether the other already did.
 *
 * TAKEN ONLY WHERE THE SCOPE IS ON AND THERE IS A TRIP. Every caller resolves the
 * lodge policy first and skips the key unless `SAME_GROUP_TRIP` is enabled, and a
 * booking in no Group Trip has no key to take — so an ordinary booking at a club
 * that HAS enabled the scope still pays nothing.
 */
const HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE = "hosting-coverage-group";

/**
 * The subset of a client this module needs. `prisma` and any
 * `Prisma.TransactionClient` both satisfy it; the narrow delegate-only picks the
 * hosting modules pass around do not, which is what the runtime guard below is
 * for.
 *
 * Named for the module rather than for the owner key: since #3039 both families use
 * them, and a `CoverageOwnerLockClient` guarding a GROUP-key acquisition reads as
 * though the wrong key were being taken.
 */
type CoverageLockClient = {
  $executeRaw: Prisma.TransactionClient["$executeRaw"];
};

type CoverageTryLockClient = {
  $queryRaw: Prisma.TransactionClient["$queryRaw"];
};

const COVERAGE_TRY_LOCK_ROW = z.object({ locked: z.boolean() });

function hasExecuteRaw(db: unknown): db is CoverageLockClient {
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as { $executeRaw?: unknown }).$executeRaw === "function"
  );
}

function hasQueryRaw(db: unknown): db is CoverageTryLockClient {
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as { $queryRaw?: unknown }).$queryRaw === "function"
  );
}

/**
 * The sorted, de-duplicated, blank-free key list every acquisition in this module
 * takes.
 *
 * ONE HELPER RATHER THAN FOUR COPIES (`INV-SSOT-001`). Sorting is the property that
 * makes composing several keys of one family deadlock-free, so it has to be
 * identical in the blocking and the fail-fast spelling of BOTH families — and the
 * owner key already carried two hand-written copies of it before the group family
 * would have added a third and a fourth. De-duplication and the `Boolean` filter
 * travel with it: an absent id is not a key, and taking one key twice is a
 * re-entrant no-op that costs only a round trip.
 */
function sortedUniqueKeys(
  ids: readonly (string | null | undefined)[],
): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))].sort();
}

/**
 * TAKE a sorted set of keys in one namespace, blocking.
 *
 * ONE STATEMENT FOR BOTH FAMILIES (`INV-SSOT-001`). The owner key and the trip key
 * differ in exactly two facts: the namespace constant, and (for the fail-fast form
 * below) the label a decode failure is reported under. Everything that makes an
 * acquisition correct is identical — `pg_advisory_xact_lock` rather than the
 * session-scoped form, the two-argument `hashtext` spelling that keeps each family in
 * its own keyspace, and the sorted de-duplicated key list. Written out per family,
 * that was two copies of the blocking form and two of the fail-fast one, each relying
 * on somebody noticing when another moved — and a family whose statement drifted to
 * `pg_advisory_lock(` would leak a session lock on a pooled connection with every
 * other test in the tree still green. It is also what keeps this file at TWO entries
 * in the advisory-lock inventory rather than four, and ONE in the raw-read inventory
 * rather than two.
 *
 * SILENT NO-OP WITHOUT `$executeRaw`, deliberately, and this is the one judgement in
 * the module. The hosting modules accept a narrow delegate-only client so they can be
 * driven by an in-memory store in tests, and `lockBookingMemberNights` takes the same
 * approach for the same reason. Throwing here would make the policy untestable
 * without a live Postgres; skipping loses only the lock, and every caller still has
 * the status-guarded claims, the participant proof and the idempotent post-commit
 * reconciliation that were protecting it before. In production the client is always a
 * real `Prisma.TransactionClient`, so the lock is always taken.
 */
async function lockCoverageKeys(
  db: unknown,
  namespace: string,
  ids: readonly (string | null | undefined)[],
): Promise<void> {
  if (!hasExecuteRaw(db)) return;
  for (const id of sortedUniqueKeys(ids)) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${namespace}), hashtext(${id}))`;
  }
}

/**
 * TRY a sorted set of keys in one namespace, fail-fast, stopping at the first loss.
 *
 * The counterpart of the blocking primitive above, one statement for the same reason.
 * A lost key stops the sequence rather than continuing, so a caller never holds a
 * partial set it would then have to release in order; `false` means the caller rolls
 * its WHOLE outer transaction back. Any later blocking acquisition of a key this call
 * won is re-entrant on the same PostgreSQL session and costs a round trip and no wait.
 *
 * `decodeLabel` is the second and last per-family fact. A malformed row has to be
 * reported against the family whose key it was, because an operator handed a message
 * naming both cannot tell whether to look at one member's bookings or one trip's.
 */
async function tryLockCoverageKeys(
  db: unknown,
  namespace: string,
  ids: readonly (string | null | undefined)[],
  decodeLabel: string,
): Promise<boolean> {
  if (!hasQueryRaw(db)) return true;
  for (const id of sortedUniqueKeys(ids)) {
    const returned = await db.$queryRaw`
      SELECT pg_try_advisory_xact_lock(
        hashtext(${namespace}),
        hashtext(${id})
      ) AS "locked"
    `;
    const rows = decodeRawRows(returned, COVERAGE_TRY_LOCK_ROW, decodeLabel);
    if (rows[0]?.locked !== true) return false;
  }
  return true;
}

/** Serialise every reader and writer of one owner's same-owner coverage. */
export async function lockHostingCoverageOwners(
  db: unknown,
  memberIds: readonly (string | null | undefined)[],
): Promise<void> {
  await lockCoverageKeys(db, HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE, memberIds);
}

/** The single-owner case, which is every caller but the merge path. */
export async function lockHostingCoverageOwner(
  db: unknown,
  memberId: string | null | undefined,
): Promise<void> {
  await lockHostingCoverageOwners(db, [memberId]);
}

/**
 * Fail-fast counterpart used by #2597's per-seam participant protocol.
 *
 * A bulk transaction may call one producer several times. Member KEY SHARE locks are
 * mutually compatible, so their NOWAIT clause cannot by itself stop two transactions
 * that already hold different coverage-owner keys from waiting on one another's later
 * key. Trying each sorted owner key closes that remaining hold-and-wait edge: false
 * makes the caller roll its WHOLE outer transaction back.
 */
export async function tryLockHostingCoverageOwners(
  db: unknown,
  memberIds: readonly (string | null | undefined)[],
): Promise<boolean> {
  return tryLockCoverageKeys(
    db,
    HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE,
    memberIds,
    "hosting coverage owner try-lock",
  );
}

export async function tryLockHostingCoverageOwner(
  db: unknown,
  memberId: string | null | undefined,
): Promise<boolean> {
  return tryLockHostingCoverageOwners(db, [memberId]);
}

/**
 * Serialise every reader and writer of one Group Trip's cross-account coverage
 * (#3039).
 */
export async function lockHostingCoverageGroups(
  db: unknown,
  groupBookingIds: readonly (string | null | undefined)[],
): Promise<void> {
  await lockCoverageKeys(
    db,
    HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE,
    groupBookingIds,
  );
}

/** The single-trip case, which is every caller today. */
export async function lockHostingCoverageGroup(
  db: unknown,
  groupBookingId: string | null | undefined,
): Promise<void> {
  await lockHostingCoverageGroups(db, [groupBookingId]);
}

/**
 * Fail-fast counterpart — and for the group key this is the PRIMARY form rather than
 * a hardening extra.
 *
 * A trip's siblings belong to other accounts, so a blocking wait here is one member's
 * booking transaction stalled by another member's edit. Worse, two transactions that
 * discover their trip keys in different orders (a booking in one trip whose same-owner
 * dependent sits in another) can each hold one and wait for the other, and sorting
 * within a call cannot fix that because the calls are separate. `false` therefore
 * means the caller rolls its WHOLE outer transaction back and answers the stable
 * `HOSTING_COVERAGE_PARTICIPANT_RETRY` 409.
 *
 * AND BECAUSE THE TRY NEVER WAITS while an xact lock cannot be released before commit,
 * the blocking acquisition that follows a successful try is a re-entrant no-op — so no
 * transaction ever WAITS on a trip key, and the group tier cannot appear in a wait-for
 * cycle at all, whatever order it is taken in. `acquireHostingCoverageGroupKey` in
 * `adult-member-hosting-review.ts` is the single place that composes the two calls and
 * states that guarantee in full.
 */
export async function tryLockHostingCoverageGroups(
  db: unknown,
  groupBookingIds: readonly (string | null | undefined)[],
): Promise<boolean> {
  return tryLockCoverageKeys(
    db,
    HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE,
    groupBookingIds,
    "hosting coverage group try-lock",
  );
}

export async function tryLockHostingCoverageGroup(
  db: unknown,
  groupBookingId: string | null | undefined,
): Promise<boolean> {
  return tryLockHostingCoverageGroups(db, [groupBookingId]);
}

/** Exported for the concurrency test that pins the namespace and the SQL shape. */
export const HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE_FOR_TESTS =
  HOSTING_COVERAGE_OWNER_LOCK_NAMESPACE;

/** The same, for the per-trip key (#3039). */
export const HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE_FOR_TESTS =
  HOSTING_COVERAGE_GROUP_LOCK_NAMESPACE;
