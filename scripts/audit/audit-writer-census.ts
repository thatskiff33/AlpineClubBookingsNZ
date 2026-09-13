/**
 * The audit-writer census (#2581).
 *
 * WHY THIS EXISTS. `AuditLog.category` is the field every category-filtered
 * reader depends on — the AI Diagnostics correlation tools filter on it with
 * `category = ANY (…)`, and a row written with no category is matched by none of
 * them. #2581 found 82 production write sites that pass no category at all, and
 * the reason it took a hand census to find them is that nothing in the
 * repository could answer "how many audit writers are there, and which of them
 * omit a category?" This tool answers it, and the contract test beside it
 * (`src/lib/__tests__/audit-writer-census.test.ts`) turns the answer into a
 * gate: adding a new uncategorised audit writer fails CI with the writer named.
 *
 * WHY AN AST WALK RATHER THAN A GREP. Two measured reasons, both from the
 * censuses that came before this file:
 *
 *  - COMMENTS. `src/lib/member-guest-find-service.ts` has the string
 *    `void createStructuredAuditLog(...)` inside a docblock. A text census
 *    counts it and reports a phantom uncategorised structured writer — which is
 *    exactly the error preserved in this issue's own title. The TypeScript
 *    parser never sees a comment as a call.
 *  - NESTED KEYS. `category` appears inside `details:` and `metadata:` payloads.
 *    Only a TOP-LEVEL `category` on the event object is the column, so the walk
 *    resolves the event object and reads its own properties rather than
 *    searching the call's text.
 *
 * WHAT IS A WRITE SITE. Four forms reach the `AuditLog` table in production,
 * and all four are counted:
 *
 *  1. `logAudit(params)`                     fire-and-forget helper
 *  2. `createAuditLog(params, db?)`          awaited helper
 *  3. `createStructuredAuditLog(event, db?)` awaited structured helper
 *  4. `<client>.auditLog.create(…)`          direct Prisma write, usually with
 *                                            `buildStructuredAuditLogCreateArgs`
 *
 * The two boundary writes inside `src/lib/audit.ts` itself, and `logAudit`'s
 * internal hop into `createAuditLog`, are NOT sites: their callers are already
 * counted, and counting the boundary as well would double every row.
 *
 * `auditLog.update` / `updateMany` / `delete` / `deleteMany` do not produce a
 * row and cannot carry a category, so they are inventoried separately as
 * non-producing DML. Today the only ones are the three retention archive/prune
 * statements in `src/lib/audit-retention.ts`; the contract test pins that set so
 * a new hand-written mutation of the audit trail has to be declared.
 *
 * ONE FORM IS NOT TYPESCRIPT AT ALL, and a TS-only census would claim `prisma/`
 * was clean while a migration wrote the table: raw SQL DML against `"AuditLog"`
 * inside `prisma/migrations/…/migration.sql`. Two migrations do it today — a
 * door-code redaction `UPDATE` and an email-override `INSERT` — so the SQL is
 * scanned as well, comment-stripped, and inventoried separately. An `INSERT` is
 * row-producing and its column list is checked for `"category"`; `UPDATE` and
 * `DELETE` cannot carry one and are recorded as mutations of existing evidence.
 *
 * SIX MEASURED BYPASSES WERE CLOSED IN #2581's REVIEW, because "the census sees
 * every writer" was asserted in the docs before it was true. A reviewer ran this
 * scanner against a synthetic tree and got a clean report for each of these;
 * `audit-writer-census-scanner.test.ts` now runs the same fixtures on every CI
 * run, so a regression in the walk fails by name rather than by silence:
 *
 *  1. `const log = tx.auditLog; log.create(…)` — a delegate parked in a local.
 *  2. `tx["auditLog"].create(…)` — the same delegate reached by element access.
 *  3. `prisma.$executeRawUnsafe('INSERT INTO "AuditLog" …')` — raw SQL from
 *     TypeScript, which the `prisma/**​/*.sql` arm never walks.
 *  4. `createMany({ data: [ {category}, {no category} ] })` — only the FIRST
 *     element used to be read, so a categorised first row hid the rest.
 *  5. `INSERT INTO "public"."AuditLog"` — a schema qualifier used to defeat the
 *     migration regex, and (6) an INSERT naming `"category"` while supplying
 *     `NULL` for it passed the column-list check while writing the very row the
 *     check exists to prevent.
 *
 * WHAT IS STILL NOT COVERED, stated because the alternative is another false
 * completeness claim: a delegate reached through a helper's return value
 * (`clientFor(tx).auditLog.create(…)`), an alias assigned outside a variable
 * declaration (`let log; log = tx.auditLog`), raw SQL assembled from fragments
 * at runtime so no single expression contains the DML keyword and the table
 * name, and an `INSERT … SELECT` whose category expression is computed rather
 * than literal. Those are the reason the TYPE and the RUNTIME assertion in
 * `src/lib/audit.ts` are the primary defences and this census is the backstop.
 *
 * Run it: `npm run audit:census` prints a deterministic TSV of every site.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";

import { must } from "../../src/lib/indexed-access";

/** The module that owns the audit boundary; its own writes are not call sites. */
export const AUDIT_BOUNDARY_MODULE = "src/lib/audit.ts";

