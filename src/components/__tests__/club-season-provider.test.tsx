// @vitest-environment jsdom

/**
 * The club's financial year-end reaches the browser through the admin layout
 * (#5259), and a screen that reads it without that mount fails loudly.
 *
 * - **Bare hook throws.** A March fallback would hide a missing mount behind
 *   the very answer the issue was about.
 * - **The admin layout mounts it with the SERVER-resolved value.** Rendered
 *   through the real layout with the resolver answering June, so a layout that
 *   stopped awaiting it, or passed a constant, fails here.
 * - **Every consumer lives under the admin route group.** The provider is
 *   mounted there only, so a consumer anywhere else would throw in production
 *   while its own suite, standing under a test wrapper, stayed green.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { walk } from "@/lib/__tests__/support/provider-mount-census";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  headers: vi.fn(),
  memberFindUnique: vi.fn(),
  clubFinancialYearEndMonth: vi.fn(),
}));

vi.mock("@/lib/financial-year-server", () => ({
  clubFinancialYearEndMonth: mocks.clubFinancialYearEndMonth,
}));

// What follows is the admin layout's own dependencies, stubbed as
// `site-style-route-gating.test.tsx` stubs them; none is what this file is about.
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: vi.fn(async () => ({
    css: ":root{}",
    appCss: ".app-theme-scope{}",
    logoUrl: null,
    logoDataUrl: null,
    isComplete: true,
    values: {},
  })),
}));
vi.mock("@/lib/club-theme-fonts", () => ({
  clubThemeFontVariableClassName: "font-vars",
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findUnique: mocks.memberFindUnique } },
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => ({})),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-layout-config", async () => {
  const { clubIdentity } = await import("@/config/club-identity");
  return { getCachedClubIdentity: vi.fn(async () => clubIdentity) };
});
vi.mock("@/lib/member-onboarding", () => ({
  MEMBER_ONBOARDING_GATE_SELECT: {
    id: true,
    active: true,
    forcePasswordChange: true,
    financeAccessLevel: true,
  },
  shouldShowMemberOnboarding: () => false,
}));
// The real `AppProviders` is an async server component reading the zone and
// format; the test shell supplies the same two providers it mounts.
vi.mock("@/components/app-providers", async () => {
  const { ClubTimeTestProvider } = await import(
    "@/lib/__tests__/support/club-time-render"
  );
  return {
    AppProviders: ({ children }: { children: ReactNode }) => (
      <ClubTimeTestProvider>{children}</ClubTimeTestProvider>
    ),
  };
});
vi.mock("@/components/admin-sidebar", () => ({
  AdminSidebar: () => null,
  ADMIN_FEATURE_SEARCH_GROUP_ORDER: [],
  getAdminFeatureSearchIndex: () => [],
}));
vi.mock("@/components/admin-command-palette", () => ({
  AdminCommandPalette: () => null,
}));
vi.mock("@/components/help-widget/help-widget-context", () => ({
  HelpWidgetProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
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

import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { useClubSeason } from "@/components/club-season-provider";
import AdminLayout from "@/app/(admin)/layout";

function CurrentSeason() {
  const season = useClubSeason();
  return <p>{season.selectLabel(season.currentSeasonYear())}</p>;
}

describe("useClubSeason", () => {
  it("throws with no ClubSeasonProvider above it, rather than assume March", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<CurrentSeason />)).toThrow(
      /useClubSeason must be used within ClubSeasonProvider/,
    );
  });
});

describe("the admin layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mocks.headers.mockResolvedValue(new Headers());
    mocks.memberFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "ADMIN",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN" }],
    });
  });

  it("hands its pages the server-resolved year-end", async () => {
    // The frozen 1 July 2026 starts a June club's season 2026.
    mocks.clubFinancialYearEndMonth.mockResolvedValue(6);

    render(await AdminLayout({ children: <CurrentSeason /> }));

    expect(screen.getByText("2026 - 2027 (Jul-Jun)")).toBeTruthy();
    expect(mocks.clubFinancialYearEndMonth).toHaveBeenCalledTimes(1);
  });
});

describe("where useClubSeason may be called", () => {
  it("is imported only under the admin route group, which mounts the provider", () => {
    const src = path.join(process.cwd(), "src");
    const consumers = walk(src, (name) => /\.tsx?$/.test(name))
      .map((file) => path.relative(process.cwd(), file))
      .filter((file) => !file.includes("__tests__"))
      .filter((file) =>
        stripComments(readFileSync(file, "utf8")).includes(
          '"@/components/club-season-provider"',
        ),
      );

    // The scan found the screens this issue moved, so a broken walk cannot pass.
    expect(consumers).toContain("src/app/(admin)/admin/finance/subscriptions/page.tsx");
    expect(consumers).toContain("src/app/(admin)/layout.tsx");
    expect(consumers.filter((file) => !file.startsWith("src/app/(admin)/"))).toEqual([]);
  });
});
