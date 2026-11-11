/**
 * The officer grace deadline, in the club's civil time (#4618, INV-DATE).
 *
 * Grace days of 0 end at the stamp itself. One or more days end at the start
 * of the club day after the deadline date: first sign-in on 2 March with 14
 * days is "by 16 March", and 17 March 00:00 club time is the first gated
 * instant. Nothing here adds a fixed number of milliseconds.
 */

import {
  addCalendarDays,
  clubCalendarDateOf,
  endOfClubDayExclusive,
  formatClubLongDate,
  startOfClubDay,
} from "@/lib/club-time";
import type { CalendarDate, ClubDateFormat, ClubTimeZone } from "@/lib/club-time";

export const OFFICER_TWO_FACTOR_GRACE_MIN_DAYS = 0;
export const OFFICER_TWO_FACTOR_GRACE_MAX_DAYS = 60;
export const OFFICER_TWO_FACTOR_GRACE_DEFAULT_DAYS = 14;

export function clampOfficerTwoFactorGraceDays(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return OFFICER_TWO_FACTOR_GRACE_DEFAULT_DAYS;
  const whole = Math.trunc(parsed);
  if (whole < OFFICER_TWO_FACTOR_GRACE_MIN_DAYS) return OFFICER_TWO_FACTOR_GRACE_MIN_DAYS;
  if (whole > OFFICER_TWO_FACTOR_GRACE_MAX_DAYS) return OFFICER_TWO_FACTOR_GRACE_MAX_DAYS;
  return whole;
}

/**
 * A reset does not start another grace period. True when a reset is recorded
 * and it is later than the grace stamp, or the stamp was never written.
 */
export function officerGraceClosedByReset(input: {
  graceStartedAt: Date | null;
  factorsResetAt: Date | null;
}): boolean {
  if (!(input.factorsResetAt instanceof Date)) return false;
  if (!(input.graceStartedAt instanceof Date)) return true;
  return input.factorsResetAt.getTime() > input.graceStartedAt.getTime();
}

/** The exclusive end of grace. Days of 0 return the stamp itself. */
export function officerTwoFactorGraceEnd(input: {
  startedAt: Date;
  graceDays: number;
  zone: ClubTimeZone;
}): Date {
  const days = clampOfficerTwoFactorGraceDays(input.graceDays);
  if (days === 0) return input.startedAt;
  const startDate = clubCalendarDateOf(input.startedAt, input.zone);
  const deadline = addCalendarDays(startDate, days);
  return endOfClubDayExclusive(deadline, input.zone);
}

/**
 * The civil date the banner and the report name. Null when grace is 0: there
 * is no "by" date, because the stamp itself is already the end.
 */
export function officerGraceDeadlineDate(input: {
  startedAt: Date;
  graceDays: number;
  zone: ClubTimeZone;
}): CalendarDate | null {
  const days = clampOfficerTwoFactorGraceDays(input.graceDays);
  if (days === 0) return null;
  return addCalendarDays(clubCalendarDateOf(input.startedAt, input.zone), days);
}

/**
 * The deadline date implied by an exclusive end instant, for a banner that
 * only holds the epoch. An end that is exactly the start of a club day names
 * the previous day. Anything else (a grace-0 stamp) has no "by" date.
 */
export function officerGraceDeadlineDateFromEnd(
  graceEndsAt: Date,
  zone: ClubTimeZone,
): CalendarDate | null {
  const civil = clubCalendarDateOf(graceEndsAt, zone);
  const dayStart = startOfClubDay(civil, zone);
  if (graceEndsAt.getTime() !== dayStart.getTime()) return null;
  return addCalendarDays(civil, -1);
}

export function formatOfficerGraceDeadline(
  graceEndsAt: Date,
  zone: ClubTimeZone,
  format: ClubDateFormat,
): string | null {
  const date = officerGraceDeadlineDateFromEnd(graceEndsAt, zone);
  if (!date) return null;
  return formatClubLongDate(date, format);
}

/** Gated once `now` has reached the exclusive end. */
export function officerGraceHasEnded(now: Date, graceEndsAt: Date): boolean {
  return now.getTime() >= graceEndsAt.getTime();
}
