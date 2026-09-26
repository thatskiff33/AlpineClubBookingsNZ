/**
 * THE MONEY-SEAM MOCK CENSUS (#3341). Enforces `INV-OPS-015`
 * (`docs/invariants/operations.md`): a test may not mock a named money seam
 * away AND assert a money figure that seam affects.
 *
 * WHY. #3340 under-charged two members $135. The sizing line was written when a
 * booking could hold one outstanding extra; PR #543 then made a later edit
 * RETIRE an earlier edit's unpaid extra (`queueSupersededAdditionalIntentCancellations`),
 * and its one test change mocked the new query to return nothing. Every suite
 * that touched the supersede machinery mocked it, so the sizing and the
 * retirement never once ran in the same test, and every ask assertion stayed
 * green over a figure that was wrong the moment the seam did its job. This file
 * makes that shape fail CI whoever is or is not reviewing.
 *
 * WHAT COUNTS AS "MOCKED". Per seam, in one test file:
 *
 *   - KEYED — a `vi.mock` / `vi.doMock` factory for the seam's module names the
 *     seam, whatever it puts there. A pass-through wrapper counts too: the
 *     census cannot tell a delegating stand-in from a lying one, and neither can
 *     a reviewer at a glance.
 *   - AUTOMOCK — `vi.mock(module)` with no factory, or an options object.
 *   - OPAQUE — a factory whose returned value is not an object literal
 *     (`() => sharedFactory()`), or that spreads anything but the real module
 *     (`...mocks` from `vi.hoisted`, `...overrides`), so what it replaces cannot
 *     be read here. Counted as mocked: a helper must not be the way round this
 *     file.
 *   - SPY — `vi.spyOn(anything, "<seam>")`, or `vi.mock(module, { spy: true })`,
 *     which keeps the implementation only until `vi.mocked(seam).mock…()`
 *     replaces it.
 *   - ABSENT — a literal factory that neither names the seam nor spreads the
 *     real module. Vitest THROWS when a missing export is read, so for most seams
 *     that is a loud failure rather than a stand-in and is not counted. It IS
 *     counted for a seam whose `absentIsSilent` says its caller swallows that
 *     throw — see the seam's own `why`.
 *
 * A factory that spreads the real module (`...(await importOriginal())`) and does
 * not name the seam leaves it LIVE.
 *
 * WHAT COUNTS AS "A MONEY FIGURE THE SEAM AFFECTS". An `expect(...)` statement,
 * matchers and all, that names one of the seam's `figures`, or — for a seam with
 * `mintedAsk` — reads a mint double (`createPaymentIntent` /
 * `upsertPaymentIntentTransaction`) for an `amountCents` on an ADDITIONAL
 * instrument. Statement-local, deliberately: a whole-file vocabulary would flag
 * every money suite in the tree.
 *
 * WHAT IT CANNOT SEE, said plainly so nobody leans on it harder than it bears:
 *
 *   - AN INDIRECT MOCK OF THE SEAM'S OWN COLLABORATORS. Mocking the query the
 *     seam reads to return `[]` — exactly what #543 did — leaves the seam
 *     "real" and inert. The census cannot tell an honest empty ledger from a
 *     muzzled one. The compensating control is the PINNED witness below,
 *     `superseded-additional-ask-integration.test.ts`, which runs every seam
 *     over a ledger that actually holds the row being retired. The per-seam
 *     witness check beside it is only a heuristic: a source-scanning census
 *     that names a seam in an `expect` satisfies it without running anything
 *     (`booking-ledger-census.test.ts` does, measured when this landed).
 *   - ASSERTION STYLES THE STATEMENT-LOCAL READ MISSES (each measured clean
 *     beside a keyed mock): an expected object held in a variable
 *     (`expect(data).toEqual(expected)`); a file snapshot (`toMatchSnapshot()`)
 *     or an `it.each` table; a mint-amount assertion that does not name the
 *     ADDITIONAL instrument in the same statement — a bare
 *     `objectContaining({ amountCents })` on `createPaymentIntent`, or
 *     `mock.calls[0][0].amountCents`; a figure spelled outside the seam's
 *     vocabulary; and an `expect` built in a helper in another file. The
 *     ADDITIONAL-marker requirement is deliberate: without it every
 *     primary-intent suite reads as a supersede suite.
 *   - A `vi.mock` in a vitest setup file (none targets a seam today).
 *   - A module that re-exports a seam under another path. None exists today.
 *   - This file itself, which holds seeded offenders as string fixtures.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { blankLiteralsWithSpans } from "./support/strip-comments";

const INVARIANT_ID = "INV-OPS-015";
const REPO_ROOT = process.cwd();
const THIS_FILE = "src/lib/__tests__/money-seam-mock-census.test.ts";

/** The additional-ask figures: what a supersede retires and a mint re-homes. */
const ASK_FIGURES = [
  "additionalAmountCents",
  "additionalAsk",
  "carriedAskCents",
  "carriedCents",
] as const;

