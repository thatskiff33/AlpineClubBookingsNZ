import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  isCodeBearing,
  validateChangelogFragment,
} from "./check-pr-changelog-fragment.mjs";
import { gitDiffChangedFiles, parseNameStatus } from "./pr-body.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A throwaway two-commit repo whose second commit adds `relPath`. Used with a
 * non-ASCII path to prove the gate reads git's raw bytes: `core.quotePath` is
 * set to git's DEFAULT (true) locally, so the `-c core.quotePath=false` in
 * `gitDiffChangedFiles` — a command-line `-c` beats local config — is the only
 * thing keeping the path from arriving C-quoted as `"src/lib/caf\303\251.ts"`.
 * The same fixture exists in `check-pr-concurrency-declaration.test.mjs`.
 */
function makeRepoAdding(relPath) {
  const root = mkdtempSync(join(tmpdir(), "quoted-path-gate-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.email", "gate-test@example.invalid");
  git("config", "user.name", "Gate Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.quotePath", "true");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");
  mkdirSync(join(root, dirname(relPath)), { recursive: true });
  writeFileSync(join(root, relPath), "export const value = 1;\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "add file");
  return root;
}

/** Shorthand: turn `"A src/lib/x.ts"` pairs into diff records. */
function changes(...pairs) {
  return pairs.map((pair) => {
    const [status, path] = pair.split(" ");
    return { status, path };
  });
}

const SOURCE_CHANGE = changes("M src/lib/booking-cancel.ts");
const EMPTY_BODY = "## Summary\n\n- something\n";

describe("PR changelog fragment gate", () => {
  it("passes a docs-only PR with no fragment and no marker", () => {
    expect(
      validateChangelogFragment(EMPTY_BODY, changes("M docs/ARCHITECTURE.md", "M README.md"))
        .outcome,
    ).toBe("not-code-bearing");
  });

  it("passes a test-only PR even though the paths sit under src/", () => {
    expect(
      validateChangelogFragment(
        EMPTY_BODY,
        changes("M src/lib/__tests__/booking-cancel.test.ts", "A src/lib/x.spec.ts"),
      ).outcome,
    ).toBe("not-code-bearing");
  });

  it("passes a workflow-only PR", () => {
    expect(
      validateChangelogFragment(EMPTY_BODY, changes("M .github/workflows/ci.yml")).outcome,
    ).toBe("not-code-bearing");
  });

  it("passes a code-bearing PR that adds a fragment", () => {
    expect(
      validateChangelogFragment(
        EMPTY_BODY,
        changes("M src/lib/booking-cancel.ts", "A changelog.d/2448-tolerant-reads.md"),
      ).outcome,
    ).toBe("fragment-added");
  });

  it("does not take an after-deploy step for a changelog entry (#5379)", () => {
    expect(() =>
      validateChangelogFragment(
        EMPTY_BODY,
        changes("M src/lib/booking-cancel.ts", "A changelog.d/2448-run-report.deploy.md"),
      ),
    ).toThrow(/needs a changelog entry/);
  });

  it("passes a code-bearing PR whose body carries the no-entry marker", () => {
    for (const marker of [
      "changelog: none",
      "- changelog: none — pure internal refactor.",
      "**Changelog: none** (no user-visible behaviour).",
      "> changelog:none",
    ]) {
      expect(
        validateChangelogFragment(`## Summary\n\n${marker}\n`, SOURCE_CHANGE).outcome,
      ).toBe("none-marker");
    }
  });

  it("does not accept the marker words buried in ordinary prose", () => {
    expect(() =>
      validateChangelogFragment(
        "We talked about the changelog: none of the reviewers wanted one.\n",
        SOURCE_CHANGE,
      ),
    ).toThrow(/needs a changelog entry/);
  });

  // TRANSITION GRACE (#2452). Delete this test together with the
  // `legacy-changelog-edit` branch when the grace is tightened.
  it("accepts a direct CHANGELOG.md edit during the transition", () => {
    expect(
      validateChangelogFragment(EMPTY_BODY, changes("M src/lib/booking-cancel.ts", "M CHANGELOG.md"))
        .outcome,
    ).toBe("legacy-changelog-edit");
  });

  it("fails a code-bearing PR with no fragment, no marker and no CHANGELOG edit", () => {
    expect(() => validateChangelogFragment(EMPTY_BODY, SOURCE_CHANGE)).toThrow(
      /needs a changelog entry/,
    );
  });

  it("fails a schema or migration PR with no entry", () => {
    expect(() =>
      validateChangelogFragment(
        EMPTY_BODY,
        changes("M prisma/schema.prisma", "A prisma/migrations/20260801_x/migration.sql"),
      ),
    ).toThrow(/needs a changelog entry/);
  });

  it("does not credit a PR that only deletes fragments", () => {
    expect(() =>
      validateChangelogFragment(
        EMPTY_BODY,
        changes("M src/lib/booking-cancel.ts", "D changelog.d/2448-tolerant-reads.md"),
      ),
    ).toThrow(/needs a changelog entry/);
  });

  it("does not accept the convention README as a fragment", () => {
    expect(() =>
      validateChangelogFragment(
        EMPTY_BODY,
        changes("M src/lib/booking-cancel.ts", "A changelog.d/README.md"),
      ),
    ).toThrow(/needs a changelog entry/);
  });

  it("treats a rename out of src/ as a source change", () => {
    const renamed = parseNameStatus("R100\tsrc/lib/old.ts\tsrc/lib/new.ts\n");
    expect(renamed).toEqual([
      { status: "D", path: "src/lib/old.ts" },
      { status: "A", path: "src/lib/new.ts" },
    ]);
    expect(() => validateChangelogFragment(EMPTY_BODY, renamed)).toThrow(
      /needs a changelog entry/,
    );
  });

  it("parses name-status output, ignoring blank lines", () => {
    expect(parseNameStatus("M\tsrc/a.ts\nA\tchangelog.d/1-x.md\n\nD\tsrc/b.ts\n")).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "A", path: "changelog.d/1-x.md" },
      { status: "D", path: "src/b.ts" },
    ]);
  });

  it("classifies code-bearing paths", () => {
    expect(isCodeBearing(["src/app/page.tsx"])).toBe(true);
    expect(isCodeBearing(["prisma/schema.prisma"])).toBe(true);
    expect(isCodeBearing(["docs/x.md", "scripts/ci/y.mjs", "e2e/z.spec.ts"])).toBe(false);
    expect(isCodeBearing(["src/lib/__tests__/a.test.ts"])).toBe(false);
  });

  /*
    A gate that cannot see a file cannot judge it. Git quotes any path with a
    non-ASCII byte by default, so `src/lib/café.ts` reaches the gate as
    `"src/lib/caf\303\251.ts"` — which `^(?:src|prisma)/` does not match. The PR
    then looks like it changed no application source and is waved through with
    no changelog entry at all. Real git, real accented filename, real diff.
  */
  it("classifies a non-ASCII source path instead of failing open on git's quoting", () => {
    const root = makeRepoAdding("src/lib/café.ts");
    try {
      const raw = gitDiffChangedFiles("HEAD~1", "HEAD", { cwd: root });
      expect(raw).toContain("src/lib/café.ts");
      expect(raw).not.toContain("\\303");
      const parsed = parseNameStatus(raw);
      expect(parsed).toEqual([{ status: "A", path: "src/lib/café.ts" }]);
      expect(isCodeBearing(parsed.map((change) => change.path))).toBe(true);
      expect(() => validateChangelogFragment(EMPTY_BODY, parsed)).toThrow(
        /needs a changelog entry/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The marker must never be pre-filled into the template: a body that always
  // contains it would silently disable the gate for every PR.
  it("keeps the no-entry marker out of the pull request template", () => {
    const template = readFileSync(resolve(repoRoot, ".github/pull_request_template.md"), "utf8");
    expect(() => validateChangelogFragment(template, SOURCE_CHANGE)).toThrow(
      /needs a changelog entry/,
    );
  });
});
