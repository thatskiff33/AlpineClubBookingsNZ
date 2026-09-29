// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDaysToDateKey,
  buildWeekDateKeys,
  getWeekStartDateKey,
  KioskWeekView,
  weekHasAccessibleDay,
  type KioskWeekDaySummary,
} from "../kiosk-week-view";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

const weekDays: KioskWeekDaySummary[] = [
  {
    date: "2026-04-13",
    accessible: true,
    guestCount: 2,
    arrivingCount: 1,
    departingCount: 0,
    rosterStatus: "needs-roster",
  },
  {
    date: "2026-04-14",
    accessible: true,
    guestCount: 3,
    arrivingCount: 1,
    departingCount: 1,
    rosterStatus: "confirmed",
  },
  { date: "2026-04-15", accessible: false },
  { date: "2026-04-16", accessible: false },
  { date: "2026-04-17", accessible: false },
  { date: "2026-04-18", accessible: false },
  { date: "2026-04-19", accessible: false },
];

describe("KioskWeekView", () => {
  it("renders clamped week controls and drills into accessible days only", () => {
    const onSelectDate = vi.fn();
    const onChangeWeek = vi.fn();

    render(
      <KioskWeekView
        days={weekDays}
        weekStart="2026-04-13"
        todayDate="2026-04-14"
        selectedDate="2026-04-13"
        lodgeName="Whakapapa"
        readOnly={false}
        refreshing={false}
        canGoToPreviousWeek={false}
        canGoToNextWeek={true}
        onSelectDate={onSelectDate}
        onChangeWeek={onChangeWeek}
        onToday={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: "Week View" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous week" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next week" })).toBeEnabled();
    expect(screen.getByLabelText("Wednesday, 15 April outside access")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(onChangeWeek).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByRole("button", { name: "Open Tuesday, 14 April" }));
    expect(onSelectDate).toHaveBeenCalledWith("2026-04-14");
    expect(
      screen.queryByRole("button", { name: "Open Wednesday, 15 April" })
    ).not.toBeInTheDocument();
  });

  it("calculates Monday week starts and accessible week navigation", () => {
    expect(getWeekStartDateKey("2026-04-15")).toBe("2026-04-13");
    expect(
      weekHasAccessibleDay("2026-04-13", {
        minDate: "2026-04-14",
        maxDate: "2026-04-16",
      })
    ).toBe(true);
    expect(
      weekHasAccessibleDay("2026-04-20", {
        minDate: "2026-04-14",
        maxDate: "2026-04-16",
      })
    ).toBe(false);
  });
});

/*
  #2474 — the day-stepping SEAM lives here, so its contract does too.

  The kiosk page moved its day arrows off a local-midnight `Date` round trip and
  onto these helpers. That switch is deliberately invisible from the page: the
  old round trip wrote and read with the same local getters, so it agreed with
  this arithmetic on every DST transition, month end and year end in every IANA
  zone (swept 2008-2030 — the only divergence in the whole space is the 2011
  Samoa dateline skip). A page-level test therefore cannot guard it, and the
  suite in `__tests__/kiosk-page-week.test.tsx` says so rather than pretending
  otherwise.

  What CAN be guarded is the arithmetic itself: that it rolls the month, the
  year and a leap day, and that it does not depend on the display device's zone.
  The realistic way to break it is a rewrite that mixes local and UTC accessors
  (`new Date(key)` mutated with `setDate` but read with `getUTCDate`), which is
  correct on a UTC CI runner and wrong on the tablet — hence the zone sweep.
*/
describe("kiosk date-key arithmetic (#2474)", () => {
  // Node applies a zone when TZ is ASSIGNED and keeps it once the variable is
  // removed, so restoring means assigning the resolved starting zone back
  // first, then deleting the variable (#2485).
  const hostTimeZone = captureHostTimeZone();

  afterEach(() => {
    hostTimeZone.restore();
  });

  it("steps date keys across month, year and leap-day boundaries", () => {
    const cases: Array<[string, number, string]> = [
      ["2026-07-31", 1, "2026-08-01"],
      ["2026-08-01", -1, "2026-07-31"],
      ["2026-02-28", 1, "2026-03-01"],
      ["2026-03-01", -1, "2026-02-28"],
      ["2028-02-28", 1, "2028-02-29"],
      ["2028-03-01", -1, "2028-02-29"],
      ["2026-12-31", 1, "2027-01-01"],
      ["2027-01-01", -1, "2026-12-31"],
      ["2026-07-31", 7, "2026-08-07"],
      ["2026-08-07", -7, "2026-07-31"],
    ];

    for (const [from, days, expected] of cases) {
      expect(addDaysToDateKey(from, days), `${from} ${days >= 0 ? "+" : ""}${days}`).toBe(
        expected
      );
    }
  });

  it("gives the same keys whatever zone the display device is in", () => {
    for (const zone of [
      "UTC",
      "Pacific/Auckland",
      "America/Los_Angeles",
      "Pacific/Chatham",
      "Asia/Kolkata",
    ]) {
      process.env.TZ = zone;

      expect(addDaysToDateKey("2026-07-31", 1), zone).toBe("2026-08-01");
      expect(addDaysToDateKey("2026-08-01", -1), zone).toBe("2026-07-31");
      expect(getWeekStartDateKey("2026-08-01"), zone).toBe("2026-07-27");
      expect(buildWeekDateKeys("2026-07-27").at(-1), zone).toBe("2026-08-02");
    }
  });
});