/** The named helpers a production writer calls. */
export const AUDIT_HELPER_SINKS = [
  "logAudit",
  "createAuditLog",
  "createStructuredAuditLog",
] as const;

export type AuditHelperSink = (typeof AUDIT_HELPER_SINKS)[number];

/**
 * The argument builder for a direct Prisma write. Not a sink of its own — it
 * builds `{ data: … }` for a `create` that is counted at the `create`.
 */
const STRUCTURED_ARG_BUILDER = "buildStructuredAuditLogCreateArgs";

/** Prisma `auditLog` methods that produce a row and so can carry a category. */
const ROW_PRODUCING_DML = new Set(["create", "createMany", "upsert"]);

/** Prisma `auditLog` methods that mutate or remove existing rows. */
const NON_PRODUCING_DML = new Set([
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

/**
 * Prisma's raw-SQL escape hatches. They reach the table without touching the
 * `auditLog` delegate, so no amount of delegate tracking sees them, and the
 * `prisma/**​/*.sql` arm never walks TypeScript. A template or argument whose
 * text performs DML against `"AuditLog"` is counted as a site here.
 *
 * READS are deliberately not counted: the Diagnostics correlation packs select
 * from `"AuditLog"` with `$queryRaw`, and a census that flagged those would be
 * noise. Only `INSERT`/`UPDATE`/`DELETE` against the table qualifies, which is
 * the same predicate the migration arm uses.
 */
const RAW_SQL_METHODS = new Set([
  "$executeRaw",
  "$executeRawUnsafe",
  "$queryRaw",
  "$queryRawUnsafe",
]);

export type AuditWriteSink =
  | AuditHelperSink
  | `auditLog.${string}`
  | `raw.${string}`;

/**
 * What the call site says about the row's category.
 *
 *  - `literal`     one string, written verbatim: `category: "booking"`.
 *  - `conditional` a choice between string literals. The owner rule for #2581
 *                  is that category follows the affected business DOMAIN, so an
 *                  actor-based conditional is a finding, not a shape to accept
 *                  quietly — hence its own kind rather than two literals.
 *  - `forwarded`   the value is decided somewhere else: a variable, a shorthand
 *                  property, a spread, or a whole event object passed by
 *                  reference. Fail-closed — every one has to be declared.
 *  - `absent`      the event object carries no `category` key at all. This is
 *                  the population #2581 exists to close.
 */
export type AuditCategoryEvidence =
  | { kind: "literal"; value: string }
  | { kind: "conditional"; values: readonly string[] }
  | { kind: "forwarded"; expression: string }
  | { kind: "absent" };

export type AuditWriteSite = {
  /** Repo-relative POSIX path. */
  file: string;
  /**
   * A stable identity that survives a reformat and a rebase: the enclosing
   * symbol chain plus an ordinal among sites sharing it. Line numbers move —
   * PR #2618 alone moved one of these writers from line 131 to line 293 — so
   * the line is reported for convenience and never used as identity.
   */
  id: string;
  /** The enclosing function/method/variable chain, `<module>` at top level. */
  symbol: string;
  line: number;
  sink: AuditWriteSink;
  /** True for the four row-producing forms; false for non-producing DML. */
  producesRow: boolean;
  /** The `action` value when it is a plain literal, else a description. */
  action: string;
  category: AuditCategoryEvidence;
  /** True when the event object also omits `severity` and `retentionClass`. */
  omitsRetentionInputs: boolean;
  /** True when the event object names an `entityType` or `entityId`. */
  hasEntityIdentifier: boolean;
};

const SCAN_ROOTS = ["src", "scripts", "prisma"] as const;

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs)$/;

/**
 * Directories that hold no production writer. `__tests__`/`__mocks__` and the
 * Playwright tree describe writers or stub them; `generated` is output.
 */
const SKIP_DIRECTORIES = new Set([
  "__tests__",
  "__mocks__",
  "node_modules",
  "e2e",
  "generated",
  "fixtures",
  "test-utils",
]);

const SKIP_FILES = /(\.test\.|\.spec\.|\.d\.ts$)/;

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function listSourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      listSourceFiles(full, out);
      continue;
    }
    if (!SOURCE_EXTENSIONS.test(entry.name)) continue;
    if (SKIP_FILES.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node)) return unwrap(node.expression);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return unwrap(node.expression);
  }
  return node;
}

function literalText(node: ts.Expression): string | null {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return inner.text;
  }
  return null;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

type TopLevelProperty =
  | { kind: "assignment"; value: ts.Expression }
  | { kind: "opaque"; text: string };

/**
 * A view of an event object's OWN top-level keys, with spreads resolved as far
 * as they can be read at the call site.
 *
 * Spreads matter here for one measured reason: the deletion-rejected writer in
 * `src/app/api/admin/deletion-requests/[id]/route.ts` spreads
 * `...(suppressed ? { metadata } : {})` and passes no category. A census that
 * failed closed on any spread would report that site as "category decided
 * elsewhere" instead of as the omission it is, and the uncategorised count would
 * read 81 rather than 82 — a site quietly moved from the population that has to
 * be fixed into an allowlist. So a spread of INLINE literals (or a conditional /
 * `&&` / `??` between them) contributes its keys, exactly as
 * `exclusivity-request-write-sites.test.ts` reads its own payloads. A spread of
 * anything opaque — an identifier, a call result — still fails closed, because
 * its keys are decided somewhere a reviewer cannot see.
 */
