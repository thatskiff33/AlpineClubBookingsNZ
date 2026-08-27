# Unit Test Harness

**Audience:** Developer, Agent.

How the Vitest unit suite is set up, and the one convention that matters most
when a test involves a date: **every test run has a fixed "today"**.

The Playwright browser suite is a separate thing with its own document —
[`E2E_PLAYWRIGHT.md`](E2E_PLAYWRIGHT.md). The journeys each suite is expected to
cover live in [`END_TO_END_TEST_MATRIX.md`](END_TO_END_TEST_MATRIX.md).

Run it with `npm test` (`vitest run`). It needs `DATABASE_URL` set to any value —
an unreachable dummy is correct and a live seeded database is not — so
`prisma.config.ts` resolves. See [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for
the full local gate.

## Shared setup

`vitest.config.mts` points every test file at two setup files, in order —
`vitest.clock-setup.ts` then `vitest.setup.ts`. Between them they:

- **freeze the clock** — the rest of this page;
- stub `server-only` (a Next.js guard with no meaning in the Node test
  environment) so server-side modules can be imported at all;
- supply fake email-delivery environment values, because
  `src/lib/email-delivery.ts` refuses to build a transport without them
  (nodemailer is mocked, so nothing is ever sent);
- **set React Testing Library's async window to 4,000ms** under jsdom — the
  section below.

The `.mts` extension is deliberate, not incidental (#2864). Vite reads a plain
`.ts` config as CommonJS, so from 8.2.1 it warns on every run that this file
uses ESM syntax, and once `configLoader: "native"` becomes vite's default such a
file stops loading at all. `.mts` is unambiguously ESM, which the native loader
reads directly. It is the narrow fix: the alternative — `"type": "module"` in
`package.json` — would reinterpret every `.js` file in the repository. Because
the file is now ESM, it has no `__dirname`; the `@` alias is built from
`import.meta.dirname` instead. If you rename it again, `frozen-test-clock.test.ts`
reads it from disk by name and will fail loudly rather than silently skip.

## The RTL async window is 4,000ms, not the 1,000ms default

RTL's async utilities — `findBy*`, `findAllBy*`, `waitFor`,
`waitForElementToBeRemoved` — run on their **own** clock, `asyncUtilTimeout`,
entirely separate from vitest's `testTimeout`. It defaults to 1,000ms, and when
it expires RTL throws

```
TestingLibraryElementError: Unable to find role="button" and name "Any member"
```

which reads like a missing element. **It is a timeout.** Written off as flake
three times on this repository before #2944 named it.

Measured for #2944 by instrumenting RTL's `asyncWrapper` over one pass of
`src/app/(admin)` — 73 files, 546 tests, 558 async waits:

| Runner | Slowest single wait | Margin against the 1,000ms default |
| --- | --- | --- |
| Idle developer machine | 470ms | 2.1x |
| Same box, 12 competing CPU burners | 1,144ms | none — 3 of 558 waits blew the window |

CI runs a suite roughly 1.7x slower than an idle developer machine (measured in
#2923), which puts that idle 470ms at ~800ms before another job shares the box.
So the default is not a comfortable ceiling load occasionally grazes; a busy
runner goes straight through it, and because scheduling decides which wait loses,
a **different** suite fails each run. `vitest.setup.ts` therefore configures
4,000ms repo-wide, and `src/lib/__tests__/rtl-async-util-timeout.test.ts` reads
the value back so it cannot be dropped silently.

The exposure is repo-wide rather than confined to the handful of suites that had
gone red, which is why the setting is not per file: of the 314 test files that
import `@testing-library/react` or `@testing-library/dom`, **219** use at least
one async utility (131 `findBy*`/`findAllBy*`, 199 `waitFor`, none
`waitForElementToBeRemoved`), spread across 82 files under `src/lib`, 69 under
`src/components`, 66 under `src/app` and 2 under `src/hooks`. The measurements, and why the
value is 4,000ms rather than 5,000ms (it has to stay below `testTimeout`, or
vitest's opaque "Test timed out in 5000ms" replaces RTL's message naming the
query), are stated in full beside the setting.

**A wider window is not a licence to wait instead of think.** A test that
interacts with a page before that page has settled has an ordering bug, and a
wider window converts it into a slow pass rather than fixing it. The next section
is the worked example.

## Settle before you interact with a mocked child component

```ts
import { settleLodgeScopedPage } from "@/lib/__tests__/helpers/lodge-scope-settle";

render(<HutLeadersPage />);
await settleLodgeScopedPage("/api/admin/hut-leaders?lodgeId=");
fireEvent.click(screen.getByRole("button", { name: /pick range/i }));
expect(screen.getByLabelText("Start Date")).toHaveValue("2099-07-10");
```

`/admin/hut-leaders` and `/admin/roster` render their date controls and their
occupancy calendar together behind one `lodgeScopeReady` gate, and both reset
workspace state in a `useEffect` keyed on the settled lodge. In a browser those
two cannot collide, because React flushes pending passive effects before
dispatching a discrete input event.

In a suite that **mocks the calendar** they can. The mock's button is in the DOM
on the commit that first renders the gated form, so `findByRole` can resolve on a
commit whose passive effects have not run and `fireEvent` dispatches immediately.
The page applies the picked range, the pending reset effect fires straight after,
and the date inputs go back to empty — failing a *synchronous* assertion that no
window can reach. On `/admin/hut-leaders` step 2 of the form only renders once
dates are chosen, so the same loss presents as `Unable to find role="button" and
name "Any member"` instead.

Measured for #2944 on `occupancy-calendar-pages.test.tsx` under 12 CPU burners:
with the window already at 4,000ms and `testTimeout` at 60,000ms, **1 failure in
30 runs** on the synchronous assertion; with the settle and the window back at
its 1,000ms default, **30/30 green**. That pair is the whole argument for keeping
these two fixes separate.

This is test-only. Both pages gate the real date inputs behind nested
`lodgeScopeReady` checks — a probe against the real page with a deferred lodges
API showed the pre-settle DOM is 563 characters, header and notice only (#2885).

**Do not** "simplify" a settle back to an immediate click, and **do not** wrap the
synchronous expectations in `waitFor` to make them retry. The first restores the
bug; the second hides it behind a slow pass.

### It is not only the calendar, and not only the click

The rule is about the page being **at rest**, so it is not confined to the three
suites #2950 named, nor to a mocked *calendar*. It applies wherever a test drives
a mocked child of a lodge-scoped page and then reads the DOM. #2953 measured a
second suite where both halves bit, `bed-allocation-board-booking-scope.test.tsx`:

**Settle before you interact.** That suite mocks `LodgeSelect`, so its buttons are
clickable on the commit that first renders the board — before the passive effect
that adopts the lodge the server echoed (#2701) has run. A click in that gap sets
the selection to null and the still-queued adoption puts it straight back, so the
board's scope key round-trips to the value it already had, `useScopedDashboard`
never sees a change, and the request the test is asserting on is **never issued at
all**. Measured with a probe that clicked deliberately early: exactly one board
request, permanently. That state is terminal, which is why it presented as a full
4,000ms `waitFor` window followed by a failed *synchronous* assertion — 4,125ms on
CI, and 1 failure in 20 runs locally under 20 competing CPU burners.

**Settle before you assert, too.** Awaiting a *request* is not awaiting the render
it causes, and a page that has answered one question may still be moving. The same
board makes **three** requests after that click, not two: the deep link, the
unscoped read the test asserts on, and a third once #2701 re-adopts the lodge the
server echoed. `useScopedDashboard` clears its value on every scope change, so the
badge the test reads next is unmounted twice in between, and a synchronous read
landing in one of those gaps fails as `Unable to find an element with the text:
Focused booking` — 2 failures in 30 runs, in ~150ms each, so an ordering failure
rather than a slow one. Wait for the page to reach rest, then assert once. Waiting
on the page's own request and render is a **settle**; folding the assertion into
that wait is a **retry**, and the prohibition above still stands.

With both settles, that suite ran **30/30 under 20 competing CPU burners with the
RTL window forced back to its 1,000ms default** — the same both-directions proof
#2944 used, and the reason a wider window was never the fix here.

## Which project typechecks a test

`npm run typecheck` runs two TypeScript projects, and between them they must
read every tracked `.ts`, `.tsx`, `.mts` and `.cts` file in the repository
except `.semgrep/tests/acb-client-server-boundary.tsx` and
`.semgrep/tests/acb-unsafe-raw-sql.ts`. Those two files are deliberately broken
samples read only by Semgrep's `--test` runner; typechecking them would defeat
their purpose:

- **`tsconfig.json`** — the app. It excludes Vitest test/spec files under
  `src/` and `scripts/`, plus everything under `__tests__/`, so that test code
  stays out of the app's type surface.
- **`tsconfig.test.json`** — the Vitest project under `src/` and `scripts/`.
  Its broad test/spec patterns deliberately cover TypeScript's `.ts`, `.tsx`,
  `.mts` and `.cts` forms, and it supplies `vitest/globals`.

Vitest also collects JavaScript test/spec forms. The existing `.js`, `.jsx`,
`.mjs` and `.cjs` files are loaded by `tsconfig.test.json` while `allowJs`
remains on, but `checkJs` is explicitly off: they execute in Vitest, but this
document does **not** claim TypeScript statically checks their bodies. MEP-E1
(#2693) owns converting the remaining JavaScript dependencies, setting
`allowJs: false`, and giving Playwright its deliberate long-term project.

Put a supported new Vitest test under `src/` or `scripts/` and the existing
patterns cover it; put one somewhere else and you must add the pattern.
`src/lib/__tests__/typecheck-project-coverage.test.ts` fails if any other
tracked TypeScript file ends up in neither project. It also pins Vitest's actual
default extension glob, requires every supported Vitest file in the test
project, and refuses compound JSX extensions that Vitest would collect but
TypeScript cannot load. It asks TypeScript itself which files each project
resolves rather than reimplementing tsconfig's glob rules.

That guard exists because the gap was real and silent (#2875): `tsconfig.json`
excluded the test files and `tsconfig.test.json` re-included only the `src/`
half, so everything under `scripts/__tests__/` was typechecked by neither
project. Deliberate `const x: number = "string"` errors planted in those files
produced a completely green `npm run typecheck`.

Playwright specs under `e2e/` are not Vitest and are not in that project. They
remain in the app project because the Vitest exclusions are scoped to `src/`
and `scripts/`, leaving `e2e/` untouched. That home is still incidental rather
than deliberate; choosing the long-term Playwright project is MEP-E1 (#2693).

## The frozen test clock

Plain English: tests are not allowed to know what today's real date is. Every
test file starts with "today" pinned to **1 July 2026**, and it stays there.

Precisely: `vitest.clock-setup.ts` calls
`vi.useFakeTimers({ toFake: ["Date"] })` and
`vi.setSystemTime(2026-07-01T00:00:00.000Z)` in its own module body, for every
file. The mechanism lives in
[`../src/lib/__tests__/helpers/clock.ts`](../src/lib/__tests__/helpers/clock.ts).

Two details there are load-bearing rather than stylistic:

- **A module body, not a `beforeAll`.** A `beforeAll` runs only after every
  module in the file's import graph has already been evaluated. Module-level date
  constants are real code — `src/components/admin-sidebar.tsx` used to build its
  unpaid-finished-stays deep link from today's date at import time — and a
  hook-based freeze left those on the real clock while the tests checking them
  saw the frozen one. That particular constant no longer exists: #3123 moved it
  into the render, because a value evaluated once per bundle load was also stale
  for the life of the browser tab. The hazard is unchanged, because it belongs to
  module evaluation order rather than to that one file.
- **Its own setup file, listed first.** A module's imports evaluate before its
  body, so an install inside `vitest.setup.ts` would still be too late for
  everything `vitest.setup.ts` imports. Vitest evaluates `setupFiles` in order,
  so a dedicated first file freezes the clock before any other module in the run.

A root `beforeEach` then re-freezes before each test **if and only if** nothing
is currently mocking `Date`. Dozens of suites undo their own pin with
`vi.useRealTimers()` in an `afterEach`; where their later describes have no clock
hooks, those tests used to drop straight back out of the freeze — the rollover
canary caught two doing exactly that. A suite that deliberately pinned another
instant is left completely alone, so this only ever converts "real clock" back to
"frozen clock", never one pin into another.

The check is `vi.getMockedSystemTime() !== null`, not `vi.isFakeTimers()`,
because Vitest has two mocked-`Date` states and only one installs fake timers: a
bare `vi.setSystemTime(...)` called while timers are real mocks `Date` on its own
and leaves `vi.isFakeTimers()` false. Guarding on fake timers overwrote that kind
of pin with the default instant.

And what the re-freeze restores is always the **default** instant, never a
suite's own pin — see rule 4 below.

### Why

Four separate times, CI went red on `main` and on every open pull request at the
same moment because the calendar moved on — issues #2426, #2401, #2443 and
#2479. The shape never varied: a suite fixes a date ("a booking on 2026-08-01",
"a payment link that expires in 48 hours"), the code under test asks the real
clock, and on the day the real date passes the fixture the suite fails. Nothing
is in any diff to blame, so whoever is working that morning burns an hour
proving it is not their fault.

The quieter version is worse. A `expect(res.status).not.toBe(403)` assertion
that starts passing off an unrelated `400 Cannot book in the past` has stopped
testing anything at all, and says nothing while it does so (#2443).

Each of the four fixes pinned one suite after it broke. Freezing once, centrally,
removes the whole class instead.

### Why this instant

`2026-07-01T00:00:00.000Z` is midnight UTC, which is **midday** in
`Pacific/Auckland`. A CI runner in UTC and a club in NZ therefore agree on what
calendar day it is, so no date-only fixture becomes zone-dependent — the property
the #2426/#2401 fixes already relied on. It also sits before every mid-2026
fixture in the repo.

**It never advances.** There is no per-release bump. Forward-looking risk is the
canary's job, below (owner decision, 2 August 2026).

### Only `Date` is faked

`toFake: ["Date"]` fakes `Date` and nothing else. `setTimeout`, `setInterval`,
`queueMicrotask` and `performance.now()` stay real, so awaited promises resolve
normally and elapsed-time measurements still work. Freezing timers as well would
hang half the suite; this is the approach #2479 proved on one suite before it was
generalised.

## Writing a date-bearing test

1. **Write dates relative to 1 July 2026.** A "future" booking is
   `2026-08-01`; a "past" one is `2026-06-01`. They stay future and past for
   good.
2. **Never write a fixture relative to the real clock** — no
   `new Date(Date.now() + 7 * 86_400_000)` to mean "next week" against a
   hard-coded expectation. Under the freeze this is deterministic, but it hides
   which date the test actually means.
3. **Need a different fixed instant? Pin it in the file, do not opt out.** A
   suite's own `vi.setSystemTime(...)` in its own `beforeAll`/`beforeEach` wins,
   because the freeze is already installed by the time any hook runs;
   `vitest.config.mts` pins `sequence.hooks: "stack"` so the setup file's
   `afterAll` restore stays last. The `vi.mock("@/lib/date-only", …)` idiom (see
   `site-banners.test.ts`) also still works and is unaffected.

   The worked example is `nz-today-date-only.test.tsx` (#2682), which pins
   `2026-06-30T21:00:00.000Z` — 09:00 on 1 July 2026 in New Zealand, and the
   *previous* UTC day. Its whole subject is that the two disagree, so it also
   shows the two guards a suite like that needs: it asserts up front that the
   UTC day and the club day really are different (a fixture that drifted out of
   the divergence window would otherwise pass vacuously), and it asserts that
   `APP_TIME_ZONE` is still `Pacific/Auckland`, so a contributor doing what rule
   6 below describes gets one clear environment failure instead of five that
   read like product bugs. A suite that keeps the DEFAULT instant but hard-codes
   fixture dates against it should assert that too — `night-occupancy-parity.test.ts`
   (#2681) pins `getTodayDateOnly()` to `2026-07-01` for that reason.

   The club-zone half of that is a shared helper, so every suite says the same
   thing and says it before any date assertion runs:

   ```ts
   import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";

   beforeEach(() => {
     expectClubTimeZonePremise();
     vi.setSystemTime(divergentInstant);
   });
   ```

   Calling it from the `beforeEach` that pins the instant is what makes the
   explanation arrive first: a wrong `TZ` then fails the hook with one sentence
   about the environment, instead of failing every test with a bare
   `expected '2026-06-14' to be '2026-06-15'` that reads like the product bug
   the suite exists to prove fixed (#2834).

   **A suite whose subject is "the PERSISTED zone is the authority" needs the
   other helper in that file, and needs it for a measured reason.**
   `src/lib/__tests__/support/club-time-render.tsx` mounts `ClubTimeProvider`
   with `CLUB_TIME_TEST_ZONE`, deliberately equal to what `APP_TIME_ZONE`
   resolves to, so that moving 37 suites onto it changed no expected string.
   The consequence is that a suite on that default **cannot tell the persisted
   zone from the environment however much it asserts** — measured on #2870, a
   mutant hook that ignored the provider entirely failed 0 of 460 assertions
   across 34 such suites, and of one later group's 49 provider-reading
   components, 46 were blind. Hand-picking `America/Denver` does not fix it
   either: it stops discriminating, silently, on a developer whose own zone is
   already Denver.

   `divergentClubZone` takes the DERIVATION and returns the oracle with it,
   refusing to return at all unless the answer differs from both wrong ones —
   `APP_TIME_ZONE`'s (what a provider-blind implementation gives) and the host's
   own resolved zone (what `getFullYear`/`getMonth`/`getDate` give). Those two
   are different on the CI runner, which resolves `UTC` while `APP_TIME_ZONE`
   falls back to `Pacific/Auckland`, so checking one is not checking the other.

   ```ts
   import { divergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";

   const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
     (z) => clubCalendarDateOf(instant, z),
   );
   expect(subjectUnderTest(instant, zone)).toBe(expected);
   expect(expected).not.toBe(environmentAnswer);
   expect(expected).not.toBe(hostAnswer);
   ```

   **Put a CALENDAR-DAY fixture instant in the 10:00-11:00 UTC hour.** Three
   calendar days exist on earth simultaneously only while the UTC hour is 10
   (`UTC+14` has turned over and `UTC-11` has not); at every other hour there are
   two, and both can already be taken — one by `APP_TIME_ZONE`, one by the host —
   leaving nothing for the helper to pick. Measured on the CI shape, a fixture at
   21:00 UTC refuses every candidate and the same fixture at 10:30 UTC resolves on
   the first. A derivation with more possible answers (a wall-clock hour, a
   formatted time, an instant) works at any hour. A suite deriving the club's
   TODAY pins its own instant, because the repository's frozen clock is at 00:00
   UTC. `src/lib/__tests__/calendar-divergence-premise.test.ts` is the worked
   example, and it also shows how to prove the premise holds on each host shape
   rather than only the author's.

   **The chooser's own guard has a test, and it needs a mocked environment zone
   to have one.** `src/lib/__tests__/helpers/club-time-zone.test.ts` is the only
   place that pins `APP_TIME_ZONE` through `vi.mock("@/config/operational")`, and
   the reason is worth knowing before writing a similar guard: on a machine where
   `TZ` is unset and the system zone is New Zealand, the host and `APP_TIME_ZONE`
   resolve to the SAME zone, so the two halves of "differ from both rivals" are
   the same assertion and dropping one changes nothing. Measured on #2870,
   deleting the host half killed **0 of 124** across every importing suite. The
   two rivals have to be made to disagree, and `APP_TIME_ZONE` is read once at
   module load, so only a module mock moves it. Keep that mock in a file of its
   own: group D's `club-zone-choice.ts` records that mocking that module inside a
   COMPONENT suite changes what the file's other tests see, because `APP_LOCALE`
   and `APP_CURRENCY` reach money and date formatting in the same render graph.

   **A pin read at module load needs a re-imported graph, not `withTimeZone`.**
   `withTimeZone` moves the process's zone for the duration of a call, which
   catches arithmetic evaluated per call — but a module-level
   `Intl.DateTimeFormat` is built once at import, so a wrong `timeZone` pin on one
   survives it. `vi.resetModules()` plus a dynamic `import()` under a pinned `TZ`
   re-evaluates `@/config/operational` and catches it; assert inside the block
   that `APP_TIME_ZONE` really moved, or the test proves nothing. Both mechanisms
   are used together in `calendar-client-club-time.test.ts` and
   `calendar-recurrence.test.ts`, and a review measured what happens when only one
   file has the second: the identical wrong pin killed 1 in the file that had it
   and **0** in the file that did not.
4. **Do not hand the clock back to the real calendar.** If your suite pins its
   own instant and wants to undo that, `vi.useRealTimers()` in an `afterEach` is
   safe — the root `beforeEach` re-freezes before the next test — but never rely
   on real time being restored, and never call it expecting later tests in the
   file to see the real date.

   One sharp edge if you do **both**: the re-freeze restores the **default**
   instant, not your pin. A suite that pins once in a `beforeAll` and also hands
   the clock back therefore keeps its instant only until the first handback —
   every test after that silently runs at 1 July 2026. Pin in a `beforeEach`
   instead when your suite does both.
5. **Measuring how long something took? `Date.now()` is no longer a stopwatch.**
   Under the freeze it is a constant, so `Date.now() - before` is always `0` —
   which makes an "it waited long enough" assertion fail and, far worse, makes an
   "it did NOT wait" assertion pass vacuously. Use the shared helper:

   ```ts
   import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

   const before = process.hrtime.bigint();
   await shouldNotHaveWaited();
   expect(realElapsedMs(before)).toBeLessThan(20);
   ```

   `process.hrtime.bigint()` is monotonic, so neither the freeze nor the canary's
   libfaketime shim touches it. `performance.now()` also stays real, but it is
   only safe when **the code under test does not read it too** — otherwise a
   suite that later installs blanket fake timers moves the guard and its test
   together and the assertion passes without anything having waited.
   `member-guest-probe-guard.test.ts` measures its privacy timing floor with
   `process.hrtime.bigint()` for exactly that reason: the guard itself reads
   `performance.now()`, so the test deliberately measures with a different API.
6. **Remember `APP_TIME_ZONE` follows `process.env.TZ`**
   (`src/config/operational.ts`). Setting `TZ=UTC` to simulate the CI runner
   also moves the *club* zone to UTC, so a timezone bug can silently pass. To
   reproduce a UTC runner with an NZ club, force
   `timeZone = "Pacific/Auckland"` explicitly as well.

   **Do not set `TZ` from Git Bash — it is a silent no-op, and this advice used
   to send you straight into it.** Measured independently by three lanes on epic
   #2988 and re-measured on #2991: Git Bash on Windows drops any `TZ` value
   containing a `/`, so the variable arrives as `undefined` and the process keeps
   the machine's own zone.

   ```
   $ TZ=UTC node -e "console.log(process.env.TZ)"              # UTC
   $ TZ=America/Denver node -e "console.log(process.env.TZ)"   # undefined
   $ export TZ=America/Denver; node -e "console.log(process.env.TZ)"  # undefined
   ```

   That is the worst possible shape: the zone with no slash works, so the lever
   looks live, and every zone that would actually discriminate is dropped. A
   matrix built on it reports six rows and measures one. `MSYS_NO_PATHCONV`,
   `MSYS2_ARG_CONV_EXCL` and a leading `//` were all tried and none of them
   helps.

   **The levers that do work.** From PowerShell, `$env:TZ = "America/Denver"`
   propagates correctly, so a whole-process run under one zone is available there.
   In-process — which is what a matrix wants — assign `process.env.TZ`, through
   `withTimeZone`/`withTimeZoneAsync` (rule 7 below), and use
   `vi.resetModules()` plus a dynamic `import()` for anything frozen at module
   load. `host-process-zone-matrix.test.ts` and
   `browser-viewer-zone-matrix.test.ts` are the worked examples, and each asserts
   its rows really diverge before asserting anything else.

   **Since CT-1 (#2989) that is true of `APP_TIME_ZONE` and NOT of the club
   timezone itself**, and the difference is the whole point of the change. The
   club's civil time is now the persisted `ClubTimeSettings.timeZone`, read
   through `getClubTimeZone()` (`src/lib/club-time-zone-settings.ts`), and
   `process.env.TZ` cannot move it once a row exists — `INV-CONFIG-002`. So a
   suite covering club-time behaviour sets the persisted value, and a suite
   covering a *not-yet-migrated* display call site still has to force
   `APP_TIME_ZONE` as above until CT-6 retires it. If you are writing a test that
   proves the database beats the environment, **prove the environment read is
   live in the same file**: assert that with no persisted row the reader really
   does return the environment's zone. Without that leg the first assertion
   cannot tell a real precedence rule from an environment read that never
   happens — the same vacuous-pass shape rule 5 warns about for `Date.now()`.
7. **Restoring `process.env.TZ` is never a bare `delete` (#2485).** Node only
   re-derives its resolved timezone when `process.env.TZ` is *assigned*;
   deleting the variable removes it from the environment but leaves the
   last-assigned zone cached, so a suite that pins a zone and deletes it on the
   way out leaks that zone into whichever suite the runner schedules next in
   the same worker. Use the shared helper instead of ad-hoc save/restore code:

   ```ts
   import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

   const hostTimeZone = captureHostTimeZone();

   afterEach(() => {
     hostTimeZone.restore();
   });
   ```

   For a single pinned call, `withTimeZone`/`withTimeZoneAsync` (same module)
   wrap the capture-set-run-restore sequence. `captureHostTimeZone()` must run
   BEFORE anything in the file assigns `process.env.TZ` — module top level, or
   the top of a `describe` block, both of which run before any hook or test
   body. See `src/lib/__tests__/helpers/timezone.ts` for the full mechanism and
   `src/lib/__tests__/helpers/timezone.test.ts` for a proof the leak is real
   and that the helper closes it.

## Opting a file out

A file that genuinely needs the real wall clock calls the shared helper once at
module top level, with a reason:

```ts
import { optOutOfFrozenClock } from "@/lib/__tests__/helpers/clock";

optOutOfFrozenClock("measures real elapsed time across the retry backoff");
```

The call hands the real clock back on the spot. One honest limitation: ES module
imports are hoisted, so the file's own imports still evaluate under the freeze —
if a module-level constant in your import graph must see the real clock, read it
inside a test instead.

The reason is required — an empty one throws — and the file must also be added
to the allowlist in
[`../src/lib/__tests__/frozen-test-clock.test.ts`](../src/lib/__tests__/frozen-test-clock.test.ts),
which pins both the exact list of opted-out files and their count. That contract
test is what keeps the opt-out honest: widening it is always a deliberate diff a
reviewer sees, never a quiet default. It scans **every** module under the
collected roots, not only files named `*.test.ts` — the opt-out's effect is
module state, so a call in a shared helper would otherwise switch the freeze off
for every suite importing it without appearing in the allowlist at all.

Before adding one, check that you actually need the **real** date rather than a
**different** one — case 3 above needs no opt-out at all. A file that mixes
real-time and frozen-time tests gets split into two files rather than opted out
wholesale.

`frozen-test-clock-opt-out.test.ts` is the one standing entry: it exists so the
opt-out path is itself exercised, and asserts only that its clock advances —
never what the date is.

## The rollover canary

The freeze is not airtight by construction: a file can opt out, and code can
reach a date through a path the freeze does not cover. So
`.github/workflows/clock-rollover-canary.yml` re-runs the whole unit suite with
the machine's **real** clock wound forward by **a day, a month and a year**, as
three parallel matrix jobs, and **fails when the suite fails** under the shifted
clock (after `--retry=2`).

Two limits worth knowing. It does not compare results against a baseline run, so
a test that changes fail→pass is not reported; and the retry, which exists to
absorb libfaketime's slowdown, means only a repeatable failure is reported — a
date dependence that surfaces on one ordering in three can be retried green. A
test that really reaches the real calendar fails on every attempt, because the
clock is shifted for the whole run, so the retry does not soften that signal.

The acceptance criterion in plain English: winding the real system clock forward
by a year must not break the suite. A properly frozen test cannot notice the
canary at all — it still sees 1 July 2026. What notices is anything that escaped
the freeze, which is exactly the population that will go red on its own one day.

The shift uses [libfaketime](https://github.com/wolfcw/libfaketime) rather than
setting the runner's system clock: no VM-wide side effects, no fight with NTP
resync, and `FAKETIME_DONT_FAKE_MONOTONIC=1` leaves monotonic clocks real so
timers, awaited promises and `performance.now()` behave normally. A dedicated
step proves the shift actually reaches Node's `Date` before the suite runs,
because a canary whose clock shift silently failed would report green while
checking nothing.

- It runs on **pushes to `main`** and on a **nightly schedule** (14:00 UTC =
  02:00 NZST), plus manual `workflow_dispatch`.
- It **fails loudly** there, and writes a job summary explaining that the
  triggering commit is almost certainly not the cause.
- It is **never a pull-request check** (owner decision, 2 August 2026). The
  workflow has no `pull_request` trigger, so it cannot become a required check
  and cannot block unrelated work on a problem that is, by construction, not
  urgent yet.

A red canary means some test still reaches the real calendar. Fix the test so it
reads the frozen clock; do not opt the file out.

Reproduce a canary job locally on Linux:

```bash
sudo apt-get install -y faketime
# -f is required: without it the offset is parsed by `date -d`, which rejects it.
# The raised timeouts and the retry are the libfaketime tax — every clock call
# and every subprocess spawn goes through the LD_PRELOAD shim. A test that really
# reaches the real calendar fails on every retry, so this does not soften the
# signal; only a slowness flake passes.
FAKETIME_DONT_FAKE_MONOTONIC=1 faketime -f '+366d' \
  npm test -- --testTimeout=30000 --hookTimeout=30000 --retry=2
```

### Any workflow that runs the suite must check out full git history

Part of the unit suite shells out to `git` against **this repository's own
commits**. `scripts/ci/check-doc-index-integrity.test.mjs` is the clearest case:
it builds a real `pull_request` payload out of `HEAD^1` and `origin/main` so the
doc-index CLI is exercised against commits that exist rather than against a
fixture. `actions/checkout` clones at depth 1 by default, and a depth-1 clone has
neither — no second commit, and no remote-tracking `origin/main`.

When that happens the tests fail with a raw
`fatal: ambiguous argument 'HEAD^1': unknown revision or path not in the working
tree`, several frames inside a helper, naming nothing that points at the
checkout. So the failure reads as a bug in whatever commit triggered it.

It has happened. The canary ran the suite on a depth-1 clone while `verify`
checked out in full, so the breakage passed all eight required checks, merged,
and reddened `main` — once per clock offset in the matrix (#2907). Nothing then
stopped the two diverging again, and the divergence is invisible everywhere
anyone would look: the canary has no `pull_request` trigger, so no PR check sees
it, and a developer's clone has full history exactly like `ci.yml`, so a local
run cannot see it either.

`npm run ci:workflowcheck` (`scripts/ci/check-workflow-suite-checkout-depth.mjs`,
a step in the `verify` job) is what keeps them matched. It parses
`.github/workflows/*.yml`, works out from the parsed shell command which jobs run
the **whole** suite — wrapped invocations included, which is why the canary's
`faketime -f '${{ matrix.offset }}' npm test -- …` counts — and fails when such a
job has no `actions/checkout` step with `fetch-depth: 0`. A job that runs only
**targeted** files (`npx vitest run <path>`) needs full history only when one of
those files reads the repository's own history, which is why `migration-drift`
and `data-migration-verification` are correct checking out shallow.

The fix when it fails is `fetch-depth: 0` on that job's checkout step. It is
**not** making the test skip when history is missing: a test that quietly
disappears in one workflow is how this whole class of gap hides, and the
surviving workflow's green then certifies nothing about it (#2907, #2909).

### Moving the frozen instant locally

Separately from the canary, two environment variables move the **frozen** instant
itself. They are a local diagnostic — the canary does not use them, because
moving the frozen date tests something else entirely (whether fixtures survive a
different "today") and would fail suites that are perfectly correct.

| Variable | Meaning |
| --- | --- |
| `TEST_CLOCK_OFFSET_DAYS` | Whole days added to the frozen instant. May be negative. |
| `TEST_CLOCK_ISO` | An absolute ISO-8601 instant replacing the frozen one entirely. |

```bash
# Reproduce a specific rollover — this is the date #2443 predicted would break
# the two subscription-gate suites, and it does.
TEST_CLOCK_ISO=2026-12-02T00:00:00.000Z npx vitest run \
  src/lib/__tests__/phase2-guest-subscription.test.ts
```

A malformed value fails the run rather than falling back to the frozen instant —
falling back would report green while checking something other than what you
asked for, which is the same vacuous-pass failure this whole convention exists to
prevent.

## Asserting that a recovery alert holds focus

The other convention that is load-bearing rather than stylistic, for the same
reason as the frozen clock: written the obvious way, the assertion reports green
or red on something other than what it claims to check.

Eighteen admin and member surfaces render a **permanently mounted** `role="alert"`
that a failed action populates and then takes focus, so a keyboard or
screen-reader user is not left on a control that has just been re-enabled while
the explanation appears elsewhere on the page. Sixteen use
`src/components/focused-action-error.tsx`; `policy-exception-requests-panel.tsx`
and `roster-editor.tsx` inline their own copy.

Assert that contract with the shared helper, never by hand:

```ts
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));
await waitFor(() => expect(alert).toHaveTextContent(RETRY_MESSAGE));
await expectRecoveryAlertToHoldFocus(alert);
```

### Why not by hand

Both obvious spellings are wrong, and this repository shipped both before #2635.

**A synchronous `expect(document.activeElement).toBe(alert)`** taken straight
after a `waitFor` on the alert's text passes only by luck. The component focuses
in a passive effect, which React flushes in a Scheduler task *after* the commit
that puts the message in the DOM. Measured on this stack: at the
mutation-observer checkpoint where `waitFor`'s callback first succeeds, focus had
landed in **0 of 30 runs**, arriving exactly one event-loop turn later. The
assertion survived only because React Testing Library's `asyncWrapper` happens to
drain one `setTimeout(0)` before handing control back — a one-turn margin inside
a library internal that nothing guarantees. A loaded CI runner is enough to lose
it, and `main` went intermittently red on a commit that passed on a rerun of the
identical SHA.

**A bare `await waitFor(() => expect(document.activeElement).toBe(alert))`** is
not the fix either. `waitFor` resolves on the first poll where the condition
holds, so focus that lands and is then stolen by a later commit passes it — a
weaker guarantee than the one being claimed. #2618 relaxed the member-facing
waitlist card to this spelling to dodge the race above, and an earlier review
recorded that as a finding rather than a fix.

`expectRecoveryAlertToHoldFocus` asserts both halves: it waits for focus to
arrive, then settles every pending render and effect and re-asserts
synchronously. So it depends on no ordering between React's flush and the test
runner's drain, and it fails if the focus does not stay.

### The related trap: `findByRole("alert")` on a permanently mounted alert

Because the live region is mounted **empty** from the start,
`await screen.findByRole("alert")` matches it immediately and waits for nothing.
Any text assertion on the next line inherits the same one-turn margin. Wait for
the text, not the element:

```ts
const alert = await screen.findByRole("alert");
await waitFor(() => expect(alert).toHaveTextContent("Payment Error"));
```

### Do not make the component's effect a layout effect

It looks like the tidy fix — focus in the same commit as the message, no window
at all — and it regresses the surfaces that raise their failure from inside a
closing dialog, to exactly the outcome the component exists to prevent. Radix's
focus scope traps focus inside an open dialog and releases it from a *passive*
effect cleanup, restoring focus to whatever was focused when the dialog opened.
Those surfaces batch "close the dialog" and "record the failure" into one commit,
so a layout effect focuses the alert while the closing dialog's content is still
mounted: the trap steals it back and the release then hands focus to the control
that opened the dialog — or to `<body>` under a synthetic click, which does not
focus its button. `focused-action-error-focus-contract.test.tsx` pins this
deliberately; so, incidentally, does `deletion-requests-client.test.tsx`.

## A mutation probe is a change you have to undo

`AGENTS.md` requires every new guard to be mutation-verified: break the thing
the guard exists to catch, confirm the suite goes red, **then restore the
mutation and re-run**. The restore is the half that gets skipped, and a probe
left in the tree is a shipped defect wearing a green suite — the suite is green
precisely because the guard is still working on code you no longer meant to
ship.

Two traps make the restore less reliable than it looks:

- **Check the restore against the repository, not against your own backup.**
  `git diff` before committing is the only check that cannot agree with itself.
  A hash comparison against a copy you made is satisfied by a probe that never
  landed at all, which is the same vacuous pass the frozen-clock section is
  about.
- **On Windows, prove the probe landed where you think.** .NET's working
  directory is not PowerShell's: `[IO.File]::ReadAllText("AGENTS.md")` after a
  `Set-Location` into a worktree reads and writes the file of the **original**
  directory, so a probe run from a worktree can silently mutate — or, worse,
  no-op against — a different checkout. Use absolute paths, and assert the
  mutated text actually differs before you run the suite.

## A shell-out suite fails on Windows for a reason that is not load

Four suites prove a real `bash` gate by running it against a throwaway fixture:
`review-findings-contracts.test.ts`, `blue-green-ledger-lint.test.ts`,
`data-migration-verification-gate.test.ts` and
`adult-member-hosting-coverage-migration.test.ts`.

For a long time this section said the first of those was **load-sensitive** and
told you to re-run it alone. That was wrong, and it is worth knowing why,
because a wrong diagnosis that suggests an action is more expensive than no
diagnosis at all: three separate lanes in one session each re-established that
the red suite was not theirs, and each threw the reasoning away. Re-running can
never help, because load was never involved.

The measured cause (#2886) is that on Windows `bash` is
`C:\Windows\System32\bash.exe` — **WSL**, not Git Bash — and two things then
fail deterministically, on a clean tree, with the suite run alone:

1. A drive-letter fixture path does not exist inside WSL's filesystem
   namespace, so the gate reported `Migration SQL file not found: C:/Users/…`.
   Flipping the separators does not help; only a path **relative to the `cwd`
   the script is spawned with** resolves under both WSL and Git Bash.
2. Variables put on `spawnSync`'s `env` option do not cross into WSL at all.
   The gate saw them unset and fell back to its production defaults — so a test
   pointing the validator at a fixture ledger was silently running it against
   the repository's real `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`. That one failed
   without any error message, which is the more dangerous of the two.

Both are fixed centrally in `src/lib/__tests__/helpers/bash-fixture-path.ts`,
which carries the measurements. **Use `bashFixturePath` and `bashGateArgs` for
gate scripts, and `bashToolArgs` for a POSIX tool**. A same-volume Windows path
becomes relative; a cross-volume one is translated by the selected shell's
`wslpath` or `cygpath` and fails clearly if neither exists. On Linux and CI the
gate invocation is equivalent to what these suites did before, which was checked
by running both shapes over the same fixtures inside `node:24-bookworm` and
comparing status, stdout and stderr.

Two things this does *not* cover, so that the list stays honest:

- A POSIX tool must run through `bashToolArgs`, not as a native Windows command.
  The awk/TypeScript splitter-agreement case does exactly that: stock Windows
  has no `awk.exe`, but its WSL bash has `/usr/bin/awk`, so the comparison stays
  mandatory on Windows, Linux and CI. A missing shell-side tool is a real red,
  never a capability skip or a `status: null` that a weak assertion could miss.
- These suites do carry generous **inline** per-test timeouts, written as the
  third argument to each `it(...)`, and an inline timeout does win over
  `--testTimeout`. That is a real fact about editing them
  (`./helpers/migration-gate-timeouts.ts` holds the budgets and the reasoning) —
  it was simply never the reason they were failing.

### A test that launches a process needs its own budget (#3083)

The previous bullet is the general rule, and it applies outside the migration
gates. `src/lib/__tests__/env-delivery-census.test.ts` renders the Compose
stacks by running `docker compose config` for real, and it inherited the 5,000ms
`testTimeout` — a default chosen for in-process work, not for a fork. It went
red on #3081 with `Test timed out in 5000ms` while the same suite passed on two
other pull requests minutes earlier at the same base, which is the "a different
one fails each run" signature of a budget rather than a defect.

So an `it()` that shells out carries an inline timeout, measured and reasoned
where it is written. `COMPOSE_RENDER_TIMEOUT_MS` in that file is 30,000ms
against a ~200ms idle render, because contention is the whole variable: the same
render measured 530ms with 24 running at once and 2,104ms with 72, on a 20-core
host. Like the migration-gate budgets, it is a **hang-catcher, not a pass mark**
— on CI these finish in well under a second, so the number never decides a pull
request.

Raise it per test, never globally. `vitest.setup.ts` states `testTimeout` is
5,000ms and calibrates the 4,000ms RTL window to sit a clear second below it, so
a global change falsifies a documented constant in another file — and it would
let thousands of ordinary tests hang six times as long to buy headroom for six.

## Census tests and the merge hazard

A third convention that is load-bearing rather than stylistic, for the same
reason as the two above: written the obvious way, this reports green on
something other than what it claims.

A **census** is a test that pins how many call sites of a given shape exist —
every writer that can strand a booking, every `toLocaleDateString` escape, every
`ViewOnlyActionButton` opt-out. It is one of the strongest guards here, because
it fails the moment somebody adds a call site nobody classified.

It also carries a merge hazard no CI check can see. Two branches each add one
call site. Each bumps the census literal from `6` to `7` — the same line, the
same value — so git merges them with **no conflict**. Both were green alone, the
merged suite is green, and `main` now asserts `7` where the truth is `8`. The
next real addition sails through a census that has stopped counting anything.

So:

1. **Re-derive the count; never increment it.** Run the census against the tree
   in front of you and record what it reports. Never take the number you started
   with and add your own branch's additions to it.
2. **Re-derive it after every merge into your branch, and once more before
   flipping the PR ready.** Those are the only moments the merged tree exists.
3. **If the number moved for a reason you did not cause, the hazard has fired**
   — check the other branch's entries too. A wrong total usually means a wrong
   *classification*, not just arithmetic: something named that is not really a
   member of the set, or a real one missing. Commit `5a5e4e748` (#2649) found a
   census claiming "at least nine other producers" that was really six, with two
   of the named ones refuted outright.
4. **Prefer a census that enumerates over one that only counts.** Listing the
   entries by name puts two concurrent additions on the same lines, so git
   raises a conflict and a human classifies both — which is exactly the review a
   bare integer skipped.

## Mocking `requireAdmin`: reference the helper, never wrap it

A fourth convention in the same family — written the obvious way, a suite that
mocks the admin guard reports green on something other than what it claims.

`src/lib/__tests__/helpers/require-admin-mock.ts` is the shared `requireAdmin`
stand-in. Wire it in as a **bare reference**, from an `async` factory:

```ts
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
```

Not as a wrapper. A route tells the guard which area and level it needs by
passing `{ permission: { area, level } }`, and the helper can only honour that if
the value reaches it. An arrow that takes no parameter throws it away, the helper
falls back to `hasAdminPortalAccess` — "is this person in the admin portal at
all", a check the real guard has never performed — and **every per-area
assertion in that file becomes vacuous**. A `lodge:view` route and a
`lodge:edit` route stop being distinguishable.

That is not hypothetical. It was found (#2921) when a suite passed a mutation its
author had just written it to catch, and the sweep that followed found 50 more
files in the same state. The bare reference is preferred over "remember to
forward `options`" for one reason: every wrapper is a place the argument can be
dropped again, and the reference has no argument to drop. Keep a wrapper only
where one is load-bearing — a `vi.fn()` spy whose implementation is installed
later — and forward its own first parameter:

```ts
mockRequireAdmin.mockImplementation(async (options) =>
  (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(
    options,
  ),
);
```

Two controls enforce this, and they are complementary rather than redundant:

- the helper's parameter is **required** (it accepts `undefined`, because a route
  that passes no options is legitimate), so a bare `evaluateRequireAdminMock()`
  is a compile error that `npm run typecheck` catches;
- `require-admin-mock-forwarding-contract.test.ts` parses every test file that
  mentions the helper and fails on the shapes the type system cannot see —
  `evaluateRequireAdminMock({})` compiles cleanly and is just as inert. It reads
  `src/` from disk, so it has no import edge to the suites it scans and
  `npm run test:related` will not select it. Run it directly.

### Prove the gate, not the guard

Forwarding makes the gates live; it does not exercise them. Before #2921 almost
every admin suite signed in as `ADMIN` (which holds `edit` on every area) or
`USER` (which holds nothing), and a pair of fixtures like that can only ever
answer "is this person an admin at all".

`helpers/admin-area-gate-sessions.ts` carries the role fixtures for asserting the
real thing. Pin **both halves** of a requirement, plus one admission so a gate
broken shut is not mistaken for a gate that works:

- a view-only admin must be refused by an `:edit` route and admitted by a
  `:view` one — that pins the **level**;
- an admin with no access to the area at all must be refused outright — that
  pins the **area**, and it is the half that catches a route re-pointed at the
  `overview` catch-all;
- a role holding exactly the declared permission must get through.

Denials need no other setup: the guard answers before the handler touches the
database, so assert the status *and* that the write mock was never called.

The area half is worth the extra assertion. On fork PR #2949 three routes were
moved from `{ area: "finance", level: "edit" }` to
`{ area: "overview", level: "view" }` — a real privilege downgrade on
money-moving routes — and 83 tests still passed. Reproduced on this tree against
`main`'s pre-sweep suites, the same downgrade left all 32 of their tests green;
with the sweep and these fixtures in place it fails six assertions.

### The larger surface this does not cover

Two limits, stated rather than implied:

1. **A route that passes no explicit `permission` is still tested as "is this an
   admin at all".** The real guard falls back to `getAdminRouteRequirement()`
   keyed on the request path; a unit test calls the handler directly, so there is
   no path for the mock to resolve. 170 of 287 `/api/admin` routes pass an
   explicit literal and are covered; the rest resolve by prefix and are not.
   `admin-route-area-matrix.test.ts` pins that prefix map separately.
2. **188 test files mock `@/lib/session-guards` without this helper at all**,
   typically resolving `requireAdmin` straight to `{ ok: true, session }`. Those
   bypass the permission check entirely rather than degrading it, and neither
   control above says anything about them.
