// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// #1940: several leaf pages now read the session permission matrix for view-only
// gating; provide an edit-level admin session so the back-link render succeeds.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

// The leaf pages embed heavy client panels/sections that fetch on mount; the
// back-link lives at the top of each page's render, so stub the panels out and
// assert only that every drill-down leaf points at its current parent hub.
vi.mock("@/components/admin/booking-policies/booking-periods-section", () => ({
  BookingPeriodsSection: () => null,
}));
vi.mock("@/components/admin/site-content-panel", () => ({
  SiteContentPanel: () => null,
}));
// The Lodge display settings sub-page (#110) renders a client card that fetches
// on mount; only its top-of-page BackLink matters here, so stub the card.
vi.mock(
  "@/app/(admin)/admin/lodges/[id]/_components/lodge-display-settings-card",
  () => ({ LodgeDisplaySettingsCard: () => null }),
);
// #2046 F2: stub the Xero record activity loader + its heavy client panel so the
// async server component renders down to its top-of-page BackLink only.
vi.mock("@/lib/xero-record-activity", () => ({
  getXeroRecordActivity: async () => ({
    rootRecord: { label: "Booking BK-7", relation: "Booking" },
    scopeRecords: [],
    relatedRecords: [],
    backLink: { href: "/admin/bookings", label: "Bookings" },
  }),
}));
vi.mock("@/components/admin/xero-record-activity-panel", () => ({
  XeroRecordActivityPanel: () => null,
}));
// #2249: the Lobby Display guided setup wizard is a leaf whose only await is the
// `lobbyDisplay` module flag, and whose body is a heavy client wizard that
// fetches on mount. Stub both so the async server component renders down to its
// top-of-page BackLink. The flag is stubbed OFF on purpose: this page stays
// reachable while the module is off (that is what its first step fixes), and the
// back-link must render in exactly that state.
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: async () => ({ lobbyDisplay: false }),
}));
vi.mock("@/app/(admin)/admin/display/setup/display-setup-wizard", () => ({
  DisplaySetupWizard: () => null,
}));
// #2046 F6: the Induction Settings leaf drills in from the Induction Register;
// stub its two client panels so only the top-of-page BackLink is asserted.
vi.mock("@/components/admin/induction-settings-panel", () => ({
  InductionSettingsPanel: () => null,
}));
vi.mock("@/components/admin/induction-template-manager", () => ({
  InductionTemplateManager: () => null,
}));

import BookingPeriodsPage from "@/app/(admin)/admin/booking-policies/periods/page";
import AdminMembershipTypesPage from "@/app/(admin)/admin/membership-types/page";
import SiteContentAdminPage from "@/app/(admin)/admin/site-content/page";
// #2046: the five Lobby Display leaves and the converted [id]-aware drill-downs.
import DisplayDevicesPage from "@/app/(admin)/admin/display/devices/page";
import DisplayLayoutsPage from "@/app/(admin)/admin/display/layouts/page";
import DisplayTemplatesPage from "@/app/(admin)/admin/display/templates/page";
import DisplayReferencePage from "@/app/(admin)/admin/display/reference/page";
import DisplayPreviewPage from "@/app/(admin)/admin/display/preview/page";
// #2048: the visual builder is a statically-renderable Lobby Display leaf (its
// header renders before the loading/fetch gate), so it joins the frozen suite.
import DisplayBuilderPage from "@/app/(admin)/admin/display/builder/page";
// #2249: the guided setup wizard, the sixth Lobby Display leaf.
import DisplaySetupPage from "@/app/(admin)/admin/display/setup/page";
import LodgeDisplaySettingsPage from "@/app/(admin)/admin/lodges/[id]/display/page";
import XeroRecordActivityPage from "@/app/(admin)/admin/xero/records/[localModel]/[localId]/page";
import AdminInductionSettingsPage from "@/app/(admin)/admin/induction/settings/page";
import { MemberDetailHeader } from "@/app/(admin)/admin/members/[id]/_components/member-detail-header";

