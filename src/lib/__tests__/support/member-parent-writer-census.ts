import ts from "typescript";

import { stripComments } from "./strip-comments";

export type MemberParentWriterPersistence =
  | "member-persistence"
  | "runtime-representation"
  | "demo-test-fixture";

export type MeasuredMemberParentWriterSite = {
  file: string;
  site: string;
  persistence: MemberParentWriterPersistence;
};

type RawSite = Omit<MeasuredMemberParentWriterSite, "site"> & {
  baseSite: string;
  position: number;
};

const PARENT_COLUMNS = new Set(["parentMemberId", "secondaryParentId"]);
const PARENT_RELATIONS = new Map([
  ["parent", "parentMemberId"],
  ["secondaryParent", "secondaryParentId"],
]);
const MEMBER_WRITE_METHODS = new Set([
  "create",
  "createMany",
  "update",
  "upsert",
  "updateMany",
]);

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

function isNullishLiteral(expression: ts.Expression): boolean {
  return expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === "undefined");
}

function scopeName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    if (ts.isMethodDeclaration(current) && current.name) {
      return propertyName(current.name) ?? "anonymous";
    }
  }
  return "module";
}

function memberWriteMethod(call: ts.CallExpression): string | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const method = call.expression.name.text;
  if (!MEMBER_WRITE_METHODS.has(method)) return null;
  const delegate = call.expression.expression;
  if (!ts.isPropertyAccessExpression(delegate) || delegate.name.text !== "member") {
    return null;
  }
  return method;
}

function propertyAssignment(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | null {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property.name) === name,
  ) ?? null;
}

function memberWriteDataExpressions(
  object: ts.ObjectLiteralExpression,
  method: string,
): ts.Expression[] {
  const names = method === "upsert" ? new Set(["create", "update"]) : new Set(["data"]);
  const expressions: ts.Expression[] = [];
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && names.has(propertyName(property.name) ?? "")) {
      expressions.push(property.initializer);
    } else if (
      ts.isShorthandPropertyAssignment(property) &&
      names.has(property.name.text)
    ) {
      expressions.push(property.name);
    }
  }
  return expressions;
}

