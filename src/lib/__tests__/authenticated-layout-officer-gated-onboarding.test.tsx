/**
 * A gated officer is not shown the onboarding wizard (#4620).
 *
 * Past grace, the officer rule (#4618) leaves an officer one signed-in page:
 * their profile, where they add a passkey. The onboarding wizard is rendered
 * by this layout over every page, cannot be dismissed, and saves through
 * routes the same gate refuses. Shown there it would cover the passkey card
 * and could never be completed, so the layout holds it back until the officer
 * has enrolled. An officer still inside grace, and every other member, sees
 * it as before.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  headers: vi.fn(),
  memberFindUnique: vi.fn(),
  wizard: vi.fn(),
  graceBanner: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mocks.auth() }));
vi.mock("next/headers", () => ({ headers: () => mocks.headers() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    booking: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/hut-leader", () => ({
  hasActiveHutLeaderAssignment: vi.fn(async () => false),
}));
vi.mock("@/lib/club-theme-fonts", () => ({
  clubThemeFontVariableClassName: "font-vars",
}));
vi.mock("@/lib/site-banners", () => ({
  getCurrentSiteBanners: vi.fn(async () => []),
}));
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: vi.fn(async () => ({ appCss: "" })),
}));
vi.mock("@/lib/public-layout-config", async () => {
  const { clubIdentity } = await import("@/config/club-identity");
  return { getCachedClubIdentity: vi.fn(async () => clubIdentity) };
});
// Partial: `@/config/club-identity` also reads FALLBACK_LODGE_CAPACITY from
// this module at import time, so the real exports have to stay in place.
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultLodgeCapacity: vi.fn(async () => 30),
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => ({ aiAssistant: false })),
}));
vi.mock("@/lib/ai-assistant-config", () => ({
  getAiAssistantAvailability: vi.fn(async () => false),
}));
vi.mock("@/lib/club-time-zone-settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getClubTimeZone: vi.fn(async () => "Pacific/Auckland"),
}));
vi.mock("@/components/app-providers", () => ({
  AppProviders: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/nav-bar", () => ({ NavBar: () => null }));
vi.mock("@/components/site-banners", () => ({ SiteBanners: () => null }));
vi.mock("@/components/member-onboarding-wizard", () => ({
  MemberOnboardingWizard: (props: { initialShouldShow: boolean }) => {
    mocks.wizard(props);
    return null;
  },
}));
vi.mock("@/components/officer-grace-banner", () => ({
  OfficerGraceBanner: (props: { endsAt: number | null }) => {
    mocks.graceBanner(props);
    return null;
  },
}));
vi.mock("@/components/report-issue-widget", () => ({
  ReportIssueWidget: () => null,
}));
vi.mock("@/components/help-widget/help-widget-context", () => ({
  HelpWidgetProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/help-widget/help-widget-member", () => ({
  HelpWidgetMember: () => null,
}));

import AuthenticatedLayout from "@/app/(authenticated)/layout";
import { REQUEST_PATH_HEADER } from "@/lib/internal-return-path";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** An officer whose own details are not yet confirmed, so the wizard is owed. */
const OFFICER_OWING_ONBOARDING = {
  id: "officer-1",
  active: true,
  canLogin: true,
  forcePasswordChange: false,
  twoFactorEnabled: false,
  role: "ADMIN",
  accessRoles: ["USER", "ADMIN"],
  onboardingConfirmedAt: null,
};

async function renderProfile(sessionUser: Record<string, unknown>) {
  mocks.auth.mockResolvedValue({
    user: { id: "officer-1", name: "Olive Officer", email: "o@example.test", ...sessionUser },
  });
  renderToStaticMarkup(await AuthenticatedLayout({ children: "profile page" }));
  return {
    wizardShown: (mocks.wizard.mock.calls.at(-1)?.[0] as { initialShouldShow: boolean })
      .initialShouldShow,
    graceBannerShown: mocks.graceBanner.mock.calls.length > 0,
  };
}

describe("authenticated layout: onboarding wizard for a gated officer (#4620)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(NOW);
    mocks.headers.mockResolvedValue(new Headers({ [REQUEST_PATH_HEADER]: "/profile" }));
    mocks.memberFindUnique.mockResolvedValue(OFFICER_OWING_ONBOARDING);
  });

  it("holds the wizard back once grace has ended, so the passkey card is reachable", async () => {
    const shown = await renderProfile({
      officerTwoFactorRequired: true,
      twoFactorSatisfiesOfficer: false,
      officerTwoFactorGraceEndsAt: NOW.getTime() - DAY_MS,
    });

    expect(shown).toEqual({ wizardShown: false, graceBannerShown: false });
  });

  it("still shows the wizard, and the reminder, while grace is running", async () => {
    const shown = await renderProfile({
      officerTwoFactorRequired: true,
      twoFactorSatisfiesOfficer: false,
      officerTwoFactorGraceEndsAt: NOW.getTime() + DAY_MS,
    });

    expect(shown).toEqual({ wizardShown: true, graceBannerShown: true });
  });

  it("still shows the wizard to an officer who has enrolled and to an ordinary member", async () => {
    const enrolled = await renderProfile({
      officerTwoFactorRequired: true,
      twoFactorSatisfiesOfficer: true,
      officerTwoFactorGraceEndsAt: null,
    });
    const member = await renderProfile({});

    expect(enrolled).toEqual({ wizardShown: true, graceBannerShown: false });
    expect(member).toEqual({ wizardShown: true, graceBannerShown: false });
  });
});
