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
// `scopeName`) and whether it is GUARDED by the screen: a `const` bound to
// `await screenChosenPassword(x, ...)` (or a conditional with that await as a
// branch the test does not rule out), where `x` and the input of the
// `bcrypt.hash(x, ...)` that made the written value (traced as below) resolve
// to the SAME `const` or parameter declaration, with the same property path,
// and nothing reassigns it; followed by an `if` that tests `!name.ok` and
// returns (or throws). A second argument that switches the check off
// (`{ breachedPasswordCheck: false }`) never counts. Both statements must sit
// in a block that encloses the writer and come before it, so a screen in a
// different handler, a callback or a sibling branch never counts. The `if`
// condition is the bare `!name.ok` or a `||` chain holding it, nothing weaker.
// When the screened reference has a property path (`b.pw`), the screen is void
// if, from the start of its arguments to the writer, an alias of its root is
// written through (`const al = b; al.pw = x`), or a call, a tagged template or a
// method call receives the root or a part of the path above the value
// (`Object.assign(b, ...)`, `log({ b })`, `b.reset()`), or a function nested in
// the scope does either (#4746). One definition of that change test serves the
// copy rule below (`objectChanged`). These rules are a best-effort guard against
// accidental changes, not a defence against a determined author: deliberately
// contrived forms (getters, functions that return the object or a closure over
// it, generators, access to an inline literal such as `[b][0]`) are out of scope.
//
// Each property writer also carries the SOURCE of the value it writes
// (`traceWrittenValue`): the expression is followed back through `const`
// bindings in the enclosing scopes and through a `bcrypt.hash(...)` call to the
// hash's input. An exempt writer must trace to random bytes, the erased-account
// sentinel or a fixed literal, so swapping a placeholder's input for a typed
// password fails the census. A raw-SQL writer is a fixed literal only when the
// literal has no template holes, no `$n` or `?` placeholders and no bind
// arguments beside it.
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
 * holes, placeholders or bind arguments. `parameter`: a parameter of the enclosing function (or a property of
 * one), so the caller decides. `copy`: the `passwordHash` of an object built in
 * the same function by a writer that is generated or screened
 * (`copiedWriters`), and never written, aliased and written, or handed to a
 * call afterwards (#4746).
 * `unknown`: anything the trace cannot follow, a typed password included.
 */
export type PasswordHashValueSource =
  | "random"
  | "deleted-sentinel"
  | "literal"
  | "parameter"
  | "copy"
  | "unknown";

/** What a writer may store with no further reason: nobody chose it. */
export const GENERATED_PASSWORD_HASH_SOURCES: ReadonlySet<PasswordHashValueSource> = new Set([
  "random",
  "deleted-sentinel",
  "literal",
]);

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
  /** For a `copy`: the lines of the writers that built the copied object. */
  copiedFromLines: number[];
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

/** True for `false`, or `true` when `negated`: a test that rules a branch out. */
function isConstantTest(test: ts.Expression, negated: boolean): boolean {
  const kind = unwrapParens(test).kind;
  return kind === (negated ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword);
}

/** True when a screen's options argument is a literal switching the check off. */
function switchesCheckOff(options: ts.Expression | undefined): boolean {
  if (!options) return false;
  const value = unwrapValue(options);
  return (
    ts.isObjectLiteralExpression(value) &&
    value.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        nameText(property.name) === "breachedPasswordCheck" &&
        unwrapParens(property.initializer).kind === ts.SyntaxKind.FalseKeyword,
    )
  );
}

/** The call in `node` when it is `await screenChosenPassword(x, ...)` screening `hashed`, else null. */
function screenCallOf(node: ts.Expression, hashed: Reference): ts.CallExpression | null {
  const value = unwrapParens(node);
  if (!ts.isAwaitExpression(value)) return null;
  const call = unwrapParens(value.expression);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
  if (call.expression.text !== SCREEN_HELPER || switchesCheckOff(call.arguments[1])) return null;
  const screened = call.arguments[0] ? referenceOf(call.arguments[0]) : null;
  return screened !== null && sameReference(screened, hashed) ? call : null;
}

/**
 * The names `statement` binds to an awaited screen of `hashed`, and where the
 * screen starts (its first argument): a `const` whose initializer is
 * `await screenChosenPassword(x, ...)` itself, or a conditional with that await
 * as one branch and a test that does not rule the branch out. Any other shape
 * (a `let`, an object literal or comma expression that discards the result)
 * binds nothing.
 */
