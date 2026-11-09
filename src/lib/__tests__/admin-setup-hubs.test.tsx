import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(),
}));
vi.mock("@/app/(admin)/admin/setup/permission-matrix", () => ({
  loadAdminSetupPermissionMatrix: vi.fn(),
}));
vi.mock("@/components/admin/finance-report-mappings-panel", () => ({
  FinanceReportMappingsPanel: () => <div>Finance mappings editor</div>,
}));
// #2307 (MG2-M-1): the Bookings Setup hub now carries the Member guests policy
// card, a client component whose view-only gate reads `useSession`. Stubbed for
// the same reason the finance panel above is — this suite renders SERVER pages
// to static markup with no SessionProvider, and what it is testing is which
// cards a hub page renders, not how any of them behaves. The card's own three
// states are covered by `member-guest-settings-card.test.tsx`.
vi.mock("@/components/admin/member-guest-settings-card", () => ({
  MemberGuestSettingsCard: ({ moduleEnabled }: { moduleEnabled: boolean }) => (
    <div>Member guests settings card (module {moduleEnabled ? "on" : "off"})</div>
  ),
}));
// #2573: the Integrations hub now carries the Google Analytics card, stubbed for
// exactly the same reason as the two above — it is a client component whose
// view-only gate reads `useSession`, and this suite renders SERVER pages to static
// markup with no SessionProvider. What is under test here is WHICH cards a hub
// renders and whether the hub survives a module being off; the card's own status
// states, validation, warnings and re-consent flow are covered by
// `analytics-integration-card.test.tsx`.
vi.mock("@/components/admin/analytics-integration-card", () => ({
  AnalyticsIntegrationCard: () => <div>Google Analytics integration card</div>,
}));

import AppearanceHubPage from "@/app/(admin)/admin/website/appearance/page";
import DisplayHubPage from "@/app/(admin)/admin/display/page";
import BookingsSetupHubPage from "@/app/(admin)/admin/rules/bookings-setup/page";
import FinanceSetupPage from "@/app/(admin)/admin/setup/finance/page";
import FoundationsSetupHubPage from "@/app/(admin)/admin/setup/foundations/page";
import { IntegrationReadinessSection } from "@/app/(admin)/admin/health/_components/integration-readiness-section";
import { AdminHubSectionCards } from "@/components/admin-hub-page";
import { BedDouble, Coins, MessageSquareText } from "lucide-react";
import IntegrationsHubPage from "@/app/(admin)/admin/integrations/page";
import MembershipSetupHubPage from "@/app/(admin)/admin/membership-setup/page";
import { loadAdminSetupPermissionMatrix } from "@/app/(admin)/admin/setup/permission-matrix";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;
const allAreasView: AdminPermissionMatrix = {
  ...emptyAdminPermissionMatrix(),
  overview: "view",
  bookings: "view",
  membership: "view",
  finance: "view",
  lodge: "view",
  content: "view",
  support: "view",
};

async function renderPage(Page: () => Promise<React.ReactNode>) {
  return renderToStaticMarkup(await Page());
}

