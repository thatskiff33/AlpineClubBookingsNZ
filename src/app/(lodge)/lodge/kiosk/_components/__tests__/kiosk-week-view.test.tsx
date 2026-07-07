// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  getWeekStartDateKey,
  KioskWeekView,
  weekHasAccessibleDay,
  type KioskWeekDaySummary,
} from "../kiosk-week-view";

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