function screenBinding(statement: ts.Statement, hashed: Reference): { names: string[]; from: number } {
  const bound = { names: [] as string[], from: Infinity };
  if (!ts.isVariableStatement(statement)) return bound;
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return bound;
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const initializer = unwrapParens(declaration.initializer);
    const call = ts.isConditionalExpression(initializer)
      ? (!isConstantTest(initializer.condition, false) && screenCallOf(initializer.whenTrue, hashed)) ||
        (!isConstantTest(initializer.condition, true) && screenCallOf(initializer.whenFalse, hashed)) ||
        null
      : screenCallOf(initializer, hashed);
    if (!call) continue;
    bound.names.push(declaration.name.text);
    bound.from = Math.min(bound.from, call.arguments[0].getStart());
  }
  return bound;
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
 * True when, after the screen, `hashed` (a property path under a `const` or
 * parameter) is changed through an alias of its root or by a call that receives
 * the root (#4746): `const al = b; al.pw = x`, `Object.assign(b, ...)`, `f(b)`,
 * `b.reset()`. `isReassigned` already covers a write through the root's own
 * name; a path-less reference (a plain string) cannot be changed from outside.
 */
function changedAfterScreen(
  hashedInput: ts.Expression,
  hashed: Reference,
  window: { from: number; to: number },
): boolean {
  if (hashed.path.length === 0) return false;
  const access = accessPath(hashedInput);
  const declaration = access && findDeclaration(access.root.text, access.root);
  if (declaration?.kind !== "const" && declaration?.kind !== "parameter") return true;
  return objectChanged(hashed.id, declarationScope(declaration), hashed.path, window, false);
}

/**
 * True when the writer is guarded: in some block enclosing it (up to its
 * function boundary and beyond, so a transaction callback inherits its
 * handler's guard), a screen binding is followed by an `if (!x.ok)` that exits,
 * both before the writer, and nothing changes the screened object between the
 * start of the screen's arguments and the writer. The screen's first argument must resolve to the same
 * declaration and property path as the input of the `bcrypt.hash(...)` that
 * produced the written value (`hashedInput`), so screening one password and
 * hashing another (or a shadowing callback parameter of the same name) does
 * not count; with no traced, unreassigned hash input, nothing does.
 */
function guardedByScreen(writer: ts.Node, hashedInput: ts.Expression | null): boolean {
  const hashed = hashedInput ? referenceOf(hashedInput) : null;
  if (hashed === null) return false;
  const position = writer.getStart();
  for (let current = writer.parent; current; current = current.parent) {
    if (!ts.isBlock(current) && !ts.isSourceFile(current)) continue;
    const bound = new Set<string>();
    let screenedAt = Infinity;
    for (const statement of current.statements) {
      if (statement.getEnd() > position) break;
      const screen = screenBinding(statement, hashed);
      for (const name of screen.names) bound.add(name);
      screenedAt = Math.min(screenedAt, screen.from);
      if (
        ts.isIfStatement(statement) &&
        exits(statement.thenStatement) &&
        testsNotOk(statement.expression, bound) &&
        !changedAfterScreen(hashedInput as ts.Expression, hashed, { from: screenedAt, to: position })
      ) {
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

/** A `const` with a plain identifier name and an initializer: the one kind of constant we follow. */
type FollowedConst = {
  kind: "const";
  id: ts.Identifier;
  declaration: ts.VariableDeclaration;
  initializer: ts.Expression;
};
type Binding = FollowedConst | { kind: "parameter" } | null;

/** Every identifier a binding name (plain or destructuring) declares. */
function declaredIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : declaredIdentifiers(element.name)));
}

/** The identifier in `name` (a plain or destructuring binding) that binds `wanted`. */
function bindingIdentifier(name: ts.BindingName, wanted: string): ts.Identifier | null {
  return declaredIdentifiers(name).find((identifier) => identifier.text === wanted) ?? null;
}

/**
 * The declaration `name` resolves to where `from` reads it: the nearest
 * enclosing scope wins, from the innermost callback out to the module. `id` is
 * the binding identifier itself, so two reads resolve to the same declaration
 * exactly when their `id`s are the same node. `loop` is a `for`, `for…in` or
 * `for…of` initializer's variable; `other` is a `let`, a `var` or a `catch`
 * variable; an import or a global is not found (null).
 */
type Declaration =
  | { kind: "const"; id: ts.Identifier; declaration: ts.VariableDeclaration }
  | { kind: "parameter"; id: ts.Identifier; scope: ts.Node }
  | { kind: "loop"; id: ts.Identifier; statement: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement }
  | { kind: "other"; id: ts.Identifier }
  | null;

function findDeclaration(name: string, from: ts.Node): Declaration {
  for (let current: ts.Node | undefined = from.parent; current; current = current.parent) {
    if (isFunctionLike(current)) {
      for (const parameter of current.parameters) {
        const id = bindingIdentifier(parameter.name, name);
        if (id) return { kind: "parameter", id, scope: current };
      }
    }
    if (
      (ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) &&
      current.initializer &&
      ts.isVariableDeclarationList(current.initializer)
    ) {
      for (const declaration of current.initializer.declarations) {
        const id = bindingIdentifier(declaration.name, name);
        if (id) return { kind: "loop", id, statement: current };
      }
    }
    if (ts.isCatchClause(current) && current.variableDeclaration) {
      const id = bindingIdentifier(current.variableDeclaration.name, name);
      if (id) return { kind: "other", id };
    }
    if (!ts.isBlock(current) && !ts.isSourceFile(current)) continue;
    for (const statement of current.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const list = statement.declarationList;
      for (const declaration of list.declarations) {
        const id = bindingIdentifier(declaration.name, name);
        if (!id) continue;
        return (list.flags & ts.NodeFlags.Const) !== 0 ? { kind: "const", id, declaration } : { kind: "other", id };
      }
    }
  }
  return null;
}

/**
 * What `name` is bound to where `from` reads it. A `const` with a plain
 * identifier gives its declaration and initializer; a parameter (destructured
 * or not) says the caller decides; `let`, a destructured `const`, a loop or
 * `catch` variable or an import is not followed, and an inner one shadows an
 * outer `const`. The one definition of a constant the scanner follows.
 */
function resolveBinding(name: string, from: ts.Node): Binding {
  const declaration = findDeclaration(name, from);
  if (declaration?.kind === "parameter") return { kind: "parameter" };
  if (declaration?.kind !== "const") return null;
  const { declaration: node } = declaration;
  return ts.isIdentifier(node.name) && node.initializer
    ? { kind: "const", id: declaration.id, declaration: node, initializer: node.initializer }
    : null;
}

/** A read of a `const` or parameter declaration, and the property path after it. */
type Reference = { id: ts.Identifier; path: readonly string[] };

/** Stands for a computed key (`a[k]`) in a path: it matches any name. */
const ANY_KEY = "*";

/** The key an element access names: its string literal, else any key (`a[0]`, `a[k]`). */
function elementKey(argument: ts.Expression): string {
  return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument) ? argument.text : ANY_KEY;
}

/**
 * The identifier and key names of an identifier or a chain of property and
 * element accesses: `a.b[0]["c"]` is `a` with `b`, `*` (a number or a computed
 * key) and `c`.
 */
function accessPath(node: ts.Expression): { root: ts.Identifier; path: string[] } | null {
  const value = unwrapValue(node);
  if (ts.isIdentifier(value)) return { root: value, path: [] };
  if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return null;
  const receiver = accessPath(value.expression);
  const key = ts.isPropertyAccessExpression(value) ? value.name.text : elementKey(value.argumentExpression);
  return receiver && { root: receiver.root, path: [...receiver.path, key] };
}

function sameReference(a: Reference, b: Reference): boolean {
  return a.id === b.id && a.path.length === b.path.length && a.path.every((name, i) => name === b.path[i]);
}

/** The targets an assignment or `++`/`--` writes, destructuring included. */
function assignmentTargets(node: ts.Node): ts.Expression[] {
  const fromPattern = (target: ts.Expression): ts.Expression[] => {
    const value = unwrapParens(target);
    if (ts.isArrayLiteralExpression(value)) {
      return value.elements.flatMap((element) =>
        fromPattern(ts.isSpreadElement(element) ? element.expression : element),
      );
    }
    if (ts.isObjectLiteralExpression(value)) {
      return value.properties.flatMap((property) => {
        if (ts.isShorthandPropertyAssignment(property)) return [property.name];
        if (ts.isPropertyAssignment(property)) return fromPattern(property.initializer);
        return ts.isSpreadAssignment(property) ? fromPattern(property.expression) : [];
      });
    }
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return fromPattern(value.left); // a default inside a pattern
    }
    return [value];
  };
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return fromPattern(node.left);
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return [node.operand];
  }
  if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
    return fromPattern(node.initializer);
  }
  return [];
}

