import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main, parseArguments, removeWorktree, scanWorktree } from "./remove-worktree.mjs";

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
  it("removes a merged lane with a pnpm-shaped node_modules without following its links", () => {
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

  /*
    #3673 review, reproduced on git 2.53.0.windows.1: `git worktree remove`
    FOLLOWS a junction it meets outside node_modules and empties the target. A
    git-ignored folder is where one hides, because `git status` never shows it.
  */
  it("refuses a link anywhere outside node_modules, and the thing it points at survives", () => {
    const { repo, lane, outside } = fixture();
    fs.writeFileSync(path.join(lane, ".gitignore"), "node_modules\n.cache\n");
    git(lane, "add", ".gitignore");
    git(lane, "commit", "-q", "-m", "ignore cache");
    git(repo, "merge", "-q", "--ff-only", "lane");
    fs.mkdirSync(path.join(lane, ".cache"));
    fs.symlinkSync(outside, path.join(lane, ".cache", "link"), process.platform === "win32" ? "junction" : "dir");
    pnpmShapedNodeModules(lane, outside);

    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(
      /links outside its top-level node_modules[\s\S]*\.cache/,
    );
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
    // Refused BEFORE anything was deleted.
    expect(fs.existsSync(path.join(lane, "node_modules", "pkg"))).toBe(true);
    expect(git(repo, "worktree", "list")).toContain("wt-lane");
  });

  it("refuses to run from inside the target, by current directory or by INIT_CWD", () => {
    const { repo, lane, outside } = fixture();
    pnpmShapedNodeModules(lane, outside);
    const sub = path.join(lane, "sub");
    fs.mkdirSync(sub);
    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main", cwd: lane })).toThrow(
      /Run this from outside/,
    );
    if (process.platform === "win32") {
      // Windows paths are case-insensitive, so a differently cased spelling of
      // a directory inside the target is still inside it.
      expect(() =>
        removeWorktree({ repoDir: repo, worktree: lane, base: "main", cwd: repo, initCwd: sub.toUpperCase() }),
      ).toThrow(/Run this from outside/);
    }
    expect(() =>
      removeWorktree({ repoDir: repo, worktree: lane, base: "main", cwd: repo, initCwd: sub }),
    ).toThrow(/Run this from outside/);
    expect(fs.existsSync(path.join(lane, "node_modules", "pkg"))).toBe(true);
  });

  it("refuses a locked worktree before deleting anything", () => {
    const { repo, lane, outside } = fixture();
    pnpmShapedNodeModules(lane, outside);
    git(repo, "worktree", "lock", lane);
    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(/locked/);
    expect(fs.existsSync(path.join(lane, "node_modules", "pkg"))).toBe(true);
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

const DIR_LINK = process.platform === "win32" ? "junction" : "dir";

/** Commit a .gitignore to the lane that ignores `extra` too, and fast-forward main to it. */
function ignoreInLane(repo, lane, extra) {
  fs.writeFileSync(path.join(lane, ".gitignore"), `node_modules\n${extra}\n`);
  git(lane, "add", ".gitignore");
  git(lane, "commit", "-q", "-m", "ignore");
  git(repo, "merge", "-q", "--ff-only", "lane");
}

/** `\\?\Volume{guid}\` for C: (or the drive the fixture is on), or null. */
function volumeGuidPath(p) {
  try {
    const drive = path.parse(p).root.slice(0, 2);
    const out = execFileSync("mountvol", [drive, "/L"], { encoding: "utf8" }).trim();
    return /^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** A junction whose target is spelled as a volume path, which lstat reports as a plain directory. */
function volumeJunction(linkPath, target) {
  const volume = volumeGuidPath(target);
  if (!volume) return false;
  const spelled = volume + target.slice(3);
  // Node writes the junction itself, with no shell in between (CodeQL
  // js/shell-command-injection-from-environment): `cmd /c mklink /J` made the
  // same reparse point, but through cmd, which re-parses the paths it is given.
  try {
    fs.symlinkSync(spelled, linkPath, "junction");
  } catch {
    return false;
  }
  return fs.existsSync(linkPath);
}

describe("remove-worktree: links Node does not flag, unreadable folders, and git never deleting", () => {
  // Review round 3 (reproduced): lstat reports a junction to `\\?\Volume{…}\…`
  // as a DIRECTORY, so a walk trusting lstat alone missed it and git followed it.
  it.runIf(process.platform === "win32")(
    "refuses a volume-path junction outside node_modules, which lstat calls a directory",
    () => {
      const { repo, lane, outside } = fixture();
      ignoreInLane(repo, lane, ".cache");
      fs.mkdirSync(path.join(lane, ".cache"));
      const link = path.join(lane, ".cache", "vol");
      // A junction needs no admin rights; if it still cannot be created there is
      // nothing to test, and the test says so rather than passing silently.
      expect(volumeJunction(link, outside), "could not create a volume-path junction").toBe(true);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(false); // the premise

      expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(
        /links outside[\s\S]*vol/,
      );
      expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
      expect(git(repo, "worktree", "list")).toContain("wt-lane");
    },
  );

  // Today readdir flags that junction even though lstat does not. A mount point
  // or another reparse-point kind may be flagged by NEITHER, and then only the
  // real-path comparison sees it; this proves that comparison on its own by
  // hiding readdir's flag.
  it.runIf(process.platform === "win32")(
    "catches a reparse point that neither readdir nor lstat flags, by its real path",
    () => {
      const { repo, lane, outside } = fixture();
      ignoreInLane(repo, lane, ".cache");
      fs.mkdirSync(path.join(lane, ".cache"));
      expect(volumeJunction(path.join(lane, ".cache", "vol"), outside)).toBe(true);
      const realReaddir = fs.readdirSync.bind(fs);
      vi.spyOn(fs, "readdirSync").mockImplementation((dir, options) => {
        const entries = realReaddir(dir, options);
        if (!options?.withFileTypes) return entries;
        return entries.map((entry) =>
          Object.assign(Object.create(Object.getPrototypeOf(entry)), entry, {
            isSymbolicLink: () => false,
            isDirectory: () => entry.isDirectory() || entry.isSymbolicLink(),
            isFile: () => entry.isFile(),
          }),
        );
      });
      const { links } = scanWorktree(lane);
      expect(links.join("\n")).toMatch(/vol -> /);
    },
  );

  it.runIf(process.platform === "win32")(
    "deletes a volume-path junction inside node_modules without following it",
    () => {
      const { repo, lane, outside } = fixture();
      pnpmShapedNodeModules(lane, outside);
      expect(volumeJunction(path.join(lane, "node_modules", "vol"), outside)).toBe(true);

      removeWorktree({ repoDir: repo, worktree: lane, base: "main" });

      expect(fs.existsSync(lane)).toBe(false);
      expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
    },
  );

  it("deletes a pnpm-shaped .next the same link-safe way as node_modules", () => {
    const { repo, lane, outside } = fixture();
    ignoreInLane(repo, lane, ".next");
    fs.mkdirSync(path.join(lane, ".next", "standalone", "node_modules"), { recursive: true });
    fs.symlinkSync(outside, path.join(lane, ".next", "standalone", "node_modules", "pkg"), DIR_LINK);

    removeWorktree({ repoDir: repo, worktree: lane, base: "main" });

    expect(fs.existsSync(lane)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
  });

  // The generated directories are exempt only at the ROOT. The same names deeper
  // down are ordinary folders a person made, and a link in one is refused.
  it.each([["sub/node_modules"], ["sub/.git"], ["sub/.next"]])(
    "refuses a link inside a nested %s",
    (nested) => {
      const { repo, lane, outside } = fixture();
      ignoreInLane(repo, lane, "sub");
      fs.mkdirSync(path.join(lane, nested), { recursive: true });
      fs.symlinkSync(outside, path.join(lane, nested, "link"), DIR_LINK);
      expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(/links outside/);
      expect(fs.existsSync(path.join(outside, "sentinel"))).toBe(true);
      expect(fs.existsSync(lane)).toBe(true);
    },
  );

  // Review round 3 (reproduced): the walk swallowed a readdir error, so an
  // unreadable folder holding a junction passed, node_modules was deleted, and
  // git then failed half-way.
  it("refuses when a folder cannot be read, and deletes nothing", () => {
    const { repo, lane, outside } = fixture();
    ignoreInLane(repo, lane, ".cache");
    pnpmShapedNodeModules(lane, outside);
    const locked = path.join(lane, ".cache", "locked");
    fs.mkdirSync(locked, { recursive: true });
    fs.symlinkSync(outside, path.join(locked, "hidden"), DIR_LINK);
    const deny = () =>
      process.platform === "win32"
        ? execFileSync("icacls", [locked, "/deny", `${process.env.USERNAME}:(RD)`], { stdio: "ignore" })
        : fs.chmodSync(locked, 0o000);
    const restore = () =>
      process.platform === "win32"
        ? execFileSync("icacls", [locked, "/remove:d", process.env.USERNAME ?? ""], { stdio: "ignore" })
        : fs.chmodSync(locked, 0o755);
    deny();
    try {
      let readable = true;
      try {
        fs.readdirSync(locked);
      } catch {
        readable = false;
      }
      // Only root reads through a deny; anywhere else the premise must hold, or
      // this test would pass without testing anything.
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      if (!isRoot) expect(readable, "the deny did not make the folder unreadable").toBe(false);
      if (!readable) {
        expect(scanWorktree(lane).unreadable.join("\n")).toContain("locked");
        expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(
          /could not be read/,
        );
        expect(fs.existsSync(path.join(lane, "node_modules", "pkg"))).toBe(true);
        expect(git(repo, "worktree", "list")).toContain("wt-lane");
      }
    } finally {
      restore();
    }
  });

  it("keeps the registration when the directory could not be fully deleted", () => {
    const { repo, lane } = fixture();
    expect(() =>
      removeWorktree({
        repoDir: repo,
        worktree: lane,
        base: "main",
        remove: () => {
          throw new Error("EBUSY: simulated open handle");
        },
      }),
    ).toThrow(/could not be fully deleted[\s\S]*KEPT/);
    expect(fs.existsSync(lane)).toBe(true);
    expect(git(repo, "worktree", "list")).toContain("wt-lane");
  });

  // The Windows case-fold must not depend on realpath: an INIT_CWD that does not
  // exist yet, spelled in a different case, is still inside the target.
  it.runIf(process.platform === "win32")(
    "treats a differently cased, not-yet-existing INIT_CWD inside the target as inside",
    () => {
      const { repo, lane } = fixture();
      const initCwd = path.join(lane, "not-created-yet").toUpperCase();
      expect(fs.existsSync(initCwd)).toBe(false);
      expect(() =>
        removeWorktree({ repoDir: repo, worktree: lane, base: "main", cwd: repo, initCwd }),
      ).toThrow(/Run this from outside/);
      expect(fs.existsSync(lane)).toBe(true);
    },
  );
});

/** Run git without a shell, for the injected-runner tests. */
function realGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("remove-worktree: other repositories inside the lane, part-way removals, aliases, prune", () => {
  // Review round 5 (reproduced): a Claude Code session's worktree lives at
  // `.claude/worktrees/<name>` INSIDE the lane. It is git-ignored there, so the
  // lane's own status is clean, and removing the lane deleted it, staged work
  // and all, and prune then forgot it without a word.
  it("refuses a lane that contains another registered worktree, and both survive", () => {
    const { repo, lane } = fixture();
    ignoreInLane(repo, lane, ".claude");
    const nested = path.join(lane, ".claude", "worktrees", "other");
    git(repo, "worktree", "add", "-q", "-b", "other", nested, "main");
    fs.writeFileSync(path.join(nested, "precious.txt"), "staged, not committed\n");
    git(nested, "add", "precious.txt");

    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(
      /contains other registered worktrees[\s\S]*other/,
    );
    expect(fs.readFileSync(path.join(nested, "precious.txt"), "utf8")).toBe("staged, not committed\n");
    const listed = git(repo, "worktree", "list");
    expect(listed).toContain("wt-lane");
    expect(listed).toContain("worktrees/other");
  });

  it("refuses a lane that contains another repository (a .git below its root)", () => {
    const { repo, lane } = fixture();
    ignoreInLane(repo, lane, "vendor");
    const clone = path.join(lane, "vendor", "lib");
    fs.mkdirSync(clone, { recursive: true });
    git(clone, "init", "-q");
    fs.writeFileSync(path.join(clone, "work.txt"), "never committed\n");

    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(
      /another git repository[\s\S]*vendor/,
    );
    expect(fs.existsSync(path.join(clone, "work.txt"))).toBe(true);
  });

  // Review round 5 (reproduced): rmSync removed `.git` first, so a removal that
  // stopped part way left a folder git no longer recognised, and the retry
  // failed. `.git` now goes last.
  it("keeps .git when a removal stops part way, so the retry can finish it", () => {
    const { repo, lane, outside } = fixture();
    pnpmShapedNodeModules(lane, outside);
    fs.mkdirSync(path.join(lane, "held"));
    fs.writeFileSync(path.join(lane, "held", "f.txt"), "tracked\n");
    git(lane, "add", ".");
    git(lane, "commit", "-q", "-m", "held");
    git(repo, "merge", "-q", "--ff-only", "lane");

    const realRm = fs.rmSync.bind(fs);
    const spy = vi.spyOn(fs, "rmSync").mockImplementation((p, options) => {
      if (path.basename(String(p)) === "held") throw Object.assign(new Error("simulated"), { code: "EBUSY" });
      return realRm(p, options);
    });
    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(
      /held[\s\S]*\.git was kept[\s\S]*KEPT/,
    );
    expect(fs.readdirSync(lane).sort()).toEqual([".git", "held"]);
    expect(git(repo, "worktree", "list")).toContain("wt-lane");
    spy.mockRestore();

    removeWorktree({ repoDir: repo, worktree: lane, base: "main" });
    expect(fs.existsSync(lane)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain("wt-lane");
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
  });

  // A lane nested in the main checkout (this repository's .artifacts/worktrees
  // layout) whose .git is not a valid one: git searches upward and answers for
  // the MAIN checkout, whose clean, merged state would pass every check.
  it("refuses when git answers for a different tree than the lane", () => {
    const { repo } = fixture();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n.artifacts\n");
    git(repo, "commit", "-q", "-am", "ignore artifacts");
    const lane = path.join(repo, ".artifacts", "worktrees", "9999");
    git(repo, "worktree", "add", "-q", "-b", "nested", lane, "main");
    fs.rmSync(path.join(lane, ".git"));
    fs.mkdirSync(path.join(lane, ".git")); // present, but not a repository
    fs.writeFileSync(path.join(lane, "work.txt"), "not in any commit\n");

    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(
      /does not see[\s\S]*as its own worktree/,
    );
    expect(fs.existsSync(path.join(lane, "work.txt"))).toBe(true);
  });

  it("explains a lane with no .git, and one whose directory is already gone", () => {
    const { repo, lane } = fixture();
    fs.rmSync(path.join(lane, ".git"));
    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(
      /has no \.git[\s\S]*git worktree prune/,
    );
    expect(fs.existsSync(lane)).toBe(true);

    fs.rmSync(lane, { recursive: true, force: true });
    expect(() => removeWorktree({ repoDir: repo, worktree: lane, base: "main" })).toThrow(
      /already gone[\s\S]*git worktree prune/,
    );
  });

  // Review round 5 (reproduced): given a junction to the lane, the tool deleted
  // the junction, found the path it was given gone, and reported "Removed"
  // while the lane stayed on disk and registered.
  it("refuses a target that is itself a link to the lane", () => {
    const { root, repo, lane } = fixture();
    const alias = path.join(root, "alias");
    fs.symlinkSync(lane, alias, DIR_LINK);
    expect(() => removeWorktree({ repoDir: repo, worktree: alias, base: "main" })).toThrow(
      /itself a link/,
    );
    expect(fs.existsSync(alias)).toBe(true);
    expect(fs.existsSync(path.join(lane, "README.md"))).toBe(true);
  });

  it("reports a failing prune, and a prune that leaves the lane listed", () => {
    const failing = fixture();
    expect(() =>
      removeWorktree({
        repoDir: failing.repo,
        worktree: failing.lane,
        base: "main",
        runGit: (cwd, args) =>
          args[0] === "worktree" && args[1] === "prune"
            ? { status: 128, stdout: "", stderr: "simulated prune failure" }
            : realGit(cwd, args),
      }),
    ).toThrow(/git worktree prune failed: simulated prune failure/);

    const noop = fixture();
    expect(() =>
      removeWorktree({
        repoDir: noop.repo,
        worktree: noop.lane,
        base: "main",
        runGit: (cwd, args) =>
          args[0] === "worktree" && args[1] === "prune" ? { status: 0, stdout: "", stderr: "" } : realGit(cwd, args),
      }),
    ).toThrow(/still lists it after git worktree prune/);
  });
});