function fixturePersistence(file: string): MemberParentWriterPersistence {
  return file === "prisma/demo-seed.ts" ||
    file.startsWith("prisma/migration-verification/") ||
    file === "scripts/audit-access-role-membership-cleanup.ts"
    ? "demo-test-fixture"
    : "member-persistence";
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolveObjectLiterals(
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
  seen = new Set<number>(),
): ts.ObjectLiteralExpression[] {
  const current = unwrapExpression(expression);
  if (seen.has(current.pos)) return [];
  seen.add(current.pos);
  if (ts.isObjectLiteralExpression(current)) return [current];
  if (!ts.isIdentifier(current)) return [];
  return identifierWrites(sourceFile, current.text).flatMap((written) =>
    resolveObjectLiterals(sourceFile, written, seen),
  );
}

function collectParentShapes(
  expression: ts.Expression,
  context: { file: string; method: string; persistence: MemberParentWriterPersistence },
  found: RawSite[],
): void {
  const record = (node: ts.Node, shape: string, column: string) => {
    found.push({
      file: context.file,
      baseSite: `${scopeName(node)}/member.${context.method}/${shape}:${column}`,
      persistence: context.persistence,
      position: node.getStart(),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name && PARENT_COLUMNS.has(name) && !isNullishLiteral(node.initializer)) {
        record(node, "scalar", name);
        return;
      }
      const column = name ? PARENT_RELATIONS.get(name) : undefined;
      if (column && ts.isObjectLiteralExpression(node.initializer)) {
        const connect = propertyAssignment(node.initializer, "connect");
        if (connect && !isNullishLiteral(connect.initializer)) {
          record(node, `relation:${name}.connect`, column);
          return;
        }
      }
    }
    if (
      ts.isShorthandPropertyAssignment(node) &&
      PARENT_COLUMNS.has(node.name.text)
    ) {
      record(node, "scalar-shorthand", node.name.text);
      return;
    }
    if (
      ts.isShorthandPropertyAssignment(node) &&
      PARENT_RELATIONS.has(node.name.text)
    ) {
      record(
        node,
        `relation:${node.name.text}.shorthand`,
        PARENT_RELATIONS.get(node.name.text)!,
      );
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
}

function identifierWrites(
  sourceFile: ts.SourceFile,
  identifier: string,
): ts.Expression[] {
  const expressions: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === identifier &&
      node.initializer
    ) {
      expressions.push(node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isIdentifier(node.left) && node.left.text === identifier) {
        expressions.push(node.right);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return expressions;
}

function collectIdentifierPropertyAssignments(
  sourceFile: ts.SourceFile,
  file: string,
  identifier: string,
  method: string,
  persistence: MemberParentWriterPersistence,
  found: RawSite[],
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === identifier &&
      PARENT_COLUMNS.has(node.left.name.text) &&
      !isNullishLiteral(node.right)
    ) {
      found.push({
        file,
        baseSite: `${scopeName(node)}/member.${method}/scalar:${node.left.name.text}`,
        persistence,
        position: node.getStart(),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function collectResolvedParentShapes(
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
  context: {
    file: string;
    method: string;
    persistence: MemberParentWriterPersistence;
  },
  found: RawSite[],
): void {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    collectIdentifierPropertyAssignments(
      sourceFile,
      context.file,
      current.text,
      context.method,
      context.persistence,
      found,
    );
    for (const written of identifierWrites(sourceFile, current.text)) {
      collectResolvedParentShapes(sourceFile, written, context, found);
    }
    return;
  }
  collectParentShapes(current, context, found);
  if (ts.isObjectLiteralExpression(current)) {
    for (const property of current.properties) {
      if (!ts.isSpreadAssignment(property)) continue;
      if (!ts.isIdentifier(unwrapExpression(property.expression))) continue;
      collectResolvedParentShapes(
        sourceFile,
        property.expression,
        context,
        found,
      );
    }
  }
}

function hasComputedMergeMove(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "updateMany" &&
      node.arguments[0]
    ) {
      for (const args of resolveObjectLiterals(sourceFile, node.arguments[0])) {
        const data = propertyAssignment(args, "data");
        if (!data) continue;
        for (const object of resolveObjectLiterals(
          sourceFile,
          data.initializer,
        )) {
          found = object.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              ts.isComputedPropertyName(property.name) &&
              ts.isPropertyAccessExpression(property.name.expression) &&
              property.name.expression.name.text === "column" &&
              !isNullishLiteral(property.initializer),
          );
          if (found) return;
        }
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function collectRawSqlParentWrites(
  sourceFile: ts.SourceFile,
  file: string,
  persistence: MemberParentWriterPersistence,
  found: RawSite[],
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const updatePattern =
        /UPDATE\s+"Member"\s+SET([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|;)/gi;
      for (const update of node.text.matchAll(updatePattern)) {
        const assignments = update[1] ?? "";
        const columnPattern =
          /"(parentMemberId|secondaryParentId)"\s*=\s*([^,;\r\n]+)/gi;
        for (const assignment of assignments.matchAll(columnPattern)) {
          const value = (assignment[2] ?? "").trim();
          if (/^NULL(?:\b|::)/i.test(value)) continue;
          found.push({
            file,
            baseSite: `${scopeName(node)}/raw-sql-update:${assignment[1]}`,
            persistence,
            position:
              node.getStart() + (update.index ?? 0) + (assignment.index ?? 0),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function collectMergeSpecs(
  sourceFile: ts.SourceFile,
  file: string,
  found: RawSite[],
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "spec" &&
      node.arguments.length >= 4 &&
      node.arguments.slice(0, 4).every(ts.isStringLiteral)
    ) {
      const [model, relation, column, bucket] = node.arguments as unknown as readonly ts.StringLiteral[];
      if (
        model.text === "Member" &&
        PARENT_COLUMNS.has(column.text) &&
        bucket.text === "move"
      ) {
        found.push({
          file,
          baseSite: `MEMBER_MERGE_RELATION_SPECS/dynamic-move:${relation.text}.${column.text}`,
          persistence: "member-persistence",
          position: node.getStart(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function collectMigrationFixtureCalls(
  sourceFile: ts.SourceFile,
  file: string,
  found: RawSite[],
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "member" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      collectParentShapes(
        node.arguments[0],
        { file, method: "fixture", persistence: "demo-test-fixture" },
        found,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function collectXeroResultRepresentation(
  sourceFile: ts.SourceFile,
  file: string,
  found: RawSite[],
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "createdDependents" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const parent = propertyAssignment(node.arguments[0], "parentMemberId");
      if (parent && !isNullishLiteral(parent.initializer)) {
        found.push({
          file,
          baseSite: `${scopeName(node)}/createdDependents.push/runtime-result:parentMemberId`,
          persistence: "runtime-representation",
          position: parent.getStart(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/**
 * Measure the repository's supported direct Prisma, raw-SQL, and table-driven
 * routes for persisting a non-null direct-parent column. Comments are removed
 * before parsing. The explicit synthetic cases below pin aliases and spreads;
 * genuinely opaque dynamically constructed calls remain review failures when
 * their parent-column token is introduced because they cannot be proven safe by
 * this deterministic census. Merge specs count only while the paired DATA-side
 * computed-column mover remains present.
 */
export function scanMemberParentWriterSources(
  sources: ReadonlyMap<string, string>,
): MeasuredMemberParentWriterSite[] {
  const parsed = new Map<string, ts.SourceFile>();
  for (const [file, source] of sources) {
    parsed.set(
      file,
      ts.createSourceFile(
        file,
        stripComments(source),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    );
  }

  const found: RawSite[] = [];
  for (const [file, sourceFile] of parsed) {
    const persistence = fixturePersistence(file);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const method = memberWriteMethod(node);
        if (method && node.arguments[0]) {
          for (const args of resolveObjectLiterals(
            sourceFile,
            node.arguments[0],
          )) {
            const dataExpressions = memberWriteDataExpressions(args, method);
            for (const data of dataExpressions) {
              collectResolvedParentShapes(
                sourceFile,
                data,
                { file, method, persistence },
                found,
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    collectRawSqlParentWrites(sourceFile, file, persistence, found);

    if (file.startsWith("prisma/migration-verification/")) {
      collectMigrationFixtureCalls(sourceFile, file, found);
    }
    if (file === "src/lib/xero-member-import.ts") {
      collectXeroResultRepresentation(sourceFile, file, found);
    }
  }

  const mergeEngine = parsed.get("src/lib/member-merge.ts");
  const mergeSpecs = parsed.get("src/lib/member-merge-relations.ts");
  if (mergeEngine && mergeSpecs && hasComputedMergeMove(mergeEngine)) {
    collectMergeSpecs(mergeSpecs, "src/lib/member-merge-relations.ts", found);
  }

  const ordered = found.sort((left, right) =>
    left.file.localeCompare(right.file) || left.position - right.position,
  );
  const totals = new Map<string, number>();
  for (const site of ordered) {
    const key = `${site.file}\0${site.baseSite}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return ordered.map((rawSite) => {
    const key = `${rawSite.file}\0${rawSite.baseSite}`;
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    return {
      file: rawSite.file,
      persistence: rawSite.persistence,
      site:
        (totals.get(key) ?? 0) > 1
          ? `${rawSite.baseSite}#${ordinal}`
          : rawSite.baseSite,
    };
  });
}
