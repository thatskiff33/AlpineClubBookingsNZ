import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  FROZEN_TEST_CLOCK_BASE_ISO,
  frozenClockOptOutReason,
  frozenTestNow,
  installFrozenTestClock,
  optOutOfFrozenClock,
} from "@/lib/__tests__/helpers/clock";
import { todayDateOnlyForTimeZone } from "@/lib/date-only";

// ---------------------------------------------------------------------------
// The frozen test clock's contract (#2481, absorbing #2443).
//
// Every test file runs with "today" pinned to FROZEN_TEST_CLOCK_BASE_ISO, set
// once in vitest.clock-setup.ts, so a calendar rollover can never again turn `main`
// and every open PR red at once (#2426, #2401, #2443, #2479).
//
// The opt-out is per file and counted. A file that genuinely needs the real
// wall clock calls optOutOfFrozenClock("<reason>") at module top level AND is
// listed below. That list is the whole point: an opt-out has to be a deliberate
// diff a reviewer sees, or it quietly becomes the norm and the freeze is
// decorative.
//
// When this test fails because you added an opt-out: do not just paste the new
// path in. Ask first whether the file actually needs the REAL date, or only a
// DIFFERENT fixed one — the second case needs no opt-out at all, just a
// `vi.setSystemTime(...)` in the file's own hook, which runs after the freeze is
// installed and therefore wins. Files that mix both get split, not opted out.
// ---------------------------------------------------------------------------

/**
 * Every test file allowed to run on the real wall clock, with the reason it is
 * allowed. Paths are repo-relative and POSIX-separated.
 */
const REAL_CLOCK_OPT_OUT_FILES: Record<string, string> = {
  "src/lib/__tests__/frozen-test-clock-opt-out.test.ts":
    "the opt-out mechanism's own end-to-end proof: it must observe a clock that advances",
};

/** Guards against an entry being added to the map without a reviewed count. */
const REAL_CLOCK_OPT_OUT_COUNT = 1;

const OPT_OUT_CALL = /optOutOfFrozenClock\(\s*(["'`])([\s\S]*?)\1\s*\)/g;
const OPT_OUT_MENTION = /optOutOfFrozenClock\s*\(/;

/**
 * Mirrors what Vitest actually collects, so the allowlist cannot be dodged by
 * putting an opt-out outside `src/` — `scripts/` carries six suites of its own.
 * `e2e/` and `.claude/` are the two directories `vitest.config.mts` excludes.
 */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".claude",
  "e2e",
  "coverage",
  "playwright-report",
  "test-results",
]);

const TEST_FILE_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const SOURCE_FILE_NAME = /\.[cm]?[jt]sx?$/;

/**
 * Every module Vitest could evaluate — NOT just the collected suites.
 *
 * `optOutOfFrozenClock` is an ordinary function whose effect is module state, so
 * it takes effect wherever it is called during a test file's module evaluation.
 * A call in a shared helper under `__tests__/helpers/` opts out every suite that
 * imports it, silently. Scanning only `*.test.ts`/`*.spec.ts` filenames would
 * see none of that, and both the list and the count assertions below would stay
 * green while the freeze had been switched off for an unbounded set of files.
 */
function walkSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) return [];
      return walkSourceFiles(path.join(dir, entry.name));
    }
    return SOURCE_FILE_NAME.test(entry.name)
      ? [path.join(dir, entry.name)]
      : [];
  });
}

function repoRelative(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath).split(path.sep).join("/");
}

const SOURCE_FILES = walkSourceFiles(process.cwd()).map(repoRelative);
const TEST_FILES = SOURCE_FILES.filter((file) => TEST_FILE_NAME.test(file));

/**
 * This file names the helper (and calls it with bad input to prove it refuses),
 * so it would otherwise scan as an opt-out. It cannot hide behind this
 * exclusion: the "pins 'today' for this file" case asserts it is itself frozen.
 */
