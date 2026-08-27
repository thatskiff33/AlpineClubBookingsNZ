// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  headers: vi.fn(),
  getWebsiteThemeRenderState: vi.fn(),
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
  // The admin layout now mounts the command palette, which calls useRouter.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: mocks.getWebsiteThemeRenderState,
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

// The layouts fetch current site banners; none are needed for gating tests
// (and the real module imports "server-only", which vitest cannot resolve).
vi.mock("@/lib/site-banners", () => ({
  getCurrentSiteBanners: vi.fn(async () => []),
}));

// The layouts now resolve DB-first club identity via the tagged public-layout
// cache (E3 #1929), whose real module imports "server-only" and wraps
// unstable_cache. Neutralise the guard and stub the accessor with the config
// identity — gating happens before/independent of the identity value.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-layout-config", async () => {
  const { clubIdentity } = await import("@/config/club-identity");
  return {
    getCachedClubIdentity: vi.fn(async () => clubIdentity),
    // #2322: the (website) layout reads the theme through the tagged cache
    // wrapper now. Delegate to the same stub so the existing "theme was read"
    // assertion still means what it says.
    getCachedWebsiteThemeRenderState: mocks.getWebsiteThemeRenderState,
    // #2573: the website chrome now resolves the club's Google Analytics runtime
    // configuration through the same tagged cache. `null` is the fail-closed answer
    // — no measurement ID saved, so no analytics — which is what this suite wants:
    // it is testing whether the website route group renders at all, not analytics.
    getCachedAnalyticsRuntimeConfig: vi.fn(async () => null),
  };
});

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

// The shared public chrome's own dependencies, none of which this file is about.
// `email-message-settings` is only read by the pre-setup branch (the DB-first
// contact address, C6 #1985), and the two components are chrome the header/footer
// stubs already stand in for.
vi.mock("@/lib/email-message-settings", () => ({
  loadEmailMessageSettings: vi.fn(async () => ({
    contactEmail: "info@example.org",
  })),
}));

vi.mock("@/components/site-banners", () => ({
  SiteBanners: () => null,
}));

vi.mock("@/components/analytics-consent", () => ({
  AnalyticsConsent: () => null,
}));

vi.mock("@/components/website-footer", () => ({
  WebsiteFooter: () => <footer>Website footer</footer>,
}));

vi.mock("@/components/admin-sidebar", () => ({
  AdminSidebar: () => <aside>Admin sidebar</aside>,
  ADMIN_NAV_SECTION_ORDER: [],
  getAdminFeatureSearchIndex: () => [],
}));

/*
  Chrome, like its sidebar sibling above — and now REQUIRED to be stubbed rather
  than merely tidy (#3123). This file mocks `AppProviders` down to a passthrough
  on purpose, because what it asserts is route-group gating and the real
  providers want data none of these cases supply. Since #3123 the palette reads
  the club's day from `ClubTimeProvider` (which `AppProviders` mounts), and
  `useClubTime()` throws when there is none — deliberately, so a tree that
  forgot the mount fails loudly instead of rendering a plausible wrong day. With
  the provider mocked away the only honest choice is to stub the component that
  needs it; the palette's own behaviour is covered by
  `admin-command-palette.test.tsx` and
  `admin-sidebar-club-time.test.tsx`, both of which mount a real provider.
*/
vi.mock("@/components/admin-command-palette", () => ({
  AdminCommandPalette: () => null,
}));

vi.mock("@/components/help-widget/help-widget-context", () => ({
  HelpWidgetProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useHelpWidgetExtras: () => {},
  useHelpWidgetHint: () => {},
  useHelpWidgetState: () => ({ extras: {}, hintGroup: null }),
}));

vi.mock("@/components/help-widget/help-widget-admin", () => ({
  HelpWidgetAdmin: () => <button type="button">Help</button>,
}));

