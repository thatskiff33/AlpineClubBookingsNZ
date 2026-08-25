/**
 * The club-calendar day boundaries on the member dashboard (#2838).
 *
 * The dashboard decides three member-facing things from "today": whether the
 * viewer is offered the STAYING GUEST card, whether they are offered the ACTIVE
 * HUT LEADER card, and which of their stays count as UPCOMING. All three compare
 * `@db.Date` columns — `Booking.checkIn` / `Booking.checkOut` and the hut-leader
 * assignment dates — and the first two are documented as offering the lodge view
 * from the DAY BEFORE (`checkIn - 1 <= today <= checkOut`).
 *
 * ## These decide which LINKS appear, not who may do what
 *
 * Both cards link to `/lodge/kiosk`, and the gate there is `getKioskAccessTier`
 * (`src/lib/kiosk-access.ts:31-81`), which asks `getTodayDateOnly()` and already
 * implemented the same `[checkIn-1, checkOut]` (`:71-73`) and
 * `[startDate-1, endDate]` (`:46-47`). That is the independent confirmation that
 * the windows asserted below are the INTENDED rule. It also bounds the defect:
 * the day-before access worked and only the card was missing, and the surviving
 * day-after card pointed at a kiosk that answered `tier: "none"`. So a red
 * assertion here is a wrong LINK, never a wrong permission.
 *
 * ## Why the assertions below are about calendar DAYS
 *
 * A `@db.Date` column holds a CLUB calendar day encoded at UTC midnight
 * (INV-DATE-010 — the rule's own word, because the day is the club's and not New
 * Zealand's). `@prisma/adapter-pg` narrows whatever `Date` is bound against
 * such a column with `formatDate`, which reads `getUTCFullYear/Month/Date` and
 * throws the time away — so Postgres compares two calendar days, and a bound
 * instant of `(D-1)T12:00Z` arrives as the day `D-1`, not as a moment partway
 * through it. `dateFilterAdmits` below models exactly that narrowing, which is
 * what makes these tests answer the product question ("can this member see the
 * surface today?") rather than the shape question ("what Date object was
 * built?").
 *
 * That mechanism is the whole defect. `new Date()` + `setHours(0, 0, 0, 0)` is
 * NZ-LOCAL midnight, which under the `TZ=Pacific/Auckland` server pin
 * (`Dockerfile`, `docker-compose*.yml`) is the PREVIOUS UTC day — `(D-1)T12:00Z`
 * in NZST, `(D-1)T11:00Z` under NZ daylight saving — and therefore narrows to
 * D-1 either way, running every window here a full day behind.
 *
 * ## Why this instant
 *
 * `2026-07-01T13:30:00.000Z` is 01:30 on 2 July in New Zealand (NZST, UTC+12),
 * 13:30 on 1 July in UTC, and 23:30 on 1 July in Brisbane (UTC+10) — so the club
 * day is 2026-07-02 while the UTC day, and the day in any zone below about
 * UTC+11, is 2026-07-01. A comfortable mid-morning instant would agree across
 * all of those and pin nothing; this one goes red under a wrong zone, which is
 * the point. The `expectClubTimeZonePremise()` guard makes that failure say so
 * out loud instead of arriving as a bare date mismatch (docs/TESTING.md rule 6).
 *
 * ## How much of a wrong zone this instant actually catches
 *
 * Measured by resolving `APP_TIME_ZONE` to each zone below with the premise
 * guard stubbed out, against this file's own assertions:
 *
 * | club zone as configured       | tests here that go red |
 * | ----------------------------- | ---------------------- |
 * | `Pacific/Auckland` (the truth) | 0 of 13 |
 * | `Australia/Brisbane` (UTC+10)  | 10 of 13 |
 * | `UTC`                          | 10 of 13 |
 * | `Etc/GMT-13` (UTC+13)          | 2 of 13 — the two `DateTime` instants only |
 * | `Etc/GMT-12` (UTC+12)          | 0 of 13 — identical to NZST in July |
 *
 * The last two rows are the honest limits. A zone one hour AHEAD of NZST names
 * the same calendar DAY at this instant, so only the two instant assertions
 * move; and UTC+12 IS New Zealand in July, so nothing here can tell them apart.
 * Do not read "the tests are red under a wrong `TZ`" as evidence of anything:
 * `TZ` also moves `APP_TIME_ZONE` (`src/config/operational.ts`), so the premise
 * guard fires first and every zone reports the same environment failure whatever
 * the instant.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_HUT_LEADER_LABEL } from "@/config/club-identity";
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingFindMany: vi.fn(),
  calendarEventFindMany: vi.fn(),
  checkCapacity: vi.fn(),
  getAvailablePromoCodesForMember: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  hasAccessRole: vi.fn(),
  isHutLeader: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  lockerFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: mocks.bookingFindFirst,
      findMany: mocks.bookingFindMany,
    },
    locker: { findMany: mocks.lockerFindMany },
    member: { findUnique: mocks.memberFindUnique },
    calendarEvent: { findMany: mocks.calendarEventFindMany },
  },
}));

vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: mocks.getMemberCreditBalance,
}));
vi.mock("@/lib/promo", () => ({
  getAvailablePromoCodesForMember: mocks.getAvailablePromoCodesForMember,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));
// PARTIAL: only `hasAccessRole` is a stub. `canViewCalendarEvents` — the other
// half of the Events card's gate — reads `isOrganisationMember` and
// `resolveAccessRoleTokens` out of this same module, and a full replacement
// makes the page throw the moment `eventsCalendar` is on. Keeping them real also
// keeps that gate honest rather than assumed.
vi.mock("@/lib/access-roles", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasAccessRole: mocks.hasAccessRole,
}));
vi.mock("@/lib/hut-leader", () => ({ isHutLeader: mocks.isHutLeader }));
vi.mock("@/lib/capacity", () => ({ checkCapacity: mocks.checkCapacity }));

import DashboardPage from "../page";

/** The instant every test in this file runs at — see the file comment. */
const PINNED_INSTANT = "2026-07-01T13:30:00.000Z";
/** The club calendar day at that instant. */
const CLUB_TODAY = "2026-07-02";