type ResolvedObject = {
  keys: Map<string, TopLevelProperty>;
  opaqueSpread: boolean;
};

function spreadLiterals(expression: ts.Expression): ts.ObjectLiteralExpression[] | null {
  const inner = unwrap(expression);
  if (ts.isObjectLiteralExpression(inner)) return [inner];
  if (ts.isConditionalExpression(inner)) {
    const whenTrue = spreadLiterals(inner.whenTrue);
    const whenFalse = spreadLiterals(inner.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (ts.isBinaryExpression(inner)) {
    // `cond && { … }` / `value ?? { … }` — read whichever side is a literal.
    const left = spreadLiterals(inner.left);
    const right = spreadLiterals(inner.right);
    if (left && right) return [...left, ...right];
    return right ?? left;
  }
  return null;
}

function resolveObjectLiteral(literal: ts.ObjectLiteralExpression): ResolvedObject {
  const keys = new Map<string, TopLevelProperty>();
  let opaqueSpread = false;

  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property.name);
      if (name) keys.set(name, { kind: "assignment", value: property.initializer });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      keys.set(property.name.text, {
        kind: "opaque",
        text: property.name.text,
      });
      continue;
    }
    if (ts.isSpreadAssignment(property)) {
      const branches = spreadLiterals(property.expression);
      if (!branches) {
        opaqueSpread = true;
        continue;
      }
      for (const branch of branches) {
        const resolved = resolveObjectLiteral(branch);
        opaqueSpread = opaqueSpread || resolved.opaqueSpread;
        for (const [name, value] of resolved.keys) {
          // A key that arrives through a spread may or may not be present at
          // runtime, so its VALUE is not readable even when its name is.
          keys.set(name, { kind: "opaque", text: `spread ${name}` });
          void value;
        }
      }
    }
  }

  return { keys, opaqueSpread };
}

function findTopLevelProperty(
  resolved: ResolvedObject,
  key: string,
): TopLevelProperty | null {
  return resolved.keys.get(key) ?? null;
}

/**
 * The event/params objects a write site passes, unwrapped through the structured
 * argument builder and through a Prisma `{ data: … }` envelope. Returns null
 * when the payload is not an inline literal — the `forwarded` case.
 *
 * PLURAL because of `createMany({ data: [ …, … ] })`: one syntactic site, one
 * row PER ELEMENT. This used to read `elements[0]` only, which a reviewer
 * demonstrated is a bypass — a first element carrying `category: "admin"` made
 * the site read as categorised while every element after it wrote a row no
 * reader can filter for. Every element is resolved now, and the combination
 * rule below takes the weakest answer.
 */
function resolveEventObjects(
  argument: ts.Expression | undefined,
): ts.ObjectLiteralExpression[] | null {
  if (!argument) return null;
  const inner = unwrap(argument);

  if (ts.isObjectLiteralExpression(inner)) {
    // A Prisma create envelope: `{ data: { … } }`.
    const data = findTopLevelProperty(resolveObjectLiteral(inner), "data");
    if (data?.kind === "assignment") {
      return resolveEventObjects(data.value);
    }
    return [inner];
  }

  if (ts.isCallExpression(inner)) {
    const callee = unwrap(inner.expression);
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null;
    if (name === STRUCTURED_ARG_BUILDER) {
      return resolveEventObjects(inner.arguments[0]);
    }
    return null;
  }

  if (ts.isArrayLiteralExpression(inner)) {
    const resolved: ts.ObjectLiteralExpression[] = [];
    for (const element of inner.elements) {
      const objects = resolveEventObjects(element);
      // Fail closed: one unreadable element makes the whole site `forwarded`,
      // which has to be declared, rather than letting its readable siblings
      // vouch for it.
      if (!objects) return null;
      resolved.push(...objects);
    }
    return resolved.length ? resolved : null;
  }

  return null;
}

/**
 * The category evidence for a whole site, across every row it writes.
 *
 * The weakest element decides, in this order: an element with no category makes
 * the SITE uncategorised (it writes an unreadable row); then an element whose
 * category is decided elsewhere makes it forwarded; then two or more distinct
 * literals make it conditional, which is the shape the owner's domain rule
 * refuses. A single-element site — every site in the tree today — resolves
 * exactly as it did before.
 */
