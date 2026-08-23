// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  ADMIN_VIEW_ONLY_SECTION_HEADING,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";

// useAdminAreaEditAccess reads the merged matrix off the session user; drive it
// per-test so the panels see a content:edit vs content:view admin.
let sessionMatrix: AdminPermissionMatrix | null = null;
// Resolution state of the client session. Defaults to "authenticated" so every
// existing case behaves as fully-resolved; the #2065 resolving-state cases set
// it to "loading" to exercise the tri-state neutral rendering.
let sessionStatus: "loading" | "authenticated" | "unauthenticated" =
  "authenticated";
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: sessionMatrix
      ? { user: { id: "u1", adminPermissionMatrix: sessionMatrix } }
      : null,
    status: sessionStatus,
  }),
}));

// SiteStyleWizard calls useRouter().refresh() after a save; the render-only
// cases here never save, so a stub router is enough.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ id: "lodge-1" }),
  useSearchParams: () => new URLSearchParams(),
}));

// Default matrix sets both content and lodge to `level`; pass overrides to
// split them (the LodgeInstructionsPanel cases below cross the two areas).
function matrix(
  level: "view" | "edit",
  overrides: Partial<AdminPermissionMatrix> = {},
): AdminPermissionMatrix {
  return {
    overview: "view",
    bookings: "view",
    membership: "view",
    finance: "view",
    lodge: level,
    content: level,
    support: "view",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const LODGE = { id: "lodge-1", name: "Lodge One" };

// URL-prefix-routed fetch stub. These are render-only case pairs, so every
// matched route answers with its canned body regardless of method; unknown
// URLs throw so a panel can never silently load nothing.
function stubFetchRoutes(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      for (const [prefix, body] of Object.entries(routes)) {
        if (url.startsWith(prefix)) {
          return jsonResponse(body);
        }
      }
      throw new Error(`Unstubbed fetch in test: ${url}`);
    }),
  );
}

// Imported after the mock is registered.
import { SiteContentPanel } from "@/components/admin/site-content-panel";
import { PageContentPanel } from "@/components/admin/page-content-panel";
import { SiteBannersPanel } from "@/components/admin/site-banners-panel";
import { LodgeInstructionsPanel } from "@/components/admin/lodge-instructions-panel";
import { MountainConditionsPanel } from "@/app/(admin)/admin/mountain-conditions/_components/mountain-conditions-panel";
import { ImageManagerClient } from "@/app/(admin)/admin/image-manager/image-manager-client";
import { SiteStyleWizard } from "@/app/(admin)/admin/site-style/site-style-wizard";
import { DEFAULT_CLUB_THEME_VALUES } from "@/lib/club-theme-schema";
// #1940 panels newly brought under the view-only pattern.
import { InductionSettingsPanel } from "@/components/admin/induction-settings-panel";
import { InductionTemplateManager } from "@/components/admin/induction-template-manager";
import { MembershipCancellationSettingsPanel } from "@/components/admin/membership-cancellation-settings-panel";
import { SubscriptionLockoutSettingsPanel } from "@/components/admin/subscription-lockout-settings-panel";
import { EmailMessageSettingsPanel } from "@/components/admin/email-settings/email-message-settings-panel";
import { BookingMessagesPanel } from "@/components/admin/booking-messages/booking-messages-panel";
import { FinanceReportMappingsPanel } from "@/components/admin/finance-report-mappings-panel";
import { RoomsBedsManager } from "@/components/admin/rooms-beds-manager";
// #1940 pass 2 panels.
import { InternetBankingSettingsPanel } from "@/components/admin/internet-banking/internet-banking-settings-panel";
import { NotificationDeliveryPolicySettings } from "@/components/admin/email-settings/notification-delivery-policy-settings";
// #1940 pass 3 panels (support / finance / bookings settings editors).
import { AdminNotificationSettings } from "@/app/(admin)/admin/notifications/notifications-settings";
import AdminModulesPage from "@/app/(admin)/admin/modules/page";
import { MODULE_KEYS } from "@/config/modules";
import { XeroRecordActivityPanel } from "@/components/admin/xero-record-activity-panel";
import type { XeroRecordActivityData } from "@/lib/xero-record-types";
import AgeTierSettingsPage from "@/app/(admin)/admin/age-tier-settings/page";
import { PromoCodesPageClient } from "@/app/(admin)/admin/promo-codes/promo-codes-page-client";
// #1940 pass 3 delegated lanes (membership / lodge settings editors).
import AdminMemberFieldsPage from "@/app/(admin)/admin/member-fields/page";
import AdminMembershipTypesPage from "@/app/(admin)/admin/membership-types/page";
import LockersPage from "@/app/(admin)/admin/lockers/page";
import CommitteePage from "@/app/(admin)/admin/committee/page";
import AdminDisplayDevicesPage from "@/app/(admin)/admin/display/devices/page";
import AdminDisplayLayoutsPage from "@/app/(admin)/admin/display/layouts/page";
import AdminDisplayTemplatesPage from "@/app/(admin)/admin/display/templates/page";
import { LodgeCapacityCard } from "@/components/admin/lodge-capacity-card";
import { LodgeDisplaySettingsCard } from "@/app/(admin)/admin/lodges/[id]/_components/lodge-display-settings-card";
import ChoresPage from "@/app/(admin)/admin/chores/page";
import AdminWorkPartiesPage from "@/app/(admin)/admin/work-parties/page";
import AdminLodgesPage from "@/app/(admin)/admin/lodges/page";
import HutLeadersPage from "@/app/(admin)/admin/hut-leaders/page";
import AdminLodgePage from "@/app/(admin)/admin/lodge/page";
import RosterPage from "@/app/(admin)/admin/roster/page";
import LodgeConfigurationHubPage from "@/app/(admin)/admin/lodges/[id]/page";
import LodgeSetupWizardPage from "@/app/(admin)/admin/lodges/[id]/setup/page";
import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { clubIdentity } from "@/config/club-identity";
// #1997 admin action-button surfaces (bookings lane).
import { CopyBookingButton } from "@/components/admin/copy-booking-button";
import { AdminCapacityHoldControls } from "@/components/admin/admin-capacity-hold-controls";
import { AdminExclusiveHoldControls } from "@/components/admin/admin-exclusive-hold-controls";
import { ConfirmPendingGuestsButton } from "@/components/admin/confirm-pending-guests-button";
import { NonMemberContactForm } from "@/components/admin/non-member-contact-form";
import AdminWaitlistPage from "@/app/(admin)/admin/waitlist/page";
import AdminBookPage from "@/app/(admin)/admin/book/page";
// #1997 admin action-button surfaces (membership queues lane).
import DeletionRequestsClient from "@/app/(admin)/admin/deletion-requests/deletion-requests-client";
import MemberApplicationsPage from "@/app/(admin)/admin/member-applications/page";
import MembershipCancellationsPage from "@/app/(admin)/admin/membership-cancellations/page";
// #1997 admin action-button surfaces (support / communications lane).
import AdminIssueReportsPage from "@/app/(admin)/admin/issue-reports/page";
import CommunicationsPage from "@/app/(admin)/admin/communications/page";
import FamilySuggestionsPage from "@/app/(admin)/admin/family-suggestions/page";
// #1997 member-detail action cards (membership / finance lane).
import { MemberDeletionCard } from "@/app/(admin)/admin/members/[id]/_components/member-deletion-card";
import { MemberCreditCard } from "@/app/(admin)/admin/members/[id]/_components/member-credit-card";
import { MemberParentLinksCard } from "@/app/(admin)/admin/members/[id]/_components/member-parent-links-card";
import { MemberDependentsCard } from "@/app/(admin)/admin/members/[id]/_components/member-dependents-card";
import { FamilyGroupEditor } from "@/components/admin/family-group-editor";
import FamilyGroupsPage from "@/app/(admin)/admin/family-groups/page";
import { MemberBillingFamilyCard } from "@/app/(admin)/admin/members/[id]/_components/member-billing-family-card";
import { MemberLodgeAccessCard } from "@/app/(admin)/admin/members/[id]/_components/member-lodge-access-card";
import { MemberPartnerLinkCard } from "@/app/(admin)/admin/members/[id]/_components/member-partner-link-card";
import { MemberSeasonalMembershipCard } from "@/app/(admin)/admin/members/[id]/_components/member-seasonal-membership-card";
import { MemberCommitteeAssignmentsCard } from "@/app/(admin)/admin/members/[id]/_components/member-committee-assignments-card";
import { MemberLifecycleCard } from "@/app/(admin)/admin/members/[id]/_components/member-lifecycle-card";
import { MemberDetailHeader } from "@/app/(admin)/admin/members/[id]/_components/member-detail-header";
import { MemberContactGroup } from "@/app/(admin)/admin/members/[id]/_components/member-contact-group";
import type { MemberGroupEditState } from "@/app/(admin)/admin/members/[id]/_hooks/use-member-group-edit";
import type { MemberContactEditForm } from "@/lib/admin-member-edit-groups";

const SITE_CONTENT_DOCUMENTS = [
  { key: "FOOTER_BLURB", contentHtml: "<p>Blurb</p>", updatedAt: null },
  { key: "FOOTER_QUICK_LINKS", contentHtml: "<p>Links</p>", updatedAt: null },
  { key: "FOOTER_AFFILIATIONS", contentHtml: "<p>Affil</p>", updatedAt: null },
];

describe("view-only admin action controls", () => {
  it("disables write actions and exposes the read-only reason to AT", () => {
    render(
      <ViewOnlyActionButton canEdit={false}>Approve</ViewOnlyActionButton>,
    );

    const button = screen.getByRole("button", { name: /Approve/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", ADMIN_VIEW_ONLY_ACTION_REASON);

    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")).toHaveTextContent(
      ADMIN_VIEW_ONLY_ACTION_REASON,
    );
  });
});

describe("SiteContentPanel view-only gating (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return new Response(
            JSON.stringify({ documents: SITE_CONTENT_DOCUMENTS }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // PUT default: success (overridden per-test for the 403 case).
        return new Response(
          JSON.stringify({
            document: {
              key: "FOOTER_BLURB",
              contentHtml: "<p>Blurb</p>",
              updatedAt: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders read-only editors and disabled Save for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<SiteContentPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /Save Footer/i,
    });
    expect(saveButtons.length).toBeGreaterThan(0);
    for (const button of saveButtons) {
      expect(button).toBeDisabled();
    }
    // The read-only editor advertises its state.
    expect(
      screen.getAllByText(/View only — your admin role cannot edit/i).length,
    ).toBeGreaterThan(0);
  });

  it("renders enabled Save controls for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<SiteContentPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /Save Footer/i,
    });
    expect(saveButtons.length).toBeGreaterThan(0);
    for (const button of saveButtons) {
      expect(button).toBeEnabled();
    }
  });

  it("surfaces a visible error when a save is rejected with 403", async () => {
    sessionMatrix = matrix("edit");
    render(<SiteContentPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /Save Footer/i,
    });

    // Simulate a stale tab: the actor's content permission was narrowed after
    // the editors loaded, so the PUT now 403s.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 403 })),
    );

    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        ADMIN_FORBIDDEN_SAVE_REASON,
      );
    });
  });
});

