import path from "path";
import fs from "node:fs";
import { ESLint } from "eslint";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

/*
  #3533 — the THIRD direction. `money-cents-guard.test.ts` holds the rule
  against BUILDING cents inline; `cents-display-guard.test.ts` holds the rule
  against RENDERING them with a hand-rolled `(cents / 100).toFixed(n)`.
  Neither could see the shape a census found 26 times under `src/` on
  20 September 2026: no division at all, just the storage form dropped into a
  sentence — `Manual refund task for 50% of ${refundableBaseCents} cents`, in
  an audit `details` string a booking officer reads to reconstruct a booking's
  money. Seven of them were in `booking-cancel.ts` alone.

  The selector keys on a template quasi whose raw text BEGINS WITH A SPACE and
  then the word: in `` `${x} cents` `` the second quasi is exactly `" cents"`,
  and a leading space can only come from text that follows an interpolation.
  The negative fixtures below are what pin that the space is load-bearing.
*/

const BOOTSTRAP_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 20_000;
vi.setConfig({ testTimeout: CASE_TIMEOUT_MS, hookTimeout: BOOTSTRAP_TIMEOUT_MS });

const REPO_ROOT = path.resolve(__dirname, "../../..");
/*
  The prefix is `INV-SSOT-001`, not `INV-MONEY-003`, and that is load-bearing:
  `money-cents-guard.test.ts` finds the blocks that LIFT the inline-cents rule
  by looking for a block whose restrictions carry no message starting
  `INV-MONEY-003`, so a second rule sharing that prefix would make every such
  block look like it still carried the rule, and the exemption-coverage test
  would pass vacuously. This arm is a rendering rule and belongs with #3302's
  anyway.
*/
const RULE_ID = "INV-SSOT-001 / #3533";
const ORDINARY_FILE = "src/lib/cents-in-prose-guard-fixture.ts";

/** The exact shape the rule bans: the stored form, in a sentence. */
const VIOLATING_CODE =
  "export function f(refundAmountCents: number): string {\n" +
  "  return `Manual refund task for ${refundAmountCents} cents`;\n" +
  "}\n";

let eslint: ESLint;

async function hitsIn(
  code: string,
  filename = ORDINARY_FILE,
): Promise<ESLint.LintResult["messages"]> {
  const results = await eslint.lintText(code, {
    filePath: path.join(REPO_ROOT, filename),
  });
  return results
    .flatMap((result) => result.messages)
    .filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        typeof message.message === "string" &&
        message.message.startsWith(RULE_ID),
    );
}

beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO_ROOT, warnIgnored: false });
  // The canary: force the flat-config bootstrap against a real violation, so a
  // cold, broken or ignored run fails loudly here instead of making every
  // negative fixture below pass vacuously.
  const hits = await hitsIn(VIOLATING_CODE);
  if (hits.length !== 1) {
    throw new Error(
      `${RULE_ID} canary produced ${hits.length} report(s), expected exactly 1. The guard is not running against ${ORDINARY_FILE}.`,
    );
  }
}, BOOTSTRAP_TIMEOUT_MS);

describe("cents-in-prose guard: catches the shape", () => {
  it("fires on the storage form in a sentence, as an error", async () => {
    const hits = await hitsIn(VIOLATING_CODE);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe(2);
  });

  it.each([
    ["an audit details string", 'export const d = `Refund ${refundAmountCents} cents recorded`;'],
    ["a thrown Error", "export function f() { throw new Error(`Amount ${amountCents} cents is below the minimum`); }"],
    ["a report line", "export const detail = `Coverage is ${coveredCents} cents short of the target`;"],
    ["a capitalised spelling", "export const d = `Owing ${owedCents} Cents`;"],
    ["a property access", "export const d = `Fee ${payment.changeFeeCents} cents`;"],
    ["a call result", "export const d = `Sum ${total(rows)} cents`;"],
    ["a bare c suffix", 'export const d = `Refund ${refundAmountCents}c recorded`;'],
    ["a c suffix before punctuation", 'export const d = `Refund ${refundAmountCents}c; review`;'],
    ["a c suffix after property access", 'export const d = `Refund ${payment.changeFeeCents}c`;'],
  ])("fires on %s", async (_label, code) => {
    expect(await hitsIn(`const refundAmountCents = 1, amountCents = 1, coveredCents = 1, owedCents = 1, payment = { changeFeeCents: 1 }, total = (r: unknown) => 1, rows = [];\n${code}\n`)).toHaveLength(1);
  });

  it("names the canonical helpers and an escape hatch that passes CI", async () => {
    const message = (await hitsIn(VIOLATING_CODE))[0]?.message;
    expect(message).toContain("formatCents");
    expect(message).toContain("@/lib/utils");
    expect(message).toContain("CENTS_DISPLAY_EXEMPTIONS");
    expect(message).toContain("eslint.config.mjs");
    expect(message).toContain("Never an eslint-disable comment");
  });
});

