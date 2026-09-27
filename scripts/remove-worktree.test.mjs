import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main, parseArguments, removeWorktree } from "./remove-worktree.mjs";

// Real git repositories and real links: the whole point is how removal meets a
// pnpm-shaped node_modules, which a mock cannot show.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ROOTS = new Set();
afterEach(() => {
  for (const root of ROOTS) fs.rmSync(root, { recursive: true, force: true });
  ROOTS.clear();
  vi.restoreAllMocks();
});

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository with one commit and a linked worktree off it. */
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "remove-worktree-")));
  ROOTS.add(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const lane = path.join(root, "wt-lane");
  git(repo, "worktree", "add", "-q", "-b", "lane", lane, "main");

  // Somewhere OUTSIDE the lane a link might point at: its survival is the
  // proof that removal unlinked rather than followed.
  const outside = path.join(root, "shared-target");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sentinel"), "keep\n");
  return { root, repo, lane, outside };
}

/** A pnpm-shaped tree: nested directory links, one of them leaving the lane. */
function pnpmShapedNodeModules(lane, outside) {
  const store = path.join(lane, "node_modules", ".pnpm", "pkg@1.0.0", "node_modules", "pkg");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "index.js"), "module.exports = 1;\n");
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(store, path.join(lane, "node_modules", "pkg"), type);
  fs.symlinkSync(outside, path.join(lane, "node_modules", "escape"), type);
}

describe("remove-worktree", () => {
  it("removes a merged lane with a pnpm-shaped node_modules and never follows a link", () => {
    const { repo, lane, outside } = fixture();
    pnpmShapedNodeModules(lane, outside);

    removeWorktree({ repoDir: repo, worktree: lane, base: "main" });

    expect(fs.existsSync(lane)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain("wt-lane");
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
  });

  it("refuses the main checkout", () => {
    const { repo } = fixture();
    expect(() => removeWorktree({ repoDir: repo, worktree: repo, base: "main" })).toThrow(/main checkout/);
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true);
  });

  it("refuses a path that is not a registered worktree", () => {
    const { repo, root } = fixture();
    const stray = path.join(root, "not-a-worktree");
    fs.mkdirSync(stray);
    expect(() => removeWorktree({ repoDir: repo, worktree: stray, base: "main" })).toThrow(/not a registered worktree/);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it("refuses a top-level node_modules that is itself a link, and leaves its target alone", () => {
    const { repo, lane, outside } = fixture();
    fs.symlinkSync(outside, path.join(lane, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(/legacy junction/);
    expect(fs.existsSync(path.join(outside, "sentinel"))).toBe(true);
    expect(fs.existsSync(lane)).toBe(true);
  });

  it("refuses uncommitted work BEFORE deleting node_modules", () => {
    const { repo, lane, outside } = fixture();
    pnpmShapedNodeModules(lane, outside);
    fs.writeFileSync(path.join(lane, "wip.txt"), "unsaved\n");
    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(/uncommitted/);
    expect(fs.existsSync(path.join(lane, "node_modules", "pkg"))).toBe(true);
  });

  it("refuses an unmerged HEAD unless the lane is declared abandoned", () => {
    const { repo, lane } = fixture();
    fs.writeFileSync(path.join(lane, "change.txt"), "new\n");
    git(lane, "add", ".");
    git(lane, "commit", "-q", "-m", "unmerged");
    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(/not merged/);
    expect(fs.existsSync(lane)).toBe(true);

    removeWorktree({ repoDir: repo, worktree: lane, base: "main", allowUnmerged: true });
    expect(fs.existsSync(lane)).toBe(false);
  });

  it("parses its arguments, tolerating a literal `--`", () => {
    expect(parseArguments(["--", "wt-x", "--base", "origin/epic/1", "--allow-unmerged"])).toEqual({
      worktree: "wt-x",
      base: "origin/epic/1",
      allowUnmerged: true,
    });
    expect(() => parseArguments([])).toThrow(/Usage/);
    expect(() => parseArguments(["a", "b"])).toThrow(/One worktree/);
    expect(() => parseArguments(["a", "--force"])).toThrow(/Unknown option --force/);
  });

  it("exits non-zero with the reason when it refuses", () => {
    const errors = [];
    vi.spyOn(console, "error").mockImplementation((line) => errors.push(String(line)));
    expect(main([])).toBe(1);
    expect(errors.join("\n")).toContain("Usage");
  });
});