describe("PageContentPanel view-only gating (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/page-content": {
        pages: [
          {
            id: "p1",
            slug: "trip-reports",
            caption: "Caption",
            menuTitle: "Trip Reports",
            title: "Trip Reports",
            headerText: "",
            path: "/trip-reports",
            sortOrder: 100,
            contentHtml: "<p>Body</p>",
            published: true,
            updatedAt: null,
            updatedByMemberId: null,
          },
        ],
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add Page and Hide for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<PageContentPanel />);

    expect(
      await screen.findByRole("button", { name: /Add Page/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Hide/i })).toBeDisabled();
    expect(
      screen.getByText(/can view page content but cannot change it/i),
    ).toBeInTheDocument();
  });

  it("enables Add Page and Hide for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<PageContentPanel />);

    expect(
      await screen.findByRole("button", { name: /Add Page/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /Hide/i })).toBeEnabled();
  });
});

describe("SiteBannersPanel view-only gating (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/site-banners": {
        current: [
          {
            id: "b1",
            message: "Mountain closed",
            priority: "NOTIFY",
            startDate: "2026-07-01",
            endDate: "2026-07-31",
            active: true,
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
        ],
        upcoming: [],
        past: [],
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add banner, Deactivate, and Delete for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<SiteBannersPanel />);

    expect(
      await screen.findByRole("button", { name: /Add banner/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Deactivate/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Delete/i })).toBeDisabled();
    expect(
      screen.getByText(/can view site banners but cannot change them/i),
    ).toBeInTheDocument();
  });

  it("enables Add banner, Deactivate, and Delete for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<SiteBannersPanel />);

    expect(
      await screen.findByRole("button", { name: /Add banner/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /Deactivate/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Delete/i })).toBeEnabled();
  });
});

describe("MountainConditionsPanel view-only gating (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/mountain-conditions": { record: null },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save, Save visibility, and upstream refresh for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<MountainConditionsPanel />);

    expect(
      await screen.findByRole("button", { name: /Update from upstream/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Save visibility/i }),
    ).toBeDisabled();
    const mcSave = screen.getByRole("button", { name: "Save" });
    expect(mcSave).toBeDisabled();
    // #2160 (content area): reason in the banner, not on the control.
    const mcBanner = screen.getByTestId("admin-view-only-banner");
    expect(mcBanner).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING);
    expect(mcBanner).toHaveTextContent(
      /can view mountain conditions but cannot change them/i,
    );
    expect(mcSave).not.toHaveAttribute("title");
  });

  it("enables Save, Save visibility, and upstream refresh for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<MountainConditionsPanel />);

    expect(
      await screen.findByRole("button", { name: /Update from upstream/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Save visibility/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});

describe("ImageManagerClient view-only gating (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/image-manager/directories": { directories: [""] },
      "/api/admin/image-manager/images": { images: [] },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the read-only notice and disables uploads for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<ImageManagerClient />);

    await screen.findByText(/0 images in this directory/i);
    expect(
      screen.getByText("Uploading is disabled for your role."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/can view images but cannot upload, delete, or change/i),
    ).toBeInTheDocument();
    // Write affordances use the accepted hidden-when-view-only idiom here.
    expect(
      screen.queryByTitle("New folder in current directory"),
    ).not.toBeInTheDocument();
  });

  it("shows live upload and folder controls for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<ImageManagerClient />);

    await screen.findByText(/0 images in this directory/i);
    expect(
      screen.getByText(/Drag & drop images here/i),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle("New folder in current directory"),
    ).toBeEnabled();
  });
});

describe("SiteStyleWizard view-only gating (#1927)", () => {
  function wizardTheme() {
    return {
      ...DEFAULT_CLUB_THEME_VALUES,
      completedAt: null,
      contrastWarnings: [],
    };
  }

  beforeEach(() => {
    sessionMatrix = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables Save and next and Reset neutral for a content:view admin", async () => {
    sessionMatrix = matrix("view");
    render(<SiteStyleWizard initialTheme={wizardTheme()} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save and next" }),
      ).toBeDisabled();
    });
    expect(
      screen.getByRole("button", { name: /Reset neutral/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view the site style but cannot change it/i),
    ).toBeInTheDocument();
    // Full-wizard jsdom render; exceeds the 5s default under full-suite load.
  }, 30_000);

  it("enables Save and next and Reset neutral for a content:edit admin", async () => {
    sessionMatrix = matrix("edit");
    render(<SiteStyleWizard initialTheme={wizardTheme()} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save and next" }),
      ).toBeEnabled();
    });
    expect(
      screen.getByRole("button", { name: /Reset neutral/i }),
    ).toBeEnabled();
  }, 30_000);
});

describe("LodgeInstructionsPanel area wiring (#1927)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lodges": { lodges: [] },
      "/api/admin/lodge-instructions": {
        documents: [
          { key: "OPEN", contentHtml: "<p>Open</p>", updatedAt: null },
          { key: "CLOSE", contentHtml: "<p>Close</p>", updatedAt: null },
          { key: "DAY_TO_DAY", contentHtml: "<p>Day</p>", updatedAt: null },
        ],
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Pins the area string "lodge" in lodge-instructions-panel.tsx: the panel
  // must gate on lodge, NOT content. A lodge:view admin stays read-only even
  // with content:edit; a lodge:edit admin edits even with content:view. If
  // someone rewires the panel to useAdminAreaEditAccess("content"), both of
  // these cases fail.
  it("renders read-only for a lodge:view admin even with content:edit", async () => {
    sessionMatrix = matrix("edit", { lodge: "view" });
    render(<LodgeInstructionsPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /^Save /,
    });
    expect(saveButtons).toHaveLength(3);
    for (const button of saveButtons) {
      expect(button).toBeDisabled();
    }
    expect(
      screen.getAllByText(/View only — your admin role cannot edit/i),
    ).toHaveLength(3);
    // #2160 (lodge area): reason in the banner, not on each of the three Saves.
    const liBanner = screen.getByTestId("admin-view-only-banner");
    expect(liBanner).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING);
    expect(liBanner).toHaveTextContent(
      /can view lodge instructions but cannot change them/i,
    );
    for (const button of saveButtons) {
      expect(button).not.toHaveAttribute("title");
    }
  });

  it("renders editable for a lodge:edit admin even with content:view", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<LodgeInstructionsPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /^Save /,
    });
    expect(saveButtons).toHaveLength(3);
    for (const button of saveButtons) {
      expect(button).toBeEnabled();
    }
    expect(
      screen.queryByText(/View only — your admin role cannot edit/i),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #1940: view-only gating audit — panels that previously rendered enabled edit
// controls to a view-level admin. Each panel gates on its OWN route area.
// ---------------------------------------------------------------------------

describe("InductionSettingsPanel view-only gating (#1940, membership)", () => {
  const SETTINGS = {
    gateEnabled: false,
    minimumMembershipMonths: 6,
    minimumNights: 3,
    requiredSignOffs: 2,
    gateEffectiveFrom: null,
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/membership-nomination-settings": { settings: SETTINGS },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables editors and Save for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<InductionSettingsPanel />);

    const save = await screen.findByRole("button", { name: /Save settings/i });
    expect(save).toBeDisabled();
    // #2160 (membership area): the reason is stated once by the section banner…
    const banner = screen.getByTestId("admin-view-only-banner");
    expect(banner).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING);
    expect(banner).toHaveTextContent(
      /can view the nomination gate settings but cannot change/i,
    );
    // …and no longer on the control itself.
    expect(save).not.toHaveAttribute("title");
  });

  it("enables Save for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<InductionSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save settings/i }),
    ).toBeEnabled();
    // #2160: the live region stays mounted for an edit-capable admin, but
    // empty — that is what lets it announce when access resolves to view-only.
    expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent("");
  });

  it("surfaces a visible error when a save is rejected with 403", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<InductionSettingsPanel />);

    const save = await screen.findByRole("button", { name: /Save settings/i });
    // Stale tab: the actor's membership permission was narrowed after load, so
    // the PUT now 403s.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 403 })),
    );
    fireEvent.click(save);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        ADMIN_FORBIDDEN_SAVE_REASON,
      );
    });
  });
});

describe("MembershipCancellationSettingsPanel view-only gating (#1940, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/membership-cancellation-settings": {
        settings: {
          warningText: "Warn",
          rejoinProcessText: "Rejoin",
          xeroArchiveContactsOnCancellation: false,
          xeroContactGroups: [],
        },
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add Group and Save for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<MembershipCancellationSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Cancellation Settings/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Add Group/i })).toBeDisabled();
    expect(
      screen.getByText(/can view membership cancellation settings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Add Group and Save for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<MembershipCancellationSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Cancellation Settings/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /Add Group/i })).toBeEnabled();
  });
});

describe("SubscriptionLockoutSettingsPanel view-only gating (#1940, membership + finance)", () => {
  // This panel reads the matrix from its prop (server-computed) and crosses two
  // write areas: the lockout enable / financial-year / invoice-text controls
  // write the membership route; the detection account/item codes write the
  // finance route. Each control gates on its OWN area, so both must be edit for
  // every editor to be live. Xero is "connected" here (chart-of-accounts returns
  // an array) so the detection selects are gated by finance edit alone, not the
  // separate not-connected disable.
  const ALL_AREAS_EDIT: Partial<AdminPermissionMatrix> = {
    membership: "edit",
    finance: "edit",
    bookings: "edit",
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/membership-lockout-settings": {
        settings: {
          mode: "HARD_BLOCK",
          financialYearEndMonthOverride: null,
          textFallbackEnabled: true,
        },
      },
      "/api/admin/xero/account-mappings": {
        subscriptionIncome: { code: null, itemCode: null },
      },
      "/api/admin/xero/chart-of-accounts": { accounts: [] },
      "/api/admin/xero/items": { items: [] },
      "/api/admin/xero/organisation": { financialYearEndMonth: 3 },
      "/api/admin/age-tier-settings": { settings: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables every editor and Save for a membership+finance:view admin", async () => {
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix("view", {
          membership: "view",
          finance: "view",
          bookings: "view",
        })}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /Save settings/i }),
    ).toBeDisabled();
    // Both membership-write checkboxes (lockout enable, invoice-text fallback)
    // and every Select trigger are disabled for a viewer.
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toBeDisabled();
    }
    for (const combobox of screen.getAllByRole("combobox")) {
      expect(combobox).toBeDisabled();
    }
    expect(
      screen.getByText(
        /can view the membership booking-lockout settings but cannot change/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /can view the subscription account and item codes but cannot change/i,
      ),
    ).toBeInTheDocument();
  });

  it("enables every editor and Save for a membership+finance:edit admin", async () => {
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix("view", ALL_AREAS_EDIT)}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /Save settings/i }),
    ).toBeEnabled();
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toBeEnabled();
    }
    for (const combobox of screen.getAllByRole("combobox")) {
      expect(combobox).toBeEnabled();
    }
    expect(
      screen.queryByText(
        /can view the membership booking-lockout settings but cannot change/i,
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        /can view the subscription account and item codes but cannot change/i,
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps the membership-write controls live for a membership:edit, finance:view admin", async () => {
    // The finance detection codes are read-only (finance view), but the lockout
    // enable / financial-year / invoice-text controls stay editable and Save is
    // enabled because their membership route is editable.
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix("view", {
          membership: "edit",
          finance: "view",
          bookings: "view",
        })}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /Save settings/i }),
    ).toBeEnabled();
    // The lockout-enable checkbox (membership) is live…
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toBeEnabled();
    }
    // …while the finance detection card advertises its read-only state.
    expect(
      screen.getByText(
        /can view the subscription account and item codes but cannot change/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        /can view the membership booking-lockout settings but cannot change/i,
      ),
    ).not.toBeInTheDocument();
  });
});

