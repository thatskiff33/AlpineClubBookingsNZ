#!/usr/bin/env node
/**
 * Remove a finished lane's git worktree without tripping over pnpm's links.
 *
 *   pnpm run worktree:remove <path>                   # clean + merged into origin/main
 *   pnpm run worktree:remove <path> --base <ref>      # merged into another base
 *   pnpm run worktree:remove <path> --allow-unmerged  # an abandoned lane
 *   node scripts/remove-worktree.mjs <path> ...       # the same, without pnpm
 *
 * ## Why this exists (#3673)
 *
 * pnpm's strict layout builds `node_modules` out of links: on Windows about
 * 2,700 directory JUNCTIONS in one worktree of this repository, each pointing
 * into that worktree's own `node_modules/.pnpm`. `git worktree remove --force`
 * cannot delete them. Measured with git 2.53.0.windows.1 on a real
 * `Local_Repos\wt-*` worktree: it deregistered the worktree, deleted part of the
 * tree, and then stopped with "Directory not empty" — leaving a half-deleted
 * folder that git no longer knows about. The package files themselves are hard
 * links into the shared pnpm store, which that failure did not damage (`pnpm
 * store status`: untouched), but the lane is left in a state nobody chose.
 *
 * Removing `node_modules` FIRST, with a remover that unlinks a link instead of
 * descending through it, and only then running `git worktree remove`, works:
 * Node's `fs.rmSync` sees a junction as a link (`lstat().isSymbolicLink()`) and
 * removes the link itself, never its target.
 *
 * ## What it refuses, and why each refusal exists
 *
 * - A path that is not a registered LINKED worktree of this repository, or is
 *   the main checkout: the tool removes lanes, never the repository.
 * - A top-level `node_modules` that is itself a link. That is the legacy
 *   junction shape `docs/agents/CODEX_WORKFLOW.md` warns about, where the target
 *   is another checkout's tree; it needs the verified manual unlink there, not a
 *   generic remover.
 * - Uncommitted or untracked work: `git worktree remove` would refuse too, and
 *   deleting `node_modules` first must not be what makes the remaining refusal
 *   happen after half the work is gone.
 * - A HEAD not merged into the base, unless `--allow-unmerged` says the lane was
 *   abandoned on purpose. Unpushed commits are the one thing here that cannot be
 *   re-downloaded.
 *
 * It never passes `--force` to git.
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

function samePath(a, b) {
  const norm = (p) => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/** Every worktree git knows about, main checkout first (git's own order). */
export function listWorktrees(repoDir) {
  const out = git(repoDir, ["worktree", "list", "--porcelain"]);
  if (out.status !== 0) throw new Error(`git worktree list failed: ${out.stderr.trim()}`);
  return out.stdout
    .split(/\r?\n\r?\n/)
    .map((block) => /^worktree (.+)$/m.exec(block)?.[1])
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Check every refusal before anything is deleted. Returns the resolved path;
 * throws with the reason otherwise.
 */
export function preflight({ repoDir, worktree, base, allowUnmerged }) {
  const target = path.resolve(worktree);
  const worktrees = listWorktrees(repoDir);
  if (worktrees.length > 0 && samePath(worktrees[0], target)) {
    throw new Error(`${target} is the main checkout, not a lane worktree. Refusing.`);
  }
  if (!worktrees.some((p) => samePath(p, target))) {
    throw new Error(`${target} is not a registered worktree of this repository. Refusing.`);
  }
  if (isLink(path.join(target, "node_modules"))) {
    throw new Error(
      `${target}/node_modules is itself a link (the legacy junction shape). Use the verified ` +
        "manual unlink in docs/agents/CODEX_WORKFLOW.md instead; this tool will not touch it.",
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

/** Preflight, then node_modules (links unlinked, never followed), then git. */
export function removeWorktree({ repoDir = process.cwd(), worktree, base = "origin/main", allowUnmerged = false }) {
  const target = preflight({ repoDir, worktree, base, allowUnmerged });
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