describe("cents-in-prose guard: it is its own group", () => {
  /*
    Review of #3533 found the first cut appended this selector to
    `CENTS_DISPLAY_RESTRICTIONS`, so it inherited that group's ten exemptions —
    files excused for seeding an editable input or writing a raw export cell,
    none of which is a reason to put the storage form in a sentence. The arm is
    its own array; #3589's one direct-return exception is confined to one
    diagnostic file. These two cases stop it being folded back in.
  */
  it("is exported separately from the toFixed arm", async () => {
    const { pathToFileURL } = await import("url");
    const config: {
      CENTS_IN_PROSE_GUARD_ARM?: string[];
      CENTS_DISPLAY_GUARD_ARM?: string[];
    } = await import(
      pathToFileURL(path.join(REPO_ROOT, "eslint.config.mjs")).href
    );
    expect(config.CENTS_IN_PROSE_GUARD_ARM).toHaveLength(2);
    expect(config.CENTS_DISPLAY_GUARD_ARM).not.toContain(
      config.CENTS_IN_PROSE_GUARD_ARM?.[0],
    );
  });

  it("still fires inside a file the toFixed arm exempts", async () => {
    // `finance-legacy-dashboard-export.ts` is a declared CENTS_DISPLAY
    // exemption. Its reason — a raw numeric export cell — says nothing about
    // sentences, so this rule must still reach it.
    const results = await eslint.lintText(VIOLATING_CODE, {
      filePath: path.join(REPO_ROOT, "src/lib/finance-legacy-dashboard-export.ts"),
    });
    const hits = results
      .flatMap((result) => result.messages)
      .filter(
        (message) =>
          message.ruleId === "no-restricted-syntax" &&
          typeof message.message === "string" &&
          message.message.startsWith(RULE_ID),
      );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe(2);
  });
});

describe("cents-in-prose guard: negative fixtures", () => {
  /*
    Each of these is a legitimate shape. If one starts failing, the selector —
    not the code — is what to fix.
  */
  it.each([
    ["a label before the value", 'export const d = `cents: ${amountCents}`;'],
    ["the word inside a longer noun", 'export const d = `${rowCount} cents-per-night rows`;'],
    ["a c prefix inside a longer noun", 'export const d = `${rowCount}children`;'],
    ["an already-formatted amount", 'export const d = `Refund ${formatCents(amountCents)} recorded`;'],
    ["a count that is not money", 'export const d = `${nightCount} nights`;'],
    ["the word alone in a static string", 'export const d = "amounts are stored in cents";'],
    ["a comment", "// the column is in cents\nexport const d = 1;"],
    // Review of #3533, lens A: a tagged template is not prose. `sql` and
    // `styled` carry text a machine reads, and the selector excludes them
    // rather than making a future one add an exemption for being a query.
    ["a tagged template", "export const q = sql`WHERE paid = ${amountCents} cents`;"],
    ["a tagged template with c", "export const q = sql`WHERE paid = ${amountCents}c`;"],

  ])("does not fire on %s", async (_label, code) => {
    expect(
      await hitsIn(`const amountCents = 1, rowCount = 1, nightCount = 1, formatCents = (c: number) => "$", sql = (s: TemplateStringsArray, ...v: unknown[]) => "";\n${code}\n`),
    ).toHaveLength(0);
  });
});

describe("cents-in-prose guard: one reviewed rounding annotation", () => {
  const roundingAuditFile = "src/lib/xero-invoice-rounding-audit.ts";
  const anotherXeroFile = "src/lib/xero-other-repair.ts";
  const pairedDiagnostic =
    'function formatDriftCents(cents: number, format: ClubFormat): string { return `${formatCents(cents, format)} (${cents >= 0 ? "+" : ""}${cents}c)`; }';

  it("pins the actual diagnostic to a formatted amount plus signed raw-cent drift", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, roundingAuditFile), "utf8");
    const file = ts.createSourceFile(roundingAuditFile, source, ts.ScriptTarget.Latest, true);
    const declarations = file.statements.filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "formatDriftCents",
    );
    expect(declarations).toHaveLength(1);
    const statements = declarations[0]?.body?.statements;
    expect(statements).toHaveLength(1); // selector exempts only a direct return
    const returned = statements?.[0];
    expect(returned && ts.isReturnStatement(returned)).toBe(true);
    expect(returned?.getText(file)).toBe(
      'return `${formatCents(cents, format)} (${cents >= 0 ? "+" : ""}${cents}c)`;',
    );
  });

  it("exempts only that direct return in the rounding-audit file", async () => {
    expect(await hitsIn(pairedDiagnostic, roundingAuditFile)).toHaveLength(0);
    expect(await hitsIn(pairedDiagnostic, anotherXeroFile)).toHaveLength(1);
    expect(
      await hitsIn(
        'function another(cents: number) { return `${cents}c`; }',
        roundingAuditFile,
      ),
    ).toHaveLength(1);
    expect(
      await hitsIn(
        'function formatDriftCents(cents: number) { if (cents) return `${cents}c`; return ""; }',
        roundingAuditFile,
      ),
    ).toHaveLength(1);
  });
});
