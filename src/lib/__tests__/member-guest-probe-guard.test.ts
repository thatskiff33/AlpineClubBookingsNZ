// #2388 (built as part of MG3, #2308) — the three mitigations the owner decided
// on 31 Jul 2026, and the ONE property the owner was explicit about: repeated
// refusals are LOGGED for an admin and NEVER blocked.
//
// The last describe block in this file is the one that matters most. A member
// trying several dates to find one that suits a friend is the normal, innocent
// case; the owner rejected an automatic cap outright. So there is a test that
// runs a long refused sequence and asserts every answer stays byte-identical and
// that nothing anywhere branches on the repeat count.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The timing-floor assertions below used to read `Date.now()`. Since #2481 every
// test file runs with the wall clock FROZEN, which makes `Date.now()` a constant
// — the two "it actually waited" assertions would have failed and, worse, the
// two "it did NOT wait" assertions would have passed vacuously off a hard-coded
// zero, reporting green while checking nothing. `realElapsedMs` measures with
// the monotonic clock the freeze leaves alone; see its docblock for why it is
// deliberately a different API from the `performance.now()` the guard reads.
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const h = vi.hoisted(() => ({
  createStructuredAuditLog: vi.fn(),
  auditLogCount: vi.fn(),
  applyMemberScopedRateLimit: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  createStructuredAuditLog: h.createStructuredAuditLog,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: { count: h.auditLogCount } },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: h.loggerError },
}));
// `applyMemberScopedRateLimit` has its own tests in rate-limit.test.ts, where the
// two-key ordering is asserted against the real counter. Stubbing it here keeps
// this file about WHEN the throttle is consulted and what is done with its
// answer, which is the part #2388 actually decided.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/rate-limit")),
  applyMemberScopedRateLimit: h.applyMemberScopedRateLimit,
}));

import {
  MEMBER_GUEST_REFUSAL_AUDIT_ACTION,
  MEMBER_GUEST_REFUSAL_FLOOR_MS,
  MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION,
  MEMBER_GUEST_REPEATED_REFUSAL_THRESHOLD,
  MEMBER_GUEST_REPEATED_REFUSAL_WINDOW_MS,
  __setMemberGuestRefusalFloorMs,
  applyMemberGuestAddThrottle,
  equaliseMemberGuestRefusalTiming,
  handleMemberGuestAddRefusal,
  memberGuestAddThrottleHook,
  MemberGuestAddThrottledError,
  memberGuestRefusalDelayMs,
  recordMemberGuestAddRefusal,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import { rateLimiters } from "@/lib/rate-limit";
import { resolveLinkedBookingMembersWithBoundary } from "@/lib/booking-guests";

const request = () =>
  new Request("https://club.example/api/bookings/quote", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.7" },
  });

const ALLOWED = null;
const DENIED = () =>
  new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 });

/**
 * Count refusals and warnings SEPARATELY (privacy re-review of MG3 #2308,
 * MEDIUM-1).
 *
 * `recordMemberGuestAddRefusal` now asks two different questions of
 * `auditLog.count` — "how many refusals in the window" and "has a warning
 * already been raised in the window" — and a single `mockResolvedValue` answers
 * both with the same number, which is not a state the database can be in. The
 * helper answers each by the action the query filters on, so a test can put the
 * counter anywhere it likes on either axis.
 */
function countByAction(refusals: number, warnings: number) {
  return async (args: { where?: { action?: string } }) =>
    args?.where?.action === MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION
      ? warnings
      : refusals;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.createStructuredAuditLog.mockResolvedValue(undefined);
  h.auditLogCount.mockResolvedValue(1);
  h.applyMemberScopedRateLimit.mockResolvedValue(ALLOWED);
  __setMemberGuestRefusalFloorMs(0);
});

afterEach(() => {
  __setMemberGuestRefusalFloorMs(MEMBER_GUEST_REFUSAL_FLOOR_MS);
});

