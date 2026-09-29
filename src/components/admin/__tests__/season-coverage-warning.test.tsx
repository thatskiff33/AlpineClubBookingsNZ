// @vitest-environment jsdom

/**
 * Every sentence the season-coverage warning can render (#2938).
 *
 * `season-timeline.test.ts` proves the arithmetic is right. This file proves
 * the officer is told the right thing about it, which is a different question
 * and had a different answer: of the wording branches below, only two were ever
 * reached by a rendered test, and one of the unreached ones was ungrammatical.
 *
 * The grammar cases are not decoration. A **one-night** hole is precisely the
 * boundary slip the night count exists to make visible — the failure mode this
 * whole panel is defending against is an off-by-one at a season edge — so the
 * singular branch is a likely real rendering, not a theoretical one. This
 * repository has shipped an ungrammatical string pinned by a passing test
 * before, so each branch below is asserted as the whole sentence a reader gets
 * rather than as a fragment that would match either wording.
 *
 * Dates are written against the frozen clock's 2026-07-01.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it } from "vitest";

import { requireCalendarDate, type CalendarDate } from "@/lib/club-time";
import type { SeasonCoverageGap } from "@/lib/season-timeline";
import {
  SeasonCoverageGapNotice,
  SeasonCoverageGapSummary,
} from "@/components/admin/season-coverage-warning";

const day = (iso: string): CalendarDate => requireCalendarDate(iso);

function gap(overrides: Partial<SeasonCoverageGap> = {}): SeasonCoverageGap {
  return {
    afterSeasonId: "winter",
    afterSeasonName: "Winter 2026",
    beforeSeasonId: "summer",
    beforeSeasonName: "Summer 2026-27",
    firstUncoveredNight: day("2026-10-01"),
    lastUncoveredNight: day("2026-11-30"),
    nights: 61,
    ...overrides,
  };
}

/** The panel's text as one whitespace-normalised string, the way it is read. */
function readPanel(): string {
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

afterEach(cleanup);

describe("SeasonCoverageGapNotice", () => {
  it("names a multi-night hole as a range, with the count beside it", () => {
    render(<SeasonCoverageGapNotice gap={gap()} />);

    expect(readPanel()).toContain(
      "No season covers 1 Oct 2026 to 30 Nov 2026 — 61 nights",
    );
  });

  it("names a ONE-night hole as a single day, and says one night", () => {
    // The branch nothing rendered. A single date with "to" on the end of it
    // ("1 Oct 2026 to 1 Oct 2026") reads as a range of unknown length, which is
    // exactly the ambiguity the night count exists to remove.
    render(
      <SeasonCoverageGapNotice
        gap={gap({
          firstUncoveredNight: day("2026-10-01"),
          lastUncoveredNight: day("2026-10-01"),
          nights: 1,
        })}
      />,
    );

    const text = readPanel();
    expect(text).toContain("No season covers 1 Oct 2026 — 1 night");
    expect(text).not.toContain("1 nights");
    expect(text).not.toContain("to 1 Oct 2026");
  });

  it("names the seasons on either side, because they are what the officer moves", () => {
    render(<SeasonCoverageGapNotice gap={gap()} />);

    expect(readPanel()).toContain(
      "Winter 2026 ends the day before, and Summer 2026-27 starts the day after.",
    );
  });

  it("is an aside, not a landmark and not a live region", () => {
    // A gap is a standing fact about data already on screen. `role="alert"`
    // would interrupt on arrival, once per hole; a named `<section>` would put
    // one region per hole in the landmark list, ahead of the page's real ones.
    const { container } = render(<SeasonCoverageGapNotice gap={gap()} />);

    expect(container.firstElementChild).toHaveAttribute("role", "note");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("SeasonCoverageGapSummary", () => {
  it("says nothing at all when the schedule has no holes", () => {
    const { container } = render(<SeasonCoverageGapSummary gaps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reads as English when exactly one night is uncovered", () => {
    // The branch this issue's review found broken: reading only the COUNT out
    // of the sentence left "One night is not covered …, and a booking for one
    // of THEM is refused" — a plural pronoun under a singular count.
    render(<SeasonCoverageGapSummary gaps={[gap({ nights: 1 })]} />);

    const text = readPanel();
    expect(text).toContain(
      "One night is not covered by any active season, and a booking that includes it is refused.",
    );
    expect(text).toContain(
      "The gap is marked in the list below, between the seasons on either side of it.",
    );
    expect(text).not.toContain("one of them");
    expect(text).not.toContain("Each gap");
  });

  it("counts the nights, not the gaps, in the second sentence", () => {
    render(<SeasonCoverageGapSummary gaps={[gap()]} />);

    const text = readPanel();
    expect(text).toContain("There is a gap in the season schedule.");
    expect(text).toContain(
      "61 nights are not covered by any active season, and a booking that includes one of them is refused.",
    );
  });

  it("pluralises the gap count and totals the nights across all of them", () => {
    // The other unrendered branch. Two holes of 61 and 1 are 62 nights, and the
    // heading counts HOLES while the sentence counts NIGHTS — a summary that
    // conflated the two would read "2 nights" here.
    render(
      <SeasonCoverageGapSummary
        gaps={[
          gap(),
          gap({
            afterSeasonId: "summer",
            afterSeasonName: "Summer 2026-27",
            beforeSeasonId: "winter-27",
            beforeSeasonName: "Winter 2027",
            firstUncoveredNight: day("2027-04-01"),
            lastUncoveredNight: day("2027-04-01"),
            nights: 1,
          }),
        ]}
      />,
    );

    const text = readPanel();
    expect(text).toContain("There are 2 gaps in the season schedule.");
    expect(text).toContain(
      "62 nights are not covered by any active season, and a booking that includes one of them is refused.",
    );
    expect(text).toContain(
      "Each gap is marked in the list below, between the seasons on either side of it.",
    );
  });

  it("never suggests an amount, a zero, or a fill", () => {
    // The issue's contract in one assertion: gaps warn and must not invent
    // coverage. A summary that offered "$0.00" or "we will use the neighbouring
    // season's rates" would be the panel doing the thing the pricing engine
    // deliberately refuses to do.
    render(<SeasonCoverageGapSummary gaps={[gap()]} />);
    const text = readPanel();
    expect(text).not.toContain("$");
    expect(text).not.toMatch(/0\.00/);
  });
});
