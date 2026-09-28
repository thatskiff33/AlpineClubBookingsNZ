#!/usr/bin/env node
/**
 * Remove a finished lane's git worktree, letting git decide what is safe.
 *
 *   pnpm run worktree:remove <path>                   # merged into origin/main
 *   pnpm run worktree:remove <path> --base <ref>      # merged into another base
 *   pnpm run worktree:remove <path> --allow-unmerged  # an abandoned lane
 *   node scripts/remove-worktree.mjs <path> ...       # the same, without pnpm
 *
 * Run it from OUTSIDE the worktree being removed (for example the main
 * checkout); it refuses otherwise.
 *
 * ## Why this exists (#3673)
 *
 * pnpm's strict layout builds `node_modules` out of links: on Windows about
 * 2,700 directory JUNCTIONS per worktree of this repository. Measured with git
 * 2.53.0.windows.1, `git worktree remove` fails half-way on them, and it
 * FOLLOWS a junction it meets and deletes the target's contents.
 *
 * ## What it does
 *
 * 1. Refuses (below) before anything is deleted.
 * 2. Deletes only the generated, link-heavy folders at the lane's root,
 *    `node_modules` and `.next`, with Node's `fs.rmSync`, which removes a link
 *    itself instead of descending into it. If one cannot be fully deleted it
 *    stops, and running it again carries on.
 * 3. Runs plain `git worktree remove <path>`, WITHOUT `--force`. git's own
 *    checks then refuse on modified, untracked or submodule work exactly as in
 *    normal use; if git refuses, the lane is intact apart from its
 *    `node_modules` and `.next` (`pnpm install` brings them back).
 *
 * The accepted trade-off, the same as plain `git worktree remove`: IGNORED
 * files, such as `.env.local`, are deleted with the lane.
 *
 * Every git call runs without any `GIT_*` environment variable (so nothing
 * points git at another repository or injects config) and with
 * `core.longpaths=true` (a long path cannot hide untracked work),
 * `core.fsmonitor=false` (a stale monitor cannot hide an edit) and
 * `status.showUntrackedFiles=normal` (config cannot hide untracked files).
 *
 * ## What it refuses, and why
 *
 * - The main checkout, a path that is not a registered linked worktree, a
 *   locked one, and a path that is itself a link to the worktree.
 * - Being run from inside the target (the current directory, or `INIT_CWD`,
 *   where `pnpm run` was typed).
 * - Another registered worktree inside the target, or any `.git` below its root
 *   (any case on Windows, `node_modules` and `.next` included): another
 *   repository whose work git would not check.
 * - A top-level `node_modules` that is itself a link (the legacy shape in
 *   `docs/agents/CODEX_WORKFLOW.md`), and any link outside the top-level
 *   `node_modules` and `.next`, which git would follow. A link is anything
 *   `lstat` flags, OR a directory whose real path is not its own (a
 *   volume-path junction or mount point, which `lstat` calls a directory).
 * - Any folder it cannot read, since it could hide a link.
 * - A `.git` git does not accept as the lane's own (`--show-toplevel` names
 *   another tree): git searches upward, so the checks would answer for it.
 * - What `git worktree remove` would delete without complaint: an in-progress
 *   rebase (its autostash lives there), merge, cherry-pick, revert, bisect or
 *   sequence; any `refs/worktree/*` or `refs/bisect/*` ref; a submodule's
 *   repository kept in the lane's git directory; files marked
 *   `--skip-worktree` or `--assume-unchanged`, whose edits git status skips.
 * - A HEAD not merged into the base unless `--allow-unmerged` says the lane was
 *   abandoned on purpose.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const USAGE =
  "Usage: pnpm run worktree:remove <worktree-path> [--base <ref>] [--allow-unmerged]";

/** Generated, link-heavy directories at the worktree root, deleted by Node. */
const GENERATED_ROOT_DIRS = ["node_modules", ".next"];

/** git state that `git worktree remove` would delete with the lane, unasked. */
const IN_PROGRESS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "sequencer",
  "modules",
];

const GIT_CONFIG = [
  "-c",
  "core.longpaths=true",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "status.showUntrackedFiles=normal",
];

