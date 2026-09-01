/**
 * The E2E suite's "today" is the CLUB's day, not the CI runner's.
 *
 * ## The failure this pins
 *
 * `Playwright E2E` is a required check, and on 31 August 2026 it went red on
 * `main` — and therefore on every open pull request — on
 * `e2e/admin-retroactive-booking.spec.ts`, three times in a row (initial plus
 * both retries, so not a flake). The same commit had passed that morning.
 *
 * ```
 * calendar is not showing August 2026, which the caller expected it to be on
 * already, and no "Prev"/"Next" hop can help
 * (retroactive stay day 2026-08-24, from the month showing 2026-08-31)
 * ```
 *
 * The Playwright process runs on the GitHub runner, whose zone is UTC. The app
 * runs in the compose stack with `TZ=Pacific/Auckland` (`docker-compose.yml`),
 * and `BookingCalendar` seeds the month it opens on from
 * `useClubTime().today()` — the CLUB's calendar day (`INV-CONFIG-002`,
 * `INV-DATE-019`; `docs/guides/club-time.md`). At 14:30 UTC on 31 August the
 * runner still said 31 August while the club had been in September for two and a
 * half hours, so the spec told `walkCalendarToMonth` "you are already showing
 * August", the walk clicked nothing, and the August day button it then wanted
 * was not rendered.
 *
 * That is a real-calendar dependency in a test, which `AGENTS.md` forbids
 * outright for unit tests and which four separate rollovers have already used to
 * turn `main` and every open pull request red at once. E2E necessarily runs
 * against a real clock, so the fix is not to freeze time: it is to make the
 * suite's REASONING about dates correct, by counting every civil date from the
 * club's day. `prisma/e2e-fixtures.ts` already owned that — `E2E_TODAY_NZ` and
 * `relDateOnly` — and the specs were quietly running their own local-time
 * `new Date()` arithmetic beside it.
 *
 * ## Why the frozen clock cannot catch this on its own
 *
 * The default frozen instant is `2026-07-01T00:00:00.000Z`, deliberately chosen
 * as midday in New Zealand so that UTC and the club agree on the date. Under it,
 * the correct and the broken derivations return the SAME string — so a test that
 * only ever runs at the default instant is vacuous here. Every test below pins
 * its own boundary instant, and the two host zones are named explicitly rather
 * than left to the machine the suite happens to run on.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";
import { withTimeZoneAsync } from "./helpers/timezone";

// 14:30:03 UTC on the last day of a UTC month. In Pacific/Auckland (NZST,
// UTC+12) that is 02:30 on 1 September — the club is a MONTH ahead of the
// runner. This is the exact instant `main` failed at, not an invented one.
const BOUNDARY_INSTANT = "2026-08-31T14:30:03.000Z";

// The runner's zone (GitHub `ubuntu-latest`) and the club's, named explicitly.
// A single-zone check here would pass vacuously on a developer box that already
// sits in Pacific/Auckland.
const RUNNER_ZONE = "UTC";
const CLUB_ZONE = "Pacific/Auckland";

const MS_PER_DAY = 86_400_000;

/** Whole months from `from`'s month to `to`'s month. Negative = backwards. */
function monthsBetween(from: string, to: string): number {
  const ordinal = (dateOnly: string) =>
    Number(dateOnly.slice(0, 4)) * 12 + Number(dateOnly.slice(5, 7)) - 1;
  return ordinal(to) - ordinal(from);
}

/** The bound a spec gives `walkCalendarToMonth`, read from its own source. */
function maxHopsIn(file: string, constant: string): number {
  const source = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
  const marker = `const ${constant} = `;
  const at = source.indexOf(marker);
  const digits =
    at < 0 ? null : /^\d+/.exec(source.slice(at + marker.length))?.[0];
  if (!digits) {
    throw new Error(
      `${file}: ${constant} not found as an integer literal — this guard ` +
        `cannot read the hop bound it is about to check`,
    );
  }
  return Number(digits);
}

