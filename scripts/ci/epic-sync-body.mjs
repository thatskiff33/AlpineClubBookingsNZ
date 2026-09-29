#!/usr/bin/env node
/**
 * Print the pull-request description for a `main` -> `epic/**` sync opened BY
 * HAND (#3721).
 *
 *   git switch -c chore/sync-main-into-<epic> origin/epic/<n>-<slug>
 *   git merge origin/main            # resolve any conflict, commit
 *   pnpm run epic:sync-body -- --branch epic/<n>-<slug> > body.md
 *   pnpm run pr:check body.md --base origin/epic/<n>-<slug>
 *   gh pr create --base epic/<n>-<slug> --body-file body.md
 *
 * The six-hourly workflow writes its own body. A hand-opened sync used to get
 * whatever its author typed, and #3718 went red at the concurrency gate before
 * a single check ran — the #3142 failure again, on the one path #3142 did not
 * cover.
 *
 * Nothing here is taken on the author's word. HEAD must be a two-parent merge;
 * its first parent must be on the epic branch and its second on `main`; and the
 * hand resolutions are MEASURED, as the paths where HEAD's tree differs from
 * `git merge-tree`'s automatic merge of the two parents. A conflicted automatic
 * merge writes markers into its tree, so every resolved conflict shows up in
 * that difference too.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { renderHandSyncPrBody } from "./render-epic-sync-pr-body.mjs";

function git(args, { cwd, allowExit = [] } = {}) {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowExit.includes(error.status)) return error.stdout;
    throw new Error(`git ${args.join(" ")} failed: ${(error.stderr || error.message).trim()}`);
  }
}

function isAncestor(commit, ref, cwd) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, ref], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function parseArgs(argv) {
  const args = { branch: null, main: "origin/main", out: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--") continue;
    if (flag === "--branch" || flag === "--main" || flag === "--out") {
      const value = argv[++i];
      if (!value) throw new Error(`${flag} needs a value.`);
      args[flag.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(flag)}.`);
    }
  }
  if (!args.branch) {
    throw new Error("Usage: pnpm run epic:sync-body -- --branch epic/<n>-<slug> [--main origin/main] [--out body.md]");
  }
  return args;
}

/** Read the merge commit at HEAD (of `cwd`, default the current directory) and return the renderer's inputs. */
export function readSyncMerge({ branch, main = "origin/main", cwd }) {
  const [headSha, ...parents] = git(["rev-list", "--parents", "-n", "1", "HEAD"], { cwd }).trim().split(/\s+/);
  if (parents.length !== 2) {
    throw new Error(
      `HEAD ${headSha.slice(0, 9)} has ${parents.length} parent(s); a sync is a two-parent merge. ` +
        `Run \`git merge ${main}\` on a branch made from origin/${branch} first.`,
    );
  }
  const [epicSha, mainSha] = parents;
  const epicRef = `origin/${branch}`;
  if (!isAncestor(epicSha, epicRef, cwd)) {
    throw new Error(
      `HEAD's first parent ${epicSha.slice(0, 9)} is not on ${epicRef}. ` +
        "Merge main INTO the epic branch (epic first), and fetch before you run this.",
    );
  }
  if (!isAncestor(mainSha, main, cwd)) {
    throw new Error(`HEAD's second parent ${mainSha.slice(0, 9)} is not on ${main}. Fetch ${main} and check the merge.`);
  }

  // Exit 1 means the automatic merge conflicted; its tree id is still line one.
  const autoTree = git(["merge-tree", "--write-tree", epicSha, mainSha], { cwd, allowExit: [1] }).split("\n")[0].trim();
  if (!/^[0-9a-f]{40}$/.test(autoTree)) {
    throw new Error("git merge-tree did not return a tree id; git 2.38 or later is required.");
  }
  const resolvedFiles = git(["diff", "--name-only", "--no-renames", autoTree, `${headSha}^{tree}`], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return { branch, headSha, epicSha, mainSha, resolvedFiles };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const body = renderHandSyncPrBody(readSyncMerge(args));
    if (args.out) {
      writeFileSync(args.out, body, "utf8");
      console.error(`Wrote ${args.out}. Check it with: pnpm run pr:check ${args.out} --base origin/${args.branch}`);
    } else {
      process.stdout.write(body);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
