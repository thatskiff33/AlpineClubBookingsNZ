import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createXeroClient: vi.fn(),
  loadXeroTokens: vi.fn(),
  claimXeroTokenRefreshLease: vi.fn(),
  releaseXeroTokenRefreshLease: vi.fn(),
  saveXeroTokens: vi.fn(),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/xero-oauth", () => ({
  createXeroClient: mocks.createXeroClient,
}));

vi.mock("@/lib/xero-token-store", () => ({
  XERO_TOKEN_REFRESH_LEASE_MS: 2 * 60 * 1000,
  claimXeroTokenRefreshLease: mocks.claimXeroTokenRefreshLease,
  loadXeroTokens: mocks.loadXeroTokens,
  releaseXeroTokenRefreshLease: mocks.releaseXeroTokenRefreshLease,
  saveXeroTokens: mocks.saveXeroTokens,
}));

vi.mock("@/lib/xero-config", () => ({
  getOperationalXeroConfig: () => ({
    clientId: "operational-client",
    clientSecret: "operational-secret",
  }),
}));

vi.mock("@/lib/logger", () => ({
  default: mocks.logger,
}));

vi.mock("@/lib/xero-api-usage", () => ({
  recordXeroApiUsage: vi.fn(),
}));

// The refresh-failure path fires a best-effort alert via a dynamic import.
vi.mock("@/lib/xero-error-alert", () => ({
  notifyXeroSyncError: vi.fn().mockResolvedValue(undefined),
}));

import {
  getAuthenticatedXeroClient,
  resetXeroRateLimitStateForTests,
  withXeroRetry,
  XeroDailyLimitError,
  XeroReconnectRequiredError,
} from "@/lib/xero-api-client";

function makeTokens(overrides: Record<string, unknown> = {}) {
  return {
    id: "xero-token-1",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: new Date("2026-06-21T12:05:00.000Z"),
    tenantId: "tenant-1",
    refreshInProgressUntil: null,
    ...overrides,
  };
}

function makeXeroClient() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    setTokenSet: vi.fn(),
    refreshWithRefreshToken: vi.fn().mockResolvedValue({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 1800,
      token_type: "Bearer",
    }),
  };
}