describe("InductionTemplateManager view-only gating (#1940, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/induction-templates": {
        templates: [
          {
            id: "t1",
            name: "Lodge Induction",
            version: "1",
            kind: "NEW_MEMBER",
            isActive: false,
            createdAt: "2026-07-01T00:00:00.000Z",
            sectionCount: 1,
            inductionCount: 0,
            used: false,
          },
        ],
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Activate/Edit/Create for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<InductionTemplateManager />);

    expect(
      await screen.findByRole("button", { name: /Create blank/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Activate$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeDisabled();
    expect(
      screen.getByText(/can view induction templates but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Activate/Edit/Create for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<InductionTemplateManager />);

    expect(
      await screen.findByRole("button", { name: /Create blank/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Activate$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeEnabled();
  });
});

describe("EmailMessageSettingsPanel view-only gating (#1940, support)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/email-settings": {
        settings: {
          clubName: "Club",
          bookingsName: "Bookings",
          emailFromName: "From",
          supportEmail: "s@example.com",
          contactEmail: "c@example.com",
          publicUrl: "https://example.com",
        },
      },
      "/api/admin/email-templates": {
        templates: [
          {
            key: "WELCOME",
            label: "Welcome",
            audience: "Member",
            defaultSubject: "Hi",
            defaultBody: "Body",
            allowedTokens: [],
            requiredTokens: [],
            triggerSummary: "On join",
            frequency: "Once",
            override: null,
          },
        ],
        staleOverrideCount: 0,
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save Email Settings and Save Template for a support:view admin", async () => {
    sessionMatrix = matrix("view", { support: "view" });
    render(<EmailMessageSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Email Settings/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Save Template/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view email settings and templates but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Save controls for a support:edit admin", async () => {
    sessionMatrix = matrix("view", { support: "edit" });
    render(<EmailMessageSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Email Settings/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Save Template/i }),
    ).toBeEnabled();
  });
});

describe("BookingMessagesPanel view-only gating (#1940, support)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/booking-messages": {
        messages: [
          {
            key: "BOOKING_CONFIRM",
            section: "Booking",
            label: "Confirmation",
            description: "Sent on confirm",
            defaultBody: "Default",
            bodyText: "Body",
            tokens: [],
            override: null,
          },
        ],
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save Message and Restore Default for a support:view admin", async () => {
    sessionMatrix = matrix("view", { support: "view" });
    render(<BookingMessagesPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Message/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Restore Default/i }),
    ).toBeDisabled();
    // Preview is a pure read and stays enabled for a viewer.
    expect(screen.getByRole("button", { name: /Preview/i })).toBeEnabled();
    // #2160 (support area): reason in the banner, not on the control.
    const bmBanner = screen.getByTestId("admin-view-only-banner");
    expect(bmBanner).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING);
    expect(bmBanner).toHaveTextContent(
      /can view booking messages but cannot change/i,
    );
    expect(
      screen.getByRole("button", { name: /Save Message/i }),
    ).not.toHaveAttribute("title");
  });

  it("enables Save Message and Restore Default for a support:edit admin", async () => {
    sessionMatrix = matrix("view", { support: "edit" });
    render(<BookingMessagesPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Message/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Restore Default/i }),
    ).toBeEnabled();
  });
});

describe("FinanceReportMappingsPanel view-only gating (#1940, finance)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/setup/finance-report-mappings": {
        categories: [],
        unmappedLines: [],
        snapshotCoverage: {
          latestProfitAndLossSnapshot: null,
          inspectedSnapshotCount: 0,
        },
      },
      "/api/admin/xero/chart-of-accounts": { accounts: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save and Backfill for a finance:view admin", async () => {
    sessionMatrix = matrix("view", { finance: "view" });
    render(<FinanceReportMappingsPanel />);

    expect(
      await screen.findByRole("button", { name: /^Save$/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Backfill History/i }),
    ).toBeDisabled();
    // #2160 (finance area): reason in the banner, not on the control.
    const frBanner = screen.getByTestId("admin-view-only-banner");
    expect(frBanner).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING);
    expect(frBanner).toHaveTextContent(
      /can view the finance report mappings but cannot change/i,
    );
    expect(screen.getByRole("button", { name: /^Save$/i })).not.toHaveAttribute(
      "title",
    );
  });

  it("enables Save and Backfill for a finance:edit admin", async () => {
    sessionMatrix = matrix("view", { finance: "edit" });
    render(<FinanceReportMappingsPanel />);

    expect(
      await screen.findByRole("button", { name: /^Save$/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Backfill History/i }),
    ).toBeEnabled();
  });
});

describe("RoomsBedsManager view-only gating (#1940, bookings)", () => {
  const PAYLOAD = {
    rooms: [],
    capacity: {
      source: "configured_beds",
      capacity: 10,
      bedAllocationEnabled: true,
      activeBedCount: 10,
      fallbackCapacity: 10,
    },
    canImportFromConfig: false,
    configBeds: [],
  };

  beforeEach(() => {
    // This manager reads the matrix from its prop, not the session, but the
    // shared stub still needs the lodges + rooms endpoints.
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lodges": { lodges: [LODGE] },
      "/api/admin/bed-allocation/rooms": PAYLOAD,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add Room for a bookings:view admin", async () => {
    render(<RoomsBedsManager permissionMatrix={matrix("view", { bookings: "view" })} />);

    expect(
      await screen.findByRole("button", { name: /Add Room/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view rooms and beds but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Add Room for a bookings:edit admin", async () => {
    render(<RoomsBedsManager permissionMatrix={matrix("view", { bookings: "edit" })} />);

    expect(
      await screen.findByRole("button", { name: /Add Room/i }),
    ).toBeEnabled();
  });
});

describe("InternetBankingSettingsPanel view-only gating (#1940, finance)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/internet-banking-settings": {
        settings: { holdBedSlots: true, holdDays: 3, minimumDaysBeforeCheckIn: 2 },
        moduleState: {
          xeroIntegrationEnabled: true,
          internetBankingPaymentsEnabled: true,
          ready: true,
        },
        holdPolicySummary: "Summary",
        xeroBehaviour: "Behaviour",
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save Settings for a finance:view admin", async () => {
    sessionMatrix = matrix("view", { finance: "view" });
    render(<InternetBankingSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Settings/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view Internet Banking settings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Save Settings for a finance:edit admin", async () => {
    sessionMatrix = matrix("view", { finance: "edit" });
    render(<InternetBankingSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: /Save Settings/i }),
    ).toBeEnabled();
  });
});

describe("NotificationDeliveryPolicySettings view-only gating (#1940, support)", () => {
  const POLICIES = [
    {
      templateName: "WELCOME",
      label: "Welcome",
      mode: "always" as const,
      defaultMode: "always" as const,
      deliveryEditable: true,
    },
  ];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables the delivery-mode select for a support:view admin", () => {
    sessionMatrix = matrix("view", { support: "view" });
    render(<NotificationDeliveryPolicySettings initialPolicies={POLICIES} />);

    // The mode Select autosaves on change, so it must be disabled for a viewer.
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(
      screen.getByText(/can view notification delivery rules but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables the delivery-mode select for a support:edit admin", () => {
    sessionMatrix = matrix("view", { support: "edit" });
    render(<NotificationDeliveryPolicySettings initialPolicies={POLICIES} />);

    expect(screen.getByRole("combobox")).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// #1940 pass 3: support / finance / bookings settings editors.
// ---------------------------------------------------------------------------

describe("AdminNotificationSettings view-only gating (#1940, support)", () => {
  const ADMINS = [
    {
      id: "a1",
      name: "Ada Admin",
      email: "ada@example.com",
      preferences: {
        adminNewBooking: true,
        adminPaymentFailure: true,
        adminPendingDeadline: true,
        adminBookingBumped: true,
        adminXeroSyncError: true,
        adminCapacityWarning: true,
        adminDailyDigest: true,
        adminWaitlistOffer: true,
        adminFamilyGroupRequest: true,
        adminBookingChangeRequest: true,
        adminRefundRequest: true,
        adminIssueReport: true,
        adminBookingRequest: true,
        adminBookingReviewRequired: true,
        adminMemberDeleteRequest: true,
        adminMaintenanceReport: true,
      },
    },
  ];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables the Edit button for a support:view admin", () => {
    sessionMatrix = matrix("view", { support: "view" });
    render(<AdminNotificationSettings initialAdmins={ADMINS} />);

    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeDisabled();
    expect(
      screen.getByText(
        /can view admin notification preferences but cannot change/i,
      ),
    ).toBeInTheDocument();
  });

  it("enables the Edit button for a support:edit admin", () => {
    sessionMatrix = matrix("view", { support: "edit" });
    render(<AdminNotificationSettings initialAdmins={ADMINS} />);

    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeEnabled();
  });
});

describe("AdminModulesPage view-only gating (#1940, support)", () => {
  const MODULE_SETTINGS = Object.fromEntries(
    MODULE_KEYS.map((key) => [key, false]),
  );

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/modules": {
        settings: MODULE_SETTINGS,
        modules: [
          {
            key: MODULE_KEYS[0],
            label: "Test Module",
            description: "A module.",
            adminEnabled: false,
            effectiveEnabled: false,
            readiness: {
              status: "admin_disabled",
              message: "off",
              dependencies: [],
            },
          },
        ],
        updatedAt: null,
        updatedByMemberId: null,
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables the module toggle and Save for a support:view admin", async () => {
    sessionMatrix = matrix("view", { support: "view" });
    render(<AdminModulesPage />);

    expect(await screen.findByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Save$/i })).toBeDisabled();
    expect(
      screen.getByText(/can view the module settings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables the module toggle for a support:edit admin", async () => {
    sessionMatrix = matrix("view", { support: "edit" });
    render(<AdminModulesPage />);

    expect(await screen.findByRole("checkbox")).toBeEnabled();
  });
});

describe("XeroRecordActivityPanel view-only gating (#1940, finance)", () => {
  const XERO_DATA = {
    rootRecord: { label: "Member X", localModel: "member", localId: "m1", url: null },
    summary: {
      totalOperations: 1,
      failedOperations: 1,
      partialOperations: 0,
      pendingOperations: 0,
      activeLinks: 0,
    },
    scopeRecords: [],
    relatedRecords: [],
    links: [],
    operations: [
      {
        id: "op1",
        status: "FAILED",
        entityType: "INVOICE",
        operationType: "PUSH",
        createdAt: "2026-07-01T00:00:00.000Z",
        direction: "OUTBOUND",
        attemptCount: 1,
        localModel: "member",
        localId: "m1",
        localUrl: null,
        localLabel: "Member X",
        xeroObjectId: null,
        xeroObjectNumber: null,
        xeroObjectUrl: null,
        lastErrorMessage: null,
        lastErrorCode: null,
        supported: true,
        reason: null,
        requestPayload: null,
        responsePayload: null,
      },
    ],
    inboundEvents: [],
  } as unknown as XeroRecordActivityData;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables Retry in background for a finance:view admin", () => {
    sessionMatrix = matrix("view", { finance: "view" });
    render(
      <XeroRecordActivityPanel localModel="member" localId="m1" initialData={XERO_DATA} />,
    );

    expect(
      screen.getByRole("button", { name: /Retry in background/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view Xero activity but cannot retry or replay/i),
    ).toBeInTheDocument();
  });

  it("enables Retry in background for a finance:edit admin", () => {
    sessionMatrix = matrix("view", { finance: "edit" });
    render(
      <XeroRecordActivityPanel localModel="member" localId="m1" initialData={XERO_DATA} />,
    );

    expect(
      screen.getByRole("button", { name: /Retry in background/i }),
    ).toBeEnabled();
  });
});

