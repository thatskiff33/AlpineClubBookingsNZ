/**
 * The staying-guest day boundary in the authenticated layout (#2838).
 *
 * This layout wraps every member page, and the `isStayingGuest` flag it hands
 * the nav bar is what puts the lodge LINK in front of a guest. Its own comment
 * states the rule — a PAID booking where `checkIn - 1 <= today <= checkOut` — so
 * the day-before offer is deliberate, not incidental.
 *
 * The flag is a link, not a permission. `/lodge/kiosk` is gated by
 * `getKioskAccessTier` (`src/lib/kiosk-access.ts:31-81`), which asks the club's
 * calendar and already implemented the same `[checkIn-1, checkOut]` (`:71-73`).
 * So the day-before link was missing while the access behind it worked, and the
 * day-after link was dead.
 *
 * SUBJECT SET: this query asks about `memberId` alone — the booking OWNER —
 * whereas the dashboard's copy of the rule and `getKioskAccessTier` both also
 * admit a LINKED MEMBER GUEST. That difference is pre-existing and untouched by
 * #2838; the fixtures below are all owner bookings, so nothing here depends on
 * which way it is resolved.
 *
 * `Booking.checkIn`/`checkOut` are `@db.Date`, and `@prisma/adapter-pg` narrows
 * a bound `Date` for such a column to its UTC calendar date (`formatDate` in
 * `mapArg`). The old `new Date()` + `setHours(0, 0, 0, 0)` was NZ-LOCAL
 * midnight — the PREVIOUS UTC day under the `TZ=Pacific/Auckland` server pin,
 * `(D-1)T12:00Z` in NZST and `(D-1)T11:00Z` under NZ daylight saving — so it
 * narrowed to D-1 either way and moved the whole window a day late.
 *
 * The pinned instant is 01:30 on 2 July in New Zealand, 13:30 on 1 July in UTC
 * and 23:30 on 1 July in Brisbane, so a wrong club zone changes the answer
 * rather than merely the arithmetic.
 *
 * THE CLUB'S ZONE IS AN INPUT HERE, NOT THE ENVIRONMENT'S (CT-4, #2870;
 * INV-CONFIG-002). The layout takes its day from `clubTime()`, which resolves
 * the persisted `ClubTimeSettings` row, so `getClubTimeZone` is stubbed and the
 * suite says which club it means. That replaced an `expectClubTimeZonePremise()`
 * guard, which was the right tool while this window read `APP_TIME_ZONE` and is
 * the wrong one now: it asserted a fact about the CONTAINER, which no longer
 * decides anything here, and it turned every run under a non-NZ `TZ` red for a
 * reason that had stopped being true.
 *
 * The five shape cases below all run under the recorded New Zealand club. They
 * are about the WINDOW — `[checkIn-1, checkOut]`, date-only, narrowed the way
 * `@prisma/adapter-pg` narrows it — and they cannot see which authority supplied
 * "today": measured, a mutant making the server binding ignore the persisted row
 * killed 0 of the 5. The pair in the second block is what closes that, by
 * driving one fixture under two clubs and demanding two different answers.
 *
 * Measured against explicitly-configured club zones: `Australia/Brisbane` and
 * `UTC` each turn 3 of the 5 shape tests red; `Etc/GMT-13` turns none red,
 * because it names the same calendar DAY at this instant and this file asserts
 * no instant (the dashboard suite's two `DateTime` assertions are what catch
 * that zone); and `Etc/GMT-12` is New Zealand in July, so nothing can tell them
 * apart.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getClubTimeZone: vi.fn(),
  headers: vi.fn(),
  memberFindUnique: vi.fn(),
  bookingFindFirst: vi.fn(),
  hasActiveHutLeaderAssignment: vi.fn(),
  navBar: vi.fn(),
}));

/*
  THE SEAM CT-4 (#2870) MOVED THIS LAYOUT ONTO. `clubTime()` in
  `@/lib/club-time/server` resolves the club's identifier through this reader, so
  stubbing it is what lets the same fixture be driven under two different clubs.
  A PARTIAL mock, so the module's other exports stay real.

  Without it this suite could not see the change at all, and that is measured
  rather than assumed: with the zone left to fall back to the environment, a
  mutant that made `clubTimeZone()` ignore the persisted row entirely killed 0 of
  the 5 assertions here. It is the same hole `dashboard-club-time-zone.test.tsx`
  exists to close for the dashboard's copy of this rule, closed the same way.
*/
vi.mock("@/lib/club-time-zone-settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getClubTimeZone: mocks.getClubTimeZone,
}));

