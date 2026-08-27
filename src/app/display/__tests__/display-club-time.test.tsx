// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  THE MACHINE IS MOVED ABOVE THE IMPORTS, AND IT HAS TO BE.

  `display-header-clock.tsx` renders the header's day line through a
  module-level `Intl.DateTimeFormat` CONSTANT, frozen when that module loads. A
  zone assigned in a `beforeEach` arrives after that and never reaches it — so
  the calendar-day case at the end of this file could not tell a formatter
  pinned to `UTC` from one that dropped the pin and renders in the runtime's own
  zone. On CI, where `TZ` is unset and the host resolves `UTC`, those two are
  literally the same thing.

  The reading is taken by hand because `vi.hoisted` runs above this file's
  imports, so `captureHostTimeZone` does not exist yet; `restoreHostTimeZone`
  below is the shared #2485 rule, and it runs once, in `afterAll`.
*/
const { HOST, originalHostTimeZone } = vi.hoisted(() => {
  const host = "America/New_York";
  const original = {
    envTz: process.env.TZ,
    resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  process.env.TZ = host;
  return { HOST: host, originalHostTimeZone: original };
});

import { restoreHostTimeZone } from "@/lib/__tests__/helpers/timezone";

/*
  THE ENVIRONMENT IS PINNED, SO THIS SUITE MEANS THE SAME THING ON EVERY HOST —
  AND IT IS PINNED SOMEWHERE THE FALLBACK WOULD NEVER PUT IT.

  `APP_TIME_ZONE` is `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`,
  so a developer whose laptop is set to Denver would otherwise turn the premise
  below into a red herring — docs/TESTING.md rule 6.

  It used to be pinned to `Pacific/Auckland`, and that was the one value it must
  not be: it is exactly what the constant falls back to wherever `TZ` is unset,
  CI included, so a `vi.mock` that quietly stopped applying produced the SAME
  answer and the premise guard beneath went on passing. Pinning a third zone
  instead makes the stub falsifiable on any host, and it buys something more: the
  environment now gives an answer that matches NEITHER club column, so a
  component that read it is caught by both halves of the pair rather than by one.
*/
vi.mock("@/config/operational", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  APP_TIME_ZONE: "Atlantic/Cape_Verde",
}));

import { DisplayScreen } from "@/app/display/display-screen";
import { APP_TIME_ZONE } from "@/config/operational";

/**
 * THE LOBBY TELEVISION RUNS ON THE CLUB'S RECORDED TIMEZONE, NOT THE
 * CONTAINER'S (CT-4, #2870; epic #2988; INV-CONFIG-002, INV-DATE-019).
 *
 * ## What was wrong, in one sentence
 *
 * `display-screen.tsx` rendered its live clock through `formatNZTime` and its
 * header date through an `Intl.DateTimeFormat` frozen at import time to
 * `APP_TIME_ZONE` — `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"` —
 * so the wall showed the MACHINE's civil time rather than the club's.
 *
 * ## Why these assertions can actually fail
 *
 * `/display` sits outside both route-group chrome components, so there is no
 * shared provider above it: the server page resolves the club's persisted zone
 * and hands it to `DisplayScreen` as a required prop. That makes the zone an
 * INPUT to the render, so a test can supply two different clubs and demand two
 * different answers — where a component reading an ambient default would agree
 * with whatever the environment happened to be and pass either way.
 *
 * Both expectations below are written out as literal strings rather than
 * recomputed with the kernel, because recomputing an expectation with the code
 * under test proves only that the function is deterministic. The shapes
 * themselves are pinned separately by
 * `src/lib/club-time/__tests__/house-shapes.test.ts`.
 *
 * ## The premise, asserted rather than assumed
 *
 * `America/Denver` is deliberately BEHIND UTC, which is where these defects
 * show: the same instant is 1 July in Auckland and 30 June in Denver, so a
 * wrong zone moves the day and not merely the hour. `expect(zone).not.toBe(...)`
 * on the identifier would be the tempting premise guard and is worthless — it
 * passes under `America/Chicago` while every assertion below goes vacuous.
 *
 * What is checked instead is what `Intl` ITSELF makes of the pinned instant in
 * each of the FOUR zones in play. Comparing the file's own two expectation
 * LITERALS to each other, which is what the first version of that guard did,
 * cannot fail for any reason whatsoever — they are constants declared eighty
 * lines above it.
 *
 * Four zones because there are four candidate authorities and only one is
 * right: the club's persisted zone (the prop under test), the environment's
 * `APP_TIME_ZONE`, the machine's own clock, and a hard-coded New Zealand. The
 * environment and the machine are both STUBBED, to two further places, so the
 * suite means the same on every host — and neither stub is `Pacific/Auckland`,
 * because that is what `APP_TIME_ZONE` falls back to wherever `TZ` is unset (CI
 * included) and a stub set to the fallback cannot be told from no stub at all.
 * The machine's zone is behind Greenwich as well, which is what lets the
 * calendar-day case at the end of this file distinguish a formatter pinned to
 * `UTC` from one pinned to nothing; on CI's `UTC` host those two are identical.
 */

