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
 * `getTodayDateOnly(timeZone = APP_TIME_ZONE)` was ONE LINE, and policing the
 * call sites it produced needed a hand-built census that walks parentheses to
 * count arguments and pins exact numbers by hand. Every bit of that machinery
 * existed because the default existed; #3123 deleted the six defaults and turned
 * the whole class into a compile error. The measurements — what CT-6 first
 * found, what #3107/#3121 took, and what #3123 cleared — are recorded in exactly
 * one place, `club-time-escape-hatch-census.test.ts`, and are not restated here:
 * a number restated in prose is a number that drifts, which is the rule
 * `eslint.config.mjs` states over `ENVIRONMENT_ZONE_ADAPTERS` and this file
 * obeys.
 *
 * The arm is NOT redundant with the environment-zone arm beside it, and the
 * difference is the whole reason this file exists. That arm is lifted for the
 * files on `ENVIRONMENT_ZONE_ADAPTER_FILES`, because an adapter has a reviewed
 * reason to read the environment — and a lifted group lifts the DEFAULT with
 * it. `src/lib/date-only.ts` held six defaults legally inside a block of its
 * own, and `src/lib/member-merge-field-kinds.ts` held a seventh on the shared
 * adapter block until #3126 deleted it. So `AUTHORITY_DEFAULT_RESTRICTIONS` is
 * on the mandatory set and NO block lifts it, which the first describe below
 * asserts from two directions. One member of that list is on
 * `PRODUCTION_GUARD_ROSTER` for the same reason, so every guard that uses the
 * roster is measured behind the lift rather than only in front of it.
 *
 * ## Two instruments, and they do NOT measure the same way
 *
 * A lint arm can stop resolving; a census can stop counting. Both are here, and
 * each sees something the other cannot:
 *
 * 1. **the arm** — resolved at a roster of production paths, then actually run
 *    over code that commits the defect, then run over code that does the same
 *    job correctly, which is the control that stops the second leg from being
 *    vacuous. It sees SYNTAX exhaustively, in a way no scanner can: every
 *    wrapper spelling of every shape, because each shape is closed by a PAIR of
 *    selectors — a `.right` field anchor and a `> .right <node>` descendant —
 *    rather than by a list of wrapper node types. It has no symbol table, so a
 *    renamed import is invisible to it;
 * 2. **a source census**, which reads the tree independently of ESLint entirely
 *    and RESOLVES ONE HOP OF INDIRECTION: a renamed import of an authority,
 *    `const { TZ } = process.env`, and `const env = process.env`. That is the
 *    half the arm cannot do, and it matters most inside
 *    `ENVIRONMENT_ZONE_ADAPTER_FILES`, where the liftable environment-zone arm
 *    that would otherwise catch an aliased read is lifted. It walks `src/`,
 *    `scripts/` and `prisma/`, because the arm resolves in all three and a
 *    directory with an arm and no second instrument is exactly what the census
 *    failure message tells its reader to distrust.
 *
 * THE CENSUS STRIPS COMMENTS, and that is load-bearing rather than tidy. This
 * repository documents each defect at the site where it removed it, so the
 * strings a scanner greps for are DENSEST in the files that no longer commit the
 * defect. On this branch the raw text names the banned binding in strictly more
 * files than the code does — most of those occurrences are PROSE, including the
 * docblock #3126 wrote to explain deleting a default and a
 * `finance-sync-cron-config.ts` header explaining a defect it does not commit —
 * and the code holds exactly one, the structural definition in
 * `src/config/operational.ts`. Both halves of that are asserted at the bottom of
 * this file rather than written down as figures here, for the same
 * numbers-drift reason as above. A raw-text census would have reported this
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
 * `src/lib/stripe.ts` writes exactly this twice today, on `chargePaymentMethod`
 * and `createPaymentIntent`, and both are correct.
 *
 * WHY IT IS CORRECT, stated carefully because an earlier draft of this comment
 * got it wrong. It does NOT rest on the currency being single-sourced today: two
 * admin display formatters hardcode `currency: "NZD"` instead of reading
 * `APP_CURRENCY`, and `schema.prisma` gives `PaymentTransaction.currency` a
 * `"nzd"` column default. Those are a separate, pre-existing defect that this
 * arm neither addresses nor is the right instrument for. It rests on there being
 * no persisted club-currency SETTING competing with `APP_CURRENCY`, so there is
 * no wrong-source-of-two for a default to pick — and on cost: every live call
 * site relies on this default rather than passing a currency, so deleting it
 * would spread the `@/config/operational` import across those modules without
 * touching either hardcoded formatter. `INV-SSOT-003` carries the ratchet that
 * brings both names in the day a persisted club-currency setting ships.
 *
 * If this ever starts reporting, the arm has stopped being about the wrong one
 * of TWO sources and has become a ban on reading configuration.
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
    //
    // A FLOOR, NOT A COUNT, and deliberately so: the arm is built as four PAIRS
    // — a field anchor and a descendant form per shape — so the honest floor is
    // four times two. It was nine while the arm enumerated wrapper node types,
    // and enumeration is what six spellings walked past; replacing two
    // wrapper-specific selectors with one general descendant form made the
    // family SMALLER and strictly stronger, which is why an array length is the
    // wrong thing to assert here. The spellings suite below is what actually
    // holds the coverage, because it measures outcomes rather than length.
    expect(
      SSOT_GUARD_ARMS.authorityDefault.length,
      "The INV-SSOT-003 arm family has fallen below its four self/descendant " +
        "pairs, so some shape has lost one of its two forms and is now closed " +
        "only when it is written bare.",
    ).toBeGreaterThanOrEqual(8);
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
    // ------------------------------------------------------------------
    // THE WRAPPED SPELLINGS. Every one of these walked past the arm while
    // it enumerated `LogicalExpression` and `ConditionalExpression` by
    // name, and the first three are not exotic — they are what the TYPE
    // SYSTEM forces. `process.env.TZ` is `string | undefined`, so on the
    // `timeZone: string` parameter this codebase writes everywhere the
    // defect CANNOT be spelled `= process.env.TZ` at all. Of the three
    // spellings that compile against a `string` parameter — `?? "…"`,
    // `!` and `as string` — the enumerated arm closed one.
    // ------------------------------------------------------------------
    [
      "an `as` assertion, which is what a `string` parameter forces",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f(tz: string = APP_TIME_ZONE as string) {\n  return tz;\n}",
    ],
    [
      "a non-null assertion on the environment read, same reason",
      "export function f(tz: string = process.env.TZ!) {\n  return tz;\n}",
    ],
    [
      "an `as` assertion on the environment read",
      "export function f(tz: string = process.env.TZ as string) {\n  return tz;\n}",
    ],
    [
      "a `satisfies` expression",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f(tz: string = APP_TIME_ZONE satisfies string) {\n  return tz;\n}",
    ],
    [
      "a template literal",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f(tz: string = `${APP_TIME_ZONE}`) {\n  return tz;\n}",
    ],
    [
      "a call wrapping the authority",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f(tz: string = String(APP_TIME_ZONE)) {\n  return tz;\n}",
    ],
    [
      "a sequence expression, which defeats a naive field anchor",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f(tz: string = (0, APP_TIME_ZONE)) {\n  return tz;\n}",
    ],
    [
      "a parenthesised authority",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f(tz: string = (APP_TIME_ZONE)) {\n  return tz;\n}",
    ],
    [
      "two wrappers at once",
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f(tz: string = (String(APP_TIME_ZONE) as string)) {\n  return tz;\n}",
    ],
    [
      "a computed namespace read behind an assertion",
      'import * as operational from "@/config/operational";\n' +
        'export function f(tz: string = operational["APP_TIME_ZONE"] as string) {\n  return tz;\n}',
    ],
    [
      "an optional namespace read",
      'import * as operational from "@/config/operational";\n' +
        "export function f(tz: string | undefined = operational?.APP_TIME_ZONE) {\n  return tz;\n}",
    ],
    [
      "the environment reached through globalThis",
      "export function f(tz: string | undefined = globalThis.process.env.TZ) {\n  return tz;\n}",
    ],
    [
      "the environment reached optionally",
      "export function f(tz: string | undefined = process?.env?.TZ) {\n  return tz;\n}",
    ],
    [
      "NEXT_PUBLIC_TZ behind a non-null assertion",
      "export function f(tz: string = process.env.NEXT_PUBLIC_TZ!) {\n  return tz;\n}",
    ],
  ];

  it.each(spellings)("reports %s exactly once", async (_label, code) => {
    // EXACTLY once, not at least once. Two reports at one line:column is the
    // shape #2685 shipped and had to unpick.
    //
    // THIS IS THE ASSERTION THAT PAYS FOR THE ARM'S DESIGN. Every shape is
    // closed by a PAIR of selectors — a `.right` field anchor for the bare
    // spelling and a `> .right <node>` descendant for every wrapped one — and
    // the pair is safe only because the descendant combinator EXCLUDES self. If
    // that ever stopped being true, or if somebody added back a wrapper-specific
    // selector that overlaps the general one, every row here would report twice
    // and this suite is what says so. The row to watch is the options-object
    // form, whose inner `AssignmentPattern` nests inside an outer one: the outer
    // pattern's `right` is the `{}` and contains nothing, the inner pattern's
    // `right` IS the authority, so exactly one selector of the eight can match.
    expect(await messagesFor(code, "src/lib/x.ts")).toHaveLength(1);
  });

  it("reports TWICE when there really are two violating nodes", async () => {
    // The control that stops the suite above from being satisfied by an arm
    // that can only ever fire once. `?? ` puts two DISTINCT authorities in one
    // default — the operational export and the environment variable behind it —
    // and they must be reported separately, at different columns, because a
    // reader fixing one has to see the other.
    const messages = await messagesFor(
      'import { APP_TIME_ZONE } from "@/config/operational";\n' +
        "export function f(tz: string = APP_TIME_ZONE ?? process.env.TZ!) {\n  return tz;\n}",
      "src/lib/x.ts",
    );
    expect(messages).toHaveLength(2);
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

/**
 * Every production `.ts`/`.tsx` in the directories the arm reaches, tests
 * excluded.
 *
 * `src/`, `scripts/` AND `prisma/`, because the arm is on the mandatory set and
 * resolves in all three — measured, not assumed: `scripts/x.ts` and
 * `prisma/seed-x.ts` are both on `PRODUCTION_GUARD_ROSTER` and the enforced
 * audit above fires at each. A census that walked only `src/` would leave two of
 * the three directories with an arm and no second instrument, which is precisely
 * the state the failure message below tells the reader to distrust.
 */
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
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

/** The directories the arm resolves in, and therefore the ones this walks. */
const CENSUS_ROOTS = ["src", "scripts", "prisma"];

/** A file's CODE, with its prose removed. See {@link stripComments}. */
const readCode = (file: string): string =>
  stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));

