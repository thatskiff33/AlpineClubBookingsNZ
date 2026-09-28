#!/usr/bin/env node
/**
 * Remove a finished lane's git worktree without following any link in it.
 *
 *   pnpm run worktree:remove <path>                   # clean + merged into origin/main
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
 * 2.53.0.windows.1:
 *
 * - `git worktree remove --force` cannot delete them. It deregistered the
 *   worktree, deleted part of it and stopped with "Directory not empty".
 * - `git worktree remove` (with or without `--force`) FOLLOWS a junction it
 *   meets and deletes the target's contents, including a junction in a
 *   git-ignored folder, which `git status` never shows.
 *
 * So git never deletes the working tree here. This tool does, with Node's
 * `fs.rmSync`, and then asks git only to forget the registration
 * (`git worktree prune`).
 *
 * ## What is guaranteed
 *
 * 1. Nothing is deleted until every check below has passed.
 * 2. The worktree is resolved to its real path first, and that path is what
 *    is deleted and what is checked afterwards.
 * 3. The deletion is `fs.rmSync(<entry>, { recursive: true })` for each
 *    top-level entry except `.git`, then `.git`, then the empty folder.
 *    `rmSync` removes a link itself instead of descending into it. Verified on
 *    Windows for directory junctions to a drive-letter path and to a
 *    `\\?\Volume{…}` path (which `lstat` reports as a plain directory), so it
 *    also covers a link created after the checks ran.
 * 4. If anything is left on disk afterwards, the registration is NOT pruned and
 *    the tool says so: the lane stays visible to git and can be retried.
 *    Because `.git` goes last, what is left is still a worktree git can check,
 *    and the retry runs every check again (a tracked file that is already
 *    deleted does not count as a change: its content is in HEAD).
 * 5. The registration is pruned only once the directory is gone, and the tool
 *    checks that git no longer lists the worktree. (`git worktree prune` also
 *    forgets any OTHER registration whose directory is already missing; a
 *    locked one is kept.)
 *
 * ## What it refuses, and why
 *
 * - A path that is not a registered LINKED worktree, the main checkout, or a
 *   locked worktree (`git worktree lock` means somebody said keep it).
 * - A path that is itself a link to the worktree: deleting it would remove only
 *   the link.
 * - A registered worktree whose directory is already gone (the message says to
 *   run `git worktree prune`), or one with no `.git` left in it.
 * - Another registered worktree inside the target (the main checkout
 *   included), and any `.git` file or folder below its root: another worktree
 *   or clone whose uncommitted work this worktree's `git status` cannot see.
 *   A Claude Code session's `.claude/worktrees/<name>` is exactly that.
 * - A `.git` that git does not accept as this worktree's own
 *   (`git rev-parse --show-toplevel` names another tree). git searches upward,
 *   so a lane nested in the main checkout would otherwise be checked as the
 *   main checkout.
 * - Being run from inside the target (the current directory, or `INIT_CWD`,
 *   where `pnpm run` was typed): a folder cannot be deleted under a shell that
 *   is sitting in it.
 * - A top-level `node_modules` that is itself a link: the legacy junction shape
 *   `docs/agents/CODEX_WORKFLOW.md` warns about, whose target is another
 *   checkout's tree.
 * - Any link outside the top-level `node_modules` and `.next` (both generated,
 *   and full of links under pnpm). A link a person made elsewhere is somebody's
 *   decision; the tool lists it and stops rather than guess. A link is anything
 *   `readdir` or `lstat` flags, OR a directory whose real path is not its own
 *   path (a volume-path junction or mount point Node does not flag).
 * - Any folder it cannot read. An unreadable folder could hide a link, so a
 *   walk that cannot see everything does not report "no links".
 * - Uncommitted or untracked work, and a HEAD not merged into the base unless
 *   `--allow-unmerged` says the lane was abandoned on purpose.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const USAGE =
  "Usage: pnpm run worktree:remove <worktree-path> [--base <ref>] [--allow-unmerged]";

/** Generated, link-heavy directories at the worktree root that rmSync deletes link-safely. */
const GENERATED_ROOT_DIRS = new Set(["node_modules", ".next"]);

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
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  // A spawn that never started (git not on PATH, cwd gone) has no stderr, only
  // `error`; report that rather than an empty reason.
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

/**
 * Every worktree git knows about, main checkout first (git's own order), with
 * whether it is locked.
 */
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

