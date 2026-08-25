import { afterEach, describe, expect, it, vi } from "vitest";

import {
  calendarDateOfDateOnlyInstant,
  clubCalendarDateOf,
  countClubNights,
  formatClubDate,
  formatClubInstantDate,
  formatClubInstantDateTime,
  requireCalendarDate,
  requireClubTimeZone,
  requireInstant,
  stayWindow,
  type ClubTimeZone,
} from "@/lib/club-time";
import { computeAge } from "@/lib/policies/age-tier";
import { getAdminCalendarBookingDayRange } from "@/lib/admin-booking-calendar-ranges";
import { captureHostTimeZone, withTimeZone } from "./helpers/timezone";

/**
 * CT-6 (#2991) — the HOST-PROCESS matrix.
 *
 * ## The claim, and why proving it is harder than it looks
 *
 * The epic's product contract is that "viewer/browser/server/container/database
 * -session timezone must not change product behaviour". This file is the
 * container half of that: with the club's configured zone held fixed, every
 * club-facing answer must be identical no matter what zone the process runs in.
 *
 * A matrix like this is worth nothing unless each row's PREMISE is proved — that
 * the execution zone really moved — and proved in CIVIL-TIME terms rather than
 * by comparing identifiers. Asserting `process.env.TZ === "America/Denver"`
 * proves a string was assigned; it does not prove `Date` and `Intl` moved with
 * it, and on this repository's documented shell they frequently do not (see
 * below). So every row below first shows the host giving a materially DIFFERENT
 * civil answer at one fixed instant, and only then shows the club's answer
 * holding still.
 *
 * The premise probe reads the host's own clock deliberately, through an
 * `Intl.DateTimeFormat` with `timeZone: undefined` written explicitly — the
 * documented way to say "follow the reader's clock" past the unzoned-formatter
 * ban. It is the one legitimate use: a test proving the club's answer is NOT the
 * host's cannot establish that without asking the host.
 *
 * A premise failure here is a FAILURE and never a skip (owner decision, #2870).
 * A row that quietly stops discriminating is exactly the disease this epic
 * exists to cure.
 *
 * ## Why the lever is `withTimeZone` and not the shell
 *
 * `docs/TESTING.md` used to send a reader to `TZ=… npx vitest`. **That is a
 * silent no-op on this repository's documented shell**, measured independently
 * by three lanes on this epic and re-measured here: Git Bash on Windows drops
 * any `TZ` value containing a `/`, so `TZ=America/Denver` arrives as `undefined`
 * and the process keeps the machine's own zone — while `TZ=UTC`, having no
 * slash, works. A matrix built on that lever would report six rows and measure
 * one, and every row would agree because every row would be the same zone.
 *
 * The levers that do work in-process are the two used here: assigning
 * `process.env.TZ` (which is what `withTimeZone` does, and what Node re-reads
 * its cached zone from on ASSIGNMENT — never on `delete`, #2485), and
 * `vi.resetModules()` plus a dynamic import for anything frozen at module load.
 * The second matters because `APP_TIME_ZONE` is read once when
 * `src/config/operational.ts` is first evaluated: `withTimeZone` alone moves the
 * host and leaves that constant where it was, so a suite using only the first
 * lever cannot tell the two apart. Measured on this epic: the same wrong pin
 * killed 1 test in the file that used both mechanisms and 0 in the file that
 * used only the first.
 */

/**
 * One fixed instant, chosen so that the rows below genuinely disagree.
 *
 * 10:30 UTC is inside the one hour of the day during which THREE calendar days
 * exist on earth simultaneously — `UTC+14` has turned over and `UTC-11` has not.
 * That is what lets the matrix carry rows on both sides of the date line and
 * still have the club's own answer be a third, distinct day.
 */
const INSTANT = requireInstant("2026-08-15T10:30:00.000Z");

/**
 * The club's configured zone, held fixed across every row. Deliberately NOT
 * `Pacific/Auckland`: that is what `APP_TIME_ZONE` falls back to, so a club on
 * it could not be told apart from the environment's claim.
 */
const CLUB_ZONE: ClubTimeZone = requireClubTimeZone("America/Denver");

/**
 * The host zones each row runs under. `UTC` is the CI runner's own zone;
 * `Pacific/Auckland` is both this repository's shipped default and a real
 * developer machine's; the rest span the offset range from `UTC-11` to `UTC+14`
 * so the matrix covers hosts on either side of the club and of the date line.
 *
 * `Pacific/Kiritimati` is the row that matters most: at the instant above it
 * reads a different CALENDAR DAY from the club, so a host-local implementation
 * does not merely shift an hour, it names the wrong lodge night.
 */
