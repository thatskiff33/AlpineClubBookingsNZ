// @vitest-environment jsdom

/**
 * The admin sidebar's dated queue link, the command palette's copy of it, and
 * the ONE club day they both come from (#3123; `INV-CONFIG-002`).
 *
 * ## What was wrong, in two independent ways
 *
 * `admin-sidebar.tsx` held the unpaid-finished-stays deep link as a
 * module-level constant, built from the container's environment timezone rather
 * than the club's persisted one. That was wrong twice over.
 *
 * 1. **Wrong authority.** The `checkOutTo` cutoff came from the process's zone,
 *    so a club behind Greenwich got a link one day off the count rendered beside
 *    it — and the *palette* navigated to the same wrong queue, because it reads
 *    the same nav table.
 * 2. **Wrong lifetime, in every zone.** A module body is evaluated ONCE per
 *    bundle load. An administrator who left the tab open overnight kept
 *    yesterday's cutoff beside a badge count fetched today. That half is a defect
 *    with no timezone in it at all, and fixing only the authority would have left
 *    it standing.
 *
 * ## Why the zone here is `America/Denver`
 *
 * The house test zone is `Pacific/Auckland`, which is also what `APP_TIME_ZONE`
 * resolves to under test — so a component reading either one gives the identical
 * answer and the assertion cannot tell them apart. Denver is behind Greenwich,
 * where these defects show: at the frozen instant (`2026-07-01T00:00:00.000Z`,
 * noon on 1 July in Auckland) a Denver club is still on **30 June**. Every
 * assertion below turns on that one-day difference.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { AdminPendingCounts } from "@/lib/admin-pending-counts";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/dashboard",
  useRouter: () => ({ push: pushMock }),
}));

import {
  AdminSidebar,
  ADMIN_NAV_SECTION_ORDER,
  getVisibleAdminNavSections,
} from "@/components/admin-sidebar";
import { AdminCommandPalette } from "@/components/admin-command-palette";
import { requireCalendarDate } from "@/lib/club-time";

/** Behind Greenwich, and NOT what `APP_TIME_ZONE` resolves to under test. */
const CLUB_BEHIND = "America/Denver";
/** Ahead of Greenwich, and the zone the container happens to hold. */
const CLUB_AHEAD = "Pacific/Auckland";

/** The two answers the frozen instant produces in those two zones. */
const DAY_BEHIND = "2026-06-30";
const DAY_AHEAD = "2026-07-01";

const HREF_BEHIND =
  "/admin/bookings?status=PAYMENT_PENDING&checkOutTo=" + DAY_BEHIND;
const HREF_AHEAD =
  "/admin/bookings?status=PAYMENT_PENDING&checkOutTo=" + DAY_AHEAD;

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

const ZERO_COUNTS: AdminPendingCounts = {
  familyRequests: 0,
  memberApplications: 0,
  refundAppeals: 0,
  manualRefundTasks: 0,
  creditApprovals: 0,
  bookingReviews: 0,
  bookingChangeRequests: 0,
  newBookingPolicyExceptionRequests: 0,
  publicBookingRequests: 0,
  unpaidFinishedStays: 0,
  unsettledAdditionalFinishedStays: 0,
  unsettledAdditionalUpcomingStays: 0,
  membershipCancellations: 0,
  archiveRequests: 0,
  deletionRequests: 0,
  memberDeleteRequests: 0,
  issueReports: 0,
  unassignedHutLeaderDates: 0,
};

function stubPendingCounts(counts: Partial<AdminPendingCounts> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...ZERO_COUNTS, ...counts }),
    })),
  );
}

function renderSidebar(zone: string) {
  return render(
    <ClubTimeProvider zone={zone}>
      <AdminSidebar
        features={allOn}
        permissionMatrix={fullMatrix}
        isFullAdmin
      />
    </ClubTimeProvider>,
  );
}

async function unpaidFinishedStaysLink() {
  await waitFor(() =>
    expect(screen.getByText("Needs Attention")).not.toBeNull(),
  );
  return screen.getAllByRole("link", { name: /Unpaid Finished Stays/ })[0];
}

