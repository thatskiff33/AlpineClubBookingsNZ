import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit as checkSharedRateLimit,
  checkRateLimitInMemory as checkRateLimit,
  getClientIp,
  applyRateLimit,
  applyMemberScopedRateLimit,
  MEMBER_SCOPED_IP_LIMIT_MULTIPLIER,
  rateLimiters,
  _testStore,
  type RateLimitConfig,
} from "../rate-limit";

// Shared-store path (#1039 item 4): prisma is mocked so the atomic upsert
// can be scripted; the fallback test rejects it to prove degradation.
const mockQueryRaw = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
    $executeRaw: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe("rate-limit", () => {
  beforeEach(() => {
    _testStore.clear();
  });

  describe("checkRateLimit", () => {
    const config: RateLimitConfig = {
      id: "test",
      limit: 3,
      windowSeconds: 60,
    };

    it("allows requests within the limit", () => {
      const r1 = checkRateLimit(config, "ip1");
      expect(r1.success).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = checkRateLimit(config, "ip1");
      expect(r2.success).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = checkRateLimit(config, "ip1");
      expect(r3.success).toBe(true);
      expect(r3.remaining).toBe(0);
    });

    it("blocks requests exceeding the limit", () => {
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");

      const r4 = checkRateLimit(config, "ip1");
      expect(r4.success).toBe(false);
      expect(r4.remaining).toBe(0);
    });

    it("tracks different IPs independently", () => {
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");

      // ip2 should still be allowed
      const r = checkRateLimit(config, "ip2");
      expect(r.success).toBe(true);
      expect(r.remaining).toBe(2);
    });

    it("tracks different configs independently", () => {
      const config2: RateLimitConfig = { id: "test2", limit: 5, windowSeconds: 60 };

      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");

      // Different config, same IP should still be allowed
      const r = checkRateLimit(config2, "ip1");
      expect(r.success).toBe(true);
      expect(r.remaining).toBe(4);
    });

    it("resets after window expires", () => {
      // Manually set an expired entry
      _testStore.set("test:ip1", { count: 5, resetAt: Date.now() - 1000 });

      const r = checkRateLimit(config, "ip1");
      expect(r.success).toBe(true);
      expect(r.remaining).toBe(2);
    });

    it("returns correct resetAt timestamp", () => {
      const before = Date.now();
      const r = checkRateLimit(config, "ip1");
      const after = Date.now();

      expect(r.resetAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(r.resetAt).toBeLessThanOrEqual(after + 60_000);
    });
  });

  describe("getClientIp", () => {
    it("extracts last IP from x-forwarded-for (rightmost = closest trusted proxy)", () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      });
      expect(getClientIp(req)).toBe("5.6.7.8");
    });

    it("ignores a client-supplied leftmost x-forwarded-for value once Caddy appends the real peer", () => {
      const req = new Request("http://localhost", {
        headers: {
          "x-forwarded-for": "203.0.113.250, 198.51.100.42",
          "x-real-ip": "198.51.100.42",
        },
      });
      expect(getClientIp(req)).toBe("198.51.100.42");
    });

    it("extracts IP from x-real-ip", () => {
      const req = new Request("http://localhost", {
        headers: { "x-real-ip": "9.8.7.6" },
      });
      expect(getClientIp(req)).toBe("9.8.7.6");
    });

    it("returns unknown when no headers present", () => {
      const req = new Request("http://localhost");
      expect(getClientIp(req)).toBe("unknown");
    });

    it("prefers x-forwarded-for over x-real-ip", () => {
      const req = new Request("http://localhost", {
        headers: {
          "x-forwarded-for": "1.1.1.1",
          "x-real-ip": "2.2.2.2",
        },
      });
      expect(getClientIp(req)).toBe("1.1.1.1");
    });
  });

  describe("applyRateLimit", () => {
    const config: RateLimitConfig = { id: "apply-test", limit: 2, windowSeconds: 60 };

    it("returns null when within limit", async () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      const result = await applyRateLimit(config, req);
      expect(result).toBeNull();
    });

    it("returns 429 Response when limit exceeded", async () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "10.0.0.2" },
      });

      await applyRateLimit(config, req);
      await applyRateLimit(config, req);
      const result = await applyRateLimit(config, req);

      expect(result).not.toBeNull();
      expect(result!.status).toBe(429);
      expect(result!.headers.get("Retry-After")).toBeTruthy();
    });

    it("includes rate limit headers on 429", async () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "10.0.0.3" },
      });

      await applyRateLimit(config, req);
      await applyRateLimit(config, req);
      const result = await applyRateLimit(config, req);

      expect(result!.headers.get("X-RateLimit-Limit")).toBe("2");
      expect(result!.headers.get("X-RateLimit-Remaining")).toBe("0");

      const body = await result!.json();
      expect(body.error).toContain("Too many requests");
    });
  });
});

