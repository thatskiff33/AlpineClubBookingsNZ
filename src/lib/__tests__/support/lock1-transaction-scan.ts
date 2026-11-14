import path from "path";
import ts from "typescript";

import { collectAdvisoryLockSites } from "./advisory-lock-scan";

// The reader behind `lock1-transaction-budget-census.test.ts` (`INV-LOCK-006`):
// for every `pg_advisory_xact_lock(1)` site, the interactive transaction that
// waits for it and the options that transaction is opened with.
//
// The sites come from the INV-LOCK-003 scanner (`advisory-lock-scan.ts`), so
// the two censuses agree on what a lock(1) site is. From each site the reader
// walks OUT through the syntax tree:
//
// - an argument of a transaction OPENER (`$transaction`, or one of the two
//   wrappers that open one) is the transaction that waits - recorded with the
//   options that call passes;
// - an anonymous function is walked through, since it runs wherever its
//   enclosing code runs;
// - a NAMED function (a declaration, or a `const` holding a function) runs
//   inside whatever transaction its caller holds, so the reader follows every
//   reference to it - a call, or the function handed to `$transaction` by name -
//   in its own module and in every module that imports it, and walks out from
//   each of those in turn;
// - `withOptionalTransaction` opens a transaction only when its caller supplies
//   none, so it is recorded AND the reader keeps walking out: a caller that
//   hands in its own `tx` is the transaction that really waits. Past that
//   point a path that reaches no opener is fine (the wrapper opened one), so
//   it is not reported as unreached.
//
// The census decides which options it accepts; this module only reads.

/** The calls that OPEN an interactive transaction, and which argument carries its options. */
const TRANSACTION_OPENERS: Readonly<Record<string, number | null>> = {
  $transaction: 1,
  withOptionalTransaction: 2,
  // No options parameter: a lock(1) wait opened through it always runs on
  // Prisma's defaults, which the census reports like any other omission.
  withStoreTransaction: null,
};

export interface TransactionOpener {
  readonly rel: string;
  /** 1-based line of the opener call. */
  readonly line: number;
  /** `$transaction`, `withOptionalTransaction` or `withStoreTransaction`. */
  readonly opener: string;
  /**
   * The options argument as written, comments included, or `null` when the
   * call passes none (Prisma's 2 s / 5 s defaults).
   */
  readonly options: string | null;
  /** How the lock(1) wait reaches it: the site, then each named function on the way. */
  readonly via: readonly string[];
}

export interface Lock1TransactionScan {
  /** One entry per opener and route to it: an opener reached two ways is listed twice. */
  readonly openers: readonly TransactionOpener[];
  /** Every named function that waits for lock(1) in a CALLER's transaction, as `rel::name`. */
  readonly joinedFunctions: readonly string[];
  /**
   * Named functions nothing in non-test `src/` references: their wait reaches
   * no transaction the reader can see, and the census must refuse them.
   */
  readonly unreached: readonly string[];
}

interface ParsedFile {
  readonly rel: string;
  readonly text: string;
  readonly source: ts.SourceFile;
}

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** The name callers use to reach `fn`, or `null` for an anonymous function. */
function nameOfFunction(fn: FunctionNode): string | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? null;
  if (ts.isMethodDeclaration(fn)) return null;
  const holder = fn.parent;
  if (ts.isVariableDeclaration(holder) && holder.initializer === fn && ts.isIdentifier(holder.name)) {
    return holder.name.text;
  }
  return null;
}

/** `prisma.$transaction(...)`, `withOptionalTransaction(...)` -> its opener name. */
function openerOf(call: ts.CallExpression): string | null {
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  return name !== null && name in TRANSACTION_OPENERS ? name : null;
}

function deepestNodeAt(source: ts.SourceFile, offset: number): ts.Node {
  let node: ts.Node = source;
  for (;;) {
    const child: ts.Node | undefined = node
      .getChildren(source)
      .find((candidate) => candidate.getStart(source) <= offset && offset < candidate.getEnd());
    if (!child) return node;
    node = child;
  }
}

/** The module `rel` names with `specifier`, as a repository path without extension. */
function resolveSpecifier(rel: string, specifier: string): string {
  if (specifier.startsWith("@/")) return `src/${specifier.slice(2)}`;
  return path.posix.join(path.posix.dirname(rel), specifier);
}

