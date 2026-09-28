/**
 * THE MEMBER DASHBOARD ASKS THE CLUB'S RECORDED SETTING WHAT DAY IT IS, NOT THE
 * CONTAINER (CT-4 group E, #2870; epic #2988; INV-CONFIG-002, INV-DATE-013).
 *
 * ## Why this file exists beside `dashboard-club-day-boundaries.test.tsx`
 *
 * That suite is about the right DAY SHAPE — that the windows are date-only,
 * `[checkIn-1, checkOut]`, and narrowed the way `@prisma/adapter-pg` narrows
 * them. It cannot see the change this one is about, and that is worth stating
 * plainly rather than assuming: its Prisma mock has no `clubTimeSettings`
 * delegate, so `loadPersistedClubTimeSettings()` returns `null` and
 * `getClubTimeZone()` falls back to the environment seed — the same
 * `Pacific/Auckland` the old `getTodayDateOnly()` read. **All nineteen of its
 * assertions pass identically with the migration and without it.** A suite that
 * cannot tell the two apart is not evidence about which one is running.
 *
 * ## What makes the assertions here capable of failing
 *
 * The persisted reader is STUBBED, to a zone the environment does not hold, and
 * the page is driven twice at one instant with two different clubs configured.
 * Two different answers are demanded. A page that ignored the persisted setting
 * would give one answer for both clubs, which is what the two sets of
 * expectations below refuse.
 *
 * ## The instant, and why it is this one
 *
 * `2026-07-01T13:30:00.000Z` is **2 July** in New Zealand (01:30, NZST/UTC+12)
 * and **1 July** in Denver (07:30, MDT/UTC-6). So the two clubs disagree about
 * the calendar DAY, not merely the hour, and everything the dashboard derives
 * from "today" moves with it.
 *
 * `America/Denver` is chosen because it is BEHIND UTC. A club east of Greenwich
 * would agree with New Zealand about the day for most of the clock, which is
 * exactly the accident that hid this class of defect for so long.
 *
 * ## The premise, asserted rather than assumed
 *
 * Comparing the environment's zone identifier with the persisted one would be
 * the tempting guard and is nearly worthless — it passes under
 * `America/Chicago` while every assertion here goes vacuous.
 *
 * What is asserted instead is what `Intl` ITSELF puts each zone on at the pinned
 * instant. Comparing the file's own two expectation LITERALS to each other, the
 * first version of that guard, cannot fail for any reason whatsoever — they are
 * constants declared a hundred lines above it.
 *
 * This file used to stub the environment's zone to Auckland. That stub is gone:
 * #3567 deleted the constant, and nothing reads the environment's zone any more.
 * `process.env.TZ` is still pinned to a THIRD zone, from `vi.hoisted` so it
 * lands before the imports, so a page that fell back to the machine's clock
 * would answer neither club's day.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { restoreHostTimeZone } from "@/lib/__tests__/helpers/timezone";

/*
  THE MACHINE IS MOVED TO A THIRD ZONE, ABOVE THE IMPORTS.

  Pinned from `vi.hoisted` so it is in place before any module loads. It used to
  back up an environment-zone stub, which went with the constant in #3567; what
  it buys now is that a page reading the machine's clock answers a zone neither
  club is on. `Atlantic/Cape_Verde` is UTC-1: behind Greenwich, so it also moves
  a UTC-midnight encoding a day, and neither of the two clubs under test.

  Read by hand because `vi.hoisted` runs above this file's imports;
  `restoreHostTimeZone` below is the shared #2485 rule.
*/
const { HOST, originalHostTimeZone } = vi.hoisted(() => {
  const host = "Atlantic/Cape_Verde";
  const original = {
    envTz: process.env.TZ,
    resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  process.env.TZ = host;
  return { HOST: host, originalHostTimeZone: original };
});

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingFindMany: vi.fn(),
  calendarEventFindMany: vi.fn(),
  checkCapacity: vi.fn(),
  getAvailablePromoCodesForMember: vi.fn(),
  getClubTimeZone: vi.fn(),
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


/*
  THE SEAM UNDER TEST. `clubTime()` in `@/lib/club-time/server` resolves the
  club's identifier through this reader; a PARTIAL mock so the module's other
  exports (which the admin surfaces reach) stay real.
*/
vi.mock("@/lib/club-time-zone-settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getClubTimeZone: mocks.getClubTimeZone,
}));

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
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));
vi.mock("@/lib/promo", () => ({
  getAvailablePromoCodesForMember: mocks.getAvailablePromoCodesForMember,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/access-roles", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasAccessRole: mocks.hasAccessRole,
}));
vi.mock("@/lib/hut-leader", () => ({ isHutLeader: mocks.isHutLeader }));
vi.mock("@/lib/capacity", () => ({ checkCapacity: mocks.checkCapacity }));

import DashboardPage from "../page";

/** 01:30 on 2 July in Auckland; 07:30 on 1 July in Denver. */
const PINNED_INSTANT = "2026-07-01T13:30:00.000Z";

/** The shipped default zone, and this deployment's persisted value too. */
const AUCKLAND = "Pacific/Auckland";
/** Behind UTC, so it disagrees with Auckland about the calendar day here. */
const DENVER = "America/Denver";

/** The club calendar day each configured club is on at `PINNED_INSTANT`. */
const CLUB_TODAY = { [AUCKLAND]: "2026-07-02", [DENVER]: "2026-07-01" } as const;

afterAll(() => {
  // Never `delete process.env.TZ`: Node re-derives the zone on ASSIGNMENT only,
  // so a bare delete leaks this zone into whichever suite runs next (#2485).
  restoreHostTimeZone(originalHostTimeZone);
});

