import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { blankLiterals } from "./support/strip-comments";

// Checks inspect locks rather than relying on caller-held locks themselves.
const INSPECTORS = new Map([
  ["src/lib/global-lock-held.ts", "assertGlobalLockHeld"],
  ["src/lib/lodge-capacity-lock.ts", "assertLodgeCapacityLockHeld"],
]);

function violations(file: string, source: string): string[] {
  const masked = blankLiterals(source);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  const check = (name: string, body: ts.ConciseBody | undefined) => {
    if (!/Locks?Held$/.test(name) || INSPECTORS.get(file) === name) return;
    const fail = () => failures.push(`${file}: ${name} must begin with its required lock checks (INV-LOCK-003)`);
    if (!body || !ts.isBlock(body)) return fail();
    const statements = [...body.statements];
    const text = (n: ts.Node | undefined) => n ? masked.slice(n.getStart(ast), n.end) : "";
    const global = /^await assertGlobalLockHeld\(/;
    const lodge = /await assertLodgeCapacityLockHeld\(/;
    // Merge deliberately takes the lodge tier alone (#2595).
    if (name !== "sweepUnbackedFutureSharedDoublesWithLocksHeld") {
      if (!global.test(text(statements.shift()))) return fail();
    }
    if (/WithGlobalLockHeld$/.test(name)) return;
    let first = statements.shift();
    // Only a key-discovery projection is permitted before the lodge check.
    if (first && ts.isVariableStatement(first)) {
      const discovery = text(first);
      const keyOnly = /select:\s*\{\s*(?:lodgeId:\s*true|id:\s*true|room:\s*\{\s*select:\s*\{\s*lodgeId:\s*true\s*\}\s*\})\s*\}/;
      if (!keyOnly.test(discovery) && !/await futurePartnerShareAllocationLodgeIds\(/.test(discovery)) return fail();
      first = statements.shift();
    }
    if (!first || (!ts.isIfStatement(first) && !ts.isForOfStatement(first))) return fail();
    const checked = ts.isIfStatement(first) ? first.thenStatement : first.statement;
    // No hidden callback or conditional can stand in for the actual check.
    const checkStatement = ts.isBlock(checked) ? checked.statements[0] : checked;
    if (!lodge.test(text(checkStatement).trimStart())) fail();
  };
  for (const node of ast.statements) {
    if (!ts.canHaveModifiers(node) || !ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(node) && node.name) check(node.name.text, node.body);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const value = declaration.initializer;
          check(declaration.name.text, value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? value.body : undefined);
        }
      }
    }
  }
  return failures;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return ["__tests__", "node_modules"].includes(entry.name) ? [] : sources(file);
    return /\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec)\./.test(file) ? [file] : [];
  });
}

describe("caller-held lock export census", () => {
  it("checks every non-test export, including newly added modules", () => {
    const failures = sources("src").flatMap((file) => violations(file.split(path.sep).join("/"), fs.readFileSync(file, "utf8")));
    expect(failures).toEqual([]);
  });
  it.each([
    "export async function writerWithLocksHeld() { await read(); }",
    "export const writerWithLocksHeld = async () => { await read(); };",
    "export async function writerWithLocksHeld() { /* await assertGlobalLockHeld(tx, 'x'); */ await read(); }",
    "export async function writerWithLocksHeld() { await read(); await assertGlobalLockHeld(tx, 'x'); }",
    "export async function writerWithLocksHeld() { await assertGlobalLockHeld(tx, 'x'); if (key) { await read(); await assertLodgeCapacityLockHeld(tx, key, 'x'); } }",
    "export async function writerWithLocksHeld() { await assertGlobalLockHeld(tx, 'x'); const key = await db.booking.findUnique({select:{status:true}}); if (key) await assertLodgeCapacityLockHeld(tx, key, 'x'); }",
  ])("rejects missing, late or conditional checks: %s", (source) => {
    expect(violations("fixture.ts", source)).toHaveLength(1);
  });
  it("ignores names in comments and literals", () => {
    expect(violations("fixture.ts", '// export async function fakeWithLocksHeld() {}\nconst example = "export function fakeWithLocksHeld() {}";')).toEqual([]);
  });
});
