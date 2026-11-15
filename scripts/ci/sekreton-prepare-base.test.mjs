/**
 * `sekreton-prepare-base.sh` gives the Sekreton gate's `fast-censuses` and
 * `migrations` jobs an origin/main to compare against (ALP-651).
 *
 * Each case builds real repositories in a temporary directory and runs the
 * real script, because what it promises is Git state: after a pass,
 * `refs/remotes/origin/main` is the base main, never HEAD; after a failure,
 * stderr says why.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "sekreton-prepare-base.sh");

const ROOTS = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repository on `main` with one commit. */
function newRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "acb-prepare-base-"));
  ROOTS.push(root);
  git(root, "init", "--quiet");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "base");
  return root;
}

function commit(root, name) {
  writeFileSync(path.join(root, `${name}.txt`), `${name}\n`, "utf8");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", name);
  return git(root, "rev-parse", "HEAD");
}

/** A feature branch forked from main, with a commit of its own, checked out. */
function branchOff(root) {
  git(root, "checkout", "--quiet", "-b", "feature");
  return commit(root, "feature");
}

function prepareBase(cwd) {
  return spawnSync("bash", [SCRIPT], { cwd, encoding: "utf8" });
}

function originMain(root) {
  return git(root, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
}

describe("sekreton-prepare-base.sh", () => {
  it("fetches main from the origin remote when there is one", () => {
    const upstream = newRepo();
    const upstreamMain = commit(upstream, "upstream-only");
    const checkout = mkdtempSync(path.join(os.tmpdir(), "acb-prepare-base-clone-"));
    ROOTS.push(checkout);
    git(checkout, "clone", "--quiet", upstream, ".");
    git(checkout, "update-ref", "-d", "refs/remotes/origin/main");
    // Moves on after the clone: the script must fetch, not reuse a stale ref.
    const latest = commit(upstream, "after-clone");
    expect(latest).not.toBe(upstreamMain);

    const result = prepareBase(checkout);

    expect(result.status, result.stderr).toBe(0);
    expect(originMain(checkout)).toBe(latest);
  });

  it("uses local main when there is no origin and main is an ancestor of HEAD", () => {
    const root = newRepo();
    const main = git(root, "rev-parse", "main");
    branchOff(root);

    const result = prepareBase(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no origin remote");
    expect(originMain(root)).toBe(main);
  });

  it("uses local main when it has moved past the branch's fork point", () => {
    const root = newRepo();
    const head = branchOff(root);
    git(root, "checkout", "--quiet", "main");
    const advancedMain = commit(root, "main-moved-on");
    git(root, "checkout", "--quiet", "feature");

    const result = prepareBase(root);

    expect(result.status, result.stderr).toBe(0);
    expect(originMain(root)).toBe(advancedMain);
    expect(originMain(root)).not.toBe(head);
  });

  it("replaces a stale origin/main that is not an ancestor of local main", () => {
    const root = newRepo();
    git(root, "checkout", "--quiet", "-b", "unrelated");
    git(root, "update-ref", "refs/remotes/origin/main", commit(root, "unrelated"));
    git(root, "checkout", "--quiet", "main");
    const main = commit(root, "main-moved-on");

    const result = prepareBase(root);

    expect(result.status, result.stderr).toBe(0);
    expect(originMain(root)).toBe(main);
  });

  it("fails with a message naming both sources when there is no origin and no main", () => {
    const root = newRepo();
    branchOff(root);
    git(root, "branch", "--quiet", "-D", "main");

    const result = prepareBase(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no 'origin' remote/);
    expect(result.stderr).toMatch(/refs\/heads\/main/);
  });

  it("fails, without falling back to local main, when the origin fetch fails", () => {
    const root = newRepo();
    branchOff(root);
    git(root, "remote", "add", "origin", path.join(root, "does-not-exist"));

    const result = prepareBase(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/could not fetch main from the origin remote/);
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], { cwd: root }).status).not.toBe(0);
  });
});