/**
 * Walk the worktree (except the top-level `.git` entry and the generated
 * directories) and return `{ links, unreadable, repositories }`.
 *
 * `repositories` lists every `.git` file or folder BELOW the root: another
 * worktree or clone living inside this one (a Claude Code session's
 * `.claude/worktrees/<name>` is exactly that), whose own uncommitted work this
 * worktree's `git status` cannot see.
 *
 * A directory counts as a link when `readdir` or `lstat` flags it, or when its
 * real path differs from its own path. The last test is the one that catches a
 * junction to a `\\?\Volume{…}` path or a mount point, which `lstat` reports
 * as an ordinary directory (reproduced in review). Every error other than
 * ENOENT (a file deleted while walking) is recorded, never swallowed.
 */
export function scanWorktree(target) {
  const links = [];
  const unreadable = [];
  const repositories = [];
  const recordError = (p, error) => {
    if (error?.code !== "ENOENT") unreadable.push(`${p} (${error?.code ?? String(error)})`);
  };
  const walk = (dir, realDir, atRoot) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      recordError(dir, error);
      return;
    }
    for (const entry of entries) {
      if (atRoot && (entry.name === ".git" || GENERATED_ROOT_DIRS.has(entry.name))) continue;
      const full = path.join(dir, entry.name);
      // Recorded, and still walked below, so a link inside it is reported too.
      if (entry.name === ".git") repositories.push(full);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (error) {
        recordError(full, error);
        continue;
      }
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        links.push(full);
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
        links.push(`${full} -> ${real}`);
        continue;
      }
      walk(full, real, false);
    }
  };
  let realTarget;
  try {
    realTarget = fs.realpathSync.native(target);
  } catch (error) {
    recordError(target, error);
    return { links, unreadable, repositories };
  }
  walk(target, realTarget, true);
  return { links, unreadable, repositories };
}

/**
 * Check every refusal before anything is deleted. Returns `{ target,
 * registeredPath }`: the worktree's REAL path, which is what is deleted and
 * checked from here on, and the spelling git registered it under. Throws with
 * the reason otherwise.
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
    throw new Error(
      `${given} is itself a link, not the worktree. Deleting it would remove only the link and ` +
        "leave the lane registered. Pass the worktree's own path instead. Refusing.",
    );
  }
  const worktrees = listWorktrees(repoDir, runGit);
  if (worktrees.length > 0 && samePath(worktrees[0].path, given)) {
    throw new Error(`${given} is the main checkout, not a lane worktree. Refusing.`);
  }
  const registered = worktrees.find((w) => samePath(w.path, given));
  if (!registered) {
    throw new Error(`${given} is not a registered worktree of this repository. Refusing.`);
  }
  if (registered.locked) {
    throw new Error(`${given} is locked (git worktree lock). Unlock it deliberately first.`);
  }
  if (!fs.existsSync(given)) {
    throw new Error(
      `${given} is registered, but its directory is already gone, so there is nothing to delete. ` +
        "Run `git worktree prune` to make git forget it.",
    );
  }
  // From here on everything uses the real path, so a volume-path or 8.3
  // spelling cannot make the post-delete checks look at a different string.
  const target = fs.realpathSync.native(given);
  const nested = worktrees.filter((w) => w !== registered && isInside(w.path, target));
  if (nested.length > 0) {
    throw new Error(
      `${target} contains other registered worktrees, which would be deleted with it, uncommitted ` +
        "work included. Nothing has been removed. Remove or move these first:\n  " +
        nested.map((w) => w.path).join("\n  "),
    );
  }
  for (const where of [cwd, initCwd]) {
    if (where && isInside(where, target)) {
      throw new Error(
        `Run this from outside ${target}: the directory ${where} is inside it. ` +
          "The main checkout is a good place to run it from.",
      );
    }
  }
  if (!fs.existsSync(path.join(target, ".git"))) {
    throw new Error(
      `${target} has no .git, so git cannot check what is in it (an earlier removal may have ` +
        "stopped part way). Nothing has been removed. Look at what is left; if none of it is " +
        "needed, delete the folder yourself and then run `git worktree prune`.",
    );
  }
  if (isFlaggedLink(path.join(target, "node_modules"))) {
    throw new Error(
      `${target}/node_modules is itself a link (the legacy junction shape). Use the verified ` +
        "manual unlink in docs/agents/CODEX_WORKFLOW.md instead; this tool will not touch it.",
    );
  }
  const { links, unreadable, repositories } = scanWorktree(target);
  if (unreadable.length > 0) {
    throw new Error(
      `Parts of ${target} could not be read, so it cannot be shown to be free of links. ` +
        "Nothing has been removed. Fix the permissions, then run this again:\n  " +
        unreadable.join("\n  "),
    );
  }
  if (links.length > 0) {
    throw new Error(
      `${target} contains links outside its top-level node_modules and .next. Nothing has been ` +
        "removed. Delete these links yourself (the link, not its target), then run this again:\n  " +
        links.join("\n  "),
    );
  }
  if (repositories.length > 0) {
    throw new Error(
      `${target} contains another git repository or worktree, whose work this worktree's git ` +
        "status cannot see. Nothing has been removed. Deal with these first:\n  " +
        repositories.join("\n  "),
    );
  }
  // git searches upward for a repository. If this .git is broken, a lane nested
  // in the main checkout (.artifacts/worktrees/<n>) would be checked as the MAIN
  // checkout, and every check below would answer for the wrong tree.
  const toplevel = runGit(target, ["rev-parse", "--show-toplevel"]);
  if (toplevel.status !== 0 || !samePath(toplevel.stdout.trim(), target)) {
    const answer =
      toplevel.status === 0 ? ` (it answers for ${toplevel.stdout.trim()})` : `: ${toplevel.stderr.trim()}`;
    throw new Error(
      `git does not see ${target} as its own worktree${answer}. Nothing has been removed. Refusing.`,
    );
  }
  const status = runGit(target, ["status", "--porcelain"]);
  if (status.status !== 0) throw new Error(`git status failed in ${target}: ${status.stderr.trim()}`);
  // A tracked file missing from disk (` D`) loses nothing: its content is in
  // HEAD. It is also exactly what a removal that stopped part way leaves, so
  // allowing it is what makes a retry possible. Anything else is real work.
  const changes = status.stdout
    .split(/\r?\n/)
    .filter((line) => line !== "" && !line.startsWith(" D "));
  if (changes.length > 0) {
    throw new Error(`${target} has uncommitted or untracked changes. Commit or discard them first.`);
  }
  if (!allowUnmerged) {
    const merged = runGit(target, ["merge-base", "--is-ancestor", "HEAD", base]);
    if (merged.status === 1) {
      throw new Error(
        `${target}'s HEAD is not merged into ${base}. Pass --allow-unmerged only for a lane ` +
          "that was abandoned on purpose.",
      );
    }
    if (merged.status !== 0) {
      throw new Error(`Could not compare HEAD with ${base}: ${merged.stderr.trim()}`);
    }
  }
  return { target, registeredPath: registered.path };
}

const RM_OPTIONS = { recursive: true, force: true, maxRetries: 3 };

/**
 * Delete everything except `.git` first, then `.git`, then the empty folder.
 * `.git` goes last so that a removal that stops part way (a file held open)
 * leaves a worktree git can still check, and the retry runs the same checks.
 */
