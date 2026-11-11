// @vitest-environment jsdom

/**
 * The admin sidebar's active link, at a moved page's old URL and at its hub URL
 * (epic #4468, C3 #4800).
 *
 * While `ADMIN_HUBS_LIVE` is off, a moved page is served at its OLD URL by a
 * `beforeFiles` rewrite, and `usePathname()` can answer either path: the server
 * render reads the request Next rendered (the rewrite's destination, the hub
 * path), the browser starts from `location` (the old path). Once the switch is
 * on, the browser is at the hub path while the sidebar's hand-written hrefs are
 * still old paths until C13. So the highlight must come out the same whichever
 * path either side is written in, or it is wrong after a move and the server
 * and client renders disagree.
 *
 * This file renders the REAL sidebar over the real registry, whose Finance hub
 * has moved (C5 #4802; until then the hub fragment was replaced here), as has
 * Fees & booking rules (C6 #4803), so the
 * wiring from `usePathname()` through `activeAdminHref` to the link's class is
 * what is measured. The registry function's own cases are in
 * `src/lib/__tests__/admin-hubs-active-link.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const state = vi.hoisted(() => ({ pathname: "/admin/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));

import { AdminSidebar } from "@/components/admin-sidebar";
import { ADMIN_PAGES } from "@/lib/admin-hubs";

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

const fullMatrix: AdminPermissionMatrix = {
  overview: "edit",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "edit",
  support: "edit",
};

function stubPendingCounts() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
}

/** The labels of every link the sidebar renders as active. */
async function activeLabels(pathname: string): Promise<string[]> {
  state.pathname = pathname;
  const view = render(
    <ClubTimeProvider zone="Pacific/Auckland" locale={CLUB_FORMAT_TEST.locale}>
      <AdminSidebar features={allOn} permissionMatrix={fullMatrix} isFullAdmin />
    </ClubTimeProvider>,
  );
  await waitFor(() => expect(screen.getAllByRole("link").length).toBeGreaterThan(10));
  const labels = [...view.container.querySelectorAll("a.app-nav-link-active")].map(
    (link) => link.textContent?.trim() ?? "",
  );
  view.unmount();
  return labels.sort();
}

describe("the sidebar's active link over a moved hub", () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubPendingCounts();
  });

  it("PREMISE: the Finance, Website, Rules, Help & system, Messages & email and Bookings hubs have moved, and nothing else has", () => {
    const moved = ADMIN_PAGES.filter((page) => page.moved);
    expect(moved.length).toBeGreaterThan(0);
    expect(new Set(moved.map((page) => page.hub))).toEqual(
      new Set(["finance", "website", "rules", "system", "messages", "bookings"]),
    );
    expect(moved.find((page) => page.id === "payments")?.hubPath).toBe(
      "/admin/finance/payments",
    );
    // Every Finance page, so the nested Xero cases below are both moved.
    expect(
      ADMIN_PAGES.filter((page) => page.hub === "finance" && !page.moved).map((page) => page.id),
    ).toEqual([]);
  });

  it.each([
    ["the old URL", "/admin/payments", ["Payments"]],
    ["the hub URL", "/admin/finance/payments", ["Payments"]],
    ["a path beneath the old URL", "/admin/payments/123", ["Payments"]],
    ["a path beneath the hub URL", "/admin/finance/payments/123", ["Payments"]],
    // The deepest match wins, at either path: Member Grouping, not Xero Sync too.
    ["a nested page's old URL", "/admin/xero/member-grouping", ["Xero Member Grouping"]],
    ["a nested page's hub URL", "/admin/finance/xero/member-grouping", ["Xero Member Grouping"]],
    ["a parent page's hub URL", "/admin/finance/xero", ["Xero Sync"]],
    // C6 (#4803): the fee console, and a policy page with no menu entry of its own.
    ["the fee console's hub URL", "/admin/rules/fees", ["Fees"]],
    ["a policy page's old URL", "/admin/booking-policies/cancellation", ["Booking Policies"]],
    // C7 (#4804): System Health, and Backup Setup, which has no menu entry of its own.
    ["System Health's hub URL", "/admin/system/health", ["System Health"]],
    ["Backup Setup's hub URL", "/admin/system/backups/setup", ["Database Backups"]],
    // C8 (#4805): Member notices, and a notice's own page beneath it, which has
    // no menu entry of its own; and Delivery Rules, reached from Notifications &
    // Email's card, which is not beneath it.
    ["Member notices' hub URL", "/admin/messages/notices", ["Member notices"]],
    ["a notice's hub URL", "/admin/messages/notices/n-1", ["Member notices"]],
    ["a notice's old URL", "/admin/notices/n-1", ["Member notices"]],
    ["Notifications & Email's hub URL", "/admin/messages/notifications", ["Notifications & Email"]],
    ["Delivery Rules' hub URL", "/admin/messages/notification-rules", []],
    ["a policy page's hub URL", "/admin/rules/booking-policies/cancellation", ["Booking Policies"]],
    // C10 (#4807): Bookings, at the hub URL and the address the menu still uses.
    ["Bookings' old URL", "/admin/bookings", ["Bookings"]],
    ["Bookings' hub URL", "/admin/booking-desk/bookings", ["Bookings"]],
    ["Booking Requests' old URL", "/admin/booking-requests", ["Booking Requests"]],
    ["Booking Requests' hub URL", "/admin/booking-desk/booking-requests", ["Booking Requests"]],
    ["Book on Behalf's hub URL", "/admin/booking-desk/book", ["Book on Behalf"]],
    ["Bed Allocation's hub URL", "/admin/booking-desk/bed-allocation", ["Bed Allocation"]],
    ["the Waitlist's old URL", "/admin/waitlist", ["Waitlist"]],
    ["the Waitlist's hub URL", "/admin/booking-desk/waitlist", ["Waitlist"]],
  ])("highlights the same link at %s (%s)", async (_label, pathname, expected) => {
    await expect(activeLabels(pathname)).resolves.toEqual([...expected].sort());
  });

  it("leaves an unmoved page's highlight as it was", async () => {
    await expect(activeLabels("/admin/members")).resolves.toEqual(["Members"]);
    // Members has not moved, so its hub path is served by nothing and lights nothing.
    await expect(activeLabels("/admin/membership/members")).resolves.toEqual([]);
  });

  it("highlights nothing at the hub's own root, which is no page yet (C13)", async () => {
    await expect(activeLabels("/admin/finance")).resolves.toEqual([]);
    await expect(activeLabels("/admin/booking-desk")).resolves.toEqual([]);
  });
});
