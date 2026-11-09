import { Prisma, type PrismaClient } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
import { isPostgresLockNotAvailable } from "@/lib/prisma-errors";
import { ApiError } from "@/lib/api-error";
import type { HostingCoverageReevaluationInput } from "@/lib/adult-member-hosting-coverage-queue";

type ParticipantDb = Pick<PrismaClient, "booking" | "member" | "$executeRaw">;
type LifecycleTargetDb = Pick<PrismaClient, "$executeRaw">;
type LinkedGuestMemberDb = Pick<PrismaClient, "member" | "$executeRaw">;

export const HOSTING_COVERAGE_RETRY_CODE =
  "HOSTING_COVERAGE_PARTICIPANT_RETRY";
export const HOSTING_COVERAGE_RETRY_MESSAGE =
  "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying.";
export const HOSTING_COVERAGE_RETRY_BODY = Object.freeze({
  error: HOSTING_COVERAGE_RETRY_MESSAGE,
  code: HOSTING_COVERAGE_RETRY_CODE,
});

export type HostingCoverageSourceParticipant = Readonly<{
  bookingId: string;
  ownerMemberId: string;
  lodgeId: string;
}>;

/**
 * WHAT A HOSTING-COVERAGE PARTICIPANT IS — the one home of the decision (#3369,
 * settled in one place by #3480).
 *
 * A participant is a MEMBER holding nights that a qualifying adult must cover.
 * The re-evaluation queue is keyed on that member, the fence below takes its
 * `FOR KEY SHARE NOWAIT` on that member's row, and the coverage-owner advisory
 * key is minted from that member's id. An organisation holds no member-nights,
 * has no `Member` row to lock and no account the queue could name — so an
 * organisation-owned booking (a school's, since stage 4 of #2912 made the
 * member link optional) is NOT a participant, and this returns `null` for it.
 *
 * WHY THIS IS A FUNCTION AND NOT A COMMENT. Before #3480 the fence's own re-read
 * below took this decision inline (`if (!ownerMemberId) return []`), while the
 * producers in `adult-member-hosting-review.ts` never took it at all: they
 * emitted a participant with `ownerMemberId: null` through a type that said
 * `string`, and the fence's fingerprint of what it re-read (school dropped)
 * could never equal the fingerprint of what it was handed (school present). The
 * result was a `HostingCoverageParticipantRetryError` thrown deterministically —
 * the same rows, the same answer, on every retry — from inside the transaction
 * that records a member's manual subscription payment, deactivates them, or
 * syncs their standing from Xero, whenever that member was a guest on a school
 * booking at a lodge with the rule switched on. Two spellings of one decision
 * disagreed, and the fence read the disagreement as contention. So there is
 * one spelling, here, and every producer and the verifier both ask it
 * (`INV-SSOT-001`).
 *
 * The answer is taken through `bookingOwner()` rather than off the column,
 * because who owns a booking is that accessor's question (`INV-SSOT-005`).
 */
export function hostingCoverageParticipantOwnerId(booking: {
  readonly memberId: string | null;
}): string | null {
  return bookingOwner(booking).memberId;
}

const issuedProofs = new WeakSet<object>();

/** A runtime-issued capability; a structural cast is rejected by the WeakSet. */
export type HostingCoverageQueueParticipantProof = Readonly<{
  lockedMemberIds: readonly string[];
  sources: readonly HostingCoverageSourceParticipant[];
}>;

export class HostingCoverageParticipantRetryError extends ApiError {
  readonly statusCode = 409;
  readonly code = HOSTING_COVERAGE_RETRY_CODE;

  constructor() {
    super(HOSTING_COVERAGE_RETRY_MESSAGE, 409);
    this.name = "HostingCoverageParticipantRetryError";
  }
}

/**
 * The participant fence was asked to issue a proof through a client that cannot
 * take a row lock. This is a wiring fault, never a runtime race: every real
 * Prisma client and transaction client exposes `$executeRaw`. It is
 * deliberately NOT a `HostingCoverageParticipantRetryError` — retrying will not
 * grow the client a raw method, and dressing it as contention would hand
 * callers a 409 that invites an endless retry loop.
 */
export class HostingCoverageParticipantFenceUnavailableError extends Error {
  constructor() {
    super(
      "Hosting coverage participants cannot be locked through a client without $executeRaw; " +
        "a participant proof must never be issued without its FOR KEY SHARE NOWAIT lock.",
    );
    this.name = "HostingCoverageParticipantFenceUnavailableError";
  }
}

