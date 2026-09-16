/**
 * The season schedule read as a timeline, and the holes in it (#2938).
 *
 * Two things every case here is really about.
 *
 * THE BOUNDARY. A season window is inclusive at both edges, counted in nights —
 * `findRateForNight` matches `startDate <= night <= endDate`, and a stay's
 * nights are the half-open `[checkIn, checkOut)` expansion (`INV-DATE-003`). So
 * two seasons abut when the later starts the day AFTER the earlier ends, and
 * the one-line version of this whole module getting it wrong is a warning panel
 * that cries gap between every correctly abutting pair a club has. `abutting`
 * below is the case that refutes that version.
 *
 * COVERAGE MEANS ACTIVE. Every pricing path loads seasons with `active: true`,
 * so a night an inactive season "covers" is a night a booking is refused. It
 * closes no gap — but it stays in the timeline, because the deactivated window
 * sitting inside a hole is usually the explanation for it.
 *
 * Dates are written against the frozen clock's 2026-07-01, so `2026-08-01` is
 * future and `2026-06-01` is past, permanently.
 */

import { describe, expect, it } from "vitest";

import { requireCalendarDate, type CalendarDate } from "@/lib/club-time";
import {
  buildSeasonTimeline,
  computeSeasonCoverageGaps,
  orderSeasonsChronologically,
  type TimelineSeason,
} from "@/lib/season-timeline";

const day = (iso: string): CalendarDate => requireCalendarDate(iso);

function season(
  id: string,
  startDate: string,
  endDate: string,
  overrides: Partial<TimelineSeason> = {},
): TimelineSeason {
  return {
    id,
    name: id,
    startDate: day(startDate),
    endDate: day(endDate),
    active: true,
    ...overrides,
  };
}

