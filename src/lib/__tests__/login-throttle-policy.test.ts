/**
 * #4609: the per-account password throttle's pure policy. Explicit instants
 * from the frozen test base; no clock is read.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";
import {
  LOGIN_THROTTLE_FREE_FAILURES,
  LOGIN_THROTTLE_IDLE_RESET_MS,
  LOGIN_THROTTLE_MAX_DELAY_MS,
  evaluateLoginThrottle,
  loginThrottleDelayMs,
  nextLoginThrottleState,
  type LoginThrottleState,
} from "@/lib/login-throttle-policy";

const T0 = new Date(FROZEN_TEST_CLOCK_BASE_ISO);
const at = (ms: number) => new Date(T0.getTime() + ms);
const SECOND = 1000;
const FREE = LOGIN_THROTTLE_FREE_FAILURES;

/** Counts `n` admitted attempts, one per `gapMs`, starting at T0. */
function afterAttempts(n: number, gapMs = 0): LoginThrottleState | null {
  let state: LoginThrottleState | null = null;
  for (let i = 0; i < n; i += 1) state = nextLoginThrottleState(state, at(i * gapMs));
  return state;
}

describe("login throttle policy (#4609)", () => {
  it("pins the security floor the owner settled on #4454", () => {
    expect(LOGIN_THROTTLE_FREE_FAILURES).toBe(5);
    expect(LOGIN_THROTTLE_IDLE_RESET_MS).toBe(3_600_000);
    expect(LOGIN_THROTTLE_MAX_DELAY_MS).toBe(900_000);
  });

  it("never throttles before the fifth counted attempt", () => {
    expect(evaluateLoginThrottle(null, T0, FREE).throttled).toBe(false);
    for (let n = 1; n < FREE; n += 1) {
      expect(evaluateLoginThrottle(afterAttempts(n), T0, FREE)).toEqual({
        throttled: false,
        retryAt: null,
      });
    }
  });

  it("waits 30 s after the fifth, admitting an attempt exactly at retryAt", () => {
    const state = afterAttempts(FREE);
    expect(evaluateLoginThrottle(state, at(30 * SECOND - 1), FREE)).toEqual({
      throttled: true,
      retryAt: at(30 * SECOND),
    });
    expect(evaluateLoginThrottle(state, at(30 * SECOND), FREE).throttled).toBe(false);
  });

  it("doubles the wait per further attempt and stops at 15 minutes", () => {
    const waits: number[] = [];
    let state = afterAttempts(FREE);
    let now = T0;
    for (let attempt = FREE + 1; attempt <= 12; attempt += 1) {
      const { retryAt } = evaluateLoginThrottle(state, now, FREE);
      waits.push((retryAt!.getTime() - now.getTime()) / SECOND);
      now = retryAt!;
      expect(evaluateLoginThrottle(state, now, FREE).throttled).toBe(false);
      state = nextLoginThrottleState(state, now);
    }
    // Waits after the 5th..11th counted attempt.
    expect(waits).toEqual([30, 60, 120, 240, 480, 900, 900]);
    expect(loginThrottleDelayMs(10, FREE)).toBe(900_000);
    expect(loginThrottleDelayMs(12, FREE)).toBe(900_000);
    expect(loginThrottleDelayMs(10_000, FREE)).toBe(900_000);
  });

  it("an attempt during a wait never moves retryAt (nothing is counted)", () => {
    const state = afterAttempts(FREE);
    const first = evaluateLoginThrottle(state, at(SECOND), FREE);
    const later = evaluateLoginThrottle(state, at(29 * SECOND), FREE);
    expect(first.retryAt).toEqual(later.retryAt);
  });

  it("forgets the count after exactly one idle hour, not a millisecond sooner", () => {
    const state = afterAttempts(FREE + 3);
    const last = state!.lastFailureAt.getTime() - T0.getTime();
    expect(
      nextLoginThrottleState(state, at(last + LOGIN_THROTTLE_IDLE_RESET_MS - 1))
        .failureCount,
    ).toBe(FREE + 4);
    expect(
      nextLoginThrottleState(state, at(last + LOGIN_THROTTLE_IDLE_RESET_MS))
        .failureCount,
    ).toBe(1);
  });

  it("reads 'within an hour' as an idle hour: five attempts 59 minutes apart still throttle", () => {
    const gap = 59 * 60 * SECOND;
    const state = afterAttempts(FREE, gap);
    expect(state!.failureCount).toBe(FREE);
    expect(evaluateLoginThrottle(state, at((FREE - 1) * gap + SECOND), FREE).throttled).toBe(
      true,
    );
  });

  it("the divided fallback budget of one throttles after the first counted attempt", () => {
    const state = afterAttempts(1);
    expect(evaluateLoginThrottle(state, at(SECOND), 1)).toEqual({
      throttled: true,
      retryAt: at(30 * SECOND),
    });
  });

  it("the wait never shrinks as the count grows and never passes the ceiling", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), (count) => {
        const here = loginThrottleDelayMs(count, FREE);
        const next = loginThrottleDelayMs(count + 1, FREE);
        return next >= here && next <= LOGIN_THROTTLE_MAX_DELAY_MS;
      }),
      { seed: 4609, numRuns: 200 },
    );
  });
});
