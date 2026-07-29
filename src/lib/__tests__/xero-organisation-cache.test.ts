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

  // `maxTransientRetries` defaults to `min(maxRetries, 1)` in withXeroRetry, so
  // `maxRetries: 0` alone would ALSO zero the transient budget — and exhausting
  // that budget arms `rememberXeroTransientOutage`, the process-global breaker
  // that fails every Xero call (invoicing and sync included) for two minutes.
  // This decorative read must never be one 5xx away from stopping invoicing.
  it("keeps the transient budget so one 5xx cannot trip the global outage breaker", async () => {
    stubLiveOrg({ name: "Live Org", shortCode: "!live1" });

    await getXeroConnectedOrganisation();

    expect(live.callXeroApi).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxTransientRetries: 1 }),
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

  // `maxTransientRetries` defaults to `min(maxRetries, 1)`, so `maxRetries: 0`
  // alone would ALSO zero the transient budget — and exhausting that budget
  // arms `rememberXeroTransientOutage`, the process-global breaker that fails
  // every Xero call (invoicing and sync included) for two minutes. The
  // year-end read must not be one 5xx away from stopping invoicing.
  it("keeps the transient budget so one 5xx cannot trip the global outage breaker", async () => {
    stubLiveClient();
    live.getOrganisations.mockResolvedValue({
      body: { organisations: [{ financialYearEndMonth: 6 }] },
    });

    await getXeroFinancialYearEndMonth();

    expect(live.callXeroApi).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxTransientRetries: 1 }),
    );
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
