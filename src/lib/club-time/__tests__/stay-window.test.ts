/**
 * The noon-to-noon stay window across DST (CT-2, #2990; epic #2988 decision 4).
 *
 * THE MUTATION THAT MATTERS: derive `departure` as
 * `arrival + nights * 86_400_000`. The 25-hour and 23-hour rows below fail, and
 * the club-local reading of `departure` stops being noon.
 */
import { describe, expect, it } from "vitest";

import { requireCalendarDate } from "../calendar-date";
import { clubWallTimeOf } from "../instant";
import { stayWindow } from "../stay-window";
import { requireClubTimeZone } from "../zone";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

const cd = requireCalendarDate;
const AUCKLAND = requireClubTimeZone("Pacific/Auckland");
const DENVER = requireClubTimeZone("America/Denver");
const HOUR = 3_600_000;

describe("arrival and departure are midday club time, not a multiple of 24 hours", () => {
  it.each([
    ["an ordinary window", "2026-07-01", "2026-07-02", 24, 1],
    ["the night NZDT ends (25 elapsed hours)", "2026-04-04", "2026-04-05", 25, 1],
    ["the night NZDT begins (23 elapsed hours)", "2026-09-26", "2026-09-27", 23, 1],
    ["a window spanning the end of NZDT", "2026-04-03", "2026-04-06", 73, 3],
  ])("%s", (_label, checkIn, checkOut, elapsedHours, nights) => {
    const window = stayWindow(cd(checkIn), cd(checkOut), AUCKLAND);
    expect(window.nights).toBe(nights);
    expect(
      (window.departure.getTime() - window.arrival.getTime()) / HOUR,
    ).toBe(elapsedHours);
    // Both endpoints really are noon in the club's zone.
    expect(clubWallTimeOf(window.arrival, AUCKLAND)).toMatchObject({
      date: checkIn,
      hour: 12,
      minute: 0,
    });
    expect(clubWallTimeOf(window.departure, AUCKLAND)).toMatchObject({
      date: checkOut,
      hour: 12,
      minute: 0,
    });
  });

  it("proves elapsed hours cannot substitute for a calendar night count", () => {
    /*
      A guard asserting only `nights === 1` on the 25-hour row would pass with an
      elapsed-time implementation, because 25/24 rounds to 1. So the assertion is
      that BOTH obvious elapsed-time spellings disagree with the calendar answer
      on at least one row.
    */
    const window = stayWindow(cd("2026-04-04"), cd("2026-04-05"), AUCKLAND);
    const elapsedDays =
      (window.departure.getTime() - window.arrival.getTime()) / 86_400_000;
    expect(Math.floor(elapsedDays)).toBe(1);
    expect(elapsedDays).toBeGreaterThan(1);
    const short = stayWindow(cd("2026-09-26"), cd("2026-09-27"), AUCKLAND);
    const shortDays =
      (short.departure.getTime() - short.arrival.getTime()) / 86_400_000;
    expect(Math.floor(shortDays)).toBe(0); // elapsed/24 floors to ZERO nights
    expect(short.nights).toBe(1);
  });
});

describe("the window keeps its date-only identities", () => {
  it("hands back exactly the days it was given", () => {
    const window = stayWindow(cd("2026-04-03"), cd("2026-04-06"), AUCKLAND);
    expect(window.checkIn).toBe("2026-04-03");
    expect(window.checkOut).toBe("2026-04-06");
  });

  it("refuses a zero-night or inverted range (INV-DATE-008)", () => {
    expect(() => stayWindow(cd("2026-07-01"), cd("2026-07-01"), AUCKLAND)).toThrow(
      /at least one lodge night/,
    );
    expect(() => stayWindow(cd("2026-07-02"), cd("2026-07-01"), AUCKLAND)).toThrow(
      /at least one lodge night/,
    );
  });

  it("works for a club behind UTC, where noon is the previous UTC day", () => {
    const window = stayWindow(cd("2026-07-01"), cd("2026-07-03"), DENVER);
    expect(window.nights).toBe(2);
    expect(window.arrival.toISOString()).toBe("2026-07-01T18:00:00.000Z");
    expect(clubWallTimeOf(window.arrival, DENVER)).toMatchObject({
      date: "2026-07-01",
      hour: 12,
    });
  });
});

describe("the host machine's timezone is irrelevant", () => {
  it("gives identical windows under UTC and America/Los_Angeles", () => {
    const answersIn = (hostZone: string) =>
      withTimeZone(hostZone, () => {
        const window = stayWindow(cd("2026-04-03"), cd("2026-04-06"), AUCKLAND);
        return {
          arrival: window.arrival.toISOString(),
          departure: window.departure.toISOString(),
          nights: window.nights,
        };
      });
    expect(answersIn("UTC")).toEqual(answersIn("America/Los_Angeles"));
  });
});
