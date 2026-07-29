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

import AppearanceHubPage from "@/app/(admin)/admin/appearance/page";
import DisplayHubPage from "@/app/(admin)/admin/display/page";
import BookingsSetupHubPage from "@/app/(admin)/admin/bookings-setup/page";
import BookingRulesSetupHubPage from "@/app/(admin)/admin/setup/booking-rules/page";
import CancellationSetupHubPage from "@/app/(admin)/admin/setup/cancellation/page";
import FinanceSetupPage from "@/app/(admin)/admin/setup/finance/page";
import FoundationsSetupHubPage from "@/app/(admin)/admin/setup/foundations/page";
import OperationalIntegrationsSetupHubPage from "@/app/(admin)/admin/setup/integrations/page";
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

  it("renders the new setup drill-down hub pages", async () => {
    const foundationHtml = await renderPage(FoundationsSetupHubPage);
    const bookingHtml = await renderPage(BookingRulesSetupHubPage);
    const integrationsHtml = await renderPage(
      OperationalIntegrationsSetupHubPage,
    );
    const cancellationHtml = await renderPage(CancellationSetupHubPage);

    expect(foundationHtml).toContain("Initial Setup");
    expect(foundationHtml).toContain("/admin/modules");
    // E3 follow-up #1966: foundations cross-links the content-gated Club
    // Identity cards under Admin > Appearance.
    expect(foundationHtml).toContain("Club Identity");
    expect(foundationHtml).toContain("/admin/appearance/identity");
    expect(bookingHtml).toContain("Booking Rules");
    expect(bookingHtml).toContain("/admin/booking-policies");
    expect(integrationsHtml).toContain("Operational Integrations");
    expect(integrationsHtml).toContain("/admin/xero/setup");
    expect(cancellationHtml).toContain("Cancellation");
    expect(cancellationHtml).toContain("/admin/membership-cancellation");
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
    const pages = [
      FoundationsSetupHubPage,
      BookingRulesSetupHubPage,
      CancellationSetupHubPage,
      OperationalIntegrationsSetupHubPage,
      FinanceSetupPage,
    ];
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
