// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  THE ENVIRONMENT IS PINNED, SO THIS SUITE MEANS THE SAME THING ON EVERY HOST.

  `APP_TIME_ZONE` is `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`,
  so a developer whose laptop is set to Denver would otherwise turn the premise
  below into a red herring — docs/TESTING.md rule 6. Pinning it here makes
  "Auckland is what the environment would have answered" a GUARANTEE rather than
  an assumption about the machine, which is what lets the Denver expectations
  mean "this did not come from the environment".
*/
vi.mock("@/config/operational", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  APP_TIME_ZONE: "Pacific/Auckland",
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
 * passes under `America/Chicago` while every assertion below goes vacuous. What
 * is checked instead is that the two EXPECTED ANSWERS differ from each other and
 * that the Auckland answer is the one the legacy environment pin would have
 * produced, so a runtime that collapsed them could not leave this file green.
 * The environment itself is STUBBED so that second half holds on any host, not
 * only on one whose `TZ` happens to be unset.
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

const EXPECTED = {
  [AUCKLAND]: { clock: "12:00 PM", day: "Wed, 1 Jul", updated: "12:00 pm" },
  [DENVER]: { clock: "6:00 PM", day: "Tue, 30 Jun", updated: "6:00 pm" },
} as const;

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
  it("the two clubs' expected answers really differ, and Auckland is the legacy answer", () => {
    /*
      THE PREMISE, NOT AN IDENTIFIER COMPARISON.

      If the runtime's ICU ever made these two zones render the same clock and
      the same day, every assertion in this file would still pass while proving
      nothing. Asserting the two expectations differ is what makes a collapse
      visible. The second half records WHY Auckland is the control: it is the
      value the old environment pin resolved to on this deployment, so a
      component that ignored its prop would produce the Auckland column for both
      clubs — which is exactly what the Denver cases below refuse.
    */
    expect(EXPECTED[AUCKLAND].clock).not.toBe(EXPECTED[DENVER].clock);
    expect(EXPECTED[AUCKLAND].day).not.toBe(EXPECTED[DENVER].day);
    expect(APP_TIME_ZONE).toBe(AUCKLAND);
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
