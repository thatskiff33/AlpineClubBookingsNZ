import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { REQUEST_PATH_HEADER } from "@/lib/internal-return-path";

const { mockAuth, mockRedirect, mockHeaders, mockRecordAuthBounce } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockRedirect: vi.fn(),
    mockHeaders: vi.fn(),
    mockRecordAuthBounce: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@/lib/auth-diagnostics", () => ({
  recordAuthBounce: (input: unknown) => mockRecordAuthBounce(input),
}));

// The layout now loads the app fonts (#1801); stub the loader so importing it
// stays light and does not pull in next/font/google under vitest.
vi.mock("@/lib/club-theme-fonts", () => ({
  clubThemeFontVariableClassName: "font-vars",
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

vi.mock("next/link", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: vi.fn() },
  },
}));

// The layout now resolves DB-first club identity via the tagged public-layout
// cache (E3 #1929). Its real module imports "server-only" (which vitest cannot
// resolve) and the identity read happens well after the auth redirect, so stub
// the accessor with the config identity to keep importing the layout light.
vi.mock("@/lib/public-layout-config", async () => {
  const { clubIdentity } = await import("@/config/club-identity");
  return { getCachedClubIdentity: vi.fn(async () => clubIdentity) };
});

// Stub the layout's UI dependencies so importing it stays light; the
// anonymous bounce path returns before any of these render.
vi.mock("@/components/app-providers", () => ({
  AppProviders: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/admin-sidebar", () => ({
  AdminSidebar: () => null,
  ADMIN_FEATURE_SEARCH_GROUP_ORDER: [],
  getAdminFeatureSearchIndex: () => [],
}));
vi.mock("@/components/help-widget/help-widget-context", () => ({
  HelpWidgetProvider: ({ children }: { children: ReactNode }) => children,
  useHelpWidgetExtras: () => {},
  useHelpWidgetHint: () => {},
  useHelpWidgetState: () => ({ extras: {}, hintGroup: null }),
}));
vi.mock("@/components/help-widget/help-widget-admin", () => ({
  HelpWidgetAdmin: () => null,
}));
vi.mock("@/components/nav-bar", () => ({ NavBar: () => null }));
vi.mock("@/components/member-onboarding-wizard", () => ({
  MemberOnboardingWizard: () => null,
}));
vi.mock("@/components/report-issue-widget", () => ({
  ReportIssueWidget: () => null,
}));

describe("admin layout auth bounce (#1669)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
    mockRecordAuthBounce.mockResolvedValue(null);
  });

  it("keeps the historical bare /login redirect for anonymous visitors", async () => {
    mockAuth.mockResolvedValue(null);
    mockHeaders.mockResolvedValue(
      new Headers({ [REQUEST_PATH_HEADER]: "/admin/members" })
    );

    const { default: AdminLayout } = await import("@/app/(admin)/layout");

    await expect(AdminLayout({ children: "secure" })).rejects.toThrow(
      "redirect:/login"
    );
    expect(mockRecordAuthBounce).toHaveBeenCalledWith({
      layout: "admin",
      requestedPath: "/admin/members",
    });
  });

  it("threads the auth-bounce reference code into the login URL", async () => {
    mockAuth.mockResolvedValue(null);
    mockHeaders.mockResolvedValue(
      new Headers({ [REQUEST_PATH_HEADER]: "/admin/members" })
    );
    mockRecordAuthBounce.mockResolvedValue("ABCD1234");

    const { default: AdminLayout } = await import("@/app/(admin)/layout");

    await expect(AdminLayout({ children: "secure" })).rejects.toThrow(
      "redirect:/login?callbackUrl=%2Fdashboard&ref=ABCD1234"
    );
  });

  it("still redirects cleanly when the bounce diagnostic rejects", async () => {
    mockAuth.mockResolvedValue(null);
    mockHeaders.mockResolvedValue(new Headers());
    mockRecordAuthBounce.mockRejectedValue(new Error("diagnostics exploded"));

    const { default: AdminLayout } = await import("@/app/(admin)/layout");

    await expect(AdminLayout({ children: "secure" })).rejects.toThrow(
      "redirect:/login"
    );
  });
});
