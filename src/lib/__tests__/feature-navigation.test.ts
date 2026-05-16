import { describe, expect, it } from "vitest";
import { getVisibleAdminNavSections } from "@/components/admin-sidebar";
import { getNavBarLinks } from "@/components/nav-bar";
import type { FeatureFlags } from "@/config/schema";

const allOn: FeatureFlags = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
};

describe("feature-aware navigation", () => {
  it("hides finance and kiosk links from the member nav when flags are off", () => {
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

  it("keeps visible links when the matching flags are on", () => {
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

  it("hides flagged admin sidebar items", () => {
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
  });
});