type DateFilter = { gte?: Date; lte?: Date };

/**
 * The calendar day Postgres actually receives for a value bound against a
 * `@db.Date` column: its UTC date, time discarded. This mirrors `formatDate` in
 * `@prisma/adapter-pg` (`mapArg`, `case "DATE"`), which is the single step that
 * turns the encoding bug into an off-by-a-day access bug.
 */
function boundDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Answer a `@db.Date` filter the way Postgres would, given the stored day as a
 * `yyyy-MM-dd` string. Lexicographic order on that format is chronological
 * order, so plain string comparison is exact here.
 */
function dateFilterAdmits(storedDay: string, filter: DateFilter): boolean {
  if (filter.gte && storedDay < boundDay(filter.gte)) return false;
  if (filter.lte && storedDay > boundDay(filter.lte)) return false;
  return true;
}

function moduleFlags() {
  return {
    kiosk: false,
    chores: false,
    financeDashboard: false,
    waitlist: false,
    xeroIntegration: false,
    bedAllocation: false,
    internetBankingPayments: false,
    addressAutocomplete: false,
    groupBookings: false,
    lockers: false,
    induction: false,
    workParties: false,
    promoCodes: false,
    hutLeaders: true,
    communications: false,
    skifieldConditions: false,
    twoFactor: false,
    analytics: false,
    // ON, or the `CalendarEvent.startsAt` half of "the two encodings stay
    // separate" is never reached: `showEventsCard` gates the query as well as
    // the card, so with the flag missing `calendarEvent.findMany` is not called
    // at all and the assertion below would inspect a mock that never fired.
    eventsCalendar: true,
  };
}

/**
 * Serve the staying-guest read from one fixture stay, evaluating the route's
 * own `where` clause against it exactly as the database would.
 */
function withStay(stay: { checkIn: string; checkOut: string } | null) {
  mocks.bookingFindFirst.mockImplementation(async (args: unknown) => {
    const where = (args as { where: { checkIn: DateFilter; checkOut: DateFilter } })
      .where;
    if (!stay) return null;
    const admitted =
      dateFilterAdmits(stay.checkIn, where.checkIn) &&
      dateFilterAdmits(stay.checkOut, where.checkOut);
    return admitted ? { id: "stay-1" } : null;
  });
}

/**
 * Serve `isHutLeader(memberId, date)` from one fixture assignment. The real
 * helper counts rows with `startDate <= date AND endDate >= date`, both
 * `@db.Date`, so the same narrowing applies to the date the page hands it —
 * which is the value under test here.
 */