function combineCategory(
  events: readonly ResolvedObject[] | null,
  fallbackExpression: string,
): AuditCategoryEvidence {
  if (!events || events.length === 0) {
    return { kind: "forwarded", expression: fallbackExpression };
  }

  const each = events.map((event) => resolveCategory(event));
  if (each.length === 1) return must(each[0], "combineCategory: length-1 evidence list has no first element");

  const absent = each.find((evidence) => evidence.kind === "absent");
  if (absent) return absent;
  const forwarded = each.find((evidence) => evidence.kind === "forwarded");
  if (forwarded) return forwarded;

  const values = [
    ...new Set(
      each.flatMap((evidence) =>
        evidence.kind === "literal"
          ? [evidence.value]
          : evidence.kind === "conditional"
            ? [...evidence.values]
            : [],
      ),
    ),
  ].sort();
  return values.length === 1
    ? { kind: "literal", value: must(values[0], "combineCategory: length-1 value list has no first element") }
    : { kind: "conditional", values };
}

function resolveCategory(event: ResolvedObject): AuditCategoryEvidence {
  const property = findTopLevelProperty(event, "category");
  if (!property) {
    return event.opaqueSpread
      ? { kind: "forwarded", expression: "opaque spread" }
      : { kind: "absent" };
  }
  if (property.kind === "opaque") {
    return { kind: "forwarded", expression: property.text };
  }

  const value = unwrap(property.value);
  const direct = literalText(value);
  if (direct !== null) return { kind: "literal", value: direct };

  if (ts.isConditionalExpression(value)) {
    const whenTrue = literalText(value.whenTrue);
    const whenFalse = literalText(value.whenFalse);
    if (whenTrue !== null && whenFalse !== null) {
      return { kind: "conditional", values: [whenTrue, whenFalse] };
    }
  }

  return { kind: "forwarded", expression: collapse(value.getText()) };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function resolveOneAction(event: ResolvedObject): string {
  const property = findTopLevelProperty(event, "action");
  if (!property) return "(none)";
  if (property.kind === "opaque") return "(forwarded)";
  const direct = literalText(property.value);
  return direct ?? `(dynamic) ${collapse(property.value.getText())}`;
}

function resolveAction(events: readonly ResolvedObject[] | null): string {
  if (!events || events.length === 0) return "(forwarded)";
  const actions = [...new Set(events.map(resolveOneAction))].sort();
  return actions.length === 1
    ? must(actions[0], "resolveAction: length-1 action list has no first element")
    : `(mixed) ${actions.join("|")}`;
}

/**
 * The enclosing symbol chain, outermost first. Named function declarations,
 * methods, classes and `const fn = …` initialisers all contribute; an anonymous
 * arrow inside one of them does not, so a reformat that wraps a call in another
 * callback does not change the identity.
 */
function symbolChain(node: ts.Node): string {
  const names: string[] = [];
  let cursor: ts.Node | undefined = node.parent;
  while (cursor) {
    if (
      (ts.isFunctionDeclaration(cursor) ||
        ts.isMethodDeclaration(cursor) ||
        ts.isClassDeclaration(cursor)) &&
      cursor.name &&
      ts.isIdentifier(cursor.name)
    ) {
      names.unshift(cursor.name.text);
    } else if (
      ts.isVariableDeclaration(cursor) &&
      ts.isIdentifier(cursor.name)
    ) {
      names.unshift(cursor.name.text);
    }
    cursor = cursor.parent;
  }
  return names.length ? names.join(".") : "<module>";
}

/**
 * True for an expression that IS the `auditLog` delegate: `db.auditLog`,
 * `db["auditLog"]`, or a bare `auditLog` destructured off a client.
 *
 * Element access is here because a reviewer demonstrated `tx["auditLog"].create`
 * as a silent bypass of the property-access-only check that preceded it.
 */
function isAuditDelegateExpression(expression: ts.Expression): boolean {
  const inner = unwrap(expression);
  if (ts.isPropertyAccessExpression(inner)) {
    return inner.name.text === "auditLog";
  }
  if (ts.isElementAccessExpression(inner)) {
    return literalText(inner.argumentExpression) === "auditLog";
  }
  return ts.isIdentifier(inner) && inner.text === "auditLog";
}

/**
 * Locals that hold the `auditLog` delegate, so `const log = tx.auditLog;
 * log.create(…)` is still counted.
 *
 * A per-file name set rather than a type-checker symbol table: the census parses
 * 1,896 files with `createSourceFile` and a full program would cost minutes. The
 * trade is stated in the header — an alias created by assignment rather than by
 * declaration, or handed back from a helper, is still invisible.
 */
function collectAuditDelegateAliases(ast: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();

  eachNode(ast, (node) => {
    if (!ts.isVariableDeclaration(node)) return;

    if (ts.isIdentifier(node.name)) {
      if (node.initializer && isAuditDelegateExpression(node.initializer)) {
        aliases.add(node.name.text);
      }
      return;
    }

    // `const { auditLog } = tx` already reads as a delegate by name; this is for
    // `const { auditLog: log } = tx`, which does not.
    if (ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const source = element.propertyName ?? element.name;
        if (
          ts.isIdentifier(source) &&
          source.text === "auditLog" &&
          ts.isIdentifier(element.name)
        ) {
          aliases.add(element.name.text);
        }
      }
    }
  });

  return aliases;
}

