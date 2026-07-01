// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

const SIDEBAR_COLLAPSE_STORAGE_KEY = "admin-sidebar:expanded-sections";

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/dashboard",
}));

import {
  AdminSidebar,
  getVisibleAdminNavSections,
} from "@/components/admin-sidebar";

function mockJsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  };
}

function buildFetchMock(
  options: { familyRequestCount?: number; unassignedHutLeaderDates?: number } = {},
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/api/admin/family-groups/requests")) {
      return mockJsonResponse({
        requests: Array.from(
          { length: options.familyRequestCount ?? 0 },
          (_, index) => ({
            id: `family-request-${index + 1}`,
          }),
        ),
      });
    }
    if (url.includes("/api/admin/member-applications")) {
      return mockJsonResponse({ pendingCount: 0 });
    }
    if (url.includes("/api/admin/refund-requests")) {
      return mockJsonResponse({ total: 0 });
    }
    if (url.includes("/api/admin/booking-reviews")) {
      return mockJsonResponse({ pagination: { total: 0 } });
    }
    if (url.includes("/api/admin/booking-change-requests")) {
      return mockJsonResponse({ total: 0 });
    }
    if (url.includes("/api/admin/credit-approvals")) {
      return mockJsonResponse([]);
    }
    if (url.includes("/api/admin/membership-cancellation-requests")) {
      return mockJsonResponse({ pendingCount: 0 });
    }
    if (url.includes("/api/admin/member-lifecycle-action-requests")) {
      return mockJsonResponse({ pendingCount: 0 });
    }
    if (url.includes("/api/admin/issue-reports")) {
      return mockJsonResponse({ total: 0 });
    }
    if (url.includes("/api/admin/hut-leaders/unassigned-dates")) {
      return mockJsonResponse({
        unassignedDates: Array.from(
          { length: options.unassignedHutLeaderDates ?? 0 },
          (_, index) => ({
            date: `2026-07-${String(index + 1).padStart(2, "0")}`,
          }),
        ),
      });
    }

    return mockJsonResponse({});
  });
}

describe("AdminSidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", buildFetchMock());
  });

  it("collapses sections by default and persists expanded state", () => {
    render(<AdminSidebar features={allOn} />);

    const sectionToggle = screen.getByRole("button", {
      name: "Bookings & Beds",
    });
    expect(sectionToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Bookings" })).toBeNull();

    fireEvent.click(sectionToggle);

    expect(sectionToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Bookings" })).not.toBeNull();
    expect(
      JSON.parse(
        window.localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) ?? "{}",
      ),
    ).toMatchObject({ "Bookings & Beds": true });
  });

  it("restores persisted expanded sections after mount", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ Finance: true }),
    );

    render(<AdminSidebar features={allOn} />);

    const financeToggle = screen.getByRole("button", { name: "Finance" });
    await waitFor(() =>
      expect(financeToggle.getAttribute("aria-expanded")).toBe("true"),
    );
    expect(screen.getByRole("link", { name: "Payments" })).not.toBeNull();
  });

  it("shows membership type settings in setup and configuration", () => {
    const section = getVisibleAdminNavSections(allOn).find(
      (item) => item.label === "Setup & Configuration",
    );

    expect(section?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: "/admin/membership-types",
          label: "Membership Types",
        }),
      ]),
    );
  });

  it("keeps pending family group requests visible while Members is collapsed", async () => {
    vi.stubGlobal("fetch", buildFetchMock({ familyRequestCount: 2 }));

    render(<AdminSidebar features={allOn} />);

    const membersToggle = screen.getByRole("button", { name: "Members" });
    expect(membersToggle.getAttribute("aria-expanded")).toBe("false");

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Family Groups/ }),
    ).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull();
  });

  it("shows unassigned hut leader dates in Needs Attention", async () => {
    vi.stubGlobal("fetch", buildFetchMock({ unassignedHutLeaderDates: 4 }));

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(screen.getByRole("link", { name: /Hut Leaders/ })).not.toBeNull();
    expect(screen.getByText("4")).not.toBeNull();
  });
});
