/**
 * #4463: the soft size gate — the changed-line count, its generated-file and
 * lockfile exclusions (read from `.gitattributes`), the `large-pr:` reason, and
 * that it only ever warns.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LARGE_PR_LINE_THRESHOLD,
  countReviewableLines,
  generatedPaths,
  largePrReason,
  measurePrSize,
  parseNumstat,
  prSizeVerdict,
} from "./check-pr-size.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const gate = join(repoRoot, "scripts", "ci", "check-pr-size.mjs");
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

describe("parseNumstat", () => {
  it("reads plain, binary and renamed records from -z output", () => {
    const out = "3\t1\tsrc/a.ts\0-\t-\tdocs/x.png\0" + "2\t0\t\0src/old name.ts\0src/new café.ts\0";
    expect(parseNumstat(out)).toEqual([
      { path: "src/a.ts", oldPath: null, added: 3, deleted: 1, binary: false },
      { path: "docs/x.png", oldPath: null, added: 0, deleted: 0, binary: true },
      { path: "src/new café.ts", oldPath: "src/old name.ts", added: 2, deleted: 0, binary: false },
    ]);
  });
});

describe("countReviewableLines", () => {
  const records = [
    { path: "src/a.ts", oldPath: null, added: 500, deleted: 100 },
    { path: "pnpm-lock.yaml", oldPath: null, added: 4000, deleted: 3000 },
    { path: "src/moved.ts", oldPath: "src/lib/__tests__/support/email-render-pins.txt", added: 10, deleted: 0 },
  ];

  it("leaves generated paths out, by either end of a rename", () => {
    const generated = new Set(["pnpm-lock.yaml", "src/lib/__tests__/support/email-render-pins.txt"]);
    expect(countReviewableLines(records, generated)).toEqual({
      lines: 600,
      excludedLines: 7010,
      excluded: ["pnpm-lock.yaml", "src/moved.ts"],
    });
  });

  it("counts everything when nothing is generated", () => {
    expect(countReviewableLines(records, new Set()).lines).toBe(7610);
  });
});

describe("the repository's own generated list", () => {
  it("marks the lockfile and the regenerated pin files, and not hand-written source or migrations", () => {
    const generated = generatedPaths(
      [
        "pnpm-lock.yaml",
        "src/lib/__tests__/support/email-render-pins.txt",
        "src/lib/theme/__tests__/theme-goldens.json",
        "scripts/ci/e2e-spec-durations.mjs",
        "src/lib/booking-create.ts",
        "prisma/migrations/20260101000000_x/migration.sql",
        "package.json",
      ],
      { cwd: repoRoot },
    );
    expect([...generated].sort()).toEqual([
      "pnpm-lock.yaml",
      "scripts/ci/e2e-spec-durations.mjs",
      "src/lib/__tests__/support/email-render-pins.txt",
      "src/lib/theme/__tests__/theme-goldens.json",
    ]);
  });
});

describe("measurePrSize against a real repository", () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function makeRepo(files) {
    root = mkdtempSync(join(tmpdir(), "pr-size-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "--quiet", "--initial-branch", "base");
    git("config", "user.email", "gate-test@example.invalid");
    git("config", "user.name", "Gate Test");
    git("config", "commit.gpgsign", "false");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(root, ".gitattributes"), "pnpm-lock.yaml linguist-generated\ngen/** linguist-generated=true\n");
    writeFileSync(join(root, "keep.ts"), lines(50));
    git("add", "-A");
    git("commit", "--quiet", "-m", "seed");
    git("checkout", "--quiet", "-b", "work");
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    git("add", "-A");
    git("commit", "--quiet", "--allow-empty", "-m", "work");
    return root;
  }

  it("counts source lines and excludes the lockfile and generated paths", () => {
    makeRepo({ "src/a.ts": lines(300), "pnpm-lock.yaml": lines(5000), "gen/out.json": lines(900) });
    expect(measurePrSize("base", "work", { cwd: root })).toEqual({
      lines: 300,
      excludedLines: 5900,
      excluded: ["gen/out.json", "pnpm-lock.yaml"],
    });
  });

  it("counts a pure rename as nothing and its edits as lines", () => {
    makeRepo({});
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("mv", "keep.ts", "moved.ts");
    writeFileSync(join(root, "moved.ts"), `${readFileSync(join(root, "moved.ts"), "utf8")}extra\n`);
    git("add", "-A");
    git("commit", "--quiet", "-m", "rename");
    expect(measurePrSize("base", "work", { cwd: root }).lines).toBe(1);
  });

  it("warns, and still exits 0, from the CI entrypoint for a large PR with no reason", () => {
    makeRepo({ "src/a.ts": lines(LARGE_PR_LINE_THRESHOLD + 1) });
    const bodyFile = join(root, "body.md");
    writeFileSync(bodyFile, "## Summary\n\n- big\n");
    const sha = (ref) => execFileSync("git", ["rev-parse", ref], { cwd: root, encoding: "utf8" }).trim();
    const env = { ...process.env, PR_BODY_FILE: bodyFile, PR_BASE_SHA: sha("base"), PR_HEAD_SHA: sha("work") };
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "PR_NUMBER", "GITHUB_REPOSITORY", "PR_BODY"]) delete env[key];
    const result = spawnSync(process.execPath, [gate], { cwd: root, encoding: "utf8", env });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^::warning title=Large PR \(soft limit\)::801 changed line\(s\), over the 800-line/m);

    writeFileSync(bodyFile, "## Summary\n\n- big\n\nlarge-pr: one generated migration plus its tests\n");
    const passed = spawnSync(process.execPath, [gate], { cwd: root, encoding: "utf8", env });
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("PR size check passed: 801 changed line(s); large-pr: one generated migration");
  });

  it("warns rather than failing when it cannot measure", () => {
    root = mkdtempSync(join(tmpdir(), "pr-size-"));
    const bodyFile = join(root, "body.md");
    writeFileSync(bodyFile, "x\n");
    const env = { ...process.env, PR_BODY_FILE: bodyFile, PR_BASE_SHA: "0".repeat(40), PR_HEAD_SHA: "1".repeat(40) };
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "PR_NUMBER", "GITHUB_REPOSITORY", "PR_BODY"]) delete env[key];
    const result = spawnSync(process.execPath, [gate], { cwd: root, encoding: "utf8", env });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^::warning title=Large PR \(soft limit\)::PR size check could not run/m);
  });
});

describe("largePrReason", () => {
  it("reads a reason on its own line, in the shapes people write it", () => {
    expect(largePrReason("text\nlarge-pr: one migration and its fixtures\n")).toBe("one migration and its fixtures");
    expect(largePrReason("- **large-pr:** mechanical rename\r\n")).toBe("mechanical rename");
    expect(largePrReason("`large-pr:` docs move")).toBe("docs move");
  });

  it("refuses an empty reason, prose mentioning it, and the template's comment", () => {
    expect(largePrReason("large-pr:\n- next bullet\n")).toBeNull();
    expect(largePrReason("Add a large-pr: line if needed")).toBeNull();
    expect(largePrReason("<!-- \nlarge-pr: <reason>\n -->")).toBeNull();
    const template = readFileSync(join(repoRoot, ".github", "pull_request_template.md"), "utf8");
    expect(template).toContain("large-pr:");
    expect(largePrReason(template)).toBeNull();
  });
});

describe("prSizeVerdict", () => {
  const size = (n) => ({ lines: n, excludedLines: 0, excluded: [] });

  it("passes at the threshold and warns one line over it", () => {
    expect(prSizeVerdict("", size(LARGE_PR_LINE_THRESHOLD))).toMatchObject({ status: "pass", outcome: "within-threshold" });
    expect(prSizeVerdict("", size(LARGE_PR_LINE_THRESHOLD + 1))).toMatchObject({
      status: "warn",
      outcome: "large-without-reason",
    });
  });

  it("passes a large PR that gives a reason", () => {
    expect(prSizeVerdict("large-pr: generated seed data", size(5000))).toMatchObject({
      status: "pass",
      outcome: "reason-given",
    });
  });

  it("names what it left out", () => {
    const verdict = prSizeVerdict("", { lines: 10, excludedLines: 7000, excluded: ["pnpm-lock.yaml"] });
    expect(verdict.message).toBe("10 changed line(s), not counting 7000 in 1 generated file(s) (pnpm-lock.yaml).");
  });

  it("never fails: an unmeasured PR warns", () => {
    expect(prSizeVerdict("", null).status).toBe("warn");
  });
});
