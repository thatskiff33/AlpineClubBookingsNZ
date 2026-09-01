import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  calendarMonthHeading,
  monthKeyOfHeading,
} from "../../../e2e/helpers/calendar-navigation";

const source = (file: string): string =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("booking-calendar month heading", () => {
  it("names the month the way the calendar heading does", () => {
    expect(calendarMonthHeading("2026-07-07")).toBe("July 2026");
    expect(calendarMonthHeading("2026-12-31")).toBe("December 2026");
  });

  it("reads a displayed heading back to a comparable month", () => {
    // The walk decides which way to hop by comparing these, and `YYYY-MM` sorts
    // lexicographically, so a plain string compare is a correct month compare
    // across a year boundary too.
    expect(monthKeyOfHeading("August 2026")).toBe("2026-08");
    expect(monthKeyOfHeading(" December 2026 ")).toBe("2026-12");
    expect(monthKeyOfHeading("January 2027") > monthKeyOfHeading("December 2026")).toBe(
      true,
    );
  });

  it("round-trips every month, so no locale surprise can flip a hop", () => {
    for (let month = 1; month <= 12; month += 1) {
      const dateOnly = `2026-${String(month).padStart(2, "0")}-15`;
      expect(monthKeyOfHeading(calendarMonthHeading(dateOnly))).toBe(
        dateOnly.slice(0, 7),
      );
    }
  });

  it("refuses text that is not a month heading instead of guessing a direction", () => {
    // A misread heading would send the walk the wrong way and fail later, on a
    // day button, with a message about the wrong thing. Fail here instead.
    expect(() => monthKeyOfHeading("Select Your Dates")).toThrow(
      "Expected a calendar month heading",
    );
    expect(() => monthKeyOfHeading("Augustus 2026")).toThrow(
      "Expected a calendar month heading",
    );
  });
});

// #3221. The walk used to be TOLD which way to go, by a caller that computed the
// direction from the date it believed the calendar had opened on. A caller can
// only get that right by guessing what day it is at the club, which is a
// different day from the CI runner's for the last ~12 hours of every UTC day —
// and on the last day of a month, a different MONTH. `main` failed at
// 2026-08-31T14:30Z asserting August against a calendar correctly showing
// September, and was green on the same commit that morning.
describe("the calendar walk decides its own direction (#3221)", () => {
  const walk = source("e2e/helpers/calendar-navigation.ts");

  it("takes no direction argument any more, from anyone", () => {
    // The argument is gone rather than corrected: it could only ever be wrong.
    expect(walk).not.toContain("calendarMonthDirection");
    expect(walk).not.toContain("CalendarMonthDirection");
    for (const file of [
      "e2e/helpers/booking.ts",
      "e2e/admin-retroactive-booking.spec.ts",
    ]) {
      expect(
        source(file),
        `${file} still passes a direction to walkCalendarToMonth`,
        // Anchored to the start of a line so the word "direction" in prose
        // cannot trip it — this repository explains a removed defect at the
        // site it removed it from, and the retroactive spec's own comment says
        // a stay "can cross a month boundary in EITHER direction".
      ).not.toMatch(/^\s*direction:\s/m);
    }
  });

  it("reads the month the calendar is actually showing", () => {
    // Role-based, so the hidden streamed copy of a Suspense boundary — which is
    // out of the accessibility tree — can never be what it reads.
    expect(walk).toContain('page.getByRole("heading"');
    expect(walk).toContain("monthKeyOfHeading(shown)");
    // Compared against the target, not against anything a caller supplied.
    expect(walk).toMatch(/monthKeyOfHeading\(shown\) [!<]/);
  });

  it("waits for the heading to move before reading it again", () => {
    // A bare re-read is a single non-retrying probe: sampled mid-render it would
    // report the month just left, hop again, overshoot, and burn the bound.
    expect(walk).toMatch(/\.not\.toHaveText\(shown\)/);
  });

  it("names both the month it wanted and the one it is stuck on", () => {
    expect(walk).toContain("calendar never reached");
    expect(walk).toMatch(/showing \$\{shown\}/);
  });
});

