import path from "path";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * #3318 — the guard that stops `.semgrep/unparsed-allowlist.json` regrowing,
 * exercised through the REAL `eslint.config.mjs`.
 *
 * WHAT IT PROTECTS. Semgrep's `semgrep scan --error` exits 0 on code it could
 * not PARSE: the failure is a `warn`-level entry in the JSON `errors` array and
 * is nowhere in the exit status, so a file the scanner skipped a region of looks
 * exactly like a file it read and cleared. #2842 made that visible and gated it;
 * this rule is what removes the growth at source, which is the structural fix
 * `INV-SSOT-001` prefers over catching each new entry afterwards.
 *
 * WHY THIS SUITE EXISTS, given the rule already runs in `npm run lint`. Lint
 * proves the tree is clean TODAY. It cannot prove the rule would object to the
 * spelling nobody has written yet, and that is the whole property being bought —
 * the allowlist grew four separate times while #2842 was in flight, three of
 * them from sibling children rather than an upstream sync. The fixtures below
 * are the spellings that were not in the tree when the rule was written:
 * `importOriginal`, `vi.importActual` and a destructured bare `importActual`;
 * the multi-line trailing-comma form that the original description of this fault
 * missed entirely; and the four parameter-annotation forms.
 *
 * THE MEASUREMENTS BEHIND EVERY CASE were taken with the pinned blocking image
 * `semgrep/semgrep:1.161.0` against minimal repro files, not inferred. Where a
 * case says a shape "parses", that is what the scanner did with it.
 */

const BOOTSTRAP_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 20_000;

vi.setConfig({
  testTimeout: CASE_TIMEOUT_MS,
  hookTimeout: BOOTSTRAP_TIMEOUT_MS,
});

const REPO_ROOT = path.resolve(__dirname, "../../..");
const RULE_ID = "scan/no-semgrep-unparsable-import-type";

/** Where a fixture is pretended to live. Never a real file. */
const FIXTURE_FILE = path.join(
  REPO_ROOT,
  "src/lib/__tests__/unparsable-import-type-fixture.test.ts",
);

/*
  THE CALL SHAPE, in the three spellings the tree uses and the two argument
  forms that decide whether it parses.

  MEASURED: `f<typeof import("x")>()` fails with "`>()` was unexpected", the
  multi-line trailing-comma form fails with "`,` was unexpected", and
  `f<typeof import("x")>("x")` parses. All three spellings behave identically,
  because the fault is the syntax and not the callee - which is why the rule
  keys on the shape and only the FIX is name-gated.
*/

/** `importOriginal`, the vitest mock-factory argument. 143 files spell it this way. */
const IMPORT_ORIGINAL_EMPTY_ARGS = `
export async function build(
  importOriginal: <T = unknown>() => Promise<T>,
) {
  const actual = await importOriginal<typeof import("@/lib/booking-policies")>();
  return { ...actual };
}
`;

/** `vi.importActual`, the idiomatic spelling a contributor reaches for first. */
const VI_IMPORT_ACTUAL_EMPTY_ARGS = `
declare const vi: { importActual: <T = unknown>(path?: string) => Promise<T> };
export async function build() {
  const actual = await vi.importActual<typeof import("@/lib/capacity")>();
  return { ...actual };
}
`;

/**
 * A BARE `importActual`, destructured off `vi`.
 *
 * This is the spelling a name-keyed rule loses: it is neither `importOriginal`
 * nor `vi.importActual`, and #3132's by-name sweep is the precedent for what
 * happens then.
 */
const BARE_IMPORT_ACTUAL_EMPTY_ARGS = `
declare const vi: { importActual: <T = unknown>(path?: string) => Promise<T> };
const { importActual } = vi;
export async function build() {
  const actual = await importActual<typeof import("@/lib/xero-api-client")>();
  return { ...actual };
}
`;