export function parseArguments(argv) {
  // A literal `--` is tolerated, as in the repository's other CLIs.
  const args = argv.filter((arg) => arg !== "--");
  const options = { worktree: "", base: "origin/main", allowUnmerged: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--allow-unmerged") options.allowUnmerged = true;
    else if (arg === "--base") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`--base needs a ref. ${USAGE}`);
      options.base = value;
      index += 1;
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}. ${USAGE}`);
    else if (options.worktree) throw new Error(`One worktree path at a time. ${USAGE}`);
    else options.worktree = arg;
  }
  if (!options.worktree) throw new Error(USAGE);
  return options;
}

function git(cwd, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  );
  const result = spawnSync("git", [...GIT_CONFIG, ...args], { cwd, encoding: "utf8", env });
  // A spawn that never started has no stderr, only `error`.
  const stderr = result.error ? `could not run git: ${result.error.message}` : (result.stderr ?? "");
  return { status: result.status, stdout: result.stdout ?? "", stderr };
}

function fold(p) {
  const trimmed = p.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** A path's comparable form: its real path where it exists, case-folded on Windows. */
function canonical(p) {
  let resolved = path.resolve(p);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A path that does not exist (yet) compares by its resolved spelling.
  }
  return fold(resolved);
}

function samePath(a, b) {
  return canonical(a) === canonical(b);
}

export function isInside(child, parent) {
  const c = canonical(child);
  const p = canonical(parent);
  return c === p || c.startsWith(p + path.sep);
}

/** Every worktree git knows about, main checkout first, with whether it is locked. */
export function listWorktrees(repoDir, runGit = git) {
  const out = runGit(repoDir, ["worktree", "list", "--porcelain"]);
  if (out.status !== 0) throw new Error(`git worktree list failed: ${out.stderr.trim()}`);
  return out.stdout
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const worktree = /^worktree (.+)$/m.exec(block)?.[1];
      if (!worktree) return null;
      return { path: path.resolve(worktree), locked: /^locked(?: |$)/m.test(block) };
    })
    .filter(Boolean);
}

function isFlaggedLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const isDotGit = (name) => fold(name) === ".git";
const isGenerated = (name) => GENERATED_ROOT_DIRS.some((dir) => fold(dir) === fold(name));

/**
 * Walk the worktree (except its own top-level `.git`) and return
 * `{ links, unreadable, repositories }`: links git would follow, folders that
 * could not be read, and every `.git` below the root.
 *
 * A directory counts as a link when `lstat` flags it, or when its real path
 * differs from its own path, which is how a junction to a
 * `\\?\Volume{…}` path or a mount point shows up. Inside the root
 * `node_modules` and `.next` links are expected, so there they are neither
 * reported nor followed; those folders are still walked for a `.git` and for
 * folders that cannot be read. Every error other than ENOENT is recorded.
 */
export function scanWorktree(target) {
  const links = [];
  const unreadable = [];
  const repositories = [];
  const recordError = (p, error) => {
    if (error?.code !== "ENOENT") unreadable.push(`${p} (${error?.code ?? String(error)})`);
  };
  const walk = (dir, realDir, atRoot, generated) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      recordError(dir, error);
      return;
    }
    for (const entry of entries) {
      if (atRoot && isDotGit(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (isDotGit(entry.name)) repositories.push(full);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (error) {
        recordError(full, error);
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (!generated) links.push(full);
        continue;
      }
      if (!stat.isDirectory()) continue;
      let real;
      try {
        real = fs.realpathSync.native(full);
      } catch (error) {
        recordError(full, error);
        continue;
      }
      if (fold(real) !== fold(path.join(realDir, entry.name))) {
        if (!generated) links.push(`${full} -> ${real}`);
        continue;
      }
      walk(full, real, false, generated || (atRoot && isGenerated(entry.name)));
    }
  };
  let realTarget;
  try {
    realTarget = fs.realpathSync.native(target);
  } catch (error) {
    recordError(target, error);
    return { links, unreadable, repositories };
  }
  walk(target, realTarget, true, false);
  return { links, unreadable, repositories };
}

function refuse(reason, list = []) {
  const detail = list.length > 0 ? `:\n  ${list.slice(0, 20).join("\n  ")}` : ".";
  throw new Error(`${reason} Nothing has been removed${detail}`);
}

/**
 * Check every refusal before anything is deleted. Returns `{ target,
 * registeredPath }`: the worktree's real path and git's spelling of it.
 */
export function preflight({
  repoDir,
  worktree,
  base,
  allowUnmerged,
  cwd = process.cwd(),
  initCwd = process.env.INIT_CWD,
  runGit = git,
}) {
  const given = path.resolve(worktree);
  if (isFlaggedLink(given)) {
    refuse(`${given} is itself a link, not the worktree. Pass the worktree's own path.`);
  }
  const worktrees = listWorktrees(repoDir, runGit);
  if (worktrees.length > 0 && samePath(worktrees[0].path, given)) {
    refuse(`${given} is the main checkout, not a lane worktree.`);
  }
  const registered = worktrees.find((w) => samePath(w.path, given));
  if (!registered) refuse(`${given} is not a registered worktree of this repository.`);
  if (registered.locked) refuse(`${given} is locked (git worktree lock). Unlock it deliberately first.`);
  // A lane whose folder is already gone has nothing left to check or delete:
  // only git's registration, which plain `git worktree remove` forgets.
  if (!fs.existsSync(given)) return { target: given, registeredPath: registered.path };

  const target = fs.realpathSync.native(given);
  const nested = worktrees.filter((w) => w !== registered && isInside(w.path, target));
  if (nested.length > 0) {
    refuse(`${target} contains other registered worktrees.`, nested.map((w) => w.path));
  }
  for (const where of [cwd, initCwd]) {
    if (where && isInside(where, target)) {
      refuse(`Run this from outside ${target}: ${where} is inside it (the main checkout is a good place).`);
    }
  }
  if (isFlaggedLink(path.join(target, "node_modules"))) {
    refuse(
      `${target}/node_modules is itself a link (the legacy junction shape). Use the verified ` +
        "manual unlink in docs/agents/CODEX_WORKFLOW.md instead.",
    );
  }
  const { links, unreadable, repositories } = scanWorktree(target);
  if (unreadable.length > 0) {
    refuse(`Parts of ${target} could not be read, so it cannot be shown to be free of links.`, unreadable);
  }
  if (links.length > 0) {
    refuse(
      `${target} contains links outside its top-level node_modules and .next, which git would ` +
        "follow. Delete the links (not their targets), then run this again.",
      links,
    );
  }
  if (repositories.length > 0) {
    refuse(`${target} contains another git repository or worktree, whose work git would not check.`, repositories);
  }
  const toplevel = runGit(target, ["rev-parse", "--show-toplevel"]);
  if (toplevel.status !== 0 || !samePath(toplevel.stdout.trim(), target)) {
    const answer = toplevel.status === 0 ? `it answers for ${toplevel.stdout.trim()}` : toplevel.stderr.trim();
    const hint = fs.existsSync(path.join(target, ".git"))
      ? ""
      : " It has no .git: if an earlier removal stopped part way, check what is left, delete it " +
        `yourself, and run \`git worktree remove ${registered.path}\`.`;
    refuse(`git does not see ${target} as its own worktree (${answer}).${hint}`);
  }
  const gitPaths = runGit(target, ["rev-parse", ...IN_PROGRESS.flatMap((name) => ["--git-path", name])]);
  if (gitPaths.status !== 0) refuse(`git rev-parse failed in ${target}: ${gitPaths.stderr.trim()}.`);
  const inProgress = gitPaths.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => path.resolve(target, p))
    .filter((p) => fs.existsSync(p));
  if (inProgress.length > 0) {
    refuse(
      `${target} has an operation in progress, or a submodule repository, that removing the lane ` +
        "would delete. Finish or abort it first.",
      inProgress,
    );
  }
  const refs = runGit(target, ["for-each-ref", "--format=%(refname)", "refs/worktree/", "refs/bisect/"]);
  if (refs.status !== 0 || refs.stdout.trim() !== "") {
    refuse(`${target} has refs of its own that removing the lane would delete.`, refs.stdout.trim().split(/\r?\n/));
  }
  const listed = runGit(target, ["ls-files", "-v", "-z"]);
  const hidden = listed.stdout.split("\0").filter((record) => /^[a-zS] /.test(record));
  if (listed.status !== 0 || hidden.length > 0) {
    refuse(
      `${target} has files marked --skip-worktree or --assume-unchanged, whose edits git does not ` +
        "check. Clear the flags (git update-index --no-skip-worktree / --no-assume-unchanged) first.",
      hidden,
    );
  }
  if (!allowUnmerged) {
    const merged = runGit(target, ["merge-base", "--is-ancestor", "HEAD", base]);
    if (merged.status === 1) {
      refuse(`${target}'s HEAD is not merged into ${base}. Pass --allow-unmerged only for an abandoned lane.`);
    }
    if (merged.status !== 0) refuse(`Could not compare HEAD with ${base}: ${merged.stderr.trim()}.`);
  }
  return { target, registeredPath: registered.path };
}