const SELF_PATH = "src/lib/__tests__/frozen-test-clock.test.ts";

/** The module that DEFINES the opt-out, so it necessarily names it. */
const HELPER_PATH = "src/lib/__tests__/helpers/clock.ts";

describe("frozen test clock", () => {
  it("collects the test files it is meant to govern", () => {
    // A broken walker would make every assertion below vacuous — the exact
    // failure mode this whole issue is about.
    expect(TEST_FILES.length).toBeGreaterThan(500);
    // …including the suites that live outside src/, which an opt-out could
    // otherwise hide in.
    expect(TEST_FILES).toContain("scripts/__tests__/quality-report.test.ts");
    expect(TEST_FILES).toContain(
      "scripts/ci/check-pr-changelog-fragment.test.mjs"
    );
  });

  it("also collects the non-test modules a suite could import", () => {
    // The opt-out's effect is module state, so a call in a shared helper opts
    // out every importing suite. The allowlist below has to see those too.
    expect(SOURCE_FILES.length).toBeGreaterThan(TEST_FILES.length * 2);
    expect(SOURCE_FILES).toContain(HELPER_PATH);
    expect(SOURCE_FILES).toContain("src/lib/date-only.ts");
    expect(SOURCE_FILES).toContain("vitest.clock-setup.ts");
  });

  it("pins 'today' for this file", () => {
    expect(Date.now()).toBe(frozenTestNow().getTime());
    expect(frozenClockOptOutReason()).toBeNull();
  });

  it("does not advance while a test runs", () => {
    const first = Date.now();
    // A real clock ticks over a busy wait of this length; the frozen one cannot.
    const spinUntil = performance.now() + 25;
    while (performance.now() < spinUntil) {
      /* busy wait on the REAL monotonic clock, which the freeze leaves alone */
    }
    expect(Date.now()).toBe(first);
  });

  it("leaves real timers alone so awaited promises still resolve", async () => {
    await expect(
      new Promise<string>((resolve) => setTimeout(() => resolve("resolved"), 1))
    ).resolves.toBe("resolved");
  });

  it("reads the same calendar date in UTC and in the club's zone", () => {
    // The reason the instant is midnight UTC (= midday NZST) rather than a
    // "tidier" NZ midnight: a runner in UTC and a club in Pacific/Auckland must
    // agree on what day it is, or every date-only fixture becomes zone-dependent.
    const base = new Date(FROZEN_TEST_CLOCK_BASE_ISO);
    const nzCalendarDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Pacific/Auckland",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(base);

    expect(nzCalendarDate).toBe(base.toISOString().slice(0, 10));
    expect(nzCalendarDate).toBe("2026-07-01");
  });

  it("drives the date-only helpers the domain actually reads", () => {
    // Proves the freeze reaches the layer bookings are judged against, not just
    // a bare `new Date()`.
    expect(todayDateOnlyForTimeZone("Pacific/Auckland")).toBe(
      frozenTestNow().toISOString().slice(0, 10)
    );
  });
});

describe("a suite that pins its own instant", () => {
  // The contract 64-odd already-pinned suites depend on, asserted rather than
  // assumed: a per-file pin must WIN over the default freeze, or this work would
  // have silently rewritten what every one of them tests. `batch-modify-payment`
  // (2026-08-20) and the `vi.mock("@/lib/date-only", …)` suites are the live
  // cases; this is the same shape in miniature.
  const OWN_INSTANT = new Date("2027-03-04T05:06:07.000Z");

  beforeAll(() => {
    vi.setSystemTime(OWN_INSTANT);
  });

  afterAll(() => {
    installFrozenTestClock();
  });

  it("keeps its own instant, not the default one", () => {
    expect(new Date().toISOString()).toBe("2027-03-04T05:06:07.000Z");
    expect(Date.now()).not.toBe(frozenTestNow().getTime());
  });

  it("keeps it across tests, so the root beforeEach cannot steal it back", () => {
    // `ensureFrozenTestClock` runs before every test and must leave a deliberate
    // pin alone — it only ever converts a REAL clock back to the frozen one.
    expect(new Date().toISOString()).toBe("2027-03-04T05:06:07.000Z");
  });
});

