/**
 * The menu preference never reaches a permission guard (C14 #4811).
 *
 * Walks each guard's import graph, including re-exports and dynamic imports,
 * and fails if `admin-menu-role` is reachable. A hardcoded cookie name in a
 * guard would be the same leak, so the source is checked for that too.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const SWITCHER = path.join(SRC, "lib/admin-menu-role.ts");
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/** Guards that decide access. None of them may reach the menu preference. */
const GUARDS = [
  "src/lib/session-guards.ts",
  "src/lib/admin-layout-guard.ts",
  "src/lib/admin-permissions.ts",
  "src/lib/finance-api-auth.ts",
  "src/lib/finance-auth.ts",
  "src/proxy.ts",
  "src/lib/admin-hubs/security-map.ts",
  "src/lib/two-factor-gate.ts",
];

const RUNTIME_IMPORT =
  /^[ \t]*(?:import|export)\s+(?!type[\s{])(?:[^;'"]*?\bfrom\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /(?:\bimport|\brequire)\s*\(\s*(["'`])([^"'`$]+)\1\s*[,)]/g;

function specifiers(text: string): string[] {
  return [
    ...[...text.matchAll(RUNTIME_IMPORT)].map((match) => match[1]),
    ...[...stripComments(text).matchAll(DYNAMIC_IMPORT)].map((match) => match[2]),
  ];
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }
  for (const ext of ["", ...EXTENSIONS]) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const ext of EXTENSIONS) {
    const candidate = path.join(base, `index${ext}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every file reachable from `start`, including `start`. */
function reachableFrom(start: string): string[] {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of specifiers(source)) {
      const next = resolveSpecifier(file, specifier);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen];
}

describe("permission guards do not import the menu-role switcher", () => {
  it("the switcher module exists, so an empty walk cannot pass", () => {
    expect(existsSync(SWITCHER)).toBe(true);
  });

  it.each(GUARDS)("%s does not reach admin-menu-role", (relative) => {
    const start = path.join(ROOT, relative);
    const reached = reachableFrom(start);
    expect(reached.length).toBeGreaterThan(1);
    expect(reached).not.toContain(SWITCHER);
    const source = readFileSync(start, "utf8");
    expect(source).not.toContain("admin-menu-role");
  });

  it("the layout guard's graph still reaches the permission matrix, so the walk is not blind", () => {
    const reached = reachableFrom(path.join(ROOT, "src/lib/admin-layout-guard.ts"));
    expect(reached).toContain(path.join(SRC, "lib/admin-permissions.ts"));
  });
});
