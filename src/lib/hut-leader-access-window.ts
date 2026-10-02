import type { Prisma } from "@prisma/client";
import { addDaysDateOnly } from "./date-only";

/**
 * When a hut leader may sign in: the ONE definition (#3817, `INV-SSOT`).
 *
 * An assignment's `startDate`..`endDate` are the lodge NIGHTS the leader covers,
 * inclusive (`INV-DATE-002`: night N runs from midday N to midday N+1). The
 * owner's rule (2 Oct 2026, #3789/#3820, "Go further"): a leader can log in from
 * the day BEFORE their first night until midnight on the day they LEAVE the
 * lodge, which is the day after their last night. As calendar days that is
 *
 *     [startDate - 1, endDate + 1]   inclusive
 *
 * "Until midnight" needs no time of day here. Every caller judges a club
 * calendar day — the club's today from `@/lib/club-time` (`INV-CONFIG-002`), or
 * a date the kiosk is showing — and the club's today stops being `endDate + 1`
 * at the club's midnight. The arithmetic is whole date-only days on the
 * `@db.Date` encoding (`addDaysDateOnly`), never 24-hour steps on an instant.
 *
 * Before #3817 the window closed at `endDate`, which was right only while the
 * writers stored the CHECK-OUT day as `endDate`. The writers now store the last
 * night slept, so the window gains the departure day explicitly. A row written
 * before #3817 that still ends on a check-out day therefore gets one extra day
 * of access (to midnight the day after it), which the owner accepted: there is
 * no backfill.
 *
 * Every hut-leader ACCESS reader routes here: the kiosk tier and its date
 * range, the kiosk lodge resolution, the PIN login, the PIN session check, the
 * instructions PIN check, the kiosk dietary grant, `isHutLeader` and the nav /
 * instructions "current or upcoming" checks. Coverage (does a night have a
 * leader?) is a different question, answered on nights, and does not.
 */

/** Days before the first covered night that sign-in opens. */
export const HUT_LEADER_ACCESS_DAYS_BEFORE_FIRST_NIGHT = 1;

/** Days after the last covered night that sign-in stays open (departure day). */
export const HUT_LEADER_ACCESS_DAYS_AFTER_LAST_NIGHT = 1;

type AssignmentNights = { startDate: Date; endDate: Date };

/** The first and last calendar day (inclusive) an assignment grants access on. */
export function hutLeaderAccessWindowOf(assignment: AssignmentNights): {
  firstDay: Date;
  lastDay: Date;
} {
  return {
    firstDay: addDaysDateOnly(
      assignment.startDate,
      -HUT_LEADER_ACCESS_DAYS_BEFORE_FIRST_NIGHT,
    ),
    lastDay: addDaysDateOnly(
      assignment.endDate,
      HUT_LEADER_ACCESS_DAYS_AFTER_LAST_NIGHT,
    ),
  };
}

/** Is `day` (a date-only club calendar day) inside the assignment's access window? */
export function isDayInHutLeaderAccessWindow(
  assignment: AssignmentNights,
  day: Date,
): boolean {
  const { firstDay, lastDay } = hutLeaderAccessWindowOf(assignment);
  return firstDay.getTime() <= day.getTime() && day.getTime() <= lastDay.getTime();
}

/**
 * The Prisma filter form of {@link isDayInHutLeaderAccessWindow}:
 * `startDate - 1 <= day <= endDate + 1`, rewritten onto the columns as
 * `startDate <= day + 1` and `endDate >= day - 1`.
 */
export function hutLeaderAccessWindowCoversDayWhere(
  day: Date,
): Pick<Prisma.HutLeaderAssignmentWhereInput, "startDate" | "endDate"> {
  return {
    startDate: { lte: addDaysDateOnly(day, HUT_LEADER_ACCESS_DAYS_BEFORE_FIRST_NIGHT) },
    endDate: { gte: addDaysDateOnly(day, -HUT_LEADER_ACCESS_DAYS_AFTER_LAST_NIGHT) },
  };
}

/**
 * "Current or upcoming": the assignment's access window has not closed by
 * `day` (`endDate + 1 >= day`). Used where access is granted ahead of the stay
 * as well as during it — the instructions reader and the nav link.
 */
export function hutLeaderAccessWindowNotClosedByWhere(
  day: Date,
): Pick<Prisma.HutLeaderAssignmentWhereInput, "endDate"> {
  return {
    endDate: { gte: addDaysDateOnly(day, -HUT_LEADER_ACCESS_DAYS_AFTER_LAST_NIGHT) },
  };
}
