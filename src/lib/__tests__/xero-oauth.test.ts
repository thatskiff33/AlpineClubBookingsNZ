import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSaveXeroTokens, mockXeroInstance } = vi.hoisted(() => ({
  mockSaveXeroTokens: vi.fn(),
  mockXeroInstance: {
    initialize: vi.fn(),
    apiCallback: vi.fn(),
    updateTenants: vi.fn(),
    setTokenSet: vi.fn(),
    revokeToken: vi.fn(),
    tenants: [] as Array<{ tenantId: string }>,
  },
}));

vi.mock("xero-node", () => ({
  XeroClient: vi.fn().mockImplementation(function MockXeroClient() {
    return mockXeroInstance;
  }),
}));

vi.mock("@/lib/xero-config", () => ({
  getOperationalXeroConfig: () => ({
    clientId: "operational-client",
    clientSecret: "operational-secret",
    redirectUris: ["https://example.org/api/admin/xero/callback"],
    scopes: ["openid", "accounting.contacts"],
  }),
}));

vi.mock("@/lib/xero-token-store", () => ({
  deleteXeroTokens: vi.fn(),
  loadXeroTokens: vi.fn(),
  saveXeroTokens: mockSaveXeroTokens,
}));

import { handleXeroCallback } from "@/lib/xero-oauth";

describe("xero-oauth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    vi.clearAllMocks();
    mockXeroInstance.tenants = [];
    mockXeroInstance.initialize.mockResolvedValue(undefined);
    mockXeroInstance.apiCallback.mockResolvedValue({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 1800,
    });
    mockXeroInstance.updateTenants.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires a tenant before saving operational Xero callback tokens", async () => {
    await expect(
      handleXeroCallback(
        "https://example.org/api/admin/xero/callback?code=abc&state=xyz",
        "xyz",
        { actor: { kind: "admin", memberId: "admin-1" } },
      )
    ).rejects.toThrow("did not return an organisation");

    expect(mockSaveXeroTokens).not.toHaveBeenCalled();
  });

  it("saves operational Xero callback tokens only with a tenant", async () => {
    mockXeroInstance.tenants = [{ tenantId: "tenant-123" }];

    await handleXeroCallback(
      "https://example.org/api/admin/xero/callback?code=abc&state=xyz",
      "xyz",
      { actor: { kind: "admin", memberId: "admin-1" } },
    );

    expect(mockSaveXeroTokens).toHaveBeenCalledWith({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: new Date("2026-05-29T12:30:00.000Z"),
      tenantId: "tenant-123",
    }, { actor: { kind: "admin", memberId: "admin-1" } });
  });
});