describe("1. per-acting-member throttling on the add paths", () => {
  it("does nothing at all when the attempt names nobody beyond the family", async () => {
    const result = await applyMemberGuestAddThrottle({
      request: request(),
      actorMemberId: "m-booker",
      beyondFamilyMemberIds: [],
    });
    expect(result).toBeNull();
    // The property that keeps an ordinary family booking untouched: not merely
    // "allowed", but never counted at all, however many times the booker
    // changes their dates.
    expect(h.applyMemberScopedRateLimit).not.toHaveBeenCalled();
  });

  it("exempts an admin acting on behalf", async () => {
    const result = await applyMemberGuestAddThrottle({
      request: request(),
      actorMemberId: "m-officer",
      beyondFamilyMemberIds: ["m-stranger"],
      skipAuthorization: true,
    });
    expect(result).toBeNull();
    expect(h.applyMemberScopedRateLimit).not.toHaveBeenCalled();
  });

  it("throttles per ACTING MEMBER, through the member-scoped helper", async () => {
    await applyMemberGuestAddThrottle({
      request: request(),
      actorMemberId: "m-booker",
      beyondFamilyMemberIds: ["m-stranger"],
    });
    const actors = h.applyMemberScopedRateLimit.mock.calls.map((call) => call[2] as string);
    expect(actors).toEqual(["m-booker", "m-booker"]);
    const limiterIds = h.applyMemberScopedRateLimit.mock.calls.map(
      (call) => (call[0] as { id: string }).id,
    );
    // A burst window AND a daily backstop: the burst catches a script, the daily
    // is what actually defeats mapping a season.
    expect(limiterIds).toEqual([
      rateLimiters.memberGuestAddProbe.id,
      rateLimiters.memberGuestAddProbeDaily.id,
    ]);
  });

  it("returns a 429 when the burst budget is spent, without touching the daily one", async () => {
    h.applyMemberScopedRateLimit.mockResolvedValueOnce(DENIED());
    const result = await applyMemberGuestAddThrottle({
      request: request(),
      actorMemberId: "m-booker",
      beyondFamilyMemberIds: ["m-stranger"],
    });
    expect(result?.status).toBe(429);
    expect(h.applyMemberScopedRateLimit).toHaveBeenCalledTimes(1);
  });

  it("returns a 429 when only the daily backstop is spent", async () => {
    h.applyMemberScopedRateLimit
      .mockResolvedValueOnce(ALLOWED)
      .mockResolvedValueOnce(DENIED());
    const result = await applyMemberGuestAddThrottle({
      request: request(),
      actorMemberId: "m-booker",
      beyondFamilyMemberIds: ["m-stranger"],
    });
    expect(result?.status).toBe(429);
  });
});

