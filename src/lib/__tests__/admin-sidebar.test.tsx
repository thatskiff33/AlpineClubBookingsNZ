// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
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
import { requireCalendarDate } from "@/lib/club-time";

/**
 * #3123 — the club's day, first and REQUIRED on the nav exports. The rendered
 * component reads its own from `ClubTimeProvider` (mounted by the `render` above,
 * at `CLUB_TIME_TEST_ZONE`); this constant is for the direct calls to the pure
 * seams, none of which assert on the one dated href.
 */
const CLUB_DAY = requireCalendarDate("2026-07-01");

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

  it("groups setup and configuration around the setup hubs", () => {
    const section = getVisibleAdminNavSections(CLUB_DAY, allOn, undefined, true).find(
      (item) => item.label === "Setup & Configuration",
    );

    expect(section?.items.map((item) => item.label)).toEqual([
      "Setup",
      "Modules",
      // Login & Security page (#2033): sits with the other system-config
      // surfaces in Setup & Configuration.
      "Login & Security",
      "Lodges",
      "Membership & Members",
      "Site Appearance & Content",
      "Bookings Setup",
      "Integrations",
      "Notifications & Email",
      "Access Roles",
      "Export & Import",
      // Club Time Zone (CT-1 #2989): the one persisted IANA club time zone.
      // Full-Admin only, like the two entries above it.
      "Club Time Zone",
      // Environment Safety (ENV-SAFETY 1 #3034): is this the club's live site
      // or a copy of it. Full-Admin only, like the three entries above it.
      "Environment Safety",
      "Committee",
    ]);
  });

  it("keeps Environment Safety out of the sidebar for an admin who is not a Full Admin", () => {
    /*
      Same argument as the Club Time Zone case below, and it matters more here: a
      support EDITOR satisfies the /admin/environment prefix requirement on the
      matrix, so `fullAdminOnly` is the only thing keeping the entry out — and
      /api/admin/environment-safety refuses them on both verbs anyway, so showing
      it would be an offer the app cannot honour.
    */
    const scoped = {
      overview: "view" as const,
      bookings: "none" as const,
      membership: "none" as const,
      finance: "none" as const,
      lodge: "none" as const,
      content: "none" as const,
      support: "edit" as const,
    };
    expect(
      getVisibleAdminNavSections(CLUB_DAY, allOn, scoped, false).flatMap((section) =>
        section.items.map((item) => item.href),
      ),
    ).not.toContain("/admin/environment");
    expect(
      getVisibleAdminNavSections(CLUB_DAY, allOn, scoped, true).flatMap((section) =>
        section.items.map((item) => item.href),
      ),
    ).toContain("/admin/environment");
  });

  it("keeps Club Time Zone out of the sidebar for an admin who is not a Full Admin", () => {
    // The `fullAdminOnly` flag, proved rather than assumed: a support EDITOR
    // satisfies the /admin/club-time prefix requirement on the matrix, so the
    // flag is the only thing keeping the entry out — and the route refuses them
    // anyway, so showing it would be an offer the app cannot honour.
    const asSupportEditor = getVisibleAdminNavSections(
      CLUB_DAY,
      allOn,
      {
        overview: "view",
        bookings: "none",
        membership: "none",
        finance: "none",
        lodge: "none",
        content: "none",
        support: "edit",
      },
      false,
    );
    const hrefs = asSupportEditor.flatMap((section) =>
      section.items.map((item) => item.href),
    );
    expect(hrefs).not.toContain("/admin/club-time");
    // …and the same matrix WITH Full Admin does see it.
    expect(
      getVisibleAdminNavSections(
      CLUB_DAY,
        allOn,
        {
          overview: "view",
          bookings: "none",
          membership: "none",
          finance: "none",
          lodge: "none",
          content: "none",
          support: "edit",
        },
        true,
      ).flatMap((section) => section.items.map((item) => item.href)),
    ).toContain("/admin/club-time");
  });

  it("owns Lobby Display once under Lodge Operations and keeps General intact", () => {
    const sections = getVisibleAdminNavSections(CLUB_DAY, allOn, undefined, true);
    const lodgeOperations = sections.find(
      (section) => section.label === "Lodge Operations",
    );
    const lobbyDisplayEntries = sections.flatMap((section) =>
      section.items.filter((item) => item.href === "/admin/display"),
    );
    const generalEntries = sections
      .filter((section) => section.label === undefined)
      .flatMap((section) => section.items.map((item) => item.label));

    expect(lodgeOperations?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: "/admin/display",
          label: "Lobby Display",
        }),
      ]),
    );
    expect(lobbyDisplayEntries).toHaveLength(1);
    expect(generalEntries).toEqual(["Admin Dashboard"]);
  });

  it("hides Lobby Display with Lodge Operations and restores its persisted state", () => {
    render(<AdminSidebar features={allOn} />);

    const sectionToggle = screen.getByRole("button", {
      name: "Lodge Operations",
    });
    expect(sectionToggle.tagName).toBe("BUTTON");
    expect(sectionToggle.getAttribute("type")).toBe("button");
    expect(sectionToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Lobby Display" })).not.toBeNull();

    fireEvent.click(sectionToggle);

    expect(sectionToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Lobby Display" })).toBeNull();
    expect(
      JSON.parse(
        window.localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) ?? "{}",
      ),
    ).toMatchObject({ "Lodge Operations": false });

    fireEvent.click(sectionToggle);

    expect(sectionToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Lobby Display" })).not.toBeNull();
    expect(
      JSON.parse(
        window.localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) ?? "{}",
      ),
    ).toMatchObject({ "Lodge Operations": true });
  });

  it("keeps Lobby Display hidden when its module is off", () => {
    const lobbyDisplayOff = { ...allOn, lobbyDisplay: false } as FeatureFlags;
    const sections = getVisibleAdminNavSections(
      CLUB_DAY,
      lobbyDisplayOff,
      undefined,
      true,
    );

    expect(
      sections
        .flatMap((section) => section.items)
        .some((item) => item.href === "/admin/display"),
    ).toBe(false);
    expect(
      sections.some((section) => section.label === "Lodge Operations"),
    ).toBe(true);
  });

  it("retires lodge-scoped Chores/Lockers/Seasons from the sidebar — reached via the lodge hub (#130)", () => {
    const sections = getVisibleAdminNavSections(CLUB_DAY, allOn);
    const allLabels = sections.flatMap((section) =>
      section.items.map((item) => item.label),
    );
    // Multi-lodge core (ADR-005): these are lodge-scoped editors, reached as
    // Configure cards under /admin/lodges/[id], not standalone sidebar entries.
    expect(allLabels).not.toContain("Chores");
    expect(allLabels).not.toContain("Lockers");
    expect(allLabels).not.toContain("Hut Fees & Seasons");
    // The single Lodges entry remains the way in.
    expect(allLabels).toContain("Lodges");
    // Unrelated retirement still holds.
    expect(allLabels).not.toContain("Booking Messages");
  });

  it("shows the consolidated Fees link on bookings OR finance view, hides it for neither (#1933, E7)", () => {
    const matrix = (over: Partial<Record<string, "none" | "view" | "edit">>) => ({
      overview: "none", bookings: "none", membership: "none", finance: "none",
      lodge: "none", content: "none", support: "none", ...over,
    }) as Parameters<typeof getVisibleAdminNavSections>[2];
    const feesVisible = (m: Parameters<typeof getVisibleAdminNavSections>[2]) =>
      getVisibleAdminNavSections(CLUB_DAY, allOn, m)
        .flatMap((section) => section.items.map((item) => item.href))
        .includes("/admin/fees");

    expect(feesVisible(matrix({ bookings: "view" }))).toBe(true);
    expect(feesVisible(matrix({ finance: "view" }))).toBe(true);
    expect(feesVisible(matrix({ bookings: "edit" }))).toBe(true);
    expect(feesVisible(matrix({ finance: "edit" }))).toBe(true);
    // Neither bookings nor finance → no Fees link, and the old fee-configuration
    // link is gone entirely.
    expect(feesVisible(matrix({ membership: "edit" }))).toBe(false);
    const membershipOnly = getVisibleAdminNavSections(CLUB_DAY, allOn, matrix({ membership: "edit" }))
      .flatMap((section) => section.items.map((item) => item.href));
    expect(membershipOnly).not.toContain("/admin/fee-configuration");
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

  it("surfaces unpaid finished stays in Needs Attention with the dashboard deep link", async () => {
    vi.stubGlobal("fetch", buildFetchMock({ unpaidFinishedStays: 5 }));

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    const link = screen.getByRole("link", { name: /Unpaid Finished Stays/ });
    // Same deep link as the dashboard attention card (#1709/#1731): the
    // bookings list pre-filtered by the shared unpaid-finished-stays helper.
    /*
      The frozen test instant is noon on 1 July in the provider's zone, so the
      cutoff is that day. Written as a literal rather than derived from a helper
      on purpose: the previous form computed it with the very environment-zone
      helper this link stopped using (#3123), so it agreed with both the old
      behaviour and the new one and could not tell them apart. What the club's
      zone — not the container's — decides this cutoff is asserted under a zone
      the environment does NOT hold, in
      `admin-sidebar-club-time.test.tsx`.
    */
    expect(link.getAttribute("href")).toBe(
      "/admin/bookings?status=PAYMENT_PENDING&checkOutTo=2026-07-01",
    );
    expect(screen.getByText("5")).not.toBeNull();
  });

  it("hides the unpaid finished stays link while nothing is owing", async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminSidebar features={allOn} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      screen.queryByRole("link", { name: /Unpaid Finished Stays/ }),
    ).toBeNull();
  });

  it("surfaces unsettled stay additions in Needs Attention with the dashboard deep link (#1723)", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchMock({
        unsettledAdditionalFinishedStays: 4,
        // #2350: the upcoming half is counted too, and the badge sums the pair.
        unsettledAdditionalUpcomingStays: 3,
      }),
    );

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    const link = screen.getByRole("link", { name: /Unpaid Stay Additions/ });
    // Same deep link as the "Bookings With Unpaid Additions" dashboard card:
    // the bookings list pre-filtered by the shared additionalOwed helper in
    // unpaid-finished-stays.ts, with no date bound so both halves are listed.
    expect(link.getAttribute("href")).toBe(
      "/admin/bookings?additionalOwed=owed",
    );
    expect(screen.getByText("7")).not.toBeNull();
  });

  // #2350: an upcoming stay with an uncollected addition is a queue item on its
  // own — before this the badge only ever counted stays that had already ended.
  it("counts an upcoming stay with an unpaid addition on its own", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchMock({ unsettledAdditionalUpcomingStays: 2 }),
    );

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Unpaid Stay Additions/ }),
    ).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull();
  });

  it("hides the unpaid stay additions link while nothing is owing", async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminSidebar features={allOn} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      screen.queryByRole("link", { name: /Unpaid Stay Additions/ }),
    ).toBeNull();
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

  it("merges self-service and admin-initiated deletion counts on the Deletion Requests badge (#1938)", async () => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      JSON.stringify({ "Monitoring & Support": false }),
    );
    // Self-service PENDING (3) + admin-initiated DELETE REQUESTED (2) = 5.
    vi.stubGlobal(
      "fetch",
      buildFetchMock({ deletionRequests: 3, memberDeleteRequests: 2 }),
    );

    render(<AdminSidebar features={allOn} />);

    await waitFor(() =>
      expect(screen.getByText("Needs Attention")).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: /Deletion Requests/ }),
    ).not.toBeNull();
    expect(screen.getByText("5")).not.toBeNull();
  });

  it("labels the membership cancellation queue as Cancellation Requests", () => {
    const section = getVisibleAdminNavSections(CLUB_DAY, allOn).find(
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
