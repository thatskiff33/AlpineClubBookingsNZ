import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLoadFinanceXeroTokens,
  mockSaveFinanceXeroTokens,
  mockGetFinanceXeroConnectionStatus,
  mockGetFinanceXeroConfigIssues,
  mockGetFinanceXeroTokenStorageIssues,
  mockXeroInstance,
} = vi.hoisted(() => ({
  mockLoadFinanceXeroTokens: vi.fn(),
  mockSaveFinanceXeroTokens: vi.fn(),
  mockGetFinanceXeroConnectionStatus: vi.fn(),
  mockGetFinanceXeroConfigIssues: vi.fn(),
  mockGetFinanceXeroTokenStorageIssues: vi.fn(),
  mockXeroInstance: {
    initialize: vi.fn(),
    apiCallback: vi.fn(),
    updateTenants: vi.fn(),
    setTokenSet: vi.fn(),
    refreshWithRefreshToken: vi.fn(),
    revokeToken: vi.fn(),
    tenants: [] as Array<{ tenantId: string }>,
  },
}));

vi.mock("xero-node", () => ({
  XeroClient: vi.fn().mockImplementation(function MockXeroClient() {
    return mockXeroInstance;
  }),
}));

vi.mock("@/lib/finance-xero-token-store", () => ({
  clearFinanceXeroTokens: vi.fn(),
  getFinanceXeroConnectionStatus: mockGetFinanceXeroConnectionStatus,
  loadFinanceXeroTokens: mockLoadFinanceXeroTokens,
  saveFinanceXeroTokens: mockSaveFinanceXeroTokens,
}));

vi.mock("@/lib/xero-config", () => ({
  getFinanceXeroConfig: () => ({
    clientId: "finance-client",
    clientSecret: "finance-secret",
    redirectUris: ["https://example.com/api/finance/xero/callback"],
    scopes: ["openid"],
  }),
  getFinanceXeroConfigIssues: mockGetFinanceXeroConfigIssues,
  getFinanceXeroTokenStorageIssues: mockGetFinanceXeroTokenStorageIssues,
}));

import { getAuthenticatedFinanceXeroClient, handleFinanceXeroCallback } from "@/lib/finance-xero";

describe("finance-xero", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));
    vi.clearAllMocks();
    mockXeroInstance.tenants = [];
    mockXeroInstance.initialize.mockResolvedValue(undefined);
    mockXeroInstance.apiCallback.mockResolvedValue({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 1800,
    });
    mockXeroInstance.updateTenants.mockResolvedValue(undefined);
    mockXeroInstance.refreshWithRefreshToken.mockResolvedValue({
      access_token: "refreshed-access-token",
      refresh_token: "refreshed-refresh-token",
      expires_in: 1800,
      token_type: "Bearer",
    });
    mockLoadFinanceXeroTokens.mockResolvedValue({
      id: "finance-token-1",
      accessToken: "stored-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: new Date("2026-04-21T10:05:00.000Z"),
      tenantId: "tenant-123",
    });
    mockGetFinanceXeroConnectionStatus.mockResolvedValue({
      connected: true,
      hasStoredTokens: true,
      tenantId: "tenant-123",
      tokenExpiresAt: new Date("2026-04-21T10:05:00.000Z"),
    });
    mockGetFinanceXeroConfigIssues.mockReturnValue([]);
    mockGetFinanceXeroTokenStorageIssues.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires a tenant before saving finance callback tokens", async () => {
    await expect(
      handleFinanceXeroCallback(
        "https://example.com/api/finance/xero/callback?code=abc&state=xyz",
        "xyz"
      )
    ).rejects.toThrow("did not return an organisation");

    expect(mockSaveFinanceXeroTokens).not.toHaveBeenCalled();
  });

  it("refreshes expiring finance tokens before returning an authenticated client", async () => {
    mockXeroInstance.tenants = [{ tenantId: "tenant-123" }];

    const result = await getAuthenticatedFinanceXeroClient();

    expect(mockXeroInstance.refreshWithRefreshToken).toHaveBeenCalledWith(
      "finance-client",
      "finance-secret",
      "stored-refresh-token"
    );
    expect(mockSaveFinanceXeroTokens).toHaveBeenCalledWith({
      accessToken: "refreshed-access-token",
      refreshToken: "refreshed-refresh-token",
      expiresAt: new Date("2026-04-21T10:30:00.000Z"),
      tenantId: "tenant-123",
    });
    expect(result.tenantId).toBe("tenant-123");
  });

  it("fails closed when stored finance tokens do not include a tenant", async () => {
    mockLoadFinanceXeroTokens.mockResolvedValue({
      id: "finance-token-1",
      accessToken: "stored-access-token",
      refreshToken: "stored-refresh-token",
      expiresAt: new Date("2026-04-21T10:40:00.000Z"),
      tenantId: undefined,
    });

    await expect(getAuthenticatedFinanceXeroClient()).rejects.toThrow(
      "tenant is not available"
    );
  });
});