describe("2. response-timing equalisation", () => {
  it("computes the remaining delay from the floor and the elapsed time", () => {
    __setMemberGuestRefusalFloorMs(250);
    expect(memberGuestRefusalDelayMs(0)).toBe(250);
    expect(memberGuestRefusalDelayMs(100)).toBe(150);
    // Never negative: a refusal that already took longer than the floor is not
    // hurried, and is not made to wait a second time.
    expect(memberGuestRefusalDelayMs(400)).toBe(0);
  });

  it("actually waits when the answer came back faster than the floor", async () => {
    __setMemberGuestRefusalFloorMs(60);
    // Two clocks on purpose: the helper is driven by the monotonic one it
    // actually uses, while the ASSERTION measures real elapsed time from a
    // different API, so this cannot pass by both sides sharing a broken clock.
    const clock = startMemberGuestRefusalClock();
    const before = process.hrtime.bigint();
    await equaliseMemberGuestRefusalTiming(clock);
    expect(realElapsedMs(before)).toBeGreaterThanOrEqual(50);
  });

  it("does not wait at all when the answer already took longer than the floor", async () => {
    __setMemberGuestRefusalFloorMs(20);
    // Five seconds of elapsed time, expressed the only way the branded type
    // allows: a real reading, moved back. The cast is the test acknowledging
    // that it is faking a clock, which is exactly what the brand is for.
    const clock = (startMemberGuestRefusalClock() - 5_000) as ReturnType<
      typeof startMemberGuestRefusalClock
    >;
    const before = process.hrtime.bigint();
    await equaliseMemberGuestRefusalTiming(clock);
    expect(realElapsedMs(before)).toBeLessThan(20);
  });

  it("applies the WHOLE floor rather than skipping it when the elapsed time is impossible", () => {
    // L4's second half. A caller who measured against the wall clock produces a
    // vast negative delta; the arithmetic's natural answer is "wait zero", i.e.
    // silently drop the control. Failing closed costs a quarter-second and
    // cannot leak anything.
    __setMemberGuestRefusalFloorMs(250);
    expect(memberGuestRefusalDelayMs(-1_700_000_000_000)).toBe(250);
    expect(memberGuestRefusalDelayMs(Number.NaN)).toBe(250);
    expect(memberGuestRefusalDelayMs(60 * 60 * 1000)).toBe(250);
    expect(memberGuestRefusalDelayMs(100)).toBe(150);
  });

  it("uses a MONOTONIC clock, so an NTP jump cannot skip or hang the floor", () => {
    // `Date.now()` is not a duration clock: a correction mid-request can make a
    // wall-clock delta negative (floor skipped) or enormous (response hangs).
    const a = startMemberGuestRefusalClock();
    const b = startMemberGuestRefusalClock();
    expect(b).toBeGreaterThanOrEqual(a);
    // And it is NOT epoch milliseconds — which is what stops anybody mistaking
    // it for a timestamp worth putting in an idempotency key.
    expect(a).toBeLessThan(Date.now() / 2);
  });
});