interface MoneySeam {
  /** The exported function. */
  readonly name: string;
  /** Repo-relative module path, no extension. */
  readonly module: string;
  /** Identifiers whose appearance in an `expect` statement is a money assertion. */
  readonly figures: readonly string[];
  /** Whether an ADDITIONAL mint double's `amountCents` is a figure it affects. */
  readonly mintedAsk: boolean;
  /** Whether a factory that simply omits the seam is a silent stand-in. */
  readonly absentIsSilent: boolean;
  readonly why: string;
}

/**
 * THE SEAM LIST — one constant, so it is greppable and extendable. Adding a seam
 * means naming the figures it affects; the census then holds every suite to it.
 */
export const MONEY_SEAMS: readonly MoneySeam[] = [
  {
    name: "queueSupersededAdditionalIntentCancellations",
    module: "src/lib/booking-payment-cleanup",
    figures: ASK_FIGURES,
    mintedAsk: true,
    absentIsSilent: true,
    why:
      "Retires every other live ADDITIONAL intent on the payment, so the ask a mint raises is only right if it carried their unpaid balance (#3340). ABSENT is counted: the minter calls it inside its provider try/catch, so vitest's missing-export throw is swallowed into a logged mint failure and the ask assertions still pass.",
  },
  {
    name: "createModificationAdditionalPaymentIntent",
    module: "src/lib/booking-modification-settlement",
    figures: ASK_FIGURES,
    mintedAsk: true,
    absentIsSilent: false,
    why:
      "The one minter of an ADDITIONAL ask: it writes the row's amount and carried provenance and triggers the supersede. Mocking it asserts the ask a caller HANDED IN, never the one the member is asked for.",
  },
  {
    name: "reconcilePaymentAggregates",
    module: "src/lib/payment-transactions",
    figures: ["additionalAmountCents"],
    mintedAsk: false,
    absentIsSilent: false,
    why:
      "Mirrors the latest ADDITIONAL row into `Payment.additionalAmountCents`, which is what the NEXT edit's sizing reads back. Its other outputs (`refundedAmountCents`, `amountCents`, status) share their names with PaymentTransaction fields the code under test writes itself, so a text census cannot attribute them and they are left off.",
  },
];

// ---------------------------------------------------------------------------
// Reading source: offsets preserved, comments gone, string contents kept.
// ---------------------------------------------------------------------------

interface Readable {
  /** Comments AND literal contents blanked, same length: for structure. */
  readonly code: string;
  /** Comments blanked, string/template contents restored: for content. */
  readonly text: string;
}

function readable(source: string): Readable {
  const { code, spans } = blankLiteralsWithSpans(source);
  let text = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.kind !== "string" && span.kind !== "template") continue;
    text += code.slice(cursor, span.start) + source.slice(span.start, span.end);
    cursor = span.end;
  }
  text += code.slice(cursor);
  return { code, text };
}

/** The index of the bracket closing the one at `open`, read over blanked code. */
function closing(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return code.length - 1;
}

/** The first comma at depth zero inside `code[from, to)`, or -1. */
function topLevelComma(code: string, from: number, to: number): number {
  let depth = 0;
  for (let index = from; index < to; index += 1) {
    const char = code[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) return index;
  }
  return -1;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A module specifier as seen from `fromFile`, repo-relative and extensionless. */
function resolveSpecifier(fromFile: string, specifier: string): string {
  let resolved = specifier;
  if (specifier.startsWith("@/")) resolved = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) {
    resolved = path.posix.join(path.posix.dirname(fromFile), specifier);
  }
  return resolved.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");
}

