import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const API_ROOT = path.join(process.cwd(), "src/app/api");

// These endpoints are consumed by authenticated machines or exist expressly to
// return provider diagnostics. Their response contracts are reviewed separately
// from browser-facing API errors.
const NON_CLIENT_RESPONSE_ROUTES = [
  "src/app/api/cron/",
  "src/app/api/webhooks/",
  "src/app/api/admin/setup/provider-test/route.ts",
  "src/app/api/finance/sync/status/route.ts",
];

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) return routeFiles(absolute);
    return entry === "route.ts" ? [absolute] : [];
  });
}

function repoPath(absolute: string) {
  return path.relative(process.cwd(), absolute).replaceAll("\\", "/");
}

function isJsonResponseCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  return (
    node.expression.name.text === "json" &&
    (node.expression.expression.getText() === "NextResponse" ||
      node.expression.expression.getText() === "Response")
  );
}

function conditionHasTypedCatchGuard(
  condition: ts.Expression,
  catchName: string
): boolean {
  let guarded = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      node.left.getText() === catchName &&
      node.right.getText() !== "Error"
    ) {
      guarded = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return guarded;
}

function isWithin(node: ts.Node, container: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === container) return true;
  }
  return false;
}

function isTypedMessageBranch(node: ts.Node, catchName: string, stop: ts.Node) {
  for (let current: ts.Node | undefined = node; current && current !== stop; current = current.parent) {
    if (
      ts.isIfStatement(current) &&
      isWithin(node, current.thenStatement) &&
      conditionHasTypedCatchGuard(current.expression, catchName)
    ) {
      return true;
    }
    if (
      ts.isConditionalExpression(current) &&
      isWithin(node, current.whenTrue) &&
      conditionHasTypedCatchGuard(current.condition, catchName)
    ) {
      return true;
    }
  }
  return false;
}

function findDeclaration(
  block: ts.Block,
  name: string
): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (
      !found &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(block);
  return found;
}

function rawCatchMessagesInResponse(
  responseBody: ts.Expression,
  catchClause: ts.CatchClause
): ts.PropertyAccessExpression[] {
  const catchVariable = catchClause.variableDeclaration?.name;
  const catchName = catchVariable && ts.isIdentifier(catchVariable)
    ? catchVariable.text
    : null;
  if (!catchName) return [];

  const raw: ts.PropertyAccessExpression[] = [];
  const resolving = new Set<string>();
  const isXeroErrorInfo = (node: ts.Expression): boolean => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === "getXeroApiErrorInfo"
    ) {
      return true;
    }
    if (ts.isIdentifier(node)) {
      const declaration = findDeclaration(catchClause.block, node.text);
      return Boolean(
        declaration?.initializer && isXeroErrorInfo(declaration.initializer)
      );
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText() === catchName &&
      node.name.text === "message" &&
      !isTypedMessageBranch(node, catchName, catchClause.block)
    ) {
      raw.push(node);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      (node.name.text === "message" || node.name.text === "diagnosticMessage") &&
      isXeroErrorInfo(node.expression)
    ) {
      raw.push(node);
    }

    // Follow local aliases such as `const message = error instanceof Error ?
    // error.message : fallback` when the alias is put into the response body.
    if (ts.isIdentifier(node) && node.text !== catchName && !resolving.has(node.text)) {
      const declaration = findDeclaration(catchClause.block, node.text);
      if (declaration?.initializer) {
        resolving.add(node.text);
        visit(declaration.initializer);
        resolving.delete(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(responseBody);
  return raw;
}

function rawMessageViolations(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === "getXeroApiErrorInfo" &&
      (!node.arguments[1] || !ts.isStringLiteral(node.arguments[1]))
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      violations.push(`${fileName}:${line}`);
    }
    if (ts.isCatchClause(node)) {
      const visitCatch = (child: ts.Node) => {
        if (ts.isCallExpression(child) && isJsonResponseCall(child) && child.arguments[0]) {
          for (const leak of rawCatchMessagesInResponse(child.arguments[0], node)) {
            const line = source.getLineAndCharacterOfPosition(leak.getStart()).line + 1;
            violations.push(`${fileName}:${line}`);
          }
        }
        ts.forEachChild(child, visitCatch);
      };
      visitCatch(node.block);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

describe("client-facing API error response contract (#1888 F31)", () => {
  it("detects direct and locally-aliased raw messages but permits typed domain errors", () => {
    const source = `
      async function unsafeDirect() {
        try { await work(); } catch (error) {
          if (error instanceof Error) {
            return NextResponse.json({ error: error.message });
          }
        }
      }
      async function unsafeAlias() {
        try { await work(); } catch (error) {
          const message = error instanceof Error ? error.message : "failed";
          return NextResponse.json({ error: message });
        }
      }
      async function unsafeHelperMessage() {
        try { await work(); } catch (error) {
          const xeroError = getXeroApiErrorInfo(error, "failed");
          return NextResponse.json({ error: xeroError.message });
        }
      }
      async function unsafeHelperDiagnostic() {
        try { await work(); } catch (error) {
          const xeroError = getXeroApiErrorInfo(error, "failed");
          return NextResponse.json({ error: xeroError.diagnosticMessage });
        }
      }
      async function safeHelperClientCopy() {
        try { await work(); } catch (error) {
          const xeroError = getXeroApiErrorInfo(error, "failed");
          return NextResponse.json({ error: xeroError.clientMessage });
        }
      }
      async function unsafeDynamicHelperFallback() {
        try { await work(); } catch (error) {
          const xeroError = getXeroApiErrorInfo(
            error,
            error instanceof Error ? error.message : "failed"
          );
          return NextResponse.json({ error: xeroError.clientMessage });
        }
      }
      async function safeTyped() {
        try { await work(); } catch (error) {
          if (error instanceof ApiError) {
            return NextResponse.json({ error: error.message });
          }
          return NextResponse.json({ error: "failed" });
        }
      }
    `;

    expect(rawMessageViolations(source, "fixture-route.ts")).toHaveLength(6);
  });

  it("never serializes an unexpected catch Error.message", () => {
    const violations: string[] = [];

    for (const absolute of routeFiles(API_ROOT)) {
      const relative = repoPath(absolute);
      if (NON_CLIENT_RESPONSE_ROUTES.some((route) => relative.startsWith(route))) {
        continue;
      }

      violations.push(...rawMessageViolations(readFileSync(absolute, "utf8"), relative));
    }

    expect(violations).toEqual([]);
  }, CENSUS_TIMEOUT_MS);
});
