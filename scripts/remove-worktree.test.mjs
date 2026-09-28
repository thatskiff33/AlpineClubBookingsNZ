import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main, parseArguments, removeWorktree, scanWorktree } from "./remove-worktree.mjs";

// Real git repositories and real links: the whole point is how removal meets a
// pnpm-shaped node_modules and git's own checks, which a mock cannot show.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ROOTS = new Set();
afterEach(() => {
  for (const root of ROOTS) fs.rmSync(root, { recursive: true, force: true });
  ROOTS.clear();
  vi.restoreAllMocks();
});

const DIR_LINK = process.platform === "win32" ? "junction" : "dir";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Run git without a shell, for the injected-runner tests. */
function realGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A repository with one commit (README.md, a.txt) and a linked worktree off it. */
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
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
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
  fs.symlinkSync(store, path.join(lane, "node_modules", "pkg"), DIR_LINK);
  fs.symlinkSync(outside, path.join(lane, "node_modules", "escape"), DIR_LINK);
}

/** Commit a .gitignore to the lane that ignores `extra` too, and fast-forward main to it. */
function ignoreInLane(repo, lane, extra) {
  fs.writeFileSync(path.join(lane, ".gitignore"), `node_modules\n${extra}\n`);
  git(lane, "add", ".gitignore");
  git(lane, "commit", "-q", "-m", "ignore");
  git(repo, "merge", "-q", "--ff-only", "lane");
}

const remove = (repo, lane, extra = {}) => removeWorktree({ repoDir: repo, worktree: lane, base: "main", ...extra });
const listed = (repo) => git(repo, "worktree", "list").includes("wt-lane");

