import { readFileSync } from "node:fs";
import { relative } from "node:path";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { jsxSourceFiles } from "./support/money-number-input-scan";

// The older number-input guard enforces INV-MONEY-003's text boundary. This
// guard keeps the editing affordance in one component (INV-SSOT-001, #3414).
vi.setConfig({ testTimeout: 60_000 });

function unsharedMoneyInputs(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties;
      const literal = (name: string) => attributes.find(
        (attribute): attribute is ts.JsxAttribute =>
          ts.isJsxAttribute(attribute) && attribute.name.text === name,
      )?.initializer;
      const literalText = (name: string) => {
        const initializer = literal(name);
        return initializer && ts.isStringLiteral(initializer) ? initializer.text : null;
      };
      const isExchangeRate =
        file === "src/components/admin/ai-spend-currency-card.tsx" &&
        literalText("data-testid") === "spend-currency-input";
      const isSharedImplementation = file === "src/components/ui/money-input.tsx";
      if (
        node.tagName.getText(parsed) !== "MoneyInput" &&
        literalText("inputMode") === "decimal" &&
        !isSharedImplementation &&
        !isExchangeRate
      ) {
        const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
        hits.push(`${file}:${line} raw decimal input; use MoneyInput (INV-SSOT-001)`);
      }
      for (const attribute of node.attributes.properties) {
        if (
          ts.isJsxSpreadAttribute(attribute) &&
          ts.isIdentifier(attribute.expression) &&
          attribute.expression.text === "MONEY_INPUT_PROPS"
        ) {
          const line = parsed.getLineAndCharacterOfPosition(attribute.getStart(parsed)).line + 1;
          hits.push(`${file}:${line} <${node.tagName.getText(parsed)}> spreads MONEY_INPUT_PROPS; use MoneyInput (INV-SSOT-001)`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return hits;
}

describe("one shared money box (INV-SSOT-001, #3414)", () => {
  it("has no raw decimal money box or legacy money-props spread in production JSX", () => {
    const root = process.cwd();
    const files = jsxSourceFiles(root);
    expect(files.length).toBeGreaterThan(400);
    const hits = files.flatMap((absolute) =>
      unsharedMoneyInputs(
        relative(root, absolute).split("\\").join("/"),
        readFileSync(absolute, "utf8"),
      ),
    );
    expect(hits).toEqual([]);
  });

  it("catches a reintroduced spread on an input, including the quote price box", () => {
    expect(
      unsharedMoneyInputs(
        "seed.tsx",
        '<Input id="quote-price" {...MONEY_INPUT_PROPS} value={price} />',
      ),
    ).toEqual([
      "seed.tsx:1 <Input> spreads MONEY_INPUT_PROPS; use MoneyInput (INV-SSOT-001)",
    ]);
    expect(
      unsharedMoneyInputs("control.tsx", '<MoneyInput value={price} onValueChange={setPrice} />'),
    ).toEqual([]);
    expect(
      unsharedMoneyInputs("control.tsx", '<Input id="quote-price" type="text" inputMode="decimal" value={price} />'),
    ).toEqual([
      "control.tsx:1 raw decimal input; use MoneyInput (INV-SSOT-001)",
    ]);
    expect(
      unsharedMoneyInputs(
        "src/components/admin/ai-spend-currency-card.tsx",
        '<Input type="text" inputMode="decimal" data-testid="spend-currency-input" />',
      ),
    ).toEqual([]);
  });
});
