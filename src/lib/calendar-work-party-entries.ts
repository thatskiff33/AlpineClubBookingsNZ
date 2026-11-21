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
import {
  startOfClubDay,
  type CalendarDate,
  type ClubTimeZone,
} from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";

/**
 * The ONE lock every writer of a work party's calendar entries takes first
 * (#5148): the existing calendar-series advisory lock with a `work-party:` key,
 * so it shares no keyspace with a real series and composes with no booking,
 * money or capacity key. The create, edit, delete and "Add to calendar" paths
 * all take it before touching the work party or its entries; the edit and the
 * delete also update or delete the work party row in the same transaction,
 * after the lock, so every path orders the advisory lock before the row lock.
 */
export async function lockWorkPartyCalendar(
  tx: Prisma.TransactionClient,
  workPartyEventId: string,
): Promise<void> {
  await lockCalendarSeries(tx, `work-party:${workPartyEventId}`);
}

/**
 * What a work party puts on the calendar (#5148): one all-day entry per
 * club day in `days`, which the caller derives from the work party's date-only
 * window. More than one day is stored as a daily series so the entries move
 * together; one day is a standalone entry.
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
 * Delete every entry linked to the work party, then any series those entries
 * belonged to that is now empty. The caller holds the work-party lock.
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
  await lockWorkPartyCalendar(tx, workPartyEventId);
  const linked = await tx.calendarEvent.findMany({
    where: { workPartyEventId },
    select: { seriesId: true },
  });
  await clearLinkedEntries(tx, workPartyEventId, linked);
}

/**
 * Replace every calendar entry linked to a work party with the entry
 * `resolveEntry` builds, or remove them all when it builds none, inside the
 * caller's transaction. With `replaceWorkPartyCalendarEvents` below, the ONE
 * writer of `CalendarEvent.workPartyEventId` (#5148): the work-party routes
 * call it on create, edit, delete and "Add to calendar", and the calendar's
 * own edit and delete refuse linked entries, so the two cannot drift.
 *
 * Delete-and-recreate rather than an in-place edit: a work party's dates can
 * move in either direction and the entries carry nothing of their own (no
 * meeting room, no per-occurrence exception), so regenerating is the honest
 * shape. It takes `lockWorkPartyCalendar` first (re-entrant, so a caller that
 * already holds it, like the edit, loses nothing), so two officers saving the
 * same work party cannot interleave and duplicate its entries. A window is
 * capped at MAX_OCCURRENCES nights, the calendar's own series limit: the
 * work-party form refuses new dates longer than that
 * (`workPartyEventDatesError`), and a work party saved longer before the cap
 * shows its first MAX_OCCURRENCES nights.
 *
 * `resolveEntry` is called after the lock, so the entries are built from the
 * work party as it is now rather than from a caller's earlier read; null means
 * "no entries" (deleted or removed). `onlyIfLinked` leaves a work party with
 * no entries alone — the edit path, which must not add one that was never on
 * the calendar. `zone` is the club's zone, resolved by the caller BEFORE its
 * transaction opens.
 *
 * Returns the number of entries now linked.
 */
export async function replaceWorkPartyCalendarEventsInTransaction(
  tx: Prisma.TransactionClient,
  workPartyEventId: string,
  resolveEntry: WorkPartyCalendarEntryResolver,
  actorId: string,
  zone: ClubTimeZone,
  options: { onlyIfLinked?: boolean } = {},
): Promise<number> {
  await lockWorkPartyCalendar(tx, workPartyEventId);
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
}

/**
 * `replaceWorkPartyCalendarEventsInTransaction` in a transaction of its own:
 * the create and "Add to calendar" paths, which run after the work party is
 * saved.
 */
export async function replaceWorkPartyCalendarEvents(
  workPartyEventId: string,
  resolveEntry: WorkPartyCalendarEntryResolver,
  actorId: string,
): Promise<number> {
  const zone = await clubTimeZone();
  return prisma.$transaction((tx) =>
    replaceWorkPartyCalendarEventsInTransaction(
      tx,
      workPartyEventId,
      resolveEntry,
      actorId,
      zone,
    ),
  );
}
