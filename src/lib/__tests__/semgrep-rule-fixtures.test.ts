import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * `semgrep --test` passes vacuously when a fixture goes missing (#2686).
 *
 * The `Static analysis gate` job runs `semgrep --test --config .semgrep/rules
 * .semgrep/tests` before the blocking scan, and that step is what is supposed to
 * notice a custom rule which has quietly stopped matching — a rule that matches
 * nothing scans clean, which reads exactly like a rule that found nothing.
 *
 * Measured, the step does not do that on its own:
 *
 *   * emptying `.semgrep/tests/` exits 0 with "No unit tests found";
 *   * adding a third rule with no fixture exits 0 with "2/2 tests passed".
 *
 * So deleting a fixture, or adding a rule and forgetting one, is green twice
 * over — and nothing else looks at that directory, because this pull request
 * excludes `.semgrep/**` from tsconfig, eslint and knip for good reasons.
 *
 * This suite is the missing half: it asserts the fixture EXISTS and covers each
 * rule id in both directions. `semgrep --test` then checks the fixtures are
 * right; this checks they are there.
 */

const RULES_DIR = ".semgrep/rules";
const TESTS_DIR = ".semgrep/tests";

function repoPath(relativePath: string) {
  // Test helper: fixed repo-relative paths, not user input.
  return path.resolve(process.cwd(), relativePath);
}

function read(relativePath: string) {
  return readFileSync(repoPath(relativePath), "utf8");
}

/** Rule ids declared in a rules file, in declaration order. */
function ruleIds(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

const ruleFiles = readdirSync(repoPath(RULES_DIR))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

const fixtureFiles = readdirSync(repoPath(TESTS_DIR)).sort();

describe("Semgrep custom rules carry live fixtures (#2686)", () => {
  it("has at least one rule file, so an emptied rules directory is not a silent pass", () => {
    expect(ruleFiles.length).toBeGreaterThan(0);
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  it.each(ruleFiles)("%s has a same-basename fixture file", (ruleFile) => {
    const base = ruleFile.replace(/\.ya?ml$/, "");
    // `semgrep --test` pairs a rule file with a fixture of the same BASENAME,
    // any extension. A fixture named anything else is invisible to it.
    // `<base>.<one extension>` only. An earlier version accepted any name
    // starting `<base>.`, so renaming the fixture to `<base>.tsx.bak` — which is
    // exactly how a fixture gets parked and forgotten — left this guard green
    // while `semgrep --test` no longer had anything to run. Found by
    // mutation-testing this test.
    const match = fixtureFiles.filter((name) =>
      new RegExp(`^${escapeForRegExp(base)}\\.[^.]+$`).test(name),
    );
    expect(
      match,
      `${TESTS_DIR}/${base}.* is missing, so ${RULES_DIR}/${ruleFile} is untested and semgrep --test still exits 0`,
    ).not.toHaveLength(0);
  });

  it.each(ruleFiles)("%s declares rule ids, each covered both ways", (ruleFile) => {
    const yaml = read(`${RULES_DIR}/${ruleFile}`);
    const ids = ruleIds(yaml);
    expect(ids.length, `${ruleFile} declares no rule id`).toBeGreaterThan(0);

    const base = ruleFile.replace(/\.ya?ml$/, "");
    const fixtureName = fixtureFiles.find((name) =>
      new RegExp(`^${escapeForRegExp(base)}\\.[^.]+$`).test(name),
    );
    expect(fixtureName).toBeDefined();
    const fixture = read(`${TESTS_DIR}/${fixtureName}`);

    for (const id of ids) {
      // A `ruleid:` line the rule must report...
      expect(
        fixture,
        `${fixtureName} has no "ruleid: ${id}" line, so nothing proves ${id} still matches anything`,
      ).toMatch(new RegExp(`ruleid:[^\\n]*${escapeForRegExp(id)}(?![\\w-])`));
      // ...and an `ok:` line it must not. Without one, a rule that has become
      // "report everything" is as green as a correct one.
      expect(
        fixture,
        `${fixtureName} has no "ok: ${id}" line, so nothing proves ${id} is not simply reporting everything`,
      ).toMatch(new RegExp(`ok:[^\\n]*${escapeForRegExp(id)}(?![\\w-])`));
    }
  });

  it("keeps every fixture out of the blocking scan, in the rule and in the workflow", () => {
    // Every file under `.semgrep/tests/` is a deliberate violation. If the scan
    // reads them, the gate is permanently red on its own fixtures; the exclusion
    // therefore lives in BOTH places, because either one alone is a single point
    // of failure.
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toContain("--exclude .semgrep/tests");
    for (const ruleFile of ruleFiles) {
      const yaml = read(`${RULES_DIR}/${ruleFile}`);
      expect(yaml, `${ruleFile} does not exclude its own fixtures`).toContain(
        "/.semgrep/tests/**",
      );
      // Anchored globs only. An unanchored `paths.exclude` glob is deprecated
      // under Semgrepignore v2 and prints a warning on every single run, which
      // is how a real warning gets lost.
      expect(yaml, `${ruleFile} has an unanchored paths.exclude glob`).not.toMatch(
        /^\s+- (?!\/)(?!")e2e\//m,
      );
    }
  });
});

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