/**
 * Preflight, delete the generated folders, then hand the rest to plain
 * `git worktree remove`. `runGit` is injectable for tests.
 */
export function removeWorktree({
  repoDir = process.cwd(),
  worktree,
  base = "origin/main",
  allowUnmerged = false,
  cwd,
  initCwd,
  runGit = git,
}) {
  const { target, registeredPath } = preflight({
    repoDir,
    worktree,
    base,
    allowUnmerged,
    runGit,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(initCwd !== undefined ? { initCwd } : {}),
  });
  for (const name of GENERATED_ROOT_DIRS) {
    const dir = path.join(target, name);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      if (fs.existsSync(dir)) {
        throw new Error(
          `${dir} could not be fully deleted (${error.code ?? error.message}). Nothing else has been ` +
            "touched and the lane is still registered. Close whatever holds it, then run this again.",
        );
      }
    }
  }
  const removed = runGit(repoDir, ["worktree", "remove", registeredPath]);
  if (removed.status !== 0) {
    const stillListed = listWorktrees(repoDir, runGit).some((w) => samePath(w.path, registeredPath));
    throw new Error(
      `git did not remove ${target}: ${removed.stderr.trim()}\n` +
        (stillListed
          ? "The lane is intact apart from its node_modules and .next (pnpm install brings them " +
            "back). Commit, stash or discard the work git names, then run this again."
          : "git had already checked the lane was clean and has unregistered it, but could not " +
            "delete everything (a file held open?). What is left needs deleting by hand."),
    );
  }
  return target;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    const target = removeWorktree({ ...options, repoDir: process.cwd() });
    console.log(`Removed worktree ${target}.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) process.exitCode = main();