function linkSafeRemove(target) {
  const failures = [];
  for (const name of fs.readdirSync(target)) {
    if (name === ".git") continue;
    try {
      fs.rmSync(path.join(target, name), RM_OPTIONS);
    } catch (error) {
      failures.push(`${name} (${error.code ?? error.message})`);
    }
  }
  const left = fs.readdirSync(target).filter((name) => name !== ".git");
  if (left.length > 0) {
    const why = failures.length > 0 ? `: ${failures.join(", ")}` : "";
    throw new Error(`could not delete ${left.join(", ")}${why}; .git was kept`);
  }
  fs.rmSync(path.join(target, ".git"), RM_OPTIONS);
  fs.rmdirSync(target);
}

/**
 * Preflight, then delete the directory link-safely, then prune the
 * registration once (and only once) the directory is really gone.
 * `remove` and `runGit` are injectable so the "something was left behind" and
 * "prune did not work" paths are testable.
 */
export function removeWorktree({
  repoDir = process.cwd(),
  worktree,
  base = "origin/main",
  allowUnmerged = false,
  cwd,
  initCwd,
  remove = linkSafeRemove,
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
  let removeError;
  try {
    remove(target);
  } catch (error) {
    removeError = error;
  }
  if (fs.existsSync(target)) {
    throw new Error(
      `${target} could not be fully deleted${removeError ? ` (${removeError.message})` : ""}. ` +
        "Its git registration has been KEPT, so the lane is still listed and nothing is lost that " +
        "git knew about. Find what is holding it (an open editor or shell, a locked file), then " +
        "run this again.",
    );
  }
  const pruned = runGit(repoDir, ["worktree", "prune"]);
  if (pruned.status !== 0) throw new Error(`git worktree prune failed: ${pruned.stderr.trim()}`);
  const stillListed = listWorktrees(repoDir, runGit).some(
    (w) => samePath(w.path, target) || samePath(w.path, registeredPath),
  );
  if (stillListed) {
    throw new Error(`${target} was deleted, but git still lists it after git worktree prune.`);
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
