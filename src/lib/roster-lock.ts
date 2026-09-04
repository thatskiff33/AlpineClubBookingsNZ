import type { Prisma } from "@prisma/client";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { addDaysDateOnly, eachDateOnlyInRange, formatDateOnly } from "@/lib/date-only";

type RosterLockTx = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * Serialise every writer that can change the roster for one NZ lodge night.
 *
 * The key deliberately remains date-only for compatibility with the existing
 * roster-generation lock. That makes writers for different lodges on the same
 * night contend briefly, but it also lets legacy/current writers share one
 * unambiguous lock family while every query is independently lodge-scoped.
 */
export async function lockRosterDate(
  tx: RosterLockTx,
  date: Date,
) {
  const lockKey = `roster:${formatDateOnly(date)}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}

/**
 * Lock an eligibility-validating roster mutation in the shared writer order.
 *
 * Booking lifecycle/consent writers already take the global and/or immutable
 * lodge tiers. Joining both before the roster-date key makes their commit
 * visible before a roster mutation performs its authoritative eligibility
 * read, including when the roster partition was initially empty.
 */
export async function lockRosterEligibilityMutation(
  tx: Prisma.TransactionClient,
  lodgeId: string,
  date: Date,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  await acquireLodgeCapacityLock(tx, lodgeId);
  await lockRosterDate(tx, date);
}

/**
 * Acquire several roster-date locks in deterministic date order.
 *
 * THE ORDER IS DETERMINISTIC WITHIN ONE CALL, WHICH IS NOT THE SAME AS WITHIN ONE
 * TRANSACTION (#3232). Two writers that each take ONE sorted set can never
 * deadlock on this family. A caller that takes TWO sorted sets — composing two
 * booking writes into one transaction, as `runLinkedDateMove` does — can hold a
 * later date from the first set and then ask for an earlier one from the second,
 * which is an inverted acquisition against a writer coming the other way.
 *
 * WHAT MAKES THAT SAFE, and it is a real constraint rather than an observation:
 * every writer in the tree that acquires MORE THAN ONE roster-date key holds
 * `pg_advisory_xact_lock(1)` for the whole transaction first — the two booking
 * modification services, guest removal, the kiosk departure route, and
 * `chore-cleanup`, which is only ever called from inside the first two. So no two
 * multi-key roster acquisitions can interleave at all, and a writer holding a
 * SINGLE roster key (`lockRosterDate`, `lockRosterEligibilityMutation`) cannot be
 * part of a cycle in this family. A NEW multi-key roster writer that does not take
 * the global key first would break that, so take it — see
 * `docs/CONCURRENCY_AND_LOCKING.md` → "Composition: roster-date writers".
 */
export async function lockRosterDates(
  tx: RosterLockTx,
  dates: Iterable<Date>,
) {
  const uniqueDates = new Map<string, Date>();
  for (const date of dates) uniqueDates.set(formatDateOnly(date), date);
  for (const [, date] of [...uniqueDates].sort(([a], [b]) => a.localeCompare(b))) {
    await lockRosterDate(tx, date);
  }
}

/**
 * The roster dates one half-open night range now occupies.
 *
 * A stay of nights [checkIn, checkOut) can carry chore rows on every one of
 * those nights AND on the check-out day itself, because its guests are in the
 * lodge until midday then (#2622). Returned as a half-open range for
 * `eachDateOnlyInRange`, so `end` is the day after check-out.
 *
 * Every writer that derives a roster-date lock set from a stay envelope must
 * build it through here. Locking only the nights would leave the check-out
 * date's partition unlocked, and a concurrent whole-roster Save could validate
 * the old stay, wait, and then insert a checkout-day row the mutation has
 * already decided to remove.
 */
export function rosterOperationalDayRange(
  checkIn: Date,
  checkOut: Date,
): { start: Date; end: Date } {
  return { start: checkIn, end: addDaysDateOnly(checkOut, 1) };
}

/**
 * Acquire one sorted lock set for date ranges plus exceptional stored dates.
 *
 * Booking mutations use this before tuple writes so an out-of-envelope legacy
 * assignment cannot make cleanup discover and acquire a lower roster key after
 * a higher one is already held.
 */
export async function lockRosterDateRangesAndDates(
  tx: RosterLockTx,
  ranges: Array<{ start: Date; end: Date }>,
  dates: Iterable<Date>,
) {
  await lockRosterDates(tx, [
    ...ranges.flatMap((range) => eachDateOnlyInRange(range.start, range.end)),
    ...dates,
  ]);
}
