import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  No admin screen parses a FAILED response as JSON without a catch (#4976,
  ALP-529, ALP-581, ALP-589).

  A refusal is not always JSON. The web server in front of the app answers a
  crashed or unreachable route with an HTML error page, so a handler that runs
  `await res.json()` on a failed response throws "Unexpected token < in JSON"
  — which the officer then reads as the reason their save was refused, or
  never sees at all when the rejection goes unhandled. A failed response is
  read through `apiErrorMessageFromResponse` (or `readApiErrorBody` when the
  caller also needs the `code`) in `src/lib/api-error-message.ts`, which falls
  back to the screen's own sentence on a body that is not JSON.

  Two shapes are counted, over the TypeScript AST rather than file text so a
  comment quoting the old shape is never a hit:

   - a FAILURE-BRANCH read: `await x.json()` inside `if (!x.ok) { … }`, in
     the `else` of `if (x.ok) { … }`, or as the `x.ok ? … : read` arm;
   - a PARSE-BEFORE-CHECK read: `const data = await x.json()` followed, in the
     same block, by a test of `x.ok` — the body is parsed before anyone knows
     whether it is a refusal, so every refusal goes through the unguarded parse.

  `await x.json().catch(…)` is not counted: its rejection is already handled.
  A success read (`if (!x.ok) throw …; const data = await x.json()`, or one
  inside `if (x.ok)` or `x.ok ? read : …`) is not counted either: a route that answered 2xx with HTML is a different defect.

  KNOWN_UNGUARDED is a CEILING per file, not a pin. Those files are being
  edited by other lanes that had not merged when this census landed (their own
  fixes may remove reads); converging one is always green here, and adding a
  read to any file — listed or not — is red. Lower or delete an entry when you
  converge its reads.

  This test reads the source tree from disk, so `pnpm run test:related` cannot
  reach it. Run it by name.
*/

const SCANNED_DIR = join(process.cwd(), "src", "app", "(admin)");

/**
 * Files whose unguarded failure reads were left to the lane already editing
 * them, with the most reads each may still hold. Every entry is a ceiling: a
 * lower count passes, a higher one fails.
 */
const SIBLING_LANE =
  "Edited by a sibling lane (ALP-529, ALP-570, ALP-576, ALP-577, ALP-578 or ALP-581) not yet merged; converted after it lands.";

const KNOWN_UNGUARDED: Record<string, { reads: number; reason: string }> = {
  "src/app/(admin)/admin/booking-desk/book/page.tsx": { reads: 1, reason: SIBLING_LANE },
  "src/app/(admin)/admin/chores/page.tsx": { reads: 3, reason: SIBLING_LANE },
  "src/app/(admin)/admin/family-groups/page.tsx": { reads: 1, reason: SIBLING_LANE },
  "src/app/(admin)/admin/lockers/page.tsx": { reads: 3, reason: SIBLING_LANE },
  "src/app/(admin)/admin/members/[id]/_components/member-lodge-access-card.tsx": { reads: 2, reason: SIBLING_LANE },
  "src/app/(admin)/admin/rules/age-tier-settings/page.tsx": { reads: 1, reason: SIBLING_LANE },
  "src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx": { reads: 3, reason: SIBLING_LANE },
  "src/app/(admin)/admin/rules/seasons/page.tsx": { reads: 3, reason: SIBLING_LANE },
  "src/app/(admin)/admin/website/mountain-conditions/_components/mountain-conditions-panel.tsx": { reads: 7, reason: SIBLING_LANE },
  "src/app/(admin)/admin/work-parties/page.tsx": { reads: 5, reason: SIBLING_LANE },
};

type Hit = { line: number; kind: "failure-branch" | "parse-before-check" };

/** `x` when `node` is `x.ok`. */
function okReceiver(node: ts.Node): string | null {
  return ts.isPropertyAccessExpression(node) &&
    node.name.text === "ok" &&
    ts.isIdentifier(node.expression)
    ? node.expression.text
    : null;
}

/** True when `condition` is (or contains, joined by `&&`/`||`) a "not ok" test on `name`. */
function testsNotOk(condition: ts.Expression, name: string): boolean {
  const expr = skipParens(condition);
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.ExclamationToken &&
    okReceiver(skipParens(expr.operand)) === name
  ) {
    return true;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      return testsNotOk(expr.left, name) || testsNotOk(expr.right, name);
    }
    if (
      (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) &&
      okReceiver(skipParens(expr.left)) === name &&
      expr.right.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return true;
    }
  }
  return false;
}

