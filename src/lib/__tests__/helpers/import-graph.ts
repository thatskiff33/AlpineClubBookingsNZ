import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/*
 * The runtime import graph of this repository's own files, for a census that
 * asks whether an entrypoint can reach a module (#5407: shared by the CLI and
 * E2E `server-only` censuses, so the two walk the graph the same way).
 */

export const REPO_ROOT = path.resolve(process.cwd());
const SRC = path.join(REPO_ROOT, "src");
export const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/**
 * Runtime module specifiers, static and dynamic.
 *
 * `import type` / `export type` are erased before anything executes. The
 * negative lookahead is `type[\s{]` rather than `type\s` because TypeScript
 * accepts `import type{ Session } from …` with no space — the same spelling
 * `client-server-boundary-census.test.ts` and the matching Semgrep rule use.
 */
const STATIC_IMPORT =
  /^[ \t]*(?:import|export)\s+(?!type[\s{])(?:[^;'"]*?\bfrom\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /(?:\bimport|\brequire)\s*\(\s*["']([^"']+)["']\s*\)/g;

/** A repository-relative path with forward slashes. */
export function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

const specifierCache = new Map<string, string[]>();
/** Every runtime specifier a file imports, static and dynamic. */
export function specifiersOf(file: string): string[] {
  const cached = specifierCache.get(file);
  if (cached) return cached;
  const text = readFileSync(file, "utf8");
  const value = [
    ...[...text.matchAll(STATIC_IMPORT)].map((match) => match[1]),
    ...[...text.matchAll(DYNAMIC_IMPORT)].map((match) => match[1]),
  ];
  specifierCache.set(file, value);
  return value;
}

/** Resolve a specifier to a file inside this repository, or `null`. */
export function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }
  for (const extension of ["", ...EXTENSIONS]) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const extension of EXTENSIONS) {
    const candidate = path.join(base, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The shortest import path from `entry` to any of `targets` (bare specifiers),
 * breadth-first, or `null` when none is reachable.
 */
export function findReach(entry: string, targets: Set<string>): string[] | null {
  const seen = new Set<string>([entry]);
  const queue: Array<{ file: string; trail: string[] }> = [
    { file: entry, trail: [entry] },
  ];
  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    for (const specifier of specifiersOf(file)) {
      if (targets.has(specifier)) return [...trail, specifier];
      const next = resolveSpecifier(file, specifier);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push({ file: next, trail: [...trail, next] });
      }
    }
  }
  return null;
}

/** A trail from `findReach`, one step a line. */
export function describeTrail(trail: string[]): string {
  return trail
    .map((step) => (step.startsWith(REPO_ROOT) ? relative(step) : step))
    .join("\n    -> ");
}
