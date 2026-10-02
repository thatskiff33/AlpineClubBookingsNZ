import { describe, expect, it } from "vitest";

import {
  buildLeaderCalendarOverlay,
  coveredNightsByDate,
} from "../leader-calendar-overlay";

/**
 * The changeover labels (#3818): a day shows "AM · <night D − 1> until midday"
 * and "PM · <night D> from midday" only when the two nights have different
 * leaders, and a night with guests and no valid shift shows "No leader tonight".
 */

function d(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

const ann = { memberId: "ann", name: "Ann Smith" };
const ben = { memberId: "ben", name: "Ben Jones" };

function overlayFor(
  covered: Array<{ date: string; leaders: Array<{ memberId: string; name: string }> }>,
  redDates: string[],
) {
  return buildLeaderCalendarOverlay({
    monthStart: d("2026-08-01"),
    monthEnd: d("2026-08-31"),
    coveredNights: coveredNightsByDate(covered),
    redDates,
    guestNights: new Set(["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"]),
  });
}

describe("buildLeaderCalendarOverlay — Wednesday leave / Thursday arrive", () => {
  it("a leader leaving Wednesday and one arriving Thursday leaves Wednesday night with nobody", () => {
    // Ann stays Mon 3 and Tue 4 Aug and leaves Wednesday 5 Aug at midday; Ben
    // arrives Thursday 6 Aug. Guests stay on Wednesday night.
    const overlay = overlayFor(
      [
        { date: "2026-08-03", leaders: [ann] },
        { date: "2026-08-04", leaders: [ann] },
        { date: "2026-08-06", leaders: [ben] },
      ],
      ["2026-08-05"],
    );

    expect(overlay["2026-08-04"]).toEqual({ tone: "violet", label: "Smith", emphasis: "fill" });
    expect(overlay["2026-08-05"]).toEqual({
      tone: "red",
      label: "AM · Smith until midday, No leader tonight",
      lines: ["AM · Smith until midday", "No leader tonight"],
    });
    expect(overlay["2026-08-06"]).toMatchObject({
      tone: "violet",
      lines: ["PM · Jones from midday"],
    });
  });

  it("a leader whose last night is Wednesday hands over to Thursday's arrival at midday", () => {
    // Ann's last night is Wednesday 5 Aug, so she is on duty until midday
    // Thursday; Ben is on duty from midday Thursday.
    const overlay = overlayFor(
      [
        { date: "2026-08-04", leaders: [ann] },
        { date: "2026-08-05", leaders: [ann] },
        { date: "2026-08-06", leaders: [ben] },
        { date: "2026-08-07", leaders: [ben] },
      ],
      [],
    );

    expect(overlay["2026-08-05"]).toEqual({ tone: "violet", label: "Smith", emphasis: "fill" });
    expect(overlay["2026-08-06"]).toEqual({
      tone: "violet",
      label: "AM · Smith until midday, PM · Jones from midday",
      lines: ["AM · Smith until midday", "PM · Jones from midday"],
      emphasis: "fill",
    });
    // Same leader both nights: no split.
    expect(overlay["2026-08-07"]).toEqual({ tone: "violet", label: "Jones", emphasis: "ring" });
    // Ben's checkout morning: he is on duty until midday.
    expect(overlay["2026-08-08"]).toMatchObject({ lines: ["AM · Jones until midday"] });
  });

  it("reads the night before the month for the 1st's morning", () => {
    const overlay = overlayFor(
      [
        { date: "2026-07-31", leaders: [ann] },
        { date: "2026-08-01", leaders: [ben] },
      ],
      [],
    );
    expect(overlay["2026-08-01"]).toMatchObject({
      lines: ["AM · Smith until midday", "PM · Jones from midday"],
    });
    expect(overlay["2026-07-31"]).toBeUndefined();
  });
});