/** The authority exports of `@/config/operational` that `INV-SSOT-003` names. */
const AUTHORITY_EXPORTS = ["APP_TIME_ZONE", "APP_LOCALE"] as const;

/** The environment variables behind the club's zone. */
const AUTHORITY_ENV_VARS = ["TZ", "NEXT_PUBLIC_TZ"] as const;

/** Regex-safe alternation, for building a scanner from a name list. */
const alternate = (names: readonly string[]): string =>
  names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

/**
 * The LOCAL names in one file that resolve a club authority.
 *
 * THIS IS THE HALF THE LINT ARM CANNOT DO, and it is why the second instrument
 * is a source census rather than a second selector. A `no-restricted-syntax`
 * selector matches a shape in one file's syntax tree; it has no symbol table, so
 * `import { APP_TIME_ZONE as CLUB_ZONE }` renames the authority out of its reach
 * and `tz: string = CLUB_ZONE` is invisible to it. The census reads the whole
 * file, so it can follow the rename.
 *
 * It resolves three indirections, each of which was measured walking past BOTH
 * instruments during #3126's review — and walking past them WORST inside the
 * `ENVIRONMENT_ZONE_ADAPTER_FILES` block, where the liftable environment-zone
 * arm that would otherwise have caught them is lifted:
 *
 *  1. `import { APP_TIME_ZONE as CLUB_ZONE } from "@/config/operational"`;
 *  2. `const { TZ } = process.env`, with or without its own rename;
 *  3. `const env = process.env`, after which `env.TZ` is the environment's zone.
 *
 * WHAT IT STILL CANNOT SEE, said plainly rather than left to be discovered.
 * Aliasing is transitive and this resolves ONE hop: `const A = CLUB_ZONE` and
 * then `tz = A` is not resolved, nor is an authority that leaves the file and
 * comes back through another module's re-export. Closing either needs a real
 * binder rather than a scanner, and neither has a live instance in this tree.
 * Both are stated in the census failure message as well, so whoever trips it is
 * told what the instrument does not cover instead of inferring a completeness it
 * does not have.
 */
