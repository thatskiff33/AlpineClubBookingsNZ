/**
 * The choreography the member-merge and member-delete race suites share (#4861).
 *
 * Each suite races a merge (or an approved hard-delete) against one writer, in
 * both orders, on real PostgreSQL. It does that in one of three ways:
 *
 * - `arrivingWhilePaused`: pause one side inside its transaction at a named
 *   slot, start the other, and wait until the other queues behind it.
 * - `firstStandWhilePaused`: the same pause, but report whether the other side
 *   settled or came to wait on it, for a case where waiting is the defect.
 * - `writerArrivingWhileMergeIsParked`: park the merge behind a row lock a
 *   session of the case holds (a key share on the duplicate's Member row, any
 *   FK write does this), start the writer, and wait until it queues behind the
 *   merge.
 *
 * Every wait is matched to the backend it waits on (`pg_blocking_pids`, through
 * `race-lock-waits.ts`), never counted across the database, because
 * `realdb-all` runs other suites against it (#4844 review F4). One copy, so a
 * fix to how a wait is detected reaches every suite (INV-SSOT).
 *
 * A writer reaches a pause through `pauseIn(slot, tx)`, called from the suite's
 * `vi.mock` of the module the writer goes through. The registry lives on
 * `globalThis`, so a mock factory's dynamic import and the suite's static
 * import share one even if this module is loaded twice.
 *
 * Test support only.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { expect } from "vitest";

import type * as BookingRowLock from "@/lib/booking-row-lock";

import { backendPid, isBlocking, RACE_TRANSACTION_BUDGET, untilBlockedChain } from "./race-lock-waits";

type Settled = PromiseSettledResult<unknown>;
type PauseHook = (pid: number) => Promise<void>;
type RawTx = Parameters<typeof backendPid>[0];

export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

const registry = globalThis as typeof globalThis & { __memberMergeRacePauses?: Map<string, PauseHook> };
const pauses: Map<string, PauseHook> = (registry.__memberMergeRacePauses ??= new Map());

/** Where a writer stops if a case has armed `slot`, handed its transaction's backend id: a pass-through otherwise. */
export async function pauseIn(slot: string, tx: unknown): Promise<void> {
  const hook = pauses.get(slot);
  if (!hook) return;
  pauses.delete(slot);
  await hook(await backendPid(tx as RawTx));
}

/** Disarm every pause a case left armed. */
export function clearPauses(): void {
  pauses.clear();
}

/** Arm `slot`; `reached` resolves with the paused transaction's backend id once `holding` stops there. */
function armPause(slot: string, holding: () => Promise<unknown>, neverPaused?: string) {
  const release = gate();
  let reach!: (pid: number) => void;
  const reachedPid = new Promise<number>((resolve) => { reach = resolve; });
  pauses.set(slot, async (pid) => {
    reach(pid);
    await release.opened;
  });
  const held = holding();
  // A writer that settles without stopping at its slot never took the step the slot marks.
  const reached = Promise.race([
    reachedPid,
    held.then(() => { throw new Error(neverPaused ?? `the writer settled without reaching its pause at ${slot}`); }),
  ]);
  return {
    held,
    reached,
    release: () => {
      pauses.delete(slot);
      release.open();
    },
  };
}

/**
 * Pause `holder` at `slot`, start `arriving`, and wait until it queues behind
 * the paused holder; then let both go. Returns both outcomes.
 */
export async function arrivingWhilePaused(
  prisma: PrismaClient,
  slot: string,
  holder: () => Promise<unknown>,
  arriving: () => Promise<unknown>,
  neverPaused?: string,
): Promise<{ held: Settled; arrived: Settled }> {
  const pause = armPause(slot, holder, neverPaused);
  let arrival: Promise<unknown> = Promise.resolve();
  try {
    const holderPid = await pause.reached;
    arrival = arriving();
    await untilBlockedChain(prisma, holderPid, 1);
  } finally {
    pause.release();
  }
  const [held, arrived] = await Promise.allSettled([pause.held, arrival]);
  return { held, arrived };
}

/**
 * Pause `holder` at `slot`, start `arriving`, and see how it first stands:
 * settled (either way), or waiting on the paused holder. Then let both go.
 */
export async function firstStandWhilePaused(
  prisma: PrismaClient,
  slot: string,
  holder: () => Promise<unknown>,
  arriving: () => Promise<unknown>,
  options: { label: string; neverPaused?: string },
): Promise<{ first: "settled" | "waiting"; held: Settled; arrived: Settled }> {
  const pause = armPause(slot, holder, options.neverPaused);
  let arrival: Promise<unknown> = Promise.resolve();
  let first: "settled" | "waiting";
  try {
    const holderPid = await pause.reached;
    arrival = arriving();
    first = await settledOrBlockedBy(prisma, arrival, holderPid, options.label);
  } finally {
    pause.release();
  }
  const [held, arrived] = await Promise.allSettled([pause.held, arrival]);
  return { first, held, arrived };
}

