// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KioskPage from "../page";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import {
  buildWeekDateKeys,
  type KioskWeekDaySummary,
} from "../_components/kiosk-week-view";

/*
  THE CLUB'S ZONE NOW ARRIVES THROUGH THE PROVIDER, AND THE ENVIRONMENT IS SET
  SOMEWHERE ELSE ON PURPOSE (CT-4, #2870; INV-CONFIG-002).

  Before CT-4 the kiosk read `APP_TIME_ZONE`, so this mock was the club's zone
  and pinning it to `Pacific/Auckland` was what kept the rollover cases meaning
  anything once the HOST zone moved. The page now takes the club's day from
  `ClubTimeProvider` instead, and `renderKiosk` below supplies it — so the mock
  is free to become a THIRD zone, and it should be. With three different zones
  in play (club `Pacific/Auckland`, environment `America/Denver`, host `UTC`)
  every date assertion in this file discriminates all three: an implementation
  that read the environment, or the tablet's own clock, would name a different
  night and go red.

  `APP_LOCALE` still matters and is left alone — the kiosk header's long-weekday
  formatter is a calendar-date shape with no house entry in the kernel, so it
  stays local and is pinned to `UTC` over the UTC-midnight encoding.
*/
vi.mock("@/config/operational", () => ({
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
}));