function authorityLocalNames(code: string): {
  readonly values: readonly string[];
  readonly envObjects: readonly string[];
} {
  const values = new Set<string>(AUTHORITY_EXPORTS);
  const envObjects = new Set<string>();

  // 1. Named imports from the operational config, alias or not. The module is
  //    reached as `@/config/operational` everywhere except from inside
  //    `src/config/` itself, which uses a relative specifier.
  const importClause =
    /import\s*\{([^}]*)\}\s*from\s*["'](?:@\/config\/operational|(?:\.{1,2}\/)+(?:config\/)?operational)["']/g;
  for (const match of code.matchAll(importClause)) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const named = specifier
        .trim()
        .match(/^(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?$/);
      if (!named) continue;
      const [, exported, local] = named;
      if ((AUTHORITY_EXPORTS as readonly string[]).includes(exported ?? "")) {
        values.add(local ?? exported ?? "");
      }
    }
  }

  // 2. `const { TZ } = process.env` and `const { TZ: hostZone } = process.env`.
  const envDestructure = /\{([^}]*)\}\s*=\s*process\s*\.\s*env\b/g;
  for (const match of code.matchAll(envDestructure)) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const named = specifier.trim().match(/^(\w+)(?:\s*:\s*(\w+))?$/);
      if (!named) continue;
      const [, key, local] = named;
      if ((AUTHORITY_ENV_VARS as readonly string[]).includes(key ?? "")) {
        values.add(local ?? key ?? "");
      }
    }
  }

  // 3. `const env = process.env`, which makes `env.TZ` the environment's zone.
  //    A PARAMETER default of the same shape is the injection seam the arm
  //    deliberately allows, so this reads declarations only.
  const envAlias =
    /\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*process\s*\.\s*env\s*(?![.[])/g;
  for (const match of code.matchAll(envAlias)) {
    if (match[1]) envObjects.add(match[1]);
  }

  return { values: [...values], envObjects: [...envObjects] };
}

