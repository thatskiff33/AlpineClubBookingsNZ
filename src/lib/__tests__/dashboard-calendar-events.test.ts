import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dashboard's Events card read (#5148): a work party is stored as one
 * calendar row per night, and the card shows it as ONE line, its first night
 * in the window, merged with the ordinary events by start time.
 */

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { calendarEvent: { findMany: mocks.findMany } },
}));

import {
  listDashboardCalendarEvents,
  mergeDashboardCalendarEvents,
  type DashboardCalendarEvent,
} from "@/lib/dashboard-calendar-events";

const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const MEMBER = { accessRoles: ["USER"], role: "USER", canLogin: true };
const NON_MEMBER = { accessRoles: [], role: "NON_MEMBER", canLogin: true };

function row(
  id: string,
  startsAt: string,
  workPartyEventId: string | null = null,
): DashboardCalendarEvent {
  return {
    id,
    title: workPartyEventId ? `Work party: ${workPartyEventId}` : id,
    startsAt: at(startsAt),
    allDay: true,
    isMeeting: false,
    workPartyEventId,
  };
}

const window = { from: at("2026-07-01"), to: at("2026-07-15") };

beforeEach(() => {
  mocks.findMany.mockReset();
});

describe("listDashboardCalendarEvents", () => {
  it("shows a multi-night work party once, on its first night, beside an ordinary event", async () => {
    mocks.findMany
      .mockResolvedValueOnce([row("meeting", "2026-07-04")])
      .mockResolvedValueOnce([
        row("wp-a-1", "2026-07-02", "wp-a"),
        row("wp-a-2", "2026-07-03", "wp-a"),
        row("wp-a-3", "2026-07-04", "wp-a"),
        row("wp-a-4", "2026-07-05", "wp-a"),
      ]);

    const lines = await listDashboardCalendarEvents({
      ...window,
      modules: { workParties: true },
      viewer: MEMBER,
    });

    expect(lines.map((line) => line.id)).toEqual(["wp-a-1", "meeting"]);
    // Ordinary events and work party rows are read apart, each through the
    // visibility rule, and only the ordinary read is capped in the database.
    const [ordinary, linked] = mocks.findMany.mock.calls.map(([args]) => args);
    expect(ordinary.where.workPartyEventId).toBeNull();
    expect(ordinary.take).toBe(6);
    expect(ordinary.where.AND).toHaveLength(1);
    expect(linked.where.workPartyEventId).toEqual({ not: null });
    expect(linked.take).toBeUndefined();
    expect(linked.where.AND).toEqual([
      {
        OR: [
          { workPartyEventId: null },
          {
            workPartyEvent: {
              active: true,
              promoCode: { active: true, archivedAt: null },
            },
          },
        ],
      },
    ]);
  });

  it.each([
    ["a non-member", { workParties: true }, NON_MEMBER],
    ["a member with the module off", { workParties: false }, MEMBER],
  ])("reads no work party row for %s", async (_label, modules, viewer) => {
    mocks.findMany.mockResolvedValueOnce([row("meeting", "2026-07-04")]);

    const lines = await listDashboardCalendarEvents({ ...window, modules, viewer });

    expect(lines.map((line) => line.id)).toEqual(["meeting"]);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0][0].where.AND).toEqual([
      { workPartyEventId: null },
    ]);
  });
});

describe("mergeDashboardCalendarEvents", () => {
  it("keeps six lines in start order, two work parties one line each", () => {
    const ordinary = [
      row("e1", "2026-07-03"),
      row("e2", "2026-07-06"),
      row("e3", "2026-07-08"),
      row("e4", "2026-07-09"),
      row("e5", "2026-07-12"),
    ];
    const nights = [
      row("a1", "2026-07-02", "wp-a"),
      row("a2", "2026-07-03", "wp-a"),
      row("b1", "2026-07-07", "wp-b"),
      row("a3", "2026-07-07", "wp-a"),
      row("b2", "2026-07-08", "wp-b"),
    ];

    expect(
      mergeDashboardCalendarEvents(ordinary, nights, 6).map((line) => line.id),
    ).toEqual(["a1", "e1", "e2", "b1", "e3", "e4"]);
  });

  it("puts an ordinary event first when it starts at the same moment", () => {
    expect(
      mergeDashboardCalendarEvents(
        [row("meeting", "2026-07-02")],
        [row("a1", "2026-07-02", "wp-a")],
        6,
      ).map((line) => line.id),
    ).toEqual(["meeting", "a1"]);
  });
});
