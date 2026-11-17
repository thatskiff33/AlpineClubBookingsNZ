import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
  #5252: the reviewed picomatch patches are really applied, on every path the
  mitigation record covers.

  The record dependency-mitigations.d/5252-picomatch-ghsa-fc5q-39xc-vjpf.json
  lets the audit say MITIGATED only while pnpm applies patches/picomatch@*.patch.
  This suite fails if a covered copy stops resolving to the patched install, or
  if the patched parser stops collapsing the advisory's single-branch repeated
  extglobs. It asserts the generated regular expressions, not timings, so it
  never depends on machine speed, and it only runs the long PoC input after the
  regex assertions have passed, so an unpatched copy fails fast instead of
  hanging.

  Retire this file with the record (dependency-mitigations.d/README.md ->
  "Retiring a record").
*/

/** The parts of a mitigation record this suite reads. */
type CoveredCopy = { version: string; dev: boolean; patch: { path: string; sha256: string }; auditPaths: string[] };
type MitigationRecord = { covers: CoveredCopy[] };

/** The parts of picomatch's API this suite calls. */
type Picomatch = {
  makeRe: (pattern: string, options?: Record<string, unknown>) => RegExp;
  isMatch: (input: string, pattern: string, options?: Record<string, unknown>) => boolean;
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECORD = path.join(REPO, "dependency-mitigations.d", "5252-picomatch-ghsa-fc5q-39xc-vjpf.json");
const record = JSON.parse(readFileSync(RECORD, "utf8")) as MitigationRecord;

/**
 * The installed directory of `name` as Node would find it from `fromDir`: the
 * nearest `node_modules/<name>` walking up, followed through pnpm's symlinks.
 * Read from the directory layout rather than `require.resolve`, because a
 * package's `exports` may not expose its `package.json`.
 */
function packageDir(fromDir: string, name: string): string {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    if (path.dirname(dir) === dir) throw new Error(`${name} is not resolvable from ${fromDir}`);
  }
}

/** Follows one `pnpm audit` path (".>a>b>picomatch") from the repository root. */
function resolveAuditPath(auditPath: string): string {
  const names = auditPath.split(">").slice(1);
  return names.reduce<string>((dir, name) => packageDir(dir, name), REPO);
}

const copies = record.covers.map((copy) => {
  const dirs = new Set(copy.auditPaths.map(resolveAuditPath));
  return { ...copy, dirs: [...dirs] };
});

describe("every covered path resolves to the patched install of its recorded version", () => {
  it.each(copies.map((copy) => [copy.version, copy] as const))("picomatch@%s", (version, copy) => {
    expect(copy.dirs).toHaveLength(1);
    const [dir] = copy.dirs;
    expect(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version).toBe(version);
    // pnpm names a patched install after the patch file's SHA256, which the
    // record binds and the lockfile records.
    expect(dir).toContain(`patch_hash=${copy.patch.sha256}`);
  });
});

describe("the patched parser collapses single-branch repeated extglobs (GHSA-fc5q-39xc-vjpf)", () => {
  // The advisory's own patterns and the shapes upstream #246 covers.
  const covered = ["+(*)", "+(*a)", "*(*a)", "+(a*)", "+(a*b)", "*(*.js)", "+(*a)c", "x+(*a)y", "+(*)/x"];

  it.each(copies.map((copy) => [copy.version, copy] as const))("picomatch@%s", (_version, copy) => {
    const picomatch = createRequire(path.join(copy.dirs[0], "package.json"))(copy.dirs[0]) as Picomatch;

    expect(picomatch.makeRe("+(*a)").source).toBe("^(?:(?=.)(?:[^/]*?a))$");
    expect(picomatch.makeRe("*(*a)").source).toBe("^(?:(?=.)(?:[^/]*?a)?)$");
    for (const pattern of covered) {
      // No group closes into an unbounded repetition: the nested quantifier
      // that backtracks exponentially is gone.
      expect(picomatch.makeRe(pattern).source, pattern).not.toMatch(/\)[+*]/);
    }
    // Capture mode cannot collapse without changing captures, so it takes the
    // existing literal fallback rather than the backtracking expression.
    expect(picomatch.makeRe("+(*a)", { capture: true }).test("aaa")).toBe(false);
    // The opt-out still restores the unguarded expression.
    expect(picomatch.makeRe("+(*a)", { maxExtglobRecursion: false }).source).toMatch(/\)\+/);

    // Matching is unchanged for ordinary input...
    expect(picomatch.isMatch("aaa", "+(*a)")).toBe(true);
    expect(picomatch.isMatch("ab", "+(*a)")).toBe(false);
    expect(picomatch.isMatch("foo.js", "*(*.js)")).toBe(true);
    expect(picomatch.isMatch("axbayb", "+(a*b)")).toBe(true);
    // ...and the PoC input now answers at once (unpatched, 32 characters took
    // over five seconds when measured for #5252; 64 would not finish).
    expect(picomatch.isMatch(`${"a".repeat(64)}!`, "+(*a)")).toBe(false);
    expect(picomatch.isMatch(`${"a".repeat(64)}!`, "+(*)/x")).toBe(false);
  });
});
