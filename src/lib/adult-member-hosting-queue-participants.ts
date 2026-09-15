import { Prisma, type PrismaClient } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
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

/** Exact SQLSTATE inspection for direct pg and nested Prisma adapter errors. */
export function isPostgresLockNotAvailable(
  error: unknown,
  depth = 0,
): boolean {
  if (depth > 5 || !error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  if (candidate.code === "55P03" || candidate.originalCode === "55P03") {
    return true;
  }
  return ["meta", "driverAdapterError", "cause"].some((key) =>
    isPostgresLockNotAvailable(candidate[key], depth + 1),
  );
}

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
 * See `clearTransactionLockTimeout` for why the UNDO is not this function with a
 * zero.
 */
async function setTransactionLockTimeout(
  db: Pick<PrismaClient, "$executeRaw">,
  milliseconds: number,
): Promise<void> {
  await db.$executeRaw(
    Prisma.sql`SELECT set_config('lock_timeout', ${String(milliseconds)}, true)`,
  );
}

/**
 * Undo the bound above, restoring whatever `lock_timeout` this deployment
 * actually configures (#2623 F4).
 *
 * NOT `set_config('lock_timeout', '0', true)`, which is what this did first. `0`
 * is not "the previous value", it is "wait forever" — so on a deployment that
 * sets `lock_timeout` at the database or role level, restoring `0` REMOVED that
 * operator's bound for the rest of the merge transaction: the sorted
 * coverage-owner keys and the loser `member.delete` with its FK checks. That is
 * the exact opposite of the intent stated below, which is to hand the remaining
 * statements back their ordinary failure semantics.
 *
 * Measured on real PostgreSQL against a database carrying
 * `ALTER DATABASE … SET lock_timeout = '3s'`:
 *
 *   set_config('lock_timeout','0',true)   -> 0    (operator's bound destroyed)
 *   RESET lock_timeout                    -> 3s   (restored, but see below)
 *   SET LOCAL lock_timeout TO DEFAULT     -> 3s   (restored)
 *
 * `SET LOCAL` rather than `RESET` because `RESET` is SESSION-scoped: it survives
 * the commit on a pooled connection. Measured on the same database, a session
 * holding `SET lock_timeout = '7s'` came out of a transaction containing `RESET`
 * at `3s` — the caller's own session setting silently destroyed for every later
 * statement that connection serves. `SET LOCAL` left it at `7s`.
 *
 * No parameter is interpolated, so the reason `set_config` was needed above —
 * `SET` takes no placeholders — does not apply here.
 *
 * On this repository's current configuration nothing sets `lock_timeout` at any
 * level, so `DEFAULT` resolves to `0` and this is byte-for-byte the old
 * behaviour. It is hardening against a deployment that adds one, not a live bug.
 */
async function clearTransactionLockTimeout(
  db: Pick<PrismaClient, "$executeRaw">,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`SET LOCAL lock_timeout TO DEFAULT`);
}

/**
 * One blocking, sorted master/loser/ancillary-owner row-lock statement, with a
 * bounded wait (#2623 T6).
 *
 * BLOCKING ON PURPOSE, and that half is unchanged. `member-merge.ts` documents
 * the wait as deliberate: merge is an irreversible admin operation, and a
 * `NOWAIT` here would fail it far more often than the hazard justifies. Its two
 * fail-fast siblings in this module (`lockHostingCoverageMemberLifecycleTarget`,
 * `acquireHostingCoverageQueueParticipantProof`) are request-path writers, where
 * failing instantly and asking for a reload is the right answer.
 *
 * WHAT WAS WRONG WAS THE WAIT BEING UNBOUNDED WHILE HOLDING. This statement runs
 * inside the merge transaction, which is still holding the adult-member hosting
 * policy-set advisory key, so a wait here is a wait-while-holding. The alarming
 * reading of that — an unbounded fan-out of third parties — is not true: owners
 * come from a capped plan (`HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT`), so the set is
 * at most that plus master and loser, and merge's own 120s transaction deadline
 * eventually aborts and releases. What remains real is that `FOR UPDATE` on up to
 * that many THIRD-PARTY owners also blocks every FK write naming those members, so
 * an uninvolved booking-create or guest-add can wait behind the tail of a merge,
 * for as long as merge's deadline allows.
 *
 * So the wait is bounded to `MEMBER_MERGE_PARTICIPANT_LOCK_TIMEOUT_MS` and
 * released. PostgreSQL raises `lock_timeout` cancellation as SQLSTATE `55P03`,
 * the same code `NOWAIT` raises, so it lands on the existing
 * `HostingCoverageParticipantRetryError` that merge already converts into its
 * clean "participants changed, nothing was saved, re-run the preview" 409.
 *
 * The timeout is restored to this deployment's own DEFAULT after a successful
 * acquisition rather than left in force: the rest of the merge transaction takes
 * further locks — sorted coverage-owner keys, the loser delete — whose failures
 * are NOT mapped onto that retry, and turning them into unmapped `55P03`s would
 * trade a bounded wait for an opaque error. Restoring the DEFAULT rather than a
 * hardcoded `0` is what keeps that true on a deployment whose operator sets
 * `lock_timeout` at the database or role level — see
 * `clearTransactionLockTimeout`. There is no restore on the failure path because a cancelled
 * statement leaves the transaction aborted, so a second statement there could only
 * replace the retry error with `25P02`.
 */
export async function lockMemberMergeHostingCoverageParticipants(
  db: Pick<PrismaClient, "$executeRaw" | "member">,
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
  await setTransactionLockTimeout(db, MEMBER_MERGE_PARTICIPANT_LOCK_TIMEOUT_MS);
  try {
    await db.$executeRaw(Prisma.sql`
      SELECT 1
      FROM "Member"
      WHERE "id" IN (${Prisma.join(ids)})
      ORDER BY "id"
      FOR UPDATE
    `);
  } catch (error) {
    if (isPostgresLockNotAvailable(error)) {
      throw new HostingCoverageParticipantRetryError();
    }
    throw error;
  }
  await clearTransactionLockTimeout(db);
  const locked = await db.member.findMany({
    where: { id: { in: ids } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (
    locked.length !== ids.length ||
    locked.some((member, index) => member.id !== ids[index])
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
