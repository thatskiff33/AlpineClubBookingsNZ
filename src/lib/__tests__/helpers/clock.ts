/**
 * The frozen test clock (#2481, absorbing #2443).
 *
 * ## Why this exists
 *
 * Four times CI went red on `main` and on every open pull request at once
 * because the calendar moved on: #2426, #2401, #2443 and #2479. The shape is
 * always identical — a suite fixes a date ("a booking on 2026-08-01", "a link
 * that expires in 48 hours"), the code under test asks the REAL clock, and the
 * day the real date passes the fixture the suite starts failing with nothing in
 * any diff to blame. The vacuous variant is worse: a `not.toBe(403)` assertion
 * that starts passing off an unrelated 400 tests nothing at all.
 *
 * So every test run gets one fixed "today", installed from
 * `vitest.clock-setup.ts` for every file, and no test can depend on what the
 * real date happens to be.
 *
 * ## The instant, and why this one
 *
 * `2026-07-01T00:00:00.000Z` (owner decision, 2 Aug 2026). Midnight UTC is
 * midday in NZ (12:00 NZST), so the runner's own zone and the club's zone agree
 * on the calendar date — the property the #2426/#2401 fixes already proved, and
 * the reason a "safer looking" midnight-NZ instant would in fact be worse. It
 * sits before every mid-2026 fixture in the repo. **It never advances**: the
 * canary below owns forward-looking risk, not a per-release bump.
 *
 * ## Only `Date` is faked, never timers
 *
 * `toFake: ["Date"]` — `setTimeout`/`setInterval`/`queueMicrotask` and
 * `performance.now()` stay real, so awaited promises resolve normally and
 * elapsed-time measurements still work. This is the approach #2479 proved on
 * `payment-link.test.ts` before it was generalised here.
 *
 * ## The rollover canary, and why it does NOT use the overrides below
 *
 * `.github/workflows/clock-rollover-canary.yml` re-runs the whole unit suite
 * with the machine's REAL clock wound forward (libfaketime, +1 day / +31 days /
 * +366 days) on `main` pushes and nightly. A properly frozen test cannot notice
 * that; anything that ESCAPED the freeze can, which is the whole population at
 * risk. Moving the frozen instant instead would test something else entirely and
 * would fail suites that are perfectly correct.
 *
 * ## Moving the frozen instant (a local diagnostic)
 *
 * - `TEST_CLOCK_OFFSET_DAYS` — integer days added to the base instant (may be
 *   negative).
 * - `TEST_CLOCK_ISO` — an absolute ISO-8601 instant replacing the base entirely.
 *   Reproduces a specific rollover on demand, e.g.
 *   `TEST_CLOCK_ISO=2026-12-02T00:00:00.000Z npx vitest run <suite>` reproduces
 *   the #2443 breakage exactly as that issue predicted it.
 *
 * Both are read fresh on every `frozenTestNow()` call and validated loudly — a
 * typo fails the run rather than silently falling back to the base instant,
 * which would report green while checking something you did not ask for.
 *
 * ## When it installs, and why that matters
 *
 * `vitest.clock-setup.ts` — the FIRST entry in `vitest.config.mts`'s
 * `setupFiles`, ahead of `vitest.setup.ts` — installs this during its own module
 * evaluation, not in a `beforeAll`. Both halves matter. A `beforeAll` runs only
 * after every module in the file's graph has been evaluated, so it leaves
 * module-level constants reading the REAL clock; and a module's imports evaluate
 * before its body, so an install inside the main setup file would still be too
 * late for anything that file imports.
 *
 * That is not hypothetical: `src/components/admin-sidebar.tsx` used to compute
 * `UNPAID_FINISHED_STAYS_HREF` from today's date at import time, and a
 * hook-based freeze left the component on the real date while the test that
 * checked it saw the frozen one. #3123 deleted that constant — it was also stale
 * for the life of the browser tab, which is a defect in production and not only
 * under test — so the example is now a postmortem rather than a live case. The
 * hazard is not: any module-level date constant behaves the same way.
 *
 * ## Opting out
 *
 * A file that genuinely needs the real wall clock calls
 * `optOutOfFrozenClock("<reason>")` at module top level, which hands the real
 * clock back immediately. The reason is mandatory, and
 * `frozen-test-clock.test.ts` pins the exact list and count of opted-out files,
 * so widening the opt-out is always a deliberate, reviewed diff. A file that
 * mixes real-time and frozen-time tests gets split rather than opted out
 * wholesale.
 *
 * One honest limitation: ES module imports are hoisted, so an opting-out file's
 * own imports still evaluate under the freeze. If a module-level constant in
 * your import graph must see the real clock, read it inside a test instead.
 *
 * A suite that just wants a DIFFERENT fixed instant does not opt out: it pins
 * its own with `vi.setSystemTime(...)` (or the `vi.mock("@/lib/date-only", …)`
 * idiom) in its own `beforeAll`/`beforeEach`, which runs after the freeze is
 * already installed and therefore wins. `vitest.config.mts` pins
 * `sequence.hooks: "stack"` so the `afterAll` restore stays last too.
 *
 * One sharp edge to know about: the re-freeze below restores the DEFAULT
 * instant, never a suite's own pin. So a suite that pins once in `beforeAll` and
 * ALSO hands the clock back (`vi.useRealTimers()` in an `afterEach`) keeps its
 * instant only until the first handback — every later test runs on the default.
 * Pin in a `beforeEach` instead if the suite does both.
 */