/** True when `condition` is `name.ok`, alone or as a conjunct. */
function testsOk(condition: ts.Expression, name: string): boolean {
  const expr = skipParens(condition);
  if (okReceiver(expr) === name) return true;
  return (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    (testsOk(expr.left, name) || testsOk(expr.right, name))
  );
}

function skipParens(expr: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expr) ? skipParens(expr.expression) : expr;
}

/**
 * An earlier `if (!x.ok) …` (alone or as one side of `||`) that every refusal
 * enters, so a later read only ever sees a success. `if (!x.ok && x.status ===
 * 403)` is NOT one: the other refusals fall through to the read.
 */
function guardsEveryFailure(statement: ts.Statement | ts.Expression, name: string): boolean {
  if (!ts.isIfStatement(statement) && !ts.isExpression(statement)) return false;
  const condition = ts.isIfStatement(statement) ? statement.expression : statement;
  const disjuncts = (expr: ts.Expression): ts.Expression[] => {
    const e = skipParens(expr);
    return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken
      ? [...disjuncts(e.left), ...disjuncts(e.right)]
      : [e];
  };
  return disjuncts(condition).some(
    (e) =>
      ts.isPrefixUnaryExpression(e) &&
      e.operator === ts.SyntaxKind.ExclamationToken &&
      okReceiver(skipParens(e.operand)) === name,
  );
}

function mentionsOk(node: ts.Node, name: string): boolean {
  if (okReceiver(node) === name) return true;
  return ts.forEachChild(node, (child) => (mentionsOk(child, name) ? true : undefined)) ?? false;
}

/** `x` when `node` is `await x.json()` with nothing chained after the call. */
function unguardedJsonReceiver(node: ts.Node): string | null {
  if (!ts.isAwaitExpression(node)) return null;
  const call = skipParens(node.expression);
  if (!ts.isCallExpression(call) || call.arguments.length > 0) return null;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "json") return null;
  return ts.isIdentifier(callee.expression) ? callee.expression.text : null;
}

/**
 * Which side of an `x.ok` test the read sits on, from the nearest enclosing
 * `if` or `?:` that tests it: "failure" for `if (!x.ok) { read }`,
 * `if (x.ok) {} else { read }` and `x.ok ? … : read`; "success" for the
 * mirror images; `null` when no enclosing test decides it.
 */
function branchOf(read: ts.Node, name: string): "failure" | "success" | null {
  let child: ts.Node = read;
  for (let parent = read.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return null;
    const [condition, whenTrue, whenFalse] = ts.isIfStatement(parent)
      ? [parent.expression, parent.thenStatement, parent.elseStatement]
      : ts.isConditionalExpression(parent)
        ? [parent.condition, parent.whenTrue, parent.whenFalse]
        : [null, null, null];
    if (!condition) continue;
    if (child === whenTrue && testsNotOk(condition, name)) return "failure";
    if (child === whenFalse && testsOk(condition, name)) return "failure";
    if (child === whenTrue && testsOk(condition, name)) return "success";
    if (child === whenFalse && guardsEveryFailure(condition, name)) return "success";
  }
  return null;
}

function parsedBeforeCheck(read: ts.Node, name: string): boolean {
  let statement: ts.Node = read;
  while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) {
    if (ts.isFunctionLike(statement.parent)) return false;
    statement = statement.parent;
  }
  const block = statement.parent;
  if (!block || !(ts.isBlock(block) || ts.isSourceFile(block))) return false;
  const siblings = block.statements as ts.NodeArray<ts.Statement>;
  const index = siblings.indexOf(statement as ts.Statement);
  if (siblings.slice(0, index).some((s) => guardsEveryFailure(s, name))) return false;
  return siblings.slice(index + 1).some((s) => mentionsOk(s, name));
}