describe("AgeTierSettingsPage view-only gating (#1940, bookings)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/age-tier-settings": { settings: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables the Edit button for a bookings:view admin", async () => {
    sessionMatrix = matrix("view", { bookings: "view" });
    render(<AgeTierSettingsPage />);

    expect(
      await screen.findByRole("button", { name: /^Edit$/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view the age tier settings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables the Edit button for a bookings:edit admin", async () => {
    sessionMatrix = matrix("view", { bookings: "edit" });
    render(<AgeTierSettingsPage />);

    expect(
      await screen.findByRole("button", { name: /^Edit$/i }),
    ).toBeEnabled();
  });
});

describe("PromoCodesPageClient view-only gating (#1940, bookings)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/promo-codes": [],
      "/api/admin/lodges": { lodges: [LODGE] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add Promo Code for a bookings:view admin", async () => {
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix("view", { bookings: "view" })}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /Add Promo Code/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view promo codes but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Add Promo Code for a bookings:edit admin", async () => {
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix("view", { bookings: "edit" })}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /Add Promo Code/i }),
    ).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// #1940 pass 3 (membership lane): member-fields, membership-types, lockers,
// committee. communications skipped (pure send-action surface).
// ---------------------------------------------------------------------------

describe("AdminMemberFieldsPage view-only gating (#1940, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/member-fields": {
        settings: {},
        updatedAt: null,
        updatedByMemberId: null,
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables field toggles and Save for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<AdminMemberFieldsPage />);

    expect(
      await screen.findByRole("button", { name: /^Save$/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view member fields but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Save for a membership:edit admin once a field is toggled", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<AdminMemberFieldsPage />);

    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    expect(screen.getByRole("button", { name: /^Save$/i })).toBeEnabled();
  });
});

describe("AdminMembershipTypesPage view-only gating (#1940, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/membership-types": { membershipTypes: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables New membership type for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<AdminMembershipTypesPage />);

    expect(
      await screen.findByRole("button", { name: /New membership type/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view membership types but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables New membership type for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<AdminMembershipTypesPage />);

    expect(
      await screen.findByRole("button", { name: /New membership type/i }),
    ).toBeEnabled();
  });
});

describe("LockersPage view-only gating (#1940, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lockers": { members: [], lockers: [] },
      "/api/admin/lodges": { lodges: [LODGE] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Create Locker for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<LockersPage />);

    expect(
      await screen.findByRole("button", { name: /^Create Locker$/ }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view lockers but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Create Locker for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<LockersPage />);

    expect(
      await screen.findByRole("button", { name: /^Create Locker$/ }),
    ).toBeEnabled();
  });
});