/**
 * Fence one host-qualification lifecycle target against a late
 * BookingGuest.member FK write.
 *
 * Callers must already hold their canonical advisory prefix. `FOR UPDATE
 * NOWAIT` is intentional: PostgreSQL's FK check takes KEY SHARE on the
 * referenced Member, so the weaker NO KEY UPDATE mode would allow the late
 * guest through. Fail-fast acquisition prevents repeated bulk fan-outs from
 * waiting while holding their earlier work. Checking the selected row count
 * also makes a missing target a safe retry instead of pretending that an empty
 * row lock protected anything.
 */
export async function lockHostingCoverageMemberLifecycleTarget(
  db: LifecycleTargetDb,
  memberId: string,
): Promise<void> {
  let locked: number;
  try {
    locked = await db.$executeRaw(Prisma.sql`
      SELECT 1
      FROM "Member"
      WHERE "id" = ${memberId}
      FOR UPDATE NOWAIT
    `);
  } catch (error) {
    if (isPostgresLockNotAvailable(error)) {
      throw new HostingCoverageParticipantRetryError();
    }
    throw error;
  }
  if (locked !== 1) {
    throw new HostingCoverageParticipantRetryError();
  }
}

/**
 * Protect the exact linked-member snapshot used by a booking-request hold.
 *
 * The hold owns its lodge advisory key before entering this helper. Sorted
 * `KEY SHARE` acquisition composes as lodge -> Member and deliberately
 * conflicts with the standing fan-out's `FOR UPDATE NOWAIT`: hold-first makes
 * the standing writer retry, while standing-first makes this read wait and
 * then observe the committed inactive/archive state. The typed read is the
 * authority; the raw statement exists only to hold the rows stable.
 */
export async function lockActiveBookingRequestLinkedMembers(
  db: LinkedGuestMemberDb,
  linkedMemberIds: readonly string[],
): Promise<void> {
  const memberIds = sortedUnique(linkedMemberIds);
  if (memberIds.length === 0) return;

  try {
    await db.$executeRaw(Prisma.sql`
      SELECT 1
      FROM "Member"
      WHERE "id" IN (${Prisma.join(memberIds)})
      ORDER BY "id"
      FOR KEY SHARE
    `);
  } catch (error) {
    if (isPostgresLockNotAvailable(error)) {
      throw new HostingCoverageParticipantRetryError();
    }
    throw error;
  }

  const members = await db.member.findMany({
    where: { id: { in: memberIds } },
    orderBy: { id: "asc" },
    select: { id: true, active: true, archivedAt: true },
  });
  if (
    members.length !== memberIds.length ||
    members.some(
      (member, index) =>
        member.id !== memberIds[index] ||
        member.active !== true ||
        member.archivedAt !== null,
    )
  ) {
    throw new HostingCoverageParticipantRetryError();
  }
}

/**
 * Match only the stable queue-participant retry code, including a wrapped
 * service error that retained its cause. Never infer this outcome from message
 * text: the fixed 409 is safe precisely because unrelated failures cannot be
 * accidentally downgraded into a retry prompt.
 */
export function isHostingCoverageParticipantRetry(
  error: unknown,
  depth = 0,
): boolean {
  if (depth > 5 || !error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  if (candidate.code === HOSTING_COVERAGE_RETRY_CODE) return true;
  return ["cause", "error"].some((key) =>
    isHostingCoverageParticipantRetry(candidate[key], depth + 1),
  );
}

function sortedUnique(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))].sort();
}

function sortedSources(
  sources: readonly HostingCoverageSourceParticipant[],
): HostingCoverageSourceParticipant[] {
  const unique = new Map<string, HostingCoverageSourceParticipant>();
  for (const source of sources) {
    unique.set(
      `${source.bookingId}:${source.ownerMemberId}:${source.lodgeId}`,
      source,
    );
  }
  return [...unique.values()].sort((a, b) =>
    a.bookingId.localeCompare(b.bookingId),
  );
}

function sourceFingerprint(
  sources: readonly HostingCoverageSourceParticipant[],
): string {
  return sortedSources(sources)
    .map(
      (source) =>
        `${source.bookingId}:${source.ownerMemberId}:${source.lodgeId}`,
    )
    .join("\n");
}

function issueProof(
  lockedMemberIds: readonly string[],
  sources: readonly HostingCoverageSourceParticipant[],
): HostingCoverageQueueParticipantProof {
  const proof = Object.freeze({
    lockedMemberIds: Object.freeze([...lockedMemberIds]),
    sources: Object.freeze(
      sortedSources(sources).map((source) => Object.freeze({ ...source })),
    ),
  });
  issuedProofs.add(proof);
  return proof;
}