function nextDay(dateOnly: string): string {
  return new Date(Date.parse(`${dateOnly}T00:00:00.000Z`) + MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * The E2E date space, re-evaluated at `instant`.
 *
 * `E2E_TODAY_NZ` is frozen at module load ("one today per process", by design),
 * so moving the clock is not enough — the modules have to be re-imported behind
 * it. Without the reset this whole file would silently assert against
 * `2026-07-01`, which is the one instant that cannot tell the bug from the fix.
 */
async function e2eDateSpaceAt(instant: string) {
  vi.setSystemTime(new Date(instant));
  vi.resetModules();
  const fixtures = await import("../../../prisma/e2e-fixtures");
  const stayDates = await import("../../../e2e/helpers/stay-dates");
  return { ...fixtures, ...stayDates };
}

afterEach(() => {
  vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
  vi.resetModules();
});

describe("the club's day at a UTC month boundary", () => {
  it("is the NEXT month, in either host zone", async () => {
    for (const zone of [RUNNER_ZONE, CLUB_ZONE]) {
      await withTimeZoneAsync(zone, async () => {
        const { relDateOnly, E2E_TODAY_NZ } =
          await e2eDateSpaceAt(BOUNDARY_INSTANT);
        expect(E2E_TODAY_NZ, `host zone ${zone}`).toBe("2026-09-01");
        expect(relDateOnly(0), `host zone ${zone}`).toBe("2026-09-01");
      });
    }
  });

  // The boundary instant above is the one that actually fired. These are the
  // other shapes of the same hazard, each an instant plus the club date it really
  // falls on — a year boundary and both New Zealand daylight-saving switches,
  // where the offset is UTC+13 rather than UTC+12 and an hour-arithmetic fix
  // would look right and be wrong.
  const OTHER_BOUNDARIES: ReadonlyArray<[instant: string, clubDay: string]> = [
    ["2026-12-31T13:00:00.000Z", "2027-01-01"],
    ["2026-04-04T14:30:00.000Z", "2026-04-05"],
    ["2026-09-26T13:30:00.000Z", "2026-09-27"],
    // One second BEFORE the window opens, so the cases above cannot pass by
    // always answering "tomorrow".
    ["2026-08-31T11:59:59.000Z", "2026-08-31"],
  ];

  it.each(OTHER_BOUNDARIES)(
    "reads %s as the club day %s, in either host zone",
    async (instant, clubDay) => {
      for (const zone of [RUNNER_ZONE, CLUB_ZONE]) {
        await withTimeZoneAsync(zone, async () => {
          const { E2E_TODAY_NZ } = await e2eDateSpaceAt(instant);
          expect(E2E_TODAY_NZ, `host zone ${zone}`).toBe(clubDay);
        });
      }
    },
  );

  it("is one real month back from the retroactive spec's past band", async () => {
    // The month boundary the walk has to cross. `walkCalendarToMonth` now reads
    // the displayed heading and picks its own direction (#3221), so what still
    // has to be true is that the club-derived past band is inside the spec's own
    // hop bound — which is the ONLY remaining check that the caller's belief
    // about where the calendar is matches reality.
    //
    // Under the old runner-derived "today" the spec asserted ZERO boundaries
    // here (31 August and 24 August are the same month) while the calendar had
    // been on September for hours — that is precisely the failure.
    await withTimeZoneAsync(RUNNER_ZONE, async () => {
      const { relDateOnly, pastStayWindowForAttempt } =
        await e2eDateSpaceAt(BOUNDARY_INSTANT);

      const displayed = relDateOnly(0);
      const bound = maxHopsIn(
        "e2e/admin-retroactive-booking.spec.ts",
        "MAX_PAST_MONTH_HOPS",
      );
      expect(displayed).toBe("2026-09-01");

      for (const retry of [0, 1, 2]) {
        const { checkIn, checkOut } = pastStayWindowForAttempt(retry);
        expect(
          Math.abs(monthsBetween(displayed, checkIn)),
          `retry ${retry}: hops from the club month ${displayed} to ${checkIn}`,
        ).toBeLessThanOrEqual(bound);
        // Then check-out, from the month the check-in left the calendar on.
        expect(
          Math.abs(monthsBetween(checkIn, checkOut)),
          `retry ${retry}: hops from ${checkIn} to ${checkOut}`,
        ).toBeLessThanOrEqual(bound);
      }

      // The specific crossing this instant creates, spelled out so the numbers
      // above cannot go vacuous.
      expect(pastStayWindowForAttempt(0).checkIn).toBe("2026-08-25");
      expect(monthsBetween(displayed, "2026-08-25")).toBe(-1);
    });
  });

  it("keeps the past band, the leftover sweep and the seasons on ONE today", async () => {
    await withTimeZoneAsync(RUNNER_ZONE, async () => {
      const {
        relDateOnly,
        pastStayWindowForAttempt,
        pastStayLeftoverCheckIns,
        seasonForWindow,
      } = await e2eDateSpaceAt(BOUNDARY_INSTANT);

      // Every attempt's window is counted from the club's day, so the sweep that
      // clears a previous run's leftover still covers all three of them.
      const swept = pastStayLeftoverCheckIns();
      for (const retry of [0, 1, 2]) {
        const window = pastStayWindowForAttempt(retry);
        expect(swept).toContain(window.checkIn);
        // Same "today", so the relative seasons the seed wrote still contain the
        // window. This is the check that used to compare a runner-derived window
        // against club-derived season edges.
        expect(seasonForWindow(window)).toBe("winter");
      }
      expect(swept[0]).toBe(relDateOnly(-16));
      expect(swept.at(-1)).toBe(relDateOnly(-6));
    });
  });

  it("puts the member calendar's fully-past month a real month back", async () => {
    // `relDateOnly(-32)` is walked to with `maxHops: 3`. From the CLUB's month,
    // -32 days is one or two months back on any run date, so the bound holds —
    // the point of checking it at the boundary is that the month the walk starts
    // from is the club's, not the runner's.
    await withTimeZoneAsync(RUNNER_ZONE, async () => {
      const { relDateOnly } = await e2eDateSpaceAt(BOUNDARY_INSTANT);
      const displayed = relDateOnly(0);
      const lastMonth = relDateOnly(-32);
      expect(lastMonth).toBe("2026-07-31");
      expect(monthsBetween(displayed, lastMonth)).toBe(-2);
      expect(Math.abs(monthsBetween(displayed, lastMonth))).toBeLessThanOrEqual(3);
    });
  });

  it("does not drift the forward stay windows off their weekday", async () => {
    // `stayWindow` now counts from the club's day too, and its Monday walk is
    // UTC-anchored so no host zone and no DST edge can move a weekday.
    for (const zone of [RUNNER_ZONE, CLUB_ZONE]) {
      await withTimeZoneAsync(zone, async () => {
        const { stayWindow } = await e2eDateSpaceAt(BOUNDARY_INSTANT);
        for (const index of [0, 5, 12]) {
          const window = stayWindow(index);
          expect(
            new Date(`${window.checkIn}T00:00:00.000Z`).getUTCDay(),
            `stayWindow(${index}) check-in ${window.checkIn} in host zone ${zone}`,
          ).toBe(1);
          expect(window.nights).toEqual([window.checkIn, nextDay(window.checkIn)]);
          expect(window.checkOut).toBe(nextDay(nextDay(window.checkIn)));
        }
      });
    }
  });

  it("agrees at the default frozen instant, which is why the pins above exist", async () => {
    // Midday NZ: the runner and the club are on the same date, so a derivation
    // that reads the host clock and one that reads the club's are
    // indistinguishable. Stated as an assertion so nobody "simplifies" the
    // boundary pins above away believing the default instant covers this.
    await withTimeZoneAsync(RUNNER_ZONE, async () => {
      const { relDateOnly } = await e2eDateSpaceAt(FROZEN_TEST_CLOCK_BASE_ISO);
      expect(relDateOnly(0)).toBe("2026-07-01");
      expect(new Date().toISOString().slice(0, 10)).toBe("2026-07-01");
    });
  });
});

// The STRUCTURAL half of this rule — "the E2E date space has exactly one
// argument-less `new Date()`, and it reads the club's zone" — lives in
// `e2e-club-day-census.test.ts`, with a counted allowlist. It is deliberately
// not restated here (`INV-SSOT`): this file is about what the dates COME OUT AS
// at a month boundary, that one is about where they may be computed.
