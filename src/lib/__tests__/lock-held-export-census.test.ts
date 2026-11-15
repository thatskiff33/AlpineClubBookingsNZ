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

// The only helpers trusted to read nothing but a lodge key (INV-LOCK-003).
const KEY_RESOLVERS = new Set(["futurePartnerShareAllocationLodgeIds", "resolveBedLodgeIdForLock"]);
const KEY_FINDERS = new Set(["findUnique", "findFirst", "findMany"]);
// A select that returns the lodge key and nothing else.
const KEY_ONLY_SELECT = /^\{\s*(?:lodgeId:\s*true|room:\s*\{\s*select:\s*\{\s*lodgeId:\s*true\s*\}\s*\})\s*,?\s*\}$/;

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
}

/** The identifier a property chain such as `bedKey?.room.lodgeId` hangs from. */
function rootOf(node: ts.Expression): string | undefined {
  let current = node;
  while (ts.isPropertyAccessExpression(current) || ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function awaitsIn(node: ts.Node): ts.AwaitExpression[] {
  const found: ts.AwaitExpression[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isAwaitExpression(child)) found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function violations(file: string, source: string, checked: string[] = []): string[] {
  const masked = blankLiterals(source);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  const text = (n: ts.Node | undefined) => (n ? masked.slice(n.getStart(ast), n.end) : "");

  // One awaited key lookup: a named resolver, or a find with a key-only select.
  const keyDiscovery = (statement: ts.VariableStatement): string | undefined => {
    const [declaration, ...rest] = statement.declarationList.declarations;
    if (!declaration || rest.length > 0 || !ts.isIdentifier(declaration.name) || !declaration.initializer) return undefined;
    const awaits = awaitsIn(declaration.initializer);
    if (awaits.length !== 1 || !ts.isCallExpression(awaits[0]!.expression)) return undefined;
    const call = awaits[0]!.expression;
    if (ts.isIdentifier(call.expression)) {
      return KEY_RESOLVERS.has(call.expression.text) ? declaration.name.text : undefined;
    }
    if (!ts.isPropertyAccessExpression(call.expression) || !KEY_FINDERS.has(call.expression.name.text)) return undefined;
    const [args, ...extra] = call.arguments;
    if (!args || extra.length > 0 || !ts.isObjectLiteralExpression(args)) return undefined;
    let keyOnly = false;
    for (const property of args.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return undefined;
      if (property.name.text === "select") keyOnly = KEY_ONLY_SELECT.test(text(property.initializer));
      else if (property.name.text !== "where") return undefined;
    }
    return keyOnly ? declaration.name.text : undefined;
  };

  // `await assertLodgeCapacityLockHeld(db, <key rooted in an allowed name>, …)`.
  const isLodgeCheck = (statement: ts.Statement | undefined, keyRoots: ReadonlySet<string>) => {
    if (!statement || !ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return false;
    const call = statement.expression.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "assertLodgeCapacityLockHeld") return false;
    const key = call.arguments[1];
    const root = key && rootOf(key);
    return root !== undefined && keyRoots.has(root);
  };
  const onlyStatement = (body: ts.Statement) => (ts.isBlock(body) ? (body.statements.length === 1 ? body.statements[0] : undefined) : body);

  const check = (name: string, fn: FunctionLike | undefined) => {
    if (!/Locks?Held$/.test(name) || INSPECTORS.get(file) === name) return;
    checked.push(name);
    const fail = () => failures.push(`${file}: ${name} must begin with its required lock checks (INV-LOCK-003)`);
    const body = fn?.body;
    if (!fn || !body || !ts.isBlock(body)) return fail();
    const params = new Set(fn.parameters.flatMap((parameter) => bindingNames(parameter.name)));
    const statements = [...body.statements];
    // Merge deliberately takes the lodge tier alone (#2595).
    if (name !== "sweepUnbackedFutureSharedDoublesWithLocksHeld") {
      if (!/^await assertGlobalLockHeld\(/.test(text(statements.shift()))) return fail();
    }
    if (/WithGlobalLockHeld$/.test(name)) return;

    let first = statements.shift();
    let discovered: string | undefined;
    // Only a key-discovery projection is permitted before the lodge check.
    if (first && ts.isVariableStatement(first)) {
      discovered = keyDiscovery(first);
      if (!discovered) return fail();
      first = statements.shift();
    }
    const keySources = new Set(discovered ? [discovered] : params);
    if (!first) return fail();
    // An unconditional check is the strongest form.
    if (isLodgeCheck(first, new Set([...params, ...keySources]))) return;
    // `if (key)` may only skip the check for a lookup that found no row.
    if (ts.isIfStatement(first)) {
      const guarded = discovered !== undefined && !first.elseStatement && rootOf(first.expression) === discovered;
      if (!guarded || !isLodgeCheck(onlyStatement(first.thenStatement), keySources)) fail();
      return;
    }
    // `for (const id of key)` must walk the discovered or supplied keys.
    if (ts.isForOfStatement(first) && ts.isVariableDeclarationList(first.initializer)) {
      const [loopVariable] = first.initializer.declarations;
      let iterable = first.expression;
      if (ts.isNewExpression(iterable) && ts.isIdentifier(iterable.expression) && iterable.expression.text === "Set" && iterable.arguments?.length === 1) {
        iterable = iterable.arguments[0]!;
      }
      const iterableRoot = rootOf(iterable);
      const walksKeys = iterableRoot !== undefined && keySources.has(iterableRoot) && loopVariable && ts.isIdentifier(loopVariable.name);
      if (!walksKeys || !isLodgeCheck(onlyStatement(first.statement), new Set([(loopVariable.name as ts.Identifier).text]))) fail();
      return;
    }
    fail();
  };

  for (const node of ast.statements) {
    if (!ts.canHaveModifiers(node) || !ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(node) && node.name) check(node.name.text, node);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const value = declaration.initializer;
          check(declaration.name.text, value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? value : undefined);
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

const GLOBAL = "await assertGlobalLockHeld(input.db, 'x');";

describe("caller-held lock export census", () => {
  // Parses every source file; under shard load that outlasts vitest's 5s default.
  it("checks every non-test export, including newly added modules", { timeout: 90_000 }, () => {
    const checked: string[] = [];
    const failures = sources("src").flatMap((file) => violations(file.split(path.sep).join("/"), fs.readFileSync(file, "utf8"), checked));
    expect(failures).toEqual([]);
    // The census pins each check's shape; the refusal test pins the lodge it
    // checks, so every checked export must have a row there too.
    const refusal = fs.readFileSync("src/lib/__tests__/lock-held-writer-refusal.test.ts", "utf8");
    const rows = new Set([...refusal.matchAll(/^\s*name: "(\w+)/gm)].map((match) => match[1]));
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.filter((name) => !rows.has(name)), "add each to lock-held-writer-refusal.test.ts").toEqual([]);
  });
  it.each([
    "export async function writerWithLocksHeld() { await read(); }",
    "export const writerWithLocksHeld = async () => { await read(); };",
    "export async function writerWithLocksHeld() { /* await assertGlobalLockHeld(tx, 'x'); */ await read(); }",
    "export async function writerWithLocksHeld() { await read(); await assertGlobalLockHeld(tx, 'x'); }",
    `export async function writerWithLocksHeld(input) { ${GLOBAL} if (key) { await read(); await assertLodgeCapacityLockHeld(input.db, key, 'x'); } }`,
    `export async function writerWithLocksHeld(input) { ${GLOBAL} const key = await input.db.booking.findUnique({ where: { id: input.id }, select: { status: true } }); if (key) await assertLodgeCapacityLockHeld(input.db, key.lodgeId, 'x'); }`,
    // A condition that is not the discovered key can switch the check off.
    `export async function writerWithLocksHeld(input) { ${GLOBAL} const key = await input.db.lodgeRoom.findUnique({ where: { id: input.id }, select: { lodgeId: true } }); if (input.skipLockCheck) await assertLodgeCapacityLockHeld(input.db, key.lodgeId, 'x'); }`,
    `export async function writerWithLocksHeld(input) { ${GLOBAL} if (input.lodgeId) await assertLodgeCapacityLockHeld(input.db, input.lodgeId, 'x'); }`,
    `export async function writerWithLocksHeld(input) { ${GLOBAL} const key = await input.db.lodgeRoom.findUnique({ where: { id: input.id }, select: { lodgeId: true } }); if (key) await assertLodgeCapacityLockHeld(input.db, key.lodgeId, 'x'); else await read(); }`,
    // A loop over anything but the discovered or supplied keys checks nothing.
    `export async function writerWithLocksHeld(input) { ${GLOBAL} for (const id of []) await assertLodgeCapacityLockHeld(input.db, id, 'x'); }`,
    `export async function writerWithLocksHeld(input) { ${GLOBAL} const ids = await resolveBedLodgeIdForLock(input.bedId, input.db); for (const id of ids) await assertLodgeCapacityLockHeld(input.db, input.lodgeId, 'x'); }`,
    // Discovery must be one key-only read, not a read of mutable rows beside it.
    `export async function writerWithLocksHeld(input) { ${GLOBAL} const [key, rows] = await Promise.all([input.db.lodgeRoom.findUnique({ select: { lodgeId: true } }), input.db.bedAllocation.findMany({ where: {} })]); if (key) await assertLodgeCapacityLockHeld(input.db, key.lodgeId, 'x'); }`,
    `export async function writerWithLocksHeld(input) { ${GLOBAL} const key = await input.db.lodgeRoom.findUnique({ where: { id: input.id }, select: { lodgeId: true }, include: { beds: true } }); if (key) await assertLodgeCapacityLockHeld(input.db, key.lodgeId, 'x'); }`,
    `export async function writerWithLocksHeld(input) { ${GLOBAL} const key = await input.db.lodgeRoom.findUnique({ where: { id: input.id }, select: { lodgeId: true, beds: true } }); if (key) await assertLodgeCapacityLockHeld(input.db, key.lodgeId, 'x'); }`,
    `export async function writerWithLocksHeld(input) { ${GLOBAL} const key = await loadRoomAndBeds(input.id); if (key) await assertLodgeCapacityLockHeld(input.db, key.lodgeId, 'x'); }`,
    // The discovered key, not a caller-supplied one, is what must be checked.
    `export async function writerWithLocksHeld(input) { ${GLOBAL} const key = await input.db.lodgeRoom.findUnique({ where: { id: input.id }, select: { lodgeId: true } }); if (key) await assertLodgeCapacityLockHeld(input.db, input.lodgeId, 'x'); }`,
  ])("rejects missing, late, conditional or mis-keyed checks: %s", (source) => {
    expect(violations("fixture.ts", source)).toHaveLength(1);
  });
  it.each([
    `export async function writerWithLocksHeld(input) { ${GLOBAL} await assertLodgeCapacityLockHeld(input.db, input.lodgeId, 'x'); await read(); }`,
    `export async function writerWithLocksHeld(input) { ${GLOBAL} const key = await input.db.lodgeRoom.findUnique({ where: { id: input.id }, select: { lodgeId: true } }); if (key) await assertLodgeCapacityLockHeld(input.db, key.lodgeId, 'x'); await read(); }`,
    `export async function writerWithLocksHeld(input) { ${GLOBAL} const ids = (await input.db.bedAllocation.findMany({ where: {}, select: { room: { select: { lodgeId: true } } } })).map((a) => a.room.lodgeId); for (const id of new Set(ids)) { await assertLodgeCapacityLockHeld(input.db, id, 'x'); } }`,
    "export async function sweepUnbackedFutureSharedDoublesWithLocksHeld(params) { for (const id of params.lockedLodgeIds) await assertLodgeCapacityLockHeld(params.db, id, 'x'); }",
    `export async function writerWithGlobalLockHeld(input) { ${GLOBAL} await read(); }`,
  ])("accepts the permitted check shapes: %s", (source) => {
    expect(violations("fixture.ts", source)).toEqual([]);
  });
  it("ignores names in comments and literals", () => {
    expect(violations("fixture.ts", '// export async function fakeWithLocksHeld() {}\nconst example = "export function fakeWithLocksHeld() {}";')).toEqual([]);
  });
});