vi.mock("@/lib/auth", () => ({ auth: () => mocks.auth() }));
vi.mock("next/headers", () => ({ headers: () => mocks.headers() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    booking: { findFirst: mocks.bookingFindFirst },
  },
}));
vi.mock("@/lib/hut-leader", () => ({
  hasActiveHutLeaderAssignment: mocks.hasActiveHutLeaderAssignment,
}));
vi.mock("@/lib/club-theme-fonts", () => ({
  clubThemeFontVariableClassName: "font-vars",
}));
vi.mock("@/lib/site-banners", () => ({
  getCurrentSiteBanners: vi.fn(async () => []),
}));
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: vi.fn(async () => ({ appCss: "" })),
}));
vi.mock("@/lib/public-layout-config", async () => {
  const { clubIdentity } = await import("@/config/club-identity");
  return { getCachedClubIdentity: vi.fn(async () => clubIdentity) };
});
// Partial: `@/config/club-identity` also reads FALLBACK_LODGE_CAPACITY from
// this module at import time, so the real exports have to stay in place.
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultLodgeCapacity: vi.fn(async () => 30),
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => ({ aiAssistant: false })),
}));
vi.mock("@/lib/ai-assistant-config", () => ({
  getAiAssistantAvailability: vi.fn(async () => false),
}));
vi.mock("@/components/app-providers", () => ({
  AppProviders: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/nav-bar", () => ({
  NavBar: (props: { user: { isStayingGuest: boolean } }) => {
    mocks.navBar(props);
    return null;
  },
}));
vi.mock("@/components/site-banners", () => ({ SiteBanners: () => null }));
vi.mock("@/components/member-onboarding-wizard", () => ({
  MemberOnboardingWizard: () => null,
}));
vi.mock("@/components/report-issue-widget", () => ({
  ReportIssueWidget: () => null,
}));
vi.mock("@/components/help-widget/help-widget-context", () => ({
  HelpWidgetProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/help-widget/help-widget-member", () => ({
  HelpWidgetMember: () => null,
}));

import AuthenticatedLayout from "@/app/(authenticated)/layout";

const PINNED_INSTANT = "2026-07-01T13:30:00.000Z";

/** The club this deployment records, and the day it is on at that instant. */
const AUCKLAND = "Pacific/Auckland";
/** A club BEHIND UTC, which at the same instant is still on the day before. */
const DENVER = "America/Denver";

const CLUB_DAY = { [AUCKLAND]: "2026-07-02", [DENVER]: "2026-07-01" } as const;
const CLUB_TODAY = CLUB_DAY[AUCKLAND];

/**
 * The `YYYY-MM-DD` a zone is on at `PINNED_INSTANT`, straight from `Intl`.
 *
 * Deliberately not the kernel: recomputing an expectation with the code under
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

type DateFilter = { gte?: Date; lte?: Date };

/** The calendar day Postgres receives for a value bound to a `@db.Date`. */
function boundDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateFilterAdmits(storedDay: string, filter: DateFilter): boolean {
  if (filter.gte && storedDay < boundDay(filter.gte)) return false;
  if (filter.lte && storedDay > boundDay(filter.lte)) return false;
  return true;
}

function withStay(stay: { checkIn: string; checkOut: string } | null) {
  mocks.bookingFindFirst.mockImplementation(async (args: unknown) => {
    const where = (args as { where: { checkIn: DateFilter; checkOut: DateFilter } })
      .where;
    if (!stay) return null;
    return dateFilterAdmits(stay.checkIn, where.checkIn) &&
      dateFilterAdmits(stay.checkOut, where.checkOut)
      ? { id: "stay-1" }
      : null;
  });
}

async function isStayingGuest(): Promise<boolean> {
  // Rendering (rather than just awaiting the layout) is what runs the NavBar
  // element, and its `user` prop is the flag under test.
  renderToStaticMarkup(await AuthenticatedLayout({ children: "member page" }));
  const call = mocks.navBar.mock.calls.at(-1)?.[0] as {
    user: { isStayingGuest: boolean };
  };
  return call.user.isStayingGuest;
}