// ---------------------------------------------------------------------------
// The two detections.
// ---------------------------------------------------------------------------

type MockKind = "keyed" | "automock" | "opaque" | "spy" | "absent";

interface SeamMock {
  readonly seam: string;
  readonly kind: MockKind;
  readonly line: number;
}

/** Whether a factory returns an object literal the census can read. */
function returnsObjectLiteral(factoryCode: string): boolean {
  return /=>\s*\(\s*\{/.test(factoryCode) || /\breturn\s*\(?\s*\{/.test(factoryCode);
}

/**
 * The names a factory can hold the REAL module under: its first parameter
 * (`importOriginal` / `importActual`), `vi.importActual`, and any binding
 * assigned by awaiting either — with or without a type annotation.
 */
function originalBindings(factoryCode: string, factoryText: string): string[] {
  const sources = ["vi\\s*\\.\\s*importActual"];
  const parameter = factoryCode.match(/^\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/)?.[1];
  if (parameter && parameter !== "async") sources.push(escape(parameter));
  const bindings = [...sources];
  for (const assigned of factoryText.matchAll(
    new RegExp(
      `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*[(\\s]*await\\s+(?:${sources.join("|")})\\b`,
      "g",
    ),
  )) {
    bindings.push(escape(assigned[1]));
  }
  return bindings;
}

/**
 * Every OBJECT spread in a factory — a `...` whose innermost open bracket is `{`;
 * a rest parameter or a call spread sits inside `(` or `[` and is not one —
 * counted as spreading the real module or spreading anything else.
 */
function objectSpreads(
  factoryCode: string,
  factoryText: string,
): { original: number; foreign: number } {
  const isOriginal = new RegExp(
    `^[\\s(]*(?:await\\s+)?[\\s(]*(?:${originalBindings(factoryCode, factoryText).join("|")})\\b`,
  );
  const open: string[] = [];
  let original = 0;
  let foreign = 0;
  for (let index = 0; index < factoryCode.length; index += 1) {
    const char = factoryCode[index];
    if (char === "(" || char === "[" || char === "{") open.push(char);
    else if (char === ")" || char === "]" || char === "}") open.pop();
    else if (factoryCode.startsWith("...", index)) {
      if (open[open.length - 1] === "{") {
        if (isOriginal.test(factoryText.slice(index + 3))) original += 1;
        else foreign += 1;
      }
      index += 2;
    }
  }
  return { original, foreign };
}

/**
 * Every mock of a named seam in one test file. `countAbsent: "all"` reports an
 * ABSENT seam whatever its `absentIsSilent` says, which is what a witness needs:
 * a suite cannot prove a seam runs if the seam is not even there.
 */
export function seamMocks(
  relPath: string,
  source: string,
  countAbsent: "silent-only" | "all" = "silent-only",
): SeamMock[] {
  const { code, text } = readable(source);
  const found: SeamMock[] = [];

  for (const call of code.matchAll(/\bvi\s*\.\s*(?:mock|doMock)\s*\(/g)) {
    const open = (call.index ?? 0) + call[0].length - 1;
    const close = closing(code, open);
    const specifier = text
      .slice(open + 1, close)
      .match(/^\s*(?:import\s*\(\s*)?(["'`])([^"'`]+)\1/)?.[2];
    if (!specifier) continue;
    const resolved = resolveSpecifier(relPath, specifier);
    const seams = MONEY_SEAMS.filter((seam) => seam.module === resolved);
    if (seams.length === 0) continue;

    const line = lineOf(source, call.index ?? 0);
    const comma = topLevelComma(code, open + 1, close);
    const factoryCode = comma === -1 ? "" : code.slice(comma + 1, close);
    const factoryText = comma === -1 ? "" : text.slice(comma + 1, close);

    for (const seam of seams) {
      let kind: MockKind | null = null;
      const spreads = objectSpreads(factoryCode, factoryText);
      if (comma === -1 || factoryCode.trim() === "") kind = "automock";
      else if (/^\s*\{/.test(factoryCode)) {
        // An options object. `{ spy: true }` keeps the implementation only until
        // `vi.mocked(seam).mockResolvedValue(...)` replaces it, so it counts too.
        kind = /\bspy\s*:\s*true\b/.test(factoryText) ? "spy" : "automock";
      } else if (new RegExp(`(?<![\\w$.])${escape(seam.name)}(?![\\w$])`).test(factoryText)) {
        kind = "keyed";
      } else if (!returnsObjectLiteral(factoryCode) || spreads.foreign > 0) {
        // A spread of anything but the real module (a `vi.hoisted` bag, an
        // `overrides` object) can carry the seam where this file cannot read it.
        kind = "opaque";
      } else if (spreads.original === 0 && (seam.absentIsSilent || countAbsent === "all")) {
        kind = "absent";
      }
      if (kind) found.push({ seam: seam.name, kind, line });
    }
  }

  for (const call of code.matchAll(/\bvi\s*\.\s*spyOn\s*\(/g)) {
    const open = (call.index ?? 0) + call[0].length - 1;
    const args = text.slice(open + 1, closing(code, open));
    for (const seam of MONEY_SEAMS) {
      if (new RegExp(`["'\`]${escape(seam.name)}["'\`]`).test(args)) {
        found.push({ seam: seam.name, kind: "spy", line: lineOf(source, call.index ?? 0) });
      }
    }
  }
  return found;
}

/** The `expect(...)` statements, matcher chain included, that assert `seam`'s money. */
export function moneyAssertionLines(source: string, seam: MoneySeam): number[] {
  const { code, text } = readable(source);
  const lines: number[] = [];
  for (const call of code.matchAll(/\bexpect\s*(?:\.\s*soft\s*)?\(/g)) {
    const start = call.index ?? 0;
    let end = closing(code, start + call[0].length - 1);
    for (;;) {
      const link = code.slice(end + 1).match(/^\s*\.\s*[A-Za-z_$][\w$]*\s*(\()?/);
      if (!link) break;
      end = link[1] ? closing(code, end + link[0].length) : end + link[0].length;
    }
    const statement = text.slice(start, end + 1);
    const namesFigure = seam.figures.some((figure) =>
      new RegExp(`(?<![\\w$])${escape(figure)}(?![\\w$])`).test(statement),
    );
    const readsMintedAsk =
      seam.mintedAsk &&
      /(?:createPaymentIntent|upsertPaymentIntentTransaction)/i.test(statement) &&
      /(?<![\w$])amountCents(?![\w$])/.test(statement) &&
      /(?:modification_additional|(?<![\w$])ADDITIONAL(?![\w$]))/.test(statement);
    if (namesFigure || readsMintedAsk) lines.push(lineOf(source, start));
  }
  return lines;
}

interface Offence {
  readonly file: string;
  readonly seam: string;
  readonly mocks: readonly SeamMock[];
  readonly assertionLines: readonly number[];
}

export function offencesIn(relPath: string, source: string): Offence[] {
  const mocks = seamMocks(relPath, source);
  const offences: Offence[] = [];
  for (const seam of MONEY_SEAMS) {
    const mine = mocks.filter((mock) => mock.seam === seam.name);
    if (mine.length === 0) continue;
    const assertionLines = moneyAssertionLines(source, seam);
    if (assertionLines.length > 0) {
      offences.push({ file: relPath, seam: seam.name, mocks: mine, assertionLines });
    }
  }
  return offences;
}

// ---------------------------------------------------------------------------
// The tree.
// ---------------------------------------------------------------------------

function testFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const rel = `${directory}/${entry.name}`;
    if (entry.isDirectory()) testFiles(rel, found);
    else if (/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)) found.push(rel);
  }
  return found;
}

const SEAM_NEEDLES = MONEY_SEAMS.flatMap((seam) => [seam.name, path.posix.basename(seam.module)]);

/** Test files that name a seam or a seam module at all, with their source. */
const candidates = (() => {
  const files = [...testFiles("src"), ...testFiles("scripts")];
  return {
    scanned: files.length,
    sources: files
      .filter((file) => file !== THIS_FILE)
      .map((file) => ({ file, source: readFileSync(path.join(REPO_ROOT, file), "utf8") }))
      .filter(({ source }) => SEAM_NEEDLES.some((needle) => source.includes(needle))),
  };
})();

function describeOffence(offence: Offence): string {
  const mocks = offence.mocks.map((mock) => `${mock.kind} at line ${mock.line}`).join(", ");
  return `${offence.file}: mocks \`${offence.seam}\` (${mocks}) and asserts money it affects at line(s) ${offence.assertionLines.join(", ")}`;
}

describe(`${INVARIANT_ID}: a money seam is never mocked away in a test that asserts its money (#3341)`, () => {
  it("names seams that exist, as exported functions of the modules it points at", () => {
    for (const seam of MONEY_SEAMS) {
      const source = readFileSync(path.join(REPO_ROOT, `${seam.module}.ts`), "utf8");
      expect(
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${escape(seam.name)}\\b`).test(source),
        `${INVARIANT_ID}: MONEY_SEAMS names \`${seam.name}\` in ${seam.module}.ts, which no longer exports it. Move the entry with the function; never delete it to make this pass.`,
      ).toBe(true);
    }
  });

  it("finds no test file that mocks a named seam AND asserts a money figure it affects", () => {
    const offences = candidates.sources.flatMap(({ file, source }) => offencesIn(file, source));
    expect(
      offences.map(describeOffence),
      `${INVARIANT_ID} (docs/invariants/operations.md): the suite(s) below replace a money seam and then assert the money that seam decides, so the assertion passes whatever the seam would have done — the shape that hid #3340 for four months. Unmock the seam (spread the real module and stub only its I/O collaborators), or move the money assertion to a suite where the seam runs for real. There is no allowlist.`,
    ).toEqual([]);
  });

  it("is not vacuous: it reads the tree and still sees the seam mocks that carry no money assertion", () => {
    expect(candidates.scanned).toBeGreaterThan(1000);
    const mocking = candidates.sources.filter(({ file, source }) => seamMocks(file, source).length > 0);
    // Dozens of suites stub a seam to isolate unrelated logic, which the rule
    // permits. If this falls to zero the mock detection has stopped working.
    expect(mocking.length).toBeGreaterThan(10);
  });

  it("has, for every seam, a witness suite where it runs unmocked AND its money is asserted", () => {
    const missing = MONEY_SEAMS.filter(
      (seam) =>
        !candidates.sources.some(({ file, source }) => {
          const { text } = readable(source);
          const reachesSeam =
            new RegExp(`(?<![\\w$])${escape(seam.name)}(?![\\w$])`).test(text) ||
            text.includes(`"@/lib/${path.posix.basename(seam.module)}"`);
          return (
            reachesSeam &&
            seamMocks(file, source, "all").every((mock) => mock.seam !== seam.name) &&
            moneyAssertionLines(source, seam).length > 0
          );
        }),
    );
    expect(
      missing.map((seam) => seam.name),
      `${INVARIANT_ID}: no suite runs these seams for real while asserting the money they decide. The integration witness is src/lib/__tests__/superseded-additional-ask-integration.test.ts.`,
    ).toEqual([]);
  });

  it("pins the integration witness: mint, supersede and resulting ask with every seam real", () => {
    const file = "src/lib/__tests__/superseded-additional-ask-integration.test.ts";
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const { text } = readable(source);
    for (const seam of MONEY_SEAMS) {
      expect(
        new RegExp(`vi\\s*\\.\\s*(?:mock|doMock)\\s*\\(\\s*["'\`][^"'\`]*${path.posix.basename(seam.module)}["'\`]`).test(text),
        `${INVARIANT_ID}: ${file} must not vi.mock ${seam.module} at all — it is the one suite where \`${seam.name}\` runs for real.`,
      ).toBe(false);
    }
    expect(seamMocks(file, source, "all")).toEqual([]);
    expect(moneyAssertionLines(source, MONEY_SEAMS[0]).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The detector against seeded fixtures (mutation verification in-file; the
// on-disk probes are recorded in the PR body).
// ---------------------------------------------------------------------------

const FIXTURE = "src/lib/__tests__/seeded.test.ts";

function offenceSeams(source: string): string[] {
  return offencesIn(FIXTURE, source).map((offence) => offence.seam);
}

const ASSERTS_ASK = `
  it("asks", () => {
    expect(result.additionalAmountCents).toBe(14000);
  });
`;

describe(`${INVARIANT_ID}: the detector, against seeded test files`, () => {
  it("fails a file that mocks the supersede seam and asserts the ask, and passes once the mock is gone", () => {
    const seeded = `
      vi.mock("@/lib/booking-payment-cleanup", () => ({
        queueSupersededAdditionalIntentCancellations: vi.fn().mockResolvedValue([]),
      }));
      ${ASSERTS_ASK}`;
    expect(offenceSeams(seeded)).toEqual(["queueSupersededAdditionalIntentCancellations"]);
    expect(offenceSeams(ASSERTS_ASK)).toEqual([]);
  });

  it("leaves a seam live when the factory spreads the real module and stubs something else", () => {
    for (const factory of [
      `async (importOriginal) => ({ ...(await importOriginal()), queueSupersededPrimaryIntentCancellations: vi.fn() })`,
      `async (importOriginal) => { const actual = await importOriginal<typeof import("@/lib/booking-payment-cleanup")>(); return { ...actual, other: vi.fn() }; }`,
      `async () => ({ ...(await vi.importActual("@/lib/booking-payment-cleanup")), other: vi.fn() })`,
    ]) {
      expect(offenceSeams(`vi.mock("@/lib/booking-payment-cleanup", ${factory});${ASSERTS_ASK}`)).toEqual([]);
    }
  });

  it("still fails a spread factory that overrides the seam by name", () => {
    const seeded = `vi.mock("@/lib/booking-payment-cleanup", async (importOriginal) => ({
      ...(await importOriginal()),
      queueSupersededAdditionalIntentCancellations: vi.fn(),
    }));${ASSERTS_ASK}`;
    expect(offenceSeams(seeded)).toEqual(["queueSupersededAdditionalIntentCancellations"]);
  });

  it("catches every other spelling of the mock", () => {
    const spellings = {
      relativePath: `vi.mock("../booking-payment-cleanup", () => ({ queueSupersededAdditionalIntentCancellations: vi.fn() }));`,
      extension: `vi.mock("@/lib/booking-payment-cleanup.ts", () => ({ queueSupersededAdditionalIntentCancellations: vi.fn() }));`,
      doMock: `vi.doMock("@/lib/booking-payment-cleanup", () => ({ queueSupersededAdditionalIntentCancellations: vi.fn() }));`,
      importForm: `vi.mock(import("@/lib/booking-payment-cleanup"), () => ({ queueSupersededAdditionalIntentCancellations: vi.fn() }));`,
      automock: `vi.mock("@/lib/booking-payment-cleanup");`,
      opaqueHelper: `vi.mock("@/lib/booking-payment-cleanup", () => cleanupDouble());`,
      spy: `vi.spyOn(cleanup, "queueSupersededAdditionalIntentCancellations").mockResolvedValue([]);`,
      getter: `vi.mock("@/lib/booking-payment-cleanup", () => ({ get queueSupersededAdditionalIntentCancellations() { return vi.fn(); } }));`,
      spyMode: `vi.mock("@/lib/booking-payment-cleanup", { spy: true });
        vi.mocked(queueSupersededAdditionalIntentCancellations).mockResolvedValue([]);`,
      spyModeNamespace: `vi.mock("@/lib/booking-payment-cleanup", { spy: true });
        vi.mocked(cleanup.queueSupersededAdditionalIntentCancellations).mockResolvedValue([]);`,
      hoistedBag: `const m = vi.hoisted(() => ({ queueSupersededAdditionalIntentCancellations: vi.fn() }));
        vi.mock("@/lib/booking-payment-cleanup", () => ({ ...m }));`,
      overridesAfterOriginal: `vi.mock("@/lib/booking-payment-cleanup", async (importOriginal) => ({
          ...((await importOriginal()) as typeof import("@/lib/booking-payment-cleanup")),
          ...overrides,
        }));`,
    };
    for (const [spelling, mock] of Object.entries(spellings)) {
      expect(offenceSeams(`${mock}${ASSERTS_ASK}`), spelling).toEqual([
        "queueSupersededAdditionalIntentCancellations",
      ]);
    }
  });

  it("reads a spread bag as unreadable for the seams whose absence is loud, too", () => {
    const minter = `const m = vi.hoisted(() => ({ createModificationAdditionalPaymentIntent: vi.fn() }));
      vi.mock("@/lib/booking-modification-settlement", () => ({ ...m }));`;
    expect(offenceSeams(`${minter}${ASSERTS_ASK}`)).toEqual(["createModificationAdditionalPaymentIntent"]);
    const reconcile = `vi.mock("@/lib/payment-transactions", () => ({ ...transactionDoubles }));`;
    expect(offenceSeams(`${reconcile}${ASSERTS_ASK}`)).toEqual(["reconcilePaymentAggregates"]);
  });

  it("does not read a rest parameter or a call spread as a factory spread", () => {
    const factory = `vi.mock("@/lib/booking-payment-cleanup", async (importOriginal) => ({
      ...((await importOriginal()) as typeof import("@/lib/booking-payment-cleanup")),
      queueSupersededPrimaryIntentCancellations: (...args: unknown[]) => primary(...args),
    }));`;
    expect(offenceSeams(`${factory}${ASSERTS_ASK}`)).toEqual([]);
  });

  it("leaves a seam live when the real module is held in a TYPED binding and spread", () => {
    const factory = `vi.mock("@/lib/booking-payment-cleanup", async (importOriginal) => {
      const actual: typeof import("@/lib/booking-payment-cleanup") = await importOriginal();
      return { ...actual, other: vi.fn() };
    });`;
    expect(offenceSeams(`${factory}${ASSERTS_ASK}`)).toEqual([]);
  });

  it("counts an ABSENT seam only where its caller swallows the missing-export throw", () => {
    const absentCleanup = `vi.mock("@/lib/booking-payment-cleanup", () => ({ queueSupersededPrimaryIntentCancellations: vi.fn() }));`;
    expect(offenceSeams(`${absentCleanup}${ASSERTS_ASK}`)).toEqual([
      "queueSupersededAdditionalIntentCancellations",
    ]);
    const absentReconcile = `vi.mock("@/lib/payment-transactions", () => ({ upsertPaymentIntentTransaction: vi.fn() }));`;
    expect(offenceSeams(`${absentReconcile}${ASSERTS_ASK}`)).toEqual([]);
  });

  it("reads the minted ask off a Stripe or ledger double, but only for an ADDITIONAL instrument", () => {
    const minter = `vi.mock("@/lib/booking-modification-settlement", () => ({ createModificationAdditionalPaymentIntent: vi.fn() }));`;
    const additional = `expect(mockCreatePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 3000, metadata: { type: "modification_additional" } }));`;
    const primary = `expect(mockCreatePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 3000, metadata: { type: "booking" } }));`;
    expect(offenceSeams(`${minter}${additional}`)).toEqual(["createModificationAdditionalPaymentIntent"]);
    expect(offenceSeams(`${minter}${primary}`)).toEqual([]);
  });

  it("does not fire on a seam or a figure that is only discussed in a comment", () => {
    const discussed = `
      // vi.mock("@/lib/booking-payment-cleanup", () => ({ queueSupersededAdditionalIntentCancellations: vi.fn() }));
      /* expect(result.additionalAmountCents).toBe(1); */
      vi.mock("@/lib/booking-payment-cleanup", () => ({ queueSupersededAdditionalIntentCancellations: vi.fn() }));
      it("x", () => { expect(result.priceDiffCents).toBe(7000); });
    `;
    expect(offenceSeams(discussed)).toEqual([]);
  });

  it("reaches the figure through the matcher chain, and past a regex holding a bracket", () => {
    const seeded = `vi.mock("@/lib/booking-payment-cleanup", () => ({ queueSupersededAdditionalIntentCancellations: vi.fn() }));
      expect(message).toMatch(/owed \\(/);
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ carriedAskCents: 7000 }),
      );`;
    expect(moneyAssertionLines(seeded, MONEY_SEAMS[0])).toEqual([3]);
    expect(offenceSeams(seeded)).toEqual(["queueSupersededAdditionalIntentCancellations"]);
  });
});
