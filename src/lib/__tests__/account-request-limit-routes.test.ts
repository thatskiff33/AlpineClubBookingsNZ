/**
 * #4613 (INV-AUTH-005): per-account limits on the forgot-password and
 * sign-in-link request routes, driven through the REAL limiter stack —
 * `applyRateLimit`, `checkAccountRequestLimit`, `checkRateLimit` and its #1142
 * fallback — against a scripted `RateLimitCounter` upsert. Only Prisma, the
 * mailer, the auth secret and the module/login settings are faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  /** The shared counter table, as the atomic upsert in rate-limit.ts leaves it. */
  const counters = new Map<string, { count: number; resetAt: Date }>();
  const state = { storeDown: false };
  const queryRaw = vi.fn(
    async (_sql: TemplateStringsArray, id: string, newResetAt: Date, now: Date) => {
      if (state.storeDown) throw new Error("connect ECONNREFUSED");
      const row = counters.get(id);
      if (!row || row.resetAt <= now) {
        counters.set(id, { count: 1, resetAt: newResetAt });
      } else {
        row.count += 1;
      }
      const current = counters.get(id)!;
      return [{ count: current.count, resetAt: current.resetAt }];
    },
  );
  return {
    counters,
    state,
    queryRaw,
    findFirst: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendMagicLinkEmail: vi.fn(),
    getAuthSecret: vi.fn<() => string | undefined>(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    $executeRaw: vi.fn().mockResolvedValue(0),
    member: { findFirst: h.findFirst },
    passwordResetToken: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: "token-1" }),
    },
    magicLinkToken: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: "token-1" }),
    },
  },
}));
vi.mock("@/lib/email", () => ({
  sendPasswordResetEmail: h.sendPasswordResetEmail,
  sendMagicLinkEmail: h.sendMagicLinkEmail,
}));
vi.mock("@/lib/runtime-config", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/runtime-config")),
  getAuthSecret: h.getAuthSecret,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn().mockResolvedValue({ magicLink: true }),
}));
vi.mock("@/lib/login-security-settings", () => ({
  loadLoginSecuritySettings: vi
    .fn()
    .mockResolvedValue({ policy: { magicLinkTtlMinutes: 15 } }),
}));
vi.mock("@/lib/logger", () => ({ default: h.logger }));

import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as magicLink } from "@/app/api/auth/magic-link/route";
import { checkAccountRequestLimit } from "@/lib/account-request-limit";
import { loginAccountKey } from "@/lib/login-throttle";
import { _testStore, rateLimiters } from "@/lib/rate-limit";

const EMAIL = "member@example.com";
const UNKNOWN_EMAIL = "nobody@example.com";
const ACCOUNT_LIMIT = 3;

const routes = [
  {
    name: "forgot-password",
    post: forgotPassword,
    path: "/api/auth/forgot-password",
    send: h.sendPasswordResetEmail,
    limiter: rateLimiters.forgotPasswordAccount,
  },
  {
    name: "magic-link",
    post: magicLink,
    path: "/api/auth/magic-link",
    send: h.sendMagicLinkEmail,
    limiter: rateLimiters.magicLinkRequestAccount,
  },
] as const;

type Route = (typeof routes)[number];

/** One request from its own internet address, so the per-address limit never bites. */
let nextAddress = 0;
function request(route: Route, email: string, address = `198.51.100.${++nextAddress}`) {
  return route.post(
    new NextRequest(`http://localhost${route.path}`, {
      method: "POST",
      body: JSON.stringify({ email }),
      headers: { "content-type": "application/json", "x-forwarded-for": address },
    }),
  );
}

/** Everything a caller can observe about one response. */
async function observe(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()],
    body: await response.text(),
  };
}

const member = {
  id: "member-1",
  email: EMAIL,
  active: true,
  emailVerified: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.counters.clear();
  h.state.storeDown = false;
  _testStore.clear();
  h.getAuthSecret.mockReturnValue("test-secret");
  h.sendPasswordResetEmail.mockResolvedValue(undefined);
  h.sendMagicLinkEmail.mockResolvedValue(undefined);
  h.findFirst.mockImplementation(async ({ where }: { where: { email: string } }) =>
    where.email === EMAIL ? member : null,
  );
});