describe("shared rate-limit store (#1039)", () => {
  const config = { id: "shared-test", limit: 2, windowSeconds: 60 };

  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it("allows and counts through the shared Postgres counter", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    mockQueryRaw.mockResolvedValueOnce([{ count: 1, resetAt }]);

    const result = await checkSharedRateLimit(config, "ip1");

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.resetAt).toBe(resetAt.getTime());
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it("blocks once the shared counter exceeds the limit", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    mockQueryRaw.mockResolvedValueOnce([{ count: 3, resetAt }]);

    const result = await checkSharedRateLimit(config, "ip1");

    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("falls back to per-process limiting when the store is unavailable", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));

    const r1 = await checkSharedRateLimit(config, "fallback-ip");
    const r2 = await checkSharedRateLimit(config, "fallback-ip");
    const r3 = await checkSharedRateLimit(config, "fallback-ip");

    // The in-memory window still enforces the limit per process.
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(false);
  });

  // #2289. The upsert's result is read, so a renamed or retyped column used to
  // arrive as `undefined`: `Number(undefined)` is `NaN`, `NaN > limit` is false,
  // and the limiter waved EVERY request through with no error to catch. The
  // decoder turns that into a throw, which the existing catch treats as the
  // store failing — degraded per-process limiting, which still limits.
  //
  // `resetAt` is deliberately left CORRECT and only `count` renamed: that is the
  // sharp version of the bug. Get `resetAt` wrong too and the old code threw a
  // TypeError on `undefined.getTime()` anyway, which would make this test pass
  // with the decoder removed. With only `count` missing, the undecoded path
  // returns success for all four requests.
  it("does not stop limiting when the shared store returns the wrong column shape", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    mockQueryRaw.mockResolvedValue([{ counter: 1, resetAt }]);

    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await checkSharedRateLimit(config, "renamed-column-ip"));
    }

    expect(results.map((r) => r.success)).toEqual([true, true, false, false]);
  });

  it("does not treat a bigint counter as unlimited", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    // int8 / COUNT(*) come back as BigInt; `NaN`-free arithmetic must survive it.
    mockQueryRaw.mockResolvedValueOnce([{ count: BigInt(3), resetAt }]);

    const result = await checkSharedRateLimit(config, "bigint-ip");

    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

describe("degraded-mode policy for auth-sensitive limiters (#1142)", () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
  });

  it("shrinks the fallback budget to limit/4 for auth-sensitive limiters", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));
    const config = {
      id: "degraded-auth-test",
      limit: 8,
      windowSeconds: 60,
      authSensitive: true,
    };

    // floor(8 / 4) = 2 allowed, third rejected.
    const r1 = await checkSharedRateLimit(config, "attacker-ip");
    const r2 = await checkSharedRateLimit(config, "attacker-ip");
    const r3 = await checkSharedRateLimit(config, "attacker-ip");

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(false);
    expect(r3.limit).toBe(2);
  });

  it("never shrinks the degraded budget below one request", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));
    const config = {
      id: "degraded-floor-test",
      limit: 3,
      windowSeconds: 60,
      authSensitive: true,
    };

    // floor(3 / 4) = 0, floored to 1 so legitimate users are not locked out.
    const r1 = await checkSharedRateLimit(config, "member-ip");
    const r2 = await checkSharedRateLimit(config, "member-ip");

    expect(r1.success).toBe(true);
    expect(r1.limit).toBe(1);
    expect(r2.success).toBe(false);
  });

  it("keeps the full budget for non-sensitive limiters in degraded mode", async () => {
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));
    const config = { id: "degraded-plain-test", limit: 8, windowSeconds: 60 };

    for (let i = 0; i < 8; i += 1) {
      const r = await checkSharedRateLimit(config, "reader-ip");
      expect(r.success).toBe(true);
    }
    const r9 = await checkSharedRateLimit(config, "reader-ip");
    expect(r9.success).toBe(false);
    expect(r9.limit).toBe(8);
  });

  it("applies the full budget when the shared store is healthy, even for auth-sensitive limiters", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    mockQueryRaw.mockResolvedValueOnce([{ count: 8, resetAt }]);
    const config = {
      id: "healthy-auth-test",
      limit: 8,
      windowSeconds: 60,
      authSensitive: true,
    };

    const result = await checkSharedRateLimit(config, "ip1");

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("does not shrink direct in-memory checks that are not degraded fallbacks", () => {
    const config = {
      id: "direct-memory-auth-test",
      limit: 8,
      windowSeconds: 60,
      authSensitive: true,
    };

    for (let i = 0; i < 8; i += 1) {
      expect(checkRateLimit(config, "ip1").success).toBe(true);
    }
    expect(checkRateLimit(config, "ip1").success).toBe(false);
  });

  it("marks every credential-guessing and public-form limiter as auth-sensitive", () => {
    const expected = [
      "login",
      "register",
      "membershipApplication",
      "forgotPassword",
      // Magic-link sign-in request (#2034): credential-adjacent public form,
      // mirrors forgotPassword's degraded-mode budget hardening.
      "magicLinkRequest",
      "resetPassword",
      "lodgePinLogin",
      "twoFactorVerify",
      "contact",
      // Lobby display pairing start / admin code bind (#27, ADR-001 §5).
      // displayClaim is deliberately NOT auth-sensitive: the claim poll can
      // only present the code inside its own server-signed blob, so it has
      // no credential-guessing surface.
      "displayPairing",
      // AI help assistant (#2211, C3): the per-member/per-IP/global limiters
      // guard paid model spend, so a degraded shared-store fallback must not be
      // usable to multiply paid-call budget across replicas.
      "aiChatMember",
      "aiChatIp",
      "aiChatGlobal",
      // AI Diagnostics (AID-2, #2371): a SEPARATE admin-only paid product with
      // its own dedicated credential and budget. Its per-admin/per-IP/global
      // limiters guard paid model spend, so — like the aiChat trio above — a
      // degraded shared-store fallback must TIGHTEN (never multiply) the paid-call
      // budget across replicas.
      "aiDiagnosticsAdmin",
      "aiDiagnosticsIp",
      "aiDiagnosticsGlobal",
      // Member-guest consent answers (#2307): the endpoint returns one uniform
      // 403 for every failure, so volume is the only probe — a degraded
      // shared-store fallback must not multiply that allowance.
      "memberGuestConsentRespond",
      // Member whole-lodge request (#2263): the submission door for asking the
      // club to sterilise every bed in the lodge. Marked auth-sensitive so a
      // degraded shared-store fallback TIGHTENS the budget rather than letting
      // one member (or one address) multiply their allowance across replicas.
      // Its sibling `memberWholeLodgeWithdraw` is deliberately NOT marked: a
      // member cancelling their own request holds nothing and reveals nothing.
      "memberWholeLodgeRequest",
      // Maintenance reports (#2780): the two doors a non-member (QR) submission
      // travels through. `maintenanceReportAnonymous` is the unauthenticated
      // submit budget and `maintenanceReportToken` the per-token read budget on
      // the same public surface — both return one uniform failure, so volume is
      // the only probe and a degraded shared-store fallback must TIGHTEN rather
      // than multiply the allowance. The member submit limiter
      // `maintenanceReportMember` is deliberately NOT marked: it sits behind a
      // session, so it is not a credential-guessing or public-form surface.
      "maintenanceReportAnonymous",
      "maintenanceReportToken",
      // Per-account email request limits (#4613): the account half of the
      // forgot-password and sign-in-link doors, keyed by checkAccountRequestLimit.
      // Marked so a degraded fallback tightens the per-account budget (#1142)
      // rather than letting many addresses multiply it across replicas.
      "forgotPasswordAccount",
      "magicLinkRequestAccount",
    ].sort();

    const marked = Object.entries(rateLimiters)
      .filter(([, config]) => (config as { authSensitive?: boolean }).authSensitive)
      .map(([name]) => name)
      .sort();

    expect(marked).toEqual(expected);
  });
});

