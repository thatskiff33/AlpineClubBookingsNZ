/**
 * The LIVE surfaces a "no census total comes back" scan reads (#5211).
 *
 * The audit-writer and view-only censuses publish no totals, and each refuses
 * one coming back. Both scan this one list, so neither can cover a place the
 * other misses.
 *
 * Live means a reader takes it as current: the root documents, `docs/`,
 * unreleased `changelog.d/` fragments, and source and script comments.
 * HISTORY is excluded, because a figure in it was true when it was written and
 * nothing should move it: `CHANGELOG.md` (the release compiler's ledger) and
 * `docs/releases/` (release notes and their drafts, compiled from fragments).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const HISTORY = new Set(["CHANGELOG.md", "docs/releases"]);
const SKIPPED_DIRECTORIES = new Set(["__tests__", "generated", "node_modules"]);
const TEXT = /\.(?:md|ts|tsx|mjs)$/;

/** Repository-relative POSIX paths of every live surface, sorted. */
export function liveDocSurfaces(repoRoot: string = process.cwd()): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(repoRoot, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (HISTORY.has(path)) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      } else if (TEXT.test(entry.name)) {
        out.push(path);
      }
    }
  };
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && !HISTORY.has(entry.name)) {
      out.push(entry.name);
    }
  }
  for (const dir of ["docs", "changelog.d", "src", "scripts"]) walk(dir);
  return out.sort();
}
