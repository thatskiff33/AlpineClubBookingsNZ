import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Discover Member write payloads, following local aliases, spreads, conditional
// branches and property assignments. A new writer fails by identity instead of
// silently replacing another writer in a count. Read/select/where false values,
// comments and XeroObjectLink.active are deliberately outside this population.
function visit(root: ts.Node, fn: (node: ts.Node) => void): void {
  fn(root);
  ts.forEachChild(root, (node) => visit(node, fn));
}

function key(node: ts.PropertyName): string {
  if (ts.isComputedPropertyName(node)) return node.expression.getText().replace(/["']/g, "");
  return node.getText().replace(/["']/g, "");
}

function scopeOf(node: ts.Node): ts.Node {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current ?? node.getSourceFile();
}

type Fields = { active: ts.Expression[]; cancelledAt: ts.Expression[]; leavingDate: ts.Expression[]; opaque: string[] };
function hasDepartureStamp(fields: Fields): boolean {
  // A reactivation's clearing write is not evidence that deactivation stamps
  // a day, even when both branches share the same mutable payload variable.
  return fields.leavingDate.some((value) => value.kind !== ts.SyntaxKind.NullKeyword && value.getText() !== "undefined");
}
function payloadFields(expression: ts.Expression, seen = new Set<ts.Node>()): Fields {
  const result: Fields = { active: [], cancelledAt: [], leavingDate: [], opaque: [] };
  const merge = (other: Fields) => {
    for (const field of ["active", "cancelledAt", "leavingDate"] as const) result[field].push(...other[field]);
    result.opaque.push(...other.opaque);
  };
  if (seen.has(expression)) return result;
  seen.add(expression);
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return payloadFields(expression.expression, seen);
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) return result;
  if (ts.isConditionalExpression(expression)) {
    merge(payloadFields(expression.whenTrue, seen));
    merge(payloadFields(expression.whenFalse, seen));
  } else if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) merge(payloadFields(property.expression, seen));
      else if (ts.isPropertyAssignment(property)) {
        const name = key(property.name);
        if (name === "active" || name === "cancelledAt" || name === "leavingDate") result[name].push(property.initializer);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const name = property.name.text;
        // A computed lifecycle value may deactivate; classify it conservatively
        // just like `active: enabled`, rather than hiding the writer entirely.
        if (name === "active" || name === "cancelledAt" || name === "leavingDate") result[name].push(property.name);
      }
    }
  } else if (ts.isIdentifier(expression)) {
    // Resolve the nearest lexical binding. Then follow every assignment of that
    // payload in its containing function, including switch branches and later
    // payload.active = data.active updates.
    let binding: ts.VariableDeclaration | undefined;
    for (let scope: ts.Node | undefined = expression.parent; scope && !binding; scope = scope.parent) {
      for (const statement of ts.isBlock(scope) || ts.isSourceFile(scope) ? scope.statements : []) {
        if (!ts.isVariableStatement(statement)) continue;
        binding = statement.declarationList.declarations.find((d) => d.name.getText() === expression.text);
        if (binding) break;
      }
    }
    if (binding?.initializer) merge(payloadFields(binding.initializer, seen));
    if (!binding) result.opaque.push(expression.getText());
    const owner = binding ? scopeOf(binding) : scopeOf(expression);
    visit(owner, (node) => {
      if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
      if (ts.isIdentifier(node.left) && node.left.text === expression.text) merge(payloadFields(node.right, seen));
      if (ts.isPropertyAccessExpression(node.left) && node.left.expression.getText() === expression.text) {
        const name = node.left.name.text;
        if (name === "active" || name === "cancelledAt" || name === "leavingDate") result[name].push(node.right);
      }
      if (ts.isElementAccessExpression(node.left) && node.left.expression.getText() === expression.text) {
        const name = node.left.argumentExpression.getText().replace(/["']/g, "");
        if (name === "active" || name === "cancelledAt" || name === "leavingDate") result[name].push(node.right);
      }
    });
  } else {
    result.opaque.push(ts.isCallExpression(expression) ? `${expression.expression.getText()}()` : expression.getText());
  }
  return result;
}

function writerIdentity(call: ts.CallExpression, source: ts.SourceFile): string {
  let node: ts.Node | undefined = call.parent;
  while (node) {
    if (ts.isFunctionDeclaration(node) && node.name && !["POST", "PUT", "PATCH"].includes(node.name.text)) return node.name.text;
    node = node.parent;
  }
  return relative(process.cwd(), source.fileName).replaceAll("\\", "/");
}

function writers(source: ts.SourceFile) {
  const found: Array<{ identity: string; fields: Fields }> = [];
  visit(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression.name.text;
    const delegate = node.expression.expression;
    if (!["update", "updateMany", "create", "createMany", "upsert"].includes(method) ||
      !ts.isPropertyAccessExpression(delegate) || delegate.name.text !== "member") return;
    const args = node.arguments[0];
    if (!args || !ts.isObjectLiteralExpression(args)) throw new Error("Unclassified Member write arguments");
    for (const property of args.properties) {
      if (!ts.isPropertyAssignment(property) || !["data", "create", "update"].includes(key(property.name))) continue;
      const fields = payloadFields(property.initializer);
      const deactivates = fields.active.some((value) => value.kind !== ts.SyntaxKind.TrueKeyword);
      const cancels = fields.cancelledAt.some((value) => value.kind !== ts.SyntaxKind.NullKeyword);
      if (deactivates || cancels || fields.opaque.length) found.push({ identity: writerIdentity(node, source), fields });
    }
  });
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? entry.name === "__tests__" ? [] : sourceFiles(path)
      : /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [path] : [];
  });
}

