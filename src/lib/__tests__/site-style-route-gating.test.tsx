// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  headers: vi.fn(),
  getWebsiteThemeRenderState: vi.fn(),
  isClubThemeComplete: vi.fn(),
  memberFindUnique: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: mocks.getWebsiteThemeRenderState,
  isClubThemeComplete: mocks.isClubThemeComplete,
}));

vi.mock("@/lib/club-theme-fonts", () => ({
  clubThemeFontVariableClassName: "font-vars",
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.memberFindUnique,
    },
  },
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceViewerAccess: () => false,
}));

vi.mock("@/lib/member-onboarding", () => ({
  MEMBER_ONBOARDING_GATE_SELECT: {
    id: true,
    active: true,
    forcePasswordChange: true,
    financeAccessLevel: true,
  },
  shouldShowMemberOnboarding: () => false,
}));

vi.mock("@/components/app-providers", () => ({
  AppProviders: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/website-header", () => ({
  WebsiteHeader: () => <header>Website header</header>,
}));

vi.mock("@/components/website-footer", () => ({
  WebsiteFooter: () => <footer>Website footer</footer>,
}));

vi.mock("@/components/admin-sidebar", () => ({
  AdminSidebar: () => <aside>Admin sidebar</aside>,
}));

vi.mock("@/components/nav-bar", () => ({
  NavBar: () => <nav>Admin nav</nav>,
}));

vi.mock("@/components/member-onboarding-wizard", () => ({
  MemberOnboardingWizard: () => null,
}));

vi.mock("@/components/report-issue-widget", () => ({
  ReportIssueWidget: () => null,
}));

import WebsiteLayout from "@/app/(website)/layout";
import AdminLayout from "@/app/(admin)/layout";

describe("site style route-group gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.headers.mockResolvedValue(new Headers());
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      css: ":root{}",
      logoDataUrl: null,
      isComplete: false,
      values: {},
    });
    mocks.isClubThemeComplete.mockResolvedValue(false);
    mocks.memberFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      financeAccessLevel: "NONE",
    });
    mocks.loadEffectiveModuleFlags.mockResolvedValue({});
  });

  it("holds the website route group until setup is complete", async () => {
    render(await WebsiteLayout({ children: <p>Website child</p> }));

    expect(screen.getByText("Site setup in progress")).toBeTruthy();
    expect(screen.queryByText("Website child")).toBeNull();
    expect(screen.queryByText("Website header")).toBeNull();
  });

  it("renders website children after setup is complete", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      css: ":root{}",
      logoDataUrl: null,
      isComplete: true,
      values: {},
    });

    render(await WebsiteLayout({ children: <p>Website child</p> }));

    expect(screen.getByText("Website child")).toBeTruthy();
    expect(screen.getByText("Website header")).toBeTruthy();
  });

  it("does not block the admin route group when setup is incomplete", async () => {
    render(await AdminLayout({ children: <p>Admin child</p> }));

    expect(screen.getByText("Admin child")).toBeTruthy();
    expect(
      screen.getByText("Complete your site style before opening the public website."),
    ).toBeTruthy();
  });
});
