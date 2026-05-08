import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockFindUnique } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
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

import { GET as getFinanceLegacyDashboardAuthRoute } from "@/app/api/finance/legacy-dashboard/auth/route";

function viewerSession() {
  return { user: { id: "finance-viewer-1", role: "MEMBER" } };
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

describe("finance legacy dashboard auth route", () => {
  beforeEach(() => {
    vi.stubEnv("NEXTAUTH_URL", "https://tokoroa.org.nz");
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(viewerSession());
    mockFindUnique.mockResolvedValue(viewerMember());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 204 for finance viewers", async () => {
    const response = await getFinanceLegacyDashboardAuthRoute(
      new NextRequest("https://tokoroa.org.nz/api/finance/legacy-dashboard/auth")
    );

    expect(response.status).toBe(204);
  });

  it("redirects unauthenticated requests to login with the legacy callback path", async () => {
    mockAuth.mockResolvedValue(null);

    const response = await getFinanceLegacyDashboardAuthRoute(
      new NextRequest("https://tokoroa.org.nz/api/finance/legacy-dashboard/auth")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://tokoroa.org.nz/login?callbackUrl=%2Ffinance-legacy%2F"
    );
  });

  it("redirects members without finance access to the member dashboard", async () => {
    mockFindUnique.mockResolvedValue({
      ...viewerMember(),
      financeAccessLevel: "NONE",
    });

    const response = await getFinanceLegacyDashboardAuthRoute(
      new NextRequest("https://tokoroa.org.nz/api/finance/legacy-dashboard/auth")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://tokoroa.org.nz/dashboard"
    );
  });

  it("redirects members who must change their password", async () => {
    mockFindUnique.mockResolvedValue({
      ...viewerMember(),
      forcePasswordChange: true,
    });

    const response = await getFinanceLegacyDashboardAuthRoute(
      new NextRequest("https://tokoroa.org.nz/api/finance/legacy-dashboard/auth")
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://tokoroa.org.nz/change-password"
    );
  });
});