/**
 * An assignment or default whose value is one of the club authorities
 * `INV-SSOT-003` names, in the local spellings {@link authorityLocalNames}
 * resolved for that file.
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
 *
 * The `OPENERS` run between the `=` and the name is what lets it see a WRAPPED
 * binding — `` = `${APP_TIME_ZONE}` ``, `= String(APP_TIME_ZONE)`, `= (ZONE)`.
 * It admits only OPENING syntax, never an argument that has already been
 * written, so `= formatDateOnlyForTimeZone(instant, APP_TIME_ZONE)` — passing a
 * zone IN, which is the correct shape — does not match. That distinction is
 * asserted in the near-miss block below.
 */
function clubAuthorityBinding(code: string): RegExp {
  const { values, envObjects } = authorityLocalNames(code);
  const openers = "(?:\\w+\\s*\\(\\s*|\\(\\s*|`\\s*|\\$\\{\\s*|new\\s+|await\\s+)*";
  const qualifier = "(?:\\w+\\s*\\.\\s*)?";
  const envVars = alternate(AUTHORITY_ENV_VARS);
  const envRead = (receiver: string): string =>
    `${receiver}\\s*(?:\\.\\s*(?:${envVars})\\b|\\[\\s*["'](?:${envVars})["']\\s*\\])`;
  const branches = [
    `${qualifier}(?:${alternate(values)})\\b`,
    // `process.env`, and also `process["env"]` — computed access is the
    // documented escape from every syntactic rule, and it costs one
    // alternation here to close rather than one more selector pair there.
    envRead(`process\\s*(?:\\.\\s*env|\\[\\s*["']env["']\\s*\\])`),
    ...envObjects.map((name) => envRead(alternate([name]))),
  ];
  return new RegExp(
    `(?<![=!<>+\\-*/%&|^])=(?!=)\\s*${openers}(?:${branches.join("|")})`,
  );
}

