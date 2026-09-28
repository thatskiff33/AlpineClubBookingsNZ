import { clubCalendarDateOf, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";

/**
 * The club's today in the `@db.Date` encoding check-ins are stored in, for
 * `bookingStayHasStarted` (#3672, #3663). Read outside every transaction
 * (`INV-LOCK-004`) and handed in, so every "has this stay started?" check a
 * cron or settlement path makes judges the same club day.
 */
export async function clubTodayForStartedStay(now: Date = new Date()): Promise<Date> {
  return dateOnlyInstantOf(
    clubCalendarDateOf(now, await readClubTimeZoneOutsideRequest())
  );
}
