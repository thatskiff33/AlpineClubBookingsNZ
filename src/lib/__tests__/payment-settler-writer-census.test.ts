/**
 * #4211 (`INV-PAY-043`): `Payment.settledByTransactionId` has ONE home for its
 * writes, `src/lib/payment-settler.ts`. The duplicate-capture guard never
 * refunds the row it names, so a third writer that set it on a path no PAID
 * claim runs (or forgot to clear it on a re-open) would protect the wrong
 * capture.
 *
 * Read with the TypeScript parser, not a regex (#4211 review F3: a regex missed
 * the shorthand `data: { settledByTransactionId }` and flagged `where:` reads).
 * A WRITE is a property named `settledByTransactionId` in an object literal -
 * written out or shorthand, wherever the object is built, so one built
 * elsewhere and passed whole is caught too - that is not a `select`/`include`
 * flag (`true` or `false`) and does not sit inside a `where`, `select`,
 * `include`, `orderBy`, `distinct` or `cursor` argument of the same call (the
 * walk up stops at the first function or call, so a closure under `select`
 * that writes is still a write); any string or template naming the column
 * inside a `$executeRaw*` / `$queryRaw*` call or a `Prisma.sql` / `sql` tag,
 * however the SQL is split across literals, and a module constant naming it
 * that such a call uses (a raw read is flagged too: raw SQL on this column goes
 * through the home or not at all); elsewhere, a literal naming it beside
 * UPDATE, INSERT or SET; and an assignment to it (`data.settledByTransactionId =
 * x`, `data["settledByTransactionId"] = x`). Types, property reads and the
 * column in a filter written inside the call pass.
 *
 * CONSERVATIVE: a filter built OUTSIDE the call (`const where = {
 * settledByTransactionId: id }`) is flagged as a write - move it inline, or
 * into the home. WHAT IT CANNOT SEE: a computed key (`["settledBy" +
 * "TransactionId"]`), and raw SQL assembled outside a raw call from literals
 * that split the column's own name.
 *
 * `pnpm run test:related` cannot select this file (it reads the tree from disk,
 * with no import edge to it); run it by name with `pnpm run test:named`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const HOME = "src/lib/payment-settler.ts";
const COLUMN = "settledByTransactionId";
const READ_ARGUMENTS = new Set(["where", "select", "include", "orderBy", "distinct", "cursor"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  const name = node.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/**
 * Inside a read argument of the same call: an enclosing property assignment is
 * named where/select/..., found before the walk leaves the call or function
 * that holds the property (a closure under `select` can still write).
 */
function insideReadArgument(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent) || ts.isCallExpression(parent)) return false;
    if (ts.isPropertyAssignment(parent) && READ_ARGUMENTS.has(propertyName(parent) ?? "")) return true;
  }
  return false;
}

const RAW_SQL_CALL = /^(\$(executeRaw|queryRaw)|sql$)/;

/** Inside an argument of a `$executeRaw*` / `$queryRaw*` call or tag, or a `Prisma.sql` / `sql` tag or call. */
function insideRawSql(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    const callee = ts.isCallExpression(parent) ? parent.expression : ts.isTaggedTemplateExpression(parent) ? parent.tag : null;
    if (callee) {
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
      if (RAW_SQL_CALL.test(name)) return true;
    }
  }
  return false;
}