/** The declaration node `identifier` resolves to, or null (an import or a global). */
function declarationId(identifier: ts.Identifier): ts.Identifier | null {
  return findDeclaration(identifier.text, identifier)?.id ?? null;
}


/** An object the scan follows: the path from the root a name stands for, and whether it only holds it. */
type Alias = { path: readonly string[]; container: boolean };

/** A read in an expression of a followed object, or of a part of it on the watched path. */
type Reach = { path: readonly string[]; container: boolean; node: ts.Expression };

/**
 * Methods that only read the object or array they are called on, so calling
 * one on it is not a hand-over. Any other method may change it, and a method
 * that returns an element (`at`, `find`, `slice`) hands an element out.
 */
const READ_ONLY_METHODS = new Set([
  "some",
  "every",
  "map",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "hasOwnProperty",
  "toString",
]);

/** Read-only methods that call back with the elements: only an inline function is vetted. */
const CALLBACK_METHODS = new Set(["some", "every", "map", "forEach"]);

/** The arrow or function expression a method call is given as its first argument, if inline. */
function inlineCallback(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | null {
  const callback = call.arguments[0] && unwrapValue(call.arguments[0]);
  return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback : null;
}

/** True when `node` or anything inside it names `arguments`. */
function usesArguments(node: ts.Node): boolean {
  return (ts.isIdentifier(node) && node.text === "arguments") || ts.forEachChild(node, (child) => usesArguments(child) || undefined) === true;
}

/**
 * True when calling `method` on a followed object only reads it: the method is
 * in `READ_ONLY_METHODS`, and one that calls back with the elements has an inline
 * function that does not use `arguments` (a named one gets the elements to
 * change, and an inline one is covered by the aliases of its parameters).
 */
function onlyReads(call: ts.CallExpression, method: string): boolean {
  if (!READ_ONLY_METHODS.has(method)) return false;
  if (!CALLBACK_METHODS.has(method)) return true;
  const callback = inlineCallback(call);
  return callback !== null && !usesArguments(callback);
}

const ALIASING_ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** The expressions a call, `new` or tagged template hands its callee. */
function callArguments(node: ts.Node): ts.Expression[] {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    return (node.arguments ?? []).map((argument) => (ts.isSpreadElement(argument) ? argument.expression : argument));
  }
  if (ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)) {
    return node.template.templateSpans.map((span) => span.expression);
  }
  return [];
}

