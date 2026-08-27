import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

import {
  MANDATORY_SRC_RESTRICTIONS,
  SRC_RESTRICTION_EXEMPTIONS,
  SSOT_GUARD_ARMS,
} from "../../../eslint.config.mjs";
import {
  auditEnforcedGuardCoverage,
  auditResolvedGuardCoverage,
  PRODUCTION_GUARD_ROSTER,
} from "./support/eslint-guard-coverage";

/**
 * `INV-SSOT-003` (#3126) — a parameter that resolves a CLUB authority may not
 * carry a default.
 *
 * ## What the rule is, in one sentence
 *
 * Single source of truth is violated when a default routes to the WRONG one of
 * two sources. The club's civil time has exactly two candidate sources — the
 * persisted `ClubTimeSettings.timeZone` row, which is the club's, and the
 * environment's `TZ` / `NEXT_PUBLIC_TZ` behind `APP_TIME_ZONE`, which is the
 * container's — and a default silently picks the container for every caller who
 * did not pass one.
 *
 * `APP_LOCALE` is on the banned list too, and for the record it is there AHEAD
 * of its second source: `schema.prisma` holds no persisted club locale today, so
 * nothing yet competes with it. `INV-SSOT-003` lists it because it is the same
 * kind of value and the live default population is zero, which makes listing it
 * now free and listing it later a migration. The currency pair is excluded by
 * name in that same invariant, with a ratchet sentence; the control below is the
 * assertion that keeps the exclusion real.
 *
 * ## Why it is worth a guard of its own
 *
 * `getTodayDateOnly(timeZone = APP_TIME_ZONE)` was ONE LINE. It carried 81 call
 * sites across 52 files, and policing them needed a hand-built census that walks
 * parentheses to count arguments and pins five exact numbers by hand. Every bit
 * of that machinery existed because the default existed; #3123 deleted the six
 * defaults and turned the whole class into a compile error.
 *
 * The arm is NOT redundant with the environment-zone arm beside it, and the
 * difference is the whole reason this file exists. That arm is lifted for the
 * files on `ENVIRONMENT_ZONE_ADAPTER_FILES`, because an adapter has a reviewed
 * reason to read the environment — and a lifted group lifts the DEFAULT with
 * it. `src/lib/date-only.ts` held six defaults legally inside a block of its
 * own, and `src/lib/member-merge-field-kinds.ts` held a seventh on the shared
 * adapter block until #3126 deleted it. So `AUTHORITY_DEFAULT_RESTRICTIONS` is
 * on the mandatory set and NO block lifts it, which the first describe below
 * asserts from two directions.
 *
 * ## Two instruments, measuring the same way
 *
 * A lint arm can stop resolving; a census can stop counting. Both are here:
 *
 * 1. **the arm** — resolved at a roster of production paths, then actually run
 *    over code that commits the defect, then run over code that does the same
 *    job correctly, which is the control that stops the second leg from being
 *    vacuous;
 * 2. **a source census**, which greps the tree for the shape independently of
 *    ESLint entirely.
 *
 * THE CENSUS STRIPS COMMENTS, and that is load-bearing rather than tidy. This
 * repository documents each defect at the site where it removed it, so the
 * strings a scanner greps for are DENSEST in the files that no longer commit the
 * defect. Measured on this branch: the raw text of `src/` holds four occurrences
 * of the banned binding across three files, and THREE of those four occurrences
 * are PROSE — two in the very docblock #3126 wrote to explain deleting the
 * default, one in a `finance-sync-cron-config.ts` header explaining a defect it
 * does not commit. In code there is exactly one, the structural definition in
 * `src/config/operational.ts`. A raw-text census would have reported this
 * issue's success as its failure, which is what #3123 measured four times over.
 */

const ROOT = path.resolve(__dirname, "../../..");

/** The shape the arm exists to refuse, in the spelling this codebase writes. */
const AUTHORITY_DEFAULT_VIOLATION = `
import { APP_TIME_ZONE } from "@/config/operational";
export function renderClubDay(value: Date, timeZone: string = APP_TIME_ZONE) {
  return { value, timeZone };
}
`;

