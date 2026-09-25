// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  THE ENVIRONMENT IS PINNED TO A LOCALE NEITHER CLUB HOLDS.

  `APP_LOCALE` is `process.env.LOCALE || NEXT_PUBLIC_LOCALE || "en-NZ"`, so on a
  host that sets neither it resolves to `en-NZ` — which is also one of the two
  club locales exercised below. A stub set to the fallback cannot be told from
  no stub at all, and the `en-NZ` case would pass whether or not the migration
  happened. `ja-JP` writes this date in a shape no Latin-script locale produces,
  so a component still reading the environment is caught by BOTH cases rather
  than by neither.
*/
vi.mock("@/config/operational", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  APP_LOCALE: "ja-JP",
}));

import { DisplayScreen } from "@/app/display/display-screen";
import { ClubFormatProvider } from "@/components/club-format-provider";
import { APP_LOCALE } from "@/config/operational";
import {
  CLUB_CURRENCY_FALLBACK,
  CLUB_LOCALE_FALLBACK,
  type ClubFormat,
} from "@/lib/club-format";

/**
 * THE LOBBY TELEVISION WRITES ITS DATE IN THE CLUB'S RECORDED LOCALE, NOT THE
 * BUILD'S (#3564, stage 2 of programme #3205; INV-CONFIG-006).
 *
 * ## What was wrong, in one sentence
 *
 * `display-header-clock.tsx` built its header day formatter as a module-level
 * `new Intl.DateTimeFormat(APP_LOCALE, …)` — and `APP_LOCALE` is
 * `NEXT_PUBLIC_LOCALE` inlined at BUILD time, with no `Dockerfile` build
 * argument, so in the published image it is `undefined` and every club's wall
 * read `Wed, 1 Jul` however it had configured itself.
 *
 * ## Why these assertions can actually fail
 *
 * `/display` sits outside both route-group chrome components, so its server
 * page resolves the club's format itself and mounts the shared
 * `ClubFormatProvider` around the screen. That makes the locale an INPUT to
 * the render, so this suite can supply two different clubs and demand two
 * different answers — where a component reading an ambient constant agrees
 * with whatever the environment happens to hold and passes either way.
 *
 * ## The two halves, and why both are needed
 *
 * The `de-CH` case is the one that proves the authority moved. The `en-NZ` case
 * is the issue's own acceptance criterion — that a club still on the shipped
 * defaults sees exactly what it saw before the formatter moved out of module
 * scope — and it is pinned as a LITERAL rather than recomputed through
 * `Intl`, because recomputing an expectation with the mechanism under test
 * proves only that the mechanism is deterministic.
 *
 * ## What this suite deliberately does NOT assert
 *
 * The live clock and the "updated" stamp. Those render through
 * `@/lib/club-time`, whose formatter factory still takes its locale from
 * `APP_LOCALE` at module load — that is `src/lib/club-time/intl.ts`, which is
 * #3565 and explicitly out of scope here. Asserting them would pin behaviour
 * that the next stage is about to change, and would quietly test the
 * environment rather than the club.
 */

const PAYLOAD = {
  lodge: { name: "Silverpeak Lodge" },
  club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
  generatedAt: "2026-07-01T00:00:00.000Z",
  window: { start: "2026-07-01", days: 3 },
  rooms: null,
  bookings: [],
  occupancy: [],
  chores: [],
  rules: null,
  notice: null,
  config: {},
  capabilities: { bedAllocation: false, chores: false },
  template: {
    key: "everyday-board",
    name: "Everyday board",
    regions: [
      { key: "header", panels: [{ module: "lodge-header" }] },
      {
        key: "main",
        panels: [{ module: "arrivals-board", options: { days: 3 } }],
      },
    ],
  },
};

/**
 * The repository's default frozen instant, named here rather than inherited
 * because `vi.useFakeTimers()` below re-installs the timers. Midday NZ, so the
 * club day is unambiguously 1 July and the locale is the only variable left.
 */
const NOW = new Date("2026-07-01T00:00:00.000Z");

/** Held fixed, so nothing below can be a timezone result wearing a locale's hat. */
const ZONE = "Pacific/Auckland";

/** The shipped default: what a club that has configured nothing still sees. */
const DEFAULT_FORMAT: ClubFormat = {
  currencyCode: CLUB_CURRENCY_FALLBACK,
  locale: CLUB_LOCALE_FALLBACK,
};

/**
 * A real club locale that is neither the shipped default nor the environment
 * stub, and whose date shape differs from `en-NZ` in word, order and
 * punctuation rather than in one character.
 */