/** The local names under which `file` imports `name` from `definingRel`. */
function localNamesOf(file: ParsedFile, name: string, definingRel: string): string[] {
  const target = definingRel.replace(/\.tsx?$/, "");
  const names: string[] = [];
  for (const statement of file.source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const resolved = resolveSpecifier(file.rel, statement.moduleSpecifier.text);
    if (resolved !== target && `${resolved}/index` !== target) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === name) names.push(element.name.text);
    }
  }
  return names;
}

/**
 * Every identifier in `file` spelled `local`, bar declarations, import bindings
 * and type positions: `ReturnType<typeof fn>` names the function without
 * running it, so it is not a place the lock(1) wait can happen.
 */
function referencesTo(file: ParsedFile, local: string): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && node.text === local) {
      const parent = node.parent;
      const declares =
        ((ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name === node) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!declares) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return found;
}

/**
 * Follow every lock(1) site in `sources` to the transaction that waits for it.
 */
export function scanLock1Transactions(
  sources: ReadonlyArray<{ rel: string; text: string }>,
): Lock1TransactionScan {
  const parsed = new Map<string, ParsedFile>();
  const parse = (rel: string): ParsedFile => {
    let file = parsed.get(rel);
    if (!file) {
      const text = sources.find((candidate) => candidate.rel === rel)!.text;
      const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      file = {
        rel,
        text,
        source: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind),
      };
      parsed.set(rel, file);
    }
    return file;
  };

  const openers: TransactionOpener[] = [];
  const joined = new Map<string, readonly string[]>();
  const unreached: string[] = [];
  // A function first reached only past a `withOptionalTransaction` is followed
  // again if a required path reaches it later.
  const optionalOnly = new Set<string>();
  const queue: Array<{ rel: string; name: string; via: readonly string[]; optional: boolean }> = [];

  const walkOut = (
    file: ParsedFile,
    start: ts.Node,
    via: readonly string[],
    optional = false,
  ): void => {
    for (let node: ts.Node = start; !ts.isSourceFile(node); node = node.parent) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) {
        const opener = openerOf(parent);
        if (opener !== null) {
          const optionsIndex = TRANSACTION_OPENERS[opener];
          const options = optionsIndex === null ? undefined : parent.arguments[optionsIndex];
          openers.push({
            rel: file.rel,
            line: file.source.getLineAndCharacterOfPosition(parent.getStart(file.source)).line + 1,
            opener,
            // Full text, so a comment written before the options travels with them.
            options: options ? file.text.slice(options.getFullStart(), options.getEnd()).trim() : null,
            via,
          });
          if (opener !== "withOptionalTransaction") return;
          optional = true;
        }
      }
      if (isFunctionNode(node)) {
        const name = nameOfFunction(node);
        if (name !== null) {
          const key = `${file.rel}::${name}`;
          if (!joined.has(key) || (optionalOnly.has(key) && !optional)) {
            if (!joined.has(key)) joined.set(key, via);
            if (optional) optionalOnly.add(key);
            else optionalOnly.delete(key);
            queue.push({ rel: file.rel, name, via: [...via, key], optional });
          }
          return;
        }
      }
    }
    if (!optional) unreached.push(`${file.rel}::(module scope) via ${via.join(" <- ")}`);
  };

  for (const site of collectAdvisoryLockSites(sources)) {
    if (site.tier !== "GLOBAL") continue;
    const file = parse(site.rel);
    walkOut(file, deepestNodeAt(file.source, site.offset), [site.qualifiedKey]);
  }

  while (queue.length > 0) {
    const { rel, name, via, optional } = queue.shift()!;
    let referenced = false;
    for (const candidate of sources) {
      // A cheap textual filter before parsing: a module that never spells the
      // name cannot reference it.
      if (!candidate.text.includes(name)) continue;
      const file = parse(candidate.rel);
      const locals = candidate.rel === rel ? [name] : localNamesOf(file, name, rel);
      for (const local of locals) {
        for (const reference of referencesTo(file, local)) {
          referenced = true;
          walkOut(file, reference, via, optional);
        }
      }
    }
    if (!referenced && !optional) unreached.push(`${rel}::${name}`);
  }

  return { openers, joinedFunctions: [...joined.keys()], unreached };
}
