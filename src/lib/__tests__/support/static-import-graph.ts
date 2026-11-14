/**
 * The static value-import graph of production source under `src/` (#4930,
 * INV-SSOT-008).
 *
 * A static import is evaluated when its importer loads, so two modules that
 * import each other statically load in an order set by whichever page or cron
 * job reached the pair first. A module-level read across that loop can then
 * throw "cannot access before initialization" on some entry points and not
 * others. That is the edge this graph records, and nothing else:
 *
 * - `import type` / `export type` declarations, and an import or re-export
 *   whose every specifier is `type`, are erased by the compiler and never load
 *   anything. They are left out, or every type shared across a loop would
 *   report as one.
 * - A dynamic `import()` loads lazily, inside a function, and is the
 *   long-standing way this tree breaks a loop on purpose. It is left out.
 * - A bare `import "x"` side-effect import, and `export * from`, DO load
 *   their target and are edges.
 *
 * Statements are read with the TypeScript parser rather than a line regex, so
 * a multi-line import block or an import named in a comment cannot be miscounted.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** Test code and test-only support: neither runs in production. */
const SKIPPED_DIRS = new Set(["__tests__", "node_modules", "generated"]);
const SKIPPED_ROOTS = [path.join(SRC, "test")];
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  "/index.ts", "/index.tsx", "/index.mts", "/index.cts", "/index.js", "/index.jsx", "/index.mjs", "/index.cjs"];
/** Imports of these load no module code the graph could loop through. */
const ASSET = /\.(css|scss|svg|png|jpe?g|gif|webp|ico|json|txt|md)$/;

function toRepoPath(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/** Every production TypeScript or JavaScript file under `src/`, repo-relative. */
export function productionSourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED_DIRS.has(entry.name) || SKIPPED_ROOTS.includes(full) ? [] : walk(full);
      }
      return SOURCE.test(entry.name) && !/\.d\.(ts|mts|cts)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)
        ? [full]
        : [];
    });
  return walk(SRC).map(toRepoPath).sort();
}

/** The repo-relative file an `@/` or relative specifier names, or null for a package. */
export function resolveSpecifier(fromRepoPath: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(ROOT, path.dirname(fromRepoPath), specifier);
  else return null;
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    try {
      if (statSync(candidate).isFile()) return toRepoPath(candidate);
    } catch {
      // try the next suffix
    }
  }
  return null;
}

/** Whether an import or re-export declaration loads its target at runtime. */
function loadsAtRuntime(statement: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const bindings = clause.namedBindings;
    if (!bindings || ts.isNamespaceImport(bindings)) return true;
    return bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly);
  }
  if (statement.isTypeOnly) return false;
  const clause = statement.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) return true;
  return clause.elements.length === 0 || clause.elements.some((element) => !element.isTypeOnly);
}

export interface ModuleImport {
  specifier: string;
  line: number;
  /** "static" loads at runtime; "type" is erased; "dynamic" is an `import()` call. */
  kind: "static" | "type" | "dynamic";
}

/** Every import, re-export and `import()` in one source text, classified. */
export function moduleImports(file: string, text: string): ModuleImport[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports: ModuleImport[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(node),
        kind: loadsAtRuntime(node) ? "static" : "type",
      });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) {
        imports.push({ specifier: argument.text, line: lineOf(node), kind: "dynamic" });
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) {
      imports.push({ specifier: node.argument.literal.text, line: lineOf(node), kind: "type" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

export interface ImportGraph {
  files: string[];
  /** Static value-import edges, importer -> imported, both repo-relative. */
  edges: Map<string, string[]>;
  /** Every classified import of every file, for the boundary rules. */
  imports: Map<string, ModuleImport[]>;
  /** `@/` or relative specifiers that resolved to no file: a resolver gap, never silently dropped. */
  unresolved: string[];
}

/** Build the graph from the files given (repo-relative); defaults to all production source. */
export function buildImportGraph(
  files: string[] = productionSourceFiles(),
  read: (file: string) => string = (file) => readFileSync(path.join(ROOT, file), "utf8"),
): ImportGraph {
  const edges = new Map<string, string[]>();
  const imports = new Map<string, ModuleImport[]>();
  const unresolved: string[] = [];
  for (const file of files) {
    const found = moduleImports(file, read(file));
    imports.set(file, found);
    const targets = new Set<string>();
    for (const entry of found) {
      if (entry.kind !== "static" || ASSET.test(entry.specifier)) continue;
      if (!entry.specifier.startsWith("@/") && !entry.specifier.startsWith(".")) continue;
      const target = resolveSpecifier(file, entry.specifier);
      if (target === null) unresolved.push(`${file}:${entry.line} -> ${entry.specifier}`);
      else targets.add(target);
    }
    edges.set(file, [...targets].sort());
  }
  return { files, edges, imports, unresolved };
}

/**
 * Every import cycle: each strongly connected component of more than one
 * module, or a module that imports itself, as a sorted list of paths
 * (Tarjan's algorithm, iterative so a deep chain cannot overflow the stack).
 */
export function importCycles(edges: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let next = 0;

  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; child: number }> = [{ node: root, child: 0 }];
    index.set(root, next);
    low.set(root, next);
    next += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const targets = edges.get(frame.node) ?? [];
      if (frame.child < targets.length) {
        const target = targets[frame.child]!;
        frame.child += 1;
        if (!index.has(target)) {
          index.set(target, next);
          low.set(target, next);
          next += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, child: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.node);
      if (component.length > 1 || targets.includes(frame.node)) cycles.push(component.sort());
    }
  }
  return cycles.sort((a, b) => a[0]!.localeCompare(b[0]!));
}