/**
 * Whether `pending` settled (either way) or came to wait on `writerPid`. The
 * longest budget any copy had (1,200 polls); a shorter one only fails a slow
 * runner, it never proves more.
 */
export async function settledOrBlockedBy(
  prisma: PrismaClient,
  pending: Promise<unknown>,
  writerPid: number,
  label: string,
): Promise<"settled" | "waiting"> {
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (settled) return "settled";
    if (await isBlocking(prisma, writerPid)) return "waiting";
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} neither settled nor waited`);
}

/** The lock that parks a merge at its `Member … FOR UPDATE`: a key share on the duplicate's row, as any FK write naming it takes. */
export function keyShareOnMember(memberId: string) {
  return (tx: Prisma.TransactionClient) =>
    tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${memberId} FOR KEY SHARE`;
}

/**
 * Park `merge` behind `park`, a row lock a session of the case holds, start
 * `writer` once the merge waits on it, and wait until the writer queues behind
 * the merge; then let everything go. Returns both outcomes.
 */
export async function writerArrivingWhileMergeIsParked(
  prisma: PrismaClient,
  park: (tx: Prisma.TransactionClient) => Promise<unknown>,
  merge: () => Promise<unknown>,
  writer: () => Promise<unknown>,
): Promise<{ merged: Settled; written: Settled }> {
  const held = gate();
  const release = gate();
  let blockerPid = 0;
  const parking = prisma.$transaction(async (tx) => {
    await park(tx);
    blockerPid = await backendPid(tx);
    held.open();
    await release.opened;
  }, RACE_TRANSACTION_BUDGET);
  await held.opened;
  let merging: Promise<unknown> = Promise.resolve();
  let writing: Promise<unknown> = Promise.resolve();
  try {
    merging = merge();
    await untilBlockedChain(prisma, blockerPid, 1);
    writing = writer();
    // The writer queues behind the merge, which is still waiting on the parked lock.
    await untilBlockedChain(prisma, blockerPid, 2);
  } finally {
    release.open();
  }
  await parking;
  const [merged, written] = await Promise.allSettled([merging, writing]);
  return { merged, written };
}

/** A member row for a race fixture; `extra` overrides any field. */
export async function createRaceMember(prisma: PrismaClient, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.member.create({
    data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: id, ageTier: "ADULT", ...extra },
  });
}

/** The admin's preview, which must show no blockers; returns the merge it confirms, to run. */
export async function previewMerge(master: string, loser: string, actorMemberId: string): Promise<() => Promise<unknown>> {
  const merge = await import("@/lib/member-merge");
  const preview = await merge.buildMemberMergePreview({ masterId: master, loserId: loser, actorMemberId });
  expect(preview.blockers).toEqual([]);
  return () => merge.executeMemberMerge({ masterId: master, loserId: loser, actorMemberId, previewToken: preview.previewToken, confirmationText: preview.confirmationPhrase });
}

export function expectFulfilled(settled: Settled): void {
  expect(settled.status, settled.status === "rejected" ? String(settled.reason) : "").toBe("fulfilled");
}

/** Prisma's code for a write conflict or deadlock, and PostgreSQL's own, anywhere in the error. */
export function isDeadlock(error: unknown): boolean {
  const text = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}))}`;
  return /P2034|40P01|deadlock/i.test(text);
}

/** The writer names an officer the merge or delete removed: its FK refuses, never a deadlock, and nothing is recorded. */
export function expectRefusedByTheDeletedOfficer(written: Settled): void {
  expect(written.status).toBe("rejected");
  const reason = (written as PromiseRejectedResult).reason;
  expect(isDeadlock(reason), String(reason)).toBe(false);
  expect(reason).toMatchObject({ code: "P2003" });
}

/** The pause slot just before a writer takes `bookingId`'s booking-row lock. */
export function beforeBookingRow(bookingId: string): string {
  return `before-booking-row:${bookingId}`;
}

/**
 * The `vi.mock("@/lib/booking-row-lock")` body: `lockBookingRowForOwnerRead`
 * stops at `beforeBookingRow(bookingId)` when a case has armed it. The one lock
 * helper lives in `booking-row-lock.ts` (#4845) and the journal's doors
 * re-export it, so one mock covers both.
 */
export function bookingRowLockDouble(real: typeof BookingRowLock): typeof BookingRowLock {
  return {
    ...real,
    lockBookingRowForOwnerRead: async (...args: Parameters<typeof real.lockBookingRowForOwnerRead>) => {
      await pauseIn(beforeBookingRow(args[1]), args[0]);
      return real.lockBookingRowForOwnerRead(...args);
    },
  };
}
