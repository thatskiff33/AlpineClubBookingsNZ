import { describe, expect, it, vi } from "vitest";

import {
  clubCalendarDateOf,
  requireClubTimeZone,
  requireInstant,
  type ClubTimeZone,
} from "@/lib/club-time";
import { withTimeZone } from "./timezone";

/**
 * The divergent-zone chooser's own guard, tested (CT-4 group F5, #2870).
 *
 * ## Why this file exists
 *
 * `divergentClubZone` is imported by suites in several lanes of this epic and by
 * the shared premise proof, and its whole value is one condition: the zone it
 * returns must differ from BOTH wrong answers — `APP_TIME_ZONE`'s (what an
 * implementation reading the environment gives) and the host's own resolved
 * zone's (what `getFullYear`/`getMonth`/`getDate` give). A review lens measured
 * that dropping the host half of that condition killed **0 of 124**: every
 * importing suite carried on passing while the chooser was free to hand back a
 * zone that coincides with the host. A suite built on that would look
 * discriminating and would not be, and because the helper is shared the weakness
 * would reach lanes that have not been written yet.
 *
 * ## Why the environment zone is mocked here and nowhere else
 *
 * The gap is invisible on this repository's default configuration, and that is
 * the point rather than an inconvenience: with `TZ` unset on a New Zealand
 * machine the host and `APP_TIME_ZONE` resolve to the SAME zone, so the two
 * halves of the condition are the same test and dropping one changes nothing. To
 * separate them the two rivals have to disagree, which means pinning
 * `APP_TIME_ZONE` — and it is read once at module load, so only a module mock can
 * move it.
 *
 * `@/config/operational` has exactly four exports, so the mock is cheap to keep
 * complete. It is file-scoped, which is why this is its own file: the chooser
 * docblock now beside it in this same module notes that
 * mocking that module inside a COMPONENT suite changes what the file's other
 * tests see, because `APP_LOCALE` and `APP_CURRENCY` reach money and date
 * formatting in the same render graph. Here the graph is one helper.
 */
vi.mock("@/config/operational", () => ({
  APP_TIME_ZONE: "Pacific/Kiritimati",
  APP_LOCALE: "en-NZ",
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
}));

const { divergentClubZone, expectClubTimeZonePremise } = await import(
  "./club-time-zone"
);

/**
 * 10:30 UTC, the hour in which three calendar days exist at once — so a third
 * day is available after the environment and the host have taken two. The
 * chooser's own docblock carries the measurement.
 */
const FIXTURE = requireInstant("2026-08-15T10:30:00.000Z");
const dayOf = (zone: ClubTimeZone): string => clubCalendarDateOf(FIXTURE, zone);

/**
 * The pair that separates the two halves of the guard. At the fixture instant
 * `Pacific/Kiritimati` (the mocked environment, UTC+14) reads 16 August and
 * `Europe/Berlin` (the pinned host, UTC+2) reads 15 August, so the two rivals
 * genuinely disagree — and `America/Denver`, the FIRST candidate in the chooser's
 * preference order, also reads 15 August. A chooser that checked only the
 * environment would therefore return Denver, whose answer is the host's.
 */
const HOST = "Europe/Berlin";
const FIRST_CANDIDATE = "America/Denver";

