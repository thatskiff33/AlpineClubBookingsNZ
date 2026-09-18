import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the Xero client infrastructure is stubbed, so the LIVE branch of
// getXeroConnectedOrganisation (short-code normalisation, negative caching,
// single flight) runs for real. Every other case in this file drives the
// mock-Xero origin instead and never reaches these.
const live = vi.hoisted(() => ({
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  getOrganisations: vi.fn(),
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: live.getAuthenticatedXeroClient,
  callXeroApi: (fn: () => unknown, options: unknown) =>
    live.callXeroApi(fn, options),
}));
vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import type { MeteredXeroCallOptions } from "@/lib/xero-api-client";
import {
  getXeroConnectedOrganisation,
  getXeroFinancialYearEndMonth,
  getXeroLockDates,
  resetXeroOrganisationCachesForTests,
} from "@/lib/xero-organisation";
import { invalidateXeroOrganisationCaches } from "@/lib/xero-organisation-cache-bus";

// CORRECTNESS-F1: the connected-org summary is cached in-process for hours. A
// disconnect → reconnect to a DIFFERENT org must not keep serving the OLD org's
// name (the exact mistake the wizard's right-org step exists to catch). The
// token store invalidates the cache via the bus; these pins prove the cache is
// honoured AND that invalidation forces a fresh read of the new org.
describe("xero-organisation cache invalidation (#2080 F1)", () => {
  const originalOrigin = process.env.XERO_MOCK_API_ORIGIN;

  function mockOrg(name: string, shortCode?: string | null) {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ name, financialYearEndMonth: 3, shortCode }),
    })) as unknown as typeof fetch;
  }

  beforeEach(() => {
    // Drive the mock-Xero organisation path (no live Xero / DB), non-production.
    vi.stubEnv("NODE_ENV", "test");
    process.env.XERO_MOCK_API_ORIGIN = "http://localhost:3000";
    resetXeroOrganisationCachesForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetXeroOrganisationCachesForTests();
    if (originalOrigin === undefined) delete process.env.XERO_MOCK_API_ORIGIN;
    else process.env.XERO_MOCK_API_ORIGIN = originalOrigin;
  });

  it("serves the cached org name until the cache is invalidated", async () => {
    mockOrg("Org A");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");

    // The org changed underneath, but without invalidation the cache still wins.
    mockOrg("Org B");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");
  });

  it("returns the NEW org name after a reconnect invalidates the cache", async () => {
    mockOrg("Org A");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");

    // Simulate the token store's reconnect-to-different-org invalidation.
    mockOrg("Org B");
    invalidateXeroOrganisationCaches();

    expect((await getXeroConnectedOrganisation()).name).toBe("Org B");
  });

  it("forceRefresh also bypasses the cache (belt-and-braces / ?refresh=1)", async () => {
    mockOrg("Org A");
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");

    mockOrg("Org B");
    expect((await getXeroConnectedOrganisation(true)).name).toBe("Org B");
  });

  // #2261: the deep-link short code rides on the SAME cached summary, so it
  // must be cached and invalidated exactly like the name — a reconnect to a
  // different org must never keep pointing "Go to Xero" at the old org.
  describe("organisation short code (#2261)", () => {
    it("returns the short code when Xero reports one", async () => {
      mockOrg("Org A", "!aBc12");
      expect((await getXeroConnectedOrganisation()).shortCode).toBe("!aBc12");
    });

    it("is null when the short code is absent, blank, or not a string", async () => {
      mockOrg("Org A", undefined);
      expect((await getXeroConnectedOrganisation()).shortCode).toBeNull();

      resetXeroOrganisationCachesForTests();
      mockOrg("Org A", "   ");
      expect((await getXeroConnectedOrganisation()).shortCode).toBeNull();

      resetXeroOrganisationCachesForTests();
      global.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          name: "Org A",
          financialYearEndMonth: 3,
          shortCode: 42,
        }),
      })) as unknown as typeof fetch;
      expect((await getXeroConnectedOrganisation()).shortCode).toBeNull();
    });

    it("trims surrounding whitespace", async () => {
      mockOrg("Org A", "  !aBc12  ");
      expect((await getXeroConnectedOrganisation()).shortCode).toBe("!aBc12");
    });

    it("caches the short code and re-reads it after invalidation", async () => {
      mockOrg("Org A", "!orgA1");
      expect((await getXeroConnectedOrganisation()).shortCode).toBe("!orgA1");

      // Cached: the new org's short code is not picked up until invalidation.
      mockOrg("Org B", "!orgB2");
      expect((await getXeroConnectedOrganisation()).shortCode).toBe("!orgA1");

      invalidateXeroOrganisationCaches();
      const summary = await getXeroConnectedOrganisation();
      expect(summary.shortCode).toBe("!orgB2");
      expect(summary.name).toBe("Org B");
    });

    it("degrades to nulls when the organisation read fails with no cache", async () => {
      global.fetch = vi.fn(async () => ({
        ok: false,
        json: async () => ({}),
      })) as unknown as typeof fetch;

      const summary = await getXeroConnectedOrganisation();
      expect(summary.shortCode).toBeNull();
      expect(summary.name).toBeNull();
      expect(summary.financialYearEndMonth).toBeNull();
    });
  });

  // #2261 review F1 (mock-path parity): the mock path used to cache a failed
  // read as if it had SUCCEEDED (12 hours of nulls), which is why no E2E could
  // ever have caught the live path caching nothing at all. Both paths must now
  // land on the same short negative TTL.
  it("negative-caches a FAILED mock read for a minute, then re-attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect((await getXeroConnectedOrganisation()).name).toBeNull();
    expect((await getXeroConnectedOrganisation()).name).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + 61_000));
    expect((await getXeroConnectedOrganisation()).name).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// #2261 review: the LIVE branch (no mock origin) — its short-code read had no
