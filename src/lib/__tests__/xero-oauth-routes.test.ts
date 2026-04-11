import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockRequireActiveSessionUser, mockGetXeroConsentUrl, mockHandleXeroCallback } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockRequireActiveSessionUser: vi.fn().mockResolvedValue(null),
    mockGetXeroConsentUrl: vi.fn(),
    mockHandleXeroCallback: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));

vi.mock("@/lib/xero", () => ({
  getXeroConsentUrl: mockGetXeroConsentUrl,
  handleXeroCallback: mockHandleXeroCallback,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { GET as connectXero } from "@/app/api/admin/xero/connect/route";
import { GET as handleXeroConnectCallback } from "@/app/api/admin/xero/callback/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN" } } as const;

describe("Xero OAuth admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXTAUTH_URL", "https://tokoroa.org.nz");
    mockAuth.mockResolvedValue(adminSession);
    mockGetXeroConsentUrl.mockImplementation(async (state?: string) => {
      const url = new URL("https://login.xero.com/identity/connect/authorize");
      if (state) {
        url.searchParams.set("state", state);
      }
      return url.toString();
    });
    mockHandleXeroCallback.mockResolvedValue(undefined);
  });

  it("sets a scoped OAuth state cookie before redirecting to Xero", async () => {
    const response = await connectXero(new Request("https://tokoroa.org.nz/api/admin/xero/connect"));

    expect(response.status).toBe(307);

    const location = response.headers.get("location");
    expect(location).toBeTruthy();

    const state = new URL(location!).searchParams.get("state");
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    expect(mockGetXeroConsentUrl).toHaveBeenCalledWith(state);

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain(`xero_oauth_state=${state}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/api/admin/xero");
    expect(setCookie).toContain("Secure");
  });

  it("accepts a callback only when the OAuth state matches the cookie", async () => {
    const state = "a".repeat(64);
    const request = new NextRequest(
      `http://internal:3000/api/admin/xero/callback?code=test-code&state=${state}`,
      {
        headers: {
          cookie: `xero_oauth_state=${state}`,
        },
      }
    );

    const response = await handleXeroConnectCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://tokoroa.org.nz/admin/xero?connected=true");
    expect(mockHandleXeroCallback).toHaveBeenCalledWith(
      `https://tokoroa.org.nz/api/admin/xero/callback?code=test-code&state=${state}`,
      state
    );

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("xero_oauth_state=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("Path=/api/admin/xero");
  });

  it("rejects a callback when the OAuth state is missing or mismatched", async () => {
    const request = new NextRequest(
      "http://internal:3000/api/admin/xero/callback?code=test-code&state=expected-state",
      {
        headers: {
          cookie: "xero_oauth_state=wrong-state",
        },
      }
    );

    const response = await handleXeroConnectCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://tokoroa.org.nz/admin/xero?error=Invalid%20Xero%20OAuth%20state.%20Please%20reconnect%20from%20the%20admin%20page."
    );
    expect(mockHandleXeroCallback).not.toHaveBeenCalled();

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("xero_oauth_state=");
    expect(setCookie).toContain("Max-Age=0");
  });
});