/**
 * The `YYYY-MM-DD` a zone is on at `PINNED_INSTANT`, straight from `Intl`.
 *
 * Deliberately NOT the kernel: recomputing an expectation with the code under
 * test proves only that the function is deterministic.
 */
function civilDayIn(zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(PINNED_INSTANT));
  const at = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${at("year")}-${at("month")}-${at("day")}`;
}

/**
 * A stay whose check-in is 3 July.
 *
 * The lodge-view window opens the day BEFORE check-in, so an Auckland club (on
 * 2 July) is inside it and a Denver club (still on 1 July) is not. That is the
 * whole product difference in one fixture.
 */
const STAY = { checkIn: "2026-07-03", checkOut: "2026-07-05" };

type DateFilter = { gte?: Date; lte?: Date };

/** What `@prisma/adapter-pg` narrows a `@db.Date` bind to: its UTC day. */
function boundDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

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
    eventsCalendar: true,
  };
}

async function renderDashboardFor(zone: string): Promise<string> {
  mocks.getClubTimeZone.mockResolvedValue(zone);
  return renderToStaticMarkup(await DashboardPage());
}

function offersLodgeView(html: string): boolean {
  return html.includes("View Lodge");
}

/** The `findFirst` filter the staying-guest card was decided from. */
function stayingGuestFilter(): { checkIn: DateFilter; checkOut: DateFilter } {
  const call = mocks.bookingFindFirst.mock.calls.at(-1)?.[0] as
    | { where: { checkIn: DateFilter; checkOut: DateFilter } }
    | undefined;
  if (!call) {
    throw new Error(
      "The dashboard never asked about a staying guest, so nothing below is " +
        "being measured. Check the module flags and the access-role stub.",
    );
  }
  return call.where;
}

describe("the member dashboard runs on the persisted club timezone (CT-4, #2870)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(PINNED_INSTANT));
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
    mocks.isHutLeader.mockResolvedValue(false);
    mocks.bookingFindFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { checkIn: DateFilter; checkOut: DateFilter } })
        .where;
      const admitted =
        dateFilterAdmits(STAY.checkIn, where.checkIn) &&
        dateFilterAdmits(STAY.checkOut, where.checkOut);
      return admitted ? { id: "stay-1" } : null;
    });
  });

  it("the runtime really puts these clubs where this file says, and the host pin is live", () => {
    /*
      THE PREMISE, AND IT HAS TO READ SOMETHING OUTSIDE THIS FILE.

      `expect(CLUB_TODAY[AUCKLAND]).not.toBe(CLUB_TODAY[DENVER])` compares two
      string literals declared a hundred lines above. Nothing — no code change,
      no ICU data update — can ever make it fail, so it asserted nothing while
      reading exactly like the guard this comment describes. What is asserted
      instead is what `Intl` ITSELF puts each zone on at `PINNED_INSTANT`, so a
      runtime that collapsed the two fails here rather than leaving every case
      below quietly vacuous.

      The last line checks the host pin took (see the top of the file): the
      machine is on `Atlantic/Cape_Verde`, neither club's zone, so a page that
      ignored the persisted setting for the machine's clock could not produce
      either column by accident.
    */
    expect(civilDayIn(AUCKLAND)).toBe(CLUB_TODAY[AUCKLAND]);
    expect(civilDayIn(DENVER)).toBe(CLUB_TODAY[DENVER]);
    expect(civilDayIn(AUCKLAND)).not.toBe(civilDayIn(DENVER));

    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(HOST);
  });

  it.each([AUCKLAND, DENVER] as const)(
    "asks the lodge-night columns about %s's calendar day",
    async (zone) => {
      await renderDashboardFor(zone);
      const where = stayingGuestFilter();

      // `checkOut >= today` and `checkIn <= tomorrow` — both `@db.Date`, so both
      // ends must be UTC midnight for the adapter's narrowing to be lossless.
      expect(where.checkOut.gte?.toISOString()).toBe(
        `${CLUB_TODAY[zone]}T00:00:00.000Z`,
      );
      expect(boundDay(where.checkOut.gte as Date)).toBe(CLUB_TODAY[zone]);
    },
  );

  it("offers the lodge view to the Auckland club, whose day-before has arrived", async () => {
    const html = await renderDashboardFor(AUCKLAND);
    expect(offersLodgeView(html)).toBe(true);
  });

  it("withholds it from the Denver club, whose day-before has not", async () => {
    /*
      THE HALF THAT CATCHES A PAGE STILL READING THE ENVIRONMENT. Same instant,
      same stay, same member — and the only difference is which club is
      configured. A dashboard on the environment's zone would answer Auckland here and
      offer a lodge link a day early, which is the visible shape of the defect:
      a member clicking through to a kiosk that answers `tier: "none"`.
    */
    const html = await renderDashboardFor(DENVER);
    expect(offersLodgeView(html)).toBe(false);
  });

  it("steps tomorrow by a CALENDAR day, so the pair is never 24 hours apart by accident", async () => {
    /*
      The window's far end is `today + 1`, and it is stepped with
      `addCalendarDays` rather than by adding 86 400 000 ms. On a spring-forward
      day the club's civil day is 23 hours long, so a fixed-millisecond step
      lands mid-day and the adapter narrows it to the WRONG day. Denver springs
      forward on 8 March 2026, which is why the assertion is written against a
      zone that has a transition at all.
    */
    vi.setSystemTime(new Date("2026-03-08T18:00:00.000Z")); // 11:00 MDT, 8 March
    await renderDashboardFor(DENVER);
    const where = stayingGuestFilter();
    expect(boundDay(where.checkOut.gte as Date)).toBe("2026-03-08");
    expect(boundDay(where.checkIn.lte as Date)).toBe("2026-03-09");
  });
});
