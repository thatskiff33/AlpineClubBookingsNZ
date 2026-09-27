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
 * 2. The deletion is `fs.rmSync(<worktree>, { recursive: true })`, which removes
 *    a link itself instead of descending into it. Verified on Windows for
 *    directory junctions to a drive-letter path and to a `\\?\Volume{…}` path
 *    (which `lstat` reports as a plain directory), so it also covers a link
 *    created after the checks ran.
 * 3. If anything is left on disk afterwards, the registration is NOT pruned and
 *    the tool says so: the lane stays visible to git and can be retried.
 * 4. The registration is pruned only once the directory is gone, and the tool
 *    checks that git no longer lists the worktree. (`git worktree prune` also
 *    forgets any OTHER registration whose directory is already missing; a
 *    locked one is kept.)
 *
 * ## What it refuses, and why
 *
 * - A path that is not a registered LINKED worktree, the main checkout, or a
 *   locked worktree (`git worktree lock` means somebody said keep it).
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
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
export function listWorktrees(repoDir) {
  const out = git(repoDir, ["worktree", "list", "--porcelain"]);
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
 * directories) and return `{ links, unreadable }`.
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
    return { links, unreadable };
  }
  walk(target, realTarget, true);
  return { links, unreadable };
}

/**
 * Check every refusal before anything is deleted. Returns the resolved path;
 * throws with the reason otherwise.
 */
export function preflight({
  repoDir,
  worktree,
  base,
  allowUnmerged,
  cwd = process.cwd(),
  initCwd = process.env.INIT_CWD,
}) {
  const target = path.resolve(worktree);
  const worktrees = listWorktrees(repoDir);
  if (worktrees.length > 0 && samePath(worktrees[0].path, target)) {
    throw new Error(`${target} is the main checkout, not a lane worktree. Refusing.`);
  }
  const registered = worktrees.find((w) => samePath(w.path, target));
  if (!registered) {
    throw new Error(`${target} is not a registered worktree of this repository. Refusing.`);
  }
  if (registered.locked) {
    throw new Error(`${target} is locked (git worktree lock). Unlock it deliberately first.`);
  }
  for (const where of [cwd, initCwd]) {
    if (where && isInside(where, target)) {
      throw new Error(
        `Run this from outside ${target}: the directory ${where} is inside it. ` +
          "The main checkout is a good place to run it from.",
      );
    }
  }
  if (isFlaggedLink(path.join(target, "node_modules"))) {
    throw new Error(
      `${target}/node_modules is itself a link (the legacy junction shape). Use the verified ` +
        "manual unlink in docs/agents/CODEX_WORKFLOW.md instead; this tool will not touch it.",
    );
  }
  const { links, unreadable } = scanWorktree(target);
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
  const status = git(target, ["status", "--porcelain"]);
  if (status.status !== 0) throw new Error(`git status failed in ${target}: ${status.stderr.trim()}`);
  if (status.stdout.trim() !== "") {
    throw new Error(`${target} has uncommitted or untracked changes. Commit or discard them first.`);
  }
  if (!allowUnmerged) {
    const merged = git(target, ["merge-base", "--is-ancestor", "HEAD", base]);
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
  return target;
}

function linkSafeRemove(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Preflight, then delete the directory link-safely, then prune the
 * registration once (and only once) the directory is really gone.
 * `remove` is injectable so the "something was left behind" path is testable.
 */
export function removeWorktree({
  repoDir = process.cwd(),
  worktree,
  base = "origin/main",
  allowUnmerged = false,
  cwd,
  initCwd,
  remove = linkSafeRemove,
}) {
  const target = preflight({
    repoDir,
    worktree,
    base,
    allowUnmerged,
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
  const pruned = git(repoDir, ["worktree", "prune"]);
  if (pruned.status !== 0) throw new Error(`git worktree prune failed: ${pruned.stderr.trim()}`);
  if (listWorktrees(repoDir).some((w) => samePath(w.path, target))) {
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