function sinkNameOf(
  call: ts.CallExpression,
  aliases: ReadonlySet<string>,
): AuditWriteSink | null {
  const callee = unwrap(call.expression);

  if (ts.isIdentifier(callee)) {
    const name = callee.text;
    return (AUDIT_HELPER_SINKS as readonly string[]).includes(name)
      ? (name as AuditHelperSink)
      : null;
  }

  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;

  // `prisma.$executeRawUnsafe("INSERT INTO \"AuditLog\" …")` — no delegate
  // involved, so the checks below never see it.
  if (RAW_SQL_METHODS.has(method)) {
    return rawSqlDmlKind(call) ? (`raw.${method}` as AuditWriteSink) : null;
  }

  if (!ROW_PRODUCING_DML.has(method) && !NON_PRODUCING_DML.has(method)) {
    return null;
  }

  // `<anything>.auditLog.<method>(…)`, a destructured `auditLog.<method>(…)`,
  // `<anything>["auditLog"].<method>(…)`, or a local holding the delegate.
  const receiver = unwrap(callee.expression);
  const isAuditDelegate =
    isAuditDelegateExpression(receiver) ||
    (ts.isIdentifier(receiver) && aliases.has(receiver.text));
  return isAuditDelegate ? (`auditLog.${method}` as AuditWriteSink) : null;
}

/**
 * The DML kind a raw-SQL call performs against `"AuditLog"`, or null when it
 * touches the table only to READ it (or not at all).
 *
 * The text is read from the tagged template or the first argument, so a query
 * assembled from runtime fragments is not seen — which the header states rather
 * than papers over.
 */
function rawSqlDmlKind(call: ts.CallExpression): "insert" | "mutation" | null {
  const text = collapse(call.arguments[0]?.getText() ?? "");
  return classifyRawSqlText(text);
}

function classifyRawSqlText(text: string): "insert" | "mutation" | null {
  const match = new RegExp(SQL_AUDIT_DML_SOURCE, "i").exec(text);
  if (!match) return null;
  // The pattern's own capture group is mandatory, so its absence here would
  // mean the pattern itself did not really match.
  const [, verb] = match;
  if (!verb) return null;
  return verb.toUpperCase().startsWith("INSERT") ? "insert" : "mutation";
}

/**
 * True for a call the census must not count, because counting it would count the
 * same row twice: the two `db.auditLog.create` boundary writes inside
 * `src/lib/audit.ts` and `logAudit`'s own hop into `createAuditLog`.
 */
function isBoundaryOwnWrite(file: string, sink: AuditWriteSink): boolean {
  if (file !== AUDIT_BOUNDARY_MODULE) return false;
  return sink.startsWith("auditLog.") || sink === "createAuditLog";
}

/** True when the declaration of a helper is being read rather than a call. */
function isDeclarationName(call: ts.CallExpression): boolean {
  return ts.isFunctionDeclaration(call.parent) || ts.isMethodDeclaration(call.parent);
}

function scanFile(file: string, repoRoot: string): AuditWriteSite[] {
  const relativePath = toPosix(relative(repoRoot, file));
  const ast = parse(file);
  const aliases = collectAuditDelegateAliases(ast);
  const found: AuditWriteSite[] = [];
  const ordinals = new Map<string, number>();

  const record = (
    node: ts.Node,
    sink: AuditWriteSink,
    producesRow: boolean,
    action: string,
    category: AuditCategoryEvidence,
    events: readonly ResolvedObject[] | null,
  ) => {
    const symbol = symbolChain(node);
    const key = `${relativePath}::${symbol}`;
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);

    found.push({
      file: relativePath,
      id: `${key}#${ordinal}`,
      symbol,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      sink,
      producesRow,
      action,
      category,
      // ANY element omitting retention inputs flags the site, and EVERY element
      // must name an entity before the site counts as identified: both take the
      // pessimistic reading of a multi-row write, and both are unchanged for the
      // single-object sites that make up the whole tree today.
      omitsRetentionInputs:
        producesRow &&
        events !== null &&
        events.some(
          (event) =>
            !findTopLevelProperty(event, "severity") &&
            !findTopLevelProperty(event, "retentionClass"),
        ),
      hasEntityIdentifier:
        producesRow &&
        events !== null &&
        events.every(
          (event) =>
            findTopLevelProperty(event, "entityType") !== null ||
            findTopLevelProperty(event, "entityId") !== null ||
            findTopLevelProperty(event, "entity") !== null,
        ),
    });
  };

  eachNode(ast, (node) => {
    // `prisma.$executeRaw`INSERT INTO "AuditLog" …`` is a tagged template, not a
    // call, so the call branch below never sees it.
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = unwrap(node.tag);
      if (!ts.isPropertyAccessExpression(tag)) return;
      if (!RAW_SQL_METHODS.has(tag.name.text)) return;
      const kind = classifyRawSqlText(collapse(node.template.getText()));
      if (!kind) return;
      record(
        node,
        `raw.${tag.name.text}` as AuditWriteSink,
        kind === "insert",
        kind === "insert" ? "(raw sql)" : "(dml)",
        { kind: "absent" },
        null,
      );
      return;
    }

    if (!ts.isCallExpression(node)) return;
    if (isDeclarationName(node)) return;
    const sink = sinkNameOf(node, aliases);
    if (!sink) return;
    if (isBoundaryOwnWrite(relativePath, sink)) return;

    if (sink.startsWith("raw.")) {
      const kind = rawSqlDmlKind(node);
      record(
        node,
        sink,
        kind === "insert",
        kind === "insert" ? "(raw sql)" : "(dml)",
        { kind: "absent" },
        null,
      );
      return;
    }

    const method = sink.startsWith("auditLog.") ? sink.slice("auditLog.".length) : null;
    const producesRow = method === null || ROW_PRODUCING_DML.has(method);

    const literals = producesRow ? resolveEventObjects(node.arguments[0]) : null;
    const events = literals ? literals.map(resolveObjectLiteral) : null;

    record(
      node,
      sink,
      producesRow,
      producesRow ? resolveAction(events) : "(dml)",
      producesRow
        ? combineCategory(
            events,
            collapse(node.arguments[0]?.getText() ?? "(no argument)"),
          )
        : { kind: "absent" },
      events,
    );
  });

  return found;
}

