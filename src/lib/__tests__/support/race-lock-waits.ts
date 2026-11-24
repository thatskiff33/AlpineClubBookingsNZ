/**
 * Lock-wait helpers for the member-merge race suites (#4823, #4840).
 *
 * `realdb-all` runs every real-PostgreSQL file in one process against one
 * database, so "some backend is waiting on a lock" can be another suite's wait.
 * These helpers wait for a SPECIFIC wait instead: a backend blocked by a known
 * backend id, read through `pg_blocking_pids`.
 *
 * Test support only.
 */
import type { PrismaClient } from "@prisma/client";

type RawClient = { $queryRaw: PrismaClient["$queryRaw"] };

/** The backend id of a transaction (or client) the case holds. */
export async function backendPid(db: RawClient): Promise<number> {
  const [{ pid }] = await db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  return pid;
}

/** The backends in this database blocked by any of `pids`. */
async function blockedBy(prisma: RawClient, pids: readonly number[]): Promise<number[]> {
  if (pids.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
    SELECT pid FROM pg_catalog.pg_stat_activity
    WHERE datname = current_database() AND pg_blocking_pids(pid) && ${[...pids]}::int[]`;
  return rows.map((row) => row.pid);
}

/**
 * Until a chain of `depth` waits hangs off `rootPid`: depth 1 is a backend
 * blocked by the root, depth 2 a backend blocked by that one, and so on.
 * Resolves to the pids at the last level.
 */
export async function untilBlockedChain(prisma: PrismaClient, rootPid: number, depth = 1): Promise<number[]> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    let level: number[] = [rootPid];
    for (let step = 0; step < depth && level.length > 0; step += 1) level = await blockedBy(prisma, level);
    if (level.length > 0) return level;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no chain of ${depth} wait(s) behind backend ${rootPid} ever formed`);
}

/**
 * Until at least `n` backends wait behind any of `pids` - the holder, or a
 * waiter already queued behind it, so writers can be queued in a fixed order.
 * Resolves to the waiting pids.
 */
export async function untilBlockedBy(prisma: RawClient, pids: readonly number[], n = 1): Promise<number[]> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const waiting = await blockedBy(prisma, pids);
    if (waiting.length >= n) return waiting;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`never saw ${n} backend(s) queued behind ${pids.join(", ")}`);
}

/** Whether any backend is blocked by `pid` right now. */
export async function isBlocking(prisma: PrismaClient, pid: number): Promise<boolean> {
  return (await blockedBy(prisma, [pid])).length > 0;
}

/**
 * The race suites pause a writer inside its transaction, or queue it behind a
 * merge, for as long as the other side takes to arrive. The writers under test
 * open their transactions with no options, so Prisma's 5-second default would
 * decide the race on a slow runner instead of the locks. This raises the budget
 * for calls that pass none; a call that passes its own (merge does) keeps it.
 */
export const RACE_TRANSACTION_BUDGET = { maxWait: 30_000, timeout: 120_000 } as const;

/** A `$transaction` call's options with the race budget filled in where an interactive call passes none. */
function budgeted(arg: unknown, options: unknown): unknown {
  return typeof arg === "function" && options === undefined ? RACE_TRANSACTION_BUDGET : options;
}

export function withRaceTransactionBudget<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "$transaction" && typeof value === "function") {
        return (arg: unknown, options?: unknown) => (value as (a: unknown, o?: unknown) => unknown).call(target, arg, budgeted(arg, options));
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * The same budget for one case, on the shared client itself, until the returned
 * restore runs. For a suite that `concurrency-lock-races.realdb.test.ts`
 * imports into its process: a `vi.mock("@/lib/prisma")` there would reach every
 * suite in that process, including the P2028 race that relies on the 5-second
 * default (`payment-lock-before-rebuild.realdb.test.ts`).
 */
export function raiseRaceTransactionBudget(client: object): () => void {
  const store = client as { $transaction: (arg: unknown, options?: unknown) => unknown };
  const original = store.$transaction;
  store.$transaction = (arg: unknown, options?: unknown) => original.call(client, arg, budgeted(arg, options));
  return () => {
    store.$transaction = original;
  };
}