/**
 * The control, and it is a REAL call site rather than an invented one:
 * `src/lib/stripe.ts` writes exactly this twice today and both are correct.
 *
 * There is one source for the currency in this product — `@/config/operational`
 * reads `CURRENCY` / `NEXT_PUBLIC_CURRENCY`, and no persisted club-currency
 * setting exists — so a boundary module reading the single source is single
 * source of truth working, not failing. If this ever starts reporting, the arm
 * has stopped being about the wrong one of TWO sources and has become a ban on
 * reading configuration, which would send five correct money call sites to be
 * rewritten and spread the `@/config/operational` import to five more modules.
 */
const AUTHORITY_DEFAULT_CONTROL = `
import { APP_STRIPE_CURRENCY } from "@/config/operational";
export function createIntent(amountCents: number, currency = APP_STRIPE_CURRENCY) {
  return { amountCents, currency };
}
`;

const SSOT_PREFIX = "INV-SSOT-003";

let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT, warnIgnored: false });
  // ESLint's first `lintText` pays for config resolution and parser load. Pay it
  // here so the per-path audits below stay inside their timeouts.
  await eslint.lintText(AUTHORITY_DEFAULT_CONTROL, {
    filePath: path.join(ROOT, "src/lib/warmup.ts"),
  });
}, 120_000);

/** Messages this guard raised for one snippet at one path. */
async function messagesFor(code: string, file: string): Promise<string[]> {
  const results = await eslint.lintText(code, {
    filePath: path.join(ROOT, file),
  });
  return results
    .flatMap((result) => result.messages)
    .filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        (message.message ?? "").startsWith(SSOT_PREFIX),
    )
    .map((message) => message.message ?? "");
}

describe("the arm is mandatory everywhere, and nothing lifts it", () => {
  type Restriction = { selector: string; message: string };

  it("declares arms at all, so requiring them of every path requires something", () => {
    // Vacuity guard. An empty family would make every assertion below trivially
    // true, which is the failure mode a guard suite is most likely to have.
    expect(
      SSOT_GUARD_ARMS.authorityDefault.length,
      "The INV-SSOT-003 arm family is empty, so the guard bans nothing.",
    ).toBeGreaterThanOrEqual(9);
  });

  it("keeps every arm inside the mandatory restriction set", () => {
    // The mandatory set is what every `src/**`, `scripts/**` and `prisma/**`
    // block is built from. An arm that fell out of it would be enforced nowhere
    // while still existing as a named array somebody could read and believe.
    const mandatory = new Set(
      (MANDATORY_SRC_RESTRICTIONS as Restriction[]).map((r) => r.selector),
    );
    const missing = SSOT_GUARD_ARMS.authorityDefault.filter(
      (selector) => !mandatory.has(selector),
    );
    expect(
      missing,
      "These INV-SSOT-003 selectors are no longer in ALWAYS_RESTRICTED_IN_SRC, " +
        "so no block picks them up:\n" + missing.join("\n"),
    ).toEqual([]);
  });

  it("carries NO exemption, which is a requirement of the design and not an accident", () => {
    // Zero exemptions is the point. The defect this arm names lived for months
    // inside an exemption written for something else: the environment-zone group
    // is lifted for adapters that must READ the zone, and lifting it lifted the
    // DEFAULT too. An entry here would re-open that by construction, so the
    // failure message says what to do instead — delete the default.
    const exempting = SRC_RESTRICTION_EXEMPTIONS.filter((exemption) =>
      (exemption.omits as Restriction[]).some((restriction) =>
        SSOT_GUARD_ARMS.authorityDefault.includes(restriction.selector),
      ),
    ).map((exemption) => JSON.stringify(exemption.files));

    expect(
      exempting,
      "A block now lifts the INV-SSOT-003 arm for these paths. There is no such " +
        "thing as a file that needs a default on a club authority: the remedy " +
        "is to DELETE the default and let the compiler enumerate the call " +
        "sites, which is what #3123 did to six of them and #3126 to the " +
        "seventh. Reading the environment can be excused; defaulting to it " +
        "cannot.\n" + exempting.join("\n"),
    ).toEqual([]);
  });

  it("resolves with every arm at every production path on the shared roster", async () => {
    const problems = await auditResolvedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      requiredSelectorsFor: () => SSOT_GUARD_ARMS.authorityDefault,
    });
    expect(
      problems,
      "INV-SSOT-003: the arm does not resolve to `error` with every selector at " +
        "a production path the roster names. Flat config REPLACES a rule's " +
        "option list rather than merging it, so a block written to lift one " +
        "guard removes the others by omission and lint goes green over an " +
        "unguarded file.",
    ).toEqual([]);
  }, 120_000);

  it("actually reports the violation at every one of them", async () => {
    // The structural leg above compares selector STRINGS. This one compares
    // outcomes, so it also catches a selector that is present and matches
    // nothing — a wrong selector passes the first leg and fails this one.
    const problems = await auditEnforcedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      violatingCode: AUTHORITY_DEFAULT_VIOLATION,
      messagePrefix: SSOT_PREFIX,
    });
    expect(problems).toEqual([]);
  }, 120_000);

  it("leaves the currency defaults alone — the control that makes the ban meaningful", async () => {
    for (const entry of PRODUCTION_GUARD_ROSTER) {
      expect(
        await messagesFor(AUTHORITY_DEFAULT_CONTROL, entry.file),
        `${entry.file} (${entry.why}) rejected \`currency = APP_STRIPE_CURRENCY\`, ` +
          "so this arm bans reading configuration rather than banning a default " +
          "that picks the wrong one of two sources. `src/lib/stripe.ts` writes " +
          "that exact line twice and both are correct.",
      ).toEqual([]);
    }
  }, 120_000);
});