describe("CommitteePage view-only gating (#1940, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/committee/roles": { roles: [] },
      "/api/admin/committee/assignments": { assignments: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add Role for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<CommitteePage />);

    expect(
      await screen.findByRole("button", { name: /Add Role/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        /can view committee roles and assignments but cannot change/i,
      ),
    ).toBeInTheDocument();
  });

  it("enables Add Role for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<CommitteePage />);

    expect(
      await screen.findByRole("button", { name: /Add Role/i }),
    ).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// #1940 pass 3 (lodge display + capacity lane): display devices/layouts/
// templates, lodge-capacity-card, lodge-display-settings-card. preview skipped
// (view-level read action).
// ---------------------------------------------------------------------------

describe("AdminDisplayDevicesPage view-only gating (#1940, lodge)", () => {
  const DEVICE = {
    id: "d1",
    name: "Lobby TV",
    lodgeId: "l1",
    lodgeName: "Main Lodge",
    templateId: null,
    templateName: null,
    pollSeconds: null,
    paired: false,
    pairingArmedUntil: null,
    lastSeenAt: null,
    revoked: false,
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/display/devices": { devices: [DEVICE] },
      "/api/admin/display/templates": { templates: [] },
      "/api/admin/lodges": { lodges: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Revoke and device inputs for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(<AdminDisplayDevicesPage />);

    expect(
      await screen.findByRole("button", { name: /Revoke/i }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(
      screen.getByText(/can view the lobby display devices but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Revoke and device inputs for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<AdminDisplayDevicesPage />);

    expect(
      await screen.findByRole("button", { name: /Revoke/i }),
    ).toBeEnabled();
    expect(screen.getByLabelText("Name")).toBeEnabled();
  });
});

describe("AdminDisplayLayoutsPage view-only gating (#1940, lodge)", () => {
  const LAYOUT = {
    id: "ly1",
    key: "everyday-board",
    name: "Everyday board",
    description: "The default board",
    updatedAt: "2026-07-01T00:00:00.000Z",
    templateCount: 0,
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/display/layouts": { layouts: [LAYOUT] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Delete and the authoring inputs for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(<AdminDisplayLayoutsPage />);

    expect(
      await screen.findByRole("button", { name: /^Delete$/i }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(
      screen.getByText(/can view the lobby display layouts but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Delete and the authoring inputs for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<AdminDisplayLayoutsPage />);

    expect(
      await screen.findByRole("button", { name: /^Delete$/i }),
    ).toBeEnabled();
    expect(screen.getByLabelText("Name")).toBeEnabled();
  });
});

describe("AdminDisplayTemplatesPage view-only gating (#1940, lodge)", () => {
  const TEMPLATE = {
    id: "t1",
    key: "foyer-board",
    name: "Foyer board",
    layout: { id: "ly1", key: "everyday-board", name: "Everyday board" },
    deviceCount: 0,
    updatedAt: "2026-07-01T00:00:00.000Z",
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/display/templates": { templates: [TEMPLATE] },
      "/api/admin/display/layouts": { layouts: [] },
      // #2887: Preview now needs an explicit lodge — with no active lodge the
      // page refuses rather than previewing the club default, so an empty list
      // here would disable Preview for an EDIT admin too and the view-only
      // assertion below would pass for the wrong reason.
      "/api/admin/lodges": {
        lodges: [{ id: "lodge-1", name: "Silverpeak Lodge", active: true }],
      },
      // The token assistant's useDisplayLodgeConfig fetch (#2248). Stubbed
      // deliberately: without this the suite's unstubbed-fetch tripwire fires
      // but is silently absorbed by the hook's own catch — this keeps the
      // fetch an explicit, answered request rather than a tolerated error.
      "/api/admin/display/lodge-config": { lodgeName: "Test Lodge", displayConfig: {} },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Delete and the template name input for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(<AdminDisplayTemplatesPage />);

    expect(
      await screen.findByRole("button", { name: /^Delete$/i }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Preview$/i })).toBeEnabled();
    expect(
      screen.getByText(/can view the lobby display templates but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Delete and the template name input for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<AdminDisplayTemplatesPage />);

    expect(
      await screen.findByRole("button", { name: /^Delete$/i }),
    ).toBeEnabled();
    expect(screen.getByLabelText("Name")).toBeEnabled();
  });
});

describe("LodgeCapacityCard view-only gating (#1940, lodge)", () => {
  const CLUB_IDENTITY = {
    name: "Test Club",
    shortName: "TC",
    supportEmail: "s@example.com",
    contactEmail: "c@example.com",
    publicUrl: "https://example.com",
    emailFromName: "Test Club",
    lodgeTravelNote: "",
    hutLeaderLabel: "Hut Leader",
    socialLinks: {},
    bookingsName: "Bookings",
    lodgeName: "Test Lodge",
    publicHost: "example.com",
    lodgeCapacity: 30,
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lodge-settings": {
        capacity: null,
        hutLeaderLookaheadDays: 14,
        schoolGroupSoftCap: 40,
        clubConfigCapacity: 30,
      },
      "/api/admin/lodges": { lodges: [LODGE] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save and the capacity inputs for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(
      <ClubIdentityProvider value={CLUB_IDENTITY}>
        <LodgeCapacityCard />
      </ClubIdentityProvider>,
    );

    expect(
      await screen.findByRole("button", { name: /^Save$/i }),
    ).toBeDisabled();
    expect(screen.getByLabelText(/Capacity \(beds\/guests\)/i)).toBeDisabled();
    expect(
      screen.getByText(/can view the lodge capacity settings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Save and the capacity inputs for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(
      <ClubIdentityProvider value={CLUB_IDENTITY}>
        <LodgeCapacityCard />
      </ClubIdentityProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Save$/i })).toBeEnabled();
    });
    expect(screen.getByLabelText(/Capacity \(beds\/guests\)/i)).toBeEnabled();
  });
});

describe("LodgeDisplaySettingsCard view-only gating (#1940, lodge)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/display/lodge-config": {
        displayConfig: {},
        displayNameGranularity: null,
        displayNotice: null,
        showGuestPhonesOnScreens: false,
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save display settings and its editors for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(<LodgeDisplaySettingsCard lodgeId="l1" />);

    expect(
      await screen.findByRole("button", { name: /Save display settings/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Add value/i })).toBeDisabled();
    expect(screen.getByLabelText(/Guest name display/i)).toBeDisabled();
    expect(
      screen.getByText(/can view the lobby display settings but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Save display settings and its editors for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<LodgeDisplaySettingsCard lodgeId="l1" />);

    expect(
      await screen.findByRole("button", { name: /Save display settings/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /Add value/i })).toBeEnabled();
    expect(screen.getByLabelText(/Guest name display/i)).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// #1940 pass 3 (lodge core lane): chores, work-parties, lodges, hut-leaders,
// lodge kiosk, roster, lodge config hub, lodge setup wizard.
// ---------------------------------------------------------------------------

describe("ChoresPage view-only gating (#1940, lodge)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/chores": [],
      "/api/admin/lodges": { lodges: [LODGE] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add Chore for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(<ChoresPage />);

    expect(
      await screen.findByRole("button", { name: /Add Chore/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view chore templates but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Add Chore for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<ChoresPage />);

    expect(
      await screen.findByRole("button", { name: /Add Chore/i }),
    ).toBeEnabled();
  });
});

describe("AdminWorkPartiesPage view-only gating (#1940, lodge)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/work-parties": { events: [] },
      "/api/admin/lodges": { lodges: [LODGE] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables New Event for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(<AdminWorkPartiesPage />);

    expect(
      await screen.findByRole("button", { name: /New Event/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view work parties but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables New Event for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<AdminWorkPartiesPage />);

    expect(
      await screen.findByRole("button", { name: /New Event/i }),
    ).toBeEnabled();
  });
});

describe("AdminLodgesPage view-only gating (#1940, lodge)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lodges": { lodges: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Add lodge for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(<AdminLodgesPage />);

    expect(
      await screen.findByRole("button", { name: /Add lodge/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view the lodge properties but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Add lodge for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<AdminLodgesPage />);

    expect(
      await screen.findByRole("button", { name: /Add lodge/i }),
    ).toBeEnabled();
  });
});

describe("HutLeadersPage view-only gating (#1940, lodge)", () => {
  const ASSIGNMENT = {
    id: "a1",
    memberId: "m1",
    memberName: "Jane Doe",
    memberEmail: "jane@example.com",
    startDate: "2026-07-01",
    endDate: "2026-07-05",
    createdAt: "2026-07-01T00:00:00.000Z",
    lodgeId: null,
    lodgeName: null,
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/hut-leaders/unassigned-dates": { unassignedDates: [] },
      "/api/admin/hut-leaders/eligible-members": { members: [] },
      "/api/admin/occupancy": { nights: [] },
      "/api/admin/hut-leaders": { assignments: [ASSIGNMENT] },
      "/api/admin/lodges": { lodges: [LODGE] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables the assignment Delete action for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(
      <ClubIdentityProvider value={clubIdentity}>
        <HutLeadersPage />
      </ClubIdentityProvider>,
    );

    expect(
      await screen.findByRole("button", { name: /Delete assignment/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view .* assignments but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables the assignment Delete action for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(
      <ClubIdentityProvider value={clubIdentity}>
        <HutLeadersPage />
      </ClubIdentityProvider>,
    );

    expect(
      await screen.findByRole("button", { name: /Delete assignment/i }),
    ).toBeEnabled();
  });
});

describe("AdminLodgePage kiosk view-only gating (#1940, lodge)", () => {
  const ACCOUNT = {
    id: "k1",
    email: "kiosk@example.com",
    firstName: "Kiosk",
    lastName: "One",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    boundLodgeId: null,
    boundLodgeName: null,
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lodges": { lodges: [] },
      "/api/admin/lodge": { accounts: [ACCOUNT], defaultLodgeName: null },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables the account Edit toggle for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(
      <ClubIdentityProvider value={clubIdentity}>
        <AdminLodgePage />
      </ClubIdentityProvider>,
    );

    expect(
      await screen.findByRole("button", { name: /^Edit$/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view the lodge kiosk accounts but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables the account Edit toggle for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(
      <ClubIdentityProvider value={clubIdentity}>
        <AdminLodgePage />
      </ClubIdentityProvider>,
    );

    expect(
      await screen.findByRole("button", { name: /^Edit$/i }),
    ).toBeEnabled();
  });
});

describe("RosterPage view-only gating (#1940, lodge)", () => {
  const ROSTER = {
    date: "2026-07-17",
    guests: [],
    assignments: [],
    templates: [],
    guestHistory: {},
    guestCount: 0,
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/roster/status": { month: "2026-07", statuses: [] },
      "/api/admin/roster/": ROSTER,
      "/api/admin/occupancy": { nights: [] },
      "/api/admin/lodges": { lodges: [LODGE] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Regenerate Roster for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(<RosterPage />);

    expect(
      await screen.findByRole("button", { name: /Regenerate Roster/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view the chore roster but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Regenerate Roster for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<RosterPage />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Regenerate Roster/i }),
      ).toBeEnabled();
    });
  });
});

describe("LodgeConfigurationHubPage view-only gating (#1940, lodge)", () => {
  const LODGE = {
    id: "lodge-1",
    name: "Lodge 1",
    slug: "lodge-1",
    active: true,
    doorCode: null,
    travelNote: null,
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lodge-settings": { capacity: null },
      "/api/admin/lodges": { lodges: [LODGE] },
      "/api/admin/modules": { settings: {} },
      "/api/admin/bed-allocation/rooms": {
        rooms: [],
        capacity: { capacity: 0, source: "unconfigured_lodge", activeBedCount: 0 },
      },
      "/api/admin/lockers": { lockers: [] },
      "/api/admin/seasons": [],
      "/api/admin/chores": [],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables the capacity editor for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(<LodgeConfigurationHubPage />);

    expect(
      await screen.findByLabelText(/Capacity for this lodge/i),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view this lodge.s capacity but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables the capacity editor for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<LodgeConfigurationHubPage />);

    expect(
      await screen.findByLabelText(/Capacity for this lodge/i),
    ).toBeEnabled();
  });
});

describe("LodgeSetupWizardPage view-only gating (#1940, lodge)", () => {
  const LODGE = {
    id: "lodge-1",
    name: "Lodge 1",
    slug: "lodge-1",
    active: true,
    doorCode: null,
    travelNote: null,
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lodges": { lodges: [LODGE] },
      "/api/admin/modules": { settings: {} },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Save and continue for a lodge:view admin", async () => {
    sessionMatrix = matrix("view", { lodge: "view" });
    render(<LodgeSetupWizardPage />);

    expect(
      await screen.findByRole("button", { name: /Save and continue/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view the lodge setup wizard but cannot change/i),
    ).toBeInTheDocument();
  });

  it("enables Save and continue for a lodge:edit admin", async () => {
    sessionMatrix = matrix("view", { lodge: "edit" });
    render(<LodgeSetupWizardPage />);

    expect(
      await screen.findByRole("button", { name: /Save and continue/i }),
    ).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// #1997 admin action-button surfaces (bookings lane). Each write route these
// back is bookings-area (path-inferred, now made explicit on the guard), so
// gating is keyed on bookings edit vs view.
// ---------------------------------------------------------------------------

describe("CopyBookingButton view-only gating (#1997, bookings)", () => {
  afterEach(() => {
    sessionMatrix = null;
    vi.restoreAllMocks();
  });

  it("disables the Copy Booking trigger for a bookings:view admin", () => {
    sessionMatrix = matrix("view", { bookings: "view" });
    render(
      <CopyBookingButton
        bookingId="b1"
        sourceCheckIn="2026-08-01"
        sourceCheckOut="2026-08-03"
        minCheckIn="2026-07-20"
      />,
    );

    expect(screen.getByRole("button", { name: /Copy Booking/i })).toBeDisabled();
  });

  it("enables the Copy Booking trigger for a bookings:edit admin", () => {
    sessionMatrix = matrix("view", { bookings: "edit" });
    render(
      <CopyBookingButton
        bookingId="b1"
        sourceCheckIn="2026-08-01"
        sourceCheckOut="2026-08-03"
        minCheckIn="2026-07-20"
      />,
    );

    expect(screen.getByRole("button", { name: /Copy Booking/i })).toBeEnabled();
  });
});

describe("AdminCapacityHoldControls view-only gating (#1997, bookings)", () => {
  afterEach(() => {
    sessionMatrix = null;
    vi.restoreAllMocks();
  });

  const props = {
    bookingId: "b1",
    hasAdminCapacityHold: false,
    adminCapacityHoldAt: null,
    heldByName: null,
    holdsCapacityNaturally: false,
    canPlaceHold: true,
  };

  it("disables Hold capacity for a bookings:view admin", () => {
    sessionMatrix = matrix("view", { bookings: "view" });
    render(<AdminCapacityHoldControls {...props} />);

    expect(
      screen.getByRole("button", { name: /Hold capacity/i }),
    ).toBeDisabled();
  });

  it("enables Hold capacity for a bookings:edit admin", () => {
    sessionMatrix = matrix("view", { bookings: "edit" });
    render(<AdminCapacityHoldControls {...props} />);

    expect(screen.getByRole("button", { name: /Hold capacity/i })).toBeEnabled();
  });
});

describe("AdminExclusiveHoldControls view-only gating (#1997, bookings)", () => {
  afterEach(() => {
    sessionMatrix = null;
    vi.restoreAllMocks();
  });

  const props = {
    bookingId: "b1",
    wholeLodgeHold: false,
    wholeLodgeHoldAt: null,
    heldByName: null,
    holdsCapacity: true,
  };

  it("disables Set exclusive hold for a bookings:view admin", () => {
    sessionMatrix = matrix("view", { bookings: "view" });
    render(<AdminExclusiveHoldControls {...props} />);

    expect(
      screen.getByRole("button", { name: /Set exclusive hold/i }),
    ).toBeDisabled();
  });

  it("enables Set exclusive hold for a bookings:edit admin", () => {
    sessionMatrix = matrix("view", { bookings: "edit" });
    render(<AdminExclusiveHoldControls {...props} />);

    expect(
      screen.getByRole("button", { name: /Set exclusive hold/i }),
    ).toBeEnabled();
  });
});

describe("ConfirmPendingGuestsButton view-only gating (#1997, bookings)", () => {
  afterEach(() => {
    sessionMatrix = null;
    vi.restoreAllMocks();
  });

  it("disables Confirm pending guests for a bookings:view admin", () => {
    sessionMatrix = matrix("view", { bookings: "view" });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod={false}
        finalPriceCents={0}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Confirm pending guests/i }),
    ).toBeDisabled();
  });

  it("enables Confirm pending guests for a bookings:edit admin", () => {
    sessionMatrix = matrix("view", { bookings: "edit" });
    render(
      <ConfirmPendingGuestsButton
        bookingId="b1"
        hasSavedPaymentMethod={false}
        finalPriceCents={0}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Confirm pending guests/i }),
    ).toBeEnabled();
  });
});

describe("NonMemberContactForm view-only gating (#1997, bookings)", () => {
  afterEach(() => {
    sessionMatrix = null;
    vi.restoreAllMocks();
  });

  it("disables Create new & continue for a bookings:view admin", () => {
    sessionMatrix = matrix("view", { bookings: "view" });
    render(<NonMemberContactForm onSelected={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: /Create new & continue/i }),
    ).toBeDisabled();
  });

  it("enables Create new & continue for a bookings:edit admin", () => {
    sessionMatrix = matrix("view", { bookings: "edit" });
    render(<NonMemberContactForm onSelected={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: /Create new & continue/i }),
    ).toBeEnabled();
  });
});

describe("AdminWaitlistPage view-only gating (#1997, bookings)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/waitlist": {
        entries: [],
        pagination: { page: 1, pageSize: 25, total: 0 },
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the view-only notice for a bookings:view admin", async () => {
    sessionMatrix = matrix("view", { bookings: "view" });
    render(<AdminWaitlistPage />);

    expect(
      await screen.findByText(
        /can view the waitlist but cannot force-confirm/i,
      ),
    ).toBeInTheDocument();
  });

  it("hides the view-only notice for a bookings:edit admin", async () => {
    sessionMatrix = matrix("view", { bookings: "edit" });
    render(<AdminWaitlistPage />);

    // Let the mount fetch settle so the table (not the notice) renders.
    await waitFor(() =>
      expect(screen.getByText(/Waitlist/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/can view the waitlist but cannot force-confirm/i),
    ).not.toBeInTheDocument();
  });
});

describe("AdminBookPage view-only gating (#1997, bookings)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lodges": { lodges: [] },
      "/api/payments/options": {
        methods: { internetBanking: { enabled: false } },
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the view-only notice for a bookings:view admin", async () => {
    sessionMatrix = matrix("view", { bookings: "view" });
    render(
      <ClubIdentityProvider value={clubIdentity}>
        <AdminBookPage />
      </ClubIdentityProvider>,
    );

    expect(
      await screen.findByText(
        /can view booking tools but cannot create bookings on behalf/i,
      ),
    ).toBeInTheDocument();
  });

  it("hides the view-only notice for a bookings:edit admin", async () => {
    sessionMatrix = matrix("view", { bookings: "edit" });
    render(
      <ClubIdentityProvider value={clubIdentity}>
        <AdminBookPage />
      </ClubIdentityProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Book on Behalf of Member/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(
        /can view booking tools but cannot create bookings on behalf/i,
      ),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #1997 admin action-button surfaces (membership queues lane). Each queue's
// write route is membership-area (path-inferred, now explicit on the guard),
// so gating is keyed on membership edit vs view.
// ---------------------------------------------------------------------------

describe("DeletionRequestsClient view-only gating (#1997, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/deletion-requests": {
        requests: [],
        total: 0,
        totalPages: 1,
      },
      "/api/admin/member-lifecycle-action-requests": {
        requests: [],
        total: 0,
        totalPages: 1,
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the view-only notice for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    expect(
      await screen.findByText(
        /can view deletion requests but cannot approve or reject/i,
      ),
    ).toBeInTheDocument();
  });

  it("hides the view-only notice for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<DeletionRequestsClient sessionMemberId="admin-1" />);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Deletion Requests/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(
        /can view deletion requests but cannot approve or reject/i,
      ),
    ).not.toBeInTheDocument();
  });
});

describe("MemberApplicationsPage view-only gating (#1997, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/member-applications": { applications: [], pendingCount: 0 },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the view-only notice for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<MemberApplicationsPage />);

    expect(
      await screen.findByText(
        /can view member applications but cannot approve, decline/i,
      ),
    ).toBeInTheDocument();
  });

  it("hides the view-only notice for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<MemberApplicationsPage />);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Member Applications/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(
        /can view member applications but cannot approve, decline/i,
      ),
    ).not.toBeInTheDocument();
  });
});

