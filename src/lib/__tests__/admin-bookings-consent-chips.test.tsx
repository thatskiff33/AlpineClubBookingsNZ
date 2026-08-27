// "+ Add Member Guest" (epic #2305) MG2 (#2307) — the two consent chips on
// Admin › Bookings (owner decision MG2-M-3 as ticked).
//
// A chip is a small thing that is easy to get quietly wrong in three ways at
// once: a number that does not match what the click reveals, an active state
// only a sighted user can perceive, and a list whose React keys collide. All
// three are asserted here, on the real page's rendered output.
import { readFileSync } from "fs";
import path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // The club-time delegate. `loadPersistedClubTimeSettings` returns `null`
    // when it is ABSENT, and the page then falls back to the environment — the
    // very defect CT-4 removes, silently, with nothing able to tell. Every test
    // here leaves it resolving `null`, which reproduces the no-row fallback and
    // keeps their expectations unchanged; the zone-authority test supplies a row.
    clubTimeSettings: { findUnique: vi.fn() },
    booking: { findMany: vi.fn(), count: vi.fn() },
    bookingGuest: { count: vi.fn(), findMany: vi.fn() },
    hostingCoverageIncident: { count: vi.fn(), findMany: vi.fn() },
    xeroSyncOperation: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
    lodge: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/components/admin/booking-filters", () => ({
  BookingFilters: () => null,
}));

vi.mock("@/components/admin-booking-calendar", () => ({
  AdminBookingCalendar: () => null,
}));

vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-settings")>();
  return { ...actual, loadEffectiveModuleFlags: vi.fn() };
});

// The list itself is not under test here; the chips are. Everything else in
// the service (the query schema, and the where-builder the waiting count is
// taken through) stays real, because the point of the count assertion is that
// the chip and the list agree on ONE filter.
vi.mock("@/lib/admin-bookings-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/admin-bookings-service")>();
  return { ...actual, listAdminBookings: vi.fn() };
});

vi.mock("@/lib/member-guest-consent-exceptions", () => ({
  loadMemberGuestConsentQueueCounts: vi.fn(),
  listMemberGuestConsentExceptions: vi.fn(),
}));

import AdminBookingsPage from "@/app/(admin)/admin/bookings/page";
import {
  adminBookingsQuerySchema,
  buildAdminBookingsWhere,
  listAdminBookings,
  type AdminBookingsClubDay,
} from "@/lib/admin-bookings-service";
import {
  dateOnlyInstantOf,
  requireCalendarDate,
  requireClubTimeZone,
} from "@/lib/club-time";

/**
 * The club's day and zone these cases mean, stated rather than read (#3123).
 * `listAdminBookings` and its `where` builders take them as data instead of
 * projecting through `APP_TIME_ZONE`; that the value comes from the PERSISTED
 * club timezone is pinned in `admin-bookings-club-time-authority.test.ts`.
 */
const TEST_CLUB_DAY: AdminBookingsClubDay = {
  zone: requireClubTimeZone("Pacific/Auckland"),
  today: dateOnlyInstantOf(requireCalendarDate("2026-07-01")),
};
import { auth } from "@/lib/auth";
import {
  listMemberGuestConsentExceptions,
  loadMemberGuestConsentQueueCounts,
} from "@/lib/member-guest-consent-exceptions";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";

const MODULES_ON = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
  bedAllocation: true,
  internetBankingPayments: true,
  addressAutocomplete: false,
  groupBookings: false,
  lockers: false,
  induction: false,
  workParties: false,
  promoCodes: false,
  hutLeaders: false,
  communications: false,
  skifieldConditions: false,
  twoFactor: false,
  magicLink: false,
  googleLogin: false,
  analytics: false,
  lobbyDisplay: false,
  aiAssistant: false,
  memberNotices: true,
  eventsCalendar: true,
  memberGuests: true,
  aiDiagnostics: false,
  maintenanceReports: true,
  alpineCentralServer: false,
  commsPortal: false,
};

function exceptionRow(overrides: Record<string, unknown> = {}) {
  return {
    bookingId: "bk-1",
    guestId: "bg-1",
    lodgeName: "Silverpeak",
    checkIn: new Date("2026-08-08T00:00:00.000Z"),
    checkOut: new Date("2026-08-10T00:00:00.000Z"),
    bookerName: "Dave Ngata",
    guestFirstName: "Sam",
    guestLastName: "Kaur",
    status: "DECLINED" as const,
    statusAt: new Date("2026-08-03T00:00:00.000Z"),
    reason: "LAST_GUEST" as const,
    why: "Sam is the only guest on this booking, so taking them off would leave it empty.",
    fix: "Cancel the booking, or add another guest first.",
    ...overrides,
  };
}