describe("admin setup hub pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue(allOn);
    vi.mocked(loadAdminSetupPermissionMatrix).mockResolvedValue(allAreasView);
  });

  it("renders the Membership & Members hub cards", async () => {
    const html = await renderPage(MembershipSetupHubPage);

    expect(html).toContain("Membership &amp; Members");
    expect(html).toContain("Membership Types");
    expect(html).toContain("Member Fields");
    expect(html).toContain("Subscription Lockout");
  });

  it("renders the Lobby Display hub cards (fork issue #109)", async () => {
    const html = await renderPage(DisplayHubPage);

    expect(html).toContain("Lobby Display");
    // The four surfaces the old four-item sidebar group linked, now cards.
    expect(html).toContain("Devices");
    expect(html).toContain("/admin/display/devices");
    expect(html).toContain("Layouts");
    expect(html).toContain("/admin/display/layouts");
    expect(html).toContain("Templates");
    expect(html).toContain("/admin/display/templates");
    expect(html).toContain("Reference");
    expect(html).toContain("/admin/display/reference");
    // #2249: the guided setup wizard is reachable from the hub at all times.
    // These renders have no database, so the readiness counts fall back to
    // "already set up" and it appears as an ordinary card rather than the gold
    // lead card — which is exactly the always-available half of the entry-point
    // decision (the lead-vs-ordinary switch itself is pinned in
    // `src/app/(admin)/admin/display/__tests__/display-setup-entry.test.tsx`).
    expect(html).toContain("/admin/display/setup");
  });

  it("hides Lobby Display hub cards when the module is disabled", async () => {
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue({
      ...allOn,
      lobbyDisplay: false,
    });

    const html = await renderPage(DisplayHubPage);

    expect(html).not.toContain("/admin/display/devices");
    expect(html).not.toContain("/admin/display/layouts");
  });

  it("renders the Bookings Setup hub without the removed sidebar duplicate", async () => {
    const html = await renderPage(BookingsSetupHubPage);

    expect(html).toContain("Bookings Setup");
    expect(html).toContain("Rooms &amp; Beds");
    expect(html).toContain("Booking Messages");
    // S1 (#4796): the Booking Rules page's cards are merged in here.
    for (const href of [
      "/admin/booking-policies",
      "/admin/seasons",
      "/admin/age-tier-settings",
      "/admin/promo-codes",
      "/admin/rooms-beds",
      "/admin/booking-messages",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    // MG2-M-1 as ticked: the member-guest policy lives HERE rather than on a
    // new admin route, and it is threaded the module flag so it can render its
    // own not-in-use banner (MG2-M-4).
    expect(html).toContain("Member guests settings card (module on)");
  });

  it("shows a Booking Officer every Bookings Setup card they can open, and no other (S1 #4796)", async () => {
    vi.mocked(loadAdminSetupPermissionMatrix).mockResolvedValue({
      ...emptyAdminPermissionMatrix(),
      overview: "view",
      bookings: "edit",
    });

    const html = await renderPage(BookingsSetupHubPage);

    for (const href of [
      "/admin/booking-policies",
      "/admin/seasons",
      "/admin/age-tier-settings",
      "/admin/promo-codes",
      // Rooms & Beds opens on lodge OR bookings (#2937).
      "/admin/rooms-beds",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    // Booking Messages is `support`.
    expect(html).not.toContain('href="/admin/booking-messages"');
  });

  it("offers a hub card exactly when its page would open, OR admissions included (S1 #4796)", () => {
    const sections = [
      { href: "/admin/fees", title: "Fees", description: "d", icon: Coins },
      { href: "/admin/rooms-beds", title: "Rooms", description: "d", icon: BedDouble },
      { href: "/admin/booking-messages", title: "Messages", description: "d", icon: MessageSquareText },
    ];
    const cards = (permissionMatrix: AdminPermissionMatrix) =>
      renderToStaticMarkup(
        <AdminHubSectionCards sections={sections} features={allOn} permissionMatrix={permissionMatrix} />,
      );
    // The fee console opens on bookings OR finance; Rooms & Beds on lodge OR bookings.
    const financeOnly = cards({ ...emptyAdminPermissionMatrix(), finance: "view" });
    expect(financeOnly).toContain('href="/admin/fees"');
    expect(financeOnly).not.toContain('href="/admin/rooms-beds"');
    expect(financeOnly).not.toContain('href="/admin/booking-messages"');
    const bookingsOnly = cards({ ...emptyAdminPermissionMatrix(), bookings: "view" });
    expect(bookingsOnly).toContain('href="/admin/fees"');
    expect(bookingsOnly).toContain('href="/admin/rooms-beds"');
    expect(bookingsOnly).not.toContain('href="/admin/booking-messages"');
    const supportOnly = cards({ ...emptyAdminPermissionMatrix(), support: "view" });
    expect(supportOnly).not.toContain('href="/admin/fees"');
    expect(supportOnly).not.toContain('href="/admin/rooms-beds"');
    expect(supportOnly).toContain('href="/admin/booking-messages"');
  });

  it("hides Bookings Setup's module-gated card when the module is off", async () => {
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue({ ...allOn, promoCodes: false });

    const html = await renderPage(BookingsSetupHubPage);

    expect(html).not.toContain('href="/admin/promo-codes"');
    expect(html).toContain('href="/admin/seasons"');
  });

  it("shows feature-gated cards when their modules are enabled", async () => {
    const html = await renderPage(AppearanceHubPage);

    expect(html).toContain("Mountain Conditions");
    expect(html).toContain("/admin/mountain-conditions");
  });

  it("hides feature-gated cards when their modules are disabled", async () => {
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue({
      ...allOn,
      skifieldConditions: false,
    });

    const html = await renderPage(AppearanceHubPage);

    expect(html).not.toContain("Mountain Conditions");
    expect(html).not.toContain("/admin/mountain-conditions");
  });

  it("keeps the Integrations hub reachable with Xero off, hiding only the Xero card (#2216)", async () => {
    // The hub is no longer gated on xeroIntegration (#2216): it renders whenever
    // any integration module is on, and AdminHubPage filters each card by its
    // own feature href — so the Xero card drops out while the hub (and every
    // other integration card / back-link) stays reachable.
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue({
      ...allOn,
      xeroIntegration: false,
    });

    const html = await renderPage(IntegrationsHubPage);

    expect(html).toContain("Integrations");
    expect(html).not.toContain("Xero Setup");
    expect(html).not.toContain("/admin/xero/setup");
    // Other integration cards remain reachable from the hub.
    expect(html).toContain("/admin/stripe/setup");
    expect(html).toContain("/admin/backups");
  });

  it("renders the setup drill-down hub pages", async () => {
    const foundationHtml = await renderPage(FoundationsSetupHubPage);

    expect(foundationHtml).toContain("Initial Setup");
    expect(foundationHtml).toContain("/admin/modules");
    // E3 follow-up #1966: foundations cross-links the content-gated Club
    // Identity cards under Admin > Appearance.
    expect(foundationHtml).toContain("Club Identity");
    expect(foundationHtml).toContain("/admin/appearance/identity");
  });

  it("renders System Health's integration readiness, the old Operational Integrations page (S1 #4796)", () => {
    const html = renderToStaticMarkup(
      <IntegrationReadinessSection features={allOn} permissionMatrix={allAreasView} />,
    );

    expect(html).toContain('id="integration-readiness"');
    expect(html).toContain("Integration readiness");
    for (const href of [
      "/admin/xero/setup",
      "/admin/xero",
      "/admin/modules",
      "/admin/email-deliverability",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("shows each readiness card only where its module is on and the admin can view it", () => {
    const supportOnly = renderToStaticMarkup(
      <IntegrationReadinessSection
        features={allOn}
        permissionMatrix={{ ...emptyAdminPermissionMatrix(), support: "view" }}
      />,
    );
    expect(supportOnly).not.toContain('href="/admin/xero');
    expect(supportOnly).toContain('href="/admin/modules"');

    const xeroOff = renderToStaticMarkup(
      <IntegrationReadinessSection
        features={{ ...allOn, xeroIntegration: false }}
        permissionMatrix={allAreasView}
      />,
    );
    expect(xeroOff).not.toContain('href="/admin/xero');
    expect(xeroOff).toContain('href="/admin/email-deliverability"');
  });

  it("hides the Club Identity cross-link without content access (#1966)", async () => {
    vi.mocked(loadAdminSetupPermissionMatrix).mockResolvedValue({
      ...allAreasView,
      content: "none",
    });

    const html = await renderPage(FoundationsSetupHubPage);

    expect(html).not.toContain("Club Identity");
    expect(html).not.toContain("/admin/appearance/identity");
  });

  it("renders a back link to the Setup Wizard on every setup sub-hub", async () => {
    // The sub-hubs are drilled into from /admin/setup, so each gets the shared
    // BackLink (label matches the destination page's heading, "Setup Wizard").
    // Distinct from Foundations' own "Setup Checklist" card, which is a grid link.
    // Booking Rules, Cancellation and Operational Integrations are no longer
    // sub-hubs: S1 (#4796) merged them into the pages they linked to.
    const pages = [FoundationsSetupHubPage, FinanceSetupPage];
    for (const Page of pages) {
      const html = await renderPage(Page);
      expect(html).toContain("Setup Wizard");
      expect(html).toContain('href="/admin/setup"');
    }
  });

  it("keeps finance report mappings collapsed by default in the finance drill-down", async () => {
    const html = await renderPage(FinanceSetupPage);

    expect(html).toContain("Finance Dashboard");
    expect(html).toContain("Xero Mappings");
    expect(html).toContain("Finance Report Mappings");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).not.toContain("Finance mappings editor");
  });

  it("hides finance drill-down cards and mappings without finance access", async () => {
    vi.mocked(loadAdminSetupPermissionMatrix).mockResolvedValue({
      ...allAreasView,
      finance: "none",
    });

    const html = await renderPage(FinanceSetupPage);

    expect(html).not.toContain("Finance Dashboard");
    expect(html).not.toContain("Finance Report Mappings");
    expect(html).toContain(
      "Finance setup pages are not available for your current permissions",
    );
  });
});
