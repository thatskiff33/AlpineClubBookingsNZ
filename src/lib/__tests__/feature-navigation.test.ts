import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getRenderedAdminNavSections,
  getVisibleAdminNavSections,
} from "@/components/admin-sidebar";
import { getNavBarLinks } from "@/components/nav-bar";
import { buildBookingRequestsHref } from "@/lib/admin-booking-requests-path";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

// All modules on; derived so it covers every module key without drifting.
const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

function collectAdminPageRoutes() {
  const root = path.join(process.cwd(), "src/app/(admin)/admin");
  const routes = new Set<string>();

  function walk(dir: string, segments: string[]) {
    if (fs.existsSync(path.join(dir, "page.tsx"))) {
      routes.add(`/admin/${segments.join("/")}`);
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      walk(path.join(dir, entry.name), [...segments, entry.name]);
    }
  }

  walk(root, []);
  return routes;
}

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
      bedAllocation: false,
      chores: false,
      waitlist: false,
      xeroIntegration: false,
    }).flatMap((section) => section.items.map((item) => item.label));

    expect(items).not.toContain("Bed Allocation");
    expect(items).not.toContain("Waitlist");
    expect(items).not.toContain("Roster");
    expect(items).not.toContain("Chores");
    expect(items).not.toContain("Xero");
    expect(items).toContain("Bookings");
    expect(items).toContain("Booking Requests");
    expect(items).toContain("Stuck States");
    expect(items).not.toContain("Change Requests");
    expect(items).toContain("Modules");
  });

  it("links booking request navigation to the combined request page", () => {
    const item = getVisibleAdminNavSections(allOn)
      .flatMap((section) => section.items)
      .find((navItem) => navItem.label === "Booking Requests");

    expect(item?.href).toBe("/admin/booking-requests");
  });

  it("only renders Needs Attention links for queues with pending counts", () => {
    const noPending = getRenderedAdminNavSections(allOn, {});

    expect(noPending.map((section) => section.label)).not.toContain(
      "Needs Attention",
    );

    const withPending = getRenderedAdminNavSections(allOn, {
      "/admin/booking-requests": 2,
      "/admin/family-groups": 3,
      "/admin/issue-reports": 1,
      "/admin/hut-leaders": 4,
    });
    const needsAttention = withPending.find(
      (section) => section.label === "Needs Attention",
    );

    expect(needsAttention?.items.map((item) => item.href)).toEqual([
      "/admin/booking-requests",
      "/admin/family-groups",
      "/admin/issue-reports",
      "/admin/hut-leaders",
    ]);
  });

  it("links only to public admin routes that exist", () => {
    const routeSet = collectAdminPageRoutes();
    const navHrefs = getVisibleAdminNavSections(allOn).flatMap((section) =>
      section.items.map((item) => item.href),
    );

    for (const href of navHrefs) {
      expect(routeSet.has(href), `${href} should have an admin page`).toBe(true);
    }
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