function withAssignment(assignment: { startDate: string; endDate: string } | null) {
  mocks.isHutLeader.mockImplementation(async (_memberId: string, date: Date) => {
    if (!assignment) return false;
    const day = boundDay(date);
    return assignment.startDate <= day && assignment.endDate >= day;
  });
}

async function renderDashboard() {
  return renderToStaticMarkup(await DashboardPage());
}

// Both lodge-access buttons link to /lodge/kiosk, so they are told apart by
// their label — which is what the member actually sees.
function showsStayingGuestSurface(html: string): boolean {
  return html.includes("View Lodge");
}

function showsHutLeaderSurface(html: string): boolean {
  return html.includes(CLUB_HUT_LEADER_LABEL);
}

describe("dashboard club-day boundaries (#2838)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(PINNED_INSTANT));
    expectClubTimeZonePremise();

    mocks.auth.mockResolvedValue({ user: { id: "member-1", name: "Mere Member" } });
    mocks.hasAccessRole.mockReturnValue(true);
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.getMemberCreditBalance.mockResolvedValue(0);
    mocks.getAvailablePromoCodesForMember.mockResolvedValue([]);
    mocks.lockerFindMany.mockResolvedValue([]);
    mocks.calendarEventFindMany.mockResolvedValue([]);
    mocks.memberFindUnique.mockResolvedValue({
      requiresInduction: false,
      inductions: [],
    });
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags());
    mocks.checkCapacity.mockResolvedValue({
      available: true,
      minAvailable: 0,
      nightDetails: [],
    });
    withStay(null);
    withAssignment(null);
  });

  describe("the club's calendar day, not the process clock", () => {
    it("asks the @db.Date columns about today and tomorrow as date-only days", async () => {
      await renderDashboard();

      const where = mocks.bookingFindFirst.mock.calls[0]?.[0] as {
        where: { checkIn: DateFilter; checkOut: DateFilter };
      };
      // Both ends are UTC midnight, so the adapter's narrowing is lossless and
      // the day Postgres compares against is the day intended.
      expect(where.where.checkOut.gte?.toISOString()).toBe(
        "2026-07-02T00:00:00.000Z",
      );
      expect(where.where.checkIn.lte?.toISOString()).toBe(
        "2026-07-03T00:00:00.000Z",
      );
      expect(boundDay(where.where.checkOut.gte as Date)).toBe(CLUB_TODAY);
      expect(boundDay(where.where.checkIn.lte as Date)).toBe("2026-07-03");
    });

    it("asks the hut-leader assignment about tomorrow first, then today", async () => {
      await renderDashboard();

      const days = mocks.isHutLeader.mock.calls.map(([, date]) =>
        boundDay(date as Date),
      );
      expect(days).toEqual(["2026-07-03", CLUB_TODAY]);
    });
  });

  describe("upcoming bookings", () => {
    /**
     * The `findMany` whose `where` carries a `checkIn` filter — the Upcoming
     * Bookings list. The dashboard makes four `booking.findMany` calls and this
     * is the only one that filters on a lodge night.
     */
    function upcomingCheckInFilter(): DateFilter {
      const call = mocks.bookingFindMany.mock.calls.find(
        ([args]) => (args as { where?: { checkIn?: unknown } }).where?.checkIn,
      );
      expect(
        call,
        "The Upcoming Bookings query no longer filters on `checkIn`, so this " +
          "block is asserting nothing.",
      ).toBeDefined();
      return (call![0] as { where: { checkIn: DateFilter } }).where.checkIn;
    }

    it("cuts the list at the club's today, not the previous day", async () => {
      await renderDashboard();

      const checkIn = upcomingCheckInFilter();
      expect(checkIn.gte?.toISOString()).toBe("2026-07-02T00:00:00.000Z");
      expect(boundDay(checkIn.gte as Date)).toBe(CLUB_TODAY);
    });

    it("drops a stay that began YESTERDAY and keeps one starting today", async () => {
      // The value assertion above pins the encoding; this pins the WINDOW, so a
      // later edit to `gte: tomorrow` (which the count assertion alone would
      // not notice) fails here. Answered through the same adapter narrowing the
      // rest of the file models, because that is what Postgres would do.
      await renderDashboard();

      const checkIn = upcomingCheckInFilter();
      expect(dateFilterAdmits("2026-07-01", checkIn)).toBe(false);
      expect(dateFilterAdmits(CLUB_TODAY, checkIn)).toBe(true);
      expect(dateFilterAdmits("2026-07-03", checkIn)).toBe(true);
    });
  });

  describe("staying guest", () => {
    it("admits the member the DAY BEFORE check-in, as the rule says", async () => {
      // Club today is 2 July; the stay starts on the 3rd.
      withStay({ checkIn: "2026-07-03", checkOut: "2026-07-05" });

      expect(showsStayingGuestSurface(await renderDashboard())).toBe(true);
    });

    it("still admits the member on the CHECK-OUT day itself", async () => {
      withStay({ checkIn: "2026-06-30", checkOut: CLUB_TODAY });

      expect(showsStayingGuestSurface(await renderDashboard())).toBe(true);
    });

    it("does NOT admit the member the day after check-out", async () => {
      withStay({ checkIn: "2026-06-29", checkOut: "2026-07-01" });

      expect(showsStayingGuestSurface(await renderDashboard())).toBe(false);
    });

    it("does NOT admit the member two days before check-in", async () => {
      withStay({ checkIn: "2026-07-04", checkOut: "2026-07-06" });

      expect(showsStayingGuestSurface(await renderDashboard())).toBe(false);
    });
  });

  describe("hut leader", () => {
    it("admits a SINGLE-DAY assignment on the day it runs", async () => {
      withAssignment({ startDate: CLUB_TODAY, endDate: CLUB_TODAY });

      expect(showsHutLeaderSurface(await renderDashboard())).toBe(true);
    });

    it("admits a SINGLE-DAY assignment the day before it runs (day-before access)", async () => {
      withAssignment({ startDate: "2026-07-03", endDate: "2026-07-03" });

      expect(showsHutLeaderSurface(await renderDashboard())).toBe(true);
    });

    it("does NOT admit a SINGLE-DAY assignment that finished yesterday", async () => {
      withAssignment({ startDate: "2026-07-01", endDate: "2026-07-01" });

      expect(showsHutLeaderSurface(await renderDashboard())).toBe(false);
    });
  });

  describe("the two encodings stay separate", () => {
    it("keeps Booking.draftExpiresAt on the start-of-club-day INSTANT, not the date-only day", async () => {
      await renderDashboard();

      // `Booking.draftExpiresAt` is a real instant. A date-only value would push
      // it to club MIDDAY and hide a draft expiring this morning, so it takes
      // 00:00 NZ — the previous UTC day at 12:00Z in NZST — which is the same
      // instant `setHours(0, 0, 0, 0)` produced under the server's NZ pin, now
      // derived from the club's calendar instead.
      const draftCall = mocks.bookingFindMany.mock.calls.find(
        ([args]) => (args as { where?: { draftExpiresAt?: unknown } }).where
          ?.draftExpiresAt,
      );
      const draftExpiresAt = (
        draftCall?.[0] as { where: { draftExpiresAt: { gt: Date } } }
      ).where.draftExpiresAt.gt;
      expect(draftExpiresAt.toISOString()).toBe("2026-07-01T12:00:00.000Z");
    });

    it("keeps BOTH CalendarEvent.startsAt bounds on instants, a whole club fortnight apart", async () => {
      await renderDashboard();

      // The other half of the same rule, and it needs `eventsCalendar` on to be
      // reached at all — `showEventsCard` gates the query as well as the card.
      expect(
        mocks.calendarEventFindMany,
        "The events query never ran, so this assertion would inspect a mock " +
          "that never fired. Check the `eventsCalendar` module flag fixture.",
      ).toHaveBeenCalledTimes(1);

      const where = (
        mocks.calendarEventFindMany.mock.calls[0]?.[0] as {
          where: { startsAt: { gte: Date; lte: Date } };
        }
      ).where;
      // Start of club today (2 July NZ) and start of the fourteenth day after
      // it (16 July NZ), both as instants. A date-only value at either end would
      // sit at club midday and slice half a day off the window.
      expect(where.startsAt.gte.toISOString()).toBe("2026-07-01T12:00:00.000Z");
      expect(where.startsAt.lte.toISOString()).toBe("2026-07-15T12:00:00.000Z");
      // Exactly fourteen club days, which is what makes the end a CALENDAR step
      // rather than 14 x 24h added to an instant.
      expect(
        (where.startsAt.lte.getTime() - where.startsAt.gte.getTime()) /
          (24 * 60 * 60 * 1000),
      ).toBe(14);
    });
  });
});