/**
 * True when, within `window` of `scope`, something changes the object `id`
 * declares, or hands it to code that could (#4746). Conservative by design: any
 * of these counts, wherever the call goes.
 *
 * `watched` is the path under `id` the caller reads; `*` in it is any element
 * of an array. Only a part that path reads through (a strict prefix of it) can
 * be changed in a way that matters, so `hash(id.pw)` for `watched = ["pw"]` is
 * not a hand-over but `log(id)` is.
 *
 * - an alias of the object, to a fixpoint: `const al = id`, a destructuring or
 *   `al = id`, `al ||= id`, either branch of `c ? id : x`, an operand of `||`,
 *   `??` or `&&`, a literal that holds it (`{ id }`, `[id]`), the variable of a
 *   `for…of` over an array of it, every parameter of an inline callback given to
 *   one of its methods, or the root of a property that stores it (`h.d = id`);
 *   an assignment used as an expression evaluates to what it assigned;
 * - a write through an alias (`al.k = v`, `al[i] = v`);
 * - a call, `new` or tagged template that receives the object or an alias
 *   (also inside a literal or a conditional), which covers `Object.assign(id, ...)`;
 * - a call of a method on it (or on a literal that holds it), unless it is in
 *   `READ_ONLY_METHODS` and, when it calls back with the elements, is given an
 *   inline function that does not use `arguments` (`onlyReads`);
 * - with `direct`, also a write through `id` itself (`id.k = v`, `id[i] = v`).
 *   Without it the caller already sees those writes (`isReassigned`).
 *
 * A change inside a function nested in `scope` counts wherever it sits, since
 * it can run at any time (a hoisted declaration, or a closure called later),
 * unless the function holds the whole window.
 *
 * `followed` are reads the caller itself traced through, which are not uses.
 */