/**
 * One raw-SQL statement against `"AuditLog"` in a committed migration.
 *
 * Identity is `<path>::<statement kind>#<ordinal>` — the same shape as a
 * TypeScript site's, and equally line-independent, because a migration file is
 * immutable once committed but its position in a reformatted tree is not.
 */
export type AuditSqlStatement = {
  file: string;
  id: string;
  line: number;
  kind: "insert" | "update" | "delete";
  /** True for `INSERT`; `UPDATE`/`DELETE` mutate rows that already have one. */
  producesRow: boolean;
  /** For an `INSERT`, whether its column list names `"category"`. */
  namesCategory: boolean;
};

/**
 * SQL with `--` line comments and `/* … *​/` blocks blanked out, newlines kept so
 * line numbers survive. Blanking rather than deleting is what keeps the offsets
 * usable; the door-code migration discusses `UPDATE "AuditLog"` in its header
 * comment as well as performing it, so a census that did not strip comments would
 * over-count exactly the way the TypeScript docblock false positive did.
 */
function stripSqlComments(sql: string): string {
  let out = "";
  let index = 0;
  let inLine = false;
  let inBlock = false;
  let inString = false;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      } else {
        out += " ";
      }
      index += 1;
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        out += "  ";
        index += 2;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (inString) {
      // Postgres doubles a quote to escape it; either way the state machine only
      // has to know it is still inside the literal.
      if (char === "'") inString = false;
      out += char;
      index += 1;
      continue;
    }
    if (char === "'") {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      inLine = true;
      out += "  ";
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      out += "  ";
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }

  return out;
}

/**
 * DML against the audit table, with an OPTIONAL schema qualifier.
 *
 * The qualifier is not decoration: a reviewer showed that
 * `INSERT INTO "public"."AuditLog"` — which Postgres executes identically —
 * slipped past the unqualified pattern entirely, so a migration could write
 * uncategorised rows and the census would report the tree clean.
 *
 * `"AuditLogArchive"` deliberately does NOT match: the closing quote is part of
 * the pattern, and the archive table is a different (already-categorised) copy
 * handled by the retention seam.
 */
const SQL_AUDIT_DML_SOURCE =
  String.raw`\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"[^"]+"\s*\.\s*)?"AuditLog"`;

const SQL_AUDIT_DML = new RegExp(SQL_AUDIT_DML_SOURCE, "gi");

/**
 * A parenthesised group at the start of `text` (after optional whitespace),
 * returned with the offset just past its closing bracket.
 *
 * Bracket-aware rather than `indexOf(")")`, because an INSERT's VALUES tuple can
 * contain `gen_random_uuid()` or `jsonb_build_object(…)`; a naive scan stops at
 * the first inner bracket and reads a truncated tuple.
 */
function readParenGroup(text: string): { inner: string; end: number } | null {
  const open = text.search(/\S/);
  if (open === -1 || text[open] !== "(") return null;

  let depth = 0;
  let inString = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "'") inString = false;
      continue;
    }
    if (char === "'") {
      inString = true;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { inner: text.slice(open + 1, index), end: index + 1 };
      }
    }
  }
  return null;
}

/** Split on commas that are not inside brackets or a string literal. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inString = false;

  for (const char of text) {
    if (inString) {
      current += char;
      if (char === "'") inString = false;
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * True when an INSERT that NAMES `"category"` supplies a literal `NULL` for it.
 *
 * Naming the column used to be the whole check, and a reviewer showed that
 * `INSERT INTO "AuditLog" (…, "category") VALUES (…, NULL)` therefore passed
 * while writing exactly the unreadable, kept-forever row the check exists to
 * refuse. Both source forms the migrations use are read: a `VALUES` list (every
 * tuple, so one bad row among many still fails) and an `INSERT … SELECT`
 * projection, which is what the committed email-override migration uses.
 *
 * A projection whose category expression is computed — a `CASE`, a joined
 * column — reads as "not statically NULL" and passes. That residual is named in
 * the header rather than hidden here.
 */
