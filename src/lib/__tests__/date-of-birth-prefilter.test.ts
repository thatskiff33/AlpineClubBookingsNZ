import { describe, expect, it } from "vitest";

import { getSeasonStartDate } from "@/lib/policies/age-tier";
import { dateOfBirthPrefilterBoundForMinAge } from "@/lib/date-of-birth-prefilter";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/**
 * The age-up candidate prefilter's date-of-birth bound (#2859, #2872).
 *
 * TWO SHIPPED OFF-BY-ONES ARE PINNED HERE, and they pull in opposite
 * directions, which is why the bound needs a suite of its own rather than only
 * the one assertion `cron-age-up.test.ts` makes through the query:
 *
 * - #2859 — a bound at the cutoff INSTANT dropped the member born on exactly
 *   the season-start anniversary, because a local-midnight cutoff sits hours
 *   after a UTC-midnight date of birth. The fix widens to the end of the cutoff
 *   calendar day.
 * - #2872 — that widened bound still had to be a CALENDAR DAY, because
 *   `Member.dateOfBirth` is `@db.Date` and the adapter narrows a bound `Date`
 *   to its UTC day. A local-midnight instant east of UTC narrows to the day
 *   BEFORE, which reopens #2859.
 *
 * EVERY ASSERTION RUNS UNDER THREE HOST ZONES, one behind UTC and one ahead, so
 * a bound that quietly depends on the container cannot pass. That is the whole
 * claim of #2872 and a suite pinned to this machine's zone could not make it.
 */

/** One zone behind UTC, one ahead, and UTC itself. */
const HOST_ZONES = ["UTC", "America/Denver", "Pacific/Auckland"];

function onEveryHostZone(assert: (hostZone: string) => void): void {
  for (const hostZone of HOST_ZONES) {
    withTimeZone(hostZone, () => assert(hostZone));
  }
}

describe("the age-tier date-of-birth prefilter bound", () => {
  it("is the UTC-midnight day AFTER the cutoff day, on every host zone", () => {
    onEveryHostZone((hostZone) => {
      // 1 April 2026 as `getSeasonStartDate` builds it: HOST-LOCAL midnight.
      const bound = dateOfBirthPrefilterBoundForMinAge(
        new Date(2026, 3, 1),
        18,
      );

      expect(bound.toISOString(), hostZone).toBe("2008-04-02T00:00:00.000Z");
    });
  });

  it("admits the member born on exactly the season-start anniversary (#2859)", () => {
    onEveryHostZone((hostZone) => {
      const bound = dateOfBirthPrefilterBoundForMinAge(
        new Date(2026, 3, 1),
        18,
      );

      // A stored date of birth is UTC midnight (INV-DATE-024). This member turns
      // 18 on season start and must be proposed; the pre-#2859 bound excluded
      // them, one season late for their own age-up.
      const bornOnTheAnniversary = new Date("2008-04-01T00:00:00.000Z");
      expect(bornOnTheAnniversary < bound, hostZone).toBe(true);
    });
  });

  it("excludes the member born the day after, so it is not merely wide", () => {
    onEveryHostZone((hostZone) => {
      const bound = dateOfBirthPrefilterBoundForMinAge(
        new Date(2026, 3, 1),
        18,
      );
      const bornTheDayAfter = new Date("2008-04-02T00:00:00.000Z");

      expect(bornTheDayAfter < bound, hostZone).toBe(false);
    });
  });

  it("is a pure UTC-midnight encoding, which is the only shape @db.Date keeps", () => {
    // `@prisma/adapter-pg` narrows a bound `Date` for a `@db.Date` column to its
    // UTC calendar date and discards the time. Any non-zero UTC time component
    // here would mean the value carries information the column silently drops.
    onEveryHostZone((hostZone) => {
      const bound = dateOfBirthPrefilterBoundForMinAge(
        new Date(2026, 3, 1),
        18,
      );

      expect(
        [
          bound.getUTCHours(),
          bound.getUTCMinutes(),
          bound.getUTCSeconds(),
          bound.getUTCMilliseconds(),
        ],
        hostZone,
      ).toEqual([0, 0, 0, 0]);
    });
  });

  it("names the same day whatever the container's zone is (#2872)", () => {
    // The property, stated directly rather than inferred from the three
    // per-zone assertions above: one season start, three containers, one answer.
    const bounds = HOST_ZONES.map((hostZone) =>
      withTimeZone(hostZone, () =>
        dateOfBirthPrefilterBoundForMinAge(new Date(2026, 3, 1), 18).toISOString(),
      ),
    );

    expect(new Set(bounds).size).toBe(1);
  });

  it("follows the configured minimum age rather than assuming 18", () => {
    onEveryHostZone((hostZone) => {
      const seasonStart = new Date(2026, 3, 1);

      expect(
        dateOfBirthPrefilterBoundForMinAge(seasonStart, 21).toISOString(),
        hostZone,
      ).toBe("2005-04-02T00:00:00.000Z");
      expect(
        dateOfBirthPrefilterBoundForMinAge(seasonStart, 0).toISOString(),
        hostZone,
      ).toBe("2026-04-02T00:00:00.000Z");
    });
  });

  it("composes with getSeasonStartDate, which is where the round trip is real", () => {
    // The host-local getters inside the derivation are only safe because the
    // value they read was CONSTRUCTED with the matching local setters. This is
    // that composition, not a hand-built stand-in for it.
    onEveryHostZone((hostZone) => {
      const seasonStart = getSeasonStartDate(2026);
      const bound = dateOfBirthPrefilterBoundForMinAge(seasonStart, 18);

      expect(bound.getUTCFullYear(), hostZone).toBe(2008);
      expect(bound.getUTCMonth(), hostZone).toBe(seasonStart.getMonth());
      expect(bound.getUTCDate(), hostZone).toBe(2);
    });
  });

  it("rolls a month or year boundary rather than emitting an impossible day", () => {
    // Reachable only if a club's season ever starts on the last day of a month,
    // but the encoding must be total: `dateOnlyFromParts` rolls day 32 forward
    // instead of producing 31 December + 1.
    onEveryHostZone((hostZone) => {
      expect(
        dateOfBirthPrefilterBoundForMinAge(
          new Date(2025, 11, 31),
          1,
        ).toISOString(),
        hostZone,
      ).toBe("2025-01-01T00:00:00.000Z");
    });
  });
});
