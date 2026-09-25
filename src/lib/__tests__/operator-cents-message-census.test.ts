import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// INV-SSOT-001 / #3589: the ESLint quasi rule catches explicit `c`/`cents`
// suffixes, but `${appliedCents}` with no suffix has no distinguishing quasi.
// Census the bounded Xero repair message sources instead. Numeric payload fields
// and provider amounts remain integer cents; only interpolated prose is checked.
const MESSAGE_SOURCES = [
  "src/lib/xero-applied-credit-allocation.ts",
  "src/lib/xero-applied-credit-deallocation.ts",
  "src/lib/xero-entrance-fee-invoices.ts",
  "src/lib/xero-inbound/credit-note-repairs.ts",
] as const;
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CENT_AMOUNT_REFERENCE = /(?:Cents\b|\bproviderTotal\b|\boutstanding\b)/;

function bareAmountInterpolations(source: string, filename: string): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) {
      for (const span of node.templateSpans) {
        const expression = span.expression;
        if (!CENT_AMOUNT_REFERENCE.test(expression.getText(file))) continue;
        const isCurrencyRendering =
          ts.isCallExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          ["formatCents", "formatSignedCents"].includes(expression.expression.text);
        if (!isCurrencyRendering) {
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
    expect(new Set(MESSAGE_SOURCES).size).toBe(4); // the four repair paths in #3589
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
      "const payload = { amountCents: appliedCents };",
    ].join("\n");
    expect(bareAmountInterpolations(source, "fixture.ts")).toEqual([
      "fixture.ts:1: appliedCents",
      "fixture.ts:2: payment.refundedAmountCents",
      "fixture.ts:3: providerTotal",
      "fixture.ts:3: outstanding",
    ]);
  });
});