describe("3. logging repeated refusals — for an admin, NEVER a block", () => {
  it("writes one audit row per refused target, naming actor and subject", async () => {
    await recordMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      targetMemberIds: ["m-stranger", "m-other"],
      route: "bookings/quote",
    });

    const refusals = h.createStructuredAuditLog.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((event) => event.action === MEMBER_GUEST_REFUSAL_AUDIT_ACTION);
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toMatchObject({
      actor: { memberId: "m-booker" },
      subject: { memberId: "m-stranger" },
      category: "privacy",
      outcome: "failure",
      retentionClass: "sensitive_access",
    });
    expect(refusals[1]).toMatchObject({ subject: { memberId: "m-other" } });
  });

  it("raises a distinct, findable row once the same target is refused repeatedly", async () => {
    h.auditLogCount.mockImplementation(
      countByAction(MEMBER_GUEST_REPEATED_REFUSAL_THRESHOLD, 0),
    );
    await recordMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      targetMemberIds: ["m-stranger"],
      route: "bookings/quote",
    });

    const warnings = h.createStructuredAuditLog.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((event) => event.action === MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      actor: { memberId: "m-booker" },
      subject: { memberId: "m-stranger" },
      severity: "important",
    });
    // The summary an admin reads has to say plainly that nothing was blocked,
    // or a club officer will assume the system already handled it.
    expect(String(warnings[0]!.summary)).toContain("nothing has been blocked");
  });

  it("counts only refusals by THIS actor against THIS target, inside the window", async () => {
    const now = new Date("2026-08-01T09:00:00.000Z");
    await recordMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      targetMemberIds: ["m-stranger"],
      route: "bookings/quote",
      now,
    });
    expect(h.auditLogCount).toHaveBeenCalledWith({
      where: {
        action: MEMBER_GUEST_REFUSAL_AUDIT_ACTION,
        actorMemberId: "m-booker",
        subjectMemberId: "m-stranger",
        createdAt: {
          gte: new Date(now.getTime() - MEMBER_GUEST_REPEATED_REFUSAL_WINDOW_MS),
        },
      },
    });
  });

  it("NEVER blocks an honest retry sequence — the owner's explicit sub-decision", async () => {
    // Twenty consecutive refusals naming the SAME member, far past the
    // threshold. This is the innocent case: somebody hunting for a date that
    // works for a friend. The property asserted is that the guard's answer never
    // changes — it has no return value to change, it raises no error, and the
    // caller's behaviour is identical on the twentieth attempt and the first.
    const attempts = 20;
    const outcomes: unknown[] = [];
    for (let i = 1; i <= attempts; i += 1) {
      h.auditLogCount.mockResolvedValue(i);
      outcomes.push(
        await recordMemberGuestAddRefusal({
          request: request(),
          actorMemberId: "m-booker",
          targetMemberIds: ["m-friend"],
          route: "bookings/quote",
        }),
      );
    }
    // Every call returned undefined — there is no signal a caller could act on.
    expect(outcomes.every((outcome) => outcome === undefined)).toBe(true);
    // And every attempt was recorded, including the ones past the threshold:
    // logging continues rather than degrading into a block.
    const refusals = h.createStructuredAuditLog.mock.calls.filter(
      (call) => (call[0] as { action: string }).action === MEMBER_GUEST_REFUSAL_AUDIT_ACTION,
    );
    expect(refusals).toHaveLength(attempts);
  });

  it("warns ONCE per actor/target per window, not on every refusal past the threshold", async () => {
    // MEDIUM-1 of the MG3 (#2308) privacy re-review, and the case that made it a
    // finding rather than a nicety: a booker re-dating a booking that happens to
    // carry a member guest produces one refusal per debounced quote. Eight date
    // tweaks in an afternoon used to raise FOUR severity-`important` rows naming
    // an innocent member. The signal the owner asked for is "somebody crossed
    // the line"; a flood of duplicates is how an admin learns to scroll past it.
    //
    // Simulated exactly as the database would behave: the refusal count climbs
    // with every attempt, and the warning count is 0 until the first warning is
    // written and 1 afterwards.
    let warningsInWindow = 0;
    h.auditLogCount.mockImplementation(async (args: { where?: { action?: string } }) =>
      args?.where?.action === MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION
        ? warningsInWindow
        : MEMBER_GUEST_REPEATED_REFUSAL_THRESHOLD + 3,
    );
    h.createStructuredAuditLog.mockImplementation(async (event: { action: string }) => {
      if (event.action === MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION) {
        warningsInWindow += 1;
      }
    });

    for (let i = 0; i < 8; i += 1) {
      await recordMemberGuestAddRefusal({
        request: request(),
        actorMemberId: "m-booker",
        targetMemberIds: ["m-friend"],
        route: "bookings/modify-quote",
      });
    }

    const events = h.createStructuredAuditLog.mock.calls.map(
      (call) => call[0] as { action: string },
    );
    // Every refusal is still recorded individually — the dedup is on the WARNING
    // only, and losing the per-refusal rows would take the audit trail with it.
    expect(
      events.filter((e) => e.action === MEMBER_GUEST_REFUSAL_AUDIT_ACTION),
    ).toHaveLength(8);
    expect(
      events.filter((e) => e.action === MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION),
    ).toHaveLength(1);
  });

  it("fires on a count that JUMPS the threshold, not only on landing exactly on it", async () => {
    // Concurrent refusals can take the count from four straight to six, so an
    // equality test against the threshold would never fire at all. The check is
    // `>=` plus "has a warning already been written", which is why this passes.
    h.auditLogCount.mockImplementation(
      countByAction(MEMBER_GUEST_REPEATED_REFUSAL_THRESHOLD + 1, 0),
    );
    await recordMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      targetMemberIds: ["m-friend"],
      route: "bookings/quote",
    });
    expect(
      h.createStructuredAuditLog.mock.calls.filter(
        (call) =>
          (call[0] as { action: string }).action ===
          MEMBER_GUEST_REPEATED_REFUSAL_AUDIT_ACTION,
      ),
    ).toHaveLength(1);
  });

  it("fails open — an audit outage cannot break a booking", async () => {
    h.createStructuredAuditLog.mockRejectedValue(new Error("audit store down"));
    await expect(
      recordMemberGuestAddRefusal({
        request: request(),
        actorMemberId: "m-booker",
        targetMemberIds: ["m-stranger"],
        route: "bookings/quote",
      }),
    ).resolves.toBeUndefined();
    expect(h.loggerError).toHaveBeenCalled();
  });
});