// MG3 (#2308) / #2388 — the authenticated-surface limiter.
//
// `applyRateLimit` keys on the client IP alone, which is wrong for an
// authenticated enumeration surface in BOTH directions: one household behind a
// NAT shares a budget, and one member can rotate addresses for a fresh one.
// These tests pin that both keys are consulted, that they are namespaced, and
// that the IP is checked first.
describe("applyMemberScopedRateLimit (#2308)", () => {
  const config: RateLimitConfig = {
    id: "member-scoped-test",
    limit: 2,
    windowSeconds: 60,
  };

  beforeEach(() => {
    _testStore.clear();
    mockQueryRaw.mockReset();
    // Reject the shared store so the deterministic per-process limiter runs;
    // the two-key behaviour under test is identical either way.
    mockQueryRaw.mockRejectedValue(new Error("connection refused"));
  });

  function request(ip: string) {
    return new Request("https://club.example/api/members/guest-candidates/search", {
      headers: { "x-forwarded-for": ip },
    });
  }

  it("spends the MEMBER budget even when the address keeps changing", async () => {
    // The same member from four different addresses. Per-IP limiting alone would
    // wave all of them through; this is the hole that matters for enumeration.
    const results = [];
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"]) {
      results.push(
        await applyMemberScopedRateLimit(config, request(ip), "m-prober"),
      );
    }
    expect(results.filter((result) => result === null).length).toBeGreaterThanOrEqual(1);
    expect(results[results.length - 1]?.status).toBe(429);
  });

  // REWRITTEN by the privacy review (finding M1). This test used to assert that
  // four members behind one address exhausted a budget of two — which is exactly
  // the NAT lock-out the function's own docblock claimed it had closed, and which
  // per-IP-only limiting already had. The behaviour deliberately changed: the
  // MEMBER key is the control, and the shared-IP key is a much larger backstop.
  it("does not lock out a household NAT, but still bounds one address", async () => {
    const members = Array.from({ length: 30 }, (_, i) => `m-${i}`);
    const results = [];
    for (const memberId of members) {
      results.push(
        await applyMemberScopedRateLimit(config, request("203.0.113.9"), memberId),
      );
    }
    // Ten honest members on one wifi, one request each, all served — under the
    // old rule the third one was refused.
    expect(results.slice(0, 10).every((result) => result === null)).toBe(true);
    // The IP key is still finite: `limit * MEMBER_SCOPED_IP_LIMIT_MULTIPLIER`.
    const served = results.filter((result) => result === null).length;
    expect(served).toBe(config.limit * MEMBER_SCOPED_IP_LIMIT_MULTIPLIER);
    expect(results[results.length - 1]?.status).toBe(429);
  });

  it("keeps the shared-IP counter under the SAME limiter id, only judged differently", async () => {
    await applyMemberScopedRateLimit(config, request("203.0.113.12"), "m-y");
    expect([..._testStore.keys()]).toContain(`${config.id}:ip:203.0.113.12`);
  });

  it("namespaces the two keys so a member id cannot collide with an address", async () => {
    // A member whose id is literally another caller's IP string must not share
    // that caller's budget.
    await applyMemberScopedRateLimit(config, request("203.0.113.10"), "203.0.113.10");
    const keys = [..._testStore.keys()];
    expect(keys).toContain(`${config.id}:ip:203.0.113.10`);
    expect(keys).toContain(`${config.id}:member:203.0.113.10`);
  });

  it("returns a 429 carrying the standard rate-limit headers", async () => {
    const spend = async () =>
      applyMemberScopedRateLimit(config, request("203.0.113.11"), "m-x");
    await spend();
    await spend();
    // The per-process fallback runs at a quarter of the limit for authSensitive
    // configs only; this config is not, so the third call is the one refused.
    const denied = (await spend()) ?? (await spend());
    expect(denied?.status).toBe(429);
    expect(denied?.headers.get("Retry-After")).toBeTruthy();
    expect(denied?.headers.get("X-RateLimit-Remaining")).toBe("0");
  });
});

