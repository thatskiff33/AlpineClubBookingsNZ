/**
 * AST helpers for the destructive-admin route census (#4619, INV-AUTH-010).
 *
 * Kept beside the walk so the walk itself stays inside the domain-module
 * line budget. The helpers do not decide which routes are listed.
 */
import { readdirSync, statSync } from "node:fs";

import ts from "typescript";

import { STEP_UP_PRISMA_WRITES } from "@/lib/step-up-routes";

const PRISMA_METHODS = new Map<string, ReadonlySet<string>>(
  Object.entries(STEP_UP_PRISMA_WRITES).map(([model, methods]) => [model, new Set(methods)]),
);

export type BodyFn =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

export type Site = {
  pos: number;
  end: number;
  ops: string[];
  readsBody: boolean;
  touchesCsv: boolean;
  auth: boolean;
  stepUp: boolean;
};

export function siteOf(node: ts.Node, extra: Partial<Site>): Site {
  return {
    pos: node.getStart(),
    end: node.end,
    ops: [],
    readsBody: false,
    touchesCsv: false,
    auth: false,
    stepUp: false,
    ...extra,
  };
}

export function isFnLike(node: ts.Node): node is BodyFn {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
}

export function hasExport(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

export function parameterNames(node: BodyFn): Set<string> {
  const names = new Set<string>();
  for (const parameter of node.parameters) {
    if (ts.isIdentifier(parameter.name)) names.add(parameter.name.text);
  }
  return names;
}

export function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function isProjectSpecifier(specifier: string): boolean {
  return specifier.startsWith("@/") || specifier.startsWith(".");
}

export function isInside(inner: ts.Node, outer: ts.Node): boolean {
  return (
    inner.getSourceFile() === outer.getSourceFile() &&
    inner.pos >= outer.pos &&
    inner.end <= outer.end &&
    inner !== outer
  );
}

export function prismaOperation(callee: ts.PropertyAccessExpression): string | null {
  const method = callee.name.text;
  const modelAccess = unwrap(callee.expression);
  if (!ts.isPropertyAccessExpression(modelAccess) && !ts.isPropertyAccessChain(modelAccess)) return null;
  const methods = PRISMA_METHODS.get(modelAccess.name.text);
  if (!methods?.has(method)) return null;
  return `prisma:${modelAccess.name.text}.${method}`;
}

export function isRequestMethod(callee: ts.PropertyAccessExpression, params: Set<string>): boolean {
  const name = callee.name.text;
  if (name !== "json" && name !== "formData" && name !== "text") return false;
  const receiver = unwrap(callee.expression);
  return ts.isIdentifier(receiver) && (params.has(receiver.text) || receiver.text === "request" || receiver.text === "req");
}

export function isRequestBodyProperty(node: ts.Node, requestNames: Set<string>): boolean {
  if (!ts.isPropertyAccessExpression(node) && !ts.isPropertyAccessChain(node)) return false;
  if (node.name.text !== "body") return false;
  const receiver = unwrap(node.expression);
  if (!ts.isIdentifier(receiver) || !requestNames.has(receiver.text)) return false;
  const parent = node.parent;
  return !parent || !ts.isCallExpression(parent);
}

export function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) || ts.isPropertyAccessChain(parent)) return parent.name !== node;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isBindingElement(parent) || ts.isParameter(parent)) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return false;
  return true;
}

export function isAuthRejection(node: ts.IfStatement): boolean {
  if (!statementReturns(node.thenStatement)) return false;
  const names = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child)) names.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node.expression);
  if (names.has("recent")) return false;
  if (names.has("isFullAdmin") || names.has("actorIsFullAdmin")) return true;
  return names.has("ok") && node.expression.getText().includes("!");
}

function statementReturns(node: ts.Statement): boolean {
  if (ts.isReturnStatement(node)) return true;
  if (ts.isBlock(node)) return node.statements.some(statementReturns);
  return false;
}

export function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function walkDir(dir: string, found: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkDir(full, found);
    else if (entry.name === "route.ts") found.add(full);
  }
}
