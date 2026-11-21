/**
 * ALP-653 (`INV-MCP-005`): a route limiter counts an AI app's loopback call
 * per connection, not per address.
 *
 * `/api/mcp` forwards the AI provider's address in `x-forwarded-for`, and every
 * member using that provider shares its few addresses. Keyed by address, one
 * club's members would spend each other's `bookingCreate` budget. Only a
 * principal header that verifies (signed, in date, in flight) changes the key;
 * a forged or released one is counted by address as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { secretHolder } = vi.hoisted(() => ({
  // Built at run time so no secret-shaped literal sits in the file (.gitleaks.toml).
  secretHolder: { value: "r".repeat(40) as string | undefined },
}));

vi.mock("@/lib/runtime-config", () => ({
  getAuthSecret: vi.fn(() => secretHolder.value),
  requireAuthSecret: vi.fn((message?: string) => {
    if (!secretHolder.value) throw new Error(message ?? "no secret");
    return secretHolder.value;
  }),
  getAuthTrustHost: vi.fn(() => true),
}));

// The shared store is scripted to fail so the per-process counters decide,
// which the test can clear between cases.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn().mockRejectedValue(new Error("no database in this test")),
    $executeRaw: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { issueMcpPrincipal, MCP_PRINCIPAL_HEADER } from "../mcp/principal";
import {
  _testStore,
  applyMemberScopedRateLimit,
  applyRateLimit,
  type RateLimitConfig,
} from "../rate-limit";
import { rateLimitSubject } from "../rate-limit-subject";

const PROVIDER_ADDRESS = "203.0.113.50";
const config: RateLimitConfig = { id: "mcp-subject-test", limit: 2, windowSeconds: 60 };

function loopbackRequest(principal: string | null): Request {
  const headers: Record<string, string> = { "x-forwarded-for": PROVIDER_ADDRESS };
  if (principal !== null) headers[MCP_PRINCIPAL_HEADER] = principal;
  return new Request("http://127.0.0.1/api/bookings", { method: "POST", headers });
}

describe("route limiters on an AI app loopback call", () => {
  beforeEach(() => {
    _testStore.clear();
    secretHolder.value = "r".repeat(40);
  });

  it("keys a verified loopback call by its connection", () => {
    const principal = issueMcpPrincipal("grant-a", Date.now());
    try {
      expect(rateLimitSubject(loopbackRequest(principal.value))).toBe("mcp:grant-a");
    } finally {
      principal.release();
    }
  });

  it("does not let two connections behind one provider address share a budget", async () => {
    const a = issueMcpPrincipal("grant-a", Date.now());
    const b = issueMcpPrincipal("grant-b", Date.now());
    try {
      expect(await applyRateLimit(config, loopbackRequest(a.value))).toBeNull();
      expect(await applyRateLimit(config, loopbackRequest(a.value))).toBeNull();
      // Connection A has spent its budget...
      expect((await applyRateLimit(config, loopbackRequest(a.value)))?.status).toBe(429);
      // ...and connection B, from the same address, still has all of its own.
      expect(await applyRateLimit(config, loopbackRequest(b.value))).toBeNull();
      expect(await applyRateLimit(config, loopbackRequest(b.value))).toBeNull();
      // A browser request from that address was never charged for either.
      expect(await applyRateLimit(config, loopbackRequest(null))).toBeNull();
    } finally {
      a.release();
      b.release();
    }
  });

  it("counts a released (replayed) header by address, sharing the browser budget", async () => {
    const principal = issueMcpPrincipal("grant-a", Date.now());
    principal.release();
    expect(rateLimitSubject(loopbackRequest(principal.value))).toBe(PROVIDER_ADDRESS);

    expect(await applyRateLimit(config, loopbackRequest(null))).toBeNull();
    expect(await applyRateLimit(config, loopbackRequest(principal.value))).toBeNull();
    expect((await applyRateLimit(config, loopbackRequest(null)))?.status).toBe(429);
  });

  it("counts a forged header by address", () => {
    const principal = issueMcpPrincipal("grant-a", Date.now());
    try {
      const [part] = principal.value.split(".");
      const forged = `${part}.${"A".repeat(43)}`;
      expect(rateLimitSubject(loopbackRequest(forged))).toBe(PROVIDER_ADDRESS);
      expect(rateLimitSubject(loopbackRequest("not-a-principal"))).toBe(PROVIDER_ADDRESS);
    } finally {
      principal.release();
    }
  });

  it("falls back to the address when no auth secret is configured", () => {
    const principal = issueMcpPrincipal("grant-a", Date.now());
    try {
      secretHolder.value = undefined;
      expect(rateLimitSubject(loopbackRequest(principal.value))).toBe(PROVIDER_ADDRESS);
    } finally {
      principal.release();
    }
  });

  it("keys the shared-address backstop of a member-scoped limiter by connection too", async () => {
    const backstop: RateLimitConfig = { id: "mcp-subject-member", limit: 1, windowSeconds: 60 };
    const a = issueMcpPrincipal("grant-a", Date.now());
    const b = issueMcpPrincipal("grant-b", Date.now());
    try {
      // Ten members' worth of calls through connection A spends A's backstop only.
      for (let i = 0; i < 10; i += 1) {
        await applyMemberScopedRateLimit(backstop, loopbackRequest(a.value), `m-a-${i}`);
      }
      expect(
        (await applyMemberScopedRateLimit(backstop, loopbackRequest(a.value), "m-a-new"))?.status,
      ).toBe(429);
      expect(await applyMemberScopedRateLimit(backstop, loopbackRequest(b.value), "m-b")).toBeNull();
    } finally {
      a.release();
      b.release();
    }
  });
});

/**
 * Every route an action calls limits through the keyed helpers or by member,
 * never by a bare address. A limiter keyed on `getClientIp` directly would
 * count every member behind one AI provider together again. The address is
 * still read for audit rows (`cancelBooking`'s ip argument); only a limiter's
 * key is checked here.
 */
describe("the routes AI app actions call", () => {
  it("never key a limiter on the bare client address", async () => {
    const { readFileSync } = await import("node:fs");
    const { MCP_ACTIONS, mcpActionRouteFile } = await import("../mcp/catalogue");
    const files = [...new Set(MCP_ACTIONS.map(mcpActionRouteFile))];
    expect(files.length).toBeGreaterThan(5);
    const limitedByHelper: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // A `checkRateLimit(config, key)` call whose key reads the address.
      expect(source, file).not.toMatch(/checkRateLimit\([^;]*getClientIp/s);
      expect(source, file).not.toMatch(/checkRateLimitInMemory\(/);
      if (/applyRateLimit\(|applyMemberScopedRateLimit\(/.test(source)) limitedByHelper.push(file);
    }
    // The two the review named (#5286): bookingCreate and bookingQuery.
    expect(limitedByHelper).toEqual(
      expect.arrayContaining(["src/app/api/availability/route.ts", "src/app/api/bookings/route.ts"]),
    );
  });
});