describe("MembershipCancellationsPage view-only gating (#1997, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/membership-cancellation-requests": {
        requests: [],
        total: 0,
        pendingCount: 0,
      },
      "/api/admin/member-lifecycle-action-requests": {
        requests: [],
        total: 0,
        pendingCount: 0,
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the view-only notice for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<MembershipCancellationsPage />);

    expect(
      await screen.findByText(
        /can view membership cancellations but cannot approve or reject/i,
      ),
    ).toBeInTheDocument();
  });

  it("hides the view-only notice for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<MembershipCancellationsPage />);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Membership Cancellations/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(
        /can view membership cancellations but cannot approve or reject/i,
      ),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #1997 admin action-button surfaces (support / communications lane).
// ---------------------------------------------------------------------------

describe("AdminIssueReportsPage view-only gating (#1997, support)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/issue-reports": { reports: [], total: 0 },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the view-only notice for a support:view admin", async () => {
    sessionMatrix = matrix("view", { support: "view" });
    render(<AdminIssueReportsPage />);

    expect(
      await screen.findByText(
        /can view issue reports but cannot resolve, reopen/i,
      ),
    ).toBeInTheDocument();
  });

  it("hides the view-only notice for a support:edit admin", async () => {
    sessionMatrix = matrix("view", { support: "edit" });
    render(<AdminIssueReportsPage />);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Issue Reports/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/can view issue reports but cannot resolve, reopen/i),
    ).not.toBeInTheDocument();
  });
});

describe("CommunicationsPage view-only gating (#1997, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/communications/send": { limit: 5, windowSeconds: 3600 },
      "/api/admin/communications/history": { history: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Send to Members for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<CommunicationsPage />);

    expect(
      await screen.findByRole("button", { name: /Send to Members/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/can view communications but cannot send bulk emails/i),
    ).toBeInTheDocument();
  });

  it("enables Send to Members for a membership:edit admin (with content)", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<CommunicationsPage />);

    const subject = await screen.findByLabelText(/Subject/i);
    const body = screen.getByLabelText(/Message|Body/i);
    fireEvent.change(subject, { target: { value: "Hello" } });
    fireEvent.change(body, { target: { value: "World" } });

    expect(
      screen.getByRole("button", { name: /Send to Members/i }),
    ).toBeEnabled();
    expect(
      screen.queryByText(/can view communications but cannot send bulk emails/i),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #1997 member-detail action cards. The Lifecycle & Deletion cards gate on
// membership edit; the Account Credit card gates on finance edit (its route is
// remapped to finance). Other member-detail cards are follow-up work.
// ---------------------------------------------------------------------------

describe("MemberDeletionCard view-only gating (#1997, membership)", () => {
  afterEach(() => {
    sessionMatrix = null;
    vi.restoreAllMocks();
  });

  const props = {
    deleteEligibility: { eligible: true, blockers: [] },
    deleteRequests: [],
    pendingDeleteRequest: undefined,
    approvalBlockerCount: 0,
    canReviewPendingDeleteRequest: true,
    onOpenRequestDialog: vi.fn(),
    onOpenReviewDialog: vi.fn(),
  } as unknown as ComponentProps<typeof MemberDeletionCard>;

  it("disables Request Delete for a membership:view admin", () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<MemberDeletionCard {...props} canEdit={false} />);

    expect(
      screen.getByRole("button", { name: /Request Delete/i }),
    ).toBeDisabled();
  });

  it("enables Request Delete for a membership:edit admin", () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<MemberDeletionCard {...props} canEdit={true} />);

    expect(screen.getByRole("button", { name: /Request Delete/i })).toBeEnabled();
  });
});

describe("MemberCreditCard view-only gating (#1997, finance)", () => {
  afterEach(() => {
    sessionMatrix = null;
    vi.restoreAllMocks();
  });

  const props = {
    creditBalance: 0,
    creditHistory: [],
    creditLoading: false,
    creditError: "",
    pendingAdjustmentRequests: [],
    reviewingAdjustmentId: null,
    showAdjustmentForm: false,
    adjustmentError: "",
    adjustmentAmount: "",
    adjustmentDescription: "",
    adjustmentSaving: false,
    onToggleAdjustmentForm: vi.fn(),
    onChangeAdjustmentAmount: vi.fn(),
    onChangeAdjustmentDescription: vi.fn(),
    onSubmitAdjustment: vi.fn(),
    onReviewAdjustment: vi.fn(),
  } as unknown as ComponentProps<typeof MemberCreditCard>;

  it("disables Request Adjustment for a finance:view admin", () => {
    sessionMatrix = matrix("view", { finance: "view" });
    render(<MemberCreditCard {...props} />);

    expect(
      screen.getByRole("button", { name: /Request Adjustment/i }),
    ).toBeDisabled();
  });

  it("enables Request Adjustment for a finance:edit admin", () => {
    sessionMatrix = matrix("view", { finance: "edit" });
    render(<MemberCreditCard {...props} />);

    expect(
      screen.getByRole("button", { name: /Request Adjustment/i }),
    ).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// #1997 remaining member-detail action cards. Membership-area cards key on
// membership edit; the billing-family card writes the finance-area
// fee-configuration route and keys on finance edit.
// ---------------------------------------------------------------------------

describe("MemberParentLinksCard view-only gating (#1997, membership)", () => {
  afterEach(() => {
    sessionMatrix = null;
    vi.restoreAllMocks();
  });

  const props = {
    member: {
      id: "m1",
      firstName: "Pat",
      lastName: "Kea",
      parentLinks: [],
      dependents: [],
    },
    memberIsArchived: false,
    currentMemberPath: "/admin/members/m1",
    unlinkingDependentId: null,
    onOpenParentLinkDialog: vi.fn(),
    onUnlinkParent: vi.fn(),
  } as unknown as ComponentProps<typeof MemberParentLinksCard>;

  it("disables Add Parent for a membership:view admin", () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<MemberParentLinksCard {...props} canEdit={false} />);
    expect(screen.getByRole("button", { name: /Add Parent/i })).toBeDisabled();
  });

  it("enables Add Parent for a membership:edit admin", () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<MemberParentLinksCard {...props} canEdit={true} />);
    expect(screen.getByRole("button", { name: /Add Parent/i })).toBeEnabled();
  });
});

describe("MemberDependentsCard view-only gating (#1997, membership)", () => {
  afterEach(() => {
    sessionMatrix = null;
    vi.restoreAllMocks();
  });

  const props = {
    // #2282: `isAdultMember` / `memberIsArchived` are gone as props — the card
    // derives the rule from the member row itself, because age no longer gates
    // recording parentage and only "is this record current, and is it a person?"
    // remains. The fixture therefore has to be a realistic row: an `active` flag
    // absent from it now reads as an inactive member and disables the control
    // for a reason that has nothing to do with the permission this suite is
    // testing.
    member: {
      id: "m1",
      firstName: "Pat",
      lastName: "Kea",
      role: "USER",
      accessRoles: [],
      canLogin: true,
      active: true,
      archivedAt: null,
      dependents: [],
      dependentEmailSource: null,
    },
    currentMemberPath: "/admin/members/m1",
    unlinkingDependentId: null,
    onOpenDependentDialog: vi.fn(),
    onUnlinkDependent: vi.fn(),
  } as unknown as ComponentProps<typeof MemberDependentsCard>;

  it("disables Add Dependent for a membership:view admin", () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<MemberDependentsCard {...props} canEdit={false} />);
    expect(
      screen.getByRole("button", { name: /Add Dependent/i }),
    ).toBeDisabled();
  });

  it("enables Add Dependent for a membership:edit admin", () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<MemberDependentsCard {...props} canEdit={true} />);
    expect(screen.getByRole("button", { name: /Add Dependent/i })).toBeEnabled();
  });
});

describe("FamilyGroupEditor view-only gating (#2065, membership)", () => {
  const GROUP = {
    id: "g1",
    name: "Kea Family",
    members: [
      {
        id: "mem1",
        firstName: "Pat",
        lastName: "Kea",
        email: "pat@example.com",
        ageTier: "ADULT",
        active: true,
        canLogin: true,
        hasPassword: true,
      },
    ],
  };

  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/family-groups/requests": { requests: [] },
      "/api/admin/family-groups/g1": GROUP,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const props = {
    groupId: "g1",
    onClose: vi.fn(),
    onChanged: vi.fn(),
  } as const;

  it("disables the mutation controls and exposes the read-only reason for a view-only admin", async () => {
    render(<FamilyGroupEditor {...props} canEdit={false} />);

    const del = await screen.findByRole("button", { name: /^Delete$/ });
    expect(del).toBeDisabled();
    // #2160: the reason no longer rides on each button — it is stated once in
    // the section banner. Gating is unchanged (still `disabled`); only the
    // explanation moved, so the per-button `title` is deliberately gone.
    expect(del).not.toHaveAttribute("title");
    expect(
      screen.getByRole("button", { name: /Update Group/i }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Group Name")).toBeDisabled();
    const banner = screen.getByTestId("admin-view-only-banner");
    expect(banner).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING);
    expect(banner).toHaveTextContent(
      /can view this family group but cannot change/i,
    );
  });

  it("keeps controls disabled but shows no read-only reason while the session is resolving", async () => {
    render(<FamilyGroupEditor {...props} canEdit={undefined} />);

    const del = await screen.findByRole("button", { name: /^Delete$/ });
    expect(del).toBeDisabled();
    // Neutral resolving state: disabled WITHOUT the view-only reason/banner.
    expect(del).not.toHaveAttribute("title", ADMIN_VIEW_ONLY_ACTION_REASON);
    expect(
      screen.getByRole("button", { name: /Update Group/i }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Group Name")).toBeDisabled();
    expect(
      screen.queryByText(/can view this family group but cannot change/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the mutation controls live for an edit-capable admin", async () => {
    render(<FamilyGroupEditor {...props} canEdit={true} />);

    const del = await screen.findByRole("button", { name: /^Delete$/ });
    expect(del).toBeEnabled();
    expect(del).not.toHaveAttribute("title", ADMIN_VIEW_ONLY_ACTION_REASON);
    // One member is loaded, so Update Group is not gated by the empty-set rule.
    expect(screen.getByRole("button", { name: /Update Group/i })).toBeEnabled();
    expect(screen.getByLabelText("Group Name")).toBeEnabled();
    expect(
      screen.queryByText(/can view this family group but cannot change/i),
    ).not.toBeInTheDocument();
  });
});

describe("FamilyGroupsPage row-action view-only gating (#2065, membership)", () => {
  const SUMMARY = {
    id: "g1",
    name: "Kea Family",
    members: [],
    memberCount: 0,
    inactiveCount: 0,
    pendingRequests: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
  };

  beforeEach(() => {
    sessionMatrix = null;
    sessionStatus = "authenticated";
    stubFetchRoutes({
      "/api/admin/family-groups/requests": { requests: [] },
      "/api/admin/family-groups/partner-invites": { invites: [] },
      "/api/admin/family-groups": { familyGroups: [SUMMARY] },
    });
  });
  afterEach(async () => {
    // The shared useSearchParams mock returns a fresh object each render, so the
    // page's mount effect re-fires and can leave an in-flight fetchData in the
    // microtask queue. Unmount and drain it while the stub is still active, so
    // no request lands on the real fetch after the global stub is torn down.
    cleanup();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStatus = "authenticated";
  });

  it("disables New Group and row Delete but keeps row Edit open for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<FamilyGroupsPage />);

    const del = await screen.findByRole("button", { name: /Delete Kea Family/i });
    expect(del).toBeDisabled();
    const newGroup = screen.getByRole("button", { name: /New Group/i });
    expect(newGroup).toBeDisabled();
    // #2160: both controls are still gated exactly as before, but the reason is
    // now stated once by the page's section banner instead of on each button.
    expect(del).not.toHaveAttribute("title");
    expect(newGroup).not.toHaveAttribute("title");
    expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent(
      ADMIN_VIEW_ONLY_SECTION_HEADING,
    );
    // Edit opens the (internally edit-gated) editor, so it stays available for
    // read-only browsing — mirroring the members/[id] open-editor trigger.
    expect(
      screen.getByRole("button", { name: /Edit Kea Family/i }),
    ).toBeEnabled();
  });

  it("keeps New Group and row Delete disabled without a read-only reason while the session is resolving", async () => {
    sessionStatus = "loading";
    sessionMatrix = matrix("edit", { membership: "edit" });
    render(<FamilyGroupsPage />);

    const del = await screen.findByRole("button", { name: /Delete Kea Family/i });
    expect(del).toBeDisabled();
    expect(del).not.toHaveAttribute("title", ADMIN_VIEW_ONLY_ACTION_REASON);
    const newGroup = screen.getByRole("button", { name: /New Group/i });
    expect(newGroup).toBeDisabled();
    expect(newGroup).not.toHaveAttribute("title", ADMIN_VIEW_ONLY_ACTION_REASON);
  });

  it("enables New Group and the create form (and row Delete) for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<FamilyGroupsPage />);

    expect(
      await screen.findByRole("button", { name: /Delete Kea Family/i }),
    ).toBeEnabled();
    const newGroup = screen.getByRole("button", { name: /New Group/i });
    expect(newGroup).toBeEnabled();

    // Opening the create form surfaces a live group-name input, and Create Group
    // carries no read-only reason (its disabled state is only the empty-member
    // rule, not edit gating).
    fireEvent.click(newGroup);
    expect(await screen.findByLabelText("Group Name")).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Create Group/i }),
    ).not.toHaveAttribute("title", ADMIN_VIEW_ONLY_ACTION_REASON);
  });
});