function objectChanged(
  id: ts.Identifier,
  scope: ts.Node,
  watched: readonly string[],
  window: { from: number; to: number },
  direct: boolean,
  followed: ReadonlySet<ts.Node> = new Set(),
): boolean {
  const matches = (name: string, wanted: string) =>
    name === wanted || name === ANY_KEY || (wanted === ANY_KEY && /^\d+$/.test(name));
  const isPrefix = (path: readonly string[]) =>
    path.length < watched.length && path.every((name, i) => matches(name, watched[i]));
  // `id` and everything bound to it, or to a part of it on the watched path.
  const sources = new Map<ts.Identifier, Alias>([[id, { path: [], container: false }]]);
  // A container alias stands for the object wherever it is read: `h.d` for
  // `const h = { d: id }` is `id`.
  const rootOf = (node: ts.Expression) => {
    const access = accessPath(node);
    const source = access && declarationId(access.root);
    const alias = source && sources.get(source);
    if (!access || !source || !alias) return null;
    return { source, path: alias.container ? alias.path : [...alias.path, ...access.path], container: alias.container };
  };
  // The followed objects an expression can evaluate to or hold.
  const reach = (expression: ts.Expression, container = false): Reach[] => {
    const value = unwrapValue(expression);
    if (ts.isConditionalExpression(value)) {
      return [...reach(value.whenTrue, container), ...reach(value.whenFalse, container)];
    }
    if (ts.isBinaryExpression(value)) {
      const kind = value.operatorToken.kind;
      if (kind === ts.SyntaxKind.CommaToken) return reach(value.right, container);
      // An assignment used as an expression evaluates to what it assigned; the
      // logical forms may also give back the target they left alone.
      if (ALIASING_ASSIGNMENTS.has(kind)) {
        return kind === ts.SyntaxKind.EqualsToken
          ? reach(value.right, container)
          : [...reach(value.left, container), ...reach(value.right, container)];
      }
      return kind === ts.SyntaxKind.QuestionQuestionToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.AmpersandAmpersandToken
        ? [...reach(value.left, container), ...reach(value.right, container)]
        : [];
    }
    if (ts.isObjectLiteralExpression(value)) {
      return value.properties.flatMap((property) => {
        if (ts.isPropertyAssignment(property)) return reach(property.initializer, true);
        if (ts.isShorthandPropertyAssignment(property)) return reach(property.name, true);
        return ts.isSpreadAssignment(property) ? reach(property.expression, true) : [];
      });
    }
    if (ts.isArrayLiteralExpression(value)) {
      return value.elements.flatMap((element) => reach(ts.isSpreadElement(element) ? element.expression : element, true));
    }
    const found = rootOf(value);
    return found ? [{ path: found.path, container: container || found.container, node: value }] : [];
  };
  const noteAlias = (names: readonly ts.Identifier[], candidates: readonly Reach[], element = false): boolean => {
    let grew = false;
    for (const candidate of candidates) {
      // An element of an array that holds the object is the object itself, so a
      // container keeps its path; an element of an array of objects is a part of it.
      const path = element && !candidate.container ? [...candidate.path, ANY_KEY] : candidate.path;
      if (!isPrefix(path)) continue;
      for (const name of names) {
        if (sources.has(name)) continue;
        sources.set(name, { path, container: candidate.container });
        grew = true;
      }
    }
    return grew;
  };
  const collectAliases = (node: ts.Node): boolean => {
    let grew = false;
    if (ts.isVariableDeclaration(node) && node.initializer) {
      grew = noteAlias(declaredIdentifiers(node.name), reach(node.initializer));
    } else if (ts.isBinaryExpression(node) && ALIASING_ASSIGNMENTS.has(node.operatorToken.kind)) {
      const names = assignmentTargets(node).flatMap((target) => {
        const declared = ts.isIdentifier(target) ? declarationId(target) : null;
        return declared ? [declared] : [];
      });
      grew = noteAlias(names, reach(node.right));
      // Storing it in a property (`h.d = id`, `h[0] = id`) makes the root of the
      // target a container of it.
      const holders = assignmentTargets(node).flatMap((target) => {
        const access = ts.isIdentifier(unwrapParens(target)) ? null : accessPath(target);
        const declared = access && declarationId(access.root);
        return declared ? [declared] : [];
      });
      grew = noteAlias(holders, reach(node.right).map((found) => ({ ...found, container: true }))) || grew;
    } else if (ts.isForOfStatement(node)) {
      const names = ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations.flatMap((declaration) => declaredIdentifiers(declaration.name))
        : assignmentTargets(node).flatMap((target) => {
            const declared = ts.isIdentifier(target) ? declarationId(target) : null;
            return declared ? [declared] : [];
          });
      grew = noteAlias(names, reach(node.expression), true);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      // Every parameter of an inline callback can hold what the method gives it:
      // the first an element, the third the array, and a rest any of them. The
      // second is the index, a number.
      const callback = inlineCallback(node);
      const receivers = reach(node.expression.expression);
      callback?.parameters.forEach((parameter, index) => {
        const names = declaredIdentifiers(parameter.name);
        if (parameter.dotDotDotToken) {
          grew = noteAlias(names, receivers.map((found) => ({ ...found, container: true }))) || grew;
        } else if (index !== 1) {
          grew = noteAlias(names, receivers, index === 0) || grew;
        }
      });
    }
    ts.forEachChild(node, (child) => {
      grew = collectAliases(child) || grew;
    });
    return grew;
  };
  while (collectAliases(scope));
  // Whether a function nested in `scope` can run inside the window, which it
  // does anywhere unless it holds the whole of it.
  const holdsWindow = (fn: ts.Node) =>
    fn.getStart() <= window.from && fn.getEnd() >= Math.min(window.to, scope.getEnd());
  const canRun = (fn: ts.Node) =>
    !holdsWindow(fn) && (ts.isFunctionDeclaration(fn) || fn.getStart() < window.to);
  let changed = false;
  const visit = (node: ts.Node, inClosure: boolean): void => {
    if (changed) return;
    const closure = inClosure || (node !== scope && isFunctionLike(node) && canRun(node));
    const start = node.getStart();
    if (closure || (start >= window.from && start < window.to)) {
      for (const target of assignmentTargets(node)) {
        const write = accessPath(target);
        const source = write && declarationId(write.root);
        if (write && source && sources.has(source) && write.path.length > 0 && (direct || source !== id)) {
          changed = true;
        }
      }
      for (const argument of callArguments(node)) {
        if (reach(argument).some((received) => !followed.has(received.node) && isPrefix(received.path))) {
          changed = true;
        }
      }
      const call = ts.isCallExpression(node) ? node : null;
      const callee = call ? unwrapValue(call.expression) : null;
      if (call && callee && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
        const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : elementKey(callee.argumentExpression);
        // A literal receiver (`[id].forEach(...)`) holds the object as well.
        const receivers = reach(callee.expression);
        if (receivers.some((receiver) => isPrefix(receiver.path)) && !onlyReads(call, method)) changed = true;
      }
    }
    ts.forEachChild(node, (child) => visit(child, closure));
  };
  visit(scope, false);
  return changed;
}

