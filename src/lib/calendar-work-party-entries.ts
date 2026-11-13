import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MAX_OCCURRENCES } from "@/lib/calendar-recurrence";
import {
  buildOccurrenceRows,
  buildSeriesRow,
  buildStandaloneEventRow,
  type ResolvedEventData,
} from "@/lib/calendar-occurrences";
import { lockCalendarSeries } from "@/lib/calendar-service";
import { startOfClubDay, type CalendarDate } from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";

/**
 * What a work party puts on the calendar (fork #118): one all-day entry per
 * club day in `days`, which the caller derives from the work party's date-only
 * window. More than one day is stored as a daily series so the calendar shows
 * the ↻ marker and the entries move together; one day is a standalone entry.
 */
export interface WorkPartyCalendarEntry {
  title: string;
  location: string | null;
  details: string | null;
  days: CalendarDate[];
}

/** Builds the entry inside the writer's transaction; null = no entries. */
export type WorkPartyCalendarEntryResolver = (
  tx: Prisma.TransactionClient,
) => Promise<WorkPartyCalendarEntry | null>;

/**
 * Replace every calendar entry linked to a work party with the entry
 * `resolveEntry` builds, or remove them all when it builds none. The ONE writer of
 * `CalendarEvent.workPartyEventId` (fork #118): the work-party routes call it
 * on create, edit, delete and "Add to calendar", and the calendar's own edit
 * and delete refuse linked entries, so the two cannot drift.
 *
 * Delete-and-recreate rather than an in-place edit: a work party's dates can
 * move in either direction and the entries carry nothing of their own (no
 * meeting room, no per-occurrence exception), so regenerating is the honest
 * shape. It runs in one transaction under the existing calendar-series lock
 * with a `work-party:` key, so two officers saving the same work party cannot
 * interleave and duplicate its entries. Capped at MAX_OCCURRENCES days, the
 * calendar's own series limit.
 *
 * `resolveEntry` is called inside the transaction, after the lock, so the
 * entries are built from the work party as it is now rather than from a
 * caller's earlier read; null means "no entries" (deleted or removed).
 * `onlyIfLinked` leaves a work party with no entries alone — the edit path,
 * which must not add one that was never on the calendar.
 *
 * Returns the number of entries now linked.
 */
async function clearLinkedEntries(
  tx: Prisma.TransactionClient,
  workPartyEventId: string,
  linked: ReadonlyArray<{ seriesId: string | null }>,
): Promise<void> {
  const seriesIds = [
    ...new Set(
      linked
        .map((row) => row.seriesId)
        .filter((id): id is string => id !== null),
    ),
  ];
  await tx.calendarEvent.deleteMany({ where: { workPartyEventId } });
  if (seriesIds.length > 0) {
    await tx.calendarEventSeries.deleteMany({
      where: { id: { in: seriesIds }, events: { none: {} } },
    });
  }
}

/**
 * Remove a work party's entries and their emptied series INSIDE the caller's
 * transaction, under the same lock — the work-party delete, so the entries and
 * the work party go together or not at all. A racing "Add to calendar" waits
 * on the lock, then re-reads the work party, finds it gone and writes nothing.
 */
export async function removeWorkPartyCalendarEventsInTransaction(
  tx: Prisma.TransactionClient,
  workPartyEventId: string,
): Promise<void> {
  await lockCalendarSeries(tx, `work-party:${workPartyEventId}`);
  const linked = await tx.calendarEvent.findMany({
    where: { workPartyEventId },
    select: { seriesId: true },
  });
  await clearLinkedEntries(tx, workPartyEventId, linked);
}

export async function replaceWorkPartyCalendarEvents(
  workPartyEventId: string,
  resolveEntry: WorkPartyCalendarEntryResolver,
  actorId: string,
  options: { onlyIfLinked?: boolean } = {},
): Promise<number> {
  const zone = await clubTimeZone();
  return prisma.$transaction(async (tx) => {
    await lockCalendarSeries(tx, `work-party:${workPartyEventId}`);
    const linked = await tx.calendarEvent.findMany({
      where: { workPartyEventId },
      select: { seriesId: true },
    });
    if (options.onlyIfLinked && linked.length === 0) return 0;
    // Read the work party AFTER the lock: of two saves racing, the one that
    // writes last also reads last, so the entries always match the newest row.
    const entry = await resolveEntry(tx);
    await clearLinkedEntries(tx, workPartyEventId, linked);
    if (!entry) return 0;

    const starts = entry.days
      .slice(0, MAX_OCCURRENCES)
      .map((day) => startOfClubDay(day, zone));
    const [firstStart] = starts;
    if (!firstStart) return 0;
    const template: ResolvedEventData = {
      title: entry.title,
      location: entry.location,
      details: entry.details,
      allDay: true,
      isMeeting: false,
      startsAt: firstStart,
      endsAt: null,
      recurrence: null,
    };

    if (starts.length === 1) {
      await tx.calendarEvent.create({
        data: { ...buildStandaloneEventRow(template, actorId), workPartyEventId },
      });
      return 1;
    }

    const series = await tx.calendarEventSeries.create({
      data: buildSeriesRow(
        { frequency: "DAILY", interval: 1, endMode: "count", count: starts.length },
        actorId,
      ),
    });
    const rows = buildOccurrenceRows(starts, template, series.id, actorId).map(
      (row) => ({ ...row, workPartyEventId }),
    );
    await tx.calendarEvent.createMany({ data: rows });
    return rows.length;
  });
}