vi.mock("@/components/help-widget/help-widget-public", () => ({
  HelpWidgetPublic: () => null,
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

import { WebsiteChrome } from "@/components/website/website-chrome";
import AdminLayout from "@/app/(admin)/layout";

/**
 * The public website's pre-setup gating, asserted where the branch now LIVES.
 *
 * It used to render `(website)/layout.tsx` directly. The D1 narrowing (3 Aug 2026)
 * extracted the whole chrome — holding screen included — into `WebsiteChrome`, and
 * the layout became three lines that resolve a nonce and compose it. Rendering the
 * layout through React Testing Library therefore stopped working entirely: it
 * returns an async server component, which RTL cannot render, so every assertion in
 * this file failed against an empty `<body><div /></body>` rather than against the
 * behaviour. That is why these cases render the chrome.
 *
 * Nothing is lost by moving down one level, and one thing is gained: the chrome is
 * composed by BOTH public route groups, so these cases now cover the three
 * `(website-dynamic)` pages as well. The layouts' own remaining job — which nonce
 * each hands the chrome, and that neither grows chrome of its own — is held by
 * `scripts/ci/check-website-render-modes.mjs`, which is a source-level check and
 * needs no renderer.
 */
const NONCE = "test-release-nonce";

describe("site style route-group gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.headers.mockResolvedValue(new Headers());
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      css: ":root{}",
      appCss: ".app-theme-scope{}",
      logoUrl: null,
      logoDataUrl: null,
      isComplete: false,
      values: {},
    });
    mocks.memberFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      role: "ADMIN",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN" }],
    });
    mocks.loadEffectiveModuleFlags.mockResolvedValue({});
  });

  it("holds the website route group until setup is complete", async () => {
    render(
      await WebsiteChrome({ nonce: NONCE, children: <p>Website child</p> }),
    );

    expect(screen.getByText("Site setup in progress")).toBeTruthy();
    expect(screen.queryByText("Website child")).toBeNull();
    expect(screen.queryByText("Website header")).toBeNull();
  });

  it("does NOT claim setup is in progress when the theme read merely FAILED", async () => {
    // #2420 review F4. `isComplete: false` used to mean both "this club has not
    // finished setup" and "the database did not answer". On a live club the
    // second reading turns a two-second blip into a "Site setup in progress"
    // page — served with 200 and, because `/` is allow-listed as anonymously
    // cacheable, stamped `public, max-age=60, stale-while-revalidate=300`. A
    // launch-state lie pinned in every visitor's cache for a minute.
    //
    // The chrome is only allowed to paint that screen on a POSITIVE answer. The
    // proxy gate keeps failing closed on the same input, and that asymmetry is
    // the point: 503 is a true statement about an unreadable database, a 200
    // holding screen is not.
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      css: ":root{}",
      appCss: ".app-theme-scope{}",
      logoUrl: null,
      logoDataUrl: null,
      isComplete: false,
      readFailed: true,
      values: {},
    });

    render(
      await WebsiteChrome({ nonce: NONCE, children: <p>Website child</p> }),
    );

    expect(screen.queryByText("Site setup in progress")).toBeNull();
    expect(screen.getByText("Website child")).toBeTruthy();
  });

  it("renders website children after setup is complete", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      css: ":root{}",
      appCss: ".app-theme-scope{}",
      logoUrl: null,
      logoDataUrl: null,
      isComplete: true,
      values: {},
    });

    render(
      await WebsiteChrome({ nonce: NONCE, children: <p>Website child</p> }),
    );

    expect(screen.getByText("Website child")).toBeTruthy();
    expect(screen.getByText("Website header")).toBeTruthy();
  });

  it("does not block the admin route group when setup is incomplete", async () => {
    mocks.getWebsiteThemeRenderState.mockResolvedValue({
      css: ":root{--success:red}",
      appCss: ".app-theme-scope{--brand-gold:#123456}",
      logoUrl: null,
      logoDataUrl: null,
      isComplete: false,
      values: {},
    });
    render(await AdminLayout({ children: <p>Admin child</p> }));

    expect(screen.getByText("Admin child")).toBeTruthy();
    expect(
      screen.getByText("Complete your site style before opening the public website."),
    ).toBeTruthy();
    const style = document.querySelector(
      'style[data-site-style="club-theme"]',
    );
    expect(style?.textContent).toContain("--brand-gold:#123456");
    expect(style?.textContent).not.toContain("--success:red");
    expect(mocks.getWebsiteThemeRenderState).toHaveBeenCalled();
  });
});
