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
 * the multi-line trailing-comma form that the original description of this
 * fault missed entirely; the instantiation-expression shapes that carry type
 * arguments with no call to hang them on; and every decorated `import()` type,
 * in and out of a parameter position.
 *
 * WHAT #3345 CHANGED, because this suite could not see either fault. #3318
 * reported only the FUNCTION PARAMETER position and printed "give the type a
 * name and use the name" as the remedy. Measured, `type P = import("x").A<null>`
 * does not parse either — so the guard was handing out an instruction that
 * created the hole it exists to close, and it was silent on the result. This
 * suite missed it because its remedy fixture kept a trailing index
 * (`Plan<null>["input"]`), which happens to be one of the few clean forms. Its
 * "measured clean: the same types outside a parameter position" fixture was
 * measurably NOT clean either — the `interface Holder` member in it fails — and
 * the case passed anyway because it only ever asserted ESLint's silence.
 *
 * THE MEASUREMENTS BEHIND EVERY CASE were taken with the pinned blocking image
 * `semgrep/semgrep:1.161.0` against minimal single-construct files, with a probe
 * rule written to defeat Semgrep's prefilter so every target is really parsed.
 * They are not inferred. Where a case says a shape "parses", that is what the
 * scanner did with it — and where a shape parses and is reported anyway, the
 * case says which margin argument pays for that.
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
 * incomplete: a trailing comma breaks it just as reliably, and 10 files were on
 * the allowlist for that alone — a formatter split the argument list across
 * lines and added the comma with the reflow. Nobody wrote that spelling deliberately, which is exactly why
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

/**
 * TYPE ARGUMENTS WITH NO CALL AT ALL — a `TSInstantiationExpression`.
 *
 * Measured: `f<typeof import("x")>` fails with "`>` was unexpected". #3318's
 * visitor keyed on `CallExpression.typeArguments`, and an instantiation
 * expression has no such property, so this was silent (#3345).
 */
const INSTANTIATION_EXPRESSION = `
declare function load<T = unknown>(): Promise<T>;
export const bound = load<typeof import("@/lib/capacity")>;
`;

/**
 * THE OPTIONAL CALL, whose type arguments hang off the CALLEE.
 *
 * Measured: `f<typeof import("x")>?.()` fails with "`>?.()` was unexpected".
 * It parses as an optional `CallExpression` over a `TSInstantiationExpression`,
 * so `CallExpression.typeArguments` is undefined here too and #3318 reported
 * nothing (#3345). Note the OTHER optional spelling,
 * `f?.<typeof import("x")>()`, measures clean — and is still reported, because
 * it is an ordinary call type-argument list and print width decides the rest.
 */
const INSTANTIATION_OPTIONAL_CALL = `
declare const load: (<T = unknown>() => Promise<T>) | undefined;
export const build = () => load<typeof import("@/lib/capacity")>?.();
`;

/** The other optional spelling. Measured clean; reported as part of the call class. */
const OPTIONAL_CALL_TYPE_ARGUMENTS = `
declare const load: (<T = unknown>() => Promise<T>) | undefined;
export const build = () => load?.<typeof import("@/lib/capacity")>();
`;

/**
 * TWO TYPE ARGUMENTS, with an argument and no trailing comma.
 *
 * Measured: `f<typeof import("x"), string>("x")` fails, where the same call with
 * ONE type argument parses. So "it needs an empty argument list" was never the
 * whole predicate even for a plain call.
 */
const TWO_TYPE_ARGUMENTS = `
declare function load<T = unknown, K = string>(path: string): Promise<T>;
export async function build() {
  return await load<typeof import("@/lib/capacity"), string>("@/lib/capacity");
}
`;

