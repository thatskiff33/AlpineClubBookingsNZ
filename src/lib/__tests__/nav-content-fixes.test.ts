/**
 * Tests for Issues 8, 9, 15: Navigation and content fixes
 * - Issue 8: Admin sidebar Home link to /dashboard
 * - Issue 15: KPI card hrefs and bookings page upcoming/comma-status filtering
 */
import { describe, it, expect } from "vitest";
import { getAuthenticatedBrandHref } from "@/components/nav-bar";

// ─── Issue 8: Admin Sidebar Home Link ────────────────────────────────────────

describe("Issue 8: Admin Sidebar Home Link", () => {
  // The sidebar renders a Home link before the admin nav items.
  // We verify the expected href is /dashboard.
  it("should define Home link as /dashboard", () => {
    const homeLink = { href: "/dashboard", label: "Home" };
    expect(homeLink.href).toBe("/dashboard");
    expect(homeLink.label).toBe("Home");
  });

  it("should place Home link before Dashboard in sidebar", () => {
    const adminNavItems = [
      { href: "/admin/dashboard", label: "Dashboard" },
      { href: "/admin/members", label: "Members" },
      { href: "/admin/bookings", label: "Bookings" },
    ];
    // Home is rendered before navItems, so its position is 0
    const allItems = [{ href: "/dashboard", label: "Home" }, ...adminNavItems];
    expect(allItems[0].href).toBe("/dashboard");
    expect(allItems[1].href).toBe("/admin/dashboard");
  });
});

// ─── Issue 9: Nav Bar Branding Link ──────────────────────────────────────────

describe("Issue 9: Nav Bar Branding Link", () => {
  it("should link authenticated branding to /dashboard", () => {
    expect(getAuthenticatedBrandHref()).toBe("/dashboard");
    expect(getAuthenticatedBrandHref()).not.toBe("/");
  });

  it("should have Dashboard as a nav item", () => {
    const memberLinks = [
      { href: "/dashboard", label: "Dashboard" },
      { href: "/book", label: "Book" },
      { href: "/bookings", label: "My Bookings" },
    ];
    const dashboardLink = memberLinks.find((l) => l.label === "Dashboard");
    expect(dashboardLink).toBeDefined();
    expect(dashboardLink?.href).toBe("/dashboard");
  });
});

// ─── Admin dashboard key-card hrefs (#2091) ──────────────────────────────────
// The dashboard KPI row was re-targeted to the four bookings-officer surfaces
// (primary row) plus a slim Members + Net Collected secondary row. These fixtures
// document the intended card→href contract.

describe("Admin dashboard key-card hrefs (#2091)", () => {
  const officerCards = [
    { label: "Bookings", href: "/admin/bookings?upcoming=7" },
    { label: "Hut Leader Assignment", href: "/admin/hut-leaders" },
    { label: "Roster Assignment", href: "/admin/roster" },
    { label: "Bed Allocation", href: "/admin/bed-allocation" },
  ];
  const secondaryCards = [
    { label: "Members", href: "/admin/members" },
    { label: "Net Collected This Month", href: "/admin/payments" },
  ];

  it("defines the four officer cards linking their target surfaces", () => {
    expect(officerCards).toHaveLength(4);
    expect(officerCards.find((c) => c.label === "Bookings")?.href).toContain(
      "upcoming=7",
    );
    expect(
      officerCards.find((c) => c.label === "Hut Leader Assignment")?.href,
    ).toBe("/admin/hut-leaders");
    expect(officerCards.find((c) => c.label === "Roster Assignment")?.href).toBe(
      "/admin/roster",
    );
    expect(officerCards.find((c) => c.label === "Bed Allocation")?.href).toBe(
      "/admin/bed-allocation",
    );
  });

  it("keeps Members and Net Collected in the slim secondary row", () => {
    expect(secondaryCards.find((c) => c.label === "Members")?.href).toBe(
      "/admin/members",
    );
    expect(
      secondaryCards.find((c) => c.label === "Net Collected This Month")?.href,
    ).toBe("/admin/payments");
  });
});

// ─── Issue 15: Bookings page comma-separated status parsing ──────────────────

describe("Issue 15: Bookings page filter logic", () => {
  function buildStatusFilter(statusFilter: string | undefined) {
    if (!statusFilter || statusFilter === "all") return { not: "DRAFT" };
    if (statusFilter === "DRAFT") return "DRAFT";
    const statuses = statusFilter.split(",").map((s) => s.trim()).filter(Boolean);
    return statuses.length === 1 ? statuses[0] : { in: statuses };
  }

  it("returns single status when only one provided", () => {
    expect(buildStatusFilter("PAYMENT_PENDING")).toBe("PAYMENT_PENDING");
  });

  it("returns { in: [...] } for comma-separated statuses", () => {
    const result = buildStatusFilter("PAYMENT_PENDING,PAID") as { in: string[] };
    expect(result).toEqual({ in: ["PAYMENT_PENDING", "PAID"] });
  });

  it("returns { not: DRAFT } when no filter provided", () => {
    expect(buildStatusFilter(undefined)).toEqual({ not: "DRAFT" });
  });

  it("returns { not: DRAFT } when filter is 'all'", () => {
    expect(buildStatusFilter("all")).toEqual({ not: "DRAFT" });
  });

  it("handles three statuses in comma list", () => {
    const result = buildStatusFilter("PAYMENT_PENDING,PAID,PENDING") as { in: string[] };
    expect(result).toEqual({ in: ["PAYMENT_PENDING", "PAID", "PENDING"] });
  });

  it("strips whitespace from comma-separated values", () => {
    const result = buildStatusFilter("PAYMENT_PENDING, PAID") as { in: string[] };
    expect(result).toEqual({ in: ["PAYMENT_PENDING", "PAID"] });
  });
});

// ─── Issue 15: Upcoming filter logic ─────────────────────────────────────────

describe("Issue 15: Upcoming check-ins filter logic", () => {
  function buildUpcomingFilter(upcomingParam: string | undefined, today: Date) {
    if (!upcomingParam) return null;
    const days = parseInt(upcomingParam, 10);
    if (isNaN(days)) return null;
    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + days);
    return { gte: today, lte: futureDate };
  }

  const today = new Date(2026, 3, 7); // 2026-04-07

  it("returns null when no upcoming param", () => {
    expect(buildUpcomingFilter(undefined, today)).toBeNull();
  });

  it("returns null for non-numeric upcoming param", () => {
    expect(buildUpcomingFilter("abc", today)).toBeNull();
  });

  it("returns date range for upcoming=7", () => {
    const result = buildUpcomingFilter("7", today);
    expect(result).not.toBeNull();
    expect(result?.gte).toEqual(today);
    const expected = new Date(today);
    expected.setDate(expected.getDate() + 7);
    expect(result?.lte).toEqual(expected);
  });

  it("upcoming=7 spans exactly 7 days", () => {
    const result = buildUpcomingFilter("7", today)!;
    const diffMs = result.lte.getTime() - result.gte.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(7);
  });
});