describe("MemberBillingFamilyCard view-only gating (#1997, finance)", () => {
  afterEach(() => {
    sessionMatrix = null;
    vi.restoreAllMocks();
  });

  const props = {
    memberId: "m1",
    billingFamilyGroupId: null,
    familyGroups: [{ id: "fg1", name: "Kea" }],
    familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER" as const,
  } as unknown as ComponentProps<typeof MemberBillingFamilyCard>;

  it("disables the billing-family select for a finance:view admin", () => {
    sessionMatrix = matrix("view", { finance: "view" });
    render(<MemberBillingFamilyCard {...props} canEdit={false} />);
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("enables the billing-family select for a finance:edit admin", () => {
    sessionMatrix = matrix("view", { finance: "edit" });
    render(<MemberBillingFamilyCard {...props} canEdit={true} />);
    expect(screen.getByRole("combobox")).toBeEnabled();
  });
});

describe("MemberLodgeAccessCard view-only gating (#1997, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/lodges": {
        lodges: [
          { id: "l1", name: "Lodge One", active: true },
          { id: "l2", name: "Lodge Two", active: true },
        ],
      },
      "/api/admin/members/m1/lodge-access": { lodgeAccess: [] },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the notice and disables Save for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<MemberLodgeAccessCard memberId="m1" />);
    expect(
      await screen.findByText(/can view lodge access but cannot change it/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Save Lodge Access/i }),
    ).toBeDisabled();
  });

  it("enables Save for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<MemberLodgeAccessCard memberId="m1" />);
    expect(
      await screen.findByRole("button", { name: /Save Lodge Access/i }),
    ).toBeEnabled();
  });
});

describe("MemberPartnerLinkCard view-only gating (#1997, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/members/m1/partner-link": {
        confirmed: null,
        pendingIncoming: [],
        pendingOutgoing: [],
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables Assign Partner for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(
      <MemberPartnerLinkCard
        memberId="m1"
        isAdultMember
        memberIsArchived={false}
        currentMemberPath="/admin/members/m1"
      />,
    );
    expect(
      await screen.findByRole("button", { name: /Assign Partner/i }),
    ).toBeDisabled();
  });

  it("enables Assign Partner for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(
      <MemberPartnerLinkCard
        memberId="m1"
        isAdultMember
        memberIsArchived={false}
        currentMemberPath="/admin/members/m1"
      />,
    );
    expect(
      await screen.findByRole("button", { name: /Assign Partner/i }),
    ).toBeEnabled();
  });
});

describe("MemberSeasonalMembershipCard view-only gating (#1997, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({ "/api/admin/membership-types": { membershipTypes: [] } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const member = {
    id: "m1",
    role: "MEMBER",
    subscriptions: [],
    seasonalMembershipAssignments: [],
  } as unknown as ComponentProps<typeof MemberSeasonalMembershipCard>["member"];

  it("shows the view-only notice for a membership:view admin", () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<MemberSeasonalMembershipCard member={member} onSaved={vi.fn()} />);
    expect(
      screen.getByText(/can view the seasonal membership type but cannot/i),
    ).toBeInTheDocument();
  });

  it("hides the view-only notice for a membership:edit admin", () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<MemberSeasonalMembershipCard member={member} onSaved={vi.fn()} />);
    expect(
      screen.queryByText(/can view the seasonal membership type but cannot/i),
    ).not.toBeInTheDocument();
  });
});

describe("MemberCommitteeAssignmentsCard view-only gating (#1997, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({ "/api/admin/committee/roles": { roles: [] } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const member = {
    id: "m1",
    firstName: "Pat",
    lastName: "Kea",
    committeeAssignments: [],
  } as unknown as ComponentProps<typeof MemberCommitteeAssignmentsCard>["member"];

  it("shows the view-only notice for a membership:view admin", () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<MemberCommitteeAssignmentsCard member={member} onSaved={vi.fn()} />);
    expect(
      screen.getByText(/can view committee assignments but cannot/i),
    ).toBeInTheDocument();
  });

  it("hides the view-only notice for a membership:edit admin", () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<MemberCommitteeAssignmentsCard member={member} onSaved={vi.fn()} />);
    expect(
      screen.queryByText(/can view committee assignments but cannot/i),
    ).not.toBeInTheDocument();
  });
});

describe("MemberContactGroup view-only gating (#1997, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/member-fields": {
        settings: { showTitle: true, showGender: true, showOccupation: true },
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const readOnlyEdit = {
    editing: false,
    form: null,
    saving: false,
    error: "",
    errorRef: { current: null },
    startEdit: vi.fn(),
    cancelEdit: vi.fn(),
    updateForm: vi.fn(),
    save: vi.fn(),
  } as unknown as MemberGroupEditState<MemberContactEditForm>;

  const member = {
    id: "m1",
    firstName: "Pat",
    lastName: "Kea",
    email: "pat@example.test",
    accessRoles: [],
    role: "MEMBER",
  } as unknown as ComponentProps<typeof MemberContactGroup>["member"];

  it("disables the Edit button for a membership:view admin", () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(
      <MemberContactGroup
        member={member}
        isSelf={false}
        actorIsFullAdmin
        edit={readOnlyEdit}
        canEdit={false}
      />,
    );
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeDisabled();
  });

  it("enables the Edit button for a membership:edit admin", () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(
      <MemberContactGroup
        member={member}
        isSelf={false}
        actorIsFullAdmin
        edit={readOnlyEdit}
        canEdit
      />,
    );
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeEnabled();
  });

  // #2065 regression pin: this child previously carried a truthy `canEdit = true`
  // default, so a parent forwarding the raw tri-state hook value during the
  // resolution window (`undefined`) coerced it to `true` and briefly flashed an
  // ENABLED Edit control to a would-be view-only admin. With the default removed
  // and the prop required, `undefined` flows through to the neutral disabled
  // state — disabled, but WITHOUT the resolved view-only reason (that is reserved
  // for `canEdit === false`).
  it("renders the neutral disabled Edit state (not enabled) while access resolves", () => {
    render(
      <MemberContactGroup
        member={member}
        isSelf={false}
        actorIsFullAdmin
        edit={readOnlyEdit}
        canEdit={undefined}
      />,
    );
    const editButton = screen.getByRole("button", { name: /^Edit$/i });
    expect(editButton).toBeDisabled();
    // Neutral, not resolved-view-only: no read-only reason is advertised yet.
    expect(editButton).not.toHaveAttribute(
      "title",
      ADMIN_VIEW_ONLY_ACTION_REASON,
    );
  });
});

describe("MemberDetailHeader view-only gating (#1997, membership + finance)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    // The header resolves access-role labels via a fetch that falls back when
    // unavailable; stub it so the render-only cases never hit an unstubbed URL.
    stubFetchRoutes({ "/api/admin/access-roles": { options: [] } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // xeroContactId=null with a live Xero connection renders the "Link to Xero"
  // button-style action directly, so both the membership action (Add Dependent)
  // and a finance action are visible affordances that can be asserted without
  // opening a Radix dropdown.
  const headerProps = {
    member: {
      id: "m1",
      firstName: "Pat",
      lastName: "Kea",
      email: "pat@example.test",
      accessRoles: [],
      active: true,
      cancelledAt: null,
      archivedAt: null,
      forcePasswordChange: false,
      xeroContactId: null,
    },
    backHref: "/admin/members",
    backLabel: "Back",
    isAdultMember: true,
    memberIsArchived: false,
    pendingDeleteRequest: undefined,
    xeroConnected: true,
    xeroPushing: false,
    xeroUnlinking: false,
    onOpenDependentDialog: vi.fn(),
    onOpenLinkXero: vi.fn(),
    onOpenCreateXero: vi.fn(),
    onUnlinkXero: vi.fn(),
  } as unknown as ComponentProps<typeof MemberDetailHeader>;

  it("gates the two areas independently: membership edit + finance view", () => {
    sessionMatrix = matrix("view", { membership: "edit", finance: "view" });
    render(
      <MemberDetailHeader
        {...headerProps}
        canEditMembership={true}
        canEditFinance={false}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Add Dependent/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /Link to Xero/i })).toBeDisabled();
  });

  it("gates the two areas independently: membership view + finance edit", () => {
    sessionMatrix = matrix("view", { membership: "view", finance: "edit" });
    render(
      <MemberDetailHeader
        {...headerProps}
        canEditMembership={false}
        canEditFinance={true}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Add Dependent/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Link to Xero/i })).toBeEnabled();
  });
});