/** Does this file's CODE bind a club authority, under its own local names? */
const bindsClubAuthority = (code: string): boolean =>
  clubAuthorityBinding(code).test(code);

describe("the scanner counts what it claims to count", () => {
  it("counts each spelling of the binding", () => {
    for (const code of [
      "function f(tz = APP_TIME_ZONE) {}",
      "function f({ tz = APP_TIME_ZONE }) {}",
      "const zone = process.env.TZ;",
      'const zone = process.env["NEXT_PUBLIC_TZ"];',
      "function f(tz =\n  APP_TIME_ZONE) {}",
      // Wrapped, which the arm closes structurally and this closes by admitting
      // opening syntax between the `=` and the name.
      "function f(tz = `${APP_TIME_ZONE}`) {}",
      "function f(tz = String(APP_TIME_ZONE)) {}",
      "function f(tz = (APP_TIME_ZONE)) {}",
      "function f(tz = APP_TIME_ZONE as string) {}",
      "function f(tz = process.env.TZ!) {}",
      // Computed access to `env` itself, which is the documented escape from
      // every syntactic rule in this file and costs one alternation to close.
      'export function f(tz = process["env"].TZ) { return tz; }',
      'export function f(tz = process["env"]["NEXT_PUBLIC_TZ"]) { return tz; }',
      // Namespace access, which the `=`-anchored pattern used to walk past
      // because the name is not adjacent to the `=`.
      "function f(tz = operational.APP_TIME_ZONE) {}",
    ]) {
      expect(bindsClubAuthority(code), code).toBe(true);
    }
  });

  it("follows the three indirections the lint arm has no symbol table for", () => {
    for (const code of [
      // A renamed import. The arm sees `CLUB_ZONE`, which is on no list.
      'import { APP_TIME_ZONE as CLUB_ZONE } from "@/config/operational";\n' +
        "export function f(tz: string = CLUB_ZONE) { return tz; }",
      // The zone destructured out of the environment first.
      "const { TZ } = process.env;\nexport function f(tz = TZ) { return tz; }",
      // The same, renamed on the way out.
      "const { TZ: hostZone } = process.env;\n" +
        "export function f(tz = hostZone) { return tz; }",
      // The environment object aliased, then read.
      "const env = process.env;\nexport function f(tz = env.TZ) { return tz; }",
      "const env = process.env;\n" +
        'export function f(tz = env["NEXT_PUBLIC_TZ"]) { return tz; }',
    ]) {
      expect(bindsClubAuthority(code), code).toBe(true);
    }
  });

  it("does NOT count the near misses", () => {
    for (const code of [
      // Passing a zone in is the correct shape, not the defect — and it stays a
      // near miss even though the scanner now admits opening syntax after `=`,
      // because an argument already written is not opening syntax.
      "formatDateOnlyForTimeZone(instant, APP_TIME_ZONE);",
      "const day = formatDateOnlyForTimeZone(instant, APP_TIME_ZONE);",
      // A different environment variable entirely.
      "const secret = process.env.CRON_SECRET;",
      // An equality test is not a binding.
      "if (candidate === APP_TIME_ZONE) return;",
      // A club zone read from the club, which is the whole point.
      "const zone = await clubTimeZone();",
      // The whole environment as an injection seam, which the arm allows by
      // name. It must not be read as an alias that then makes the seam itself a
      // zone binding.
      "export function f(env: NodeJS.ProcessEnv = process.env) { return env.X; }",
      // A rename of something that is NOT an authority.
      'import { APP_CURRENCY as MONEY } from "@/config/operational";\n' +
        "export function f(c = MONEY) { return c; }",
    ]) {
      expect(bindsClubAuthority(code), code).toBe(false);
    }
  });

  it("reads CODE, not prose — the failure this whole method exists to avoid", () => {
    // Not a hypothetical, and not a refinement. #3123 measured four cases where
    // a raw-source scanner misfired on this repository's own postmortems: two
    // false greens and two false reds. The docblock below is close to one that
    // shipped in `member-merge-field-kinds.ts`, written to explain the default
    // #3126 DELETED.
    const postmortem =
      "/**\n * It used to carry `= APP_TIME_ZONE`, which was the environment's\n" +
      " * answer and not the club's. #3126 deleted it.\n */\n" +
      "export function render(value: Date, timeZone: string) {\n" +
      "  return { value, timeZone };\n}\n";
    expect(bindsClubAuthority(postmortem)).toBe(true);
    expect(bindsClubAuthority(stripComments(postmortem))).toBe(false);
  });
});

