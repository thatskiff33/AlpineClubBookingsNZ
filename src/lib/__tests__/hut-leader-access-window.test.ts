import { describe, expect, it } from "vitest";
import {
  hutLeaderAccessWindowCoversDayWhere,
  hutLeaderAccessWindowNotClosedByWhere,
  hutLeaderAccessWindowOf,
  isDayInHutLeaderAccessWindow,
} from "@/lib/hut-leader-access-window";
import { clubToday, dateOnlyInstantOf, requireClubTimeZone } from "@/lib/club-time";

/**
 * The hut-leader access window (#3817, owner decision "Go further", 2 Oct 2026):
 * from the day BEFORE the first night until midnight on the day the leader
 * LEAVES — the day after the last night. As club calendar days,
 * `[startDate - 1, endDate + 1]` inclusive.
 *
 * Fixtures are relative to the frozen test instant, 2026-07-01T00:00:00Z
 * (`vitest.clock-setup.ts`), which is 1 July in New Zealand.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Nights 1-3 July: arrive 1 July, leave the morning of 4 July. */
const assignment = { startDate: day("2026-07-01"), endDate: day("2026-07-03") };

/** The Prisma filter, evaluated over one row the way Postgres would. */
function whereAdmits(
  where: { startDate: { lte: Date }; endDate: { gte: Date } },
  row: { startDate: Date; endDate: Date },
) {
  return row.startDate <= where.startDate.lte && row.endDate >= where.endDate.gte;
}

describe("hut-leader access window (#3817)", () => {
  it("PREMISE: the frozen today is the first night, in the club's zone", () => {
    const today = dateOnlyInstantOf(clubToday(requireClubTimeZone("Pacific/Auckland")));
    expect(today.toISOString()).toBe(assignment.startDate.toISOString());
  });

  it("runs from the day before the first night to the day after the last", () => {
    const { firstDay, lastDay } = hutLeaderAccessWindowOf(assignment);
    expect(firstDay.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(lastDay.toISOString()).toBe("2026-07-04T00:00:00.000Z");
  });

  it.each([
    ["2026-06-29", false, "two days before the first night"],
    ["2026-06-30", true, "the day before the first night"],
    ["2026-07-01", true, "the first night"],
    ["2026-07-03", true, "the last night"],
    ["2026-07-04", true, "the departure day, until midnight"],
    ["2026-07-05", false, "the day after the departure day"],
  ])("%s is %s (%s)", (iso, expected) => {
    expect(isDayInHutLeaderAccessWindow(assignment, day(iso))).toBe(expected);
  });

  it.each([
    "2026-06-29",
    "2026-06-30",
    "2026-07-01",
    "2026-07-03",
    "2026-07-04",
    "2026-07-05",
  ])("the Prisma filter agrees with the predicate on %s", (iso) => {
    expect(
      whereAdmits(hutLeaderAccessWindowCoversDayWhere(day(iso)) as never, assignment),
    ).toBe(isDayInHutLeaderAccessWindow(assignment, day(iso)));
  });

  it("'not closed' stays open through the departure day and closes after it", () => {
    const admits = (iso: string) =>
      assignment.endDate >= (hutLeaderAccessWindowNotClosedByWhere(day(iso)).endDate as { gte: Date }).gte;
    // Upcoming: long before the stay.
    expect(admits("2026-06-01")).toBe(true);
    expect(admits("2026-07-04")).toBe(true);
    expect(admits("2026-07-05")).toBe(false);
  });

  it("is whole calendar days, so a DST change cannot move it", () => {
    // NZ daylight saving starts on 27 Sep 2026: 24-hour arithmetic on an instant
    // would land an hour short of the departure day's encoding.
    const acrossDst = { startDate: day("2026-09-26"), endDate: day("2026-09-26") };
    expect(hutLeaderAccessWindowOf(acrossDst).lastDay.toISOString()).toBe(
      "2026-09-27T00:00:00.000Z",
    );
  });
});
