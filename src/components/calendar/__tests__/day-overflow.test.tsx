// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import { requireCalendarDate } from "@/lib/club-time";
import { MonthCalendar } from "../month-calendar";
import { DayEventsDialog } from "../day-events-dialog";

const AUGUST = requireCalendarDate("2026-08-01");
const DAY = requireCalendarDate("2026-08-15"); // a Saturday in the August grid

function makeEvent(n: number): CalendarEventDTO {
  return {
    id: `evt-${n}`,
    title: `Event ${n}`,
    location: null,
    details: null,
    allDay: false,
    startsAt: `2026-08-15T0${n}:00:00.000Z`,
    endsAt: null,
    isMeeting: false,
    seriesId: null,
    detachedFromSeries: false,
    recurrence: null,
  };
}

const fiveEvents = [1, 2, 3, 4, 5].map(makeEvent);

afterEach(cleanup);

describe("MonthCalendar '+N more' overflow", () => {
  function renderGrid(canCreate: boolean) {
    const onOpenDay = vi.fn();
    const onSelectDay = vi.fn();
    render(
      <MonthCalendar
        monthStart={AUGUST}
        eventsByDay={new Map([[DAY, fiveEvents]])}
        canCreate={canCreate}
        onSelectEvent={vi.fn()}
        onSelectDay={onSelectDay}
        onOpenDay={onOpenDay}
      />,
    );
    return { onOpenDay, onSelectDay };
  }

  it("renders 3 chips and a '+2 more' overflow control", () => {
    renderGrid(false);
    expect(screen.getByText("Event 1")).toBeInTheDocument();
    expect(screen.getByText("Event 2")).toBeInTheDocument();
    expect(screen.getByText("Event 3")).toBeInTheDocument();
    // The 4th/5th are not rendered as chips…
    expect(screen.queryByText("Event 4")).not.toBeInTheDocument();
    // …but the overflow control is present.
    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });

  it("opens the day-detail (not create) for an ordinary member", () => {
    const { onOpenDay, onSelectDay } = renderGrid(false);
    screen.getByRole("button", { name: /Show all 5 events/i }).click();
    expect(onOpenDay).toHaveBeenCalledWith(DAY);
    expect(onSelectDay).not.toHaveBeenCalled();
  });

  it("opens the day-detail (not the create form) for a manager too", () => {
    const { onOpenDay, onSelectDay } = renderGrid(true);
    screen.getByRole("button", { name: /Show all 5 events/i }).click();
    expect(onOpenDay).toHaveBeenCalledWith(DAY);
    expect(onSelectDay).not.toHaveBeenCalled();
  });

  it("gives managers a keyboard-focusable, labelled per-day Add button", () => {
    const { onSelectDay } = renderGrid(true);
    // The 15th falls in the rendered month; its Add control is labelled with the
    // full date so screen-reader and keyboard users can create on that day.
    const add = screen.getByRole("button", {
      name: /Add event on .*15 August 2026/i,
    });
    add.click();
    expect(onSelectDay).toHaveBeenCalledWith(DAY);
  });

  it("shows no Add buttons to an ordinary member", () => {
    renderGrid(false);
    expect(
      screen.queryByRole("button", { name: /Add event on/i }),
    ).not.toBeInTheDocument();
  });
});

describe("DayEventsDialog", () => {
  function renderDialog(canCreate: boolean) {
    const onSelectEvent = vi.fn();
    const onCreate = vi.fn();
    render(
      <DayEventsDialog
        open
        onOpenChange={vi.fn()}
        dayKey={DAY}
        events={fiveEvents}
        canCreate={canCreate}
        onSelectEvent={onSelectEvent}
        onCreate={onCreate}
      />,
    );
    return { onSelectEvent, onCreate };
  }

  it("lists every event on the day, including the 4th and 5th", () => {
    renderDialog(false);
    for (const n of [1, 2, 3, 4, 5]) {
      expect(screen.getByText(`Event ${n}`)).toBeInTheDocument();
    }
  });

  it("hides 'Add event' from an ordinary member", () => {
    renderDialog(false);
    expect(
      screen.queryByRole("button", { name: /Add event/i }),
    ).not.toBeInTheDocument();
  });

  it("offers 'Add event' to a manager and selecting an event opens its detail", () => {
    const { onSelectEvent, onCreate } = renderDialog(true);
    screen.getByRole("button", { name: /Add event/i }).click();
    expect(onCreate).toHaveBeenCalledWith(DAY);

    screen.getByText("Event 4").click();
    expect(onSelectEvent).toHaveBeenCalledWith(fiveEvents[3]);
  });
});
