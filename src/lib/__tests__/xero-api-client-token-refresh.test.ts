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

import {
  getAuthenticatedXeroClient,
  resetXeroRateLimitStateForTests,
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
        claimedTokenId: "xero-token-1",
        refreshLeaseUntil: leaseUntil,
      }
    );
    expect(mocks.releaseXeroTokenRefreshLease).toHaveBeenCalledWith(
      "xero-token-1",
      leaseUntil
    );
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
