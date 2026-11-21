/**
 * Keeping a work party's Events Calendar entries in step with it (#5148).
 *
 * The rows themselves are written only by `replaceWorkPartyCalendarEvents` in
 * `calendar-work-party-entries.ts`; this module decides WHEN and WHAT:
 *
 * - **Create:** a new work party goes on the calendar when the Events Calendar
 *   module is on, and not otherwise.
 * - **Edit:** a work party that already has entries has them regenerated from
 *   its name, dates, description and lodge as saved, whatever the module state
 *   — an entry that exists must never show stale dates. The rewrite runs in the
 *   edit's own transaction, after the lock and the update
 *   (`updateWorkPartyWithCalendar`), so the work party and its entries change
 *   together or not at all. One without entries (made before this feature, or
 *   while the calendar was off) is left alone, so a club that typed it on the
 *   calendar by hand does not get a duplicate.
 * - **"Add to calendar":** the officer's explicit link for such a work party;
 *   refused while the module is off (the route checks).
 * - **Delete:** its entries go with it, in the delete's own transaction
 *   (`removeWorkPartyCalendarEventsInTransaction`).
 * - **Deactivate / reactivate:** an ordinary edit. The entries stay, and the
 *   calendar readers hide an inactive work party's entries, and every work
 *   party's entries while the Work parties module is off
 *   (`whereVisibleCalendarEvent`), so turning either back on shows them again.
 *
 * Every write builds the entry from the work party read INSIDE the writer's
 * transaction, after its lock (`loadWorkPartyCalendarEntry`), never from the
 * route's own copy: two officers saving the same work party at once therefore
 * leave the entries matching whichever save landed last.
 *
 * Dates come from the work party's date-only columns through the club-time
 * kernel — the window helpers in `work-party-rules.ts`, then `eachCalendarDate`
 * — never by hand (INV-DATE, INV-CONFIG-002).
 */
import type { Prisma } from "@prisma/client";
import { eachCalendarDate, type CalendarDate } from "@/lib/club-time";
import {
  workPartyCheckOutDay,
  workPartyFirstNight,
} from "@/lib/work-party-rules";
import {
  lockWorkPartyCalendar,
  replaceWorkPartyCalendarEvents,
  replaceWorkPartyCalendarEventsInTransaction,
  type WorkPartyCalendarEntry,
} from "@/lib/calendar-work-party-entries";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import { clubTimeZone } from "@/lib/club-time/server";
import {
  updateWorkPartyEventAndPromo,
  type WorkPartyEventInput,
} from "@/lib/work-party";
import logger from "@/lib/logger";

export interface WorkPartyCalendarSource {
  name: string;
  description: string | null;
  startDate: Date;
  endDate: Date;
  lodge?: { name: string } | null;
}

/** Each club day of the inclusive window, first night to last night. */
export function workPartyCalendarDays(source: {
  startDate: Date;
  endDate: Date;
}): CalendarDate[] {
  return eachCalendarDate(
    workPartyFirstNight(source),
    workPartyCheckOutDay(source),
  );
}

export function workPartyCalendarEntry(
  source: WorkPartyCalendarSource,
): WorkPartyCalendarEntry {
  return {
    title: `Work party: ${source.name}`,
    location: source.lodge?.name ?? null,
    details: source.description,
    days: workPartyCalendarDays(source),
  };
}

/** The work party as it is now, as calendar entries; null once it is gone. */
async function loadWorkPartyCalendarEntry(
  db: Prisma.TransactionClient,
  workPartyEventId: string,
): Promise<WorkPartyCalendarEntry | null> {
  const workParty = await db.workPartyEvent.findUnique({
    where: { id: workPartyEventId },
    select: {
      name: true,
      description: true,
      startDate: true,
      endDate: true,
      lodge: { select: { name: true } },
    },
  });
  return workParty ? workPartyCalendarEntry(workParty) : null;
}

/** Put a work party on the calendar now, replacing any entries it has. */
export function addWorkPartyToCalendar(
  workPartyEventId: string,
  actorId: string,
): Promise<number> {
  return replaceWorkPartyCalendarEvents(
    workPartyEventId,
    (tx) => loadWorkPartyCalendarEntry(tx, workPartyEventId),
    actorId,
  );
}

/** What an officer sees when a new work party saved but its calendar did not. */
export const WORK_PARTY_CALENDAR_SYNC_FAILED =
  "The work party was saved, but it could not be added to the calendar. Use Add to calendar to try again.";

/**
 * Run a calendar write after the work party itself has been saved. The work
 * party is the record that matters (it carries the discount); a calendar
 * failure is logged and reported back rather than turning a saved work party
 * into a 500 the officer would retry.
 */
async function afterWorkPartySaved(
  workPartyEventId: string,
  write: () => Promise<unknown>,
  failure: string,
): Promise<string | null> {
  try {
    await write();
    return null;
  } catch (err) {
    logger.error(
      { err, workPartyEventId },
      "Work party calendar sync failed",
    );
    return failure;
  }
}

/** On create: add the entries when the Events Calendar module is on. */
export async function syncCreatedWorkPartyCalendar(
  workPartyEventId: string,
  actorId: string,
): Promise<string | null> {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.eventsCalendar) return null;
  return afterWorkPartySaved(
    workPartyEventId,
    () => addWorkPartyToCalendar(workPartyEventId, actorId),
    WORK_PARTY_CALENDAR_SYNC_FAILED,
  );
}

/**
 * On edit: save the work party and regenerate the entries of one that already
 * has some, in ONE transaction (#5148). The lock comes first, before the
 * update takes its row locks, the order every writer of a
 * work party's entries uses (`lockWorkPartyCalendar`), so an edit racing a
 * delete or an "Add to calendar" waits rather than deadlocks. A failed
 * rewrite fails the save, so the calendar can never be left showing the old
 * dates of a work party that saved.
 */
export async function updateWorkPartyWithCalendar(
  workPartyEventId: string,
  input: WorkPartyEventInput,
  actorId: string,
) {
  const zone = await clubTimeZone();
  return prisma.$transaction(async (tx) => {
    await lockWorkPartyCalendar(tx, workPartyEventId);
    const event = await updateWorkPartyEventAndPromo(tx, workPartyEventId, input);
    await replaceWorkPartyCalendarEventsInTransaction(
      tx,
      workPartyEventId,
      (db) => loadWorkPartyCalendarEntry(db, workPartyEventId),
      actorId,
      zone,
      { onlyIfLinked: true },
    );
    return event;
  });
}