/*
  THE DECORATED-TYPE SHAPE. #3318 called this "the parameter shape" and reported
  it only there; #3345 measured the position out of the predicate almost
  entirely.

  MEASURED FAILING, everywhere they were tried: an `import()` type carrying a
  type-argument list (a parameter, a return, a variable, a TYPE ALIAS, an
  interface property, a class property, a generic constraint or default, a
  nested type argument, an `extends` or `implements` clause); one under `keyof`,
  with or without a qualifier; one wrapped in parentheses while carrying a
  qualifier; and an indexed access on one in a parameter or return position.

  MEASURED CLEAN in the same family: `import("x").A<null>["k"]` and
  `import("x").A["k"]` in an ALIAS, `x as import("x").A<null>`,
  `readonly import("x").A<null>[]`, `(typeof import("x"))` and
  `keyof typeof import("x")`.

  Adding an index to a failing alias FIXES it and removing one BREAKS it. That
  is why the rule reports the decoration wherever it appears rather than trying
  to describe the boundary, and why the remedy is a top-level type-only import
  rather than a reshape.
*/

/**
 * THE FORM #3345 EXISTS FOR: a type-argument list on an `import()` type in a
 * plain type alias, with no index after it.
 *
 * Measured: FAILS, `<null>` was unexpected. This is exactly what #3318's own
 * remedy text told an author to write, and #3318's rule was silent on it. If
 * this case ever goes green-by-silence again, the guard is back to printing an
 * instruction that opens an unscanned region.
 */
const ALIAS_TYPE_ARGUMENT = `
type Plan = import("@/lib/xero-contacts").Plan<null>;
export function reserve(input: Plan) {
  return input;
}
`;

/**
 * An interface property. Measured: FAILS.
 *
 * #3318 shipped a fixture asserting the opposite — "measured clean: the same
 * types outside a parameter position" — whose `interface Holder` member is this
 * construct. The case passed because it only asserted ESLint's silence, never
 * the scanner's.
 */
const INTERFACE_PROPERTY_TYPE_ARGUMENT = `
export interface Holder {
  plan: import("@/lib/x").Plan<null>;
}
`;

/** A return annotation. Measured: FAILS. Not a parameter, so #3318 missed it. */
const RETURN_TYPE_ARGUMENT = `
export function build(): import("@/lib/x").Plan<null> {
  throw new Error("never");
}
`;

/**
 * `keyof` over a module type. Measured: `keyof import("x")` and
 * `keyof import("x").A` both fail, while `keyof typeof import("x")` parses — so
 * the `typeof` in front is what rescues it, not the qualifier.
 */
const KEYOF_MODULE_TYPE = `
export type Keys = keyof import("@/lib/capacity");
`;

/**
 * An indexed access on an `import()` type in an ALIAS. Measured: parses.
 *
 * Reported anyway, and this is the case that shows why the class is the unit:
 * deleting the `["input"]` from this line produces `ALIAS_TYPE_ARGUMENT`, which
 * fails. A rule that only reported the failing spelling would leave every one of
 * these one edit from an allowlist entry.
 */
const INDEXED_ALIAS = `
type Input = import("@/lib/xero-contacts").Plan<null>["input"];
export function reserve(input: Input) {
  return input;
}
`;

/**
 * A parenthesised qualified `import()` type. Measured: `(import("x").A)` and
 * `(typeof import("x").v)` fail, while `(typeof import("x"))` parses.
 *
 * typescript-eslint drops `TSParenthesizedType` from the AST, so the rule reads
 * the surrounding tokens for this one. That is also why the DOUBLY parenthesised
 * module type is a stated limit rather than a covered case.
 */
const PARENTHESISED_QUALIFIED = `
export type Plan = (import("@/lib/xero-contacts").Plan);
`;

/** A type argument on the imported type, in a parameter. Measured: fails. */
const PARAM_TYPE_ARGUMENT = `
export function reserve(input: import("@/lib/xero-contacts").Plan<null>) {
  return input;
}
`;

/** An indexed access on the imported type, in a parameter. Measured: fails. */
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

/** A `TSFunctionType`'s parameter list is a parameter list. Measured: fails. */
const FUNCTION_TYPE_PARAM = `
export type Handler = (input: import("@/lib/x").Plan<null>["k"]) => void;
`;

