/**
 * Per-account password sign-in throttle (#4609, INV-AUTH).
 *
 * The per-address limiter (`RATE_LIMITS.login`) cannot see one account being
 * guessed from many addresses. This counts attempts per ACCOUNT KEY instead:
 * an HMAC of the normalised sign-in email under the auth secret, so the
 * address never reaches the table or a log. The policy is in
 * `login-throttle-policy.ts`.
 *
 * An attempt is CLAIMED before its password is compared, under the
 * `LoginThrottle` row lock, so parallel guesses on one account queue and a
 * burst fired the moment a wait ends admits exactly one. The wait for the row
 * is bounded: a claim that cannot have it within a second answers "waiting",
 * so one account under attack cannot hold the connection pool. An account
 * already waiting is refused from an unlocked read without queuing at all. A
 * throttled claim writes nothing; a valid password (or a completed password
 * reset) clears the row. Unknown emails are claimed exactly like real ones: the caller decides
 * before it reads any Member.
 *
 * If the store fails, the claim falls back to a bounded per-process map at
 * the #1142 divided budget and never refuses sign-in for the failure itself.
 */
import "server-only";

import { createHash, createHmac } from "node:crypto";

import { DEGRADED_AUTH_LIMIT_DIVISOR } from "./degraded-auth-limit";
import logger from "./logger";
import {
  LOGIN_THROTTLE_FREE_FAILURES,
  LOGIN_THROTTLE_IDLE_RESET_MS,
  effectiveLoginFailureCount,
  evaluateLoginThrottle,
  nextLoginThrottleState,
  type LoginThrottleState,
} from "./login-throttle-policy";
import { prisma } from "./prisma";
import { isPostgresLockNotAvailable } from "./prisma-errors";
import { getAuthSecret } from "./runtime-config";

/** Domain label so this HMAC can never collide with another use of the secret. */
const ACCOUNT_KEY_LABEL = "login-throttle:v1:";
/**
 * The per-process fallback's free budget: the full budget divided as the
 * auth-sensitive limiters divide theirs in degraded mode (#1142), never below
 * one.
 */
export const LOGIN_THROTTLE_DEGRADED_FREE_FAILURES = Math.max(
  1,
  Math.floor(LOGIN_THROTTLE_FREE_FAILURES / DEGRADED_AUTH_LIMIT_DIVISOR),
);
const MEMORY_MAX_ENTRIES = 10_000;
const STORE_ERROR_LOG_INTERVAL_MS = 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
/**
 * How long a claim waits for its account's row before answering "waiting".
 * A claim holds the row for a few milliseconds, so an ordinary race still
 * queues and counts; a burst on one account cannot hold pooled connections
 * for longer than this each (#4637 review).
 */
const ROW_LOCK_TIMEOUT_MS = 1_000;
/** The claim transaction's own bounds, explicit rather than Prisma's defaults. */
const CLAIM_TRANSACTION_OPTIONS = { maxWait: 1_000, timeout: 3_000 } as const;

/**
 * The one sign-in email normaliser. The Credentials member lookup matches on
 * it too, so the throttle key is never finer than the match (INV-SSOT-002): a
 * case variant that signs in to an account counts against that account.
 */
export function normaliseSignInEmail(email: string): string {
  return email.toLowerCase();
}

/**
 * The account key: HMAC-SHA256 of the normalised email under the auth secret,
 * as 64 hex characters. Exported for #4613's per-account request limits.
 * Throws when no auth secret is configured; callers here catch that and fall
 * back.
 */
export function loginAccountKey(email: string): string {
  const secret = getAuthSecret();
  if (!secret) throw new Error("No auth secret is configured for the login throttle");
  return createHmac("sha256", secret)
    .update(ACCOUNT_KEY_LABEL + normaliseSignInEmail(email))
    .digest("hex");
}

/**
 * The fallback map's key. Without a secret NextAuth cannot sign anyone in
 * anyway; the unkeyed digest only keeps the map working, and it is never
 * stored or logged.
 */
function memoryKeyFor(email: string): string {
  try {
    return loginAccountKey(email);
  } catch {
    return createHash("sha256")
      .update(`${ACCOUNT_KEY_LABEL}unkeyed:${normaliseSignInEmail(email)}`)
      .digest("hex");
  }
}

const memoryStore = new Map<string, LoginThrottleState>();
let lastStoreErrorLogAt = 0;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Logs a store failure at most once a minute, naming no email and no key. */
function noteStoreFailure(err: unknown, now: Date): void {
  if (now.getTime() - lastStoreErrorLogAt < STORE_ERROR_LOG_INTERVAL_MS) return;
  lastStoreErrorLogAt = now.getTime();
  const error = err instanceof Error ? err : null;
  logger.error(
    {
      errorName: error?.name ?? typeof err,
      errorCode: (error as { code?: unknown } | null)?.code ?? null,
    },
    "Login throttle store unavailable; falling back to per-process counting",
  );
}

function sweepMemory(now: Date): void {
  for (const [key, state] of memoryStore) {
    if (effectiveLoginFailureCount(state, now) === 0) memoryStore.delete(key);
  }
  while (memoryStore.size >= MEMORY_MAX_ENTRIES) {
    const oldest = memoryStore.keys().next().value;
    if (oldest === undefined) break;
    memoryStore.delete(oldest);
  }
}

