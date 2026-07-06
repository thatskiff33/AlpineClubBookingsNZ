// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPendingCounts } from "@/lib/admin-pending-counts";

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

const ZERO_COUNTS: AdminPendingCounts = {
  familyRequests: 0,
  memberApplications: 0,
  refundAppeals: 0,
  creditApprovals: 0,
  bookingReviews: 0,
  bookingChangeRequests: 0,
  publicBookingRequests: 0,
  membershipCancellations: 0,
  archiveRequests: 0,
  deletionRequests: 0,
  issueReports: 0,
  unassignedHutLeaderDates: 0,
};

function buildFetchMock(counts: Partial<AdminPendingCounts> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/api/admin/pending-counts")) {
      return { ok: true, json: async () => ({ ...ZERO_COUNTS, ...counts }) };
    }

    return { ok: true, json: async () => ({}) };
  });
}

describe("AdminSidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", buildFetchMock());
  });

  it("expands sections by default and persists collapsed state", () => {
    render(<AdminSidebar features={allOn} />);

    const sectionToggle = screen.getByRole("button", {
      name: "Bookings & Beds",
    });
    expect(sectionToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Bookings" })).not.toBeNull();

    fireEvent.click(sectionToggle);

    expect(sectionToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Bookings" })).toBeNull();
    expect(
      JSON.parse(
        window.localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) ?? "{}",
      ),
    ).toMatchObject({ "Bookings & Beds": false });
  });

  it("restores persisted collapsed sections after mount", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ Finance: false }),
    );

    render(<AdminSidebar features={allOn} />);

    const financeToggle = screen.getByRole("button", { name: "Finance" });
    await waitFor(() =>
      expect(financeToggle.getAttribute("aria-expanded")).toBe("false"),
    );
    expect(screen.queryByRole("link", { name: "Payments" })).toBeNull();
  });

  it("fetches all badge counts with a single request", async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminSidebar features={allOn} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/admin/pending-counts",
    );
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
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ Members: false }),
    );
    vi.stubGlobal("fetch", buildFetchMock({ familyRequests: 2 }));

    render(<AdminSidebar features={allOn} />);

    const membersToggle = screen.getByRole("button", { name: "Members" });
    await waitFor(() =>
      expect(membersToggle.getAttribute("aria-expanded")).toBe("false"),
    );

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Family Groups/ }),
    ).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull();
  });

  it("surfaces queued public booking requests in Needs Attention", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ "Bookings & Beds": false }),
    );
    vi.stubGlobal("fetch", buildFetchMock({ publicBookingRequests: 3 }));

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Booking Requests/ }),
    ).not.toBeNull();
    expect(screen.getByText("3")).not.toBeNull();
  });

  it("combines internal review, change request, and public queue counts on the Booking Requests badge", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ "Bookings & Beds": false }),
    );
    vi.stubGlobal(
      "fetch",
      buildFetchMock({
        bookingReviews: 2,
        bookingChangeRequests: 1,
        publicBookingRequests: 3,
      }),
    );

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Booking Requests/ }),
    ).not.toBeNull();
    expect(screen.getByText("6")).not.toBeNull();
  });

  it("shows unassigned hut leader dates in Needs Attention", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ "Lodge Operations": false }),
    );
    vi.stubGlobal("fetch", buildFetchMock({ unassignedHutLeaderDates: 4 }));

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(screen.getByRole("link", { name: /Hut Leaders/ })).not.toBeNull();
    expect(screen.getByText("4")).not.toBeNull();
  });

  it("surfaces pending account deletion requests in Needs Attention", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ "Monitoring & Support": false }),
    );
    vi.stubGlobal("fetch", buildFetchMock({ deletionRequests: 2 }));

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Deletion Requests/ }),
    ).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull();
  });

  it("labels the membership cancellation queue as Cancellation Requests", () => {
    const section = getVisibleAdminNavSections(allOn).find(
      (item) => item.label === "Members",
    );

    expect(section?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: "/admin/membership-cancellations",
          label: "Cancellation Requests",
        }),
      ]),
    );
  });
});