describe("getAuthenticatedXeroClient token refresh lease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T12:00:00.000Z"));
    vi.clearAllMocks();
    resetXeroRateLimitStateForTests();
    mocks.releaseXeroTokenRefreshLease.mockResolvedValue(undefined);
    mocks.saveXeroTokens.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims a database lease before refreshing and saves tokens under that lease", async () => {
    const tokens = makeTokens();
    const leaseUntil = new Date("2026-06-21T12:02:00.000Z");
    const xero = makeXeroClient();
    mocks.createXeroClient.mockReturnValue(xero);
    mocks.loadXeroTokens.mockResolvedValue(tokens);
    mocks.claimXeroTokenRefreshLease.mockResolvedValue({
      claimed: true,
      tokens,
      leaseUntil,
    });

    const result = await getAuthenticatedXeroClient();

    expect(result).toEqual({ xero, tenantId: "tenant-1" });
    expect(mocks.claimXeroTokenRefreshLease).toHaveBeenCalledTimes(1);
    expect(xero.refreshWithRefreshToken).toHaveBeenCalledWith(
      "operational-client",
      "operational-secret",
      "old-refresh"
    );
    expect(mocks.saveXeroTokens).toHaveBeenCalledWith(
      {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date("2026-06-21T12:30:00.000Z"),
        tenantId: "tenant-1",
      },
      {
        // #3454: a refresh is the named background job, never an absence.
        actor: { kind: "system", actor: "xero-token-refresh" },
        lease: { claimed: tokens, leaseUntil },
      }
    );
    expect(mocks.releaseXeroTokenRefreshLease).toHaveBeenCalledWith(
      "xero-token-1",
      leaseUntil
    );
  });

  it("releases the lease and does not cache the rejection when client construction fails during refresh", async () => {
    // Regression: buildAuthenticatedXeroClient (initialize -> identity.xero.com
    // discovery) used to run before the try/finally, so one timeout left the
    // rejected promise cached in the refresh mutex and the DB lease claimed —
    // every later call replayed the stale error until the process restarted.
    const tokens = makeTokens();
    const leaseUntil = new Date("2026-06-21T12:02:00.000Z");
    const failingXero = makeXeroClient();
    failingXero.initialize = vi
      .fn()
      .mockRejectedValue(new Error("outgoing request timed out after 3500ms"));
    const workingXero = makeXeroClient();
    mocks.createXeroClient
      .mockReturnValueOnce(failingXero)
      .mockReturnValue(workingXero);
    mocks.loadXeroTokens.mockResolvedValue(tokens);
    mocks.claimXeroTokenRefreshLease.mockResolvedValue({
      claimed: true,
      tokens,
      leaseUntil,
    });

    await expect(getAuthenticatedXeroClient()).rejects.toThrow(
      "outgoing request timed out after 3500ms"
    );
    expect(mocks.releaseXeroTokenRefreshLease).toHaveBeenCalledWith(
      "xero-token-1",
      leaseUntil
    );

    const result = await getAuthenticatedXeroClient();

    expect(result).toEqual({ xero: workingXero, tenantId: "tenant-1" });
    expect(workingXero.refreshWithRefreshToken).toHaveBeenCalledTimes(1);
    expect(mocks.saveXeroTokens).toHaveBeenCalledTimes(1);
  });

  it("waits for another worker's refresh lease instead of double-refreshing", async () => {
    const expiredTokens = makeTokens({
      refreshInProgressUntil: new Date("2026-06-21T12:01:00.000Z"),
    });
    const refreshedTokens = makeTokens({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      expiresAt: new Date("2026-06-21T12:30:00.000Z"),
      refreshInProgressUntil: null,
    });
    const xero = makeXeroClient();
    mocks.createXeroClient.mockReturnValue(xero);
    mocks.loadXeroTokens
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(refreshedTokens);
    mocks.claimXeroTokenRefreshLease.mockResolvedValue({
      claimed: false,
      tokens: expiredTokens,
      leaseUntil: expiredTokens.refreshInProgressUntil,
    });

    const resultPromise = getAuthenticatedXeroClient();
    await vi.advanceTimersByTimeAsync(250);
    const result = await resultPromise;

    expect(result).toEqual({ xero, tenantId: "tenant-1" });
    expect(xero.refreshWithRefreshToken).not.toHaveBeenCalled();
    expect(mocks.saveXeroTokens).not.toHaveBeenCalled();
    expect(xero.setTokenSet).toHaveBeenLastCalledWith({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      token_type: "Bearer",
    });
  });
});

