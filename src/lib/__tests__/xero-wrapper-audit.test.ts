import fs from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SCAN_ROOTS = [
  path.resolve(process.cwd(), "src/app"),
  path.resolve(process.cwd(), "src/lib"),
];

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "__tests__") {
        return [];
      }

      return collectSourceFiles(fullPath);
    }

    if (!/\.(ts|tsx)$/.test(entry.name)) {
      return [];
    }

    return [fullPath];
  });
}

function getScriptKind(filePath: string) {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function isWrappedInCallXeroApi(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "callXeroApi"
    ) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

function findUnwrappedAccountingApiCalls(filePath: string): string[] {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );
  const violations: string[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "accountingApi" &&
      !isWrappedInCallXeroApi(node)
    ) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.expression.getStart(sourceFile)
      );
      violations.push(
        `${path.relative(process.cwd(), filePath)}:${line + 1}:${character + 1} ${node.expression.getText(sourceFile)}`
      );
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe("Xero wrapper audit", () => {
  it("wraps every accountingApi call in callXeroApi", () => {
    const violations = SCAN_ROOTS.flatMap((root) =>
      collectSourceFiles(root).flatMap((filePath) => findUnwrappedAccountingApiCalls(filePath))
    );

    expect(violations).toEqual([]);
  });
});
