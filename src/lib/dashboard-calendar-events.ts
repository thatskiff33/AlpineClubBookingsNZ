import { prisma } from "@/lib/prisma";
import {
  showsWorkPartyCalendarEntries,
  whereVisibleCalendarEvent,
  type CalendarViewer,
} from "@/lib/calendar-events";

/** How many lines the dashboard's Events card lists. */
export const DASHBOARD_EVENTS_CARD_LIMIT = 6;

/** One line of the dashboard's Events card. */
export type DashboardCalendarEvent = {
  id: string;
  title: string;
  startsAt: Date;
  allDay: boolean;
  isMeeting: boolean;
  workPartyEventId: string | null;
};

const DASHBOARD_EVENT_SELECT = {
  id: true,
  title: true,
  startsAt: true,
  allDay: true,
  isMeeting: true,
  workPartyEventId: true,
} as const;

/**
 * The dashboard's Events card (#5148): the next calendar events in a window,
 * one line per event.
 *
 * A work party is stored as one calendar row per night, so its rows collapse
 * to ONE line, its first night in the window; otherwise a week-long work party
 * would fill the card and push out the other events. Ordinary events and work
 * party rows are read separately (both through `whereVisibleCalendarEvent`,
 * so a non-member never gets a work party row; the work-party read is skipped
 * outright when the rule admits none), then merged by start time and cut to
 * `limit`. The work-party read is bounded by the window: at most one row
 * per night for each work party.
 */
export async function listDashboardCalendarEvents({
  from,
  to,
  modules,
  viewer,
  limit = DASHBOARD_EVENTS_CARD_LIMIT,
}: {
  from: Date;
  to: Date;
  modules: { workParties: boolean };
  viewer: CalendarViewer;
  limit?: number;
}): Promise<DashboardCalendarEvent[]> {
  const window = { startsAt: { gte: from, lte: to } };
  const context = { modules, viewer };
  const [ordinary, workPartyNights] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: whereVisibleCalendarEvent(
        { ...window, workPartyEventId: null },
        context,
      ),
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: limit,
      select: DASHBOARD_EVENT_SELECT,
    }),
    // Skipped when the rule would admit no work party row at all.
    showsWorkPartyCalendarEntries(context)
      ? prisma.calendarEvent.findMany({
          where: whereVisibleCalendarEvent(
            { ...window, workPartyEventId: { not: null } },
            context,
          ),
          orderBy: [{ startsAt: "asc" }, { id: "asc" }],
          select: DASHBOARD_EVENT_SELECT,
        })
      : Promise.resolve([]),
  ]);
  return mergeDashboardCalendarEvents(ordinary, workPartyNights, limit);
}

/**
 * Keep each work party's earliest night, merge with the ordinary events by
 * start time (an ordinary event first on a tie) and keep `limit`. Both inputs
 * arrive sorted by start time.
 */
export function mergeDashboardCalendarEvents(
  ordinary: DashboardCalendarEvent[],
  workPartyNights: DashboardCalendarEvent[],
  limit: number,
): DashboardCalendarEvent[] {
  const seen = new Set<string>();
  const firstNights: DashboardCalendarEvent[] = [];
  for (const night of workPartyNights) {
    const key = night.workPartyEventId ?? night.id;
    if (seen.has(key)) continue;
    seen.add(key);
    firstNights.push(night);
  }
  return [...ordinary, ...firstNights]
    .map((event, order) => ({ event, order }))
    .sort(
      (a, b) =>
        a.event.startsAt.getTime() - b.event.startsAt.getTime() ||
        a.order - b.order,
    )
    .slice(0, limit)
    .map(({ event }) => event);
}
