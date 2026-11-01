/**
 * Which Prisma delegate uses in a source file do anything but READ (#4626).
 *
 * The member-money journal census and the club tax setting census both need
 * "this delegate is only ever read here", and a text pattern for writes is easy
 * to step around: alias the delegate (`const d = tx.memberMoneyLine`), reach it
 * by brackets (`tx["memberMoneyLine"]`), destructure it (`const { memberMoneyLine } = tx`)
 * or chain it optionally (`tx?.memberMoneyLine?.create`). So the rule is the
 * other way round and syntactic: every mention of a delegate name must be the
 * receiver of a call to a read method, a relation key whose value is `true` or
 * an object made only of literals (no identifier, call, spread or write key),
 * or a type. Anything else is reported. A name built at
 * runtime from pieces is outside what any static scan can see.
 */
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const READ_METHODS = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy",
]);
/** Keys that make a nested relation object in a query a write. */
const NESTED_WRITE_KEYS = new Set([
  "create", "createMany", "connectOrCreate", "connect", "disconnect", "set", "update", "updateMany", "upsert", "delete", "deleteMany",
]);

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(["node_modules", "__tests__", "generated", ".next"]);

/** Every non-test source file under `src/` and `scripts/`, and the top-level files of `prisma/`, repo-relative. */
export function productionSourceFiles(root: string): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : walk(path);
    return SOURCE.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name) ? [path] : [];
  });
  const prisma = readdirSync(join(root, "prisma"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name))
    .map((entry) => join(root, "prisma", entry.name));
  return [...walk(join(root, "src")), ...walk(join(root, "scripts")), ...prisma]
    .map((file) => relative(root, file).split(sep).join("/"));
}

function nameOf(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

/** The member name a property or literal-keyed element access reads, if any. */
function accessedName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
}

/**
 * A query value made only of literals: `true`, numbers, strings, null, and
 * object or array literals of the same, with no key that writes. An identifier,
 * call, spread or template with a substitution could carry a nested write the
 * scan cannot see, so none is allowed.
 */
function isLiteralQuery(node: ts.Expression): boolean {
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword
    || node.kind === ts.SyntaxKind.NullKeyword || ts.isNumericLiteral(node) || ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => isLiteralQuery(element));
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => ts.isPropertyAssignment(property)
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      && !NESTED_WRITE_KEYS.has(property.name.text)
      && isLiteralQuery(property.initializer));
  }
  return false;
}

/** `access` (a delegate reached by `.name` or `["name"]`) is the receiver of a read call. */
function isReadCall(access: ts.Node): boolean {
  const method = access.parent;
  if (!method || (method as ts.PropertyAccessExpression).expression !== access) return false;
  const name = accessedName(method);
  const call = method.parent;
  return name !== undefined && READ_METHODS.has(name) && !!call && ts.isCallExpression(call) && call.expression === method;
}

function isAllowedUse(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  // `x.delegate` or `x["delegate"]`, followed by a read call.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return isReadCall(parent);
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return isReadCall(parent);
  // A relation key in select/include/where: `true`, or an object built only of literals.
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    const value = parent.initializer;
    return value.kind === ts.SyntaxKind.TrueKeyword || (ts.isObjectLiteralExpression(value) && isLiteralQuery(value));
  }
  // A type: `Pick<Prisma.TransactionClient, "memberMoneyLine">`.
  if (ts.isLiteralTypeNode(parent)) return true;
  return false;
}

export interface DelegateUse {
  line: number;
  text: string;
}

/** Every mention of a delegate the predicate names that is not a read, with its line. */
export function delegateUsesBeyondReads(source: string, fileName: string, isDelegate: (name: string) => boolean): DelegateUse[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const uses: DelegateUse[] = [];
  const visit = (node: ts.Node) => {
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? nameOf(node) : undefined;
    if (name !== undefined && isDelegate(name) && !isAllowedUse(node)) {
      const statement = node.parent ?? node;
      uses.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        text: statement.getText(file).split("\n")[0]!.slice(0, 120),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return uses;
}

