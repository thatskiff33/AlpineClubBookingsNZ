import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  WHY THIS OVERRIDE EXISTS, AND WHEN TO DELETE IT.

  GHSA-ggr8-5vv4-36mx (published 2026-08-17) is a high-severity stack-exhaustion
  advisory in DeepmergeTS affecting `deepmerge-ts < 8.0.0`. It reaches us only
  through Prisma:

      prisma -> @prisma/config -> deepmerge-ts

  The repository therefore pins a `deepmerge-ts` override — in
  `pnpm-workspace.yaml` since #3673, and in `package.json`'s npm `overrides`
  before that. The reasoning lives here, and more usefully so does the condition
  for removing it.

  It mattered more than a single red check. `verify` ran `Audit dependencies`
  early, and a failure there SKIPS every later step: lint, the file-size ratchet,
  Prisma generate, typecheck, knip, test and build. So the advisory did not just
  turn `main` red, it silently stopped the suite from running on every branch
  while other checks stayed green (#2945). That structural fault is fixed —
  the audit is its own job now (#2946) and an advisory reddens only itself — so
  the blast radius of the next one is a single check. This override still stands
  on its own merits.

  npm's own remedy was `prisma@6.12.0` — a major downgrade of the database
  toolchain to fix a transitive advisory. Rejected.

  THE OVERRIDE IS TEMPORARY. The second test below fails once `@prisma/config`
  itself asks for a fixed version, which is the signal that upstream has shipped
  and this override is now pinning something nobody needs pinned. When it fails:
  delete the override, delete this file, and let the dependency resolve normally.
*/

const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/**
 * The override's range, read from the `overrides:` block of
 * `pnpm-workspace.yaml`. A line-level read rather than a YAML parser, because
 * the repository declares none and the block is flat `name: range` pairs.
 */
function workspaceOverride(name: string): string | undefined {
  const text = readFileSync(path.join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf("overrides:");
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (line !== "" && !/^\s/.test(line)) break; // the next top-level key
    const m = /^\s+["']?([^"':\s]+)["']?:\s*["']?([^"'\s#]+)["']?/.exec(line);
    if (m && m[1] === name) return m[2];
  }
  return undefined;
}

/**
 * Under pnpm's strict layout (#3673) a transitive package is not reachable from
 * the repository root, so resolve along the real edge the advisory travels:
 * `prisma` (declared here) -> `@prisma/config` -> `deepmerge-ts`.
 */
function prismaConfigManifestPath(): string {
  const fromPrisma = createRequire(require_.resolve("prisma/package.json"));
  return fromPrisma.resolve("@prisma/config/package.json");
}

function resolvedDeepmergeManifestPath(): string {
  // deepmerge-ts is ESM and its `exports` map does not expose `./package.json`,
  // so resolve its entry point and walk up to the manifest that names it.
  let dir = path.dirname(createRequire(prismaConfigManifestPath()).resolve("deepmerge-ts"));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
      if (manifest.name === "deepmerge-ts") return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("deepmerge-ts manifest not found above its entry point");
    dir = parent;
  }
}

function major(range: string): number {
  const m = /(\d+)/.exec(range.replace(/^[\^~>=<\s]+/, ""));
  return m ? Number(m[1]) : Number.NaN;
}

describe("the deepmerge-ts override (GHSA-ggr8-5vv4-36mx)", () => {
  it("pins a version that carries the fix", () => {
    const pinned = workspaceOverride("deepmerge-ts");
    expect(
      typeof pinned === "string" ? pinned : undefined,
      "the deepmerge-ts override is gone. If Prisma shipped the fix, the other " +
        "test in this file will say so and this file should be deleted with it; " +
        "if not, the advisory is back and `verify` will stop running its own suite.",
    ).toBeTypeOf("string");

    expect(major(pinned as string)).toBeGreaterThanOrEqual(8);

    // And the tree really resolved to it — an override that does not take is
    // exactly the kind of green that means nothing. Read the copy Prisma
    // actually loads, not whatever a root lookup happens to find.
    const resolved = JSON.parse(
      readFileSync(resolvedDeepmergeManifestPath(), "utf8"),
    ) as { version: string };
    expect(major(resolved.version)).toBeGreaterThanOrEqual(8);
  });

  it("tells us to remove itself once Prisma no longer needs it", () => {
    const config = JSON.parse(
      readFileSync(prismaConfigManifestPath(), "utf8"),
    ) as { version: string; dependencies?: Record<string, string> };

    const wanted = config.dependencies?.["deepmerge-ts"];

    // If @prisma/config stops depending on it at all, or asks for a fixed
    // major itself, the override has done its job.
    expect(
      wanted === undefined || major(wanted) >= 8,
      `@prisma/config@${config.version} still asks for deepmerge-ts@${wanted}, ` +
        "so the override is still load-bearing. When this expectation flips to " +
        "true, DELETE the override from pnpm-workspace.yaml and delete this file.",
    ).toBe(false);
  });
});