function insertSuppliesNullCategory(rest: string, columnIndex: number): boolean {
  const positionIsNull = (expressions: readonly string[]) =>
    (expressions[columnIndex] ?? "").trim().toUpperCase() === "NULL";

  const values = /^\s*VALUES\s*/i.exec(rest);
  if (values) {
    let cursor = rest.slice(values[0].length);
    for (;;) {
      const tuple = readParenGroup(cursor);
      if (!tuple) return false;
      if (positionIsNull(splitTopLevel(tuple.inner))) return true;
      const next = /^\s*,\s*/.exec(cursor.slice(tuple.end));
      if (!next) return false;
      cursor = cursor.slice(tuple.end + next[0].length);
    }
  }

  const select = /^\s*SELECT\s+/i.exec(rest);
  if (select) {
    const projection = rest.slice(select[0].length);
    // The projection ends at the first `FROM` outside brackets and strings.
    let depth = 0;
    let inString = false;
    for (let index = 0; index < projection.length; index += 1) {
      const char = projection[index];
      if (inString) {
        if (char === "'") inString = false;
        continue;
      }
      if (char === "'") inString = true;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      else if (
        depth === 0 &&
        /^from\b/i.test(projection.slice(index, index + 5)) &&
        !/[A-Za-z0-9_"]/.test(projection[index - 1] ?? " ")
      ) {
        return positionIsNull(splitTopLevel(projection.slice(0, index)));
      }
    }
    return positionIsNull(splitTopLevel(projection));
  }

  return false;
}

function scanSqlFile(file: string, repoRoot: string): AuditSqlStatement[] {
  const relativePath = toPosix(relative(repoRoot, file));
  const sql = stripSqlComments(readFileSync(file, "utf8"));
  const found: AuditSqlStatement[] = [];
  const ordinals = new Map<string, number>();

  for (const match of sql.matchAll(SQL_AUDIT_DML)) {
    // The pattern's own capture group is mandatory, so its absence here would
    // mean the pattern itself did not really match.
    const [fullMatch, verb] = match;
    if (!fullMatch || !verb) continue;
    const keyword = verb.toUpperCase();
    const kind = keyword.startsWith("INSERT")
      ? "insert"
      : keyword.startsWith("UPDATE")
        ? "update"
        : "delete";
    const at = match.index ?? 0;
    const ordinalKey = `${relativePath}::${kind}`;
    const ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, ordinal + 1);

    // The column list is the first parenthesised group after the table name; an
    // INSERT that omits it is relying on positional columns, which cannot be read
    // here, so it counts as NOT naming a category and has to be declared.
    //
    // Naming it is necessary but NOT sufficient: the value in that position must
    // not be a literal NULL, or the row is born uncategorised while the column
    // list says otherwise.
    let namesCategory = false;
    if (kind === "insert") {
      const rest = sql.slice(at + fullMatch.length);
      const columnGroup = readParenGroup(rest);
      if (columnGroup) {
        const columns = splitTopLevel(columnGroup.inner).map((column) =>
          column.replace(/"/g, "").trim().toLowerCase(),
        );
        const columnIndex = columns.indexOf("category");
        namesCategory =
          columnIndex !== -1 &&
          !insertSuppliesNullCategory(rest.slice(columnGroup.end), columnIndex);
      }
    }

    found.push({
      file: relativePath,
      id: `${ordinalKey}#${ordinal}`,
      line: sql.slice(0, at).split("\n").length,
      kind,
      producesRow: kind === "insert",
      namesCategory,
    });
  }

  return found;
}

export type AuditWriterCensus = {
  /** Every row-producing site, sorted by id. */
  sites: readonly AuditWriteSite[];
  /** Every non-producing `auditLog` DML statement, sorted by id. */
  nonProducingDml: readonly AuditWriteSite[];
  /** Row-producing sites whose event object carries no `category` key. */
  uncategorised: readonly AuditWriteSite[];
  /** Row-producing sites whose category is decided outside the call. */
  forwarded: readonly AuditWriteSite[];
  /** Row-producing sites choosing between category literals. */
  conditional: readonly AuditWriteSite[];
  /** Literal category value to the number of sites writing it. */
  categoryCounts: Readonly<Record<string, number>>;
  /** Sink to `{ total, uncategorised }`. */
  sinkCounts: Readonly<Record<string, { total: number; uncategorised: number }>>;
  /** Raw-SQL DML against `"AuditLog"` in committed migrations, sorted by id. */
  sqlStatements: readonly AuditSqlStatement[];
  /** Files scanned, for the "did the scan actually run" assertion. */
  filesScanned: number;
  /**
   * Every scanned source file, repo-relative and posix-separated, sorted.
   *
   * Exposed so a contract test can ask questions of the SAME corpus the census
   * measured rather than walking the tree itself with its own exclusions — a
   * gate keyed on "which files name this action" is only as trustworthy as its
   * agreement with the census about what the tree is (#2755).
   */
  files: readonly string[];
  /** Migration `.sql` files scanned, for the same reason. */
  sqlFilesScanned: number;
};

function listSqlFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSqlFiles(full, out);
      continue;
    }
    if (entry.name.endsWith(".sql")) out.push(full);
  }
  return out;
}