function parse(source: string, name = "fixture.ts"): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

// Non-lifecycle payload fragments whose implementations were reviewed. New
// computed fragments fail until classified here; otherwise a helper/spread
// could hide a deactivation from the closed-world population above.
const OPAQUE_PAYLOADS = {
  "anonymiseFormerMember: MEMBER_CONTACT_ERASURE_PATCH": "erases scalar contact details only",
  "src/app/api/admin/deletion-requests/[id]/route.ts: MEMBER_CONTACT_ERASURE_PATCH": "erases scalar contact details only",
  "anonymiseFormerMember: DIETARY_ERASURE_PATCH": "erases dietary text only; the member is already inactive",
  "createAdminMember: buildDietaryRequirementsPatch()": "single dietary column patch",
  "executeMemberMerge: fieldOutcome.patch": "explicit scalar allowlist excludes lifecycle fields; mergeMemberFields regression test",
  "src/app/api/admin/deletion-requests/[id]/route.ts: DIETARY_ERASURE_PATCH": "erases dietary text only",
};

const WRITERS = [
  "createAdminMember",
  "updateAdminMember",
  "reviewMemberArchiveRequest",
  "reviewMembershipCancellationParticipant",
  "src/app/api/admin/deletion-requests/[id]/route.ts",
  "src/app/api/admin/members/bulk-update/route.ts",
  "src/app/api/admin/members/import/route.ts",
].sort();

describe("Member deactivation writers record the departure in the same write (#4457)", () => {
  it("discovers exactly the reviewed lifecycle writers, each with leavingDate", () => {
    const found = ["src", "scripts"].flatMap((root) => sourceFiles(join(process.cwd(), root)))
      .flatMap((file) => writers(parse(readFileSync(file, "utf8"), file)));
    const lifecycle = found.filter(({ fields }) => fields.active.some((value) => value.kind !== ts.SyntaxKind.TrueKeyword) || fields.cancelledAt.some((value) => value.kind !== ts.SyntaxKind.NullKeyword));
    expect(lifecycle.map((writer) => writer.identity).sort()).toEqual(WRITERS);
    for (const writer of lifecycle) expect(hasDepartureStamp(writer.fields), writer.identity).toBe(true);
    expect([...new Set(found.flatMap(({ identity, fields }) => fields.opaque.map((expression) => `${identity}: ${expression}`)))].sort())
      .toEqual(Object.keys(OPAQUE_PAYLOADS).sort());
  });

  it.each([
    "tx.member.update({ where: { id }, data: { active: false } });",
    "const active = false; tx.member.update({ data: { active } });",
    "const cancelledAt = day; tx.member.update({ data: { cancelledAt } });",
    "const alias = { active: enabled }; const payload = { ...alias }; tx.member.updateMany({ data: payload });",
    "let patch = {}; patch.active = false; tx.member.update({ data: patch });",
    "const patch = {}; patch['active'] = false; tx.member.update({ data: patch });",
    "const patch = enabled ? { active: true } : { cancelledAt: day }; tx.member.upsert({ create: {}, update: patch });",
  ])("finds direct, aliased, spread, assigned and cancellation-only writes: %s", (fixture) => {
    const found = writers(parse(`function change() { ${fixture} }`));
    expect(found).toHaveLength(1);
    expect(found[0]?.fields.leavingDate).toHaveLength(0);
  });

  it("surfaces computed helper payloads instead of silently considering them safe", () => {
    const found = writers(parse("function change() { const patch = helper(); tx.member.update({ data: { ...patch } }); }"));
    expect(found).toHaveLength(1);
    expect(found[0]?.fields.opaque).toEqual(["helper()"]);
  });

  it("does not count a reactivation's null date as a departure stamp", () => {
    const found = writers(parse(`function change() {
      let patch = {};
      if (deactivate) patch = { active: false };
      else patch = { active: true, leavingDate: null };
      tx.member.updateMany({ data: patch });
    }`));
    expect(found).toHaveLength(1);
    expect(hasDepartureStamp(found[0].fields)).toBe(false);
  });

  it("ignores read predicates, other delegates, and literal active-only creation", () => {
    expect(writers(parse(`
      tx.member.findMany({ where: { active: false } });
      tx.member.update({ where: { active: false }, data: { email } });
      tx.xeroObjectLink.update({ data: { active: false } });
      tx.member.create({ data: { active: true } });
    `))).toEqual([]);
  });
});