import { vi } from "vitest";

/**
 * The frozen "today" every test run gets by default. Never advances — see the
 * module comment.
 */
export const FROZEN_TEST_CLOCK_BASE_ISO = "2026-07-01T00:00:00.000Z";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Set by `optOutOfFrozenClock` during the test file's module evaluation. */
let realClockReason: string | null = null;

/**
 * Declare that THIS test file needs the real wall clock, with a reason, and
 * hand the real clock back straight away.
 *
 * Call it once at module top level — not inside a hook or a test, where the
 * file's modules have already been evaluated against the frozen clock:
 *
 * ```ts
 * optOutOfFrozenClock("measures real elapsed time across a retry backoff");
 * ```
 *
 * Adding a call here also means adding the file to the allowlist in
 * `src/lib/__tests__/frozen-test-clock.test.ts`, which is the point: the
 * opt-out cannot quietly become the norm.
 */
export function optOutOfFrozenClock(reason: string): void {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (!trimmed) {
    throw new Error(
      "optOutOfFrozenClock(reason) requires a non-empty reason explaining why this " +
        "file needs the real wall clock. See src/lib/__tests__/helpers/clock.ts."
    );
  }
  realClockReason = trimmed;
  // The freeze is already installed by the time a test file runs, so opting out
  // has to actively undo it rather than merely suppress a later install.
  vi.useRealTimers();
}

/** The opt-out reason for the current test file, or `null` when frozen. */
export function frozenClockOptOutReason(): string | null {
  return realClockReason;
}

/**
 * Real elapsed milliseconds since `sinceNs`, captured with
 * `process.hrtime.bigint()`:
 *
 * ```ts
 * const before = process.hrtime.bigint();
 * await somethingThatShouldNotHaveWaited();
 * expect(realElapsedMs(before)).toBeLessThan(20);
 * ```
 *
 * This is the ONLY sanctioned way to measure elapsed time in a test. Under the
 * freeze `Date.now()` is a constant, so `Date.now() - before` is always `0` —
 * which makes an "it actually waited" assertion fail and, far worse, makes an
 * "it did NOT wait" assertion pass vacuously off a hard-coded zero, reporting
 * green while checking nothing.
 *
 * `process.hrtime.bigint()` is monotonic: the freeze does not touch it, and
 * neither does the rollover canary's libfaketime shim
 * (`FAKETIME_DONT_FAKE_MONOTONIC=1`). It is also deliberately a DIFFERENT API
 * from the `performance.now()` some of the code under test reads, so a guard and
 * its test cannot pass by sharing one broken clock — the whole point of
 * measuring from outside.
 */
