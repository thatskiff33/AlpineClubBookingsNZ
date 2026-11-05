import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Scanner for the `passwordHash` writer census (#4610, INV-AUTH-006).
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
// different handler, a callback or a sibling branch never counts. The `if`
// condition is the bare `!name.ok` or a `||` chain holding it, nothing weaker.
//
// Each property writer also carries the SOURCE of the value it writes
// (`traceWrittenValue`): the expression is followed back through `const`
// bindings in the enclosing scopes and through a `bcrypt.hash(...)` call to the
// hash's input. An exempt writer must trace to random bytes, the erased-account
// sentinel or a fixed literal, so swapping a placeholder's input for a typed
// password fails the census. A raw-SQL writer is a fixed literal only when the
// literal has no template holes.
//
// Stated limits: SQL assembled by concatenating separate literals, or read
// from a `.sql` file at run time, is not seen (no writer here does either;
// `prisma/migrations` is schema, not a runtime writer, and is the one directory
// skipped by path). Only `.ts`/`.js` sources under the scan roots are read.

export const SCREEN_HELPER = "screenChosenPassword";

export type PasswordHashWriterKind = "property" | "sql";

/**
 * Where a written value comes from. `random`: a hash of `randomBytes` or
 * `randomUUID` output. `deleted-sentinel`: `DELETED_ACCOUNT_PASSWORD_HASH`.
 * `literal`: a fixed string, or the hash of one, or a raw-SQL literal with no
 * holes. `parameter`: a parameter of the enclosing function (or a property of
 * one), so the caller decides. `copy`: another object's `passwordHash`.
 * `unknown`: anything the trace cannot follow, a typed password included.
 */
export type PasswordHashValueSource =
  | "random"
  | "deleted-sentinel"
  | "literal"
  | "parameter"
  | "copy"
  | "unknown";

export type PasswordHashWriterSite = {
  file: string;
  scope: string;
  kind: PasswordHashWriterKind;
  line: number;
  /** Guarded by a bound, awaited screen whose `!x.ok` branch exits first. */
  screenedBefore: boolean;
  /** Where the written value comes from (`traceWrittenValue`). */
  source: PasswordHashValueSource;
  /**
   * The first argument of the `bcrypt.hash(...)` that produced the written
   * value, as source text, when it is an identifier or a property-access chain
   * (`newPassword`, `parsed.data.password`); otherwise null.
   */
  hashedInput: string | null;
};

const REPO_ROOT = process.cwd();
export const PASSWORD_HASH_SCAN_ROOTS = ["src", "prisma", "scripts"] as const;

function walk(root: string, relative: string): string[] {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || child === "prisma/migrations") {
        return [];
      }
      return walk(root, child);
    }
    return /\.(?:[cm]?tsx?|[cm]?js)$/.test(entry.name) ? [child] : [];
  });
}

/**
 * Every non-test source file under the scan roots, relative to `root` (the
 * repository by default) and `/`-separated.
 */
export function passwordHashScanFiles(root: string = REPO_ROOT): string[] {
  return PASSWORD_HASH_SCAN_ROOTS.flatMap((scanRoot) => walk(root, scanRoot)).filter(
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

/** `node` without any parentheses around it. */
function unwrapParens(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrapParens(node.expression) : node;
}

/**
 * True when `condition` is `!name.ok` for one of `names`, or a `||` chain with
 * it as one operand: either way a failed screen enters the branch. A guard
 * under `&&` (`flag && !s.ok`), a double negation (`!!s.ok`) or any other
 * wrapper can let a failed screen through, so it does not count.
 */
function testsNotOk(condition: ts.Expression, names: ReadonlySet<string>): boolean {
  const node = unwrapParens(condition);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return testsNotOk(node.left, names) || testsNotOk(node.right, names);
  }
  if (!ts.isPrefixUnaryExpression(node) || node.operator !== ts.SyntaxKind.ExclamationToken) {
    return false;
  }
  const operand = unwrapParens(node.operand);
  return (
    ts.isPropertyAccessExpression(operand) &&
    operand.name.text === "ok" &&
    ts.isIdentifier(operand.expression) &&
    names.has(operand.expression.text)
  );
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

/** The value a property writer stores, or null for a raw-SQL writer. */
function writtenValue(node: ts.Node): ts.Expression | null {
  if (ts.isPropertyAssignment(node)) return node.initializer;
  if (ts.isShorthandPropertyAssignment(node)) return node.name;
  if (ts.isBinaryExpression(node)) return node.right;
  return null;
}

/** `node` without parentheses, `await`, `!` or type assertions around it. */
function unwrapValue(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

type Binding = { kind: "const"; initializer: ts.Expression } | { kind: "parameter" } | null;

function bindsName(name: ts.BindingName, wanted: string): boolean {
  if (ts.isIdentifier(name)) return name.text === wanted;
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsName(element.name, wanted),
  );
}

/**
 * What `name` is bound to where `from` reads it: the nearest enclosing scope
 * wins, from the innermost callback out to the module. A `const` with a plain
 * identifier gives its initializer; a parameter (destructured or not) says the
 * caller decides; `let`, a destructured `const`, a loop variable or an import
 * is not followed.
 */
function resolveBinding(name: string, from: ts.Node): Binding {
  for (let current: ts.Node | undefined = from.parent; current; current = current.parent) {
    if (isFunctionLike(current) && current.parameters.some((p) => bindsName(p.name, name))) {
      return { kind: "parameter" };
    }
    if (!ts.isBlock(current) && !ts.isSourceFile(current)) continue;
    for (const statement of current.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const list = statement.declarationList;
      for (const declaration of list.declarations) {
        if (!bindsName(declaration.name, name)) continue;
        const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
        return isConst && ts.isIdentifier(declaration.name) && declaration.initializer
          ? { kind: "const", initializer: declaration.initializer }
          : null;
      }
    }
  }
  return null;
}

const MAX_TRACE_DEPTH = 8;
const HASH_FUNCTIONS = new Set(["hash", "hashSync"]);
const HASH_MODULES = new Set(["bcrypt", "bcryptjs"]);
const RANDOM_FUNCTIONS = new Set(["randomBytes", "randomUUID"]);

/** True for `hash(...)`, `hashSync(...)`, `bcrypt.hash(...)` or `bcryptjs.hashSync(...)`. */
function isHashCall(node: ts.Expression): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return HASH_FUNCTIONS.has(callee.text);
  return (
    ts.isPropertyAccessExpression(callee) &&
    HASH_FUNCTIONS.has(callee.name.text) &&
    ts.isIdentifier(callee.expression) &&
    HASH_MODULES.has(callee.expression.text)
  );
}

/** True when a call in `node`'s receiver chain is `randomBytes(...)` or `randomUUID()` (bare or `crypto.`). */
function callsRandom(node: ts.Expression): boolean {
  let current: ts.Expression = unwrapValue(node);
  for (;;) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name && RANDOM_FUNCTIONS.has(name)) return true;
      current = callee;
    } else if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    } else {
      return false;
    }
  }
}