it("sizes both per-account limits at three an hour, auth-sensitive", () => {
  for (const route of routes) {
    expect(route.limiter).toMatchObject({
      limit: ACCOUNT_LIMIT,
      windowSeconds: 60 * 60,
      authSensitive: true,
    });
  }
});

describe.each(routes)("$name: per-account request limit (#4613)", (route) => {
  it("stops emailing one account requested from many addresses past the limit", async () => {
    const answers = [];
    for (let i = 0; i < 10; i += 1) answers.push(await observe(await request(route, EMAIL)));

    // Every request is answered as accepted; only the first three send.
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toEqual({ success: true });
    }
    expect(route.send).toHaveBeenCalledTimes(ACCOUNT_LIMIT);
    // A limited request decides before any Member read.
    expect(h.findFirst).toHaveBeenCalledTimes(ACCOUNT_LIMIT);
  });

  it("counts every spelling the member lookup matches against one account", async () => {
    for (const spelling of [EMAIL, "MEMBER@example.com", "Member@Example.COM", "member@EXAMPLE.com"]) {
      await request(route, spelling);
    }
    expect(route.send).toHaveBeenCalledTimes(ACCOUNT_LIMIT);
  });

  it("stores the account's HMAC, never its address", async () => {
    await request(route, "Member@Example.com");

    expect([...h.counters.keys()]).toContain(`${route.limiter.id}:account:${loginAccountKey(EMAIL)}`);
    const everything = JSON.stringify([
      [...h.counters.keys()],
      h.queryRaw.mock.calls,
      Object.values(h.logger).map((fn) => fn.mock.calls),
    ]).toLowerCase();
    expect(everything).not.toContain("example.com");
  });

  it("answers a real and an unknown account identically, under and over the limit", async () => {
    const real = [];
    for (let i = 0; i < 5; i += 1) real.push(await observe(await request(route, EMAIL)));
    const realLookups = h.findFirst.mock.calls.length;

    h.counters.clear();
    const unknown = [];
    for (let i = 0; i < 5; i += 1) unknown.push(await observe(await request(route, UNKNOWN_EMAIL)));

    // Not vacuous: the real account was emailed, the unknown one never was,
    // and both were counted and limited after the same number of requests.
    expect(route.send).toHaveBeenCalledTimes(ACCOUNT_LIMIT);
    expect(realLookups).toBe(ACCOUNT_LIMIT);
    expect(h.findFirst).toHaveBeenCalledTimes(2 * ACCOUNT_LIMIT);
    expect(h.counters.get(`${route.limiter.id}:account:${loginAccountKey(UNKNOWN_EMAIL)}`)?.count).toBe(5);

    expect(unknown).toEqual(real);
  });

  it("falls back to the #1142 per-process count when the store is down, never refusing", async () => {
    h.state.storeDown = true;

    const answers = [];
    for (let i = 0; i < 4; i += 1) answers.push(await observe(await request(route, EMAIL)));

    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toEqual({ success: true });
    }
    // The degraded budget: max(1, floor(3 / DEGRADED_AUTH_LIMIT_DIVISOR)) = 1.
    expect(route.send).toHaveBeenCalledTimes(1);
    expect(h.counters.size).toBe(0);
  });

  it("still applies the per-address limit first", async () => {
    const address = "203.0.113.9";
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await request(route, `user${i}@example.org`, address)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe("checkAccountRequestLimit without an auth secret", () => {
  it("counts in this process at the degraded budget and never writes an unkeyed digest to the store", async () => {
    h.getAuthSecret.mockReturnValue(undefined);
    const config = rateLimiters.forgotPasswordAccount;

    const first = await checkAccountRequestLimit(config, EMAIL);
    const second = await checkAccountRequestLimit(config, "Member@Example.com");

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect([..._testStore.keys()].join()).not.toContain("example.com");
  });
});
