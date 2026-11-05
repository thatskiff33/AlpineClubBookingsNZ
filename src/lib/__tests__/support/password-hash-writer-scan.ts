import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Scanner for the `passwordHash` writer census (#4610, INV-AUTH-005).
//
// Two passes over the TypeScript AST, so comments never count:
//
// 1. Property writers — any place a value is given to a `passwordHash`
//    property: an object-literal property (`passwordHash: x`,
//    `"passwordHash": x`), a shorthand property (`{ passwordHash }`), or an
//    assignment (`row.passwordHash = x`, `row["passwordHash"] = x`). Types,
//    selects (`passwordHash: true|false`) and destructuring reads are not
//    writers, and the parser tells those shapes apart.
// 2. Raw-SQL writers — a string or template literal (tagged or not) naming the
//    `passwordHash` column (quoted or bare) together with `INSERT` or `UPDATE`.
//
// Each writer is reported with its enclosing named function ("scope", see
// `scopeName`) and whether it is GUARDED by the screen: an awaited
// `screenChosenPassword(...)` whose result is bound to a name, followed by an
// `if` that tests `!name.ok` and returns (or throws). Both statements must sit
// in a block that encloses the writer and come before it, so a screen in a
// different handler, a callback or a sibling branch never counts.
//
// Stated limits: SQL assembled by concatenating separate literals, or read
// from a `.sql` file at run time, is not seen (no writer here does either; the
// `migrations` directories are schema, not runtime writers). Only `.ts`/`.js`
// sources under the scan roots are read.

export const SCREEN_HELPER = "screenChosenPassword";

export type PasswordHashWriterKind = "property" | "sql";

export type PasswordHashWriterSite = {
  file: string;
  scope: string;
  kind: PasswordHashWriterKind;
  line: number;
  /** Guarded by a bound, awaited screen whose `!x.ok` branch exits first. */
  screenedBefore: boolean;
};

const REPO_ROOT = process.cwd();
export const PASSWORD_HASH_SCAN_ROOTS = ["src", "prisma", "scripts"] as const;

function walk(relative: string): string[] {
  const absolute = path.join(REPO_ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "migrations") {
        return [];
      }
      return walk(child);
    }
    return /\.(?:[cm]?tsx?|[cm]?js)$/.test(entry.name) ? [child] : [];
  });
}

/** Every non-test source file under the scan roots, relative and `/`-separated. */
export function passwordHashScanFiles(): string[] {
  return PASSWORD_HASH_SCAN_ROOTS.flatMap(walk).filter(
    (file) =>
      !file.includes("/__tests__/") &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
      !file.endsWith(".d.ts"),
  );
}

function nameText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

const isFunctionLike = (node: ts.Node): node is ts.SignatureDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

/**
 * The name a function is known by: its own name, or for an anonymous function
 * the variable it initialises — directly or as an argument to a wrapper, as in
 * `export const POST = withGuard(async () => ...)`. Null for a callback, which
 * takes the name of the function around it.
 */
function functionName(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
    return nameText(fn.name) ?? "anonymous-method";
  }
  if (ts.isConstructorDeclaration(fn)) return "constructor";
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  let current: ts.Node = fn;
  while (
    ts.isCallExpression(current.parent) ||
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent)
  ) {
    // A wrapper's argument, never the callee or a call nested in an await.
    if (ts.isCallExpression(current.parent) && current.parent.expression === current) return null;
    current = current.parent;
  }
  return ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)
    ? current.parent.name.text
    : null;
}

/** The nearest enclosing named function, or "module" at the top level. */
function scopeName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionLike(current)) {
      const name = functionName(current);
      if (name) return name;
    }
  }
  return "module";
}

function isWriterNode(node: ts.Node): boolean {
  if (ts.isPropertyAssignment(node) && nameText(node.name) === "passwordHash") {
    const value = node.initializer;
    return value.kind !== ts.SyntaxKind.TrueKeyword && value.kind !== ts.SyntaxKind.FalseKeyword;
  }
  if (ts.isShorthandPropertyAssignment(node) && node.name.text === "passwordHash") {
    return true;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const left = node.left;
    if (ts.isPropertyAccessExpression(left) && left.name.text === "passwordHash") return true;
    if (ts.isElementAccessExpression(left) && nameText(left.argumentExpression) === "passwordHash") {
      return true;
    }
  }
  return false;
}

/** `name` when `statement` is `const name = await screenChosenPassword(...)` (or `cond ? await ... : ...`). */
function screenBinding(statement: ts.Statement): string[] {
  if (!ts.isVariableStatement(statement)) return [];
  const names: string[] = [];
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    let awaitsScreen = false;
    const visit = (node: ts.Node): void => {
      if (awaitsScreen || isFunctionLike(node)) return;
      if (
        ts.isAwaitExpression(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === SCREEN_HELPER
      ) {
        awaitsScreen = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.initializer);
    if (awaitsScreen) names.push(declaration.name.text);
  }
  return names;
}

/** True when `statement` leaves the function on every path through it. */
function exits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  return ts.isBlock(statement) && statement.statements.some(exits);
}

/** True when `condition` contains `!name.ok` for one of `names`. */
function testsNotOk(condition: ts.Expression, names: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || isFunctionLike(node)) return;
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isPropertyAccessExpression(node.operand) &&
      node.operand.name.text === "ok" &&
      ts.isIdentifier(node.operand.expression) &&
      names.has(node.operand.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return found;
}

/**
 * True when the writer is guarded: in some block enclosing it (up to its
 * function boundary and beyond, so a transaction callback inherits its
 * handler's guard), a screen binding is followed by an `if (!x.ok)` that exits,
 * both before the writer.
 */
function guardedByScreen(writer: ts.Node): boolean {
  const position = writer.getStart();
  for (let current = writer.parent; current; current = current.parent) {
    if (!ts.isBlock(current) && !ts.isSourceFile(current)) continue;
    const bound = new Set<string>();
    for (const statement of current.statements) {
      if (statement.getEnd() > position) break;
      for (const name of screenBinding(statement)) bound.add(name);
      if (ts.isIfStatement(statement) && exits(statement.thenStatement) && testsNotOk(statement.expression, bound)) {
        return true;
      }
    }
  }
  return false;
}

const SQL_WRITE = /\b(?:INSERT|UPDATE)\b/i;
const SQL_PASSWORD_HASH_COLUMN = /"passwordHash"|\bpasswordHash\b/;

/** The literal text of a string or template literal (template holes dropped). */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  }
  return null;
}

function isSqlWriterNode(node: ts.Node): boolean {
  const text = literalText(node);
  return text !== null && SQL_WRITE.test(text) && SQL_PASSWORD_HASH_COLUMN.test(text);
}

export function scanPasswordHashWriters(file: string, source: string): PasswordHashWriterSite[] {
  const kind = /\.tsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.[cm]?js$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const sites: PasswordHashWriterSite[] = [];
  const visit = (node: ts.Node): void => {
    const writerKind = isWriterNode(node) ? "property" : isSqlWriterNode(node) ? "sql" : null;
    if (writerKind) {
      sites.push({
        file,
        scope: scopeName(node),
        kind: writerKind,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        screenedBefore: guardedByScreen(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

export function scanRepositoryPasswordHashWriters(): PasswordHashWriterSite[] {
  return passwordHashScanFiles().flatMap((file) =>
    scanPasswordHashWriters(file, fs.readFileSync(path.join(REPO_ROOT, file), "utf8")),
  );
}
