// Global test setup.
//
// The email layer (src/lib/email-delivery.ts) validates delivery configuration
// and refuses to build a transport — throwing "Email delivery is not
// configured" — when EMAIL_FROM or the SES credentials are absent. Unit tests
// mock nodemailer's transport, so no real mail is ever sent; these fake values
// exist only to satisfy that config gate, mirroring how CI supplies a fake
// STRIPE_SECRET_KEY value.
//
// EMAIL_FROM is set to SAFE_DEFAULT_CONFIG.supportEmail — the exact value
// email-sender.ts falls back to when EMAIL_FROM is unset (C6 #1985: the envelope
// sender is bootstrap-derived, never club.json) — so the rendered "from" address
// is byte-for-byte identical to the unset behaviour and no test that asserts the
// sender address changes. Set with ??= so any test that deliberately exercises a
// different/!ok config by assigning or deleting these keeps control.
import { vi } from "vitest";
import { SAFE_DEFAULT_CONFIG } from "@/config/club";

// `server-only` is a Next.js guard that throws when a module is imported outside
// a Server Component. Server-side libraries (e.g. member-photo.ts) legitimately
// import it; in the Vitest node environment the guard has no meaning, so stub it
// globally. Without this, any test that transitively imports a server-only
// module fails to load. Applies to all test files via setupFiles.
vi.mock("server-only", () => ({}));

process.env.EMAIL_FROM ??= SAFE_DEFAULT_CONFIG.supportEmail;
process.env.AWS_SES_ACCESS_KEY_ID ??= "test-ses-access-key-id";
process.env.AWS_SES_SECRET_ACCESS_KEY ??= "test-ses-secret-access-key";

// Keep dotenv silent under Vitest. Scripts a suite imports (for example
// `scripts/config-self-heal.ts`, via `import "dotenv/config"`) print dotenv's
// "injected env (N) from .env" banner unless told not to. dotenv 18 prints it
// with console.error, so it lands in the stderr a CLI test asserts is empty
// (config-self-heal-cli.test.ts). Both names are set on purpose: dotenv 18
// reads DOTENV_QUIET and falls back to DOTENV_CONFIG_QUIET, while dotenv 17
// reads only DOTENV_CONFIG_QUIET. `??=` so a run can still opt back in.
process.env.DOTENV_QUIET ??= "true";
process.env.DOTENV_CONFIG_QUIET ??= "true";

// The frozen test clock (#2481) is installed by `vitest.clock-setup.ts`, which
// `vitest.config.mts` lists BEFORE this file so that "today" is already pinned
// when this module's own imports evaluate. See that file and
// `src/lib/__tests__/helpers/clock.ts`.

/*
  HEADROOM FOR A LOADED RUNNER, not cover for a slow test.

  React Testing Library's async utilities — `findBy*`, `findAllBy*`, `waitFor`,
  `waitForElementToBeRemoved` — run on their OWN clock, `asyncUtilTimeout`, which
  defaults to 1000ms and is entirely separate from vitest's `testTimeout`. When
  that window expires RTL throws

      TestingLibraryElementError: Unable to find role="button" and name "Any member"

  which reads like a missing element, and has been written off as flake for
  exactly that reason. It is a timeout. Nothing was missing: the identical query
  passes in the sibling case two `it` blocks further down the same file.

  Measured on this repository for #2944, by instrumenting RTL's `asyncWrapper`
  over one pass of `src/app/(admin)` — 73 files, 546 tests, 558 async waits:

    idle developer machine        slowest single wait   470ms   (2.1x margin)
    same box, 12 CPU burners      slowest single wait  1144ms   (no margin —
                                                                 3 of 558 waits
                                                                 blew the window)

  So the default is not a comfortable ceiling that load occasionally grazes. A
  busy runner goes straight through it, and because which wait loses is a matter
  of scheduling, a DIFFERENT suite fails each run — the signature that got this
  filed as flake three times. CI here runs a suite roughly 1.7x slower than an
  idle developer machine (measured in #2923), which already puts that idle 470ms
  at ~800ms before a single other job shares the box.

  4,000ms is deliberately NOT 5,000ms. vitest's `testTimeout` is 5,000ms, and an
  equal RTL window loses the race to it: vitest's rejection lands first and
  reports the opaque "Test timed out in 5000ms" instead of RTL's message, which
  names the failing query and dumps the DOM. Staying a clear second below keeps
  that diagnostic. 4,000ms is 8.5x the measured idle worst case and 3.5x the
  loaded one.

  A wider window costs a passing test nothing — every one of these utilities
  resolves the moment its callback succeeds, so the timeout is only ever paid by
  a wait that was going to fail. It changes how long a genuine failure takes to
  report, and nothing else.

  What it does NOT license is waiting instead of thinking. A test that interacts
  with a page before that page has settled has an ORDERING bug, and widening the
  window around one converts it into a slow pass rather than fixing it.
  `src/app/(admin)/admin/__tests__/occupancy-calendar-pages.test.tsx` is the
  worked example (#2944): it waits for the page's own lodge-scoped read before it
  clicks, and its synchronous assertions stay synchronous.

  Configured here rather than per file because the exposure is broad, not
  incidental: 219 of the 314 test files that import `@testing-library/react` or
  `@testing-library/dom` use at least one of these utilities — 131 use `findBy*`
  or `findAllBy*`, 199 use `waitFor`, none use `waitForElementToBeRemoved` — and
  they are spread across the tree rather than clustered (82 under `src/lib`, 69
  under `src/components`, 66 under `src/app`, 2 under `src/hooks`). Nothing in the
  tree calls `configure()` itself, passes a per-call `{ timeout }`, or asserts
  that one of these utilities rejects, so this ceiling is the only one in play.

  Imported dynamically and only under jsdom: `vitest.config.mts` sets the default
  environment to `node`, and the several hundred node-environment suites have no
  reason to pay for loading the DOM testing library.
*/
if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/dom");
  configure({ asyncUtilTimeout: 4_000 });
}