describe("FamilySuggestionsPage view-only gating (#1997, membership)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    stubFetchRoutes({
      "/api/admin/family-suggestions": {
        suggestions: [],
        ungroupedCount: 0,
        totalMembers: 0,
        hiddenCount: 1,
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the notice and disables Reset hidden for a membership:view admin", async () => {
    sessionMatrix = matrix("view", { membership: "view" });
    render(<FamilySuggestionsPage />);
    expect(
      await screen.findByText(
        /can view family group suggestions but cannot create, hide, or reset/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Reset hidden/i }),
    ).toBeDisabled();
  });

  it("hides the notice and enables Reset hidden for a membership:edit admin", async () => {
    sessionMatrix = matrix("view", { membership: "edit" });
    render(<FamilySuggestionsPage />);
    expect(
      await screen.findByRole("button", { name: /Reset hidden/i }),
    ).toBeEnabled();
    expect(
      screen.queryByText(
        /can view family group suggestions but cannot create, hide, or reset/i,
      ),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #2065: session-resolution neutral state. Before the client session resolves,
// useAdminAreaEditAccess returns `undefined`, and every consumer must render a
// NEUTRAL state — no "view only" banner, no read-only editor caption, and
// controls disabled (never flashing enabled for a would-be view-only admin,
// never flashing the banner for a would-be editor). SiteContentPanel is the
// representative consumer (banner + read-only WysiwygEditor + ViewOnlyActionButton
// Save). Once resolved, behaviour is identical to today (covered by the
// SiteContentPanel #1927 block above and asserted again here both ways).
// ---------------------------------------------------------------------------

describe("SiteContentPanel session-resolution neutral state (#2065)", () => {
  beforeEach(() => {
    sessionMatrix = null;
    sessionStatus = "authenticated";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ documents: SITE_CONTENT_DOCUMENTS }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStatus = "authenticated";
  });

  it("shows no banner or read-only caption and keeps Save disabled while resolving", async () => {
    // Session still resolving: matrix is irrelevant, status drives undefined.
    sessionStatus = "loading";
    sessionMatrix = matrix("edit");
    render(<SiteContentPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /Save Footer/i,
    });
    expect(saveButtons.length).toBeGreaterThan(0);
    // Neutral: controls disabled (a would-be view-only admin never sees them
    // enabled), and NO view-only banner / read-only editor caption.
    for (const button of saveButtons) {
      expect(button).toBeDisabled();
    }
    expect(
      screen.queryByText(/can view site content but cannot change/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/View only — your admin role cannot edit/i),
    ).not.toBeInTheDocument();
  });

  it("shows the banner and disabled Save once resolved to a view-only admin", async () => {
    sessionStatus = "authenticated";
    sessionMatrix = matrix("view");
    render(<SiteContentPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /Save Footer/i,
    });
    for (const button of saveButtons) {
      expect(button).toBeDisabled();
    }
    expect(
      screen.getAllByText(/View only — your admin role cannot edit/i).length,
    ).toBeGreaterThan(0);
  });

  it("shows enabled Save and no banner once resolved to an edit-capable admin", async () => {
    sessionStatus = "authenticated";
    sessionMatrix = matrix("edit");
    render(<SiteContentPanel />);

    const saveButtons = await screen.findAllByRole("button", {
      name: /Save Footer/i,
    });
    for (const button of saveButtons) {
      expect(button).toBeEnabled();
    }
    expect(
      screen.queryByText(/can view site content but cannot change/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/View only — your admin role cannot edit/i),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #2168 — the member detail page renders ONE view-only banner and the eight
// membership-scoped cards below it hand over their per-button reason.
//
// This is the BEHAVIOURAL check of the property that
// `src/components/admin/__tests__/view-only-banner-contract.test.ts` proves
// statically, and it is deliberately independent of that mechanism: it renders
// the real components and looks at what a view-only admin actually gets, so a
// bug in the static analysis cannot make it pass.
//
// Two halves, and BOTH matter:
//
//  - default (no vouching parent): every gated control still carries the
//    reason, and the three cards that own a Notice still render it. This is the
//    half that guarantees the opt-out can never orphan an explanation — drop a
//    card into a dialog, a new page, or a test, and it explains itself.
//  - vouched: the reason and the same-scope Notice are gone, and the control is
//    still disabled. Gating never depends on this prop; only who states the
//    reason does.
// ---------------------------------------------------------------------------

describe("member detail cards hand their reason to the page banner (#2168)", () => {
  afterEach(() => {
    sessionMatrix = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const member = {
    id: "m1",
    firstName: "Pat",
    lastName: "Kea",
    email: "pat@example.test",
    role: "MEMBER",
    // #2282: `MemberDependentsCard` derives its own "can this member take a
    // dependent?" rule from the member row, so the fixture has to be a
    // realistic one. Without these, the card's control is disabled by THAT rule
    // (an absent `active` reads as inactive) and `expect(control).toBeDisabled()`
    // below would stop isolating the view-only permission it is testing.
    active: true,
    archivedAt: null,
    canLogin: true,
    accessRoles: [],
    dependentEmailSource: null,
    parentLinks: [],
    dependents: [],
    subscriptions: [],
    seasonalMembershipAssignments: [],
    committeeAssignments: [],
  };

  interface VouchCase {
    name: string;
    routes?: Record<string, unknown>;
    /** A control the card gates, used to prove gating is unchanged. */
    control: RegExp;
    /** Same-scope Notice the card drops when an ancestor vouches, if any. */
    notice?: RegExp;
    render: (vouched: boolean) => void;
  }

  const cases: VouchCase[] = [
    {
      name: "MemberDeletionCard",
      control: /Request Delete/i,
      render: (vouched) =>
        render(
          <MemberDeletionCard
            {...({
              deleteEligibility: { eligible: true, blockers: [] },
              deleteRequests: [],
              pendingDeleteRequest: undefined,
              approvalBlockerCount: 0,
              canReviewPendingDeleteRequest: true,
              onOpenRequestDialog: vi.fn(),
              onOpenReviewDialog: vi.fn(),
            } as unknown as ComponentProps<typeof MemberDeletionCard>)}
            canEdit={false}
            ancestorRendersViewOnlyBanner={vouched}
          />,
        ),
    },
    {
      name: "MemberDependentsCard",
      control: /Add Dependent/i,
      render: (vouched) =>
        render(
          <MemberDependentsCard
            {...({
              member,
              currentMemberPath: "/admin/members/m1",
              unlinkingDependentId: null,
              onOpenDependentDialog: vi.fn(),
              onUnlinkDependent: vi.fn(),
            } as unknown as ComponentProps<typeof MemberDependentsCard>)}
            canEdit={false}
            ancestorRendersViewOnlyBanner={vouched}
          />,
        ),
    },
    {
      name: "MemberParentLinksCard",
      control: /Add Parent/i,
      render: (vouched) =>
        render(
          <MemberParentLinksCard
            {...({
              member,
              memberIsArchived: false,
              currentMemberPath: "/admin/members/m1",
              unlinkingDependentId: null,
              onOpenParentLinkDialog: vi.fn(),
              onUnlinkParent: vi.fn(),
            } as unknown as ComponentProps<typeof MemberParentLinksCard>)}
            canEdit={false}
            ancestorRendersViewOnlyBanner={vouched}
          />,
        ),
    },
    {
      name: "MemberLifecycleCard",
      control: /Request Archive/i,
      render: (vouched) =>
        render(
          <MemberLifecycleCard
            {...({
              member,
              pendingArchiveRequest: null,
              reviewedArchiveRequests: [],
              isArchiveRequester: false,
              canRequestArchive: true,
              canRequestCancellation: false,
              openCancellationRequest: null,
              archiveError: "",
              archiveReason: "",
              archiveReviewNotes: {},
              archiveActionLoading: null,
              cancellationError: "",
              cancellationReason: "",
              cancellationSubmitting: false,
              onChangeArchiveReason: vi.fn(),
              onChangeArchiveReviewNote: vi.fn(),
              onChangeCancellationReason: vi.fn(),
              onSubmitArchive: vi.fn(),
              onSubmitCancellation: vi.fn(),
              onReviewArchive: vi.fn(),
            } as unknown as ComponentProps<typeof MemberLifecycleCard>)}
            canEdit={false}
            ancestorRendersViewOnlyBanner={vouched}
          />,
        ),
    },
    {
      name: "MemberPartnerLinkCard",
      routes: {
        "/api/admin/members/m1/partner-link": {
          confirmed: null,
          pendingIncoming: [],
          pendingOutgoing: [],
        },
      },
      control: /Assign Partner/i,
      render: (vouched) =>
        render(
          <MemberPartnerLinkCard
            memberId="m1"
            isAdultMember
            memberIsArchived={false}
            currentMemberPath="/admin/members/m1"
            ancestorRendersViewOnlyBanner={vouched}
          />,
        ),
    },
    {
      name: "MemberSeasonalMembershipCard",
      routes: { "/api/admin/membership-types": { membershipTypes: [] } },
      control: /Preview/i,
      notice: /can view the seasonal membership type but cannot/i,
      render: (vouched) =>
        render(
          <MemberSeasonalMembershipCard
            member={
              member as unknown as ComponentProps<
                typeof MemberSeasonalMembershipCard
              >["member"]
            }
            onSaved={vi.fn()}
            ancestorRendersViewOnlyBanner={vouched}
          />,
        ),
    },
    {
      name: "MemberCommitteeAssignmentsCard",
      routes: { "/api/admin/committee/roles": { roles: [] } },
      control: /Add Assignment/i,
      notice: /can view committee assignments but cannot/i,
      render: (vouched) =>
        render(
          <MemberCommitteeAssignmentsCard
            member={
              member as unknown as ComponentProps<
                typeof MemberCommitteeAssignmentsCard
              >["member"]
            }
            onSaved={vi.fn()}
            ancestorRendersViewOnlyBanner={vouched}
          />,
        ),
    },
    {
      name: "MemberLodgeAccessCard",
      routes: {
        "/api/admin/lodges": {
          lodges: [
            { id: "l1", name: "Lodge One", active: true },
            { id: "l2", name: "Lodge Two", active: true },
          ],
        },
        "/api/admin/members/m1/lodge-access": { lodgeAccess: [] },
      },
      control: /Save Lodge Access/i,
      notice: /can view lodge access but cannot change it/i,
      render: (vouched) =>
        render(
          <MemberLodgeAccessCard
            memberId="m1"
            ancestorRendersViewOnlyBanner={vouched}
          />,
        ),
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} states the reason itself when nothing vouches for it`, async () => {
      sessionMatrix = matrix("view", { membership: "view" });
      if (testCase.routes) stubFetchRoutes(testCase.routes);
      testCase.render(false);

      const control = await screen.findByRole("button", {
        name: testCase.control,
      });
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute("title", ADMIN_VIEW_ONLY_ACTION_REASON);
      const describedBy = control.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy ?? "")).toHaveTextContent(
        ADMIN_VIEW_ONLY_ACTION_REASON,
      );
      if (testCase.notice) {
        expect(screen.getByText(testCase.notice)).toBeInTheDocument();
      }
    });

    it(`${testCase.name} hands the reason over when an ancestor vouches`, async () => {
      sessionMatrix = matrix("view", { membership: "view" });
      if (testCase.routes) stubFetchRoutes(testCase.routes);
      testCase.render(true);

      const control = await screen.findByRole("button", {
        name: testCase.control,
      });
      // Gating is untouched — only WHERE the explanation lives changes.
      expect(control).toBeDisabled();
      expect(control).not.toHaveAttribute(
        "title",
        ADMIN_VIEW_ONLY_ACTION_REASON,
      );
      // Not one control in the card keeps the reason, not just this one.
      expect(
        document.querySelectorAll(`[title="${ADMIN_VIEW_ONLY_ACTION_REASON}"]`)
          .length,
      ).toBe(0);
      expect(
        screen.queryByText(ADMIN_VIEW_ONLY_ACTION_REASON),
      ).not.toBeInTheDocument();
      if (testCase.notice) {
        expect(screen.queryByText(testCase.notice)).not.toBeInTheDocument();
      }
    });
  }
});