describe("authenticated layout staying-guest day boundary (#2838)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(PINNED_INSTANT));
    // The club this deployment records. The pair at the end of this file drives
    // the same fixture under the other one.
    mocks.getClubTimeZone.mockResolvedValue(AUCKLAND);

    mocks.auth.mockResolvedValue({
      user: { id: "member-1", name: "Mere Member", email: "m@example.test" },
    });
    mocks.headers.mockResolvedValue(new Headers());
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-1",
      active: true,
      forcePasswordChange: false,
      role: "USER",
      accessRoles: ["USER"],
    });
    mocks.hasActiveHutLeaderAssignment.mockResolvedValue(false);
    withStay(null);
  });

  it("asks the @db.Date columns about today and tomorrow as date-only days", async () => {
    await isStayingGuest();

    const where = (
      mocks.bookingFindFirst.mock.calls[0]?.[0] as {
        where: { checkIn: DateFilter; checkOut: DateFilter };
      }
    ).where;
    expect(where.checkOut.gte?.toISOString()).toBe("2026-07-02T00:00:00.000Z");
    expect(where.checkIn.lte?.toISOString()).toBe("2026-07-03T00:00:00.000Z");
    expect(boundDay(where.checkOut.gte as Date)).toBe(CLUB_TODAY);
  });

  it("admits the member the DAY BEFORE check-in, as the rule says", async () => {
    withStay({ checkIn: "2026-07-03", checkOut: "2026-07-05" });

    expect(await isStayingGuest()).toBe(true);
  });

  it("still admits the member on the CHECK-OUT day itself", async () => {
    withStay({ checkIn: "2026-06-30", checkOut: CLUB_TODAY });

    expect(await isStayingGuest()).toBe(true);
  });

  it("does NOT admit the member the day after check-out", async () => {
    withStay({ checkIn: "2026-06-29", checkOut: "2026-07-01" });

    expect(await isStayingGuest()).toBe(false);
  });

  it("does NOT admit the member two days before check-in", async () => {
    withStay({ checkIn: "2026-07-04", checkOut: "2026-07-06" });

    expect(await isStayingGuest()).toBe(false);
  });
});

describe("the day comes from the club's PERSISTED zone (CT-4, #2870)", () => {
  /*
    THE PAIR, and why the five cases above cannot stand in for it.

    Each of those asks whether the window has the right SHAPE around "today". If
    the layout went on taking "today" from the container's `TZ` instead of from
    `ClubTimeSettings`, every one of them would still pass — because on this
    deployment the two agree, which is precisely the accident that hides this
    class of defect. Measured: a mutant making the server binding ignore the
    persisted row killed 0 of those 5.

    So the same fixture is driven twice, changing only which club is configured,
    and the two are required to DISAGREE. `2026-07-01T13:30Z` is 01:30 on 2 July
    in Auckland and 07:30 on 1 July in Denver, and the stay checks in on 3 July —
    so the day-before window has opened for one club and not the other. The
    product difference is a nav link: a member offered "Lodge" a day early, or
    denied it on the morning they arrive.
  */
  const STAY_FROM_THE_THIRD = { checkIn: "2026-07-03", checkOut: "2026-07-05" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(PINNED_INSTANT));
    mocks.auth.mockResolvedValue({
      user: { id: "member-1", name: "Mere Member", email: "m@example.test" },
    });
    mocks.headers.mockResolvedValue(new Headers());
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-1",
      active: true,
      forcePasswordChange: false,
      role: "USER",
      accessRoles: ["USER"],
    });
    mocks.hasActiveHutLeaderAssignment.mockResolvedValue(false);
    withStay(STAY_FROM_THE_THIRD);
  });

  it("the two clubs really are on different days at this instant", () => {
    // THE PREMISE, read from `Intl` rather than from the constants above, so a
    // runtime or a fixture edit that put the two clubs on the same day fails
    // here instead of leaving the pair below asserting nothing twice.
    expect(civilDayIn(AUCKLAND)).toBe(CLUB_DAY[AUCKLAND]);
    expect(civilDayIn(DENVER)).toBe(CLUB_DAY[DENVER]);
    expect(civilDayIn(AUCKLAND)).not.toBe(civilDayIn(DENVER));
  });

  it("offers the lodge link to the club whose day-before has arrived", async () => {
    mocks.getClubTimeZone.mockResolvedValue(AUCKLAND);

    expect(await isStayingGuest()).toBe(true);
  });

  it("withholds it from the club still on the day before that", async () => {
    mocks.getClubTimeZone.mockResolvedValue(DENVER);

    expect(await isStayingGuest()).toBe(false);
  });

  it("really asks the persisted reader, rather than defaulting past it", async () => {
    /*
      The resolver is FAIL-SOFT: an unreachable database, an absent row or a
      missing delegate all degrade silently to the environment seed, which on
      this deployment answers Auckland. So "true" above and "the stub was never
      consulted" look identical from the outside. This says which happened.
    */
    mocks.getClubTimeZone.mockResolvedValue(DENVER);
    await isStayingGuest();

    expect(mocks.getClubTimeZone).toHaveBeenCalled();
  });
});