const HOST_ZONES = [
  "UTC",
  "Pacific/Auckland",
  "America/Denver",
  "Europe/Berlin",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
] as const;

/** The host's OWN civil answer — the one legitimate unzoned read. */
function hostCivilDateTime(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: undefined,
    dateStyle: "short",
    timeStyle: "short",
    hour12: false,
  }).format(INSTANT);
}

/** The host's own calendar day, in the shape a lodge night is stored as. */
function hostCalendarDay(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: undefined }).format(
    INSTANT,
  );
}

/**
 * Every club-facing answer the matrix holds still, computed once per row.
 *
 * These are the real subjects, not stand-ins: projecting an instant into the
 * club's calendar, decoding a STORED lodge night, the noon-to-noon stay window
 * whose instants a provider and an email both quote, two rendered strings a
 * member reads, the night count capacity is charged from, the admin calendar
 * grid, and the age that selects a price band (#3082).
 */
function clubFacingAnswers(): Record<string, unknown> {
  const checkIn = requireCalendarDate("2026-09-25");
  const checkOut = requireCalendarDate("2026-09-28");
  const storedNight = requireInstant("2026-09-25T00:00:00.000Z");
  const window = stayWindow(checkIn, checkOut, CLUB_ZONE);

  return {
    projectedInstant: clubCalendarDateOf(INSTANT, CLUB_ZONE),
    decodedStoredNight: calendarDateOfDateOnlyInstant(storedNight),
    stayArrivalIso: window.arrival.toISOString(),
    stayDepartureIso: window.departure.toISOString(),
    stayNights: window.nights,
    renderedCalendarDay: formatClubDate(checkIn),
    renderedInstantDate: formatClubInstantDate(INSTANT, CLUB_ZONE),
    renderedInstantDateTime: formatClubInstantDateTime(INSTANT, CLUB_ZONE),
    nights: countClubNights(checkIn, checkOut),
    adminCalendarRange: getAdminCalendarBookingDayRange(
      { checkIn: "2026-09-25", checkOut: "2026-09-28" },
      2026,
      8,
    ),
    // A birthday exactly on the season boundary, which is where a host-local
    // read costs a member a price band rather than a cosmetic hour.
    ageOnBoundary: computeAge(
      new Date("2008-04-01T00:00:00.000Z"),
      new Date("2026-04-01T00:00:00.000Z"),
    ),
  };
}

const hostTimeZone = captureHostTimeZone();

afterEach(() => {
  hostTimeZone.restore();
  vi.resetModules();
});

describe("the matrix premise: each row's host really answers differently", () => {
  it("gives a materially different civil answer in every row", () => {
    const answers = new Map<string, string>();
    for (const zone of HOST_ZONES) {
      withTimeZone(zone, () => {
        answers.set(zone, hostCivilDateTime());
      });
    }

    // Not "the identifiers differ" — the CIVIL ANSWERS differ. Six distinct
    // wall-clock readings of one instant is what makes the invariance claim
    // below worth making; if a row's host silently failed to move, two rows
    // would collapse onto one answer and this fails rather than passing
    // vacuously with a matrix that measured one zone six times.
    expect(new Set(answers.values()).size).toBe(HOST_ZONES.length);
  });

  it("puts hosts on BOTH sides of the club's calendar day", () => {
    const days = new Map<string, string>();
    for (const zone of HOST_ZONES) {
      withTimeZone(zone, () => {
        days.set(zone, hostCalendarDay());
      });
    }

    const clubDay = clubCalendarDateOf(INSTANT, CLUB_ZONE);
    expect(clubDay).toBe("2026-08-15");
    // Ahead of the club, and behind it. A matrix whose hosts all sat on one
    // side could not catch an implementation that is wrong in one direction.
    expect(days.get("Pacific/Kiritimati")).toBe("2026-08-16");
    expect(days.get("Pacific/Pago_Pago")).toBe("2026-08-14");
    expect(new Set(days.values())).toEqual(
      new Set(["2026-08-14", "2026-08-15", "2026-08-16"]),
    );
  });

  it("moves APP_TIME_ZONE itself when the module graph is re-imported", async () => {
    // The second lever, and the premise for the second matrix below. Without
    // this assertion that matrix would be six identical runs of one
    // configuration, which is precisely the shape that has passed while
    // measuring nothing on this epic.
    const seen = new Map<string, string>();
    for (const zone of HOST_ZONES) {
      vi.resetModules();
      process.env.TZ = zone;
      const { APP_TIME_ZONE } = await import("@/config/operational");
      seen.set(zone, APP_TIME_ZONE);
    }
    hostTimeZone.restore();

    for (const zone of HOST_ZONES) {
      expect(seen.get(zone)).toBe(zone);
    }
  });
});