// #2626. The member past-days test timed out at 90 s on `locator.click: Target
// page, context or browser has been closed` while "stepping back" a three-hop
// loop that had, measurably, completed ZERO hops. Two things made that possible
// and each is pinned here, because both are invisible in a passing run.
describe("calendar month walk cannot burn a test budget (#2626)", () => {
  const walk = source("e2e/helpers/calendar-navigation.ts");
  const spec = source("e2e/admin-retroactive-booking.spec.ts");

  it("checks the nav control is actionable before clicking, and bounds the click", () => {
    // `playwright.config.ts` sets no `actionTimeout`, so Playwright's default of
    // 0 — wait until the TEST is killed — applies to every bare `click()`. A hop
    // count bounds the number of clicks, never the time, so the walk's own
    // arrival assertion is unreachable unless each click is bounded too.
    expect(walk).toContain("toBeEnabled()");
    expect(walk).toMatch(/\.click\(\{\s*timeout:/);
    expect(walk).toContain("never became actionable");
    expect(walk).toContain("calendar never reached");
  });

  it("fails on the calendar being absent, before it tries to click anything", () => {
    // The walk now reads the heading before its first hop, so "the calendar is
    // not on this page" — an open onboarding modal is the usual cause — has to
    // fail as itself rather than as an unbounded click on a control that will
    // never appear.
    expect(walk).toContain("month heading never appeared");
  });

  it("leaves no hand-rolled walk or gate dismissal in the retroactive spec", () => {
    // The gate opens on its PROFILE step for the demo-seed personas, which the
    // spec's private copy had no branch for — so it returned with the modal still
    // over the calendar. The shared helper is the only correct one.
    expect(spec).toContain("completeMemberDetailsGateIfShown");
    expect(spec).not.toContain("dismissDetailsGateIfShown");
    // Both of this spec's walks go through the shared, bounded one.
    expect(spec).not.toMatch(/getByRole\("button", \{ name: \/Prev\/ \}\)/);
    expect(spec.match(/walkCalendarToMonth\(page, \{/g) ?? []).toHaveLength(2);
  });

  it("keeps the shared forward walk on the same bounded path", () => {
    const booking = source("e2e/helpers/booking.ts");
    expect(booking).toContain("walkCalendarToMonth(page, {");
    expect(booking).not.toMatch(/getByRole\("button", \{ name: \/Next\/ \}\)/);
  });

  // The walk bounds its own hops, then hands the DAY click back to its caller.
  // Both callers are checked here because an unbounded one is invisible in a
  // passing run and costs the whole 90 s budget in a failing one: arrival being
  // asserted removes the common cause (wrong month) but not a day that resolves
  // and is not actionable — disabled as past, out of season, availability still
  // loading. Grep both call sites, since the bound has no runtime enforcement.
  it("bounds the day click each walk hands back to its caller", () => {
    const dayClick =
      /calendarDayLabel\(dateOnly\) \}\)\s*\.click\(\{\s*timeout: CALENDAR_CLICK_TIMEOUT_MS,?\s*\}\)/;
    const bareDayClick = /calendarDayLabel\(\w+\) \}\)\s*\.click\(\)/;
    for (const file of [
      "e2e/helpers/booking.ts",
      "e2e/admin-retroactive-booking.spec.ts",
    ]) {
      const text = source(file);
      expect(text, `${file} must bound its calendar day click`).toMatch(dayClick);
      expect(text, `${file} has an unbounded calendar day click`).not.toMatch(
        bareDayClick,
      );
    }
    // One constant for the hop click and the day click, so they cannot drift.
    expect(walk).toContain("export const CALENDAR_CLICK_TIMEOUT_MS = 15_000;");
  });

  // With the direction derived, `maxHops` is the ONLY remaining check that the
  // caller's belief about where the calendar is matches reality — so a loose
  // bound is no longer free head-room, it is the check being switched off. The
  // retroactive walks cross at most one month boundary each.
  it("keeps the retroactive hop bound tight enough to still be a check", () => {
    const bound = /const MAX_PAST_MONTH_HOPS = (\d+);/.exec(spec);
    expect(bound, "MAX_PAST_MONTH_HOPS is no longer declared").not.toBeNull();
    expect(Number(bound?.[1])).toBeLessThanOrEqual(3);
  });
});
