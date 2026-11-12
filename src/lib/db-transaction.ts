import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * The Prisma interactive-transaction client — the module client minus the
 * lifecycle/composition methods a `$transaction` callback cannot call. Every
 * repository helper that runs "inside the caller's transaction OR opens its own"
 * threads a value of this type; sharing one definition keeps the tx-accepting
 * booking services, the capacity engine and the exception-execution seam in step.
 *
 * Defined over the `PrismaClient` CLASS (default generics) and — matching this
 * codebase's existing transaction-client aliases and the type Prisma infers for
 * an interactive `$transaction` callback here — it retains `$transaction`. The
 * many in-tree helpers this value is threaded to (`WorkPartyDbClient`,
 * `BedAllocationLifecycleDb`, the booking-modify `TransactionClient`, …) all
 * require `$transaction` in their param type, so a client that dropped it would
 * not be assignable to them. `withOptionalTransaction` never actually calls
 * `$transaction` on the value.
 */
export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$use" | "$extends"
>;

/**
 * The interactive-transaction budget of every writer that waits for the global
 * key `pg_advisory_xact_lock(1)` (`INV-LOCK-005`) - the one definition.
 *
 * Prisma counts the wait for that key against `maxWait` / `timeout`, and its
 * defaults (2 s / 5 s) lose to any legitimate holder that runs longer: bed-range
 * assignment and group settlement are the longest, and run on this budget
 * themselves, so a writer on it can outlast either of them. When it does run
 * out Prisma answers P2028 (P2034 for a lost write conflict), NOTHING IS
 * COMMITTED, and the caller answers "busy, try again" as a retryable 503
 * through `isTransactionContention` rather than as a refusal.
 *
 * The trade-off: a waiter holds its pooled connection for as long as it waits,
 * so a wider budget swaps opaque failures for pool pressure under a burst
 * (`docs/CONCURRENCY_AND_LOCKING.md` -> "Tier 2").
 */
export const LOCK1_HOLDER_TRANSACTION_BUDGET = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;

/** The options `prisma.$transaction` takes alongside an interactive callback. */
type InteractiveTransactionOptions = {
  maxWait?: number;
  timeout?: number;
};

/**
 * Run `fn` inside the caller's transaction when one is supplied, otherwise open
 * a fresh `prisma.$transaction` - with `options`, when given.
 *
 * This is the single seam that makes `createConfirmedBooking` and
 * `modifyBookingBatch` transaction-aware (#2525) without duplicating their
 * bodies: standalone callers pass no `tx` and get a self-contained transaction —
 * behaviour byte-identical to before — while the atomic approve-and-execute
 * path passes ITS transaction so the reservation release, the request-status
 * claim and the canonical booking write all commit together, closing the
 * mark-approved-then-call-service gap.
 *
 * IMPORTANT: when a caller `tx` is supplied the callback runs to completion but
 * the caller still owns the COMMIT. A service that also performs post-commit
 * provider calls (email, Xero, Stripe) must therefore DEFER those to the caller
 * rather than firing them the instant this returns — see the `deferredPostCommit`
 * thunks the two services attach in tx-mode. Do not perform an external side
 * effect immediately after this resolves in tx-mode; the enclosing transaction
 * has not committed yet.
 *
 * `options` applies only to the transaction this opens: a caller-supplied `tx`
 * already runs on its opener's budget, which governs.
 */
export async function withOptionalTransaction<T>(
  tx: PrismaTransactionClient | undefined,
  fn: (tx: PrismaTransactionClient) => Promise<T>,
  options?: InteractiveTransactionOptions,
): Promise<T> {
  if (tx) {
    return fn(tx);
  }
  const run = (innerTx: Prisma.TransactionClient) =>
    fn(innerTx as unknown as PrismaTransactionClient);
  return options ? prisma.$transaction(run, options) : prisma.$transaction(run);
}

/**
 * Is `store` the ROOT Prisma client rather than an interactive transaction
 * client? The one home for that question (`INV-SSOT`).
 *
 * The TYPES cannot answer it. `Prisma.TransactionClient` is `PrismaClient` minus
 * a deny list, and in Prisma 7 that list (`denylist` in
 * `node_modules/@prisma/client/runtime/client.d.ts`) is
 * `["$connect","$disconnect","$on","$use","$extends"]`. `$transaction` is NOT in
 * it - Prisma 7 supports nested transactions - so the full client is
 * structurally assignable to a transaction-client parameter. Measured with a
 * compile probe, not assumed: `Prisma.TransactionClient & { $transaction?: never }`
 * collapses to `never` and rejects both clients.
 *
 * So the answer is a RUNTIME probe, and the discriminator is `$connect`: measured
 * against a real PostgreSQL on Prisma 7.9.1, an interactive transaction client
 * reports `typeof tx.$transaction === "function"` while `$connect`,
 * `$disconnect` and `$extends` are all `undefined` on it - the deny list is
 * exactly what tells the two apart.
 */
export function isRootPrismaClient(
  store: Prisma.TransactionClient | PrismaClient,
): store is PrismaClient {
  return typeof (store as { $connect?: unknown }).$connect === "function";
}

/**
 * Run `fn` inside the transaction `store` already is, or - when `store` is the
 * root client - inside a new transaction of its own.
 *
 * The sibling of `withOptionalTransaction` for helpers that take ONE `store`
 * parameter defaulting to the root client (the payment-ledger writers) rather
 * than an optional `tx`. The same caveat applies: joined to a caller's
 * transaction, the caller owns the commit.
 */
export async function withStoreTransaction<T>(
  store: Prisma.TransactionClient | PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (isRootPrismaClient(store)) {
    return store.$transaction((tx) => fn(tx));
  }
  return fn(store);
}
