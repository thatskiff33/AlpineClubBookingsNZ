import { describe, expect, it } from "vitest";
import { getVisibleAdminNavSections } from "@/components/admin-sidebar";
import { getNavBarLinks } from "@/components/nav-bar";
import { buildBookingRequestsHref } from "@/lib/admin-booking-requests-path";
import type { FeatureFlags } from "@/config/schema";

const allOn: FeatureFlags = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
  bedAllocation: true,
  internetBankingPayments: true,
};

describe("feature-aware navigation", () => {
  it("hides finance and kiosk links from the member nav when effective modules are off", () => {
    const labels = getNavBarLinks(
      {
        name: "Jane Member",
        email: "jane@example.org",
        role: "MEMBER",
        canAccessFinance: true,
        isHutLeader: true,
      },
      {
        ...allOn,
        financeDashboard: false,
        kiosk: false,
      }
    ).map((link) => link.label);

    expect(labels).not.toContain("Finance");
    expect(labels).not.toContain("Hut Leader");
  });

  it("keeps visible links when the matching effective modules are on", () => {
    const labels = getNavBarLinks(
      {
        name: "Jane Member",
        email: "jane@example.org",
        role: "MEMBER",
        canAccessFinance: true,
        isHutLeader: true,
      },
      allOn
    ).map((link) => link.label);

    expect(labels).toContain("Finance");
    expect(labels).toContain("Hut Leader");
  });

  it("hides disabled effective admin sidebar items", () => {
    const items = getVisibleAdminNavSections({
      ...allOn,
      chores: false,
      waitlist: false,
      xeroIntegration: false,
    }).flatMap((section) => section.items.map((item) => item.label));

    expect(items).not.toContain("Waitlist");
    expect(items).not.toContain("Roster");
    expect(items).not.toContain("Chores");
    expect(items).not.toContain("Xero");
    expect(items).toContain("Bookings");
    expect(items).toContain("Booking Requests");
    expect(items).not.toContain("Change Requests");
    expect(items).toContain("Modules");
  });

  it("links booking request navigation to the combined request page", () => {
    const item = getVisibleAdminNavSections(allOn)
      .flatMap((section) => section.items)
      .find((navItem) => navItem.label === "Booking Requests");

    expect(item?.href).toBe("/admin/booking-requests");
  });

  it("preserves old booking request deep-link params on the combined page", () => {
    expect(
      buildBookingRequestsHref("changes", {
        requestId: "request-1",
        tab: "approvals",
      })
    ).toBe("/admin/booking-requests?tab=changes&requestId=request-1");
  });
});