describe("every spelling of the defect is closed", () => {
  /**
   * Each of these was run against the shipped config while #3126 was built, and
   * each reported exactly once. They are kept as a suite rather than as a
   * transcript because a probe you ran once proves the arm worked once.
   *
   * The options-object form is the shape this codebase actually writes, and the
   * wrapped forms are what somebody reaches for the moment a bare read looks
   * unsafe — `tz = process.env.TZ ?? "Pacific/Auckland"` is the same defect with
   * a nicer face.
   */
  const spellings: Array<[string, string]> = [
    [
      "a plain parameter default",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f(tz: string = APP_TIME_ZONE) {\n  return tz;\n}",
    ],
    [
      "an options-object property default",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f({ tz = APP_TIME_ZONE }: { tz?: string } = {}) {\n  return tz;\n}",
    ],
    [
      "an array-destructuring default",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f([tz = APP_TIME_ZONE]: string[]) {\n  return tz;\n}",
    ],
    [
      "a destructured default inside a body",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f(opts: { tz?: string }) {\n" +
        "  const { tz = APP_TIME_ZONE } = opts;\n  return tz;\n}",
    ],
    [
      "the environment variable behind it, read dotted",
      "export function f(tz: string | undefined = process.env.TZ) {\n  return tz;\n}",
    ],
    [
      "the same read computed, which is the documented escape from every syntactic rule here",
      'export function f(tz: string | undefined = process.env["TZ"]) {\n  return tz;\n}',
    ],
    [
      "wrapped in a nullish fallback",
      'export function f(tz: string = process.env.TZ ?? "Pacific/Auckland") {\n  return tz;\n}',
    ],
    [
      "wrapped in a ternary",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        'export function f(live: boolean, tz: string = live ? APP_TIME_ZONE : "UTC") {\n  return tz;\n}',
    ],
    [
      "reached through a namespace import",
      'import * as operational from "@/config/operational";\n' +
        "export function f(tz: string = operational.APP_TIME_ZONE) {\n  return tz;\n}",
    ],
    [
      "reached through a namespace import, computed",
      'import * as operational from "@/config/operational";\n' +
        'export function f(tz: string = operational["APP_TIME_ZONE"]) {\n  return tz;\n}',
    ],
    [
      "APP_LOCALE, which INV-SSOT-003 lists ahead of its second source",
      'import { APP_LOCALE } from "@/config/operational";\n' +
        "export function f(locale: string = APP_LOCALE) {\n  return locale;\n}",
    ],
  ];

  it.each(spellings)("reports %s exactly once", async (_label, code) => {
    // EXACTLY once, not at least once. Two reports at one line:column is the
    // shape #2685 shipped and had to unpick, and it is what a selector matching
    // the authority as a DESCENDANT of the AssignmentPattern would produce for
    // the options-object form, whose inner pattern nests inside an outer one.
    expect(await messagesFor(code, "src/lib/x.ts")).toHaveLength(1);
  });
});

describe("the stated boundaries hold — each of these must stay clean", () => {
  /**
   * Every entry is something the arm deliberately does NOT ban, with the reason
   * it does not. Stating the boundary is half of this arm's value, and a
   * boundary nothing asserts is a boundary that moves the next time somebody
   * widens a regular expression.
   */
  const boundaries: Array<[string, string]> = [
    [
      "the currency pair, which INV-SSOT-003 excludes by name and with a ratchet",
      'import { APP_CURRENCY } from "@/config/operational";\n' +
        "export function f(currency = APP_CURRENCY) {\n  return currency;\n}",
    ],
    [
      "a different environment variable, which has exactly one source",
      "export function f(secret: string | undefined = process.env.CRON_SECRET) {\n" +
        "  return secret;\n}",
    ],
    [
      "the whole environment as an injection seam, as admin-cron-health.ts writes it",
      "export function f(env: NodeJS.ProcessEnv = process.env) {\n" +
        "  return env.CRON_ENABLED;\n}",
    ],
    [
      "a body-level fallback, which is the same hazard and the stated known limit",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f(opts: { tz?: string }) {\n" +
        "  return opts.tz ?? APP_TIME_ZONE;\n}",
    ],
    [
      "a default that CALLS a club authority resolver, which returns the club's own answer",
      'import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";\n' +
        "export async function f(tz: string = await readClubTimeZoneOutsideRequest()) {\n" +
        "  return tz;\n}",
    ],
    [
      "an ordinary default that is not an authority at all",
      "export function f(limit = 10) {\n  return limit;\n}",
    ],
  ];

  it.each(boundaries)("does not report %s", async (label, code) => {
    expect(
      await messagesFor(code, "src/lib/x.ts"),
      `${label} is now reported. That is a WIDENING, not a fix: read the block ` +
        "above `NO_CLUB_AUTHORITY_DEFAULT` in eslint.config.mjs, which records " +
        "why each of these is out of scope and what would have to change for it " +
        "to come in.",
    ).toEqual([]);
  });
});

describe("the message hands the reader the rule, the remedy and the precedent", () => {
  it("names all three", async () => {
    const [message] = await messagesFor(
      AUTHORITY_DEFAULT_VIOLATION,
      "src/lib/x.ts",
    );
    // A guard whose message is only a prohibition sends whoever trips it looking
    // for a workaround. This one has to say what to do instead, and that the
    // remedy has already been applied once in this repository.
    expect(message).toContain("INV-SSOT-003");
    expect(message).toContain("INV-CONFIG-002");
    expect(message).toContain("DELETE THE DEFAULT");
    expect(message).toContain("#3123");
    // Three runtimes, three different answers, and getting this wrong is how a
    // CLI acquires a `server-only` edge that breaks it at import.
    expect(message).toContain("clubTimeZone()");
    expect(message).toContain("readClubTimeZoneOutsideRequest()");
    expect(message).toContain("ClubTimeProvider");
  });
});

// ---------------------------------------------------------------------------
// THE SECOND INSTRUMENT: a source census that does not go through ESLint at all.
// ---------------------------------------------------------------------------

/** Every production `.ts`/`.tsx` under `src/`, tests excluded. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") {
        walk(full, out);
      }
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)
    ) {
      out.push(path.relative(ROOT, full).replaceAll("\\", "/"));
    }
  }
  return out;
}

/**
 * An assignment or default whose value is one of the club authorities
 * `INV-SSOT-003` names, in every spelling the lint arm closes.
 *
 * DELIBERATELY BROADER THAN THE ARM: it cannot tell a parameter default from a
 * module-level binding, so it also matches the one structural definition in the
 * tree. That is the right direction of error for a second instrument — it may
 * over-report and be argued down, and it may never under-report and be believed.
 *
 * The lookaround around the `=` is not decoration. Without it the pattern
 * matched `candidate === APP_TIME_ZONE`, an equality TEST rather than a binding
 * — and the near-miss block below is what found that, before the census was
 * ever pointed at the tree. That is the order this file's neighbours use, for
 * exactly this reason: a census whose scanner is subtly wrong reports a
 * comfortable number and everybody believes it.
 */
const CLUB_AUTHORITY_BINDING =
  /(?<![=!<>+\-*/%&|^])=(?!=)\s*(?:APP_TIME_ZONE\b|APP_LOCALE\b|process\s*\.\s*env\s*(?:\.\s*(?:TZ|NEXT_PUBLIC_TZ)\b|\[\s*["'](?:TZ|NEXT_PUBLIC_TZ)["']\s*\]))/;

/** A file's CODE, with its prose removed. See {@link stripComments}. */
const readCode = (file: string): string =>
  stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));

describe("the scanner counts what it claims to count", () => {
  it("counts each spelling of the binding", () => {
    for (const code of [
      "function f(tz = APP_TIME_ZONE) {}",
      "function f({ tz = APP_TIME_ZONE }) {}",
      "const zone = process.env.TZ;",
      'const zone = process.env["NEXT_PUBLIC_TZ"];',
      "function f(tz =\n  APP_TIME_ZONE) {}",
    ]) {
      expect(CLUB_AUTHORITY_BINDING.test(code), code).toBe(true);
    }
  });

  it("does NOT count the near misses", () => {
    for (const code of [
      // Passing a zone in is the correct shape, not the defect.
      "formatDateOnlyForTimeZone(instant, APP_TIME_ZONE);",
      // A different environment variable entirely.
      "const secret = process.env.CRON_SECRET;",
      // An equality test is not a binding.
      "if (candidate === APP_TIME_ZONE) return;",
      // A club zone read from the club, which is the whole point.
      "const zone = await clubTimeZone();",
    ]) {
      expect(CLUB_AUTHORITY_BINDING.test(code), code).toBe(false);
    }
  });

  it("reads CODE, not prose — the failure this whole method exists to avoid", () => {
    // Not a hypothetical, and not a refinement. #3123 measured four cases where
    // a raw-source scanner misfired on this repository's own postmortems: two
    // false greens and two false reds. The docblock below is close to one that
    // ships in `member-merge-field-kinds.ts` today, written to explain the
    // default #3126 DELETED.
    const postmortem =
      "/**\n * It used to carry `= APP_TIME_ZONE`, which was the environment's\n" +
      " * answer and not the club's. #3126 deleted it.\n */\n" +
      "export function render(value: Date, timeZone: string) {\n" +
      "  return { value, timeZone };\n}\n";
    expect(CLUB_AUTHORITY_BINDING.test(postmortem)).toBe(true);
    expect(CLUB_AUTHORITY_BINDING.test(stripComments(postmortem))).toBe(false);
  });
});

describe("the census: nothing in the tree binds a club authority but the module that defines them", () => {
  it("names exactly one file, and it is the structural one", () => {
    const binding = walk(path.join(ROOT, "src")).filter((file) =>
      CLUB_AUTHORITY_BINDING.test(readCode(file)),
    );

    expect(
      binding,
      "A production file binds the environment's zone (`INV-SSOT-003`). If it " +
        "is a parameter default, the lint arm should have caught it and did " +
        "not — say so, because that means the two instruments disagree and one " +
        "of them is broken. If it is a module-level binding, this census is " +
        "broader than the arm on purpose and the question is whether a second " +
        "module should be reading the environment at all.\n" + binding.join("\n"),
    ).toEqual(["src/config/operational.ts"]);
  });

  it("would report three files' worth of prose if it read raw source", () => {
    // The measurement behind the docblock at the top of this file, kept as an
    // assertion so the claim cannot quietly stop being true. Comments in this
    // tree name `= APP_TIME_ZONE` in strictly MORE files than code does, because
    // the house style documents each defect at the site where it removed it.
    const files = walk(path.join(ROOT, "src"));
    const raw = files.filter((file) =>
      CLUB_AUTHORITY_BINDING.test(
        fs.readFileSync(path.join(ROOT, file), "utf8"),
      ),
    );
    const code = files.filter((file) =>
      CLUB_AUTHORITY_BINDING.test(readCode(file)),
    );
    expect(
      raw.length,
      "Raw source no longer over-reports, so this assertion has stopped " +
        "demonstrating anything. Check that `stripComments` is still being " +
        "applied above before lowering it — the two instruments have to measure " +
        "the same way or they are one instrument and a rubber stamp.",
    ).toBeGreaterThan(code.length);
  });
});