/**
 * THE FORM THE ORIGINAL DESCRIPTION OF THIS FAULT MISSED.
 *
 * #2842 corrected "a generic call with an `import()` type argument" to "with an
 * EMPTY argument list", measured on a single-line repro. That correction is also
 * incomplete: a trailing comma breaks it just as reliably, and 11 files reached
 * the allowlist that way — a formatter split the argument list across lines and
 * added the comma. Nobody wrote that spelling deliberately, which is exactly why
 * a rule keyed on the empty parens would have gone on missing it.
 */
const TRAILING_COMMA_ARGUMENT = `
declare const vi: { importActual: <T = unknown>(path?: string) => Promise<T> };
export async function build() {
  const actual = await vi.importActual<typeof import("@/lib/member-merge")>(
    "@/lib/member-merge",
  );
  return { ...actual };
}
`;

/**
 * THE SPELLING THAT PARSES TODAY, and is reported anyway.
 *
 * Measured clean, and 23 files in the tree held it when #3318 started. It is
 * still a violation, because which side of the line a call sits on is decided by
 * PRINT WIDTH: a rename that pushes this past it produces the fixture above,
 * with no change of any substance. Banning the broken spelling rather than the
 * class would have left all 23 one reflow from an allowlist entry.
 */
const SINGLE_LINE_ARGUMENT = `
declare const vi: { importActual: <T = unknown>(path?: string) => Promise<T> };
export async function build() {
  const actual = await vi.importActual<typeof import("@/x")>("@/x");
  return { ...actual };
}
`;

/**
 * A CALLEE THE RULE DOES NOT KNOW TO RESOLVE TO `T`.
 *
 * Reported — the parse fault does not care what the function is called — but
 * NOT fixed. `(await loadModule()) as T` is only type-equivalent for a function
 * declared `<T = unknown>(...) => Promise<T>`, and an autofix that silently
 * changed a type would be worse than no autofix at all.
 */
const UNKNOWN_CALLEE = `
declare function loadModule<T = unknown>(): Promise<T>;
export async function build() {
  const actual = await loadModule<typeof import("@/lib/capacity")>();
  return { ...actual };
}
`;

/** The call is not directly awaited, so there is no `T` to assert. Reported, unfixed. */
const NOT_AWAITED = `
declare const vi: { importActual: <T = unknown>(path?: string) => Promise<T> };
export function build() {
  return vi
    .importActual<typeof import("@/lib/capacity")>()
    .then((actual) => ({ ...actual }));
}
`;

/*
  THE PARAMETER SHAPE, which nothing had written down until #3318 measured it,
  and which is the entire reason `adult-member-hosting-queue-merge.realdb.test.ts`
  sat on the allowlist carrying none of the call shape at all.

  MEASURED: `(i: import("x").A)` parses; `(i: import("x").A<null>)`,
  `(i: import("x").A["k"])` and `(i: (import("x").A)["k"])` all fail; and
  `(i: (typeof import("x"))["k"])` parses. The boundary inside the position is
  therefore incoherent, which is why the rule reports the POSITION and the remedy
  is to name the type rather than to reshape it.
*/

/** A type argument on the imported type. Measured: fails. */
const PARAM_TYPE_ARGUMENT = `
export function reserve(input: import("@/lib/xero-contacts").Plan<null>) {
  return input;
}
`;

/** An indexed access on the imported type. Measured: fails. */
const PARAM_INDEXED_ACCESS = `
export function reserve(input: import("@/lib/xero-contacts").Plan["input"]) {
  return input;
}
`;

/** The same, parenthesised. Measured: fails. */
const PARAM_PARENTHESISED_INDEXED = `
export function reserve(input: (import("@/lib/xero-contacts").Plan)["input"]) {
  return input;
}
`;

/**
 * A BARE `import()` type in a parameter, which parses today.
 *
 * Reported for the same reason `SINGLE_LINE_ARGUMENT` is: one added type
 * argument or index turns it into one of the three above, and the sub-shape that
 * breaks cannot be predicted from the shape.
 */
const PARAM_BARE = `
export function reserve(input: import("@/lib/xero-contacts").Plan) {
  return input;
}
`;