/**
 * Walk `src/`, `scripts/` and `prisma/` and inventory every audit write.
 *
 * `prisma/` and `scripts/` are in scope because they reach the same database
 * without going through a route: a seed or an operator backfill that wrote an
 * audit row would be invisible to a `src`-only scan. Neither contributes a
 * TypeScript site today, and the contract test pins that — but `prisma/` DOES
 * write the table in raw SQL, which is why `sqlStatements` exists rather than the
 * TS-only claim that the tree is clean.
 */
export function scanAuditWriterCensus(
  repoRoot: string = process.cwd(),
): AuditWriterCensus {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    listSourceFiles(join(repoRoot, root), files);
  }
  files.sort();

  const sqlFiles = listSqlFiles(join(repoRoot, "prisma"), []).sort();
  const sqlStatements = sqlFiles
    .flatMap((file) => scanSqlFile(file, repoRoot))
    .sort((a, b) => a.id.localeCompare(b.id));

  const all = files.flatMap((file) => scanFile(file, repoRoot));
  const byId = (a: AuditWriteSite, b: AuditWriteSite) => a.id.localeCompare(b.id);

  const sites = all.filter((site) => site.producesRow).sort(byId);
  const nonProducingDml = all.filter((site) => !site.producesRow).sort(byId);

  const categoryCounts: Record<string, number> = {};
  const sinkCounts: Record<string, { total: number; uncategorised: number }> = {};
  for (const site of sites) {
    const bucket = (sinkCounts[site.sink] ??= { total: 0, uncategorised: 0 });
    bucket.total += 1;
    if (site.category.kind === "absent") bucket.uncategorised += 1;
    if (site.category.kind === "literal") {
      categoryCounts[site.category.value] =
        (categoryCounts[site.category.value] ?? 0) + 1;
    }
  }

  return {
    sites,
    nonProducingDml,
    uncategorised: sites.filter((site) => site.category.kind === "absent"),
    forwarded: sites.filter((site) => site.category.kind === "forwarded"),
    conditional: sites.filter((site) => site.category.kind === "conditional"),
    categoryCounts,
    sinkCounts,
    sqlStatements,
    filesScanned: files.length,
    files: files.map((file) => toPosix(relative(repoRoot, file))),
    sqlFilesScanned: sqlFiles.length,
  };
}

/** How a site's category reads in the TSV. */
export function describeCategory(evidence: AuditCategoryEvidence): string {
  switch (evidence.kind) {
    case "literal":
      return evidence.value;
    case "conditional":
      return `conditional:${evidence.values.join("|")}`;
    case "forwarded":
      return `forwarded:${evidence.expression}`;
    case "absent":
      return "(absent)";
  }
}

const TSV_HEADER = [
  "id",
  "file",
  "symbol",
  "line",
  "sink",
  "producesRow",
  "action",
  "category",
  "omitsRetentionInputs",
  "hasEntityIdentifier",
].join("\t");

/** A deterministic TSV of the whole census, newest analysis first in id order. */
export function renderCensusTsv(census: AuditWriterCensus): string {
  const rows = [...census.sites, ...census.nonProducingDml].map((site) =>
    [
      site.id,
      site.file,
      site.symbol,
      String(site.line),
      site.sink,
      String(site.producesRow),
      site.action,
      describeCategory(site.category),
      String(site.omitsRetentionInputs),
      String(site.hasEntityIdentifier),
    ].join("\t"),
  );
  // Migration SQL shares the table so it shares the report; `sink` reads
  // `sql.<kind>` and `category` reads whether an INSERT names the column.
  const sqlRows = census.sqlStatements.map((statement) =>
    [
      statement.id,
      statement.file,
      "<migration>",
      String(statement.line),
      `sql.${statement.kind}`,
      String(statement.producesRow),
      "(sql)",
      statement.producesRow
        ? statement.namesCategory
          ? "named"
          : "(absent)"
        : "(dml)",
      "false",
      "false",
    ].join("\t"),
  );
  return [TSV_HEADER, ...rows, ...sqlRows].join("\n");
}

function main(): void {
  const census = scanAuditWriterCensus();
  process.stdout.write(`${renderCensusTsv(census)}\n`);
  process.stderr.write(
    [
      `files scanned:        ${census.filesScanned}`,
      `sql files scanned:    ${census.sqlFilesScanned}`,
      `row-producing sites:  ${census.sites.length}`,
      `uncategorised:        ${census.uncategorised.length}`,
      `forwarded category:   ${census.forwarded.length}`,
      `conditional category: ${census.conditional.length}`,
      `non-producing DML:    ${census.nonProducingDml.length}`,
      `migration SQL on AuditLog: ${census.sqlStatements.length}`,
      `category values:      ${JSON.stringify(census.categoryCounts)}`,
      `by sink:              ${JSON.stringify(census.sinkCounts)}`,
      "",
    ].join("\n"),
  );
}

// `tsx scripts/audit/audit-writer-census.ts` runs the census; importing it (the
// contract test does) must not.
if (
  process.argv[1] &&
  toPosix(process.argv[1]).endsWith("scripts/audit/audit-writer-census.ts")
) {
  main();
}
