/**
 * ONE `@/lib/auth` double for the #1881 real-PostgreSQL harness.
 *
 * A `vi.mock` in a file the harness imports is registered for the whole
 * harness process, and the LAST file to register a factory for a module wins
 * (the same trap `stripe-race-double.ts` documents). So every realdb suite that
 * drives a session-gated route registers this same factory and sets the session
 * on this one shared holder, which lives on `globalThis` so it is one object
 * even if this module is loaded twice. Signed out (`null`) is the pass-through:
 * no suite's route sees a session unless that suite installs one, and each
 * suite puts it back to `null` when it finishes.
 */
type RaceSession = { user: Record<string, unknown> };

const registry = globalThis as typeof globalThis & { __raceSession?: { current: RaceSession | null } };

export const raceSession: { current: RaceSession | null } = (registry.__raceSession ??= { current: null });

/** The `vi.mock("@/lib/auth")` body every session-driving race suite shares. */
export function raceAuthDouble() {
  return { auth: () => Promise.resolve(raceSession.current) };
}