describe("handleMemberGuestAddRefusal — the one call every add path makes", () => {
  it("does nothing for an ordinary validation error", async () => {
    __setMemberGuestRefusalFloorMs(5_000);
    const before = process.hrtime.bigint();
    await handleMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      error: { message: "Check-out must be after check-in" } as {
        crossFamilyMemberIds?: readonly string[];
      },
      route: "bookings/quote",
      startedAt: startMemberGuestRefusalClock(),
      throttle: "CHARGE_NOW",
    });
    // The floor must NOT be applied to ordinary errors: a quarter-second (here
    // five seconds) on "check-out must be after check-in" would slow the whole
    // booking flow down to hide nothing.
    expect(realElapsedMs(before)).toBeLessThan(1_000);
    expect(h.createStructuredAuditLog).not.toHaveBeenCalled();
    expect(h.applyMemberScopedRateLimit).not.toHaveBeenCalled();
  });

  it("spends the throttle budget, audits, and equalises for a collapsed refusal", async () => {
    __setMemberGuestRefusalFloorMs(40);
    const startedAt = startMemberGuestRefusalClock();
    const before = process.hrtime.bigint();
    await handleMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      error: { crossFamilyMemberIds: ["m-stranger"] },
      route: "bookings/quote",
      startedAt,
      throttle: "CHARGE_NOW",
    });
    expect(h.applyMemberScopedRateLimit).toHaveBeenCalled();
    expect(h.createStructuredAuditLog).toHaveBeenCalled();
    expect(realElapsedMs(before)).toBeGreaterThanOrEqual(30);
  });

  it("never converts a refusal into a 429, even when the budget is spent", async () => {
    // Returning a 429 only when the caller guessed a REAL member would be its
    // own oracle. The throttle's answer is deliberately discarded here.
    h.applyMemberScopedRateLimit.mockResolvedValue(DENIED());
    await expect(
      handleMemberGuestAddRefusal({
        request: request(),
        actorMemberId: "m-booker",
        error: { crossFamilyMemberIds: ["m-stranger"] },
        route: "bookings/quote",
        startedAt: startMemberGuestRefusalClock(),
        throttle: "CHARGE_NOW",
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The fixes the privacy and correctness reviews of MG3 (#2308) landed here
// ---------------------------------------------------------------------------

describe("H1 — the throttle is spent BEFORE anything is read about the member", () => {
  it("raises the 429 out of the boundary hook, so both resolution branches answer alike", async () => {
    h.applyMemberScopedRateLimit.mockResolvedValue(DENIED());
    const hook = memberGuestAddThrottleHook({
      request: request(),
      actorMemberId: "m-booker",
    });
    const error = await hook({ beyondFamilyMemberIds: ["m-stranger"] }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(MemberGuestAddThrottledError);
    expect((error as MemberGuestAddThrottledError).response.status).toBe(429);
  });

  it("stays silent for a family-only attempt, so ordinary bookings are never throttled", async () => {
    const hook = memberGuestAddThrottleHook({
      request: request(),
      actorMemberId: "m-booker",
    });
    await expect(hook({ beyondFamilyMemberIds: [] })).resolves.toBeUndefined();
    expect(h.applyMemberScopedRateLimit).not.toHaveBeenCalled();
  });

  it("exempts an admin acting on behalf, exactly as the direct throttle does", async () => {
    const hook = memberGuestAddThrottleHook({
      request: request(),
      actorMemberId: "m-officer",
      skipAuthorization: true,
    });
    await expect(hook({ beyondFamilyMemberIds: ["m-stranger"] })).resolves.toBeUndefined();
    expect(h.applyMemberScopedRateLimit).not.toHaveBeenCalled();
  });

  it("runs before the member records are read, on a real resolve", async () => {
    // The ordering claim, asserted against `resolveLinkedBookingMembersWithBoundary`
    // itself rather than against a route: the hook must fire before the member
    // lookup, or an id with nobody behind it throws first and answers 403 while a
    // real member answers 429.
    const calls: string[] = [];
    const db = {
      familyGroupMember: { findMany: async () => [] },
      member: {
        findMany: async () => {
          calls.push("member.findMany");
          return [];
        },
      },
    } as unknown as Parameters<typeof resolveLinkedBookingMembersWithBoundary>[0];

    h.applyMemberScopedRateLimit.mockResolvedValue(DENIED());
    const error = await resolveLinkedBookingMembersWithBoundary(db, "m-booker", ["m-ghost"], {
      memberGuestWideningEnabled: true,
      onBoundaryResolved: memberGuestAddThrottleHook({
        request: request(),
        actorMemberId: "m-booker",
      }),
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MemberGuestAddThrottledError);
    expect(calls).toEqual([]);
  });
});

describe("MEDIUM-1 — exactly one throttle unit per attempt", () => {
  it("does not charge again on a route whose hook already charged", async () => {
    await handleMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      error: { crossFamilyMemberIds: ["m-stranger"] },
      route: "bookings/quote",
      startedAt: startMemberGuestRefusalClock(),
      throttle: "ALREADY_CHARGED",
    });
    // Double-charging halved the real budget on the refused path — which is both
    // the probe channel AND the owner's explicitly protected honest case.
    expect(h.applyMemberScopedRateLimit).not.toHaveBeenCalled();
    // The other two mitigations still run.
    expect(h.createStructuredAuditLog).toHaveBeenCalled();
  });

  it("charges once on a route that resolves inside its transaction", async () => {
    await handleMemberGuestAddRefusal({
      request: request(),
      actorMemberId: "m-booker",
      error: { crossFamilyMemberIds: ["m-stranger"] },
      route: "bookings/guests-add",
      startedAt: startMemberGuestRefusalClock(),
      throttle: "CHARGE_NOW",
    });
    // Two calls, not four: the burst window and the daily backstop, once each.
    expect(h.applyMemberScopedRateLimit).toHaveBeenCalledTimes(2);
  });
});

describe("#2388 acceptance — a run of probes across dates is throttled before it yields a calendar", () => {
  it("cuts the run off at the burst cap, long before a season is mapped", async () => {
    // The owner's first acceptance criterion, which had no test at any level.
    // A real counter is used, not a stub: the limiter's own budget decides.
    // One counter PER LIMITER: `applyMemberGuestAddThrottle` consults the burst
    // window and the daily backstop, so a single shared counter would spend both
    // budgets on every attempt.
    const spent = new Map<string, number>();
    h.applyMemberScopedRateLimit.mockImplementation(
      async (config: { id: string; limit: number }) => {
        const next = (spent.get(config.id) ?? 0) + 1;
        spent.set(config.id, next);
        return next > config.limit ? DENIED() : ALLOWED;
      },
    );

    const hook = memberGuestAddThrottleHook({
      request: request(),
      actorMemberId: "m-prober",
    });

    // One attempt per candidate date, all naming the same member.
    const answers: string[] = [];
    for (let night = 0; night < 40; night += 1) {
      const outcome = await hook({ beyondFamilyMemberIds: ["m-target"] }).then(
        () => "answered",
        (err: unknown) =>
          err instanceof MemberGuestAddThrottledError ? "throttled" : "other",
      );
      answers.push(outcome);
    }

    const answered = answers.filter((a) => a === "answered").length;
    expect(answered).toBe(rateLimiters.memberGuestAddProbe.limit);
    expect(answers.at(-1)).toBe("throttled");
    // A lodge season is ~150 nights; the run stops an order of magnitude short of
    // one sitting's worth of it.
    expect(answered).toBeLessThan(150);
  });

  it("leaves an honest family booking completely untouched, however many dates it tries", async () => {
    const hook = memberGuestAddThrottleHook({
      request: request(),
      actorMemberId: "m-honest",
    });
    for (let night = 0; night < 40; night += 1) {
      await expect(hook({ beyondFamilyMemberIds: [] })).resolves.toBeUndefined();
    }
    expect(h.applyMemberScopedRateLimit).not.toHaveBeenCalled();
  });
});