// The two harvest-cost claims the privacy review found overstated (finding M2),
// and the daily backstop it found missing on the default-on mode (M3). These are
// arithmetic assertions on the shipped numbers, so a later "tidy-up" of a limiter
// cannot quietly make a docblock's honesty claim false again.
describe("member-guest limiter sizing is honest (#2308 M2/M3)", () => {
  it("gives the DEFAULT-ON email resolve a daily cap no larger than the opt-in search's", () => {
    // Without a daily cap, 20 per 15 minutes is 1,920 lookups a day — nearly five
    // times the budget of the mode the owner accepted as browsable.
    expect(rateLimiters.memberGuestResolveDaily).toBeDefined();
    expect(rateLimiters.memberGuestResolveDaily.windowSeconds).toBe(24 * 60 * 60);
    expect(rateLimiters.memberGuestResolveDaily.limit).toBeLessThanOrEqual(
      rateLimiters.memberGuestSearchDaily.limit,
    );
    const burstPerDay =
      rateLimiters.memberGuestResolve.limit *
      ((24 * 60 * 60) / rateLimiters.memberGuestResolve.windowSeconds);
    expect(rateLimiters.memberGuestResolveDaily.limit).toBeLessThan(burstPerDay);
  });

  it("does not let the add-probe cap be described as making a season take weeks", () => {
    // ~150 nights in a lodge season. At 50 a day that is about three days, not
    // three weeks — the figure the docblock used to claim. The cap is still worth
    // having (it turns a scripted afternoon into days of logged work), but the
    // arithmetic has to be stated truthfully.
    const SEASON_NIGHTS = 150;
    const daysToMapASeason =
      SEASON_NIGHTS / rateLimiters.memberGuestAddProbeDaily.limit;
    expect(daysToMapASeason).toBeLessThan(7);
  });
});
