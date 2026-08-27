// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import { ClubTimeProvider } from "@/components/club-time-provider";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import { buildMonthGrid } from "@/lib/calendar-client";
import {
  clubToday,
  clubWallTimeOf,
  endOfClubDayExclusive,
  formatClubInstantTime,
  formatClubMonthYear,
  requireCalendarDate,
  requireClubTimeZone,
  requireInstant,
  startOfCalendarMonth,
  startOfClubDay,
  type ClubTimeZone,
} from "@/lib/club-time";
import { divergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";
import { CalendarView } from "../calendar-view";
import { EventDialog } from "../event-dialog";
import { MonthCalendar } from "../month-calendar";
import { DayEventsDialog } from "../day-events-dialog";

/**
 * The events calendar reads the CLUB's timezone from `ClubTimeProvider`, and
 * this suite is built so that it cannot pass unless it does (CT-4 group F5,
 * #2870).
 *
 * ## Why it does not use the shared render harness
 *
 * `src/lib/__tests__/support/club-time-render.tsx` mounts the provider with
 * `CLUB_TIME_TEST_ZONE = "Pacific/Auckland"`, which is deliberately what
 * `APP_TIME_ZONE` resolves to under test — so a suite on that default cannot
 * tell the persisted zone from the environment however much it asserts. On this
 * epic a mutant hook that ignored the provider entirely failed 0 of 460
 * assertions across the 34 suites that use it, and of one later group's 49
 * provider-reading components, 46 were blind.
 *
 * So this suite mounts the provider itself with a zone `divergentClubZone` picks
 * to differ from BOTH `APP_TIME_ZONE` and the host's own resolved zone, and every
 * assertion below is checked against the two wrong answers as well as the right
 * one. The other three suites in this directory stay on the shared harness on
 * purpose: their subjects are permission gating, a11y and overflow behaviour,
 * none of which is about the zone.
 *
 * ## Every fixture instant sits in the 10:00 UTC hour, and that is load-bearing
 *
 * Three calendar days exist on earth simultaneously only while the UTC hour is
 * 10 — `UTC+14` has turned over and `UTC-11` has not. At any other hour there are
 * two, and both can already be taken by `APP_TIME_ZONE` and the host, leaving no
 * divergent zone for the chooser to pick. That is why the blocks deriving the
 * club's TODAY pin their own instant with `vi.setSystemTime`: the repository's
 * frozen clock is at `2026-07-01T00:00:00.000Z`, which is outside the window.
 * Pinning a different fixed instant in a suite's own hook is the documented way
 * to do that (`docs/TESTING.md`), and it is not an opt-out from the freeze.
 */

/** Inside the three-day window, and the same club date as the frozen clock. */
const PINNED_NOW = "2026-07-01T10:30:00.000Z";
/** 22:30 NZ on 16 Apr 2026 — a real instant, as the DTO carries it. */
const EVENT_STARTS_AT = "2026-04-16T10:30:00.000Z";

function makeEvent(overrides: Partial<CalendarEventDTO> = {}): CalendarEventDTO {
  return {
    id: "evt-1",
    title: "Committee meeting",
    location: null,
    details: null,
    allDay: false,
    startsAt: EVENT_STARTS_AT,
    endsAt: null,
    isMeeting: false,
    seriesId: null,
    detachedFromSeries: false,
    recurrence: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderInClubZone(ui: ReactElement, zone: ClubTimeZone) {
  return render(<ClubTimeProvider zone={zone}>{ui}</ClubTimeProvider>);
}

describe("CalendarView opens on the CLUB's month", () => {
  let zone: ClubTimeZone;
  let expectedHeading: string;
  let environmentHeading: string;
  let hostHeading: string;

  beforeEach(() => {
    vi.setSystemTime(new Date(PINNED_NOW));
    const chosen = divergentClubZone((z) =>
      formatClubMonthYear(startOfCalendarMonth(clubToday(z))),
    );
    zone = chosen.zone;
    expectedHeading = chosen.expected;
    environmentHeading = chosen.environmentAnswer;
    hostHeading = chosen.hostAnswer;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  it("titles the month from the club's today, not the browser's", async () => {
    renderInClubZone(<CalendarView canManage={false} />, zone);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 2 }).textContent,
      ).toBe(expectedHeading);
    });
    // The two wrong answers really are different headings on this frozen clock,
    // so the assertion above is discriminating rather than a coincidence.
    expect(expectedHeading).not.toBe(environmentHeading);
    expect(expectedHeading).not.toBe(hostHeading);
  });

  it("asks the API for the club's own grid window", async () => {
    renderInClubZone(<CalendarView canManage={false} />, zone);
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });
    const url = new URL(
      vi.mocked(fetch).mock.calls[0][0] as string,
      "https://example.test",
    );
    const grid = buildMonthGrid(startOfCalendarMonth(clubToday(zone)));
    expect(url.searchParams.get("from")).toBe(
      startOfClubDay(grid[0], zone).toISOString(),
    );
    expect(url.searchParams.get("to")).toBe(
      new Date(
        endOfClubDayExclusive(grid[grid.length - 1], zone).getTime() - 1,
      ).toISOString(),
    );
  });
});