describe("remove-worktree", () => {
  it("removes a merged lane with a pnpm-shaped node_modules without following its links", () => {
    const { repo, lane, outside } = fixture();
    pnpmShapedNodeModules(lane, outside);

    remove(repo, lane);

    expect(fs.existsSync(lane)).toBe(false);
    expect(listed(repo)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
  });

  it("refuses the main checkout", () => {
    const { repo } = fixture();
    expect(() => remove(repo, repo)).toThrow(/main checkout/);
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true);
  });

  it("refuses a path that is not a registered worktree", () => {
    const { repo, root } = fixture();
    const stray = path.join(root, "not-a-worktree");
    fs.mkdirSync(stray);
    expect(() => remove(repo, stray)).toThrow(/not a registered worktree/);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it("refuses a top-level node_modules that is itself a link, and leaves its target alone", () => {
    const { repo, lane, outside } = fixture();
    fs.symlinkSync(outside, path.join(lane, "node_modules"), DIR_LINK);
    expect(() => remove(repo, lane)).toThrow(/legacy junction/);
    expect(fs.existsSync(path.join(outside, "sentinel"))).toBe(true);
    expect(fs.existsSync(lane)).toBe(true);
  });

  // The design: only node_modules/.next are deleted by the tool; git then
  // refuses a lane with work in it and the work is untouched.
  it("leaves uncommitted work to git's refusal, deleting only node_modules", () => {
    const { repo, lane, outside } = fixture();
    pnpmShapedNodeModules(lane, outside);
    fs.writeFileSync(path.join(lane, "wip.txt"), "unsaved\n");
    expect(() => remove(repo, lane)).toThrow(/git did not remove[\s\S]*intact apart from its node_modules/);
    expect(fs.readFileSync(path.join(lane, "wip.txt"), "utf8")).toBe("unsaved\n");
    expect(fs.existsSync(path.join(lane, "node_modules"))).toBe(false);
    expect(listed(repo)).toBe(true);
    expect(fs.existsSync(path.join(outside, "sentinel"))).toBe(true);
  });

  it("refuses an unmerged HEAD unless the lane is declared abandoned", () => {
    const { repo, lane } = fixture();
    fs.writeFileSync(path.join(lane, "change.txt"), "new\n");
    git(lane, "add", ".");
    git(lane, "commit", "-q", "-m", "unmerged");
    expect(() => remove(repo, lane)).toThrow(/not merged/);
    expect(fs.existsSync(lane)).toBe(true);

    remove(repo, lane, { allowUnmerged: true });
    expect(fs.existsSync(lane)).toBe(false);
  });

  // #3673 review, reproduced on git 2.53.0.windows.1: `git worktree remove`
  // FOLLOWS a junction it meets outside node_modules and empties the target. A
  // git-ignored folder is where one hides, because `git status` never shows it.
  it("refuses a link anywhere outside node_modules, and the thing it points at survives", () => {
    const { repo, lane, outside } = fixture();
    ignoreInLane(repo, lane, ".cache");
    fs.mkdirSync(path.join(lane, ".cache"));
    fs.symlinkSync(outside, path.join(lane, ".cache", "link"), DIR_LINK);
    pnpmShapedNodeModules(lane, outside);

    expect(() => remove(repo, lane)).toThrow(/links outside its top-level node_modules[\s\S]*\.cache/);
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
    expect(fs.existsSync(path.join(lane, "node_modules", "pkg"))).toBe(true);
    expect(listed(repo)).toBe(true);
  });

  it("refuses to run from inside the target, by current directory or by INIT_CWD", () => {
    const { repo, lane, outside } = fixture();
    pnpmShapedNodeModules(lane, outside);
    const sub = path.join(lane, "sub");
    fs.mkdirSync(sub);
    expect(() => remove(repo, lane, { cwd: lane })).toThrow(/Run this from outside/);
    if (process.platform === "win32") {
      expect(() => remove(repo, lane, { cwd: repo, initCwd: sub.toUpperCase() })).toThrow(/Run this from outside/);
      // Not yet existing, so the case-fold cannot lean on realpath.
      const later = path.join(lane, "not-created-yet").toUpperCase();
      expect(() => remove(repo, lane, { cwd: repo, initCwd: later })).toThrow(/Run this from outside/);
    }
    expect(() => remove(repo, lane, { cwd: repo, initCwd: sub })).toThrow(/Run this from outside/);
    expect(fs.existsSync(path.join(lane, "node_modules", "pkg"))).toBe(true);
  });

  it("refuses a locked worktree before deleting anything", () => {
    const { repo, lane, outside } = fixture();
    pnpmShapedNodeModules(lane, outside);
    git(repo, "worktree", "lock", lane);
    expect(() => remove(repo, lane)).toThrow(/locked/);
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

/** `\\?\Volume{guid}\` for the drive the fixture is on, or null. */
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
  // Node writes the junction itself, with no shell in between (CodeQL
  // js/shell-command-injection-from-environment).
  try {
    fs.symlinkSync(volume + target.slice(3), linkPath, "junction");
  } catch {
    return false;
  }
  return fs.existsSync(linkPath);
}

describe("remove-worktree: links Node does not flag, unreadable folders, the generated folders", () => {
  // Review round 3 (reproduced): lstat reports a junction to `\\?\Volume{…}\…`
  // as a DIRECTORY, so a walk trusting lstat alone missed it and git followed it.
  it.runIf(process.platform === "win32")(
    "refuses a volume-path junction outside node_modules, which lstat calls a directory",
    () => {
      const { repo, lane, outside } = fixture();
      ignoreInLane(repo, lane, ".cache");
      fs.mkdirSync(path.join(lane, ".cache"));
      const link = path.join(lane, ".cache", "vol");
      expect(volumeJunction(link, outside), "could not create a volume-path junction").toBe(true);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(false); // the premise
      expect(() => remove(repo, lane)).toThrow(/links outside[\s\S]*vol/);
      expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
      expect(listed(repo)).toBe(true);
    },
  );

  it.runIf(process.platform === "win32")(
    "deletes a volume-path junction inside node_modules without following it",
    () => {
      const { repo, lane, outside } = fixture();
      pnpmShapedNodeModules(lane, outside);
      expect(volumeJunction(path.join(lane, "node_modules", "vol"), outside)).toBe(true);
      remove(repo, lane);
      expect(fs.existsSync(lane)).toBe(false);
      expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
    },
  );

  it("deletes a pnpm-shaped .next the same link-safe way as node_modules", () => {
    const { repo, lane, outside } = fixture();
    ignoreInLane(repo, lane, ".next");
    fs.mkdirSync(path.join(lane, ".next", "standalone", "node_modules"), { recursive: true });
    fs.symlinkSync(outside, path.join(lane, ".next", "standalone", "node_modules", "pkg"), DIR_LINK);
    remove(repo, lane);
    expect(fs.existsSync(lane)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
  });

  // The generated directories are exempt only at the ROOT.
  it.each([["sub/node_modules"], ["sub/.next"]])("refuses a link inside a nested %s", (nested) => {
    const { repo, lane, outside } = fixture();
    ignoreInLane(repo, lane, "sub");
    fs.mkdirSync(path.join(lane, nested), { recursive: true });
    fs.symlinkSync(outside, path.join(lane, nested, "link"), DIR_LINK);
    expect(() => remove(repo, lane)).toThrow(/links outside/);
    expect(fs.existsSync(path.join(outside, "sentinel"))).toBe(true);
    expect(fs.existsSync(lane)).toBe(true);
  });

  // Review round 3 (reproduced): the walk swallowed a readdir error, so an
  // unreadable folder holding a junction passed.
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
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      if (!isRoot) expect(readable, "the deny did not make the folder unreadable").toBe(false);
      if (!readable) {
        expect(scanWorktree(lane).unreadable.join("\n")).toContain("locked");
        expect(() => remove(repo, lane)).toThrow(/could not be read/);
        expect(fs.existsSync(path.join(lane, "node_modules", "pkg"))).toBe(true);
        expect(listed(repo)).toBe(true);
      }
    } finally {
      restore();
    }
  });

  // A file held open in node_modules: stop before git, and a rerun carries on.
  it("stops when node_modules cannot be fully deleted, and a rerun finishes", () => {
    const { repo, lane, outside } = fixture();
    pnpmShapedNodeModules(lane, outside);
    const realRm = fs.rmSync.bind(fs);
    const spy = vi.spyOn(fs, "rmSync").mockImplementation((p, options) => {
      if (path.basename(String(p)) === "node_modules") throw Object.assign(new Error("simulated"), { code: "EBUSY" });
      return realRm(p, options);
    });
    expect(() => remove(repo, lane)).toThrow(/node_modules could not be fully deleted \(EBUSY\)[\s\S]*still registered/);
    expect(listed(repo)).toBe(true);
    spy.mockRestore();

    remove(repo, lane);
    expect(fs.existsSync(lane)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep\n");
  });
});

describe("remove-worktree: other repositories, spellings, and git's own answer", () => {
  // Review round 5 (reproduced): a Claude Code session's worktree at
  // `.claude/worktrees/<name>` INSIDE the lane was deleted with it.
  it("refuses a lane that contains another registered worktree, and both survive", () => {
    const { repo, lane } = fixture();
    ignoreInLane(repo, lane, ".claude");
    const nested = path.join(lane, ".claude", "worktrees", "other");
    git(repo, "worktree", "add", "-q", "-b", "other", nested, "main");
    fs.writeFileSync(path.join(nested, "precious.txt"), "staged, not committed\n");
    git(nested, "add", "precious.txt");
    expect(() => remove(repo, lane)).toThrow(/contains other registered worktrees[\s\S]*other/);
    expect(fs.readFileSync(path.join(nested, "precious.txt"), "utf8")).toBe("staged, not committed\n");
    expect(git(repo, "worktree", "list")).toContain("worktrees/other");
  });

  it.each([["vendor/lib"], ["node_modules/debug-clone"], [".next/debug-clone"]])(
    "refuses a lane that contains another repository at %s",
    (where) => {
      const { repo, lane } = fixture();
      ignoreInLane(repo, lane, "vendor\n.next");
      const clone = path.join(lane, where);
      fs.mkdirSync(clone, { recursive: true });
      git(clone, "init", "-q");
      fs.writeFileSync(path.join(clone, "work.txt"), "never committed\n");
      expect(() => remove(repo, lane)).toThrow(/another git repository/);
      expect(fs.existsSync(path.join(clone, "work.txt"))).toBe(true);
    },
  );

  it.runIf(process.platform === "win32")("finds a repository whose .git is spelled .GIT", () => {
    const { repo, lane } = fixture();
    ignoreInLane(repo, lane, "vendor");
    const clone = path.join(lane, "vendor");
    fs.mkdirSync(clone);
    git(clone, "init", "-q");
    fs.renameSync(path.join(clone, ".git"), path.join(clone, ".GIT"));
    expect(() => remove(repo, lane)).toThrow(/another git repository[\s\S]*\.GIT/);
  });

  // git searches upward: a lane nested in the main checkout whose .git is not a
  // repository would be checked as the MAIN checkout, clean and merged.
  it("refuses when git answers for a different tree than the lane", () => {
    const { repo } = fixture();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n.artifacts\n");
    git(repo, "commit", "-q", "-am", "ignore artifacts");
    const lane = path.join(repo, ".artifacts", "worktrees", "9999");
    git(repo, "worktree", "add", "-q", "-b", "nested", lane, "main");
    fs.rmSync(path.join(lane, ".git"));
    fs.mkdirSync(path.join(lane, ".git"));
    fs.writeFileSync(path.join(lane, "work.txt"), "not in any commit\n");
    expect(() => remove(repo, lane)).toThrow(/does not see[\s\S]*as its own worktree/);
    expect(fs.existsSync(path.join(lane, "work.txt"))).toBe(true);
  });

  it("explains a lane with no .git, and forgets one whose folder is already gone", () => {
    const { repo, lane } = fixture();
    fs.rmSync(path.join(lane, ".git"));
    expect(() => remove(repo, lane)).toThrow(/has no \.git[\s\S]*git worktree remove/);
    expect(fs.existsSync(lane)).toBe(true);

    fs.rmSync(lane, { recursive: true, force: true });
    remove(repo, lane);
    expect(listed(repo)).toBe(false);
  });

  // Review round 5 (reproduced): given a junction to the lane, the tool removed
  // the junction and reported "Removed" while the lane stayed.
  it("refuses a target that is itself a link to the lane", () => {
    const { root, repo, lane } = fixture();
    const alias = path.join(root, "alias");
    fs.symlinkSync(lane, alias, DIR_LINK);
    expect(() => remove(repo, alias)).toThrow(/itself a link/);
    expect(fs.existsSync(path.join(lane, "README.md"))).toBe(true);
  });

  it("resolves a lane given through a linked parent folder to its real path", () => {
    const { root, repo, lane } = fixture();
    const linkedParent = path.join(path.dirname(root), `${path.basename(root)}-alias`);
    fs.symlinkSync(root, linkedParent, DIR_LINK);
    ROOTS.add(linkedParent);
    expect(remove(repo, path.join(linkedParent, "wt-lane"))).toBe(path.join(root, "wt-lane"));
    expect(fs.existsSync(lane)).toBe(false);
    expect(listed(repo)).toBe(false);
  });

  // Review round 6 (reproduced): a global `git worktree prune` also forgot a
  // second worktree whose folder was briefly elsewhere.
  it("leaves another worktree whose folder is away registered, with its staged work", () => {
    const { root, repo, lane } = fixture();
    const other = path.join(root, "wt-other");
    git(repo, "worktree", "add", "-q", "-b", "other", other, "main");
    fs.writeFileSync(path.join(other, "staged.txt"), "s\n");
    git(other, "add", "staged.txt");
    fs.renameSync(other, `${other}-offline`);
    remove(repo, lane);
    fs.renameSync(`${other}-offline`, other);
    expect(git(other, "status", "--porcelain")).toBe("A  staged.txt");
  });

  it("says when git unregistered the lane but could not delete all of it", () => {
    const { repo, lane } = fixture();
    const runGit = (cwd, args) =>
      args[0] === "worktree" && args[1] === "remove"
        ? (realGit(cwd, ["worktree", "remove", lane]), { status: 255, stdout: "", stderr: "failed to delete" })
        : realGit(cwd, args);
    expect(() => remove(repo, lane, { runGit })).toThrow(/has unregistered it[\s\S]*by hand/);
  });
});

describe("remove-worktree: what git worktree remove itself would not refuse", () => {
  it.each([
    ["an unstaged deletion", (l) => fs.rmSync(path.join(l, "a.txt"))],
    ["a staged deletion", (l) => git(l, "rm", "-q", "a.txt")],
    ["a staged rename", (l) => git(l, "mv", "a.txt", "b.txt")],
    [
      "a deleted file replaced by a folder of work",
      (l) => {
        fs.rmSync(path.join(l, "a.txt"));
        fs.mkdirSync(path.join(l, "a.txt"));
        fs.writeFileSync(path.join(l, "a.txt", "w"), "work\n");
      },
    ],
    ["an untracked file", (l) => fs.writeFileSync(path.join(l, "new.txt"), "work\n")],
  ])("git refuses %s, and nothing but node_modules goes", (_label, change) => {
    const { repo, lane } = fixture();
    change(lane);
    const before = fs.readdirSync(lane).sort();
    expect(() => remove(repo, lane)).toThrow(/git did not remove/);
    expect(fs.readdirSync(lane).sort()).toEqual(before);
  });

  it("sees an untracked file even when status.showUntrackedFiles=no", () => {
    const { repo, lane } = fixture();
    git(repo, "config", "status.showUntrackedFiles", "no");
    fs.writeFileSync(path.join(lane, "precious.txt"), "work\n");
    expect(() => remove(repo, lane)).toThrow(/git did not remove/);
    expect(fs.existsSync(path.join(lane, "precious.txt"))).toBe(true);
  });

  it.each([["--skip-worktree"], ["--assume-unchanged"]])(
    "refuses a file marked %s, whose edit git status does not show",
    (flag) => {
      const { repo, lane } = fixture();
      git(lane, "update-index", flag, "a.txt");
      fs.writeFileSync(path.join(lane, "a.txt"), "LOCAL EDIT\n");
      expect(git(lane, "status", "--porcelain")).toBe(""); // the premise
      expect(() => remove(repo, lane)).toThrow(/--skip-worktree or --assume-unchanged[\s\S]*a\.txt/);
      expect(fs.readFileSync(path.join(lane, "a.txt"), "utf8")).toBe("LOCAL EDIT\n");
    },
  );

  // Review round 7 (reproduced): `rebase --autostash` stopped at a `break`
  // leaves a clean status and the stash inside rebase-merge/.
  it("refuses an in-progress rebase, whose autostash lives in the lane's git directory", () => {
    const { root, repo, lane } = fixture();
    fs.writeFileSync(path.join(lane, "a.txt"), "PRECIOUS UNCOMMITTED\n");
    const editor = path.join(root, "break-editor.cjs");
    fs.writeFileSync(
      editor,
      'const fs = require("fs"); const f = process.argv[2]; fs.writeFileSync(f, "break\\n" + fs.readFileSync(f, "utf8"));\n',
    );
    const editorCmd = `node '${editor.split(path.sep).join("/")}'`;
    git(lane, "-c", `sequence.editor=${editorCmd}`, "rebase", "-q", "-i", "--autostash", "main");
    expect(git(lane, "status", "--porcelain")).toBe(""); // the premise: git itself sees nothing
    expect(() => remove(repo, lane)).toThrow(/operation in progress[\s\S]*rebase-merge/);
    expect(listed(repo)).toBe(true);
  });

  it.each([["MERGE_HEAD"], ["CHERRY_PICK_HEAD"], ["REVERT_HEAD"], ["BISECT_LOG"], ["rebase-apply"], ["sequencer"]])(
    "refuses while %s exists in the lane's git directory",
    (name) => {
      const { repo, lane } = fixture();
      const marker = path.resolve(lane, git(lane, "rev-parse", "--git-path", name));
      fs.writeFileSync(marker, `${git(lane, "rev-parse", "HEAD")}\n`);
      expect(() => remove(repo, lane)).toThrow(new RegExp(`operation in progress[\\s\\S]*${name}`));
      expect(listed(repo)).toBe(true);
    },
  );

  it.each([["refs/worktree/keep"], ["refs/bisect/bad"]])("refuses a lane with a %s ref", (ref) => {
    const { repo, lane } = fixture();
    git(lane, "update-ref", ref, "HEAD");
    expect(() => remove(repo, lane)).toThrow(new RegExp(`refs of its own[\\s\\S]*${ref}`));
    expect(listed(repo)).toBe(true);
  });

  // Review round 7 (reproduced): after `submodule deinit` the submodule's
  // repository, unpushed commits included, lives in the lane's git directory.
  it("refuses a lane whose git directory holds a submodule repository", () => {
    const { root, repo, lane } = fixture();
    const source = path.join(root, "subsrc");
    fs.mkdirSync(source);
    git(source, "init", "-q", "-b", "main");
    git(source, "-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "s");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source.split(path.sep).join("/"), "sub");
    git(repo, "commit", "-q", "-m", "add sub");
    git(lane, "merge", "-q", "--ff-only", "main");
    git(lane, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
    git(lane, "submodule", "deinit", "-q", "-f", "sub");
    expect(() => remove(repo, lane)).toThrow(/operation in progress, or a submodule repository[\s\S]*modules/);
    expect(listed(repo)).toBe(true);
  });

  // Review round 7 (reproduced): a stale fsmonitor hook that reports no
  // changes hid an edit from git status.
  it("does not trust an fsmonitor to report edits", () => {
    const { root, repo, lane } = fixture();
    const hook = path.join(root, "fsmonitor.sh");
    fs.writeFileSync(hook, `#!/bin/sh\nif [ -z "$2" ]; then printf 'tok1\\0/\\0'; else printf '%s\\0' "$2"; fi\n`, {
      mode: 0o755,
    });
    git(lane, "config", "core.fsmonitor", hook.split(path.sep).join("/"));
    git(lane, "config", "core.fsmonitorHookVersion", "2");
    git(lane, "update-index", "--fsmonitor");
    git(lane, "status");
    git(lane, "status");
    fs.writeFileSync(path.join(lane, "a.txt"), "PRECIOUS EDIT\n");
    expect(() => remove(repo, lane)).toThrow(/git did not remove/);
    expect(fs.readFileSync(path.join(lane, "a.txt"), "utf8")).toBe("PRECIOUS EDIT\n");
  });

  // Review round 7 (reproduced): with core.longpaths=false git status cannot
  // open a folder past 260 characters and reports no untracked work in it, so
  // plain `git worktree remove` passes its check, unregisters the lane and
  // deletes what it can. With the override git refuses cleanly instead.
  it.runIf(process.platform === "win32")("sees untracked work under a long path", () => {
    const { repo, lane } = fixture();
    git(repo, "config", "core.longpaths", "false");
    let dir = path.join(lane, "src");
    while (dir.length < 300) dir = path.join(dir, "d".repeat(40));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PRECIOUS.txt"), "work\n");
    expect(() => remove(repo, lane)).toThrow(/git did not remove[\s\S]*intact/);
    expect(fs.existsSync(path.join(dir, "PRECIOUS.txt"))).toBe(true);
    expect(fs.existsSync(path.join(lane, "README.md"))).toBe(true);
    expect(listed(repo)).toBe(true);
  });

  // Review rounds 6-7: variables from the caller's shell, in any case, must not
  // point git elsewhere or inject config (here: an excludes file ignoring all).
  it.each([
    ["Git_Dir (mixed case)", (f) => ({ Git_Dir: path.join(f.repo, ".git"), Git_Work_Tree: f.repo })],
    [
      "GIT_CONFIG_COUNT",
      (f) => {
        const excludes = path.join(f.root, "exclude-everything");
        fs.writeFileSync(excludes, "*\n");
        return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: excludes };
      },
    ],
  ])("ignores %s inherited from the caller's shell", (_label, makeEnv) => {
    const f = fixture();
    fs.writeFileSync(path.join(f.lane, "PRECIOUS.txt"), "work\n");
    const env = makeEnv(f);
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      expect(() => remove(f.repo, f.lane)).toThrow(/git did not remove/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(fs.existsSync(path.join(f.lane, "PRECIOUS.txt"))).toBe(true);
  });

  // The accepted trade-off, identical to plain `git worktree remove`.
  it("deletes ignored files such as .env.local with the lane, as git does", () => {
    const { repo, lane } = fixture();
    ignoreInLane(repo, lane, ".env.local");
    fs.writeFileSync(path.join(lane, ".env.local"), "SECRET=1\n");
    remove(repo, lane);
    expect(fs.existsSync(lane)).toBe(false);
  });
});