describe("admin drill-down leaf back links", () => {
  it("points a Booking Policies leaf back at the Booking Policies hub (replaced inline link)", () => {
    const html = renderToStaticMarkup(<BookingPeriodsPage />);

    expect(html).toContain('href="/admin/booking-policies"');
    expect(html).toContain("← Booking Policies");
  });

  it("points the Membership Types leaf back at the Membership & Members hub (new link — owner finding 7)", () => {
    const html = renderToStaticMarkup(<AdminMembershipTypesPage />);

    expect(html).toContain('href="/admin/membership-setup"');
    expect(html).toContain("← Membership &amp; Members");
  });

  it("points a Site Appearance leaf back at the Site Appearance & Content hub (new link)", () => {
    const html = renderToStaticMarkup(<SiteContentAdminPage />);

    expect(html).toContain('href="/admin/appearance"');
    expect(html).toContain("← Site Appearance &amp; Content");
  });

  // #2046 F6: the Induction Settings leaf replaced its ad-hoc outline button
  // ("Induction register") with the shared BackLink to the register.
  it("points the Induction Settings leaf back at the Induction Register", () => {
    const html = renderToStaticMarkup(<AdminInductionSettingsPage />);

    expect(html).toContain('href="/admin/induction"');
    expect(html).toContain("← Induction Register");
  });

  // #2046: the five Lobby Display leaves each drilled into from /admin/display
  // (Preview is reached from Templates). Every one must carry the shared BackLink
  // to its STATIC parent hub. Adding a leaf here without a BackLink fails the test.
  it.each([
    ["Devices", DisplayDevicesPage, "/admin/display", "← Lobby Display"],
    ["Layouts", DisplayLayoutsPage, "/admin/display", "← Lobby Display"],
    ["Templates", DisplayTemplatesPage, "/admin/display", "← Lobby Display"],
    ["Reference", DisplayReferencePage, "/admin/display", "← Lobby Display"],
    ["Builder", DisplayBuilderPage, "/admin/display", "← Lobby Display"],
    [
      "Preview",
      DisplayPreviewPage,
      "/admin/display/templates",
      "← Display Templates",
    ],
  ])(
    "points the Lobby Display %s leaf back at its parent hub",
    (_name, Page, href, label) => {
      const html = renderToStaticMarkup(<Page />);

      expect(html).toContain(`href="${href}"`);
      expect(html).toContain(label);
    },
  );

  // #2249: the guided setup wizard is an async server component (its one await
  // is the module flag), so it takes its own case rather than joining the
  // synchronous it.each above. It is the one leaf that is reachable while its
  // parent hub is feature-gated OFF, which is exactly why its back-link matters:
  // it is the operator's only way out of the wizard.
  it("points the Lobby Display guided setup wizard back at its parent hub", async () => {
    const html = renderToStaticMarkup(await DisplaySetupPage());

    expect(html).toContain('href="/admin/display"');
    expect(html).toContain("← Lobby Display");
  });

  // #2046: ad-hoc ArrowLeft back-links normalised onto BackLink. The [id]-aware
  // targets carry a dynamic href (the parent is itself a drill-down record, not a
  // static hub) — the shared BackLink already takes an arbitrary href/label, so
  // the dynamic-parent variant needs no new component, only a resolved href.
  it("points the per-lodge Display settings sub-page back at its lodge (dynamic [id] parent)", async () => {
    const html = renderToStaticMarkup(
      await LodgeDisplaySettingsPage({
        params: Promise.resolve({ id: "lodge-42" }),
      }),
    );

    expect(html).toContain('href="/admin/lodges/lodge-42"');
    expect(html).toContain("← Lodge configuration");
  });

  it("points the Member detail header back at its caller-provided origin (dynamic returnTo parent)", () => {
    const html = renderToStaticMarkup(
      <MemberDetailHeader
        {...({
          member: {
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.test",
            accessRoles: [],
          },
          backHref: "/admin/members",
          backLabel: "Members",
          isAdultMember: true,
          memberIsArchived: false,
          pendingDeleteRequest: undefined,
          xeroConnected: null,
          xeroPushing: false,
          xeroUnlinking: false,
          onOpenDependentDialog: () => {},
          onOpenLinkXero: () => {},
          onOpenCreateXero: () => {},
          onUnlinkXero: () => {},
        } as unknown as ComponentProps<typeof MemberDetailHeader>)}
      />,
    );

    expect(html).toContain('href="/admin/members"');
    expect(html).toContain("← Members");
  });

  // #2046 F2: the Xero record activity page is an async server component whose
  // only await is the activity loader; mock the loader and stub the heavy client
  // panel so the top-of-page BackLink renders in isolation (mirrors the
  // async-loader stubbing pattern in admin-setup-hubs.test.tsx). Its parent is a
  // dynamic returnTo — here the record's own scope back-link resolved from the
  // loader — so this closes the static-render gap for the dynamic-parent variant.
  it("points the Xero record activity page back at its resolved parent (dynamic returnTo)", async () => {
    const html = renderToStaticMarkup(
      await XeroRecordActivityPage({
        params: Promise.resolve({ localModel: "Booking", localId: "book-7" }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(html).toContain('href="/admin/bookings"');
    expect(html).toContain("← Bookings");
  });
});

// The remaining #2046 conversions render behind a client data gate ("use
// client" pages that read params/session and fetch on mount), so they are not
// statically renderable in this server-render suite. They are NOT enforced by
// lint here — ArrowLeft/Link/Button stay imported for other uses in each file,
// so deleting a BackLink usage would pass typecheck and lint. They are instead
// covered by render tests in the companion RTL suite
// `admin-drilldown-back-links-client.test.tsx`, which drives a failed/benign
// fetch to reach each converted affordance:
//   - src/app/(admin)/admin/lodges/[id]/page.tsx (error fallback → /admin/lodges)
//   - src/app/(admin)/admin/lodges/[id]/setup/page.tsx (main → lodge config; and
//     the "not found" fallback → /admin/lodges)
//   - src/app/(admin)/admin/members/[id]/page.tsx (error fallback → returnTo)
//   - src/app/(admin)/admin/members/[id]/merge/page.tsx (→ master member)
// The Xero record activity page (dynamic returnTo) is covered by the async
// server-render case immediately above.
