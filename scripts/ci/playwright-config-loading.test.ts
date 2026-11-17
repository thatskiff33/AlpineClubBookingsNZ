import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "../../src/lib/__tests__/support/strip-comments";

// Playwright loads playwright.config.ts, and every local module it imports,
// through its CommonJS transform: `import` becomes `require`, but `import.meta`
// is left as is and throws "Cannot use 'import.meta' outside a module" before a
// single test runs. Vitest loads the config as ESM, so importing it in a test
// cannot see the failure; this census walks the config's local import graph
// instead (#4991, where a CLI guard reached the config and broke every E2E job).

const CONFIG = path.resolve("playwright.config.ts");
const LOCAL_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']|(?:^|\n)\s*import\s+["'](\.{1,2}\/[^"']+)["']/g;

function resolveLocal(from: string, specifier: string): string {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.mts`, `${base}.mjs`, `${base}.js`]) {
    if (existsSync(candidate) && !candidate.endsWith(".d.mts")) return candidate;
  }
  throw new Error(`${path.relative(process.cwd(), from)} imports ${specifier}, which does not resolve`);
}

/** Source without comments, which the transform keeps but never runs. */
const code = (file: string) => stripComments(readFileSync(file, "utf8"));

/** Every local module playwright.config.ts loads, the config included. */
function configImportGraph(): string[] {
  const seen = new Set<string>();
  const queue = [CONFIG];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(LOCAL_IMPORT)) {
      queue.push(resolveLocal(file, (match[1] ?? match[2]) as string));
    }
  }
  return [...seen].map((file) => path.relative(process.cwd(), file).split(path.sep).join("/")).sort();
}

describe("modules Playwright loads with playwright.config.ts", () => {
  const graph = configImportGraph();

  it("finds the config's local imports, including the shared results path", () => {
    expect(graph).toContain("playwright.config.ts");
    expect(graph).toContain("scripts/ci/e2e-spec-shard.mjs");
    expect(graph).toContain("scripts/ci/playwright-results-file.mjs");
  });

  it("ignores comments, so only executable import.meta fails", () => {
    expect(code("scripts/ci/escape-regex.mjs")).not.toMatch(/\bimport\.meta\b/);
    expect(code("scripts/ci/summarise-playwright-flaky.mjs")).toMatch(/\bimport\.meta\b/);
  });

  it("never reaches a CLI entry such as the flaky summariser", () => {
    expect(graph).not.toContain("scripts/ci/summarise-playwright-flaky.mjs");
  });

  it.each(graph)("%s uses no import.meta, which Playwright's CommonJS transform cannot load", (file) => {
    expect(code(file)).not.toMatch(/\bimport\.meta\b/);
  });
});