describe("divergentClubZone refuses a zone that coincides with the HOST", () => {
  it("skips the first candidate when its answer is the host's", () => {
    withTimeZone(HOST, () => {
      const chosen = divergentClubZone(dayOf);

      // The premise, asserted before anything else: the two rivals disagree, so
      // the two halves of the guard are genuinely different tests here.
      expect(chosen.environmentAnswer).not.toBe(chosen.hostAnswer);
      // And the first candidate really does answer exactly what the host does,
      // so a host-blind chooser had something wrong to return.
      expect(dayOf(requireClubTimeZone(FIRST_CANDIDATE))).toBe(chosen.hostAnswer);

      expect(chosen.zone).not.toBe(FIRST_CANDIDATE);
      expect(chosen.expected).not.toBe(chosen.hostAnswer);
      expect(chosen.expected).not.toBe(chosen.environmentAnswer);
    });
  });

  it("never returns the environment's zone or the host's own", () => {
    withTimeZone(HOST, () => {
      const chosen = divergentClubZone(dayOf);
      expect(chosen.zone).not.toBe("Pacific/Kiritimati");
      expect(chosen.zone).not.toBe(HOST);
    });
  });

  it("hands back all three answers, each derived from its own zone", () => {
    withTimeZone(HOST, () => {
      const chosen = divergentClubZone(dayOf);
      expect(chosen.expected).toBe(dayOf(chosen.zone));
      expect(chosen.environmentAnswer).toBe("2026-08-16");
      expect(chosen.hostAnswer).toBe("2026-08-15");
    });
  });
});

describe("divergentClubZone fails loudly rather than certifying nothing", () => {
  it("throws when the derivation cannot diverge at all", () => {
    // A zone-independent derivation: every candidate agrees with both rivals, so
    // there is no discriminating zone and saying so is the only honest answer. A
    // skip here is the disease this epic exists to cure (owner decision, #2870).
    expect(() => divergentClubZone(() => "always the same")).toThrowError(
      /No candidate club zone gives an answer different from BOTH/,
    );
  });

  it("names both rivals and every candidate it tried in the failure", () => {
    let message = "";
    try {
      divergentClubZone(() => "always the same");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Pacific/Kiritimati");
    expect(message).toContain("tried");
    // The reader is told what to do, not just that it failed.
    expect(message).toContain("zone-independent");
  });
});

/**
 * The trap that would have reddened CI while staying green here, kept as a test
 * so it cannot come back: CT-1's validator REFUSES `"UTC"` — it is not a named
 * region zone and no club may choose it — and the CI runner's own host resolves
 * exactly `"UTC"`. The two rival answers are what a WRONG implementation would
 * produce, not candidates for the club's zone, so they are branded without
 * validation; validating them threw "not a named zone" for every importing suite
 * on CI.
 */
describe("divergentClubZone tolerates a host zone no club could choose", () => {
  it("works with the process pinned to plain UTC, as the CI runner is", () => {
    withTimeZone("UTC", () => {
      const chosen = divergentClubZone(dayOf);
      expect(chosen.hostAnswer).toBe("2026-08-15");
      expect(chosen.expected).not.toBe(chosen.hostAnswer);
      expect(chosen.expected).not.toBe(chosen.environmentAnswer);
    });
  });

  it("still refuses to hand out a zone the environment claims", () => {
    withTimeZone("UTC", () => {
      // Sanity: the mocked environment is a zone CT-1 accepts, and the chooser
      // must not return it however the host is pinned.
      expect(divergentClubZone(dayOf).zone).not.toBe("Pacific/Kiritimati");
    });
  });
});

describe("expectClubTimeZonePremise", () => {
  it("fails with an environment explanation when APP_TIME_ZONE is not New Zealand", () => {
    // The mock above pins a non-New-Zealand zone, so the premise guard must
    // refuse — and its message must say this is the environment rather than the
    // dating bug the calling suite describes.
    expect(() => expectClubTimeZonePremise()).toThrowError(
      /environment problem, not the dating bug/,
    );
  });
});

describe("the fixture instant sits in the three-day window", () => {
  it("really does have three club days available", () => {
    // The chooser's guidance depends on this; if the fixture drifted out of the
    // 10:00 UTC hour the tests above could start passing for the wrong reason.
    const days = new Set(
      ["Pacific/Kiritimati", "Europe/Berlin", "Pacific/Pago_Pago"].map((zone) =>
        dayOf(requireClubTimeZone(zone)),
      ),
    );
    expect(days.size).toBe(3);
    expect(days.has("2026-08-15")).toBe(true);
  });
});
