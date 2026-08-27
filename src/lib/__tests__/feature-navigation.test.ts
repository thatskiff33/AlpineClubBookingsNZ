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
import { requireCalendarDate } from "@/lib/club-time";

// All modules on; derived so it covers every module key without drifting.
const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

/**
 * #3123 — the club's day, first and REQUIRED on the nav exports. Nothing in this
 * file asserts on the one dated href, so one fixed day serves every call.
 */
const CLUB_DAY = requireCalendarDate("2026-07-01");

/**
 * Every `/admin/**` page on disk, from whichever route group it lives in.
 *
 * This walked `src/app/(admin)/admin` alone, which assumed admin pages only ever
 * live in that one route group. That assumption is true again today — but it was
 * briefly false during AID-7 (#2378), and it failed in the direction that MATTERS:
 * a real, reachable page in another group was reported as not existing, so a correct
 * nav link looked like a broken one.
 *
 * It was the third guard in this repository to make the same assumption (the others
 * being the route-map drift guard's page walk and its feature-prefix check), all
 * found by one change that briefly put an admin page elsewhere. A route group is a
 * rendering concern; which pages exist is not. Discovering the groups keeps the two
 * from being tied together again, at no cost while every page is in `(admin)`.
 */
function collectAdminPageRoutes() {
  const appDir = path.join(process.cwd(), "src/app");
  const roots = fs
    .readdirSync(appDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("("))
    .map((group) => path.join(appDir, group.name, "admin"))
    .filter((dir) => fs.existsSync(dir));
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

  for (const root of roots) walk(root, []);
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
    const items = getVisibleAdminNavSections(CLUB_DAY, {
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
    // #2216: the Integrations hub is deliberately ungated from xeroIntegration —
    // it stays visible so the Stripe/Google/Backups/AI cards remain reachable.
    expect(items).toContain("Integrations");
    expect(items).toContain("Bookings");
    expect(items).toContain("Booking Requests");
    expect(items).toContain("Stuck States");
    expect(items).not.toContain("Change Requests");
    expect(items).toContain("Modules");
  });

  it("keeps feature-gated setup entries behind the same route visibility rules", () => {
    const items = getVisibleAdminNavSections(CLUB_DAY, {
      ...allOn,
      chores: false,
      skifieldConditions: false,
      xeroIntegration: false,
    })
      .find((section) => section.label === "Setup & Configuration")
      ?.items.map((item) => item.label);

    expect(items).toContain("Site Appearance & Content");
    expect(items).not.toContain("Chores");
    // #2216: Integrations is no longer Xero-gated (see the sidebar test above).
    expect(items).toContain("Integrations");
  });

  it("links booking request navigation to the combined request page", () => {
    const item = getVisibleAdminNavSections(CLUB_DAY, allOn)
      .flatMap((section) => section.items)
      .find((navItem) => navItem.label === "Booking Requests");

    expect(item?.href).toBe("/admin/booking-requests");
  });

  it("only renders Needs Attention links for queues with pending counts", () => {
    const noPending = getRenderedAdminNavSections(CLUB_DAY, allOn, {});

    expect(noPending.map((section) => section.label)).not.toContain(
      "Needs Attention",
    );

    const withPending = getRenderedAdminNavSections(CLUB_DAY, allOn, {
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
    const navHrefs = getVisibleAdminNavSections(CLUB_DAY, allOn).flatMap((section) =>
      section.items.map((item) => item.href),
    );

    for (const href of navHrefs) {
      // Deep links may carry query params (e.g. the Needs Attention
      // unpaid-finished-stays link, #1731); the page route is the pathname.
      const pathname = href.split(/[?#]/)[0];
      expect(routeSet.has(pathname), `${href} should have an admin page`).toBe(
        true,
      );
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
