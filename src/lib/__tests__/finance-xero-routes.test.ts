import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockFindUnique,
  mockGetFinanceXeroRouteStatus,
  mockGetFinanceXeroConsentUrl,
  mockDisconnectFinanceXero,
  mockHandleFinanceXeroCallback,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockGetFinanceXeroRouteStatus: vi.fn(),
  mockGetFinanceXeroConsentUrl: vi.fn(),
  mockDisconnectFinanceXero: vi.fn(),
  mockHandleFinanceXeroCallback: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/lib/finance-xero", () => ({
  getFinanceXeroRouteStatus: mockGetFinanceXeroRouteStatus,
  getFinanceXeroConsentUrl: mockGetFinanceXeroConsentUrl,
  disconnectFinanceXero: mockDisconnectFinanceXero,
  handleFinanceXeroCallback: mockHandleFinanceXeroCallback,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { GET as connectFinanceXero } from "@/app/api/finance/xero/connect/route";
import { POST as disconnectFinanceXeroRoute } from "@/app/api/finance/xero/disconnect/route";
import { GET as getFinanceXeroStatus } from "@/app/api/finance/xero/status/route";
import { GET as handleFinanceXeroConnectCallback } from "@/app/api/finance/xero/callback/route";

function managerSession() {
  return { user: { id: "finance-manager-1", role: "ADMIN" } };
}

function viewerMember() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "View",
    lastName: "Only",
    role: "MEMBER",
    financeAccessLevel: "VIEWER",
    active: true,
    forcePasswordChange: false,
  };
}

function managerMember() {
  return {
    id: "finance-manager-1",
    email: "manager@example.com",
    firstName: "Fin",
    lastName: "Manager",
    role: "ADMIN",
    financeAccessLevel: "MANAGER",
    active: true,
    forcePasswordChange: false,
  };
}

describe("finance Xero routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXTAUTH_URL", "https://tokoroa.org.nz");
    mockAuth.mockResolvedValue(managerSession());
    mockFindUnique.mockResolvedValue(managerMember());
    mockGetFinanceXeroRouteStatus.mockResolvedValue({
      connected: false,
      tenantId: null,
      tokenExpiresAt: null,
      oauthConfigured: true,
      tokenStorageConfigured: true,
      canConnect: true,
      configIssues: [],
      tokenStorageIssues: [],
    });
    mockGetFinanceXeroConsentUrl.mockImplementation(async (state?: string) => {
      const url = new URL("https://login.xero.com/identity/connect/authorize");
      if (state) {
        url.searchParams.set("state", state);
      }
      return url.toString();
    });
    mockDisconnectFinanceXero.mockResolvedValue(undefined);
    mockHandleFinanceXeroCallback.mockResolvedValue(undefined);
  });

  it("returns finance status for a finance manager", async () => {
    mockGetFinanceXeroRouteStatus.mockResolvedValue({
      connected: true,
      tenantId: "finance-tenant-1",
      tokenExpiresAt: new Date("2026-04-20T00:00:00Z"),
      oauthConfigured: true,
      tokenStorageConfigured: true,
      canConnect: true,
      configIssues: [],
      tokenStorageIssues: [],
    });

    const response = await getFinanceXeroStatus();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connected: true,
      tenantId: "finance-tenant-1",
      oauthConfigured: true,
      tokenStorageConfigured: true,
      canConnect: true,
    });
  });

  it("rejects finance viewer access to the connect route", async () => {
    mockFindUnique.mockResolvedValue(viewerMember());

    const response = await connectFinanceXero(
      new Request("https://tokoroa.org.nz/api/finance/xero/connect")
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Finance manager access required",
    });
    expect(mockGetFinanceXeroConsentUrl).not.toHaveBeenCalled();
  });

  it("sets a finance-scoped OAuth state cookie before redirecting to Xero", async () => {
    const response = await connectFinanceXero(
      new Request("https://tokoroa.org.nz/api/finance/xero/connect")
    );

    expect(response.status).toBe(307);

    const location = response.headers.get("location");
    expect(location).toBeTruthy();

    const state = new URL(location!).searchParams.get("state");
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    expect(mockGetFinanceXeroConsentUrl).toHaveBeenCalledWith(state);

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain(`finance_xero_oauth_state=${state}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/api/finance/xero");
    expect(setCookie).toContain("Secure");
  });

  it("returns config issues instead of redirecting when finance Xero is not ready", async () => {
    mockGetFinanceXeroRouteStatus.mockResolvedValue({
      connected: false,
      tenantId: null,
      tokenExpiresAt: null,
      oauthConfigured: false,
      tokenStorageConfigured: false,
      canConnect: false,
      configIssues: ["FINANCE_XERO_CLIENT_ID is required"],
      tokenStorageIssues: ["FINANCE_XERO_ENCRYPTION_KEY is required"],
    });

    const response = await connectFinanceXero(
      new Request("https://tokoroa.org.nz/api/finance/xero/connect")
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Finance Xero is not configured",
      configIssues: ["FINANCE_XERO_CLIENT_ID is required"],
      tokenStorageIssues: ["FINANCE_XERO_ENCRYPTION_KEY is required"],
    });
    expect(mockGetFinanceXeroConsentUrl).not.toHaveBeenCalled();
  });

  it("requires authentication for disconnect", async () => {
    mockAuth.mockResolvedValue(null);

    const response = await disconnectFinanceXeroRoute();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorised",
    });
    expect(mockDisconnectFinanceXero).not.toHaveBeenCalled();
  });

  it("disconnects finance Xero for a finance manager", async () => {
    const response = await disconnectFinanceXeroRoute();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mockDisconnectFinanceXero).toHaveBeenCalledTimes(1);
  });

  it("accepts the finance callback only when the OAuth state matches the cookie", async () => {
    const state = "b".repeat(64);
    const request = new NextRequest(
      `http://internal:3000/api/finance/xero/callback?code=test-code&state=${state}`,
      {
        headers: {
          cookie: `finance_xero_oauth_state=${state}`,
        },
      }
    );

    const response = await handleFinanceXeroConnectCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://tokoroa.org.nz/finance?connected=true"
    );
    expect(mockHandleFinanceXeroCallback).toHaveBeenCalledWith(
      `https://tokoroa.org.nz/api/finance/xero/callback?code=test-code&state=${state}`,
      state
    );

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("finance_xero_oauth_state=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("Path=/api/finance/xero");
  });

  it("rejects the finance callback when the OAuth state is missing or mismatched", async () => {
    const request = new NextRequest(
      "http://internal:3000/api/finance/xero/callback?code=test-code&state=expected-state",
      {
        headers: {
          cookie: "finance_xero_oauth_state=wrong-state",
        },
      }
    );

    const response = await handleFinanceXeroConnectCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://tokoroa.org.nz/finance?error=Invalid%20finance%20Xero%20OAuth%20state.%20Please%20reconnect%20from%20the%20finance%20page."
    );
    expect(mockHandleFinanceXeroCallback).not.toHaveBeenCalled();
  });
});
