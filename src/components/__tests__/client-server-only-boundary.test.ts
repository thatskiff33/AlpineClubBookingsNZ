import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No `"use client"` module may reach `import "server-only"`, however many hops away.
 *
 * ## Why this is a test and not a lint rule we already had
 *
 * Next registers a build-time error for exactly this
 * (`next-invalid-import-error-loader` in
 * `node_modules/next/dist/build/webpack-config.js`: "'server-only' cannot be imported
 * from a Client Component module"), and if a build ever got past it the client chunk
 * would throw on evaluation, because `node_modules/server-only/index.js` is a bare
 * `throw` — so an admin opening the affected screen gets a blank page.
 *
 * Nothing cheaper catches it. `pnpm run lint`, `pnpm run typecheck` and `pnpm run knip`
 * are all clean on the violation, and every Vitest file has `server-only` mocked away
 * globally by `vitest.setup.ts`, so a component test renders the offending component
 * happily. That is how #2573's first cut shipped a `"use client"` admin card importing
 * two constants and an href from two `server-only` modules: the only gate that saw it
 * was the build, minutes into CI.
 *
 * ## What counts as an import here
 *
 * Value imports and bare side-effect imports, following the `@/` alias — because those
 * are what survive into the bundle. A `import type { … }` clause is elided by
 * TypeScript and does NOT drag the module in, so it is skipped; that is exactly how a
 * client component may keep using a server module's TYPES, which several do.
 *
 * A violation is reported with the full chain, because the fix depends on where the
 * chain bends: usually the client-safe half of the leaf module belongs in a sibling
 * without the `server-only` marker (`src/lib/analytics-settings-shared.ts`,
 * `src/lib/site-banner-shared.ts`), leaving the database and logger reads behind.
 */

const SRC_ROOT = path.join(process.cwd(), "src");

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(entryPath);
    }
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function toRepoPath(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath).split(path.sep).join("/");
}

/**
 * Resolve a `@/…` specifier to a real file. The alias maps to `src/`, and a
 * directory-shaped specifier resolves through its `index` file, as the bundler does.
 */
function resolveAliasImport(specifier: string): string | null {
  const withoutAlias = specifier.slice(2);
  const base = path.join(SRC_ROOT, withoutAlias);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * Every module this one pulls into the bundle: `@/…` imports that are NOT type-only,
 * plus the bare `server-only` marker itself.
 *
 * Deliberately regex-based rather than a real parse. The shapes in this repo are
 * ordinary top-of-file ESM (`import x from "…"`, `import { a, b } from "…"`,
 * `import "…"`, `export … from "…"`), and a parser dependency for the sake of the
 * exotic cases would make the guard slower to run and harder to trust.
 */
const IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import|export)\s+(?:(type)\s+)?([^;'"]*?)?["']([^"']+)["']/g;

function bundledImportsOf(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const [, typeKeyword, clause, specifier] = match;
    if (typeKeyword) continue; // `import type { … } from` — elided, never bundled.
    // `import { type A, type B } from "…"`: only inline type specifiers, so nothing
    // of the module survives compilation either. A clause that names even one value
    // does bundle it.
    if (clause && /^\s*\{[^}]*\}\s*(from\s*)?$/.test(clause)) {
      const names = clause
        .replace(/^[\s{]*/, "")
        .replace(/[\s}]*(from\s*)?$/, "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      if (names.length > 0 && names.every((name) => name.startsWith("type "))) {
        continue;
      }
    }
    if (specifier === "server-only" || specifier.startsWith("@/")) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

const sourceFiles = listSourceFiles(SRC_ROOT);
const sources = new Map<string, string>();
for (const file of sourceFiles) {
  sources.set(file, fs.readFileSync(file, "utf8"));
}

const clientModules = sourceFiles.filter((file) =>
  /^\s*(?:\/\/[^\n]*\n\s*)*["']use client["']/.test(sources.get(file) ?? ""),
);

/**
 * The chain from `entry` to a `server-only` import, or `null` when there is none.
 * Breadth-first so the shortest chain is the one reported.
 */
function findServerOnlyChain(entry: string): string[] | null {
  const queue: Array<{ file: string; chain: string[] }> = [
    { file: entry, chain: [toRepoPath(entry)] },
  ];
  const seen = new Set<string>([entry]);

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    const source = sources.get(file);
    if (source === undefined) continue;

    for (const specifier of bundledImportsOf(source)) {
      if (specifier === "server-only") {
        return [...chain, 'import "server-only"'];
      }
      const resolved = resolveAliasImport(specifier);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push({ file: resolved, chain: [...chain, toRepoPath(resolved)] });
    }
  }

  return null;
}

describe("client/server-only module boundary (#2573)", () => {
  it("finds the client modules to check, so a broken scan cannot pass vacuously", () => {
    // The mutation guard for this file: if the `"use client"` detection ever stops
    // matching, every assertion below would pass over an empty set.
    expect(clientModules.length).toBeGreaterThan(300);
    expect(clientModules.map(toRepoPath)).toContain(
      "src/components/admin/analytics-integration-card.tsx",
    );
  });

  it("resolves the alias and follows a chain, proving the walker works", () => {
    // A known-good chain: this client card imports the client-safe shared module,
    // which must NOT reach `server-only` …
    expect(
      findServerOnlyChain(
        path.join(SRC_ROOT, "components/admin/analytics-integration-card.tsx"),
      ),
    ).toBeNull();
    // … while the server module beside it does, one hop in. If this stops finding a
    // chain, the walker has gone blind and the assertion below means nothing.
    expect(
      findServerOnlyChain(path.join(SRC_ROOT, "lib/analytics-settings.ts")),
    ).toEqual(["src/lib/analytics-settings.ts", 'import "server-only"']);
  });

  it("has no client module that transitively imports server-only", () => {
    const violations = clientModules
      .map((file) => ({ file: toRepoPath(file), chain: findServerOnlyChain(file) }))
      .filter((entry): entry is { file: string; chain: string[] } =>
        Boolean(entry.chain),
      )
      .map((entry) => entry.chain.join(" -> "));

    expect(violations).toEqual([]);
  });
});