function claimInMemory(key: string, now: Date): boolean {
  if (memoryStore.size >= MEMORY_MAX_ENTRIES) sweepMemory(now);
  const state = memoryStore.get(key) ?? null;
  if (evaluateLoginThrottle(state, now, LOGIN_THROTTLE_DEGRADED_FREE_FAILURES).throttled) {
    return false;
  }
  memoryStore.delete(key);
  memoryStore.set(key, nextLoginThrottleState(state, now));
  return true;
}

type ThrottleTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Ensures the row exists, then locks it, waiting at most `ROW_LOCK_TIMEOUT_MS`
 * (a longer wait raises SQLSTATE 55P03, which the claim answers as "waiting").
 * A clear or the idle sweep can delete the row between the ensure and the lock
 * (READ COMMITTED), and the lock then matches nothing, so a lost row is ensured
 * and locked once more before the claim gives up as a store failure.
 */
async function lockAccountRow(tx: ThrottleTx, key: string, now: Date): Promise<void> {
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(ROW_LOCK_TIMEOUT_MS)}, true)`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await tx.loginThrottle.createMany({
      data: [{ id: key, failureCount: 0, lastFailureAt: now }],
      skipDuplicates: true,
    });
    // Lock raw, read typed (INV-OPS-001): a constant is selected for the lock.
    const locked = await tx.$executeRaw`SELECT 1 FROM "LoginThrottle" WHERE "id" = ${key} FOR UPDATE`;
    if (locked === 1) return;
  }
  throw new Error("Login throttle row could not be locked");
}

/**
 * Deletes rows idle for an hour or more, which already count as zero. Run by
 * the daily `data-pruning` job and, while this process handles password
 * sign-ins, every ten minutes. One `deleteMany`: against a claim holding a row
 * it waits, then re-checks the refreshed row and skips it.
 */
export async function sweepIdleLoginThrottleRows(): Promise<number> {
  const cutoff = new Date(Date.now() - LOGIN_THROTTLE_IDLE_RESET_MS);
  const { count } = await prisma.loginThrottle.deleteMany({
    where: { lastFailureAt: { lt: cutoff } },
  });
  return count;
}

function scheduleCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    sweepIdleLoginThrottleRows().catch(() => {
      // Best-effort: an idle row already counts as zero.
    });
  }, CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) cleanupTimer.unref();
}

/**
 * Claims one password attempt for `email` BEFORE its password is compared.
 * `allowed: false` means the account is waiting — or another claim on it held
 * the row past the lock timeout: the caller must not compare the real
 * password, and nothing was counted. Never throws.
 *
 * An unlocked read first refuses an account already waiting without touching
 * the lock: concurrent claims only make that answer stricter, and a clear
 * racing it costs at most one refused attempt. Most of an attack on one
 * account therefore never queues on its row.
 */
export async function claimPasswordAttempt(email: string): Promise<{ allowed: boolean }> {
  const seenAt = new Date();
  try {
    const key = loginAccountKey(email);
    scheduleCleanup();
    const seen = await prisma.loginThrottle.findUnique({
      where: { id: key },
      select: { failureCount: true, lastFailureAt: true },
    });
    if (evaluateLoginThrottle(seen, seenAt, LOGIN_THROTTLE_FREE_FAILURES).throttled) {
      return { allowed: false };
    }
    const allowed = await prisma.$transaction(async (tx) => {
      await lockAccountRow(tx, key, seenAt);
      // The instant is taken once the row is held, so lock order is time order
      // and lastFailureAt can never move backwards (#4637 review).
      const now = new Date();
      const row = await tx.loginThrottle.findUniqueOrThrow({
        where: { id: key },
        select: { failureCount: true, lastFailureAt: true },
      });
      if (evaluateLoginThrottle(row, now, LOGIN_THROTTLE_FREE_FAILURES).throttled) {
        return false;
      }
      await tx.loginThrottle.update({
        where: { id: key },
        data: nextLoginThrottleState(row, now),
      });
      return true;
    }, CLAIM_TRANSACTION_OPTIONS);
    return { allowed };
  } catch (err) {
    // Another claim held the row past the lock timeout: answer "waiting",
    // uncounted. It is contention on this account, not a store failure.
    if (isPostgresLockNotAvailable(err)) return { allowed: false };
    const now = new Date();
    noteStoreFailure(err, now);
    return { allowed: claimInMemory(memoryKeyFor(email), now) };
  }
}

/**
 * Forgets `email`'s count, after a valid password or a completed password
 * reset. Never throws: a failed delete leaves a count the next valid password
 * or the idle hour clears.
 */
export async function clearPasswordAttempts(email: string): Promise<void> {
  try {
    const key = memoryKeyFor(email);
    memoryStore.delete(key);
    if (!getAuthSecret()) return;
    await prisma.loginThrottle.deleteMany({ where: { id: key } });
  } catch (err) {
    noteStoreFailure(err, new Date());
  }
}

// test seam
/** Resets the per-process state between tests. */
export function resetLoginThrottleProcessState(): void {
  memoryStore.clear();
  lastStoreErrorLogAt = 0;
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
}