/**
 * True when anything in `scope` writes `reference` or a value on its path: the
 * declaration itself (a parameter), or a property its path reads through.
 */
function isReassigned(reference: Reference, scope: ts.Node): boolean {
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    for (const target of assignmentTargets(node)) {
      const write = accessPath(target);
      if (!write || declarationId(write.root) !== reference.id) continue;
      // Writing the declaration, or any property its path reads through.
      if (
        write.path.length <= reference.path.length &&
        write.path.every((name, i) => name === ANY_KEY || name === reference.path[i])
      ) {
        written = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return written;
}

/** The block (or function) a `const` or parameter is visible in. */
function declarationScope(
  declaration: { kind: "const"; declaration: ts.VariableDeclaration } | { kind: "parameter"; scope: ts.Node },
): ts.Node {
  return declaration.kind === "parameter" ? declaration.scope : declaration.declaration.parent.parent.parent;
}

/**
 * The declaration and path `node` reads, when it is an identifier or a chain of
 * property accesses and literal-key element accesses rooted in a `const` or a parameter that nothing in its
 * scope reassigns; otherwise null.
 */
function referenceOf(node: ts.Expression): Reference | null {
  const access = accessPath(node);
  if (!access) return null;
  const declaration = findDeclaration(access.root.text, access.root);
  if (declaration?.kind !== "const" && declaration?.kind !== "parameter") return null;
  // A computed key names no one property, so two reads of `b[k]` need not match.
  if (access.path.includes(ANY_KEY)) return null;
  const reference = { id: declaration.id, path: access.path };
  return isReassigned(reference, declarationScope(declaration)) ? null : reference;
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

type TracedValue = {
  source: PasswordHashValueSource;
  hashedInput: string | null;
  /** The `bcrypt.hash(...)` input node behind `hashedInput`. */
  hashedInputNode: ts.Expression | null;
  /** For a `copy`: the `passwordHash` writers of the copied object. */
  copiedFrom: ts.Node[];
};

const UNTRACED: TracedValue = { source: "unknown", hashedInput: null, hashedInputNode: null, copiedFrom: [] };

/** The expressions a callback returns, or null if any path returns nothing. */
function returnedExpressions(fn: ts.Node): ts.Expression[] | null {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  if (!ts.isBlock(fn.body)) return [fn.body];
  const returned: ts.Expression[] = [];
  let bare = false;
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returned.push(node.expression);
      else bare = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return bare || returned.length === 0 ? null : returned;
}

/**
 * The `const`s `objectLiterals` followed (each with whether it holds an array
 * of the objects or one object), and the reads of them it followed through.
 */
type LiteralTrace = {
  consts: { binding: FollowedConst; elements: boolean }[];
  followed: Set<ts.Node>;
};

/**
 * The object literals `node` evaluates to; with `elements`, the literals each
 * element of the array it evaluates to is built from. Followed through `const`
 * bindings, array literals, `Promise.all(...)` and `.map(callback)`; anything
 * else is null.
 */
function objectLiterals(
  node: ts.Expression,
  elements: boolean,
  trace: LiteralTrace,
  depth = 0,
): ts.ObjectLiteralExpression[] | null {
  const value = unwrapValue(node);
  if (depth > MAX_TRACE_DEPTH) return null;
  if (ts.isIdentifier(value)) {
    const binding = resolveBinding(value.text, value);
    if (binding?.kind !== "const") return null;
    trace.consts.push({ binding, elements });
    trace.followed.add(value);
    return objectLiterals(binding.initializer, elements, trace, depth + 1);
  }
  if (!elements) return ts.isObjectLiteralExpression(value) ? [value] : null;
  const all = (parts: readonly ts.Expression[], each: boolean) => {
    const found = parts.map((part) => objectLiterals(part, each, trace, depth + 1));
    return found.every((literals) => literals !== null) ? found.flat() : null;
  };
  if (ts.isArrayLiteralExpression(value)) return all(value.elements, false);
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return null;
  const callee = value.expression;
  const [argument] = value.arguments;
  if (callee.name.text === "all" && ts.isIdentifier(callee.expression) && callee.expression.text === "Promise") {
    return value.arguments.length === 1 ? all([argument], true) : null;
  }
  if (callee.name.text === "map" && argument) {
    const returned = returnedExpressions(argument);
    return returned && all(returned, false);
  }
  return null;
}

/**
 * The `passwordHash` writers of the object `copy.passwordHash` reads: `copy`
 * must be a plain `const` or a `const` `for…of` variable, built (through
 * `objectLiterals`) from object literals that each set `passwordHash` after
 * any spread. Anything else is null, so `parsedBody.passwordHash` never counts.
 */
function copiedWriters(copy: ts.PropertyAccessExpression): ts.Node[] | null {
  const root = unwrapValue(copy.expression);
  if (!ts.isIdentifier(root)) return null;
  const binding = resolveBinding(root.text, root);
  const declaration = binding ? null : findDeclaration(root.text, root);
  let literals: ts.ObjectLiteralExpression[] | null = null;
  const trace: LiteralTrace = { consts: [], followed: new Set() };
  // The object, or the loop variable, and each array it came from, with where
  // each is built and the path of the value a copy reads.
  const changeWindows: { id: ts.Identifier; scope: ts.Node; from: number; watched: readonly string[] }[] = [];
  const objectPath = ["passwordHash"];
  if (binding?.kind === "const") {
    changeWindows.push({
      id: binding.id,
      scope: declarationScope(binding),
      from: binding.declaration.getEnd(),
      watched: objectPath,
    });
    literals = objectLiterals(binding.initializer, false, trace);
  } else if (
    declaration?.kind === "loop" &&
    ts.isForOfStatement(declaration.statement) &&
    declaration.id.parent === (declaration.statement.initializer as ts.VariableDeclarationList).declarations[0] &&
    (declaration.statement.initializer.flags & ts.NodeFlags.Const) !== 0
  ) {
    changeWindows.push({
      id: declaration.id,
      scope: declaration.statement,
      from: declaration.statement.getStart(),
      watched: objectPath,
    });
    literals = objectLiterals(declaration.statement.expression, true, trace);
  }
  if (!literals) return null;
  for (const { binding: followed, elements } of trace.consts) {
    changeWindows.push({
      id: followed.id,
      scope: declarationScope(followed),
      from: followed.declaration.getEnd(),
      watched: elements ? [ANY_KEY, ...objectPath] : objectPath,
    });
  }
  // #4746: a write after the build (`x.k = v`, `rows[0] = v`), an alias that
  // writes, `Object.assign(x, ...)` or any call that receives the object, an
  // element of the array or the array can replace the value the literal
  // vetted, so the copy is refused.
  for (const { id, scope, from, watched } of changeWindows) {
    if (objectChanged(id, scope, watched, { from, to: Infinity }, true, trace.followed)) return null;
  }
  const writers: ts.Node[] = [];
  for (const literal of literals) {
    let writer: ts.Node | null = null;
    for (const property of literal.properties) {
      if (isWriterNode(property)) writer = property;
      else if (ts.isSpreadAssignment(property)) writer = null; // a later spread may override it
    }
    if (!writer) return null;
    writers.push(writer);
  }
  return writers;
}

/** Where a WRITTEN `passwordHash` value comes from, and the hash call's input. */
function traceWrittenValue(node: ts.Expression, depth = 0): TracedValue {
  const value = unwrapValue(node);
  if (depth > MAX_TRACE_DEPTH) return UNTRACED;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return { ...UNTRACED, source: "literal" };
  }
  if (isHashCall(value)) {
    const input = value.arguments[0];
    return input
      ? { ...UNTRACED, source: traceHashInput(input, depth + 1), hashedInput: referenceText(input), hashedInputNode: input }
      : UNTRACED;
  }
  if (ts.isIdentifier(value)) {
    if (value.text === "DELETED_ACCOUNT_PASSWORD_HASH") return { ...UNTRACED, source: "deleted-sentinel" };
    const binding = resolveBinding(value.text, value);
    if (binding?.kind === "const") return traceWrittenValue(binding.initializer, depth + 1);
    return binding?.kind === "parameter" ? { ...UNTRACED, source: "parameter" } : UNTRACED;
  }
  if (ts.isPropertyAccessExpression(value) && value.name.text === "passwordHash") {
    const root = rootIdentifier(value);
    if (root !== null && resolveBinding(root.text, root)?.kind === "parameter") {
      return { ...UNTRACED, source: "parameter" };
    }
    const copiedFrom = copiedWriters(value);
    return copiedFrom ? { ...UNTRACED, source: "copy", copiedFrom } : UNTRACED;
  }
  return UNTRACED;
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

/** A `$1`-style or `?` bind placeholder: the value is supplied at run time. */
const SQL_PLACEHOLDER = /\$\d+|(?:^|[\s(,=])\?(?=[\s,);]|$)/m;

/**
 * Where a raw-SQL writer's value comes from: a fixed literal only when the
 * whole statement is one literal with no template holes, no bind placeholders,
 * no string joined to it and no bind arguments beside it, so the value is
 * written inline.
 */
function sqlValueSource(node: ts.Node): PasswordHashValueSource {
  if (ts.isTemplateExpression(node)) return "unknown";
  if (SQL_PLACEHOLDER.test(literalText(node) ?? "")) return "unknown";
  let current: ts.Node = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)) current = current.parent;
  // Joined to another string (`'... = \'' + h + '\''`), the value is built at run time.
  if (
    ts.isBinaryExpression(current.parent) &&
    (current.parent.operatorToken.kind === ts.SyntaxKind.PlusToken ||
      current.parent.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
  ) {
    return "unknown";
  }
  const call = current.parent;
  return ts.isCallExpression(call) && call.arguments.length > 1 && call.arguments.includes(current as ts.Expression)
    ? "unknown"
    : "literal";
}

export function scanPasswordHashWriters(file: string, source: string): PasswordHashWriterSite[] {
  const kind = /\.tsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.[cm]?js$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const sites: PasswordHashWriterSite[] = [];
  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  // A copy counts only from a writer in the same function that is generated
  // or screened; otherwise the copied value is unknown.
  const copiesVettedValue = (copy: ts.Node, origin: ts.Node): boolean => {
    const value = writtenValue(origin);
    if (!value || scopeName(origin) !== scopeName(copy)) return false;
    const traced = traceWrittenValue(value);
    return GENERATED_PASSWORD_HASH_SOURCES.has(traced.source) || guardedByScreen(origin, traced.hashedInputNode);
  };
  const visit = (node: ts.Node): void => {
    const writerKind = isWriterNode(node) ? "property" : isSqlWriterNode(node) ? "sql" : null;
    if (writerKind) {
      const value = writtenValue(node);
      let traced: TracedValue = value ? traceWrittenValue(value) : { ...UNTRACED, source: sqlValueSource(node) };
      if (traced.source === "copy" && !traced.copiedFrom.every((origin) => copiesVettedValue(node, origin))) {
        traced = UNTRACED;
      }
      sites.push({
        file,
        scope: scopeName(node),
        kind: writerKind,
        line: lineOf(node),
        screenedBefore: guardedByScreen(node, traced.hashedInputNode),
        source: traced.source,
        hashedInput: traced.hashedInput,
        copiedFromLines: traced.copiedFrom.map(lineOf),
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
