/**
 * `.github/CODEOWNERS` cannot rot (#3341).
 *
 * The file is the mechanical half of the money gate: once "Require review from
 * Code Owners" is on for `main`, a pull request touching a listed path needs the
 * owner's Approve. GitHub never complains about a pattern that matches nothing —
 * it simply stops gating — so a renamed money module would silently leave the
 * gate while the file still read as complete. This census makes that loud, and
 * holds the file to the money surface the issue scoped it to.
 *
 * `git ls-files` is the instrument, because CODEOWNERS is evaluated against the
 * files a pull request changes, which are tracked files. It reads the index, so
 * a shallow CI checkout answers it exactly as a full one does.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const OWNER = "@thatskiff33";

/**
 * The ceiling on the owned share of non-test `src/lib` TypeScript. Measured at
 * 94 of 1132 files (8.3%) when this landed; #3341 scoped the surface at "about
 * 7%" and said a materially larger share means the globs have gone too broad.
 * A ceiling rather than an exact count, so an ordinary new money module does not
 * red the build — but a glob that starts sweeping in unrelated code does.
 */
const MAX_OWNED_SRC_LIB_SHARE = 0.1;

interface Rule {
  readonly pattern: string;
  readonly owners: readonly string[];
  readonly line: number;
}

function rules(): Rule[] {
  return readFileSync(path.join(ROOT, ".github", "CODEOWNERS"), "utf8")
    .split("\n")
    .map((text, index) => ({ text: text.trim(), line: index + 1 }))
    .filter(({ text }) => text !== "" && !text.startsWith("#"))
    .map(({ text, line }) => {
      const [pattern, ...owners] = text.split(/\s+/);
      return { pattern, owners, line };
    });
}

/**
 * A CODEOWNERS pattern as GitHub reads it (gitignore syntax): `*` and `?` stay
 * inside one path segment, `**` crosses them, and a pattern naming a directory
 * owns everything beneath it. Only anchored patterns are allowed here, so the
 * unanchored "match at any depth" rule is deliberately not implemented.
 */
function matcher(pattern: string): RegExp {
  const body = pattern
    .slice(1)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${body}(?:/.*)?$`);
}

const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean);

describe(".github/CODEOWNERS covers the money surface and nothing stale (#3341)", () => {
  it("anchors every pattern and names the one owner", () => {
    const malformed = rules()
      .filter((rule) => !rule.pattern.startsWith("/") || rule.owners.join(" ") !== OWNER)
      .map((rule) => `line ${rule.line}: ${rule.pattern} ${rule.owners.join(" ")}`);
    expect(
      malformed,
      `Every CODEOWNERS rule is an anchored path owned by ${OWNER} alone. An unanchored pattern matches at any depth, which is how a money glob quietly starts owning unrelated code.`,
    ).toEqual([]);
  });

  it("matches at least one tracked file with every pattern", () => {
    const dead = rules()
      .filter((rule) => !tracked.some((file) => matcher(rule.pattern).test(file)))
      .map((rule) => `line ${rule.line}: ${rule.pattern}`);
    expect(
      dead,
      "These CODEOWNERS patterns match no tracked file, so they gate nothing. A money module was probably renamed or moved: point the pattern at its new path in the same pull request rather than deleting the line.",
    ).toEqual([]);
  });

  it("owns the guards that enforce the money gate, including itself", () => {
    const owned = (file: string) => rules().some((rule) => matcher(rule.pattern).test(file));
    for (const guard of [
      ".github/CODEOWNERS",
      "src/lib/__tests__/money-seam-mock-census.test.ts",
      "src/lib/__tests__/superseded-additional-ask-integration.test.ts",
      "src/lib/__tests__/codeowners-census.test.ts",
    ]) {
      expect(tracked, `${guard} must be tracked`).toContain(guard);
      expect(owned(guard), `${guard} must be code-owned, or a PR can weaken the gate unreviewed`).toBe(true);
    }
  });

  it("stays scoped: the owned share of non-test src/lib TypeScript is under the ceiling", () => {
    const srcLib = tracked.filter(
      (file) =>
        /^src\/lib\/.+\.tsx?$/.test(file) &&
        !file.includes("/__tests__/") &&
        !/\.(?:test|spec)\.tsx?$/.test(file),
    );
    const patterns = rules().map((rule) => matcher(rule.pattern));
    const owned = srcLib.filter((file) => patterns.some((pattern) => pattern.test(file)));
    // Non-vacuous: the money modules are really in the owned set.
    expect(owned).toContain("src/lib/booking-payment-cleanup.ts");
    expect(owned).toContain("src/lib/payment-transactions.ts");
    expect(
      owned.length / srcLib.length,
      `CODEOWNERS now owns ${owned.length} of ${srcLib.length} non-test src/lib files. #3341 scoped the money gate at about 7%; a share above ${MAX_OWNED_SRC_LIB_SHARE * 100}% means a glob has gone too broad — tighten it rather than raising this ceiling.`,
    ).toBeLessThanOrEqual(MAX_OWNED_SRC_LIB_SHARE);
  });
});