/** A `TSFunctionType`'s parameter list is a parameter list. Measured: fails. */
const FUNCTION_TYPE_PARAM = `
export type Handler = (input: import("@/lib/x").Plan<null>["k"]) => void;
`;

/*
  THE REMEDIES, and the neighbours a widening of this rule would break. Every one
  of these is measured clean, and every one of them is code somebody would
  legitimately write, so a report here is a false positive that would teach its
  reader to switch the rule off.
*/

/** The remedy for the call shape, which is what the autofix writes. */
const CAST_REMEDY = `
declare const vi: { importActual: <T = unknown>(path?: string) => Promise<T> };
export async function build() {
  const actual = (await vi.importActual()) as typeof import("@/lib/capacity");
  return { ...actual };
}
`;

/** The remedy for the parameter shape: name the type, use the name. */
const NAMED_ALIAS_PARAM = `
type Plan = import("@/lib/xero-contacts").Plan<null>["input"];
export function reserve(input: Plan) {
  return input;
}
`;

/** A generic call with no `import()` type. Nothing to do with this fault. */
const GENERIC_WITHOUT_IMPORT_TYPE = `
declare function load<T = unknown>(): Promise<T>;
export async function build() {
  return await load<string>();
}
`;

/** Measured: `new C<typeof import("x")>()` parses. `new` is unaffected. */
const NEW_EXPRESSION = `
declare class Holder<T> {
  constructor();
  value: T;
}
export function build() {
  return new Holder<typeof import("@/lib/capacity")>();
}
`;

/** Measured clean: the same types outside a parameter position. */
const NON_PARAMETER_POSITIONS = `
type Alias = import("@/lib/x").Plan<null>["k"];
let held: import("@/lib/x").Plan<null>["k"];
export interface Holder {
  plan: import("@/lib/x").Plan<null>["k"];
}
export function build(): import("@/lib/x").Plan<null>["k"] {
  throw new Error("never");
}
export function read(): Alias {
  return held;
}
`;

/**
 * REPRESENTATIVE PATHS THE RULE MUST REACH.
 *
 * Asked of ESLint rather than of the config's glob text, for the reason
 * `support/eslint-guard-coverage.ts` records: a string test on a pattern misses
 * a block with no `files` key, a glob that does not begin with `src/`, and a
 * severity downgrade. Test paths matter most — they are the entire population of
 * this fault, and the config switches `no-restricted-syntax` off for every one
 * of them, which is why this is a rule of its own.
 */
const REACHED_PATHS: readonly { file: string; why: string }[] = [
  {
    file: "src/lib/__tests__/example.test.ts",
    why: "a unit test — where all 307 call sites measured for #3318 lived",
  },
  {
    file: "src/components/admin/__tests__/example.test.tsx",
    why: "a component test, the .tsx half of the same population",
  },
  {
    file: "src/lib/__tests__/example.realdb.test.ts",
    why: "a real-Postgres suite, which is where the parameter shape was found",
  },
  {
    file: "src/lib/example.ts",
    why: "ordinary production code, where three parameter-shape sites were",
  },
  {
    file: "src/app/api/example/route.ts",
    why: "an API route",
  },
  {
    file: "scripts/example.mjs",
    why: "an operator script — Semgrep scans these too",
  },
  {
    file: "prisma/example.ts",
    why: "seed and migration helpers, the other non-src directory in scope",
  },
];

let eslint: ESLint;
let fixingEslint: ESLint;

/*
  THE CANARY. Most cases below assert "no report", so anything that makes ESLint
  return nothing at all — a fixture that will not parse, a path that turns out to
  be ignored, a config bootstrap that silently produced no rules — would pass
  every one of them vacuously. The hook lints a known violation and THROWS unless
  it produces exactly one report, so a broken run fails loudly before a single
  vacuous green is printed.
*/
beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO_ROOT, warnIgnored: false });
  fixingEslint = new ESLint({ cwd: REPO_ROOT, warnIgnored: false, fix: true });
  const reports = await reportsFor(IMPORT_ORIGINAL_EMPTY_ARGS, FIXTURE_FILE);
  if (reports.length !== 1) {
    throw new Error(
      `#3318 canary produced ${reports.length} report(s), expected exactly 1. The rule is not running against ${FIXTURE_FILE}, so every negative case below would have passed vacuously.`,
    );
  }
}, BOOTSTRAP_TIMEOUT_MS);

