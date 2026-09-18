import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * THE ONE SCANNER for `BookingGuestNight` writers (#3275, #3276). Stage 1's
 * census (`booking-guest-night-price-source-census.test.ts`, INV-MONEY-028)
 * discovers every direct and nested night writer in the tree by AST; stage 2's
 * census (`booking-guest-night-adjustment-census.test.ts`, INV-MONEY-029)
 * asserts that every writer it discovers has declared how it records — or does
 * not record — the promotion build-up. Both read the same discovery, so a new
 * night writer cannot be added without the second census asking about it.
 */
const REPO = process.cwd();
const SKIPPED_DIRECTORIES = new Set([
  ".artifacts",
  ".git",
  ".next",
  "__tests__",
  "coverage",
  "migration-verification",
  "migrations",
  "node_modules",
]);
const EXECUTABLE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/;
const DIRECT_WRITER_METHODS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
]);
const RAW_SQL_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO)\b[\s\S]{0,500}["'`]BookingGuestNight["'`]/i;

export type SourceScan = {
  direct: number;
  nested: number;
  aliasedDelegates: number;
  rawSqlWrites: number;
};

/** Every non-test executable source file in the tree, absolute paths. */
export function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (
        EXECUTABLE_EXTENSION.test(entry.name) &&
        !TEST_FILE.test(entry.name)
      ) {
        files.push(full);
      }
    }
  };
  walk(REPO);
  return files;
}

export function relativeSource(file: string): string {
  return relative(REPO, file).split("\\").join("/");
}

export function scanSource(file: string, code: string): SourceScan {
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    false,
    /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let direct = 0;
  let nested = 0;
  let aliasedDelegates = 0;
  const propertyName = (name: ts.PropertyName): string | undefined =>
    ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
  const isNightDelegate = (node: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "bookingGuestNight") ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "bookingGuestNight");
  const visit = (
    node: ts.Node,
    parent?: ts.Node,
    grandparent?: ts.Node,
  ) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      DIRECT_WRITER_METHODS.has(node.expression.name.text) &&
      isNightDelegate(node.expression.expression)
    ) {
      direct += 1;
    }
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === "nights" &&
      ts.isObjectLiteralExpression(node.initializer) &&
      node.initializer.properties.some(
        (entry) =>
          ts.isPropertyAssignment(entry) && propertyName(entry.name) === "create",
      )
    ) {
      nested += 1;
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      isNightDelegate(node)
    ) {
      const method = parent;
      const call = grandparent;
      const isDirectCalledMethod =
        method !== undefined &&
        call !== undefined &&
        ts.isPropertyAccessExpression(method) &&
        method.expression === node &&
        ts.isCallExpression(call) &&
        call.expression === method;
      if (!isDirectCalledMethod) aliasedDelegates += 1;
    }
    if (
      ts.isBindingElement(node) &&
      ((node.propertyName !== undefined &&
        propertyName(node.propertyName) === "bookingGuestNight") ||
        (ts.isIdentifier(node.name) && node.name.text === "bookingGuestNight"))
    ) {
      aliasedDelegates += 1;
    }
    ts.forEachChild(node, (child) => visit(child, node, parent));
  };
  visit(source);
  return {
    direct,
    nested,
    aliasedDelegates,
    rawSqlWrites: RAW_SQL_WRITE.test(stripComments(code)) ? 1 : 0,
  };
}

export function discoveredWriterSiteCounts(): Map<string, SourceScan> {
  const sites = new Map<string, SourceScan>();
  for (const file of sourceFiles()) {
    const scan = scanSource(file, readFileSync(file, "utf8"));
    if (
      scan.direct > 0 ||
      scan.nested > 0 ||
      scan.aliasedDelegates > 0 ||
      scan.rawSqlWrites > 0
    ) {
      sites.set(relativeSource(file), scan);
    }
  }
  return sites;
}

