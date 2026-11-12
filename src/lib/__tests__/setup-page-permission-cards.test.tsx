// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

// The two cross-area cards are mocked to cheap markers: this test exercises the
// client's matrix-driven conditional (#1548), not the cards' own fetches.
vi.mock("@/components/admin/lodge-capacity-card", () => ({
  LodgeCapacityCard: () => <div data-testid="lodge-card" />,
}));
vi.mock("@/components/admin/finance-report-mappings-panel", () => ({
  FinanceReportMappingsPanel: () => <div data-testid="finance-panel" />,
}));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => false,
}));

import { SetupPageClient } from "@/app/(admin)/admin/setup/setup-page-client";

const setupBody = {
  readiness: {
    status: "blocked",
    summary: { total: 1, complete: 0, warning: 0, blocked: 1, skipped: 0 },
    categories: [
      {
        id: "foundation",
        title: "Foundation",
        description: "Club identity and first-install readiness.",
        status: "blocked",
        checks: [
          {
            id: "runtime-env",
            title: "Runtime Environment",
            description: "Database, auth, app origin, cron, and seed admin.",
            status: "blocked",
            required: true,
            message: "Required runtime variables are missing or invalid.",
            details: ["Fix DATABASE_URL"],
            href: "/admin/setup/foundations",
            progress: "open",
          },
          {
            // S1 (#4796): a support page's check whose page is membership.
            id: "membership-cancellation",
            title: "Membership Cancellation",
            description: "Warning text, rejoin process text, and Xero cancellation handling.",
            status: "warning",
            required: false,
            message: "Membership cancellation settings were not checked.",
            details: [],
            href: "/admin/membership-cancellations?tab=settings",
            progress: "open",
          },
        ],
      },
    ],
    generatedAt: "2026-01-01T00:00:00.000Z",
  },
  progress: {
    completedStepIds: [],
    skippedStepIds: [],
    completedAt: null,
    completedByMemberId: null,
  },
};

function stubSetupFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => setupBody,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

function matrix(
  overrides: Partial<AdminPermissionMatrix>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

function renderSetup(overrides: Partial<AdminPermissionMatrix>) {
  return render(
    <SetupPageClient
      permissionMatrix={matrix(overrides)}
      features={allOn}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SetupPageClient — permission-aware cross-area cards (#1548)", () => {
  beforeEach(() => {
    stubSetupFetch();
  });

  it("hides the lodge card when the viewer lacks lodge access", async () => {
    renderSetup({ support: "view" });

    await waitFor(() => {
      expect(screen.getByText("Setup Wizard")).toBeTruthy();
    });
    expect(screen.queryByTestId("lodge-card")).toBeNull();
  });

  it("renders the lodge card when the viewer has lodge view", async () => {
    renderSetup({ support: "view", lodge: "view" });

    await waitFor(() => {
      expect(screen.getByTestId("lodge-card")).toBeTruthy();
    });
  });

  it("hides the finance drill-down when the viewer lacks finance access", async () => {
    const { container } = renderSetup({ support: "view" });

    await waitFor(() => {
      expect(screen.getByText("Setup Wizard")).toBeTruthy();
    });
    expect(screen.queryByTestId("finance-panel")).toBeNull();
    expect(container.querySelector('a[href="/admin/setup/finance"]')).toBeNull();
  });

  it("links to finance setup without rendering mappings on the main page", async () => {
    const { container } = renderSetup({ support: "view", finance: "view" });

    await waitFor(() => {
      expect(screen.getByText("Setup hubs")).toBeTruthy();
    });
    expect(container.querySelector('a[href="/admin/setup/finance"]')).toBeTruthy();
    expect(screen.queryByTestId("finance-panel")).toBeNull();
  });

  it("places KPIs, blockers, hubs, and checks in the expected order", async () => {
    const { container } = renderSetup({
      support: "view",
      finance: "view",
      bookings: "view",
      lodge: "view",
      membership: "view",
    });

    await waitFor(() => {
      expect(screen.getByText("Setup hubs")).toBeTruthy();
    });

    const html = container.innerHTML;
    expect(html.indexOf("Overall")).toBeLessThan(
      html.indexOf("Resolve or explicitly skip"),
    );
    expect(html.indexOf("Resolve or explicitly skip")).toBeLessThan(
      html.indexOf("Setup hubs"),
    );
    expect(html.indexOf("Setup hubs")).toBeLessThan(
      html.indexOf("Readiness checks"),
    );
  });
});

describe("SetupPageClient — links offered only where they open (S1 #4796)", () => {
  beforeEach(() => {
    stubSetupFetch();
  });

  it("shows each hub card exactly when its page would open", async () => {
    const { container } = renderSetup({ support: "view" });
    await waitFor(() => {
      expect(screen.getByText("Setup hubs")).toBeTruthy();
    });
    expect(container.querySelector('a[href="/admin/health#integration-readiness"]')).toBeTruthy();
    expect(container.querySelector('a[href="/admin/bookings-setup"]')).toBeNull();
    expect(
      container.querySelector('a[href="/admin/membership-cancellations?tab=settings"]'),
    ).toBeNull();
  });

  it("keeps a readiness check but drops its Open link when the admin cannot open the page", async () => {
    renderSetup({ support: "view" });
    await waitFor(() => {
      expect(screen.getByText("Membership Cancellation")).toBeTruthy();
    });
    const openLinks = screen
      .getAllByRole("link", { name: /Open/ })
      .map((link) => link.getAttribute("href"));
    expect(openLinks).toContain("/admin/setup/foundations");
    expect(openLinks).not.toContain("/admin/membership-cancellations?tab=settings");
  });

  it("offers the Open link and the card to an admin who can open the page", async () => {
    const { container } = renderSetup({ support: "view", membership: "view", bookings: "view" });
    await waitFor(() => {
      expect(screen.getByText("Membership Cancellation")).toBeTruthy();
    });
    const openLinks = screen
      .getAllByRole("link", { name: /Open/ })
      .map((link) => link.getAttribute("href"));
    expect(openLinks).toContain("/admin/membership-cancellations?tab=settings");
    expect(container.querySelector('a[href="/admin/bookings-setup"]')).toBeTruthy();
  });
});
