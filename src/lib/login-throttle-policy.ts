/**
 * The per-account password sign-in throttle's pure policy (#4609, INV-AUTH).
 *
 * No I/O and no clock: every function takes `now`. The values are a security
 * floor the owner settled on #4454, not a club setting (INV-CONFIG-001 records
 * why), so they are constants and appear nowhere else.
 *
 * "5 wrong passwords within an hour" is read as "an hour with no counted
 * attempt resets the count": failures spaced 59 minutes apart still add up.
 * A fixed hourly window was not chosen because it would also reset the
 * 15-minute ceiling every hour.
 *
 * Kept free of `server-only` so the login form can import the answer code
 * below; the server half lives in `login-throttle.ts`.
 */

/** The `CredentialsSignin` code a throttled attempt answers with. */
export const LOGIN_THROTTLED_CODE = "LOGIN_THROTTLED";

/** Counted attempts allowed before the first wait. */
export const LOGIN_THROTTLE_FREE_FAILURES = 5;
/** An hour with no counted attempt forgets the count. */
export const LOGIN_THROTTLE_IDLE_RESET_MS = 60 * 60 * 1000;
/** The first wait, after the fifth counted attempt. */
export const LOGIN_THROTTLE_BASE_DELAY_MS = 30 * 1000;
/** The wait doubles per further counted attempt up to this ceiling. */
export const LOGIN_THROTTLE_MAX_DELAY_MS = 15 * 60 * 1000;

export interface LoginThrottleState {
  failureCount: number;
  lastFailureAt: Date;
}

export interface LoginThrottleDecision {
  throttled: boolean;
  /** When the next attempt is admitted; null when nothing is waiting. */
  retryAt: Date | null;
}

/** The count that still applies at `now`: zero once an idle hour has passed. */
export function effectiveLoginFailureCount(
  state: LoginThrottleState,
  now: Date,
): number {
  const idleMs = now.getTime() - state.lastFailureAt.getTime();
  return idleMs >= LOGIN_THROTTLE_IDLE_RESET_MS ? 0 : state.failureCount;
}

/**
 * The wait that follows `failureCount` counted attempts: none below the free
 * budget, then the base delay doubling per attempt, capped at the ceiling.
 */
export function loginThrottleDelayMs(
  failureCount: number,
  freeFailures: number,
): number {
  if (failureCount < freeFailures) return 0;
  const doublings = Math.min(failureCount - freeFailures, 30);
  return Math.min(
    LOGIN_THROTTLE_MAX_DELAY_MS,
    LOGIN_THROTTLE_BASE_DELAY_MS * 2 ** doublings,
  );
}

/**
 * Whether an attempt at `now` must wait. An attempt exactly at `retryAt` is
 * admitted. `freeFailures` is required (INV-SSOT-003): the shared store passes
 * the full budget, the per-process fallback its divided one.
 */
export function evaluateLoginThrottle(
  state: LoginThrottleState | null,
  now: Date,
  freeFailures: number,
): LoginThrottleDecision {
  if (!state) return { throttled: false, retryAt: null };
  const count = effectiveLoginFailureCount(state, now);
  const delayMs = loginThrottleDelayMs(count, freeFailures);
  if (delayMs === 0) return { throttled: false, retryAt: null };
  const retryAt = new Date(state.lastFailureAt.getTime() + delayMs);
  return { throttled: now.getTime() < retryAt.getTime(), retryAt };
}

/** The state after an admitted attempt at `now` is counted. */
export function nextLoginThrottleState(
  state: LoginThrottleState | null,
  now: Date,
): LoginThrottleState {
  const count = state ? effectiveLoginFailureCount(state, now) : 0;
  return { failureCount: count + 1, lastFailureAt: now };
}