// Lives in `prisma-errors.ts` since #4161 (the Xero link heal reads it too);
// re-exported here for this module's existing callers and tests.
export { isPostgresLockNotAvailable };

/**
 * Acquire one exact, sorted Member participant set without waiting. Source
 * booking owner and lodge are re-read only after those rows are protected.
 */
export async function acquireHostingCoverageQueueParticipantProof(
  params: {
    sources: readonly HostingCoverageSourceParticipant[];
    actorMemberId?: string | null;
  },
  db: ParticipantDb,
): Promise<HostingCoverageQueueParticipantProof> {
  const memberIds = sortedUnique([
    ...params.sources.map((source) => source.ownerMemberId),
    params.actorMemberId,
  ]);
  // The row lock IS this function's contract. An issued proof is a capability:
  // it enters `issuedProofs`, so it satisfies
  // assertHostingCoverageQueueParticipantsLocked at every downstream call site.
  // Issuing one without having taken the lock would therefore not "keep test
  // doubles narrow" — it would silently disable the fence wherever such a
  // client is passed, which is exactly the structural cast that check exists to
  // reject. So refuse instead: a caller that cannot lock gets no proof at all.
  // Test doubles must supply `$executeRaw`; see the queue-participants suite
  // for the minimal shape.
  if (typeof (db as { $executeRaw?: unknown }).$executeRaw !== "function") {
    throw new HostingCoverageParticipantFenceUnavailableError();
  }
  try {
    await db.$executeRaw(Prisma.sql`
      SELECT 1
      FROM "Member"
      WHERE "id" IN (${Prisma.join(memberIds)})
      ORDER BY "id"
      FOR KEY SHARE NOWAIT
    `);
  } catch (error) {
    if (
      error instanceof HostingCoverageParticipantRetryError ||
      isPostgresLockNotAvailable(error)
    ) {
      throw new HostingCoverageParticipantRetryError();
    }
    throw error;
  }

  const members = await db.member.findMany({
    where: { id: { in: memberIds } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (
    members.length !== memberIds.length ||
    members.some((member, index) => member.id !== memberIds[index])
  ) {
    throw new HostingCoverageParticipantRetryError();
  }

  const bookingIds = sortedUnique(
    params.sources.map((source) => source.bookingId),
  );
  const bookings = await db.booking.findMany({
    where: { id: { in: bookingIds } },
    orderBy: { id: "asc" },
    select: { id: true, memberId: true, lodgeId: true },
  });
  // #3369: an organisation-owned booking is not a participant and is not part
  // of the fingerprint the proof is taken over. THE SAME PREDICATE THE PRODUCERS
  // USE, so what the fence re-reads and what it was handed cannot disagree about
  // a school booking again (#3480) — see `hostingCoverageParticipantOwnerId`.
  const refreshed = bookings.flatMap((booking) => {
    const ownerMemberId = hostingCoverageParticipantOwnerId(booking);
    if (ownerMemberId === null) return [];
    return [{ bookingId: booking.id, ownerMemberId, lodgeId: booking.lodgeId }];
  });
  if (sourceFingerprint(refreshed) !== sourceFingerprint(params.sources)) {
    throw new HostingCoverageParticipantRetryError();
  }
  return issueProof(memberIds, refreshed);
}

/** Validate before both coverage-owner acquisition and the final queue write. */
export function assertHostingCoverageQueueParticipantsLocked(
  proof: HostingCoverageQueueParticipantProof,
  input: Pick<
    HostingCoverageReevaluationInput,
    "memberId" | "lodgeId" | "sourceBookingId" | "actorMemberId"
  >,
): void {
  if (!issuedProofs.has(proof as object)) {
    throw new HostingCoverageParticipantRetryError();
  }
  const source = proof.sources.find(
    (candidate) => candidate.bookingId === input.sourceBookingId,
  );
  const locked = new Set(proof.lockedMemberIds);
  if (
    !input.sourceBookingId ||
    !source ||
    source.ownerMemberId !== input.memberId ||
    source.lodgeId !== input.lodgeId ||
    !locked.has(input.memberId) ||
    (input.actorMemberId && !locked.has(input.actorMemberId))
  ) {
    throw new HostingCoverageParticipantRetryError();
  }
}

/**
 * How long member merge may wait for its participant rows (#2623 T6).
 *
 * An order of magnitude below merge's own `timeout: 120_000` transaction budget
 * (`member-merge.ts`), which is the number this replaces as the effective bound,
 * and far above the sub-second acquisition a healthy system sees — so a merge
 * that trips it really is contended rather than merely busy. It is deliberately
 * NOT lower: the point of keeping this lock blocking is that a short overlap
 * with an ordinary writer should still succeed, and 5s is the same order as the
 * block-detection poll the real-PostgreSQL race harness uses, so a bound there
 * would race the suite that proves the wait is still a wait.
 */
export const MEMBER_MERGE_PARTICIPANT_LOCK_TIMEOUT_MS = 10_000;

/**
 * Bound one statement's lock wait, for the current transaction only.
 *
 * `set_config(..., is_local => true)` rather than `SET LOCAL` because the value
 * is then an ordinary bound parameter instead of interpolated SQL — `SET` takes
 * no placeholders. It runs through `$executeRaw` for the same reason every other
 * raw statement in this module does: nothing reads the returned row, only that
 * the statement succeeded.
 *
 * Only ever called inside a savepoint that is then rolled back, which restores
 * the value in force before it exactly — a database- or role-level bound
 * included (#2623 F4). So there is no undo to get wrong: not `0`, which means
 * "wait forever", and not `RESET`, which is session-scoped and survives the
 * commit on a pooled connection (both measured on real PostgreSQL in #2623).
 */
async function setTransactionLockTimeout(
  db: Pick<PrismaClient, "$executeRaw">,
  milliseconds: number,
): Promise<void> {
  await db.$executeRaw(
    Prisma.sql`SELECT set_config('lock_timeout', ${String(milliseconds)}, true)`,
  );
}

type MemberMergeParticipantDb = Pick<PrismaClient, "$executeRaw" | "$queryRaw" | "member">;

/**
 * The two savepoints, as fixed statements: one around each acquisition attempt,
 * one around a single-row wait. Named apart so neither can release the other.
 * A savepoint in an interactive transaction is the `member-partner-link.ts`
 * precedent; PostgreSQL releases the row locks and the `SET LOCAL` taken after
 * a savepoint when it is rolled back to.
 */
const ATTEMPT_SAVEPOINT = {
  open: Prisma.sql`SAVEPOINT member_merge_participants_attempt`,
  rollBack: Prisma.sql`ROLLBACK TO SAVEPOINT member_merge_participants_attempt`,
  release: Prisma.sql`RELEASE SAVEPOINT member_merge_participants_attempt`,
} as const;
const WAIT_SAVEPOINT = {
  open: Prisma.sql`SAVEPOINT member_merge_participant_wait`,
  rollBack: Prisma.sql`ROLLBACK TO SAVEPOINT member_merge_participant_wait`,
  release: Prisma.sql`RELEASE SAVEPOINT member_merge_participant_wait`,
} as const;

/**
 * Wait for one busy participant row, holding none of the others (#4855), for at
 * most `milliseconds`. The row is taken `FOR UPDATE` — the strength merge needs,
 * so the wait outlasts every key share on it — and released straight away by
 * the savepoint's rollback, which also drops the `lock_timeout` set inside it.
 * Returns whether the row still exists; a cancelled wait (`55P03`) means the
 * bound ran out.
 */
async function waitForOneParticipantRow(
  db: MemberMergeParticipantDb,
  memberId: string,
  milliseconds: number,
): Promise<"free" | "missing" | "timedOut"> {
  await db.$executeRaw(WAIT_SAVEPOINT.open);
  let outcome: "free" | "missing" | "timedOut";
  try {
    await setTransactionLockTimeout(db, milliseconds);
    const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Member"
      WHERE "id" = ${memberId}
      FOR UPDATE
    `);
    outcome = rows.length === 1 ? "free" : "missing";
  } catch (error) {
    if (!isPostgresLockNotAvailable(error)) throw error;
    outcome = "timedOut";
  }
  await db.$executeRaw(WAIT_SAVEPOINT.rollBack);
  await db.$executeRaw(WAIT_SAVEPOINT.release);
  return outcome;
}

/**
 * Lock master, loser and every ancillary owner `FOR UPDATE`, all at once, and
 * never wait for one of those rows while holding another (#4855), within one
 * bounded budget (#2623 T6).
 *
 * WHY NOT ONE BLOCKING STATEMENT, which is what this was. `SELECT … ORDER BY
 * "id" FOR UPDATE` locks the rows in id order and holds the earlier ones while
 * it waits for a later one. Any FK write naming a member takes a key share on
 * that row, and one transaction can name several members in any order — a
 * single INSERT checks its foreign keys in schema order, not id order. So a
 * writer that held a later row and then named an earlier one closed a cycle
 * with merge, and PostgreSQL aborted one side (`40P01`): an officer who was the
 * duplicate, approving a change request that credits the survivor, or a held
 * booking request that links the survivor as a guest and then names the
 * officer as its maker. No writer-side ordering can rule that out, so merge
 * never holds part of the set while it waits.
 *
 * EACH ATTEMPT, inside a savepoint: one `FOR UPDATE SKIP LOCKED` over the
 * sorted set. If it returns every id, merge holds them all — on the fast path
 * this is the same single statement as before. Otherwise the savepoint is
 * rolled back, releasing what it did lock, and merge waits for the first
 * skipped row ALONE (`waitForOneParticipantRow`), releases that too and tries
 * again. A row that is gone is a changed participant set, not contention.
 *
 * STILL A WAIT, AND STILL BOUNDED (#2623 T6). Merge is irreversible admin work,
 * so a short overlap with an ordinary writer must still succeed: it waits, in
 * PostgreSQL's own lock queue, for up to `MEMBER_MERGE_PARTICIPANT_LOCK_TIMEOUT_MS`
 * in all, and every single-row wait is bounded by what is left of that budget.
 * The loop cannot spin: an attempt either takes every row, or waits on a row
 * until it frees or the budget is gone, and the budget is read from a monotonic
 * clock before each attempt. Running out lands on the existing
 * `HostingCoverageParticipantRetryError`, which merge converts into its clean
 * "participants changed, nothing was saved, re-run the preview" 409. While it
 * waits merge holds none of these rows, so it no longer blocks the FK writes of
 * up to `HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT` third-party owners as it waits.
 *
 * The lock bound only ever exists inside the single-row wait's savepoint, and
 * its rollback restores whatever was in force before — so merge's later locks
 * (coverage-owner keys, the loser delete) keep their ordinary failure semantics.
 */
export async function lockMemberMergeHostingCoverageParticipants(
  db: MemberMergeParticipantDb,
  params: {
    masterId: string;
    loserId: string;
    ownerMemberIds: readonly string[];
  },
): Promise<readonly string[]> {
  const ids = sortedUnique([
    params.masterId,
    params.loserId,
    ...params.ownerMemberIds,
  ]);
  const deadline = performance.now() + MEMBER_MERGE_PARTICIPANT_LOCK_TIMEOUT_MS;
  for (;;) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new HostingCoverageParticipantRetryError();
    await db.$executeRaw(ATTEMPT_SAVEPOINT.open);
    const lockedRows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Member"
      WHERE "id" IN (${Prisma.join(ids)})
      ORDER BY "id"
      FOR UPDATE SKIP LOCKED
    `);
    const locked = new Set(lockedRows.map((row) => row.id));
    const busy = ids.find((id) => !locked.has(id));
    if (busy === undefined) {
      await db.$executeRaw(ATTEMPT_SAVEPOINT.release);
      break;
    }
    await db.$executeRaw(ATTEMPT_SAVEPOINT.rollBack);
    await db.$executeRaw(ATTEMPT_SAVEPOINT.release);
    const waited = await waitForOneParticipantRow(db, busy, remaining);
    if (waited !== "free") throw new HostingCoverageParticipantRetryError();
  }
  const lockedMembers = await db.member.findMany({
    where: { id: { in: ids } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (
    lockedMembers.length !== ids.length ||
    lockedMembers.some((member, index) => member.id !== ids[index])
  ) {
    throw new HostingCoverageParticipantRetryError();
  }
  return Object.freeze(ids);
}

/** Issue the merge bypass only after an exact under-lock plan comparison. */
export function proveMemberMergeHostingCoverageParticipants(params: {
  lockedMemberIds: readonly string[];
  plannedSources: readonly HostingCoverageSourceParticipant[];
  refreshedSources: readonly HostingCoverageSourceParticipant[];
}): HostingCoverageQueueParticipantProof {
  if (
    sourceFingerprint(params.plannedSources) !==
    sourceFingerprint(params.refreshedSources)
  ) {
    throw new HostingCoverageParticipantRetryError();
  }
  const locked = new Set(params.lockedMemberIds);
  if (
    params.refreshedSources.some(
      (source) => !locked.has(source.ownerMemberId),
    )
  ) {
    throw new HostingCoverageParticipantRetryError();
  }
  return issueProof(params.lockedMemberIds, params.refreshedSources);
}