vi.mock("@/components/kiosk-lodge-instructions", () => ({
  KioskLodgeInstructions: ({ date }: { date: string }) => (
    <div data-testid="kiosk-instructions">{date}</div>
  ),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

function buildWeekDays(start: string): KioskWeekDaySummary[] {
  return buildWeekDateKeys(start).map((date, index) =>
    index === 0
      ? {
          date,
          accessible: true,
          guestCount: 2,
          arrivingCount: 1,
          departingCount: 0,
          rosterStatus: "needs-roster",
        }
      : {
          date,
          accessible: false,
        }
  );
}

/** The club this kiosk belongs to. Delivered the way the application does it. */
const CLUB_ZONE = "Pacific/Auckland";

function renderKiosk() {
  return render(
    <ClubTimeProvider zone={CLUB_ZONE}>
      <KioskPage />
    </ClubTimeProvider>,
  );
}

describe("KioskPage week view", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads the week summary by default and drills into the day endpoints", async () => {
    let servedWeekStart = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith("/api/lodge/access")) {
        return Response.json({
          tier: "admin",
          dateRange: null,
          canManageRoster: true,
          canMarkAttendance: true,
          canCompleteChores: true,
          lodgeName: "Whakapapa",
        });
      }

      if (url.startsWith("/api/lodge/week?start=")) {
        servedWeekStart = new URL(url, "http://localhost").searchParams.get("start") ?? "";
        return Response.json({
          start: servedWeekStart,
          days: buildWeekDays(servedWeekStart),
        });
      }

      if (url.startsWith(`/api/lodge/guests/${servedWeekStart}`)) {
        return Response.json({
          bookings: [],
          totalGuests: 0,
        });
      }

      if (url.startsWith(`/api/lodge/roster/${servedWeekStart}`)) {
        return Response.json({
          assignments: [],
        });
      }

      throw new Error(`Unexpected fetch ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    renderKiosk();

    expect(await screen.findByRole("heading", { name: "Week View" })).toBeVisible();
    expect(servedWeekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/lodge/week?start="))
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/lodge/guests/"))
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Open / }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          // #2631: one operational-day scope, so no query parameter.
          ([url]) => String(url) === `/api/lodge/guests/${servedWeekStart}`
        )
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === `/api/lodge/roster/${servedWeekStart}`
      )
    ).toBe(true);
    expect(screen.getByRole("button", { name: /Week/ })).toBeVisible();

    const weekCallCount = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/lodge/week?start=")
    ).length;
    fireEvent.click(screen.getByRole("button", { name: /Week/ }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes("/api/lodge/week?start=")
        ).length
      ).toBeGreaterThan(weekCallCount);
    });
  });
});

/*
  #2474 — the kiosk's idea of "today" belongs to the CLUB, not to the display
  device, and it has to STAY the club's day on a screen nobody reloads.

  A lodge kiosk is a tablet on a wall. Nobody administers its clock, and a
  device on the wrong zone (or simply shipped on UTC) used to open the kiosk on
  the wrong night: the page read `new Date()` through local getters while every
  server route it calls resolves the night in New Zealand. The hut leader then
  saw one night's arrivals and the check-in write refused a different one.

  Every case below therefore runs the page on a HOST that is deliberately NOT in
  New Zealand, at an instant where the two calendars genuinely disagree. The
  fixture instants are absolute, so the rollover canary's shifted real clock
  cannot move them.

  ONE THING THESE TESTS DO NOT PROVE, stated here so nobody mistakes them for it:
  the day arrows also moved from a local-midnight `Date` round trip onto
  `addDaysToDateKey`, and NO page-level test can tell those two apart. Written
  and read back through the same local getters, the old round trip agreed with
  the new arithmetic on every DST transition, month end and year end in every
  IANA zone (swept 2008-2030; the sole divergence in the whole space is the 2011
  Samoa dateline skip, which deleted a calendar day). That switch is a seam
  alignment, not a repaired defect — the contract for the arithmetic itself is a
  direct unit case in `_components/__tests__/kiosk-week-view.test.tsx`.
*/

// Restoring the host zone is not `delete process.env.TZ`: Node applies a zone
// when TZ is ASSIGNED and keeps it once the variable is removed, so deleting
// alone would strand the whole worker on whichever zone this file set last
// (#2485). `captureHostTimeZone` assigns the resolved starting zone back
// first, then removes the variable.
const hostTimeZone = captureHostTimeZone();

/** Every day of the served week open, so any of them can be drilled into. */
function buildOpenWeekDays(start: string): KioskWeekDaySummary[] {
  return buildWeekDateKeys(start).map((date) => ({
    date,
    accessible: true as const,
    guestCount: 0,
    arrivingCount: 0,
    departingCount: 0,
    rosterStatus: "no-guests" as const,
  }));
}

/**
 * Serves every kiosk endpoint and records the date each was asked for, so a
 * test can assert on the NIGHT the page requested rather than on its own idea
 * of what should have been rendered.
 */
function installKioskFetchMock() {
  const accessDates: string[] = [];
  const weekStarts: string[] = [];
  const dayDates: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;

    if (path === "/api/lodge/access") {
      accessDates.push(url.searchParams.get("date") ?? "");
      return Response.json({
        tier: "admin",
        dateRange: null,
        canManageRoster: true,
        canMarkAttendance: true,
        canCompleteChores: true,
        lodgeName: "Whakapapa",
      });
    }

    if (path === "/api/lodge/week") {
      const start = url.searchParams.get("start") ?? "";
      weekStarts.push(start);
      return Response.json({ start, days: buildOpenWeekDays(start) });
    }

    const guests = path.match(/^\/api\/lodge\/guests\/(\d{4}-\d{2}-\d{2})$/);
    if (guests) {
      dayDates.push(guests[1]);
      return Response.json({ bookings: [], totalGuests: 0 });
    }

    const roster = path.match(/^\/api\/lodge\/roster\/(\d{4}-\d{2}-\d{2})$/);
    if (roster) {
      return Response.json({ assignments: [] });
    }

    throw new Error(`Unexpected fetch ${url}`);
  });

  // `vi.stubGlobal` rather than a raw `global.fetch =`: a raw assignment is not
  // undone by `vi.restoreAllMocks()`, so it would outlive this describe and
  // silently serve whichever suite happened to be ordered after it.
  vi.stubGlobal("fetch", fetchMock);
  return { accessDates, weekStarts, dayDates };
}

/**
 * Drains the page's chained fetches (access -> week/day) without `waitFor`.
 *
 * The rollover case fakes `setInterval`, and `waitFor`/`findBy*` poll on a real
 * interval — under a faked one they can only be woken by a DOM mutation, which
 * is exactly the kind of near-miss that reports green. `setTimeout` stays real
 * here, so awaiting a macrotask inside `act` flushes both the microtask queue
 * and React's effects, deterministically.
 */
async function settleKiosk(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("KioskPage club-time dates (#2474)", () => {
  beforeEach(() => {
    // A kiosk tablet whose clock is on UTC — the shipped default, and the
    // common case on a device nobody administers.
    process.env.TZ = "UTC";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Put the harness's timer shape back whatever a case did to it: the
    // rollover case additionally fakes `setInterval`, and the root re-freeze
    // will not undo that (it only ever converts a REAL clock back to a frozen
    // one). Uninstall first — reconfiguring in place would keep this file's
    // pending fake intervals alive.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"] });
    // The root re-freeze restores the DEFAULT instant only when nothing is
    // mocking Date, and these tests leave their own pin in place — so hand the
    // harness instant back explicitly rather than leaking a pin into the next
    // file-level test (docs/TESTING.md, rule 4).
    vi.setSystemTime(frozenTestNow());
    hostTimeZone.restore();
  });

  it("opens on the club's day, not the display device's, after the NZ rollover", async () => {
    // 13:00 UTC on Sunday 2 August 2026 is 01:00 on MONDAY 3 August in
    // Pacific/Auckland (NZST, UTC+12). The tablet still says 2 August; the club
    // — and every lodge route the kiosk calls — is already on the 3rd.
    vi.setSystemTime(new Date("2026-08-02T13:00:00.000Z"));
    const { accessDates, weekStarts } = installKioskFetchMock();

    renderKiosk();

    expect(await screen.findByRole("heading", { name: "Week View" })).toBeVisible();

    // The night asked for is the club's, and never the host's.
    expect(accessDates).toContain("2026-08-03");
    expect(accessDates).not.toContain("2026-08-02");
    // 3 August 2026 is itself a Monday, so it is also the week start.
    expect(weekStarts).toEqual(["2026-08-03"]);

    // ...and the strip marks the club's day as today. A host-derived "today"
    // would be 2 August, which is not even in this week, so no day would carry
    // the marker at all.
    expect(
      screen.getByRole("button", { name: "Open Monday, 3 August" })
    ).toHaveTextContent("Today");
    // Selector-scoped: the week header also carries a "Today" jump BUTTON, and
    // the marker under test is the chip inside a day tile.
    expect(screen.getAllByText("Today", { selector: "p" })).toHaveLength(1);
  });

  it("steps across a month boundary and comes back to the club's day", async () => {
    // 13:00 UTC on 30 July 2026 is FRIDAY 31 July in Pacific/Auckland.
    vi.setSystemTime(new Date("2026-07-30T13:00:00.000Z"));
    const { dayDates } = installKioskFetchMock();

    renderKiosk();

    expect(await screen.findByRole("heading", { name: "Week View" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Friday, 31 July" }));

    expect(
      await screen.findByRole("heading", { name: "Friday, 31 July 2026" })
    ).toBeVisible();
    await waitFor(() => expect(dayDates).toContain("2026-07-31"));

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(
      await screen.findByRole("heading", { name: "Saturday, 1 August 2026" })
    ).toBeVisible();
    await waitFor(() => expect(dayDates).toContain("2026-08-01"));

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(
      await screen.findByRole("heading", { name: "Friday, 31 July 2026" })
    ).toBeVisible();

    // One night per press, and the night the page ASKED FOR is the one it
    // showed: no neighbouring night was ever fetched.
    expect(dayDates).not.toContain("2026-07-30");
    expect(dayDates).not.toContain("2026-08-02");

    // Back on the strip, "today" is still the CLUB's Friday. This is the half
    // of the case that discriminates: a device-derived today on this UTC host
    // is Thursday 30 July, which sits in the very same week, so the chip would
    // simply be on the wrong tile rather than absent.
    fireEvent.click(screen.getByRole("button", { name: /Week$/ }));
    expect(await screen.findByRole("heading", { name: "Week View" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open Friday, 31 July" })
    ).toHaveTextContent("Today");
    expect(
      screen.getByRole("button", { name: "Open Thursday, 30 July" })
    ).not.toHaveTextContent("Today");
  });

  it("rolls a never-reloaded kiosk onto the club's new day at NZ midnight", async () => {
    /*
      The deployment shape that matters: a wall tablet left running. Before this
      case existed, `todayDate` was read fresh in the render while `date` and
      `weekStart` were mount-time state, so at 00:00 NZ the chip moved and the
      night being served did not — and 00:00 NZ is the check-in hour, not a
      harmless midday. Chip and served night now move together or not at all.

      `setInterval` is faked here (Date-only faking is the harness default) so
      the club-day tick can be driven deterministically instead of waited on.
    */
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    // 11:59 UTC is 23:59 on SUNDAY 2 August in Pacific/Auckland — one minute of
    // club day left, and the host is still on Sunday morning UTC.
    vi.setSystemTime(new Date("2026-08-02T11:59:00.000Z"));
    const { accessDates, weekStarts } = installKioskFetchMock();

    renderKiosk();
    await settleKiosk();

    expect(screen.getByRole("heading", { name: "Week View" })).toBeVisible();
    expect(accessDates).toContain("2026-08-02");
    expect(weekStarts).toEqual(["2026-07-27"]);
    expect(
      screen.getByRole("button", { name: "Open Sunday, 2 August" })
    ).toHaveTextContent("Today");

    // The club crosses midnight into Monday 3 August. Nobody touches the
    // tablet; only the clock moves.
    vi.setSystemTime(new Date("2026-08-02T12:00:30.000Z"));

    // First, the half-minute BEFORE the tick lands. A re-render in that window
    // must not move the chip on its own: the page is still serving Sunday, and
    // a chip reading the club's calendar inline would already say Monday. This
    // is the divergence #2474's review found, in miniature — chip and served
    // night move together or not at all. Refresh is just a cheap re-render.
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settleKiosk();
    expect(
      screen.getByRole("button", { name: "Open Sunday, 2 August" })
    ).toHaveTextContent("Today");
    expect(accessDates).not.toContain("2026-08-03");

    // One `CLUB_DAY_TICK_MS` (page.tsx) — raising that constant should fail
    // this case rather than quietly slow the kiosk down.
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    await settleKiosk();

    // The night served, the week strip and the chip all followed the club.
    expect(accessDates).toContain("2026-08-03");
    expect(weekStarts).toContain("2026-08-03");
    expect(
      screen.getByRole("button", { name: "Open Monday, 3 August" })
    ).toHaveTextContent("Today");
    expect(screen.getAllByText("Today", { selector: "p" })).toHaveLength(1);
  });

  it("does not re-point an open day list at the new night mid-check-in", async () => {
    /*
      The dangerous variant: the kiosk is on TODAY's day list — the arrivals
      screen — when the club rolls over. Advancing it would move the list, and
      the next **Arrived** tap, onto a different lodge night at the exact hour a
      late party is being checked in. The day list waits to be asked.
    */
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-08-02T11:59:00.000Z"));
    const { accessDates } = installKioskFetchMock();

    renderKiosk();
    await settleKiosk();

    // Drill into the club's CURRENT day, so only the view — not the night —
    // distinguishes this from the rollover case above.
    fireEvent.click(screen.getByRole("button", { name: "Open Sunday, 2 August" }));
    await settleKiosk();
    expect(
      screen.getByRole("heading", { name: "Sunday, 2 August 2026" })
    ).toBeVisible();

    vi.setSystemTime(new Date("2026-08-02T12:00:30.000Z"));
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    await settleKiosk();

    expect(
      screen.getByRole("heading", { name: "Sunday, 2 August 2026" })
    ).toBeVisible();
    expect(accessDates).not.toContain("2026-08-03");

    // Back on the strip, the week shown is the one around the night that was
    // opened — Mon 27 Jul to Sun 2 Aug — which no longer holds the club's day,
    // so nothing is marked Today. Nothing is mismarked either: the chip is
    // never on a day that is not today. **Today** is what jumps across.
    fireEvent.click(screen.getByRole("button", { name: /Week$/ }));
    await settleKiosk();
    expect(screen.queryAllByText("Today", { selector: "p" })).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await settleKiosk();
    expect(accessDates).toContain("2026-08-03");
    expect(
      screen.getByRole("button", { name: "Open Monday, 3 August" })
    ).toHaveTextContent("Today");
  });

  it("leaves a hut leader's chosen night alone when the club day turns over", async () => {
    // Same rollover, but the kiosk has been navigated off "today" first. The
    // club day advancing must not yank the screen out from under whoever is
    // working on another night.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-08-02T11:59:00.000Z"));
    const { accessDates, weekStarts } = installKioskFetchMock();

    renderKiosk();
    await settleKiosk();

    fireEvent.click(screen.getByRole("button", { name: "Open Friday, 31 July" }));
    await settleKiosk();
    expect(
      screen.getByRole("heading", { name: "Friday, 31 July 2026" })
    ).toBeVisible();

    vi.setSystemTime(new Date("2026-08-02T12:00:30.000Z"));
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    await settleKiosk();

    // Still on the chosen night: no fetch for the new club day, and the header
    // has not moved.
    expect(
      screen.getByRole("heading", { name: "Friday, 31 July 2026" })
    ).toBeVisible();
    expect(accessDates).not.toContain("2026-08-03");
    expect(weekStarts).not.toContain("2026-08-03");

    // ...and **Today** still goes to the club's CURRENT day, not the day the
    // page was mounted on.
    fireEvent.click(screen.getByRole("button", { name: /Week$/ }));
    await settleKiosk();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await settleKiosk();

    expect(accessDates).toContain("2026-08-03");
    expect(
      screen.getByRole("button", { name: "Open Monday, 3 August" })
    ).toHaveTextContent("Today");
  });
});
