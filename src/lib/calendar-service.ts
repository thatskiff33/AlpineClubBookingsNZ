import { randomUUID } from "crypto";
import type { CalendarEvent, CalendarEventSeries, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import type { CalendarEditScope } from "@/lib/calendar-events";
import {
  generateOccurrenceStarts,
  type RecurrenceRule,
} from "@/lib/calendar-recurrence";
import {
  buildOccurrenceRows,
  clubDayKey,
  durationMsOf,
  nextMeetingRoom,
  seriesCount,
  seriesMatchesRule,
  seriesUntil,
  withClubTimeOfDay,
  type ResolvedEventData,
} from "@/lib/calendar-occurrences";
import type { ClubTimeZone } from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";

/**
 * A Prisma "record required but not found" error (P2025). Thrown by
 * `update`/`delete` on a row a concurrent admin has already removed; the calling
 * mutation treats it as "already gone" and returns null so the route 404s.
 * Matches the codebase's code-based detection (see src/lib/prisma-errors.ts).
 */
function isRecordNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2025",
  );
}

/**
 * Calendar create / update / delete, including recurrence materialisation and
 * the single-occurrence vs whole-series edit semantics (#calendar-recurring).
 *
 * A recurring event is stored as one CalendarEvent row per occurrence, sharing
 * a CalendarEventSeries. Editing scope:
 *  - "single": only the clicked occurrence changes; if it belonged to a series
 *    it is marked detachedFromSeries so later series edits/deletes skip it.
 *  - "series": applies to every NON-detached occurrence. Detail/time-only
 *    changes are propagated in place (each occurrence keeps its own date);
 *    changing the recurrence pattern (or the anchor date) regenerates the whole
 *    series from the edited occurrence, preserving detached exceptions.
 *
 * ## Where the club's timezone comes from, and where the reasoning lives
 *
 * `calendar-occurrences.ts` is this file's other half — the occurrence row shape
 * and the two club-time questions that decide it — and its module docblock is
 * the single home for WHY the club's persisted zone rather than the container's
 * `TZ` is the authority here (`INV-CONFIG-002`, CT-4, #2870). Read it before
 * changing anything below that touches a date; it is not restated here, so that
 * the two cannot drift apart.
 *
 * What belongs to THIS file is the resolution and the third question. The zone is
 * resolved ONCE per exported entry point with `clubTimeZone()` (request-memoised)
 * and threaded down as an argument, so no helper can silently reach for a
 * different one — and the third zone-dependent question, whether an edit changed
 * the anchor DAY, is `updateCalendarEvent`'s `dateChanged` comparison. It uses
 * `clubDayKey` from that module rather than its own reading, which is what stops
 * the comparison and the generation disagreeing about what "the same day" is.
 */

/** Prisma client or an interactive-transaction client. */
type Db = typeof prisma | Prisma.TransactionClient;

/**
 * Serialize concurrent whole-series mutations. Without this, two editors saving
 * the same recurring series can interleave their delete-and-regenerate under
 * Read Committed and duplicate or drop occurrences. This is a DOMAIN-KEYED
 * scoped advisory lock (hashtext of a namespaced string, its own keyspace
 * distinct from the per-lodge capacity key), released at transaction end — same
 * family as lockRosterDate / fee-schedule locks. $executeRaw (not $queryRaw):
 * pg_advisory_xact_lock returns void, which the driver adapter cannot
 * deserialize as a result row.
 */