describe("the dated queue link answers from the club's zone, not the container's", () => {
  beforeEach(() => {
    window.localStorage.clear();
    pushMock.mockReset();
    stubPendingCounts({ unpaidFinishedStays: 3 });
  });

  it("PREMISE: the two zones really do disagree about the day at this instant", () => {
    // Without this the whole file could be asserting one value twice.
    expect(DAY_BEHIND).not.toBe(DAY_AHEAD);
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: CLUB_BEHIND }).format(
        frozenTestNow(),
      ),
    ).toBe(DAY_BEHIND);
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: CLUB_AHEAD }).format(
        frozenTestNow(),
      ),
    ).toBe(DAY_AHEAD);
  });

  it("cuts the queue off at the CLUB's day for a club behind Greenwich", async () => {
    renderSidebar(CLUB_BEHIND);

    const link = await unpaidFinishedStaysLink();
    // The old code produced HREF_AHEAD here — the container's day — because the
    // helper it used defaulted its zone to the environment.
    expect(link.getAttribute("href")).toBe(HREF_BEHIND);
  });

  it("is recomputed per render, so the same module answers two clubs differently", async () => {
    // THE STALENESS PROOF WITH NO CLOCK IN IT. A module-level constant is
    // evaluated once per bundle load and CANNOT produce two answers inside one
    // module instance, whatever it is handed. This one does.
    const behind = renderSidebar(CLUB_BEHIND);
    expect((await unpaidFinishedStaysLink()).getAttribute("href")).toBe(
      HREF_BEHIND,
    );
    behind.unmount();

    renderSidebar(CLUB_AHEAD);
    expect((await unpaidFinishedStaysLink()).getAttribute("href")).toBe(
      HREF_AHEAD,
    );
  });

  it("follows the club past midnight without a reload", async () => {
    /*
      The half of this defect that had no timezone in it. The tab is not
      reloaded; only the clock moves. Pinned inside this test and handed straight
      back, so the root re-freeze is never relied on to undo it
      (`docs/TESTING.md`).
    */
    try {
      // 23:30 in Denver on 30 June — still the day before.
      vi.setSystemTime(new Date("2026-07-01T05:30:00.000Z"));
      const before = renderSidebar(CLUB_BEHIND);
      expect((await unpaidFinishedStaysLink()).getAttribute("href")).toBe(
        HREF_BEHIND,
      );
      before.unmount();

      // 00:30 in Denver on 1 July — one hour later, next day.
      vi.setSystemTime(new Date("2026-07-01T06:30:00.000Z"));
      renderSidebar(CLUB_BEHIND);
      expect((await unpaidFinishedStaysLink()).getAttribute("href")).toBe(
        HREF_AHEAD,
      );
    } finally {
      vi.setSystemTime(frozenTestNow());
    }
  });

  it("keys the badge count by the SAME href it renders the link with", async () => {
    // The drift the old docblock promised to prevent and could not: the link's
    // cutoff was frozen at bundle load while the count is fetched at mount, so
    // the two could describe different days. Both now come from one value in one
    // render, and the badge only appears when the map is keyed by exactly the
    // href the link carries.
    renderSidebar(CLUB_BEHIND);

    const link = await unpaidFinishedStaysLink();
    expect(link.getAttribute("href")).toBe(HREF_BEHIND);
    expect(link.textContent).toContain("3");
  });
});

describe("the sidebar and the command palette come from ONE definition", () => {
  beforeEach(() => {
    window.localStorage.clear();
    pushMock.mockReset();
    stubPendingCounts({ unpaidFinishedStays: 3 });
    // cmdk needs both of these; jsdom ships neither.
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it("navigates the palette to the very href the sidebar link carries", async () => {
    /*
      THE REGRESSION THIS FILE EXISTS FOR. `getAdminFeatureSearchIndex` derives
      the palette's entries from `buildAdminNavSections`, the same builder the
      sidebar renders — so a partial migration that dated one surface and not the
      other would show a link and a search result pointing at two different
      queues. Both are rendered here under ONE provider and compared to EACH
      OTHER rather than to a literal, so this fails on any divergence and not
      only on the day this file happens to expect.
    */
    render(
      <ClubTimeProvider zone={CLUB_BEHIND}>
        <AdminSidebar
          features={allOn}
          permissionMatrix={fullMatrix}
          isFullAdmin
        />
        <AdminCommandPalette
          features={allOn}
          permissionMatrix={fullMatrix}
          isFullAdmin
        />
      </ClubTimeProvider>,
    );

    const sidebarHref = (await unpaidFinishedStaysLink()).getAttribute("href");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByPlaceholderText("Search admin features…");
    fireEvent.change(input, { target: { value: "Unpaid Finished Stays" } });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Unpaid Finished Stays/ })).not.toBeNull(),
    );
    fireEvent.keyDown(input, { key: "Enter" });

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0]).toBe(sidebarHref);
    // And it is the club's day, not the container's — otherwise the two could
    // agree by both being wrong.
    expect(sidebarHref).toBe(HREF_BEHIND);
  });
});

describe("the nav section order is day-independent, as its probe day claims", () => {
  it("is the same list whichever day the builder is given", () => {
    /*
      `ADMIN_NAV_SECTION_ORDER` is built by calling `buildAdminNavSections` with
      a fixed probe day, on the stated ground that the club's day changes one
      href and never a LABEL. That is a claim about the nav table, and a future
      section keyed off a date would silently falsify it. Re-derive the order
      from real builder calls under two different days and compare.
    */
    const labelsOn = (day: string) =>
      getVisibleAdminNavSections(requireCalendarDate(day), allOn).map(
        (section) => section.label,
      );

    expect(labelsOn(DAY_BEHIND)).toEqual(labelsOn(DAY_AHEAD));
    expect(ADMIN_NAV_SECTION_ORDER).toEqual([...new Set(labelsOn(DAY_AHEAD))]);
    expect(ADMIN_NAV_SECTION_ORDER.length).toBeGreaterThan(5);
  });
});

describe("the module holds no import-time day, and no environment-zone helper", () => {
  const SOURCE = readFileSync(
    path.join(__dirname, "..", "admin-sidebar.tsx"),
    "utf8",
  );

  it("imports neither retired helper", () => {
    // ESLint's environment-zone arm covers the import for migrated modules; this
    // states it for THIS module, where the removal is the fix.
    expect(SOURCE).not.toContain("getTodayDateOnly");
    expect(SOURCE).not.toContain("@/lib/date-only");
  });

  it("builds the dated href inside a function, never at module scope", () => {
    /*
      A source assertion because no render can see the difference: a module-level
      constant recomputed once per bundle load looks identical to a correct value
      inside any single render. What it must not be is a top-level
      `const … = buildUnpaidFinishedStaysHref(…)`, which is what it was.
    */
    expect(SOURCE).not.toMatch(
      /^const\s+\w+\s*=\s*buildUnpaidFinishedStaysHref\(/m,
    );
    // And the one place that builds it takes the day as a parameter.
    expect(SOURCE).toContain(
      "const buildAdminNavSections = (clubToday: CalendarDate): NavSection[] =>",
    );
  });
});
