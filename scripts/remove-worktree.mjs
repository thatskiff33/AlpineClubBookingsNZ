#!/usr/bin/env node
/**
 * Remove a finished lane's git worktree without tripping over pnpm's links.
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
 * 2,700 directory JUNCTIONS in one worktree of this repository, each pointing
 * into that worktree's own `node_modules/.pnpm`. `git worktree remove --force`
 * cannot delete them. Measured with git 2.53.0.windows.1 on a real
 * `Local_Repos\wt-*` worktree: it deregistered the worktree, deleted part of the
 * tree, and then stopped with "Directory not empty", leaving a half-deleted
 * folder git no longer knows about.
 *
 * Worse, review then reproduced that `git worktree remove` (with or without
 * `--force`) FOLLOWS a junction it meets anywhere else in the tree and deletes
 * the target's contents: a junction in a git-ignored `.cache/` pointing outside
 * the worktree emptied that outside directory. `git status` never lists ignored
 * files, so a clean status proves nothing about links.
 *
 * So: the top-level `node_modules` is removed first with Node's `fs.rmSync`,
 * which sees a junction as a link (`lstat().isSymbolicLink()`) and removes the
 * link itself, not its target; and a link ANYWHERE ELSE in the worktree is a
 * refusal, because the remaining deletion is git's and git would follow it.
 *
 * ## What is guaranteed
 *
 * Nothing is deleted until every check below has passed. The links inside the
 * top-level `node_modules` are unlinked, never followed. `git worktree remove`
 * (never with `--force`) is only handed a tree that contains no links at all.
 *
 * ## What it refuses, and why each refusal exists
 *
 * - A path that is not a registered LINKED worktree, or is the main checkout:
 *   the tool removes lanes, never the repository.
 * - A locked worktree (`git worktree lock`): somebody said keep it.
 * - Being run from inside the target (the current directory, or `INIT_CWD`,
 *   where `pnpm run` was typed): the folder cannot be deleted under a shell that
 *   is sitting in it, and the result is the half-removed state above.
 * - A top-level `node_modules` that is itself a link: the legacy junction shape
 *   `docs/agents/CODEX_WORKFLOW.md` warns about, whose target is another
 *   checkout's tree; it needs the verified manual unlink there.
 * - Any other link in the worktree: git would follow it (above).
 * - Uncommitted or untracked work: `git worktree remove` would refuse too, and
 *   deleting `node_modules` first must not be what happens before that refusal.
 * - A HEAD not merged into the base, unless `--allow-unmerged` says the lane was
 *   abandoned on purpose. Unpushed commits cannot be re-downloaded.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const USAGE =
  "Usage: pnpm run worktree:remove <worktree-path> [--base <ref>] [--allow-unmerged]";

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

/** A path's comparable form: its real path where it exists, case-folded on Windows. */
function canonical(p) {
  let resolved = path.resolve(p);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A path that does not exist compares by its resolved spelling.
  }
  resolved = resolved.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) {
  return canonical(a) === canonical(b);
}

function isInside(child, parent) {
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

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Every symlink or junction in the worktree except inside the top-level
 * `node_modules` (removed link-safely by this tool) and `.git`.
 */
export function linksOutsideNodeModules(target) {
  const found = [];
  const walk = (dir, atRoot) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (atRoot && (entry.name === ".git" || entry.name === "node_modules")) continue;
      const full = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) found.push(full);
      else if (stat.isDirectory()) walk(full, false);
    }
  };
  walk(target, true);
  return found;
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
  if (isLink(path.join(target, "node_modules"))) {
    throw new Error(
      `${target}/node_modules is itself a link (the legacy junction shape). Use the verified ` +
        "manual unlink in docs/agents/CODEX_WORKFLOW.md instead; this tool will not touch it.",
    );
  }
  const links = linksOutsideNodeModules(target);
  if (links.length > 0) {
    throw new Error(
      `${target} contains links outside its top-level node_modules. git worktree remove would ` +
        "follow them and delete what they point at, so nothing has been removed. Delete these " +
        "links yourself (the link, not its target), then run this again:\n  " +
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

/** Preflight, then the top-level node_modules (links unlinked), then git. */
export function removeWorktree({
  repoDir = process.cwd(),
  worktree,
  base = "origin/main",
  allowUnmerged = false,
  cwd,
  initCwd,
}) {
  const target = preflight({
    repoDir,
    worktree,
    base,
    allowUnmerged,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(initCwd !== undefined ? { initCwd } : {}),
  });
  fs.rmSync(path.join(target, "node_modules"), { recursive: true, force: true, maxRetries: 3 });
  const removed = git(repoDir, ["worktree", "remove", target]);
  if (removed.status !== 0) {
    throw new Error(`git worktree remove failed: ${removed.stderr.trim()}`);
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
