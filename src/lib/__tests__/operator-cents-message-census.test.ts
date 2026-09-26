import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// INV-SSOT-001 / #3589: the ESLint quasi rule catches explicit `c`/`cents`
// suffixes, but `${appliedCents}` with no suffix has no distinguishing quasi.
// Census the bounded Xero repair and rate-backfill message sources instead.
// Numeric payload fields and provider amounts remain integer cents; only
// interpolated prose is checked.
const MESSAGE_SOURCES = [
  "src/lib/xero-applied-credit-allocation.ts",
  "src/lib/xero-applied-credit-allocation-repair.ts",
  "src/lib/xero-applied-credit-deallocation.ts",
  "src/lib/xero-entrance-fee-invoices.ts",
  "src/lib/xero-inbound/credit-note-repairs.ts",
  "src/lib/rate-derived-night-price-backfill.ts",
] as const;
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CENT_AMOUNT_REFERENCE = /(?:Cents\b|\bproviderTotal\b|\boutstanding\b)/;

function isBareAmountRendering(expression: ts.Expression, file: ts.SourceFile): boolean {
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
      ["formatCents", "formatSignedCents"].includes(expression.expression.text)) {
    return false;
  }
  // A conditional's test chooses a branch; it is not printed. Check each
  // output branch, so `amountCents !== undefined ? formatCents(...) : ""`
  // passes while a bare amount in either branch fails.
  if (ts.isConditionalExpression(expression)) {
    return isBareAmountRendering(expression.whenTrue, file) ||
      isBareAmountRendering(expression.whenFalse, file);
  }
  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.some((span) => isBareAmountRendering(span.expression, file));
  }
  // A report may join mapped template lines. Inspect the mapper's output,
  // not the whole expression text: it contains `*Cents` inside safe formatter
  // calls, and the nested template is also visited by the ordinary walk.
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "join") {
    const mapped = expression.expression.expression;
    if (ts.isCallExpression(mapped) && ts.isPropertyAccessExpression(mapped.expression) &&
        mapped.expression.name.text === "map") {
      const mapper = mapped.arguments[0];
      if (mapper && ts.isArrowFunction(mapper) && !ts.isBlock(mapper.body)) {
        return isBareAmountRendering(mapper.body, file);
      }
    }
  }
  return CENT_AMOUNT_REFERENCE.test(expression.getText(file));
}

function bareAmountInterpolations(source: string, filename: string): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) {
      for (const span of node.templateSpans) {
        const expression = span.expression;
        if (isBareAmountRendering(expression, file)) {
          const line = file.getLineAndCharacterOfPosition(expression.getStart(file)).line + 1;
          violations.push(`${filename}:${line}: ${expression.getText(file)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

describe("operator Xero repair message amounts (INV-SSOT-001)", () => {
  it("censuses every scoped source, including an amount with no unit", () => {
    expect(new Set(MESSAGE_SOURCES).size).toBe(6); // original four plus full-fix expansion
    const violations = MESSAGE_SOURCES.flatMap((name) =>
      bareAmountInterpolations(fs.readFileSync(path.join(REPO_ROOT, name), "utf8"), name),
    );
    expect(violations).toEqual([]);
  });

  it("rejects direct amounts, properties and the established un-suffixed aliases", () => {
    const source = [
      "const a = `Applied ${appliedCents} credit`;",
      "const b = `Refund ${payment.refundedAmountCents}`;",
      "const c = `Provider ${providerTotal}, remaining ${outstanding}`;",
      "const d = `Applied ${formatCents(appliedCents, format)}`;",
      "const e = `Applied ${appliedCents !== undefined ? formatCents(appliedCents, format) : \"\"}`;",
      "const f = `Applied ${appliedCents !== undefined ? formatCents(appliedCents, format) : appliedCents}`;",
      "const payload = { amountCents: appliedCents };",
    ].join("\n");
    expect(bareAmountInterpolations(source, "fixture.ts")).toEqual([
      "fixture.ts:1: appliedCents",
      "fixture.ts:2: payment.refundedAmountCents",
      "fixture.ts:3: providerTotal",
      "fixture.ts:3: outstanding",
      "fixture.ts:6: appliedCents !== undefined ? formatCents(appliedCents, format) : appliedCents",
    ]);
  });

  it("checks the output of a mapped report line, not only the join wrapper", () => {
    const source =
      'const line = `Rows: ${rows.map((row) => `${row.amountCents}`).join(", ")}`;';
    expect(bareAmountInterpolations(source, "fixture.ts")).toContain(
      "fixture.ts:1: row.amountCents",
    );
  });

  it.each([
    [
      "src/lib/xero-applied-credit-allocation-repair.ts",
      "formatCents(params.targetCents, params.format)",
      "params.targetCents",
    ],
    [
      "src/lib/rate-derived-night-price-backfill.ts",
      "formatCents(item.derivedTotalCents, format)",
      "item.derivedTotalCents",
    ],
  ])("mutation-proves the expanded census reaches %s", (filename, formatted, bare) => {
    const original = fs.readFileSync(path.join(REPO_ROOT, filename), "utf8");
    expect(original).toContain(formatted);
    const mutated = original.replace(formatted, bare);
    expect(mutated).not.toBe(original);
    expect(bareAmountInterpolations(mutated, filename)).toContainEqual(
      expect.stringMatching(new RegExp(`: ${bare.replaceAll(".", "\\.")}$`)),
    );
  });
});
