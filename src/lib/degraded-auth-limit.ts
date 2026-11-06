/**
 * Divisor applied to an auth-sensitive budget while it runs on a per-process
 * fallback because its shared Postgres store is unavailable (#1142). 4 covers
 * the blue/green double-slot deployment plus headroom for process restarts
 * resetting in-memory counters mid-window.
 *
 * Its own module so both fallbacks read one value: the per-address limiters
 * (`rate-limit.ts`) and the per-account password throttle
 * (`login-throttle.ts`, #4609). Tests that replace `@/lib/rate-limit` with a
 * partial mock still load the throttle.
 */
export const DEGRADED_AUTH_LIMIT_DIVISOR = 4;