async function reportsFor(code: string, filePath: string) {
  const results = await eslint.lintText(code, { filePath });
  const messages = results.flatMap((result) => result.messages);

  const fatal = messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`fixture did not parse: ${fatal[0]?.message ?? "unknown"}`);
  }

  return messages.filter((message) => message.ruleId === RULE_ID);
}

async function fixedText(code: string) {
  const [result] = await fixingEslint.lintText(code, {
    filePath: FIXTURE_FILE,
  });
  return result?.output ?? code;
}

describe("#3318: the call shape is reported however it is spelled", () => {
  it.each([
    ["importOriginal with empty parens", IMPORT_ORIGINAL_EMPTY_ARGS],
    ["vi.importActual with empty parens", VI_IMPORT_ACTUAL_EMPTY_ARGS],
    ["a destructured bare importActual", BARE_IMPORT_ACTUAL_EMPTY_ARGS],
    ["the multi-line trailing-comma form", TRAILING_COMMA_ARGUMENT],
    ["the single-line form that parses today", SINGLE_LINE_ARGUMENT],
    ["a callee the rule cannot autofix", UNKNOWN_CALLEE],
    ["a call that is not directly awaited", NOT_AWAITED],
  ])("reports %s", async (_label, code) => {
    const reports = await reportsFor(code, FIXTURE_FILE);

    expect(
      reports.length,
      "The parse fault is a property of the syntax, not of the callee's name. A rule that misses one spelling leaves the same unscanned region behind under a second name, which is exactly how #3132's by-name sweep left seven copies alive.",
    ).toBe(1);
    expect(reports[0]?.severity, "a warning blocks nothing").toBe(2);
    expect(
      reports[0]?.message,
      "the message has to hand the reader the remedy, not just the verdict",
    ).toContain("as typeof import(");
  });

  it("says out loud that a spelling which parses today is still banned", async () => {
    const [report] = await reportsFor(SINGLE_LINE_ARGUMENT, FIXTURE_FILE);

    expect(
      report?.message,
      "Someone reported on a call that parses will go and check, find it parses, and conclude the rule is confused — then take the allowlist escape. The message has to explain that print width is what decides, or this case of the class reads as a false positive.",
    ).toContain("MAY WELL PARSE TODAY");
  });
});

describe("#3318: the parameter shape is reported in every failing form", () => {
  it.each([
    ["a type argument on the imported type", PARAM_TYPE_ARGUMENT],
    ["an indexed access on it", PARAM_INDEXED_ACCESS],
    ["the same, parenthesised", PARAM_PARENTHESISED_INDEXED],
    ["a bare import() type, which parses today", PARAM_BARE],
    ["a TSFunctionType's parameter", FUNCTION_TYPE_PARAM],
  ])("reports %s", async (_label, code) => {
    const reports = await reportsFor(code, FIXTURE_FILE);

    expect(
      reports.length,
      "This shape put a file on the allowlist for as long as the construct description named only the call, and the entry read as unexplained the whole time. If the rule stops seeing it, that happens again.",
    ).toBe(1);
    expect(reports[0]?.severity).toBe(2);
    expect(
      reports[0]?.message,
      "the remedy for this shape is a NAMED type, not the cast",
    ).toContain("Give the type a name");
  });
});