const SWISS_FORMAT: ClubFormat = { currencyCode: "CHF", locale: "de-CH" };

const EXPECTED_DAY = {
  "en-NZ": "Wed, 1 Jul",
  "de-CH": "Mi., 1. Juli",
  "ja-JP": "7月1日(水)",
} as const;

/** One day line, straight from `Intl` — never through the code under test. */
function dayLineFor(locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(NOW);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * The stack `src/app/display/page.tsx` builds, with the club's format supplied
 * as the argument rather than resolved from the database. The provider mount
 * is the page's, not `DisplayScreen`'s — see that file for why — so a test
 * that means to exercise the real shape has to build it the same way round.
 */
async function renderHeaderFor(format: ClubFormat): Promise<HTMLElement> {
  const { container } = render(
    <ClubFormatProvider
      currencyCode={format.currencyCode}
      locale={format.locale}
    >
      <DisplayScreen zone={ZONE} />
    </ClubFormatProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  const header = container.querySelector(".display-header-clock");
  if (header === null) {
    throw new Error(
      "The lobby header clock did not render, so nothing below is being " +
        "measured. Check the payload shape before trusting a green run here.",
    );
  }
  return header as HTMLElement;
}

describe("the lobby display writes its date in the club's locale (#3564)", () => {
  it("three locales, three different answers, and the stub is live", () => {
    /*
      THE PREMISE, READ FROM OUTSIDE THIS FILE. Comparing the three expectation
      literals to each other would be a guard that no code change, runtime
      upgrade or ICU data update could ever fail. What is asserted instead is
      what `Intl` ITSELF makes of this instant in each locale, so a slim-ICU
      runtime that collapsed `de-CH` onto English fails HERE — loudly — rather
      than leaving the case below passing for the wrong reason.
    */
    expect(dayLineFor("en-NZ")).toBe(EXPECTED_DAY["en-NZ"]);
    expect(dayLineFor("de-CH")).toBe(EXPECTED_DAY["de-CH"]);
    expect(dayLineFor("ja-JP")).toBe(EXPECTED_DAY["ja-JP"]);
    expect(new Set(Object.values(EXPECTED_DAY)).size).toBe(3);

    // And the environment stub really applied: on a host with `LOCALE` unset
    // this constant falls back to `en-NZ`, which is neither of these.
    expect(APP_LOCALE).toBe("ja-JP");
  });

  it("a club on the shipped defaults sees exactly what it saw before", async () => {
    const header = await renderHeaderFor(DEFAULT_FORMAT);
    expect(header.textContent ?? "").toContain(EXPECTED_DAY["en-NZ"]);
  });

  it("a Swiss club sees the Swiss date shape", async () => {
    const header = await renderHeaderFor(SWISS_FORMAT);
    const text = header.textContent ?? "";

    expect(text).toContain(EXPECTED_DAY["de-CH"]);
    // The complement, which is what catches a half-migration: a header still
    // holding one build-time formatter would render the Swiss club an English
    // day, and a `toContain` on the Swiss string alone would not see it.
    expect(text).not.toContain(EXPECTED_DAY["en-NZ"]);
    expect(text).not.toContain(EXPECTED_DAY["ja-JP"]);
  });

  it("the live clock follows the club's locale too, not only the date line (#3566)", async () => {
    /*
      Until #3566 the clock went through the club-time kernel, which read the
      environment's locale, so a Swiss club's wall showed "Mi., 1. Juli" beside
      "12:00 PM". The binding now carries the recorded locale.
    */
    const clock = (header: HTMLElement) =>
      header.querySelector(".display-clock-time")?.textContent ?? "";
    const swiss = clock(await renderHeaderFor(SWISS_FORMAT));
    expect(swiss).toBe("12:00");
    const nz = clock(await renderHeaderFor(DEFAULT_FORMAT));
    expect(nz).toBe(
      new Intl.DateTimeFormat("en-NZ", { timeZone: ZONE, timeStyle: "short" })
        .format(NOW)
        .toUpperCase(),
    );
    expect(nz).not.toBe(swiss);
  });

  it("an unusable recorded locale falls back rather than blanking the wall", async () => {
    /*
      The provider re-validates what it is handed, for the reason
      `resolveClubFormat` states: the only ways to get an unusable value past
      stage 1's validator are database surgery and an ICU that stopped
      accepting a tag the club chose years ago. On an unattended wall screen,
      answering in the documented default beats throwing and going black.
    */
    const header = await renderHeaderFor({
      currencyCode: "NZD",
      locale: "not a locale",
    });
    expect(header.textContent ?? "").toContain(EXPECTED_DAY["en-NZ"]);
  });
});