describe("orderSeasonsChronologically", () => {
  it("puts the earliest start first, whatever order they arrived in", () => {
    const ordered = orderSeasonsChronologically([
      season("summer", "2026-10-01", "2027-04-30"),
      season("winter", "2026-06-01", "2026-09-30"),
      season("spring", "2026-05-01", "2026-05-31"),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(["spring", "winter", "summer"]);
  });

  it("is TOTAL, so a refresh cannot reorder two seasons sharing a start", () => {
    // The common real pair: a deactivated window and the replacement that took
    // its place. Left tied, they render in whatever order the API returned,
    // which moves under the officer between one refresh and the next.
    const input = [
      season("b", "2026-06-01", "2026-09-30", { name: "Winter 2026" }),
      season("a", "2026-06-01", "2026-09-30", { name: "Winter 2026" }),
    ];
    expect(orderSeasonsChronologically(input).map((s) => s.id)).toEqual([
      "a",
      "b",
    ]);
    expect(
      orderSeasonsChronologically([...input].reverse()).map((s) => s.id),
    ).toEqual(["a", "b"]);
  });

  it("breaks a shared start by end date before name", () => {
    const ordered = orderSeasonsChronologically([
      season("long", "2026-06-01", "2026-09-30", { name: "A" }),
      season("short", "2026-06-01", "2026-06-30", { name: "Z" }),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(["short", "long"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [
      season("summer", "2026-10-01", "2027-04-30"),
      season("winter", "2026-06-01", "2026-09-30"),
    ];
    orderSeasonsChronologically(input);
    expect(input.map((s) => s.id)).toEqual(["summer", "winter"]);
  });
});

describe("computeSeasonCoverageGaps", () => {
  it("reports NOTHING between two abutting seasons", () => {
    // 30 September is the last night winter prices; 1 October is the first
    // night summer prices. Nothing is uncovered. A comparison asking only
    // `next.startDate > previous.endDate` reports a gap here, and would do so
    // for every correctly configured club in existence.
    const gaps = computeSeasonCoverageGaps({
      seasons: [
        season("winter", "2026-06-01", "2026-09-30"),
        season("summer", "2026-10-01", "2027-04-30"),
      ],
    });
    expect(gaps).toEqual([]);
  });

  it("reports nothing when the seasons overlap", () => {
    const gaps = computeSeasonCoverageGaps({
      seasons: [
        season("winter", "2026-06-01", "2026-09-30"),
        season("summer", "2026-09-15", "2027-04-30"),
      ],
    });
    expect(gaps).toEqual([]);
  });

  it("finds a one-night hole and says it is one night", () => {
    // The error this exists to catch: an officer types 2 October instead of
    // 1 October. "1 Oct 2026 — 30 Nov 2026" and "1 Oct 2026" look equally
    // plausible on screen, so the night COUNT is what makes it visible.
    const [gap, ...rest] = computeSeasonCoverageGaps({
      seasons: [
        season("winter", "2026-06-01", "2026-09-30"),
        season("summer", "2026-10-02", "2027-04-30"),
      ],
    });
    expect(rest).toEqual([]);
    expect(gap).toMatchObject({
      afterSeasonId: "winter",
      beforeSeasonId: "summer",
      firstUncoveredNight: "2026-10-01",
      lastUncoveredNight: "2026-10-01",
      nights: 1,
    });
  });

  it("counts a longer hole in nights, inclusive of its last night", () => {
    const [gap] = computeSeasonCoverageGaps({
      seasons: [
        season("winter", "2026-06-01", "2026-09-30"),
        season("summer", "2026-12-01", "2027-04-30"),
      ],
    });
    // October (31) + November (30).
    expect(gap).toMatchObject({
      firstUncoveredNight: "2026-10-01",
      lastUncoveredNight: "2026-11-30",
      nights: 61,
    });
  });

  it("raises no phantom hole after a short season a long one swallows", () => {
    // Comparing each season with the one printed above it reports a gap after
    // `short` — it ends in June and `late` starts in October — even though
    // `long` covers every night between. The sweep is what prevents that.
    const gaps = computeSeasonCoverageGaps({
      seasons: [
        season("long", "2026-06-01", "2026-09-30"),
        season("short", "2026-06-10", "2026-06-20"),
        season("late", "2026-10-01", "2027-04-30"),
      ],
    });
    expect(gaps).toEqual([]);
  });

  it("does not let an INACTIVE season close a hole", () => {
    // The deactivated window sits exactly in the hole. Every pricing path loads
    // `active: true`, so a booking for October is refused — and reporting no
    // gap here would tell the officer the opposite.
    const [gap, ...rest] = computeSeasonCoverageGaps({
      seasons: [
        season("winter", "2026-06-01", "2026-09-30"),
        season("retired", "2026-10-01", "2026-11-30", { active: false }),
        season("summer", "2026-12-01", "2027-04-30"),
      ],
    });
    expect(rest).toEqual([]);
    expect(gap).toMatchObject({
      afterSeasonId: "winter",
      beforeSeasonId: "summer",
      firstUncoveredNight: "2026-10-01",
      lastUncoveredNight: "2026-11-30",
    });
  });

  it("reports every hole in a schedule with several", () => {
    const gaps = computeSeasonCoverageGaps({
      seasons: [
        season("a", "2026-06-01", "2026-06-30"),
        season("b", "2026-08-01", "2026-08-31"),
        season("c", "2026-10-01", "2026-10-31"),
      ],
    });
    expect(
      gaps.map((gap) => [gap.firstUncoveredNight, gap.lastUncoveredNight]),
    ).toEqual([
      ["2026-07-01", "2026-07-31"],
      ["2026-09-01", "2026-09-30"],
    ]);
  });

  it("says nothing about a schedule of one season, or of none", () => {
    expect(computeSeasonCoverageGaps({ seasons: [] })).toEqual([]);
    expect(
      computeSeasonCoverageGaps({
        seasons: [season("only", "2026-06-01", "2026-09-30")],
      }),
    ).toEqual([]);
  });

  it("does NOT report the open stretch after the last season", () => {
    // Every club has one. A warning true of every installation for ever is how
    // officers learn to ignore the panel.
    expect(
      computeSeasonCoverageGaps({
        seasons: [season("winter", "2026-06-01", "2026-09-30")],
        notBefore: day("2026-07-01"),
      }),
    ).toEqual([]);
  });

  describe("notBefore", () => {
    it("drops a hole that is wholly in the past", () => {
      // Last season's hole is not work anybody can still do.
      expect(
        computeSeasonCoverageGaps({
          seasons: [
            season("old", "2025-06-01", "2025-06-30"),
            season("winter", "2026-06-01", "2026-09-30"),
          ],
          notBefore: day("2026-07-01"),
        }),
      ).toEqual([]);
    });

    it("reports a straddling hole in FULL, past nights included", () => {
      // Its real extent is what the officer has to close, so reporting only
      // the future half would understate the window they must move.
      const [gap] = computeSeasonCoverageGaps({
        seasons: [
          season("a", "2026-05-01", "2026-05-31"),
          season("b", "2026-08-01", "2026-08-31"),
        ],
        notBefore: day("2026-07-01"),
      });
      expect(gap).toMatchObject({
        firstUncoveredNight: "2026-06-01",
        lastUncoveredNight: "2026-07-31",
        nights: 61,
      });
    });

    it("keeps a hole whose last night is today", () => {
      const [gap] = computeSeasonCoverageGaps({
        seasons: [
          season("a", "2026-05-01", "2026-06-30"),
          season("b", "2026-07-02", "2026-08-31"),
        ],
        notBefore: day("2026-07-01"),
      });
      expect(gap).toMatchObject({ lastUncoveredNight: "2026-07-01" });
    });

    it("reports every hole when it is omitted", () => {
      expect(
        computeSeasonCoverageGaps({
          seasons: [
            season("old", "2025-06-01", "2025-06-30"),
            season("winter", "2026-06-01", "2026-09-30"),
          ],
        }),
      ).toHaveLength(1);
    });
  });
});

describe("buildSeasonTimeline", () => {
  it("puts each gap immediately before the season that resumes cover", () => {
    const entries = buildSeasonTimeline({
      seasons: [
        season("summer", "2026-12-01", "2027-04-30"),
        season("winter", "2026-06-01", "2026-09-30"),
      ],
    });
    expect(
      entries.map((entry) =>
        entry.kind === "season" ? entry.season.id : "GAP",
      ),
    ).toEqual(["winter", "GAP", "summer"]);
  });

  it("puts a deactivated window ABOVE the warning it explains", () => {
    // An officer looking at a hole needs to see the window sitting in it, and
    // to see it before the sentence that says nothing covers those nights —
    // that ordering is what turns the panel into a diagnosis.
    const entries = buildSeasonTimeline({
      seasons: [
        season("winter", "2026-06-01", "2026-09-30"),
        season("retired", "2026-10-01", "2026-11-30", { active: false }),
        season("summer", "2026-12-01", "2027-04-30"),
      ],
    });
    expect(
      entries.map((entry) =>
        entry.kind === "season" ? entry.season.id : "GAP",
      ),
    ).toEqual(["winter", "retired", "GAP", "summer"]);
  });

  it("lists every season, gap or no gap", () => {
    const entries = buildSeasonTimeline({
      seasons: [
        season("winter", "2026-06-01", "2026-09-30"),
        season("summer", "2026-10-01", "2027-04-30"),
      ],
    });
    expect(entries.map((entry) => entry.kind)).toEqual(["season", "season"]);
  });

  it("carries the caller's own season object through untouched", () => {
    // The screens hand it a decoded season with the API payload attached, and
    // render from that payload — so the entry has to be the caller's object,
    // not a copy of the five fields the timeline itself reads.
    const carried = { ...season("winter", "2026-06-01", "2026-09-30"), lodge: "A" };
    const [entry] = buildSeasonTimeline({ seasons: [carried] });
    expect(entry?.kind === "season" && entry.season).toBe(carried);
  });
});