describe("club-facing answers do not move when the host does", () => {
  it("is identical in all six host zones", () => {
    const rows = HOST_ZONES.map((zone) => ({
      zone,
      answers: withTimeZone(zone, () => clubFacingAnswers()),
    }));

    const [first, ...rest] = rows;
    for (const row of rest) {
      // Compared as a whole object rather than field by field, so a new club
      // -facing subject added to `clubFacingAnswers` is covered the moment it is
      // added rather than when somebody remembers to assert it.
      expect(
        row.answers,
        `the club's answers under host ${row.zone} differ from under ${first.zone}`,
      ).toEqual(first.answers);
    }
  });

  it("is identical when APP_TIME_ZONE moves with the host", async () => {
    // The stronger row: the whole module graph is re-evaluated under each zone,
    // so `APP_TIME_ZONE` and every module-load `Intl` constant move too. This is
    // what catches a formatter pinned at import, which `withTimeZone` alone
    // cannot reach.
    const rows: Array<{ zone: string; answers: unknown }> = [];
    for (const zone of HOST_ZONES) {
      vi.resetModules();
      process.env.TZ = zone;

      const clubTime = await import("@/lib/club-time");
      const { computeAge: freshComputeAge } = await import(
        "@/lib/policies/age-tier"
      );
      const { getAdminCalendarBookingDayRange: freshRange } = await import(
        "@/lib/admin-booking-calendar-ranges"
      );

      const clubZone = clubTime.requireClubTimeZone("America/Denver");
      const checkIn = clubTime.requireCalendarDate("2026-09-25");
      const checkOut = clubTime.requireCalendarDate("2026-09-28");
      const window = clubTime.stayWindow(checkIn, checkOut, clubZone);

      rows.push({
        zone,
        answers: {
          projectedInstant: clubTime.clubCalendarDateOf(INSTANT, clubZone),
          decodedStoredNight: clubTime.calendarDateOfDateOnlyInstant(
            clubTime.requireInstant("2026-09-25T00:00:00.000Z"),
          ),
          stayArrivalIso: window.arrival.toISOString(),
          stayDepartureIso: window.departure.toISOString(),
          renderedCalendarDay: clubTime.formatClubDate(checkIn),
          renderedInstantDateTime: clubTime.formatClubInstantDateTime(
            INSTANT,
            clubZone,
          ),
          adminCalendarRange: freshRange(
            { checkIn: "2026-09-25", checkOut: "2026-09-28" },
            2026,
            8,
          ),
          ageOnBoundary: freshComputeAge(
            new Date("2008-04-01T00:00:00.000Z"),
            new Date("2026-04-01T00:00:00.000Z"),
          ),
        },
      });
    }
    hostTimeZone.restore();

    const [first, ...rest] = rows;
    for (const row of rest) {
      expect(
        row.answers,
        `the club's answers with APP_TIME_ZONE at ${row.zone} differ from ${first.zone}`,
      ).toEqual(first.answers);
    }
  });

  it("holds the answers the club actually gives, not merely equal ones", () => {
    // Six rows agreeing on a wrong answer would satisfy the two tests above.
    // These are the club's real answers, hand-written, so a kernel that became
    // uniformly wrong is caught here rather than certified by its own
    // consistency.
    const answers = withTimeZone("Pacific/Kiritimati", () =>
      clubFacingAnswers(),
    );
    expect(answers.projectedInstant).toBe("2026-08-15");
    expect(answers.decodedStoredNight).toBe("2026-09-25");
    expect(answers.stayNights).toBe(3);
    expect(answers.nights).toBe(3);
    // Noon in Denver on the check-in day, and noon on the check-out day. Denver
    // is UTC-6 in September (MDT), so club noon is 18:00 UTC.
    expect(answers.stayArrivalIso).toBe("2026-09-25T18:00:00.000Z");
    expect(answers.stayDepartureIso).toBe("2026-09-28T18:00:00.000Z");
    // September 2026 is month index 8. The stay occupies the nights of the
    // 25th, 26th and 27th; the check-out day is not an occupied night.
    expect(answers.adminCalendarRange).toEqual({ start: 25, end: 27 });
    // Born 1 April 2008, measured on 1 April 2026: eighteen exactly, on the
    // boundary. A host-local read west of Greenwich returns seventeen (#3082).
    expect(answers.ageOnBoundary).toBe(18);
  });
});