describe("#3318: the remedies and their neighbours are silent", () => {
  it.each([
    ["the cast the autofix writes", CAST_REMEDY],
    ["a named alias used as a parameter", NAMED_ALIAS_PARAM],
    ["a generic call with no import() type", GENERIC_WITHOUT_IMPORT_TYPE],
    ["new C<typeof import(...)>(), measured clean", NEW_EXPRESSION],
    ["the same types outside a parameter position", NON_PARAMETER_POSITIONS],
  ])("is silent on %s", async (_label, code) => {
    const reports = await reportsFor(code, FIXTURE_FILE);

    expect(
      reports.map((report) => `${report.line}: ${report.message}`),
      "A guard that fires on the remedy it recommends, or on code the scanner reads perfectly well, teaches its reader to switch it off. Every fixture here was measured clean against semgrep/semgrep:1.161.0.",
    ).toEqual([]);
  });
});

describe("#3318: the autofix writes the measured-clean form", () => {
  it.each([
    [
      "importOriginal with empty parens",
      IMPORT_ORIGINAL_EMPTY_ARGS,
      "const actual = (await importOriginal()) as typeof import(\"@/lib/booking-policies\");",
    ],
    [
      "vi.importActual with empty parens",
      VI_IMPORT_ACTUAL_EMPTY_ARGS,
      "const actual = (await vi.importActual()) as typeof import(\"@/lib/capacity\");",
    ],
    [
      "a destructured bare importActual",
      BARE_IMPORT_ACTUAL_EMPTY_ARGS,
      "const actual = (await importActual()) as typeof import(\"@/lib/xero-api-client\");",
    ],
    [
      "the multi-line trailing-comma form, whose reflow it undoes",
      TRAILING_COMMA_ARGUMENT,
      "const actual = (await vi.importActual(\"@/lib/member-merge\")) as typeof import(\"@/lib/member-merge\");",
    ],
    [
      "the single-line form that parses today",
      SINGLE_LINE_ARGUMENT,
      "const actual = (await vi.importActual(\"@/x\")) as typeof import(\"@/x\");",
    ],
  ])("rewrites %s", async (_label, code, expected) => {
    const output = await fixedText(code);

    expect(
      output.split("\n").map((line) => line.trim()),
      "The fix rebuilds the whole await expression, so the line break and trailing comma a reflow introduced go away with it. If this drifts, the 307-site rewrite #3318 shipped is no longer what the rule would write.",
    ).toContain(expected);
    expect(
      await reportsFor(output, FIXTURE_FILE),
      "the fixed output must satisfy the rule, or `eslint --fix` loops",
    ).toEqual([]);
  });

  it.each([
    ["a callee it cannot prove resolves to T", UNKNOWN_CALLEE],
    ["a call that is not directly awaited", NOT_AWAITED],
    ["a parameter annotation, whose remedy is a new declaration", PARAM_BARE],
  ])("refuses to fix %s", async (_label, code) => {
    const [report] = await reportsFor(code, FIXTURE_FILE);

    expect(
      report?.fix,
      "An autofix that changed a type, or guessed at a declaration the file does not have, would be worse than no autofix. These are reported and left to a person.",
    ).toBeUndefined();
    expect(await fixedText(code)).toBe(code);
  });
});

describe("#3318: the rule reaches every surface Semgrep scans", () => {
  it("is an error at each representative path", async () => {
    const problems: string[] = [];

    for (const entry of REACHED_PATHS) {
      const config = await eslint.calculateConfigForFile(
        path.join(REPO_ROOT, entry.file),
      );
      const severity = config.rules?.[RULE_ID];

      if (severity === undefined) {
        problems.push(`${entry.file} (${entry.why}): the rule is not enabled`);
        continue;
      }
      const level = Array.isArray(severity) ? severity[0] : severity;
      if (level !== 2 && level !== "error") {
        problems.push(
          `${entry.file} (${entry.why}): severity is ${JSON.stringify(level)}, not error. \`npm run lint\` runs bare \`eslint\` with no --max-warnings, so a warning blocks nothing.`,
        );
      }
    }

    expect(
      problems,
      "The population of this fault is TEST files, and the config switches `no-restricted-syntax` off for every one of them. If this rule stops reaching a surface, the allowlist starts growing there again with nothing to say so.",
    ).toEqual([]);
  });
});
