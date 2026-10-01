import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockRequireActiveSessionUser, mockGetXeroConsentUrl, mockHandleXeroCallback, mockLogger } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockRequireActiveSessionUser: vi.fn().mockResolvedValue(null),
    mockGetXeroConsentUrl: vi.fn(),
    mockHandleXeroCallback: vi.fn(),
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));

vi.mock("@/lib/xero", () => ({
  getXeroConsentUrl: mockGetXeroConsentUrl,
  handleXeroCallback: mockHandleXeroCallback,
}));

vi.mock("@/lib/logger", () => ({
  default: mockLogger,
}));

import { GET as connectXero } from "@/app/api/admin/xero/connect/route";
import { GET as handleXeroConnectCallback } from "@/app/api/admin/xero/callback/route";
import {
  toSafeXeroOAuthCallbackMessage,
  XERO_OAUTH_CALLBACK_GENERIC_MESSAGE,
  XERO_OAUTH_CALLBACK_INVALID_STATE_MESSAGE,
  XERO_OAUTH_CALLBACK_NO_TENANT_MESSAGE,
} from "@/lib/xero-oauth-callback-messages";

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as const;

describe("Xero OAuth admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXTAUTH_URL", "https://example.org");
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
    const response = await connectXero(
      new Request("https://www.example.org/api/admin/xero/connect")
    );

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
    expect(setCookie).toContain("Domain=example.org");
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
    expect(response.headers.get("location")).toBe("https://example.org/admin/xero?connected=true");
    expect(mockHandleXeroCallback).toHaveBeenCalledWith(
      `https://example.org/api/admin/xero/callback?code=test-code&state=${state}`,
      state,
      // #3454: the connect is recorded as this administrator's act.
      expect.objectContaining({ actor: { kind: "admin", memberId: "admin-1" } }),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        callbackPath: "/api/admin/xero/callback",
        hasCode: true,
        hasState: true,
      },
      "Processing Xero OAuth callback"
    );

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("xero_oauth_state=");
    expect(setCookie).toContain("Domain=example.org");
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
      "https://example.org/admin/xero?error=Invalid%20Xero%20OAuth%20state.%20Please%20reconnect%20from%20the%20admin%20page."
    );
    expect(mockHandleXeroCallback).not.toHaveBeenCalled();

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("xero_oauth_state=");
    expect(setCookie).toContain("Domain=example.org");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("does not reflect provider callback error details into the redirect URL", async () => {
    const state = "b".repeat(64);
    mockHandleXeroCallback.mockRejectedValue(
      new Error(
        "Xero apiCallback failed for https://example.org/api/admin/xero/callback?code=secret-code&state=secret-state"
      )
    );

    const response = await handleXeroConnectCallback(
      new NextRequest(
        `http://internal:3000/api/admin/xero/callback?code=test-code&state=${state}`,
        {
          headers: {
            cookie: `xero_oauth_state=${state}`,
          },
        }
      )
    );

    const location = response.headers.get("location");
    expect(response.status).toBe(307);
    expect(location).toBe(
      "https://example.org/admin/xero?error=Xero%20connection%20failed.%20Please%20reconnect%20from%20the%20admin%20page."
    );
    expect(location).not.toContain("secret-code");
    expect(location).not.toContain("secret-state");
  });
});

// #2394 review, F9. The callback's error message travels back as `?error=` and
// is now rendered in a danger-styled box on TWO admin pages, so the same
// allow-list has to be enforced when READING the query string — not only when
// writing it. React escapes the value, so this is not XSS; it is a phishing
// surface, and a crafted link would otherwise put attacker-chosen prose of
// unbounded length into an authoritative-looking red banner on a trusted page.
describe("toSafeXeroOAuthCallbackMessage (the read side of ?error=)", () => {
  it("passes our own three messages through unchanged", () => {
    for (const message of [
      XERO_OAUTH_CALLBACK_INVALID_STATE_MESSAGE,
      XERO_OAUTH_CALLBACK_NO_TENANT_MESSAGE,
      XERO_OAUTH_CALLBACK_GENERIC_MESSAGE,
    ]) {
      expect(toSafeXeroOAuthCallbackMessage(message)).toBe(message);
    }
  });

  it("collapses anything else to the generic message rather than rendering it", () => {
    expect(
      toSafeXeroOAuthCallbackMessage(
        "Your Xero session was suspended. Call 0800-000-000 to restore it.",
      ),
    ).toBe(XERO_OAUTH_CALLBACK_GENERIC_MESSAGE);
    // Including a near-miss of one of ours, and something enormous.
    expect(
      toSafeXeroOAuthCallbackMessage("Invalid Xero OAuth state."),
    ).toBe(XERO_OAUTH_CALLBACK_GENERIC_MESSAGE);
    expect(toSafeXeroOAuthCallbackMessage("x".repeat(5000))).toBe(
      XERO_OAUTH_CALLBACK_GENERIC_MESSAGE,
    );
  });

  it("says nothing at all when there was no error", () => {
    expect(toSafeXeroOAuthCallbackMessage(null)).toBeNull();
    expect(toSafeXeroOAuthCallbackMessage(undefined)).toBeNull();
    expect(toSafeXeroOAuthCallbackMessage("")).toBeNull();
  });
});