describe("a suite that hands the clock back to real time", () => {
  // The escape the rollover canary found in `admin-booking-copy.test.ts` and
  // `batch-modify-payment.test.ts`: an `afterEach` that undoes the suite's own
  // pin, leaving every later test in the file on the real calendar.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is re-frozen by the next test rather than left on the real calendar", () => {
    expect(Date.now()).toBe(frozenTestNow().getTime());
    vi.useRealTimers();
    // Deliberately NOT asserted as "later than": that would depend on the real
    // date, which is the whole thing this file exists to forbid.
    expect(Date.now()).not.toBe(frozenTestNow().getTime());
  });

  it("is frozen again here, after the afterEach handed the clock back", () => {
    expect(Date.now()).toBe(frozenTestNow().getTime());
  });
});

describe("the setup-file ordering the whole design rests on", () => {
  // `vitest.clock-setup.ts` must be evaluated FIRST and SEQUENTIALLY, or the
  // freeze is not in place before `vitest.setup.ts` (and everything it imports)
  // evaluates — the import-time-constant hole that once bit `admin-sidebar.tsx`,
  // whose own module-level date constant #3123 has since removed.
  //
  // Vitest's own config type documents `sequence.setupFiles` as defaulting to
  // "parallel" (Promise.all). It resolves to the sequential branch today only
  // because that documented default is never applied, so nothing but this
  // explicit pin stands between the design and a `Promise.all`. Asserted here
  // because a reviewer deleting the config line would otherwise see no failure.
  // Resolve the config the way vitest itself does — first hit wins across its
  // ordered candidate list — because `.ts` OUTRANKS `.mts`. Reading
  // `vitest.config.mts` unconditionally would keep passing against a file
  // vitest no longer loads if a `vitest.config.ts` ever reappeared beside it
  // (an init, a fork port, a partial revert), silently reopening the hole.
  const CONFIG_CANDIDATES = [
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.cts",
    "vitest.config.js",
    "vitest.config.mjs",
    "vitest.config.cjs",
  ];
  const resolvedConfigName = CONFIG_CANDIDATES.find((name) =>
    fs.existsSync(path.join(process.cwd(), name))
  );

  it("is vitest.config.mts that vitest actually resolves, not a shadowing sibling", () => {
    expect(resolvedConfigName).toBe("vitest.config.mts");
  });

  const config = fs.readFileSync(
    path.join(process.cwd(), resolvedConfigName ?? "vitest.config.mts"),
    "utf8"
  );

  it("lists the clock setup file before the general one", () => {
    expect(config).toMatch(
      /setupFiles:\s*\[\s*"\.\/vitest\.clock-setup\.ts"\s*,\s*"\.\/vitest\.setup\.ts"\s*\]/
    );
  });

  it("pins the setup files to sequential evaluation", () => {
    expect(config).toMatch(/sequence:\s*\{[\s\S]*?setupFiles:\s*"list"/);
  });

  it("pins hooks to definition order so a per-file pin still wins", () => {
    expect(config).toMatch(/sequence:\s*\{[\s\S]*?hooks:\s*"stack"/);
  });
});

describe("a suite that pins its own instant with no fake timers installed", () => {
  // Vitest has TWO mocked-Date states. `vi.setSystemTime(x)` while timers are
  // real mocks `Date` on its own and leaves `vi.isFakeTimers()` FALSE — which is
  // exactly what a file gets by combining two idioms this repo blesses
  // separately: an earlier describe's `afterEach(() => vi.useRealTimers())`,
  // then a later describe pinning with a bare `vi.setSystemTime` in `beforeAll`
  // (the shape `booking-guest-consent-authority.test.ts` already uses).
  //
  // Guarding the re-freeze on `isFakeTimers()` read that as "real clock" and
  // silently replaced the pin with the default instant, so the suite ran at a
  // date its author never chose and the docs said it would keep.
  const OWN_INSTANT = new Date("2027-09-09T09:09:09.000Z");

  beforeAll(() => {
    vi.useRealTimers();
    vi.setSystemTime(OWN_INSTANT);
  });

  afterAll(() => {
    installFrozenTestClock();
  });

  it("is in the date-only mock state, not the fake-timer one", () => {
    // If this ever flips, the case above is no longer being exercised and the
    // guard below would pass for the wrong reason.
    expect(vi.isFakeTimers()).toBe(false);
    expect(vi.getMockedSystemTime()?.toISOString()).toBe(
      "2027-09-09T09:09:09.000Z"
    );
  });

  it("keeps its own instant across tests, not the default one", () => {
    expect(new Date().toISOString()).toBe("2027-09-09T09:09:09.000Z");
    expect(Date.now()).not.toBe(frozenTestNow().getTime());
  });
});

describe("a suite that pins its own instant AND hands the clock back", () => {
  // The two documented idioms combined in one suite, and the one behaviour the
  // docs must state plainly: the re-freeze restores the DEFAULT instant, never
  // this suite's pin. A `beforeAll` pin therefore survives only until the first
  // handback. A suite that does both has to re-pin in a `beforeEach`.
  const OWN_INSTANT = new Date("2027-05-06T07:08:09.000Z");

  beforeAll(() => {
    vi.setSystemTime(OWN_INSTANT);
  });

  afterAll(() => {
    installFrozenTestClock();
  });

  it("keeps the pin for as long as nothing hands the clock back", () => {
    expect(new Date().toISOString()).toBe("2027-05-06T07:08:09.000Z");
    // What an `afterEach(() => vi.useRealTimers())` does to the next test.
    vi.useRealTimers();
  });

  it("comes back on the DEFAULT instant, not on the suite's own pin", () => {
    expect(Date.now()).toBe(frozenTestNow().getTime());
    expect(new Date().toISOString()).not.toBe("2027-05-06T07:08:09.000Z");
  });
});

describe("frozen test clock opt-out allowlist", () => {
  const filesCallingOptOut = SOURCE_FILES.filter(
    (file) =>
      file !== SELF_PATH &&
      file !== HELPER_PATH &&
      OPT_OUT_MENTION.test(
        fs.readFileSync(path.join(process.cwd(), file), "utf8")
      )
  );

  it("matches the reviewed allowlist exactly", () => {
    expect(filesCallingOptOut.slice().sort()).toEqual(
      Object.keys(REAL_CLOCK_OPT_OUT_FILES).sort()
    );
  });

  it("finds no opt-out hiding in a shared non-test module", () => {
    // The bypass the filename-only scan allowed: a helper under `__tests__/`
    // calling the opt-out at module top level switches the freeze off for every
    // suite that imports it, while the list and count assertions above still
    // report exactly the reviewed set. Only the module that DEFINES the opt-out
    // may name it outside a test file.
    expect(filesCallingOptOut.filter((f) => !TEST_FILE_NAME.test(f))).toEqual(
      []
    );
  });

  it("matches the reviewed count", () => {
    // Deliberately redundant with the list above: a careless "just add the path"
    // fix has to touch the count too, which is what makes it a reviewed change.
    expect(filesCallingOptOut).toHaveLength(REAL_CLOCK_OPT_OUT_COUNT);
    expect(Object.keys(REAL_CLOCK_OPT_OUT_FILES)).toHaveLength(
      REAL_CLOCK_OPT_OUT_COUNT
    );
  });

  it("gives every opt-out a substantive written reason", () => {
    for (const relativePath of Object.keys(REAL_CLOCK_OPT_OUT_FILES)) {
      const source = fs.readFileSync(
        path.join(process.cwd(), relativePath),
        "utf8"
      );
      const reasons = [...source.matchAll(OPT_OUT_CALL)].map((match) =>
        match[2].trim()
      );

      expect(
        reasons,
        `${relativePath} must call optOutOfFrozenClock with a literal reason string`
      ).toHaveLength(1);
      expect(
        reasons[0].length,
        `${relativePath}'s opt-out reason is too thin to review: ${reasons[0]}`
      ).toBeGreaterThanOrEqual(20);
      expect(REAL_CLOCK_OPT_OUT_FILES[relativePath].length).toBeGreaterThanOrEqual(20);
    }
  });

  it("refuses an opt-out with no reason", () => {
    expect(() => optOutOfFrozenClock("")).toThrow(/requires a non-empty reason/);
    expect(() => optOutOfFrozenClock("   ")).toThrow(/requires a non-empty reason/);
    // The rejected calls must not have flipped this file onto the real clock.
    expect(frozenClockOptOutReason()).toBeNull();
  });
});

describe("frozen test clock instant overrides", () => {
  const savedIso = process.env.TEST_CLOCK_ISO;
  const savedOffset = process.env.TEST_CLOCK_OFFSET_DAYS;

  afterEach(() => {
    if (savedIso === undefined) delete process.env.TEST_CLOCK_ISO;
    else process.env.TEST_CLOCK_ISO = savedIso;
    if (savedOffset === undefined) delete process.env.TEST_CLOCK_OFFSET_DAYS;
    else process.env.TEST_CLOCK_OFFSET_DAYS = savedOffset;
  });

  it("winds the clock forward by whole days", () => {
    process.env.TEST_CLOCK_ISO = FROZEN_TEST_CLOCK_BASE_ISO;

    process.env.TEST_CLOCK_OFFSET_DAYS = "1";
    expect(frozenTestNow().toISOString()).toBe("2026-07-02T00:00:00.000Z");

    process.env.TEST_CLOCK_OFFSET_DAYS = "30";
    expect(frozenTestNow().toISOString()).toBe("2026-07-31T00:00:00.000Z");

    process.env.TEST_CLOCK_OFFSET_DAYS = "365";
    expect(frozenTestNow().toISOString()).toBe("2027-07-01T00:00:00.000Z");
  });

  it("accepts an absolute instant and a negative offset", () => {
    process.env.TEST_CLOCK_ISO = "2026-12-02T00:00:00.000Z";
    delete process.env.TEST_CLOCK_OFFSET_DAYS;
    expect(frozenTestNow().toISOString()).toBe("2026-12-02T00:00:00.000Z");

    process.env.TEST_CLOCK_OFFSET_DAYS = "-1";
    expect(frozenTestNow().toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("fails loudly on a malformed override rather than silently ignoring it", () => {
    // An override that quietly fell back to the base instant would report green
    // while testing something other than what was asked for — the vacuous-pass
    // failure mode again.
    process.env.TEST_CLOCK_ISO = "not-a-date";
    expect(() => frozenTestNow()).toThrow(/parseable ISO-8601 instant/);

    process.env.TEST_CLOCK_ISO = FROZEN_TEST_CLOCK_BASE_ISO;
    process.env.TEST_CLOCK_OFFSET_DAYS = "1.5";
    expect(() => frozenTestNow()).toThrow(/integer number of days/);

    process.env.TEST_CLOCK_OFFSET_DAYS = "soon";
    expect(() => frozenTestNow()).toThrow(/integer number of days/);
  });

  it("defaults to the base instant with no overrides set", () => {
    delete process.env.TEST_CLOCK_ISO;
    delete process.env.TEST_CLOCK_OFFSET_DAYS;
    expect(frozenTestNow().toISOString()).toBe(FROZEN_TEST_CLOCK_BASE_ISO);
  });
});