const PAYLOAD = {
  lodge: { name: "Silverpeak Lodge" },
  club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
  // A real INSTANT: when the server built this payload. Its civil reading is
  // 12:00 pm on 13 April in Auckland and 6:00 pm on 12 April in Denver.
  generatedAt: "2026-04-13T00:00:00.000Z",
  window: { start: "2026-04-13", days: 3 },
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
      { key: "main", panels: [{ module: "arrivals-board", options: { days: 3 } }] },
    ],
  },
};

/**
 * The instant the clock is read at, pinned explicitly.
 *
 * It is the repository's default frozen instant (`vitest.clock-setup.ts`), named
 * here rather than inherited, because `vi.useFakeTimers()` below re-installs the
 * timers and the expectations are written against this exact moment. Midday NZ,
 * so UTC and New Zealand agree on the date and the Denver reading is
 * unambiguously the PREVIOUS day.
 */
const NOW = new Date("2026-07-01T00:00:00.000Z");

/** East of Greenwich, and the value this deployment's environment also holds. */
const AUCKLAND = "Pacific/Auckland";
/** BEHIND UTC, where a wrong zone moves the calendar day and not just the hour. */
const DENVER = "America/Denver";

/**
 * The zone the CONTAINER's `TZ` is stubbed to, above. Not `Pacific/Auckland`, on
 * purpose: see the stub's own comment.
 */
const ENVIRONMENT = "Atlantic/Cape_Verde";

/*
  `HOST` — the machine, a FOURTH place and behind Greenwich on purpose — is
  declared in the `vi.hoisted` block at the top of this file, because it has to
  be assigned before the imports run. `America/New_York` is UTC-4 in July, where
  a UTC-midnight encoding reads as the previous evening. Measured on this branch:
  the "every calendar-date formatter drops its UTC pin" mutant killed 0 of 530
  tests in the related set at `TZ=UTC` before that pin existed.
*/

const EXPECTED = {
  [AUCKLAND]: { clock: "12:00 PM", day: "Wed, 1 Jul", updated: "12:00 pm" },
  [DENVER]: { clock: "6:00 PM", day: "Tue, 30 Jun", updated: "6:00 pm" },
} as const;