function unguardedFailureReads(source: string, fileName = "scan.tsx"): Hit[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    const name = unguardedJsonReceiver(node);
    if (name) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      const branch = branchOf(node, name);
      if (branch === "failure") hits.push({ line, kind: "failure-branch" });
      else if (branch === null && parsedBeforeCheck(node, name)) hits.push({ line, kind: "parse-before-check" });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") walk(full, files);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const measured = walk(SCANNED_DIR)
  .map((file) => ({
    rel: relative(process.cwd(), file).split(sep).join("/"),
    hits: unguardedFailureReads(readFileSync(file, "utf8"), file),
  }))
  .filter(({ hits }) => hits.length > 0);

describe("admin failed-response JSON reads (#4976, ALP-589)", () => {
  /**
   * A source-scanning guard's real failure mode is passing vacuously: the
   * matcher stops recognising the shape and every assertion below goes green
   * over nothing. Pin it on every written form first.
   */
  it("counts a parse inside a failure branch and a parse before the check", () => {
    const source = [
      "async function a(res: Response) {",
      "  if (!res.ok) {",
      "    const data = await res.json();",
      "    throw new Error(data.error);",
      "  }",
      "}",
      "async function b(res: Response) {",
      "  if (res.status === 403) return;",
      "  const data = await res.json();",
      "  if (!res.ok) return data.error;",
      "}",
      "async function c(response: Response) {",
      "  if (response.ok) {",
      "    return 1;",
      "  } else {",
      "    const err = await response.json();",
      "  }",
      "}",
      "async function d(res: Response) {",
      "  const data = (await res.json()) as { ok?: boolean };",
      "  if (res.ok && data.ok) return data;",
      "}",
      "async function f(res: Response) {",
      "  if (!res.ok && res.status === 403) return;",
      "  const data = await res.json();",
      "  if (!res.ok) return data.error;",
      "}",
      "async function e(res: Response) {",
      "  if (!res.ok || res.status === 207) {",
      "    if (res.status === 403) return;",
      "    const body = await res.json();",
      "  }",
      "}",
      "async function g(res: Response) {",
      "  const data = res.ok ? null : await res.json();",
      "}",
    ].join("\n");
    expect(unguardedFailureReads(source)).toEqual([
      { line: 3, kind: "failure-branch" },
      { line: 9, kind: "parse-before-check" },
      { line: 16, kind: "failure-branch" },
      { line: 20, kind: "parse-before-check" },
      { line: 25, kind: "parse-before-check" },
      { line: 31, kind: "failure-branch" },
      { line: 35, kind: "failure-branch" },
    ]);
  });

  it("does not count a guarded read or a success read", () => {
    const source = [
      "async function a(res: Response) {",
      "  if (!res.ok) {",
      "    const data = await res.json().catch(() => null);",
      "    throw new Error(String(data));",
      "  }",
      "  const ok = await res.json();",
      "  return ok;",
      "}",
      "async function b(res: Response) {",
      "  if (!res.ok) throw new Error('x');",
      "  const data = await res.json();",
      "  if (data.ok) return data;",
      "}",
      "async function c(res: Response) {",
      "  if (res.ok) {",
      "    const data = await res.json();",
      "    return data;",
      "  }",
      "}",
      "async function d(res: Response) {",
      "  if (!res.ok) {",
      "    const later = async () => { const x = await other.json(); };",
      "  }",
      "}",
      "async function e(res: Response) {",
      "  const data = res.ok ? await res.json() : await res.json().catch(() => null);",
      "  if (res.ok && data.success) return data;",
      "}",
      "async function f(res: Response) {",
      "  if (res.ok) {",
      "    const data = await res.json();",
      "    if (data.success) return data;",
      "  }",
      "  if (!res.ok) return null;",
      "}",
      "// if (!res.ok) { const data = await res.json(); }",
    ].join("\n");
    expect(unguardedFailureReads(source)).toEqual([]);
  });

  it("lists only files that still exist", () => {
    const missing = Object.keys(KNOWN_UNGUARDED).filter((rel) => !existsSync(join(process.cwd(), rel)));
    expect(missing, "delete the KNOWN_UNGUARDED entry of a moved or deleted file").toEqual([]);
  });

  it("finds no unguarded failure read outside the known ceilings", () => {
    const over = measured
      .filter(({ rel, hits }) => hits.length > (KNOWN_UNGUARDED[rel]?.reads ?? 0))
      .map(({ rel, hits }) => `${rel}: ${hits.map((h) => `${h.line} (${h.kind})`).join(", ")}`);
    expect(
      over,
      "read a failed response through apiErrorMessageFromResponse (or " +
        "readApiErrorBody) from src/lib/api-error-message.ts, never a bare " +
        "`await res.json()`: an HTML error page from the proxy throws a JSON " +
        "parse error the officer then reads as the refusal",
    ).toEqual([]);
  });
});