async function renderPage(searchParams: Record<string, string> = {}) {
  const element = await AdminBookingsPage({
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element);
}

describe("the Admin › Bookings consent chips (#2307, MG2-M-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue(null);
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue(MODULES_ON);
    vi.mocked(prisma.lodge.findMany).mockResolvedValue([
      { id: "lodge-1", name: "Silverpeak" },
    ] as never);
    vi.mocked(prisma.hostingCoverageIncident.count).mockResolvedValue(0);
    vi.mocked(prisma.hostingCoverageIncident.findMany).mockResolvedValue([]);
    vi.mocked(listAdminBookings).mockResolvedValue({
      bookings: [],
      total: 0,
      page: 1,
      totalPages: 1,
      pageSize: 25,
      sortBy: "lastUpdated",
      sortDir: "desc",
    } as never);
    vi.mocked(loadMemberGuestConsentQueueCounts).mockResolvedValue({
      waitingBookings: 4,
      attentionGuests: 2,
    });
    vi.mocked(listMemberGuestConsentExceptions).mockResolvedValue([]);
    vi.mocked(auth).mockResolvedValue({
      user: { id: "admin-1", accessRoles: [{ role: "ADMIN" }] },
    } as never);
  });

  it("counts the waiting chip inside the filters already applied, minus the chips themselves", async () => {
    // A lodge and a status filter are already narrowing the list. Clicking the
    // chip does not clear them — it stacks — so a count taken over every
    // booking in the club would promise rows the click then hides.
    await renderPage({
      lodgeId: "lodge-1",
      status: "PAID",
      consentState: "attention",
    });

    const [, options] = vi.mocked(loadMemberGuestConsentQueueCounts).mock
      .calls[0];
    expect(options?.waitingScope).toEqual(
      buildAdminBookingsWhere({
        ...adminBookingsQuerySchema.parse({ lodgeId: "lodge-1", status: "PAID" }),
        consentState: "all",
      }, TEST_CLUB_DAY),
    );
    // The scope carries the operator's filters...
    expect(JSON.stringify(options?.waitingScope)).toContain("lodge-1");
    // ...and NOT the consent narrowing itself: counting bookings that are both
    // waiting AND stuck would be a third, meaningless number.
    expect(JSON.stringify(options?.waitingScope)).not.toContain("PENDING");
    expect(JSON.stringify(options?.waitingScope)).not.toContain("DECLINED");
  });

  it("exposes the chip group to assistive technology with a role, not a bare label", async () => {
    // An aria-label on a role-less <div> is dropped entirely — the div has no
    // role for the name to attach to. Same fix as the "Rows per page" group in
    // admin-pagination.tsx.
    const html = await renderPage();
    expect(html).toContain('role="group" aria-label="Consent queues"');
  });

  it("says which chip is active in its accessible name, not only in its colour", async () => {
    const html = await renderPage({ consentState: "waiting" });
    expect(html).toContain('aria-label="Waiting for consent · 4, current"');
    expect(html).toContain('aria-current="true"');
    // The chip that is NOT active keeps its plain visible text as its name.
    expect(html).not.toContain("Consent needs attention · 2, current");
  });

  it("gives the other chip the current marker when it is the active one", async () => {
    const html = await renderPage({ consentState: "attention" });
    expect(html).toContain('aria-label="Consent needs attention · 2, current"');
    expect(html).not.toContain("Waiting for consent · 4, current");
  });

  it("leaves both chips unmarked when neither queue is open", async () => {
    const html = await renderPage();
    expect(html).not.toContain(", current");
    expect(html).not.toContain('aria-current="true"');
  });

  it("renders every stuck row even when two guests share a name", async () => {
    // Two brothers called Sam Kaur on one booking is unusual but entirely
    // legal. React's server renderer does not police duplicate keys, so this
    // asserts what it CAN see — both rows survive — and the assertion below
    // pins the key expression itself.
    vi.mocked(listMemberGuestConsentExceptions).mockResolvedValue([
      exceptionRow({ guestId: "bg-1" }),
      exceptionRow({ guestId: "bg-2" }),
    ]);

    const html = await renderPage({ consentState: "attention" });

    expect(html).toContain("2 stuck consent rows");
    expect(html.split("Sam Kaur").length - 1).toBe(2);
  });

  it("keys those rows by the guest row's own id", () => {
    // A React key is invisible in rendered output, so the contract is asserted
    // over the source: keying on the guest's NAME makes two same-named guests
    // on one booking collide, and React then reuses the wrong row.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/app/(admin)/admin/bookings/page.tsx"),
      "utf8",
    );
    expect(source).toContain("<TableRow key={row.guestId}>");
  });
});