/** The 1-based lines of every write of the column in one source text. */
function settledByWrites(fileName: string, text: string): number[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  // Constants whose literal names the column: used inside raw SQL, they write it.
  const namingConstants = new Set<string>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && node.initializer.getText(source).includes(COLUMN)) {
      namingConstants.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const assignsColumn = (target: ts.Expression) =>
    (ts.isPropertyAccessExpression(target) && target.name.text === COLUMN) ||
    (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression) && target.argumentExpression.text === COLUMN);
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && assignsColumn(node.left)) {
      lines.push(at(node));
    } else if (ts.isIdentifier(node) && namingConstants.has(node.text) && !ts.isVariableDeclaration(node.parent) && insideRawSql(node)) {
      lines.push(at(node));
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === COLUMN && !insideReadArgument(node)) {
      lines.push(at(node));
    } else if (ts.isPropertyAssignment(node) && propertyName(node) === COLUMN) {
      const flag = node.initializer.kind === ts.SyntaxKind.TrueKeyword || node.initializer.kind === ts.SyntaxKind.FalseKeyword;
      if (!flag && !insideReadArgument(node)) lines.push(at(node));
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
      node.text.includes(COLUMN) &&
      (insideRawSql(node) || /\b(update|insert|set)\b/i.test(node.text))
    ) {
      lines.push(at(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe("Payment.settledByTransactionId has one writer home (#4211, INV-PAY-043)", { timeout: 60_000 }, () => {
  it("writes it only in payment-settler.ts", () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (rel === HOME) return [];
      const text = readFileSync(file, "utf8");
      // Only a file that names the column can write it; parse just those.
      return text.includes(COLUMN) ? settledByWrites(rel, text).map((line) => `${rel}:${line}`) : [];
    });
    expect(
      offenders,
      "INV-PAY-043: write Payment.settledByTransactionId only through src/lib/payment-settler.ts (recordSettlingTransaction or CLEAR_SETTLING_TRANSACTION).",
    ).toEqual([]);
  });

  it("is non-vacuous: the home's own writes are seen, and the walk reads the tree", () => {
    expect(settledByWrites(HOME, readFileSync(path.join(ROOT, HOME), "utf8")).length).toBeGreaterThanOrEqual(2);
    expect(sourceFiles(SRC).length).toBeGreaterThan(500);
  });

  it.each([
    ["a literal clear", "await tx.payment.update({ where, data: { settledByTransactionId: null } });", 1],
    ["a variable", "await tx.payment.update({ where, data: { settledByTransactionId: txId } });", 1],
    ["a shorthand write", "const settledByTransactionId = txId; await tx.payment.update({ where, data: { settledByTransactionId } });", 1],
    ["an upsert's create", "await tx.payment.upsert({ where: { id }, create: { bookingId, settledByTransactionId: x }, update: {} });", 1],
    ["raw SQL", 'await tx.$executeRaw`UPDATE "Payment" SET "settledByTransactionId" = NULL`;', 1],
    ["a select flag", "await tx.payment.findUnique({ where: { id }, select: { settledByTransactionId: true } });", 0],
    ["a where filter", "await tx.payment.findFirst({ where: { settledByTransactionId: id } });", 0],
    ["a shorthand where filter", "const settledByTransactionId = id; await tx.payment.findFirst({ where: { settledByTransactionId } });", 0],
    ["a nested where filter", "await tx.booking.findFirst({ where: { payment: { settledByTransactionId: { not: null } } } });", 0],
    ["a type", "type P = { settledByTransactionId: string | null; other?: string };", 0],
    ["a property read", "const id = payment.settledByTransactionId; const ok = id === payment?.settledByTransactionId;", 0],
    ["a write in a closure under select", "await tx.payment.findMany({ select: { id: true, after: () => tx.payment.update({ where: { id }, data: { settledByTransactionId: x } }) } });", 1],
    ["an object built elsewhere and passed whole", "const data = { settledByTransactionId: txId }; await tx.payment.update({ where: { id }, data });", 1],
    ["raw SQL split across literals", 'await tx.$executeRawUnsafe(\'UPDATE "Payment" SET \' + \'"settledByTransactionId" = NULL WHERE id = $1\', id);', 1],
    ["a raw SQL read naming it", 'await tx.$queryRaw`SELECT "settledByTransactionId" FROM "Payment"`;', 1],
    ["a property assignment", "const data: Record<string, unknown> = {}; data.settledByTransactionId = txId; await tx.payment.update({ where: { id }, data });", 1],
    ["an element assignment", 'const data: Record<string, unknown> = {}; data["settledByTransactionId"] = txId; await tx.payment.update({ where: { id }, data });', 1],
    // Twice: the fragment's literal, and the fragment where the raw call uses it.
    ["a Prisma.sql fragment", 'const fragment = Prisma.sql`"settledByTransactionId" = ${txId}`; await tx.$executeRaw`UPDATE "Payment" SET ${fragment}`;', 2],
    ["a bare sql tag", 'const fragment = sql`"settledByTransactionId" = NULL`;', 1],
    ["a module constant used in $executeRawUnsafe", 'const COLUMN_SQL = \'"settledByTransactionId"\'; await tx.$executeRawUnsafe(`UPDATE "Payment" SET ${COLUMN_SQL} = NULL`);', 1],
    ["a filter built outside the call (conservative: flagged)", "const where = { settledByTransactionId: id }; await tx.payment.findFirst({ where });", 1],
  ])("discriminates %s", (_label, snippet, expected) => {
    expect(settledByWrites("planted.ts", snippet)).toHaveLength(expected);
  });
});