// #2105: the token/tenant sites and identity-auth refresh failures throw the
// dedicated XeroReconnectRequiredError (unchanged message strings); transient
// identity 5xx stays an ordinary retryable Error.
describe("getAuthenticatedXeroClient error taxonomy (#2105)", () => {
  const REFRESH_FAILED_MESSAGE =
    "Xero token refresh failed. Please reconnect Xero via the admin panel.";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T12:00:00.000Z"));
    vi.clearAllMocks();
    resetXeroRateLimitStateForTests();
    mocks.releaseXeroTokenRefreshLease.mockResolvedValue(undefined);
    mocks.saveXeroTokens.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws XeroReconnectRequiredError when Xero is not connected (no tokens)", async () => {
    mocks.loadXeroTokens.mockResolvedValue(null);

    const err = await getAuthenticatedXeroClient().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(XeroReconnectRequiredError);
    expect((err as Error).message).toBe(
      "Xero is not connected. Please connect via admin panel.",
    );
  });

  it("throws XeroReconnectRequiredError when the tenant ID is missing", async () => {
    mocks.loadXeroTokens.mockResolvedValue(makeTokens({ tenantId: null }));

    const err = await getAuthenticatedXeroClient().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(XeroReconnectRequiredError);
    expect((err as Error).message).toBe(
      "Xero tenant ID not found. Please reconnect Xero.",
    );
  });

  function arrangeFailingRefresh(refreshError: unknown) {
    const tokens = makeTokens();
    const xero = makeXeroClient();
    xero.refreshWithRefreshToken = vi.fn().mockRejectedValue(refreshError);
    mocks.createXeroClient.mockReturnValue(xero);
    mocks.loadXeroTokens.mockResolvedValue(tokens);
    mocks.claimXeroTokenRefreshLease.mockResolvedValue({
      claimed: true,
      tokens,
      leaseUntil: new Date("2026-06-21T12:02:00.000Z"),
    });
  }

  it("maps an invalid_grant refresh rejection to XeroReconnectRequiredError (unchanged message)", async () => {
    arrangeFailingRefresh(
      Object.assign(new Error("invalid_grant (token revoked)"), {
        error: "invalid_grant",
      }),
    );

    const err = await getAuthenticatedXeroClient().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(XeroReconnectRequiredError);
    expect((err as Error).message).toBe(REFRESH_FAILED_MESSAGE);
  });

  it("maps an HTTP 400 refresh rejection to XeroReconnectRequiredError", async () => {
    arrangeFailingRefresh(
      Object.assign(new Error("Bad Request"), {
        response: { statusCode: 400 },
      }),
    );

    await expect(getAuthenticatedXeroClient()).rejects.toBeInstanceOf(
      XeroReconnectRequiredError,
    );
  });

  it("keeps a transient identity 5xx refresh rejection an ordinary retryable Error (NOT reconnect-required)", async () => {
    arrangeFailingRefresh(
      Object.assign(new Error("identity endpoint unavailable"), {
        response: { statusCode: 503 },
      }),
    );

    const err = await getAuthenticatedXeroClient().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(XeroReconnectRequiredError);
    expect((err as Error).message).toBe(REFRESH_FAILED_MESSAGE);
  });
});

// #2423 review F2. The outbox's FAILED->PENDING auto-re-drive keys on
// `XeroDailyLimitError.preHttp` to tell a never-sent refusal from an attempted
// call. That distinction is only sound if the marker is actually set correctly
// on BOTH construction sites, so pin the real production paths here (not a
// hand-built error): the pre-HTTP daily gate must mark `preHttp: true`, and the
// post-HTTP conversion of a 429 Xero itself returned must mark `preHttp: false`.
describe("XeroDailyLimitError pre-HTTP vs post-HTTP marker (#2423 F2)", () => {
  beforeEach(() => {
    resetXeroRateLimitStateForTests();
  });

  afterEach(() => {
    resetXeroRateLimitStateForTests();
  });

  it("marks a real HTTP 429/day converted by withXeroRetry as preHttp: false (attempted)", async () => {
    const day429 = Object.assign(new Error("rate limited"), {
      response: {
        statusCode: 429,
        headers: { "x-rate-limit-problem": "day", "retry-after": "3600" },
      },
    });

    const postHttpError = await withXeroRetry(async () => {
      throw day429;
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(postHttpError).toBeInstanceOf(XeroDailyLimitError);
    // The call WAS attempted, so the outbox must keep it on the FAILED path.
    expect((postHttpError as XeroDailyLimitError).preHttp).toBe(false);
  });

  it("marks the pre-HTTP daily gate refusal as preHttp: true (never attempted)", async () => {
    // Arm the daily gate by driving one real 429/day through withXeroRetry.
    const day429 = Object.assign(new Error("rate limited"), {
      response: {
        statusCode: 429,
        headers: { "x-rate-limit-problem": "day", "retry-after": "3600" },
      },
    });
    await withXeroRetry(async () => {
      throw day429;
    }).catch(() => undefined);

    // A subsequent call is now refused BEFORE fn() runs by the armed gate.
    let ran = false;
    const gateRefusal = await withXeroRetry(async () => {
      ran = true;
      return "unreachable";
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(ran).toBe(false);
    expect(gateRefusal).toBeInstanceOf(XeroDailyLimitError);
    // Never attempted, so the outbox may safely return the row to PENDING.
    expect((gateRefusal as XeroDailyLimitError).preHttp).toBe(true);
  });
});