describe("the census: nothing in the tree binds a club authority but the module that defines them", () => {
  it("names exactly one file, and it is the structural one", () => {
    const binding = CENSUS_ROOTS.flatMap((root) =>
      walk(path.join(ROOT, root)),
    ).filter((file) => bindsClubAuthority(readCode(file)));

    expect(
      binding,
      "A production file binds the environment's zone (`INV-SSOT-003`). If it " +
        "is a parameter default, the lint arm should have caught it and did " +
        "not — say so, because that means the two instruments disagree and one " +
        "of them is broken. If it is a module-level binding, this census is " +
        "broader than the arm on purpose and the question is whether a second " +
        "module should be reading the environment at all. Two spellings are " +
        "invisible to BOTH instruments and are stated limits rather than gaps " +
        "somebody forgot: an alias of an alias (`const A = CLUB_ZONE`, then " +
        "`tz = A`), and an authority re-exported through another module and " +
        "imported from there. Each needs a real binder rather than a scanner, " +
        "and neither has a live instance.\n" + binding.join("\n"),
    ).toEqual(["src/config/operational.ts"]);
  });

  it("would report more files' worth of prose if it read raw source", () => {
    // The measurement behind the docblock at the top of this file, kept as an
    // assertion so the claim cannot quietly stop being true. Comments in this
    // tree name `= APP_TIME_ZONE` in strictly MORE files than code does, because
    // the house style documents each defect at the site where it removed it.
    const files = CENSUS_ROOTS.flatMap((root) => walk(path.join(ROOT, root)));
    const raw = files.filter((file) =>
      bindsClubAuthority(fs.readFileSync(path.join(ROOT, file), "utf8")),
    );
    const code = files.filter((file) => bindsClubAuthority(readCode(file)));
    expect(
      raw.length,
      "Raw source no longer over-reports, so this assertion has stopped " +
        "demonstrating anything. Check that `stripComments` is still being " +
        "applied above before lowering it — the two instruments have to measure " +
        "the same way or they are one instrument and a rubber stamp.",
    ).toBeGreaterThan(code.length);
  });
});