// coverage at all, and a failing-but-present Xero connection re-attempted a
// live call on EVERY request because failures were never cached.
// ---------------------------------------------------------------------------
describe("connected-organisation summary: live read (#2261 review F1/F2)", () => {
  const originalOrigin = process.env.XERO_MOCK_API_ORIGIN;
  const originalInternalOrigin = process.env.XERO_MOCK_INTERNAL_ORIGIN;

  function stubLiveOrg(org: Record<string, unknown> | undefined) {
    live.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getOrganisations: live.getOrganisations } },
      tenantId: "tenant-1",
    });
    live.callXeroApi.mockImplementation(async (fn: () => Promise<unknown>) =>
      fn(),
    );
    live.getOrganisations.mockResolvedValue({
      body: { organisations: org ? [org] : [] },
    });
  }

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    // No mock origin: force the real getOrganisations code path.
    delete process.env.XERO_MOCK_API_ORIGIN;
    delete process.env.XERO_MOCK_INTERNAL_ORIGIN;
    vi.clearAllMocks();
    resetXeroOrganisationCachesForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetXeroOrganisationCachesForTests();
    if (originalOrigin === undefined) delete process.env.XERO_MOCK_API_ORIGIN;
    else process.env.XERO_MOCK_API_ORIGIN = originalOrigin;
    if (originalInternalOrigin === undefined)
      delete process.env.XERO_MOCK_INTERNAL_ORIGIN;
    else process.env.XERO_MOCK_INTERNAL_ORIGIN = originalInternalOrigin;
  });

  it("reads name, year-end month and a trimmed short code from Xero", async () => {
    stubLiveOrg({
      name: "Live Org",
      financialYearEndMonth: 3,
      shortCode: "  !live1  ",
    });

    await expect(getXeroConnectedOrganisation()).resolves.toEqual({
      name: "Live Org",
      financialYearEndMonth: 3,
      shortCode: "!live1",
      readFailure: null,
    });
    expect(live.getOrganisations).toHaveBeenCalledTimes(1);
  });

  it("returns a null short code when the live organisation has none", async () => {
    stubLiveOrg({ name: "Live Org", financialYearEndMonth: 13 });

    const summary = await getXeroConnectedOrganisation();
    expect(summary.name).toBe("Live Org");
    expect(summary.shortCode).toBeNull();
    // 13 is out of range, so the month degrades to null too.
    expect(summary.financialYearEndMonth).toBeNull();
  });

  it("returns nulls when Xero reports no organisation at all", async () => {
    stubLiveOrg(undefined);

    await expect(getXeroConnectedOrganisation()).resolves.toEqual({
      name: null,
      financialYearEndMonth: null,
      shortCode: null,
      // The read SUCCEEDED — Xero simply reported no organisation. That is a
      // different thing from a failed read, and #2394 turns on the difference.
      readFailure: null,
    });
  });

  it("does not retry: a page-decoration read must not wait out a 429", async () => {
    stubLiveOrg({ name: "Live Org", shortCode: "!live1" });

    await getXeroConnectedOrganisation();

    expect(live.callXeroApi).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        operation: "getOrganisations",
        maxRetries: 0,
      }),
    );
  });

  // #2394 review, F2. This read sits behind an operator-facing Try again button
  // that is rendered precisely when Xero is 5xx-ing, so the two options are one
  // decision. `maxTransientRetries: 1` would spend TWO Xero calls per press and,
  // on exhausting the budget, arm `rememberXeroTransientOutage` — the
  // process-global breaker that fails every Xero call (invoicing, sync, webhook
  // replay) for two minutes. `maxTransientRetries: 0` alone is worse: the very
  // first 5xx arms it. So: no transient retry, and an explicit opt-out of
  // arming the breaker at all. A page decoration must not be able to stop
  // invoicing, however often a human presses.
  it("spends one call per read and can never arm the global outage breaker", async () => {
    stubLiveOrg({ name: "Live Org", shortCode: "!live1" });

    await getXeroConnectedOrganisation();

    expect(live.callXeroApi).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxTransientRetries: 0,
        armTransientBreaker: false,
      }),
    );
  });

  // The reconnect (generation) guard. A read that started BEFORE a
  // connect/disconnect describes the OLD organisation, so it must not write
  // itself into the freshly cleared cache — otherwise the next admin would be
  // deep-linked into a PREVIOUS company's books, which is the whole reason the
  // deep link is short-code-scoped in the first place.
  it("drops a read that started before a reconnect instead of caching the old org", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    live.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getOrganisations: live.getOrganisations } },
      tenantId: "tenant-1",
    });
    live.callXeroApi.mockImplementation(async (fn: () => Promise<unknown>) =>
      fn(),
    );
    live.getOrganisations.mockImplementation(async () => {
      await gate;
      return {
        body: { organisations: [{ name: "Old Org", shortCode: "!oldOrg" }] },
      };
    });

    // A read is in flight against the OLD connection...
    const inFlight = getXeroConnectedOrganisation();
    // ...when the admin reconnects to a different Xero organisation.
    invalidateXeroOrganisationCaches();
    release?.();

    // Its own caller is still served (see the known residual documented on
    // useXeroOrgShortCode) — the guard bounds the CACHE, not this value.
    expect((await inFlight).shortCode).toBe("!oldOrg");
    expect(live.getOrganisations).toHaveBeenCalledTimes(1);

    // The next caller must go live again and see the NEW organisation: nothing
    // from the abandoned read may have landed in the cleared cache.
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ name: "New Org", shortCode: "!newOrg" }] },
    });

    const after = await getXeroConnectedOrganisation();
    expect(live.getOrganisations).toHaveBeenCalledTimes(2);
    expect(after.shortCode).toBe("!newOrg");
    expect(after.name).toBe("New Org");
  });

  // F1: the bug. A present-but-failing connection (revoked refresh token,
  // org read 500, per-minute 429) cached nothing, so an admin reloading
  // /admin/xero re-attempted a live Xero call on every single request.
  it("caches a FAILED read for a minute instead of re-calling Xero per request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    live.getAuthenticatedXeroClient.mockRejectedValue(
      new Error("invalid_grant"),
    );

    await expect(getXeroConnectedOrganisation()).resolves.toEqual({
      name: null,
      financialYearEndMonth: null,
      shortCode: null,
      // A bare `invalid_grant` Error carries no status and no known error
      // name, so it classifies as the generic "try again" case (#2394).
      readFailure: {
        kind: "unavailable",
        rateLimit: null,
        retryAfterSeconds: null,
      },
    });
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(1);

    // Reload, reload, reload: still exactly one live attempt.
    await getXeroConnectedOrganisation();
    await getXeroConnectedOrganisation();
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(1);

    // Past the negative TTL the next caller does try again.
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await getXeroConnectedOrganisation();
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(2);
  });

  it("lets a later success replace the negative entry and restore the long TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    live.getAuthenticatedXeroClient.mockRejectedValue(new Error("boom"));

    expect((await getXeroConnectedOrganisation()).name).toBeNull();

    vi.setSystemTime(new Date(Date.now() + 61_000));
    stubLiveOrg({ name: "Back Online", shortCode: "!back1" });

    const recovered = await getXeroConnectedOrganisation();
    expect(recovered.name).toBe("Back Online");
    expect(recovered.shortCode).toBe("!back1");
    expect(live.getOrganisations).toHaveBeenCalledTimes(1);

    // The success is cached for the LONG TTL: a minute later, no new call.
    vi.setSystemTime(new Date(Date.now() + 61_000));
    expect((await getXeroConnectedOrganisation()).name).toBe("Back Online");
    expect(live.getOrganisations).toHaveBeenCalledTimes(1);
  });

  it("clears a negative entry on connect/disconnect invalidation", async () => {
    live.getAuthenticatedXeroClient.mockRejectedValue(new Error("boom"));
    expect((await getXeroConnectedOrganisation()).name).toBeNull();
    expect((await getXeroConnectedOrganisation()).name).toBeNull();
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(1);

    // The admin re-enters credentials: the reconnect must not wait out the
    // negative TTL before the org (and its deep links) come back.
    stubLiveOrg({ name: "Org After Reconnect", shortCode: "!new1" });
    invalidateXeroOrganisationCaches();

    const summary = await getXeroConnectedOrganisation();
    expect(summary.name).toBe("Org After Reconnect");
    expect(summary.shortCode).toBe("!new1");
  });

  // F2: N concurrent cold-cache callers must share ONE underlying read.
  it("shares a single in-flight read across concurrent cold-cache callers", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    live.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getOrganisations: live.getOrganisations } },
      tenantId: "tenant-1",
    });
    live.callXeroApi.mockImplementation(async (fn: () => Promise<unknown>) =>
      fn(),
    );
    live.getOrganisations.mockImplementation(async () => {
      await gate;
      return {
        body: { organisations: [{ name: "Org A", shortCode: "!orgA1" }] },
      };
    });

    const inFlight = Promise.all(
      Array.from({ length: 5 }, () => getXeroConnectedOrganisation()),
    );
    release?.();
    const results = await inFlight;

    expect(live.getOrganisations).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.shortCode)).toEqual(Array(5).fill("!orgA1"));

    // The shared promise is released afterwards, so a later cold call still works.
    invalidateXeroOrganisationCaches();
    expect((await getXeroConnectedOrganisation()).name).toBe("Org A");
    expect(live.getOrganisations).toHaveBeenCalledTimes(2);
  });

  it("shares one read even while Xero is failing (no stampede on a cold cache)", async () => {
    live.getAuthenticatedXeroClient.mockRejectedValue(new Error("boom"));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => getXeroConnectedOrganisation()),
    );

    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.name === null)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // #2394: a failed read now says WHY, in the three shapes an operator acts on
  // differently. Before this the summary degraded to nulls indistinguishable
  // from "Xero has no name for you", and the setup wizard could only sit on
  // "Confirming the organisation name…" for ever.
  // -------------------------------------------------------------------------
  it("classifies a revoked/unusable authorisation as 'disconnected'", async () => {
    const err = new Error("Xero is not connected. Please connect via admin panel.");
    err.name = "XeroReconnectRequiredError";
    live.getAuthenticatedXeroClient.mockRejectedValue(err);

    expect((await getXeroConnectedOrganisation()).readFailure).toEqual({
      kind: "disconnected",
      rateLimit: null,
      retryAfterSeconds: null,
    });
  });

  it("classifies a token that no longer decrypts as 'disconnected' too", async () => {
    const err = new Error("stored Xero token could not be decrypted");
    err.name = "XeroTokenDecryptError";
    live.getAuthenticatedXeroClient.mockRejectedValue(err);

    expect((await getXeroConnectedOrganisation()).readFailure?.kind).toBe(
      "disconnected",
    );
  });

  it("classifies a live 401 as 'disconnected', not as a transient blip", async () => {
    // The token was revoked in Xero's own UI, so it arrives as a raw API error
    // rather than a reconnect-classed one.
    stubLiveOrg({ name: "Live Org" });
    live.callXeroApi.mockRejectedValue({ response: { statusCode: 401 } });

    expect((await getXeroConnectedOrganisation()).readFailure?.kind).toBe(
      "disconnected",
    );
  });

  it("classifies the daily-limit error, with its own retry-after", async () => {
    const err = new Error("Xero daily API limit reached.") as Error & {
      retryAfterSec: number;
    };
    err.name = "XeroDailyLimitError";
    err.retryAfterSec = 7200;
    live.getAuthenticatedXeroClient.mockRejectedValue(err);

    expect((await getXeroConnectedOrganisation()).readFailure).toEqual({
      kind: "rate_limited",
      rateLimit: "day",
      retryAfterSeconds: 7200,
    });
  });

  it("reads the limit scope and Retry-After off a live 429", async () => {
    stubLiveOrg({ name: "Live Org" });
    live.callXeroApi.mockRejectedValue({
      response: {
        statusCode: 429,
        headers: { "x-rate-limit-problem": "minute", "retry-after": "37" },
      },
    });

    expect((await getXeroConnectedOrganisation()).readFailure).toEqual({
      kind: "rate_limited",
      rateLimit: "minute",
      retryAfterSeconds: 37,
    });
  });

  it("classifies the process-global transient breaker as 'unavailable' with a wait", async () => {
    const err = new Error("Xero is temporarily unavailable.") as Error & {
      retryAfterSec: number;
    };
    err.name = "XeroTransientOutageError";
    err.retryAfterSec = 120;
    live.getAuthenticatedXeroClient.mockRejectedValue(err);

    expect((await getXeroConnectedOrganisation()).readFailure).toEqual({
      kind: "unavailable",
      rateLimit: null,
      retryAfterSeconds: 120,
    });
  });

  it("classifies a 5xx as 'unavailable'", async () => {
    stubLiveOrg({ name: "Live Org" });
    live.callXeroApi.mockRejectedValue({ response: { statusCode: 503 } });

    expect((await getXeroConnectedOrganisation()).readFailure).toEqual({
      kind: "unavailable",
      rateLimit: null,
      retryAfterSeconds: null,
    });
  });

  // A failure does not blank a name we already have — but it must still be
  // reported, or the surface showing that stale name has no way to know it is
  // stale. Both halves matter, so both are pinned together.
  it("keeps the last known name AND reports the failure beside it", async () => {
    stubLiveOrg({ name: "Live Org", shortCode: "!live1" });
    expect((await getXeroConnectedOrganisation()).name).toBe("Live Org");

    live.callXeroApi.mockRejectedValue({ response: { statusCode: 503 } });
    const summary = await getXeroConnectedOrganisation(true);

    expect(summary.name).toBe("Live Org");
    expect(summary.shortCode).toBe("!live1");
    expect(summary.readFailure?.kind).toBe("unavailable");
  });

  // The whole point of the wizard's Try again button: a forced read must not be
  // answered out of the 60-second NEGATIVE cache the failure just wrote.
  it("lets a forced refresh escape the negative cache and recover", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    live.getAuthenticatedXeroClient.mockRejectedValue(new Error("boom"));

    expect((await getXeroConnectedOrganisation()).readFailure?.kind).toBe(
      "unavailable",
    );
    // An ordinary read inside the window is served from the negative entry.
    await getXeroConnectedOrganisation();
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(1);

    // Xero recovers. Without forceRefresh the operator would wait out the TTL.
    stubLiveOrg({ name: "Back Online", shortCode: "!back1" });
    const retried = await getXeroConnectedOrganisation(true);

    expect(retried.name).toBe("Back Online");
    expect(retried.readFailure).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The year-end read (#2283: single flight + retry caps). It feeds membership
// financial-year resolution, so it is deliberately NOT negative-cached: an
// admin who has just fixed the connection must be picked up by the very next
// call. De-duplication carries none of that cost, and without it a
// present-but-failing connection turned N concurrent requests into N live Xero
// calls in exactly the state where Xero can least serve them.
// ---------------------------------------------------------------------------
describe("financial year-end month: single flight + retry caps (#2283)", () => {
  const originalOrigin = process.env.XERO_MOCK_API_ORIGIN;
  const originalInternalOrigin = process.env.XERO_MOCK_INTERNAL_ORIGIN;

  function stubLiveClient() {
    live.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getOrganisations: live.getOrganisations } },
      tenantId: "tenant-1",
    });
    live.callXeroApi.mockImplementation(async (fn: () => Promise<unknown>) =>
      fn(),
    );
  }

  /**
   * Same live client, but `callXeroApi` hands the read's OWN option object to
   * the REAL `withXeroRetry` (#2423) instead of just invoking the call.
   *
   * The process-global transient breaker is module state inside
   * `xero-api-client`, which this file mocks wholesale, so a test that wants to
   * assert on the breaker has to reach past the mock with `vi.importActual` —
   * one real module instance, so the state the read touches is the state the
   * assertions read. Every option that decides whether the breaker ARMS is the
   * read's own; only `maxWaitSec` is overridden, so the retry backoff sleeps for
   * nothing instead of really waiting a second.
   *
   * Callers must call `resetXeroRateLimitStateForTests()` on the returned module
   * afterwards — the cooldown is process-global and would otherwise leak.
   */
  async function stubLiveClientThroughRealRetry() {
    const real = (await vi.importActual("@/lib/xero-api-client")) as typeof import("@/lib/xero-api-client");
    real.resetXeroRateLimitStateForTests();
    live.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getOrganisations: live.getOrganisations } },
      tenantId: "tenant-1",
    });
    live.callXeroApi.mockImplementation(
      async (fn: () => Promise<unknown>, options: MeteredXeroCallOptions) =>
        real.withXeroRetry(fn, { ...options, maxWaitSec: 0 }),
    );
    return real;
  }

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    // The year-end read has no mock-Xero branch: it is always the live path.
    delete process.env.XERO_MOCK_API_ORIGIN;
    delete process.env.XERO_MOCK_INTERNAL_ORIGIN;
    vi.clearAllMocks();
    resetXeroOrganisationCachesForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetXeroOrganisationCachesForTests();
    if (originalOrigin === undefined) delete process.env.XERO_MOCK_API_ORIGIN;
    else process.env.XERO_MOCK_API_ORIGIN = originalOrigin;
    if (originalInternalOrigin === undefined)
      delete process.env.XERO_MOCK_INTERNAL_ORIGIN;
    else process.env.XERO_MOCK_INTERNAL_ORIGIN = originalInternalOrigin;
  });

  it("collapses concurrent cold-cache callers into ONE Xero read", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubLiveClient();
    live.getOrganisations.mockImplementation(async () => {
      await gate;
      return { body: { organisations: [{ financialYearEndMonth: 6 }] } };
    });

    const inFlight = Promise.all(
      Array.from({ length: 5 }, () => getXeroFinancialYearEndMonth()),
    );
    release?.();

    expect(await inFlight).toEqual(Array(5).fill(6));
    expect(live.getOrganisations).toHaveBeenCalledTimes(1);
  });

  it("shares one read while Xero is FAILING, and every joiner still resolves", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    live.getAuthenticatedXeroClient.mockImplementation(async () => {
      await gate;
      throw new Error("invalid_grant");
    });

    const inFlight = Promise.all(
      Array.from({ length: 5 }, () => getXeroFinancialYearEndMonth()),
    );
    release?.();

    // No joiner sees a rejection: the shared read degrades to null for all.
    expect(await inFlight).toEqual(Array(5).fill(null));
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(1);
  });

  // #2283 (decision item 9, option A): the year-end read aligns with the
  // summary read's retry posture. It has no negative cache (recovery must be
  // immediate — see the test below), so its only storm-control is "one attempt
  // per call": it must never wait out a per-minute 429 inside the call.
  it("does not retry: a failing read degrades now rather than waiting out a 429", async () => {
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 6 }] },
    });

    await getXeroFinancialYearEndMonth();

    expect(live.callXeroApi).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        operation: "getOrganisations",
        workflow: "membershipFinancialYear",
        maxRetries: 0,
      }),
    );
  });

  // #2423. Two options, one posture — the same pairing the summary read takes.
  // The read must NOT be able to ARM `rememberXeroTransientOutage`, the
  // process-global breaker that fails every Xero call (invoicing, sync,
  // webhook replay) for two minutes: it sits on unattended member-facing
  // traffic, so one member request per throttle window could hold that cooldown
  // open indefinitely. And once it cannot arm, the transient retry has no
  // purpose left (its ONLY stated job was making arming take two 5xx) while
  // still costing a second live call per failed read and, on a 5xx carrying
  // `Retry-After`, a sleep inside the member request. Detection is unaffected:
  // arming stays on by default for every call that matters.
  it("takes exactly one attempt and never arms the global outage breaker", async () => {
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 6 }] },
    });

    await getXeroFinancialYearEndMonth();

    expect(live.callXeroApi).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxTransientRetries: 0,
        armTransientBreaker: false,
      }),
    );
  });

  // The assertion above pins the OPTIONS; these two pin the CONSEQUENCE, by
  // running the year-end read's own option object through the REAL retry loop
  // (this file mocks `callXeroApi`, so the breaker it owns is reached past that
  // mock). Without them, deleting `armTransientBreaker: false` would fail one
  // literal-value assertion and nothing that describes what actually happens.
  it("does not arm the breaker when the year-end read hits a 5xx", async () => {
    const real = await stubLiveClientThroughRealRetry();
    try {
      // Xero is 5xx-ing. With no transient budget left, this is exactly the
      // moment arming would otherwise happen — on the FIRST failure.
      live.getOrganisations.mockRejectedValue({
        response: { statusCode: 503 },
        message: "Xero unavailable",
      });

      expect(await getXeroFinancialYearEndMonth()).toBeNull();
      // One live call, not two: no transient retry, and no sleep inside the
      // member request waiting to make it.
      expect(live.getOrganisations).toHaveBeenCalledTimes(1);

      // Invoicing's next Xero call is untouched — no cooldown was started, so
      // it is attempted and succeeds rather than being refused up front.
      const invoicePush = vi.fn(async () => "posted");
      await expect(real.withXeroRetry(invoicePush)).resolves.toBe("posted");
      expect(invoicePush).toHaveBeenCalledTimes(1);
    } finally {
      real.resetXeroRateLimitStateForTests();
    }
  });

  // Opting out of ARMING is not opting out of RESPECTING: a cooldown started by
  // a call that matters must still stop this one, and the read must degrade the
  // way any other failure does rather than reaching Xero.
  it("still refuses while a breaker armed by another caller is active", async () => {
    const real = await stubLiveClientThroughRealRetry();
    try {
      // Invoicing (default posture) hits repeated 5xx and arms the breaker.
      const outage = { response: { statusCode: 503 }, message: "Xero down" };
      await expect(
        real.withXeroRetry(() => Promise.reject(outage), {
          maxRetries: 2,
          maxWaitSec: 0,
        }),
      ).rejects.toBe(outage);

      live.getOrganisations.mockResolvedValue({
        body: { organisations: [{ financialYearEndMonth: 6 }] },
      });

      // Xero would answer, but the cooldown refuses before any HTTP.
      expect(await getXeroFinancialYearEndMonth()).toBeNull();
      expect(live.getOrganisations).not.toHaveBeenCalled();
    } finally {
      real.resetXeroRateLimitStateForTests();
    }
  });

  it("does NOT negative-cache the VALUE: the first call past the throttle tries again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    live.getAuthenticatedXeroClient.mockRejectedValueOnce(new Error("boom"));
    expect(await getXeroFinancialYearEndMonth()).toBeNull();

    // The admin fixes the connection. No VALUE is pinned, only the next
    // ATTEMPT is deferred — and by seconds, not the summary read's minute.
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 3 }] },
    });
    vi.setSystemTime(new Date(Date.now() + 16_000));
    expect(await getXeroFinancialYearEndMonth()).toBe(3);
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(2);
  });

  // #2283 review F1 (a). A cold cache plus one 429 used to return null, which
  // `getFinancialYearResolution` turns into the March default — silently moving
  // the membership season boundary (and the subscription-enforcement gate) for
  // the requests that hit it. The connected-org summary holds the SAME Xero
  // field, so a failing year-end read degrades to that instead of to nothing.
  it("degrades to the summary cache's year-end month when its own read fails cold", async () => {
    // Warm the summary cache (the live branch: no mock origin in this suite).
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: {
        organisations: [
          { name: "Live Org", financialYearEndMonth: 9, shortCode: "!live1" },
        ],
      },
    });
    expect((await getXeroConnectedOrganisation()).financialYearEndMonth).toBe(9);

    // Now the year-end read itself fails with nothing of its own cached.
    live.getAuthenticatedXeroClient.mockRejectedValue(new Error("429"));
    expect(await getXeroFinancialYearEndMonth()).toBe(9);
  });

  // #2283 review F1 (b). `maxRetries: 0` removed the incidental storm control
  // that waiting out a 429 used to provide. Member-facing traffic is serial, so
  // single flight does not bound it; a short post-failure throttle does.
  it("throttles the next live attempt for a few seconds after a failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    live.getAuthenticatedXeroClient.mockRejectedValue(new Error("429"));

    expect(await getXeroFinancialYearEndMonth()).toBeNull();
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(1);

    // A burst of member requests inside the window makes NO live Xero call.
    for (let i = 0; i < 5; i += 1) {
      expect(await getXeroFinancialYearEndMonth()).toBeNull();
    }
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(1);

    // Past the window, one call goes live again.
    vi.setSystemTime(new Date(Date.now() + 16_000));
    expect(await getXeroFinancialYearEndMonth()).toBeNull();
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(2);
  });

  // #2423 review F1. Arming the process-global breaker was ALSO what suppressed
  // this read during an outage: it refused itself, pre-HTTP, for the cooldown.
  // Opting out of arming (rightly) removed that, leaving 15 seconds as the only
  // bound on a read that goes live every window for the whole of an outage. The
  // storm control comes back LOCALLY — same order of magnitude as the breaker's
  // own cooldown, and nobody else's calls are touched.
  it("backs off for about two minutes when Xero is unreachable and it already holds a real month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    // Warm the fallback: the summary cache holds the SAME Xero field.
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ name: "Live Org", financialYearEndMonth: 9 }] },
    });
    await getXeroConnectedOrganisation();

    // Xero is 5xx-ing. The read degrades to the month it already holds.
    live.getAuthenticatedXeroClient.mockRejectedValue({
      response: { statusCode: 503 },
      message: "Xero unavailable",
    });
    expect(await getXeroFinancialYearEndMonth()).toBe(9);
    const callsAfterFailure = live.getAuthenticatedXeroClient.mock.calls.length;

    // Past the SHORT window and still suppressed: re-asking a service that is
    // down only spends the daily quota invoicing needs, and the answer served
    // meanwhile is the real month, not a guess.
    vi.setSystemTime(new Date(Date.now() + 16_000));
    expect(await getXeroFinancialYearEndMonth()).toBe(9);
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(
      callsAfterFailure,
    );

    // Past the outage window, one call goes live again — nothing is pinned.
    vi.setSystemTime(new Date(Date.now() + 106_000));
    expect(await getXeroFinancialYearEndMonth()).toBe(9);
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(
      callsAfterFailure + 1,
    );
  });

  // The other half of the same decision (#2283's cold-cache concern). With no
  // month held, the value served is null — which `getFinancialYearResolution`
  // turns into the March default, moving the membership season boundary. A cold
  // cache must therefore keep re-attempting at the SHORT window, so a real month
  // arrives as soon as Xero can give one.
  it("keeps the short window during an outage while the cache is COLD", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    live.getAuthenticatedXeroClient.mockRejectedValue({
      response: { statusCode: 503 },
      message: "Xero unavailable",
    });

    expect(await getXeroFinancialYearEndMonth()).toBeNull();
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(1);

    // Xero comes back 16 seconds later: the read must be free to notice.
    vi.setSystemTime(new Date(Date.now() + 16_000));
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 6 }] },
    });
    expect(await getXeroFinancialYearEndMonth()).toBe(6);
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(2);
  });

  // ...but "keep re-attempting" is about a BLIP, not a licence to poll Xero
  // every 15 seconds for hours. Unbounded, a process that booted during an
  // outage spends ~4 live calls a minute against the shared per-tenant DAILY
  // cap — and the daily gate is the 24-hour, no-opt-out suppression this whole
  // review is keeping out of reach of member traffic.
  it("stops the cold-cache fast retries once the failures stop looking like a blip", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    live.getAuthenticatedXeroClient.mockRejectedValue({
      response: { statusCode: 503 },
      message: "Xero unavailable",
    });

    // The first eight attempts stay fast — about two minutes of them.
    for (let i = 0; i < 8; i += 1) {
      expect(await getXeroFinancialYearEndMonth()).toBeNull();
      vi.setSystemTime(new Date(Date.now() + 16_000));
    }
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(8);

    // The ninth concedes this is an outage and takes the long window.
    expect(await getXeroFinancialYearEndMonth()).toBeNull();
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(9);

    vi.setSystemTime(new Date(Date.now() + 16_000));
    expect(await getXeroFinancialYearEndMonth()).toBeNull();
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(9);

    // Recovery is delayed by the long window at worst, never blocked.
    vi.setSystemTime(new Date(Date.now() + 106_000));
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 6 }] },
    });
    expect(await getXeroFinancialYearEndMonth()).toBe(6);
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(10);
  });

  // And the longer window is only for failures nobody can fix by acting now. A
  // disconnected Xero is fixed by an admin reconnecting; the reconnect that
  // happens in THIS process clears the window outright (see the test below), so
  // what this pins is the out-of-band case — another process's reconnect, or a
  // token that refreshed itself — where only the window's length decides how
  // long a fixed connection keeps being ignored.
  it("keeps the short window for a disconnected failure, even holding a real month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ name: "Live Org", financialYearEndMonth: 9 }] },
    });
    await getXeroConnectedOrganisation();

    const reconnectRequired = new Error("Please reconnect Xero.");
    reconnectRequired.name = "XeroReconnectRequiredError";
    live.getAuthenticatedXeroClient.mockRejectedValue(reconnectRequired);
    expect(await getXeroFinancialYearEndMonth()).toBe(9);
    const callsAfterFailure = live.getAuthenticatedXeroClient.mock.calls.length;

    // The authorisation is restored out of band; 16 seconds later this read
    // picks it up rather than serving the stale month for two minutes.
    vi.setSystemTime(new Date(Date.now() + 16_000));
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 6 }] },
    });
    expect(await getXeroFinancialYearEndMonth()).toBe(6);
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(
      callsAfterFailure + 1,
    );
  });

  it("serves the same fallback month inside the throttle window as a live failure would", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ name: "Live Org", financialYearEndMonth: 9 }] },
    });
    await getXeroConnectedOrganisation();

    live.getAuthenticatedXeroClient.mockRejectedValue(new Error("429"));
    expect(await getXeroFinancialYearEndMonth()).toBe(9);
    const callsAfterFailure = live.getAuthenticatedXeroClient.mock.calls.length;

    // Throttled: same answer, no additional live call.
    expect(await getXeroFinancialYearEndMonth()).toBe(9);
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(
      callsAfterFailure,
    );
  });

  it("lets forceRefresh (an admin re-check) skip the throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    live.getAuthenticatedXeroClient.mockRejectedValueOnce(new Error("429"));
    expect(await getXeroFinancialYearEndMonth()).toBeNull();
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(1);

    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 3 }] },
    });

    // Same instant, still inside the window: forceRefresh goes live anyway.
    expect(await getXeroFinancialYearEndMonth(true)).toBe(3);
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(2);
  });

  it("clears the throttle on a reconnect so the new connection is read at once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    live.getAuthenticatedXeroClient.mockRejectedValueOnce(new Error("boom"));
    expect(await getXeroFinancialYearEndMonth()).toBeNull();

    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 6 }] },
    });
    invalidateXeroOrganisationCaches();

    expect(await getXeroFinancialYearEndMonth()).toBe(6);
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(2);
  });

  it("clears the throttle on success so a later failure starts a fresh window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    live.getAuthenticatedXeroClient.mockRejectedValueOnce(new Error("boom"));
    expect(await getXeroFinancialYearEndMonth()).toBeNull();

    // Success past the window: the throttle is cleared, not extended.
    vi.setSystemTime(new Date(Date.now() + 16_000));
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 6 }] },
    });
    expect(await getXeroFinancialYearEndMonth()).toBe(6);

    // A much later failure (long past the 12-hour cache) throttles from THEN,
    // and still degrades to the month the successful read left behind.
    vi.setSystemTime(new Date(Date.now() + 13 * 60 * 60 * 1000));
    live.getAuthenticatedXeroClient.mockRejectedValue(new Error("boom"));
    expect(await getXeroFinancialYearEndMonth()).toBe(6);
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(3);
    expect(await getXeroFinancialYearEndMonth()).toBe(6);
    expect(live.getAuthenticatedXeroClient).toHaveBeenCalledTimes(3);
  });

  it("clears the in-flight slot so a later caller is never wedged", async () => {
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 9 }] },
    });

    expect(await getXeroFinancialYearEndMonth()).toBe(9);
    // Cached now, so no second read; after invalidation a cold call must work.
    invalidateXeroOrganisationCaches();
    expect(await getXeroFinancialYearEndMonth()).toBe(9);
    expect(live.getOrganisations).toHaveBeenCalledTimes(2);
  });

  // Same reconnect guard as the summary read: the two share one generation
  // counter, because they share one invalidation.
  it("drops a read that started before a reconnect instead of caching the old month", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubLiveClient();
    live.getOrganisations.mockImplementation(async () => {
      await gate;
      return { body: { organisations: [{ financialYearEndMonth: 6 }] } };
    });

    const inFlight = getXeroFinancialYearEndMonth();
    invalidateXeroOrganisationCaches();
    release?.();
    expect(await inFlight).toBe(6);

    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 3 }] },
    });
    expect(await getXeroFinancialYearEndMonth()).toBe(3);
    expect(live.getOrganisations).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The lock-dates read is the THIRD cache on the same invalidation path, and the