async function lockCalendarSeries(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  seriesId: string,
): Promise<void> {
  const key = `calendar-series:${seriesId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

async function createSeriesRows(
  data: ResolvedEventData & { recurrence: RecurrenceRule },
  actorId: string,
  tx: Db,
  idempotencyKey: string | null,
  zone: ClubTimeZone,
): Promise<CalendarEvent> {
  const series = await tx.calendarEventSeries.create({
    data: {
      frequency: data.recurrence.frequency,
      interval: data.recurrence.interval,
      until: seriesUntil(data.recurrence),
      count: seriesCount(data.recurrence),
      createdById: actorId,
    },
  });

  const starts = generateOccurrenceStarts(
    data.startsAt,
    data.recurrence,
    zone,
  );
  const rows = buildOccurrenceRows(starts, data, series.id, actorId);
  // The idempotency key is a per-CREATE dedup token, so it lives on the anchor
  // (earliest occurrence, rows[0]) ONLY — never on every row (which would
  // collide with itself) and never via buildOccurrenceRows (shared with
  // regenerate, which must not carry a key).
  if (idempotencyKey && rows.length > 0) {
    rows[0] = { ...rows[0], idempotencyKey };
  }
  await tx.calendarEvent.createMany({ data: rows });

  // The anchor is the first (earliest) occurrence — used for the audit log
  // and the API response.
  const anchor = await tx.calendarEvent.findFirst({
    where: { seriesId: series.id },
    orderBy: { startsAt: "asc" },
  });
  // createMany always inserts at least the anchor, so this is non-null; the
  // fallback keeps the type honest.
  return anchor as CalendarEvent;
}

async function createSeriesWithOccurrences(
  data: ResolvedEventData & { recurrence: RecurrenceRule },
  actorId: string,
  zone: ClubTimeZone,
  db: Db = prisma,
  idempotencyKey: string | null = null,
): Promise<CalendarEvent> {
  // Already inside a caller's transaction (e.g. the standalone→series convert),
  // OR a plain create with no dedup key: create the rows directly. In the tx
  // case the outer transaction owns rollback; in the no-key case there is
  // nothing to make atomic beyond the individual writes.
  if (db !== prisma || !idempotencyKey) {
    return createSeriesRows(data, actorId, db, idempotencyKey, zone);
  }

  // Top-level KEYED series create. Wrap in a transaction so a duplicate
  // idempotency key (P2002 on the anchor) rolls back the series + occurrences
  // cleanly, and return the already-created anchor for that key instead of
  // erroring.
  try {
    return await prisma.$transaction((tx) =>
      createSeriesRows(data, actorId, tx, idempotencyKey, zone),
    );
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      const existing = await prisma.calendarEvent.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return existing;
    }
    throw error;
  }
}

/**
 * Create a one-off or recurring event. Returns the (anchor) event.
 *
 * `idempotencyKey` (optional) makes a create dedup-safe: replaying the same key
 * returns the event the first call created instead of inserting a duplicate.
 * The key is stored on a standalone event, or on a series' anchor occurrence.
 */
export async function createCalendarEvent(
  data: ResolvedEventData,
  actorId: string,
  idempotencyKey?: string | null,
): Promise<CalendarEvent> {
  const key = idempotencyKey ?? null;
  if (!data.recurrence) {
    // A one-off event stores the instant it was handed: no calendar arithmetic,
    // so no zone is needed and none is resolved.
    try {
      return await prisma.calendarEvent.create({
        data: {
          title: data.title,
          location: data.location,
          details: data.details,
          allDay: data.allDay,
          startsAt: data.startsAt,
          endsAt: data.endsAt,
          isMeeting: data.isMeeting,
          meetingRoom: data.isMeeting ? randomUUID() : null,
          createdById: actorId,
          idempotencyKey: key,
        },
      });
    } catch (error) {
      if (key && isPrismaUniqueConstraintError(error)) {
        const existing = await prisma.calendarEvent.findUnique({
          where: { idempotencyKey: key },
        });
        if (existing) return existing;
      }
      throw error;
    }
  }
  return createSeriesWithOccurrences(
    { ...data, recurrence: data.recurrence },
    actorId,
    await clubTimeZone(),
    prisma,
    key,
  );
}

type EventWithSeries = CalendarEvent & { series: CalendarEventSeries | null };

/**
 * Returns null when a concurrent admin deleted this occurrence between the
 * caller's existence check and this write (P2025) — the route's documented
 * "already gone" 404, never a 500.
 */
async function updateSingleOccurrence(
  existing: CalendarEvent,
  data: ResolvedEventData,
): Promise<CalendarEvent | null> {
  try {
    return await prisma.calendarEvent.update({
      where: { id: existing.id },
      data: {
        title: data.title,
        location: data.location,
        details: data.details,
        allDay: data.allDay,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        isMeeting: data.isMeeting,
        meetingRoom: nextMeetingRoom(data.isMeeting, existing.meetingRoom),
        // A per-occurrence edit becomes an exception so later series edits skip it.
        detachedFromSeries: existing.seriesId ? true : existing.detachedFromSeries,
      },
    });
  } catch (error) {
    if (isRecordNotFoundError(error)) return null;
    throw error;
  }
}

/**
 * Series edit with the SAME recurrence pattern and anchor day: push the new
 * details + time-of-day onto every non-detached occurrence, keeping each one's
 * own date.
 */
async function propagateSeriesFieldChanges(
  seriesId: string,
  data: ResolvedEventData,
  zone: ClubTimeZone,
): Promise<void> {
  const durationMs = durationMsOf(data.startsAt, data.endsAt);
  // Read + write the occurrence set UNDER the per-series lock (inside the
  // transaction), so a concurrent regenerate cannot delete rows out from under
  // this update. An explicit timeout floor keeps a large series (up to
  // MAX_OCCURRENCES rows) from tripping the 5s interactive-transaction default.
  await prisma.$transaction(
    async (tx) => {
      await lockCalendarSeries(tx, seriesId);
      // Uniform columns are identical for every occurrence → one updateMany,
      // not one round-trip per row. Turning meetings OFF also clears the room
      // here (a null column shared by all rows).
      await tx.calendarEvent.updateMany({
        where: { seriesId, detachedFromSeries: false },
        data: {
          title: data.title,
          location: data.location,
          details: data.details,
          allDay: data.allDay,
          isMeeting: data.isMeeting,
          ...(data.isMeeting ? {} : { meetingRoom: null }),
        },
      });
      // Per-row columns that genuinely differ between occurrences: each keeps
      // its OWN date (start recomputed with the new time-of-day) and end, and a
      // row that is only NOW becoming a meeting needs a fresh room.
      const occurrences = await tx.calendarEvent.findMany({
        where: { seriesId, detachedFromSeries: false },
        select: { id: true, startsAt: true, meetingRoom: true },
      });
      for (const occ of occurrences) {
        const start = withClubTimeOfDay(
          occ.startsAt,
          data.startsAt,
          data.allDay,
          zone,
        );
        const endsAt =
          data.allDay || durationMs == null
            ? null
            : new Date(start.getTime() + durationMs);
        const perRow: Prisma.CalendarEventUpdateInput = { startsAt: start, endsAt };
        if (data.isMeeting && !occ.meetingRoom) {
          perRow.meetingRoom = randomUUID();
        }
        await tx.calendarEvent.update({ where: { id: occ.id }, data: perRow });
      }
    },
    { timeout: 20000 },
  );
}

/**
 * Series edit that CHANGES the pattern (or the anchor day): rewrite the rule and
 * regenerate every non-detached occurrence from the edited occurrence as the new
 * anchor. Detached exceptions are left untouched.
 *
 * Returns false when a concurrent whole-series delete removed the series row
 * before this transaction took the lock (P2025) — the series is already gone,
 * so the caller 404s rather than surfacing a 500. The rollback leaves the
 * occurrences exactly as that delete left them.
 */
async function regenerateSeries(
  series: CalendarEventSeries,
  data: ResolvedEventData & { recurrence: RecurrenceRule },
  actorId: string,
  zone: ClubTimeZone,
): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await lockCalendarSeries(tx, series.id);
      await tx.calendarEventSeries.update({
        where: { id: series.id },
        data: {
          frequency: data.recurrence.frequency,
          interval: data.recurrence.interval,
          until: seriesUntil(data.recurrence),
          count: seriesCount(data.recurrence),
        },
      });
      // E2: capture the room slug of each surviving (non-detached) occurrence,
      // keyed by its start instant, so a regenerated occurrence that lands on
      // the same instant REUSES its room and its already-shared join link keeps
      // working. Only occurrences that actually have a room are carried.
      const surviving = await tx.calendarEvent.findMany({
        where: { seriesId: series.id, detachedFromSeries: false },
        select: { startsAt: true, meetingRoom: true },
      });
      const preservedRooms = new Map<number, string>();
      for (const occ of surviving) {
        if (occ.meetingRoom) {
          preservedRooms.set(occ.startsAt.getTime(), occ.meetingRoom);
        }
      }
      await tx.calendarEvent.deleteMany({
        where: { seriesId: series.id, detachedFromSeries: false },
      });
      const starts = generateOccurrenceStarts(
        data.startsAt,
        data.recurrence,
        zone,
      );
      await tx.calendarEvent.createMany({
        data: buildOccurrenceRows(starts, data, series.id, actorId, preservedRooms),
      });
    });
    return true;
  } catch (error) {
    // A concurrent admin deleted the whole series first: treat as already gone.
    if (isRecordNotFoundError(error)) return false;
    throw error;
  }
}

/**
 * Series edit that turns recurrence OFF: keep the edited occurrence as a
 * standalone event and drop the rest of the series.
 */
async function collapseSeriesToSingle(
  existing: EventWithSeries,
  data: ResolvedEventData,
): Promise<CalendarEvent | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockCalendarSeries(tx, existing.seriesId!);
      // Remove every other occurrence; detach the survivor from the series.
      await tx.calendarEvent.deleteMany({
        where: { seriesId: existing.seriesId!, id: { not: existing.id } },
      });
      const updated = await tx.calendarEvent.update({
        where: { id: existing.id },
        data: {
          title: data.title,
          location: data.location,
          details: data.details,
          allDay: data.allDay,
          startsAt: data.startsAt,
          endsAt: data.endsAt,
          isMeeting: data.isMeeting,
          meetingRoom: nextMeetingRoom(data.isMeeting, existing.meetingRoom),
          seriesId: null,
          detachedFromSeries: false,
        },
      });
      await tx.calendarEventSeries.delete({ where: { id: existing.seriesId! } });
      return updated;
    });
  } catch (error) {
    // A concurrent admin deleted the survivor first: treat as already gone.
    if (isRecordNotFoundError(error)) return null;
    throw error;
  }
}

export interface CalendarUpdateResult {
  anchor: CalendarEvent;
  scope: CalendarEditScope;
}

/**
 * Update an event. `scope` only matters when the event belongs to a series;
 * a standalone event is always edited in place. Returns null when the id is
 * unknown (the route turns that into a 404).
 */
export async function updateCalendarEvent(
  id: string,
  data: ResolvedEventData,
  scope: CalendarEditScope,
  actorId: string,
): Promise<CalendarUpdateResult | null> {
  const existing = (await prisma.calendarEvent.findUnique({
    where: { id },
    include: { series: true },
  })) as EventWithSeries | null;
  if (!existing) return null;

  // One resolution of the club's persisted zone for this whole update, so the
  // day comparison below, the regenerated series and the propagated
  // time-of-day cannot disagree about what "the same day" means.
  const zone = await clubTimeZone();

  // Converting a standalone (non-recurring) event INTO a recurring series:
  // replace the single row with a freshly generated series anchored at the
  // edited start. Runs before the single-edit path so "open the event, set it
  // to repeat, save" works without deleting and recreating.
  if (!existing.seriesId && data.recurrence) {
    try {
      const anchor = await prisma.$transaction(async (tx) => {
        // Serialize concurrent "convert this standalone event into a series"
        // saves on the same row (keyed by the event id, since no series exists
        // yet).
        await lockCalendarSeries(tx, id);
        await tx.calendarEvent.delete({ where: { id } });
        return createSeriesWithOccurrences(
          { ...data, recurrence: data.recurrence as RecurrenceRule },
          actorId,
          zone,
          tx,
        );
      });
      return { anchor, scope: "series" };
    } catch (error) {
      // A concurrent admin deleted the row first: treat as already gone (404).
      if (isRecordNotFoundError(error)) return null;
      throw error;
    }
  }

  // Standalone event, or a per-occurrence edit: change just this row.
  if (!existing.seriesId || !existing.series || scope === "single") {
    const anchor = await updateSingleOccurrence(existing, data);
    // A concurrent delete removed the row between the read and the write → 404.
    if (!anchor) return null;
    return { anchor, scope: "single" };
  }

  // Series edit that removes recurrence entirely.
  if (!data.recurrence) {
    const anchor = await collapseSeriesToSingle(existing, data);
    // A concurrent delete removed the survivor first → 404.
    if (!anchor) return null;
    return { anchor, scope: "series" };
  }

  const dateChanged =
    clubDayKey(existing.startsAt, zone) !== clubDayKey(data.startsAt, zone);
  const patternChanged =
    dateChanged || !seriesMatchesRule(existing.series, data.recurrence, zone);

  if (patternChanged) {
    const regenerated = await regenerateSeries(
      existing.series,
      { ...data, recurrence: data.recurrence },
      actorId,
      zone,
    );
    // A concurrent whole-series delete removed the series first → 404.
    if (!regenerated) return null;
  } else {
    // No P2025 guard here: propagate reads its occurrence set INSIDE the
    // transaction, after taking the per-series lock that every series and
    // single delete also takes, so no row it updates can vanish under it.
    await propagateSeriesFieldChanges(existing.seriesId, data, zone);
  }

  // Return the (possibly regenerated) anchor for the response.
  const anchor = await prisma.calendarEvent.findFirst({
    where: { seriesId: existing.seriesId },
    orderBy: { startsAt: "asc" },
  });
  return { anchor: (anchor ?? existing) as CalendarEvent, scope: "series" };
}

export interface CalendarDeleteResult {
  title: string;
  scope: CalendarEditScope;
  deletedCount: number;
}

/** How a whole-series delete treats detached exceptions (per-occurrence edits). */
export type CalendarDeleteExceptionMode = "keep" | "delete";

/**
 * Delete an event. `scope: "series"` removes every occurrence of the series
 * (and the series row); "single" removes just this occurrence, tidying up an
 * emptied series. Returns null when the id is unknown (or a concurrent delete
 * removed it first).
 *
 * `exceptionMode` (series scope only) chooses what happens to detached
 * exceptions — occurrences a "single" edit turned into standalone-looking
 * one-offs of the series:
 *  - "keep" (default): orphan them (seriesId → null) so they survive as
 *    standalone events, then delete the non-detached occurrences + series row.
 *    `deletedCount` is the non-detached count.
 *  - "delete": remove every occurrence of the series, exceptions included.
 */
export async function deleteCalendarEvent(
  id: string,
  scope: CalendarEditScope,
  exceptionMode: CalendarDeleteExceptionMode = "keep",
): Promise<CalendarDeleteResult | null> {
  const existing = await prisma.calendarEvent.findUnique({ where: { id } });
  if (!existing) return null;

  if (scope === "series" && existing.seriesId) {
    const seriesId = existing.seriesId;
    try {
      const deletedCount = await prisma.$transaction(async (tx) => {
        await lockCalendarSeries(tx, seriesId);
        if (exceptionMode === "keep") {
          // Orphan detached exceptions into standalone events, then remove only
          // the non-detached occurrences and the series row.
          await tx.calendarEvent.updateMany({
            where: { seriesId, detachedFromSeries: true },
            data: { seriesId: null },
          });
          const deleted = await tx.calendarEvent.deleteMany({
            where: { seriesId, detachedFromSeries: false },
          });
          await tx.calendarEventSeries.delete({ where: { id: seriesId } });
          return deleted.count;
        }
        const deleted = await tx.calendarEvent.deleteMany({ where: { seriesId } });
        await tx.calendarEventSeries.delete({ where: { id: seriesId } });
        return deleted.count;
      });
      return { title: existing.title, scope: "series", deletedCount };
    } catch (error) {
      // A concurrent delete already removed the series → treat as already gone.
      if (isRecordNotFoundError(error)) return null;
      throw error;
    }
  }

  // Single delete: run the delete AND the empty-series cleanup under the series
  // lock (when the row belongs to a series), so two concurrent single-deletes
  // cannot both observe a non-empty series and both skip the cleanup, leaving an
  // orphan series row.
  const seriesId = existing.seriesId;
  try {
    await prisma.$transaction(async (tx) => {
      if (seriesId) await lockCalendarSeries(tx, seriesId);
      await tx.calendarEvent.delete({ where: { id } });
      if (seriesId) {
        const remaining = await tx.calendarEvent.count({ where: { seriesId } });
        if (remaining === 0) {
          await tx.calendarEventSeries
            .delete({ where: { id: seriesId } })
            .catch(() => {});
        }
      }
    });
  } catch (error) {
    // A concurrent delete removed this occurrence first → already gone.
    if (isRecordNotFoundError(error)) return null;
    throw error;
  }

  return { title: existing.title, scope: "single", deletedCount: 1 };
}

/*
  Re-exported so `calendar-service.ts` stays the one import for a caller shaping
  a create/edit — the type belongs with the row builder that consumes it
  (`calendar-occurrences.ts`), and the route and its tests should not have to
  know which half of this pair holds which piece.
*/
export type { ResolvedEventData };
