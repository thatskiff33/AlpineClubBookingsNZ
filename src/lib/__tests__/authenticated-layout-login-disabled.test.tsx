import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * The member layout refuses a member whose login is switched off (#3603). The
 * token refresh already ends such a session; this is the same rule at the
 * layout, for a session that reaches it first.
 *
 * The member re-read is projected through the layout's own `select`, so a
 * field it stops selecting stops reaching the check. Every other database read
 * the layout makes AFTER its account gate throws `PASSED_THE_GATE`, which is how
 * the admitted control proves the gate let the same member through.
 */

const { mockAuth, mockRedirect, mockFindUnique } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRedirect: vi.fn(),
  mockFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/auth-diagnostics", () => ({ recordAuthBounce: vi.fn(async () => null) }));
vi.mock("@/lib/club-theme-fonts", () => ({ clubThemeFontVariableClassName: "font-vars" }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => mockRedirect(path) }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-pathname": "/dashboard" })),
}));
vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  const passedTheGate = () => {
    throw new Error("PASSED_THE_GATE");
  };
  const member = { findUnique: honourSelect(mockFindUnique) };
  return {
    prisma: new Proxy({ member } as Record<string, unknown>, {
      get: (target, key) =>
        key in target
          ? target[key as string]
          : new Proxy({}, { get: () => passedTheGate }),
    }),
  };
});
vi.mock("@/lib/site-banners", () => ({ getCurrentSiteBanners: vi.fn(async () => []) }));
vi.mock("@/lib/public-layout-config", async () => {
  const { clubIdentity } = await import("@/config/club-identity");
  return { getCachedClubIdentity: vi.fn(async () => clubIdentity) };
});
vi.mock("@/components/app-providers", () => ({
  AppProviders: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/nav-bar", () => ({ NavBar: () => null }));
vi.mock("@/components/member-onboarding-wizard", () => ({ MemberOnboardingWizard: () => null }));
vi.mock("@/components/report-issue-widget", () => ({ ReportIssueWidget: () => null }));

function memberRow(canLogin: boolean) {
  return {
    id: "member-1",
    active: true,
    canLogin,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    firstName: "Test",
    lastName: "Member",
    email: "member@example.org",
    role: "USER",
    accessRoles: [{ role: "USER", roleDefinitionId: null, roleDefinition: null }],
  };
}

async function runLayout(): Promise<string> {
  const { default: AuthenticatedLayout } = await import("@/app/(authenticated)/layout");
  try {
    await AuthenticatedLayout({ children: "secure" });
    return "rendered";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("the member layout and a login-disabled member (#3603)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
    mockAuth.mockResolvedValue({
      user: {
        id: "member-1",
        role: "USER",
        accessRoles: ["USER"],
        canLogin: true,
        twoFactorRequired: false,
      },
    });
  });

  it("redirects a member whose login is switched off to login", async () => {
    mockFindUnique.mockResolvedValue(memberRow(false));
    await expect(runLayout()).resolves.toBe("redirect:/login");
  });

  it("lets the same member through with login enabled", async () => {
    mockFindUnique.mockResolvedValue(memberRow(true));
    await expect(runLayout()).resolves.toBe("PASSED_THE_GATE");
  });
});