// one with the worst failure mode. It backs the retroactive-booking guard,
// which fails CLOSED: a booking whose check-in falls on or before the effective
// lock date is rejected so its invoice never posts into a locked period. A read
// in flight across a reconnect that repopulated the cleared cache would make
// that guard evaluate the PREVIOUS organisation's lock dates for up to the full
// 5-minute TTL — and the dangerous direction is the quiet one: old org unlocked,
// new org locked, so the guard returns instead of throwing and the invoice
// lands in a locked period in the org that is actually connected.
// ---------------------------------------------------------------------------
describe("lock dates: reconnect guard (#2283)", () => {
  const originalOrigin = process.env.XERO_MOCK_API_ORIGIN;
  const originalInternalOrigin = process.env.XERO_MOCK_INTERNAL_ORIGIN;

  const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

  function stubLiveClient() {
    live.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getOrganisations: live.getOrganisations } },
      tenantId: "tenant-1",
    });
    live.callXeroApi.mockImplementation(async (fn: () => Promise<unknown>) =>
      fn(),
    );
  }

  /** A gated read of the OLD org, which has NO lock dates set. */
  function startUnlockedOldOrgRead() {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubLiveClient();
    live.getOrganisations.mockImplementation(async () => {
      await gate;
      return { body: { organisations: [{}] } };
    });
    const inFlight = getXeroLockDates();
    return { inFlight, release: () => release?.() };
  }

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    // The lock-dates read has no mock-Xero branch: it is always the live path.
    delete process.env.XERO_MOCK_API_ORIGIN;
    delete process.env.XERO_MOCK_INTERNAL_ORIGIN;
    vi.clearAllMocks();
    resetXeroOrganisationCachesForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetXeroOrganisationCachesForTests();
    if (originalOrigin === undefined) delete process.env.XERO_MOCK_API_ORIGIN;
    else process.env.XERO_MOCK_API_ORIGIN = originalOrigin;
    if (originalInternalOrigin === undefined)
      delete process.env.XERO_MOCK_INTERNAL_ORIGIN;
    else process.env.XERO_MOCK_INTERNAL_ORIGIN = originalInternalOrigin;
  });

  it("does not cache lock dates read before a reconnect: the next booking sees the NEW org's lock", async () => {
    const { inFlight, release } = startUnlockedOldOrgRead();

    // The admin reconnects to a DIFFERENT organisation mid-read...
    invalidateXeroOrganisationCaches();
    release();

    // ...the abandoned read still answers its own caller (bounded residual).
    await expect(inFlight).resolves.toEqual({
      periodLockDate: null,
      endOfYearLockDate: null,
    });
    expect(live.getOrganisations).toHaveBeenCalledTimes(1);

    // The organisation now connected HAS a period lock. Nothing from the
    // abandoned read may be serving "unlocked" from the cleared cache.
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ periodLockDate: "2026-06-30" }] },
    });

    const after = await getXeroLockDates();
    expect(live.getOrganisations).toHaveBeenCalledTimes(2);
    expect(iso(after.periodLockDate)).toBe("2026-06-30");
  });

  it("still fails closed after a reconnect: the abandoned read leaves nothing to fall back on", async () => {
    const { inFlight, release } = startUnlockedOldOrgRead();

    invalidateXeroOrganisationCaches();
    release();
    await inFlight;

    // Xero is now unreachable. With no cache entry for the CURRENT connection,
    // the read must throw so the route returns a retryable error rather than
    // skipping the guard on the old org's "no lock dates".
    live.getAuthenticatedXeroClient.mockRejectedValue(
      new Error("xero unavailable"),
    );
    await expect(getXeroLockDates()).rejects.toThrow("xero unavailable");
  });

  it("keeps caching within the TTL when no reconnect intervenes", async () => {
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ periodLockDate: "2026-06-30" }] },
    });

    expect(iso((await getXeroLockDates()).periodLockDate)).toBe("2026-06-30");
    expect(iso((await getXeroLockDates()).periodLockDate)).toBe("2026-06-30");
    expect(live.getOrganisations).toHaveBeenCalledTimes(1);
  });
});