/** One civil reading, straight from `Intl` — never through the code under test. */
function civilReading(zone: string, instant: Date): string {
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: zone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
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

afterAll(() => {
  // Never `delete process.env.TZ`: Node re-derives the zone on ASSIGNMENT only,
  // so a bare delete leaks this zone into whichever suite runs next (#2485).
  restoreHostTimeZone(originalHostTimeZone);
});

async function renderHeaderFor(zone: string): Promise<HTMLElement> {
  const { container } = render(<DisplayScreen zone={zone} />);
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

describe("the lobby display renders in the club's persisted timezone (CT-4, #2870)", () => {
  it("four authorities, four different answers, and the two stubs are live", () => {
    /*
      THE PREMISE, AND IT HAS TO READ SOMETHING OUTSIDE THIS FILE.

      The tempting version — `expect(EXPECTED[AUCKLAND].clock).not.toBe(
      EXPECTED[DENVER].clock)` — compares two string literals declared eighty
      lines above. No code change, no runtime upgrade and no ICU data update can
      ever make it fail, so it asserted nothing at all while reading exactly like
      the guard its own comment described. What is asserted instead is what
      `Intl` ITSELF makes of `NOW` in each of the four zones in play, so a runtime
      that collapsed any two of them fails here rather than leaving the cases
      below quietly vacuous.

      Four, not two, because there are four candidate authorities and only the
      first is correct: the club's PERSISTED zone (the prop), the environment's
      `APP_TIME_ZONE`, the machine's own clock, and a hard-coded New Zealand. All
      four give a different reading of this one instant, so any component reading
      the wrong one is caught — and caught by BOTH halves of the pair, not one.
    */
    expect(civilReading(AUCKLAND, NOW)).toBe("1 Jul 2026, 12:00 pm");
    expect(civilReading(DENVER, NOW)).toBe("30 Jun 2026, 6:00 pm");
    expect(civilReading(ENVIRONMENT, NOW)).toBe("30 Jun 2026, 11:00 pm");
    expect(civilReading(HOST, NOW)).toBe("30 Jun 2026, 8:00 pm");
    expect(
      new Set(
        [AUCKLAND, DENVER, ENVIRONMENT, HOST].map((zone) =>
          civilReading(zone, NOW),
        ),
      ).size,
    ).toBe(4);

    /*
      AND BOTH STUBS REALLY APPLIED. Neither of these can pass by accident on a
      host whose `TZ` is unset: `APP_TIME_ZONE` falls back to `Pacific/Auckland`
      there, which is neither of the values demanded here.
    */
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(HOST);
  });

  it.each([AUCKLAND, DENVER] as const)(
    "renders the live clock and the header day in %s",
    async (zone) => {
      const header = await renderHeaderFor(zone);
      const text = header.textContent ?? "";

      // The live clock: a real instant, so its civil reading is the club's to
      // give. `formatClock` upper-cases the kernel's short time.
      expect(text).toContain(EXPECTED[zone].clock);

      // The header day line: the CLUB day the same instant falls on. Under the
      // wrong zone this names 1 July for a club whose evening it still is on
      // 30 June — the INV-DATE-019 defect, on the one screen in the building
      // that nobody is standing in front of to notice.
      expect(text).toContain(EXPECTED[zone].day);

      // And the payload's own `generatedAt`, which is a second instant read
      // through the same binding.
      expect(text).toContain(`updated ${EXPECTED[zone].updated}`);
    },
  );

  it("shows the Denver club NOTHING that belongs to the Auckland club", async () => {
    /*
      The complement of the case above, and the one that would catch a partial
      migration: a header that still carried one environment-pinned formatter
      would render a Denver clock beside an Auckland day, and a `toContain`
      assertion on the Denver strings alone would not see it.
    */
    const header = await renderHeaderFor(DENVER);
    const text = header.textContent ?? "";
    expect(text).not.toContain(EXPECTED[AUCKLAND].clock);
    expect(text).not.toContain(EXPECTED[AUCKLAND].day);
    expect(text).not.toContain(EXPECTED[AUCKLAND].updated);
  });

  it("a simulated preview date is a CALENDAR DAY, so both clubs read it the same", async () => {
    /*
      THE OTHER HALF OF THE RULE, and the one a zone-only test would miss. When
      an admin pins `?previewDate`, the header shows the board's `window.start`
      — a `yyyy-MM-dd` key, a calendar day, which is the same day in every zone
      on earth. So this expectation is deliberately the SAME for both clubs, and
      it fails if anybody ever "fixes" it by projecting the key through a zone:
      under Denver that would name 12 April for a window starting on the 13th.
    */
    window.history.pushState(
      {},
      "",
      "/display?previewDevice=dev-9&previewDate=2026-08-01",
    );
    try {
      for (const zone of [AUCKLAND, DENVER]) {
        const header = await renderHeaderFor(zone);
        expect(header.textContent ?? "").toContain("Mon, 13 Apr");
      }
    } finally {
      window.history.pushState({}, "", "/display");
    }
  });
});