export function realElapsedMs(sinceNs: bigint): number {
  return Number(process.hrtime.bigint() - sinceNs) / 1e6;
}

function readOffsetDays(): number {
  const raw = process.env.TEST_CLOCK_OFFSET_DAYS?.trim();
  if (!raw) {
    return 0;
  }

  const days = Number(raw);
  if (!Number.isInteger(days)) {
    throw new Error(
      `TEST_CLOCK_OFFSET_DAYS must be an integer number of days, got ${JSON.stringify(raw)}.`
    );
  }

  return days;
}

/**
 * The instant the test clock is frozen at: the base instant, shifted by the
 * canary's environment overrides when they are set.
 */
export function frozenTestNow(): Date {
  const absolute = process.env.TEST_CLOCK_ISO?.trim();
  const base = new Date(absolute || FROZEN_TEST_CLOCK_BASE_ISO);
  if (Number.isNaN(base.getTime())) {
    throw new Error(
      `TEST_CLOCK_ISO must be a parseable ISO-8601 instant, got ${JSON.stringify(absolute)}.`
    );
  }

  return new Date(base.getTime() + readOffsetDays() * MS_PER_DAY);
}

/**
 * Install the frozen clock for the current test file. Called once from
 * `vitest.clock-setup.ts`'s module body, before the test file (and everything
 * it imports) is evaluated.
 */
export function installFrozenTestClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(frozenTestNow());
}

/**
 * Re-freeze before each test IF, and only if, the clock has been handed back to
 * the real calendar. Called from a root `beforeEach` in `vitest.clock-setup.ts`.
 *
 * 67 test files call `vi.useRealTimers()`, usually in an `afterEach` that undoes
 * their own pin. Most re-pin in a `beforeEach`, so the handback is invisible —
 * but a file whose LATER describes have no clock hooks of their own runs those
 * on the real calendar, straight back out of the freeze. The rollover canary
 * caught two doing exactly that (`admin-booking-copy.test.ts` and
 * `batch-modify-payment.test.ts`), each a latent repeat of #2426/#2401/#2443/
 * #2479 waiting for its fixture date to pass.
 *
 * The "is anything already mocking Date?" check is what makes this safe rather
 * than a blunt reset: a suite that DELIBERATELY pinned another instant is left
 * completely alone. It only ever converts "real clock" back to "frozen clock",
 * never one pin into another. And it runs before the file's own `beforeEach`,
 * so a per-test pin still wins.
 *
 * That check has to be `vi.getMockedSystemTime()`, NOT `vi.isFakeTimers()`.
 * Vitest has two distinct mocked-Date states, and only one of them installs
 * fake timers: `vi.setSystemTime(x)` called while timers are REAL mocks `Date`
 * on its own and leaves `vi.isFakeTimers()` returning false. A file reaches that
 * state by combining two separately-blessed idioms — an `afterEach` that hands
 * the clock back, then a later describe pinning with a bare `vi.setSystemTime`
 * in its `beforeAll`. Guarding on `isFakeTimers()` read that as "real clock" and
 * overwrote the deliberate pin with the default instant, so the suite silently
 * ran at the wrong date. `vi.getMockedSystemTime()` is public API and returns
 * non-null in BOTH states; `frozen-test-clock.test.ts` pins the case.
 */
export function ensureFrozenTestClock(): void {
  if (realClockReason || vi.getMockedSystemTime() !== null) {
    return;
  }

  installFrozenTestClock();
}

/**
 * Hand the clock back after the file's tests. Safe to call when the file opted
 * out or already restored real timers itself.
 */
export function restoreRealTestClock(): void {
  if (realClockReason) {
    return;
  }

  vi.useRealTimers();
}
