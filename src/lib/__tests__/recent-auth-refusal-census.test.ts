/**
 * #4616 (INV-AUTH-008): only `requireRecentAuth` may send the step-up refusal.
 *
 * The "confirm it's you" dialog REPLAYS any request answered with
 * `RECENT_AUTH_REQUIRED`. That is safe only because the one function that
 * sends it runs before any side effect or body read, so the refusal means
 * nothing happened. A second emitter — a route building the body by hand, or a
 * helper that re-exports it — could refuse after acting, and the replay would
 * act twice. So the code's name and its spelling may appear in exactly two
 * production files: the pure module that defines and recognises it, and
 * `recent-auth.ts`, whose private builder only `requireRecentAuth` calls.
 *
 * Reads source from disk, so `test:related` cannot select it: run it by name
 * when the refusal or a step-up route moves.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const srcRoot = path.join(repoRoot, "src");

const ALLOWED = new Set(["src/lib/recent-auth-policy.ts", "src/lib/recent-auth.ts"]);

function productionSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules" ? [] : productionSources(full);
    }
    return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)
      ? [full]
      : [];
  });
}

function relative(file: string) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

describe("the step-up refusal has one emitter (#4616)", () => {
  const files = productionSources(srcRoot);

  it("walks the production tree, including both allowed files", () => {
    const walked = new Set(files.map(relative));
    expect(walked.size).toBeGreaterThan(500);
    for (const allowed of ALLOWED) expect(walked.has(allowed)).toBe(true);
  });

  it("names the refusal code only in the module that defines it and the one that sends it", () => {
    const naming = files
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return source.includes("RECENT_AUTH_REQUIRED_CODE") || source.includes('"RECENT_AUTH_REQUIRED"');
      })
      .map(relative)
      .sort();
    expect(naming).toEqual([...ALLOWED].sort());
  });

  it("builds the refusal privately in recent-auth.ts and sends it only from requireRecentAuth", () => {
    const source = fs.readFileSync(path.join(srcRoot, "lib", "recent-auth.ts"), "utf8");
    // Defined once, not exported.
    expect(source.match(/function recentAuthRequiredResponse\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+recentAuthRequiredResponse/);
    expect(source).not.toMatch(/export\s*\{[^}]*recentAuthRequiredResponse/);
    // Called once, inside requireRecentAuth.
    const calls = [...source.matchAll(/(?<!function )recentAuthRequiredResponse\(\)/g)];
    expect(calls).toHaveLength(1);
    const guardStart = source.indexOf("export async function requireRecentAuth(");
    const guardEnd = source.indexOf("\n}\n", guardStart);
    expect(guardStart).toBeGreaterThan(-1);
    expect(calls[0]!.index).toBeGreaterThan(guardStart);
    expect(calls[0]!.index).toBeLessThan(guardEnd);
    // The code itself is used once in this file: in that builder.
    expect(source.match(/RECENT_AUTH_REQUIRED_CODE/g)).toHaveLength(2); // import + builder
  });
});