/*
  THE PARAMETER POSITION, on its own, for an UNDECORATED type.

  This is the one arm resting on a margin argument rather than on a measured
  failure. MEASURED: `(i: import("x").A)` and `(i: typeof import("x"))` are both
  clean, and one added type argument, index or `keyof` fails. It is kept because
  a parameter annotation is where this fault was found — one line of it put
  `adult-member-hosting-queue-merge.realdb.test.ts` on the allowlist with none of
  the call shape in it at all — and because the remedy costs one import line.
*/

/** A bare qualified `import()` type in a parameter. Measured: parses. Reported. */
const PARAM_BARE = `
export function reserve(input: import("@/lib/xero-contacts").Plan) {
  return input;
}
`;

/** A bare module type in a parameter. Measured: parses. Reported. */
const PARAM_TYPEOF_MODULE = `
export function reserve(input: typeof import("@/lib/capacity")) {
  return input;
}
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

/**
 * THE REMEDY FOR A DECORATED TYPE: a top-level TYPE-ONLY import, and the name.
 *
 * Measured clean. It is a type-only import, so it is erased at compile time and
 * a module that must stay dynamically loaded stays dynamically loaded — which is
 * the objection that made #3318 reach for an alias instead.
 *
 * NOT the alias form. `type Plan = import("@/lib/x").Plan<null>` fails, and
 * `type Plan = import("@/lib/x").Plan<null>["input"]` — which #3318 shipped here
 * as the remedy fixture — happens to parse only because of the trailing index.
 * A remedy fixture that lands on the one clean sub-shape by luck cannot see the
 * instruction being wrong, which is how #3318 went out.
 */
const IMPORT_TYPE_REMEDY = `
import type { Plan } from "@/lib/xero-contacts";
export function reserve(input: Plan<null>["input"]) {
  return input;
}
`;

/** The namespace spelling of the same remedy. Measured clean. */
const NAMESPACE_IMPORT_TYPE_REMEDY = `
import type * as XeroContacts from "@/lib/xero-contacts";
export function reserve(input: XeroContacts.Plan<null>) {
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

/**
 * `new` with an UNDECORATED module type. Measured clean in every argument-list
 * variant — empty, with arguments, with a trailing comma, and with no
 * parentheses at all — which is why print width does not reach it and why
 * `NewExpression` is deliberately outside the call arm.
 */
const NEW_EXPRESSION = `
declare class Holder<T> {
  constructor(path?: string);
  value: T;
}
export function build() {
  return new Holder<typeof import("@/lib/capacity")>();
}
export function reflowed() {
  return new Holder<typeof import("@/lib/capacity")>(
    "@/lib/capacity",
  );
}
export function bare() {
  return new Holder<typeof import("@/lib/capacity")>;
}
`;

/** A tagged template's type argument. Measured clean, and not reported. */
const TAGGED_TEMPLATE = `
declare function sql<T = unknown>(strings: TemplateStringsArray): T;
export const rows = sql<typeof import("@/lib/capacity")>\`select 1\`;
`;

/**
 * THE `typeof import()` IDIOM, which is 454 of the 455 `import()` types in this
 * tree and must stay usable.
 *
 * Measured clean in every one of these positions, and none of them is reported:
 * the module type plain, a member of it, and an indexed access on it with and
 * without the parentheses. A rule that swept these up would have nowhere left to
 * send the call sites #3318 rewrote.
 */
const TYPEOF_MODULE_POSITIONS = `
type Whole = typeof import("@/lib/capacity");
type Member = typeof import("@/lib/capacity").resolveCapacity;
type Indexed = (typeof import("@/lib/capacity"))["resolveCapacity"];
type IndexedNoParens = typeof import("@/lib/capacity")["resolveCapacity"];
let whole: Whole;
export function read(): [Whole, Member, Indexed, IndexedNoParens] {
  return [whole, whole.resolveCapacity, whole.resolveCapacity, whole.resolveCapacity];
}
`;

/**
 * A BARE qualified `import()` type outside a parameter position. Measured clean,
 * and not reported.
 *
 * This is the undecorated half of the decorated arm's boundary, and the tree has
 * real instances of it — a return annotation in
 * `display-built-in-parity.test.tsx`, an alias in
 * `ai-diagnostics-select-only-role.realdb.test.ts`. Reporting these would turn
 * the rule into a ban on `import()` types outright.
 */
const BARE_QUALIFIED_OUTSIDE_PARAMETER = `
type Alias = import("@/lib/x").Plan;
let held: import("@/lib/x").Plan;
export interface Holder {
  plan: import("@/lib/x").Plan;
}
export function build(): import("@/lib/x").Plan {
  throw new Error("never");
}
export const cast = held as unknown as import("@/lib/x").Plan;
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
    why: "a unit test — where every call site #3318 measured lived",
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
    ["an instantiation expression with no call", INSTANTIATION_EXPRESSION],
    ["type arguments on an optional call's callee", INSTANTIATION_OPTIONAL_CALL],
    ["the other optional spelling, which parses", OPTIONAL_CALL_TYPE_ARGUMENTS],
    ["two type arguments with an argument", TWO_TYPE_ARGUMENTS],
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

describe("#3345: a decorated import() type is reported wherever it appears", () => {
  it.each([
    ["a type argument in a plain type alias", ALIAS_TYPE_ARGUMENT],
    ["a type argument on an interface property", INTERFACE_PROPERTY_TYPE_ARGUMENT],
    ["a type argument in a return annotation", RETURN_TYPE_ARGUMENT],
    ["keyof over a module type", KEYOF_MODULE_TYPE],
    ["an indexed alias, which parses today", INDEXED_ALIAS],
    ["a parenthesised qualified type", PARENTHESISED_QUALIFIED],
    ["a type argument in a parameter", PARAM_TYPE_ARGUMENT],
    ["an indexed access in a parameter", PARAM_INDEXED_ACCESS],
    ["the same, parenthesised", PARAM_PARENTHESISED_INDEXED],
    ["a TSFunctionType's parameter", FUNCTION_TYPE_PARAM],
  ])("reports %s", async (_label, code) => {
    const reports = await reportsFor(code, FIXTURE_FILE);

    expect(
      reports.length,
      "#3318 reported this class in the PARAMETER position only, and roughly a dozen further positions failed with the rule silent on every one. The position is nearly irrelevant; the decoration is the fault.",
    ).toBe(1);
    expect(reports[0]?.severity, "a warning blocks nothing").toBe(2);
    expect(
      reports[0]?.message,
      "The remedy for this shape is a top-level type-only import. An ALIAS over the import() type is what #3318 printed, and it does not parse — a guard that hands out that instruction opens the region it exists to protect.",
    ).toContain("import type { A } from");
  });

  it("does not print the alias remedy that #3318 got wrong", async () => {
    const [report] = await reportsFor(ALIAS_TYPE_ARGUMENT, FIXTURE_FILE);

    expect(
      report?.message,
      'Somebody following "give the type a name and use the name" writes `type P = import("x").A<null>;`, which is measured to FAIL and which this rule did not report. The message has to say the alias form fails, or the wrong instruction comes straight back.',
    ).toContain('`type P = import("@/lib/x").A<null>;` FAILS');
  });
});

describe("#3318: an undecorated import() type in a parameter is reported", () => {
  it.each([
    ["a bare qualified type, which parses today", PARAM_BARE],
    ["a bare module type, which parses today", PARAM_TYPEOF_MODULE],
  ])("reports %s", async (_label, code) => {
    const reports = await reportsFor(code, FIXTURE_FILE);

    expect(
      reports.length,
      "This shape put a file on the allowlist for as long as the construct description named only the call, and the entry read as unexplained the whole time. If the rule stops seeing it, that happens again.",
    ).toBe(1);
    expect(reports[0]?.severity).toBe(2);
    expect(
      reports[0]?.message,
      "This line parses. The message has to say so, and say what pays for reporting it anyway, or it reads as a false positive and the reader reaches for a disable comment.",
    ).toContain("THIS EXACT LINE PARSES TODAY");
  });
});

describe("#3318: the remedies and their neighbours are silent", () => {
  it.each([
    ["the cast the autofix writes", CAST_REMEDY],
    ["a top-level type-only import", IMPORT_TYPE_REMEDY],
    ["the namespace spelling of it", NAMESPACE_IMPORT_TYPE_REMEDY],
    ["a generic call with no import() type", GENERIC_WITHOUT_IMPORT_TYPE],
    ["every argument-list variant of new", NEW_EXPRESSION],
    ["a tagged template's type argument", TAGGED_TEMPLATE],
    ["the typeof import() idiom in every position", TYPEOF_MODULE_POSITIONS],
    ["a bare qualified type outside a parameter", BARE_QUALIFIED_OUTSIDE_PARAMETER],
  ])("is silent on %s", async (_label, code) => {
    const reports = await reportsFor(code, FIXTURE_FILE);

    expect(
      reports.map((report) => `${report.line}: ${report.message}`),
      "A guard that fires on the remedy it recommends, or on code the scanner reads perfectly well, teaches its reader to switch it off. Every construct in this group was measured against semgrep/semgrep:1.161.0 and parses.",
    ).toEqual([]);
  });
});

describe("#3345: the rule carries no per-file escape", () => {
  it("has no eslint-disable naming it anywhere in the tree", async () => {
    // `eslint.config.mjs` grants no allowlist and no exemption block, and until
    // #3345 that was the whole claim. An inline ESLint disable directive naming
    // this rule is exactly such an escape: `npm run lint` is bare `eslint` and
    // `noInlineConfig` is not set, and 37 files already carry directives for
    // other rules. This is the #2685 money-guard census applied to the same
    // hole — and `npm run lint` reports an unused directive, so a stale one
    // cannot hide here either.
    //
    // The residual it closes is asymmetric, which is why it is worth a test. For
    // a construct that genuinely fails to parse, a directive is bounded: the
    // coverage gate still sees the partial parse and fails the build. For the
    // half of the class that PARSES today it is unbounded, and that half is the
    // entire reason the rule was widened past the broken spelling.
    //
    // THIS CENSUS READS RAW SOURCE, so writing this rule's id on the same line
    // as the word below would make it report itself — `INV-SSOT-004`, the hazard
    // this repository hits hardest because it documents each defect at the site
    // it removed it. Comment-stripping is not the answer here: the thing being
    // hunted IS a comment. The discipline is instead to keep prose about a
    // directive on a different line from the rule id, which every mention in
    // this suite and in `eslint.config.mjs` does.
    const { execSync } = await import("child_process");
    const hits = execSync(
      'git grep -n --fixed-strings "eslint-disable" -- "*.ts" "*.tsx" "*.mts" "*.cts" "*.js" "*.jsx" "*.mjs" "*.cjs" || true',
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 26 },
    );
    const escapes = hits
      .split("\n")
      .filter((line) => line.includes("no-semgrep-unparsable-import-type"));

    expect(
      escapes,
      "Every arm of this rule has a remedy available everywhere that changes no behaviour, so a disable comment is only ever a way of signing part of a file off as unscanned. That is what `.semgrep/unparsed-allowlist.json` is for, with a written reason the gate refuses to omit.",
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
      "The fix rebuilds the whole await expression, so the line break and trailing comma a reflow introduced go away with it. If this drifts, the rewrite #3318 shipped is no longer what the rule would write.",
    ).toContain(expected);
    expect(
      await reportsFor(output, FIXTURE_FILE),
      "the fixed output must satisfy the rule, or `eslint --fix` loops",
    ).toEqual([]);
  });

  it.each([
    ["a callee it cannot prove resolves to T", UNKNOWN_CALLEE],
    ["a call that is not directly awaited", NOT_AWAITED],
    ["an instantiation expression with no call to await", INSTANTIATION_EXPRESSION],
    ["a parameter annotation, whose remedy is a new import line", PARAM_BARE],
    ["a decorated type, whose remedy is a new import line", ALIAS_TYPE_ARGUMENT],
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