describe("EventDialog reads and writes CLUB civil time", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(PINNED_NOW));
  });

  it("defaults a new event's date to the club's today", () => {
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (z) => clubToday(z) as string,
    );
    renderInClubZone(
      <EventDialog
        open
        onOpenChange={vi.fn()}
        event={null}
        initialDate={null}
        canCreate
        canManage
        canEditExisting
        onSaved={vi.fn()}
      />,
      zone,
    );
    const dateInput = screen.getByLabelText(/^Date/i) as HTMLInputElement;
    expect(dateInput.value).toBe(expected);
    expect(dateInput.value).not.toBe(environmentAnswer);
    expect(dateInput.value).not.toBe(hostAnswer);
    // The pinned clock really is the instant this is derived from, so the three
    // answers above are the three days that exist at it.
    expect(new Date().toISOString()).toBe(PINNED_NOW);
  });

  it("shows an existing event's date and time as the club reads them", () => {
    const instant = requireInstant(EVENT_STARTS_AT);
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (z) => {
        const wall = clubWallTimeOf(instant, z);
        return {
          date: wall.date as string,
          time: `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`,
        };
      },
    );
    renderInClubZone(
      <EventDialog
        open
        onOpenChange={vi.fn()}
        event={makeEvent()}
        initialDate={null}
        canCreate
        canManage
        canEditExisting
        onSaved={vi.fn()}
      />,
      zone,
    );
    const dateInput = screen.getByLabelText(/^Date/i) as HTMLInputElement;
    const startInput = screen.getByLabelText(/^Start time/i) as HTMLInputElement;
    expect({ date: dateInput.value, time: startInput.value }).toEqual(expected);
    expect({ date: dateInput.value, time: startInput.value }).not.toEqual(
      environmentAnswer,
    );
    expect({ date: dateInput.value, time: startInput.value }).not.toEqual(
      hostAnswer,
    );
  });

  it("heads the read-only view with the club's day and time", () => {
    const instant = requireInstant(EVENT_STARTS_AT);
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (z) => formatClubInstantTime(instant, z),
    );
    renderInClubZone(
      <EventDialog
        open
        onOpenChange={vi.fn()}
        event={makeEvent()}
        initialDate={null}
        canCreate={false}
        canManage={false}
        canEditExisting={false}
        onSaved={vi.fn()}
      />,
      zone,
    );
    const description = screen.getByText(/Committee meeting/i)
      .closest("[role=dialog]")!
      .textContent!;
    expect(description).toContain(expected);
    expect(expected).not.toBe(environmentAnswer);
    expect(expected).not.toBe(hostAnswer);
  });
});

/**
 * The WIRING of the gap-tolerant end resolver, which the unit tests for
 * `isoEndFromDateTimeInputs` cannot reach.
 *
 * A correctness lens found that both ends of a time inside a spring-forward gap
 * resolved to the same instant, so the event was stored zero-length. The helper
 * that fixes it is unit-tested in `calendar-client-club-time.test.ts`; this
 * asserts the dialog actually calls it, by reading the body it POSTs. Without
 * this, swapping the dialog back to the naive resolver is invisible.
 *
 * The club zone is PINNED, because the property is "this zone's clocks jump over
 * 02:00 on this date". The premise is asserted rather than assumed.
 */
describe("EventDialog does not store a zero-length event inside a DST gap", () => {
  const CLUB = requireClubTimeZone("Pacific/Auckland");
  const GAP_DAY = "2026-09-27";

  it("posts an end thirty minutes after the start for a 02:00-02:30 event", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();

    renderInClubZone(
      <EventDialog
        open
        onOpenChange={vi.fn()}
        event={null}
        initialDate={requireCalendarDate(GAP_DAY)}
        canCreate
        canManage
        canEditExisting
        onSaved={onSaved}
      />,
      CLUB,
    );

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Clocks-forward meeting" },
    });
    fireEvent.change(screen.getByLabelText(/^Start time/i), {
      target: { value: "02:00" },
    });
    fireEvent.change(screen.getByLabelText(/^End time/i), {
      target: { value: "02:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { startsAt: string; endsAt: string };

    // The premise: 02:00 and 02:30 do not exist on this day in this zone, so a
    // naive resolution really would have collapsed them onto one instant.
    expect(
      clubWallTimeOf(requireInstant(body.startsAt), CLUB).hour,
      "02:00 resolved to something other than the transition instant — check the tz data still puts New Zealand's spring-forward on 2026-09-27",
    ).toBe(3);
    expect(body.endsAt).not.toBe(body.startsAt);
    expect(
      (requireInstant(body.endsAt).getTime() -
        requireInstant(body.startsAt).getTime()) /
        60000,
    ).toBe(30);
  });
});

describe("the grid and the day list time events in the club's zone", () => {
  const instant = requireInstant(EVENT_STARTS_AT);

  it("labels a month-grid chip with the club's time", () => {
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (z) => formatClubInstantTime(instant, z),
    );
    const day = clubWallTimeOf(instant, zone).date;
    renderInClubZone(
      <MonthCalendar
        monthStart={startOfCalendarMonth(day)}
        eventsByDay={new Map([[day, [makeEvent()]]])}
        canCreate={false}
        onSelectEvent={vi.fn()}
        onSelectDay={vi.fn()}
        onOpenDay={vi.fn()}
      />,
      zone,
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(environmentAnswer)).not.toBeInTheDocument();
    expect(screen.queryByText(hostAnswer)).not.toBeInTheDocument();
  });

  it("labels a day-detail row with the club's time", () => {
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (z) => formatClubInstantTime(instant, z),
    );
    const day = clubWallTimeOf(instant, zone).date;
    renderInClubZone(
      <DayEventsDialog
        open
        onOpenChange={vi.fn()}
        dayKey={day}
        events={[makeEvent()]}
        canCreate={false}
        onSelectEvent={vi.fn()}
        onCreate={vi.fn()}
      />,
      zone,
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(environmentAnswer)).not.toBeInTheDocument();
    expect(screen.queryByText(hostAnswer)).not.toBeInTheDocument();
  });
});