/** Source text of an identifier or a property-access chain of identifiers. */
function referenceText(node: ts.Expression): string | null {
  const value = unwrapValue(node);
  if (ts.isIdentifier(value)) return value.text;
  if (ts.isPropertyAccessExpression(value)) {
    const receiver = referenceText(value.expression);
    return receiver === null ? null : `${receiver}.${value.name.text}`;
  }
  return null;
}

/** The leftmost identifier of a property-access chain. */
function rootIdentifier(node: ts.Expression): ts.Identifier | null {
  const value = unwrapValue(node);
  if (ts.isIdentifier(value)) return value;
  return ts.isPropertyAccessExpression(value) ? rootIdentifier(value.expression) : null;
}

/** Where the INPUT to a hash call comes from. */
function traceHashInput(node: ts.Expression, depth: number): PasswordHashValueSource {
  const value = unwrapValue(node);
  if (depth > MAX_TRACE_DEPTH) return "unknown";
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return "literal";
  if (callsRandom(value)) return "random";
  if (ts.isIdentifier(value)) {
    const binding = resolveBinding(value.text, value);
    if (binding?.kind === "const") return traceHashInput(binding.initializer, depth + 1);
    return binding?.kind === "parameter" ? "parameter" : "unknown";
  }
  return "unknown";
}

type TracedValue = { source: PasswordHashValueSource; hashedInput: string | null };

/** Where a WRITTEN `passwordHash` value comes from, and the hash call's input. */
function traceWrittenValue(node: ts.Expression, depth = 0): TracedValue {
  const value = unwrapValue(node);
  if (depth > MAX_TRACE_DEPTH) return { source: "unknown", hashedInput: null };
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return { source: "literal", hashedInput: null };
  }
  if (isHashCall(value)) {
    const input = value.arguments[0];
    return input
      ? { source: traceHashInput(input, depth + 1), hashedInput: referenceText(input) }
      : { source: "unknown", hashedInput: null };
  }
  if (ts.isIdentifier(value)) {
    if (value.text === "DELETED_ACCOUNT_PASSWORD_HASH") return { source: "deleted-sentinel", hashedInput: null };
    const binding = resolveBinding(value.text, value);
    if (binding?.kind === "const") return traceWrittenValue(binding.initializer, depth + 1);
    return { source: binding?.kind === "parameter" ? "parameter" : "unknown", hashedInput: null };
  }
  if (ts.isPropertyAccessExpression(value) && value.name.text === "passwordHash") {
    const root = rootIdentifier(value);
    const parameter = root !== null && resolveBinding(root.text, root)?.kind === "parameter";
    return { source: parameter ? "parameter" : "copy", hashedInput: null };
  }
  return { source: "unknown", hashedInput: null };
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
      const value = writtenValue(node);
      const traced: TracedValue = value
        ? traceWrittenValue(value)
        : { source: ts.isTemplateExpression(node) ? "unknown" : "literal", hashedInput: null };
      sites.push({
        file,
        scope: scopeName(node),
        kind: writerKind,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        screenedBefore: guardedByScreen(node),
        ...traced,
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
