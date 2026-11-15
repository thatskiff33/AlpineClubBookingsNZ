/**
 * `sekreton-prepare-base.sh` gives the Sekreton gate's `fast-censuses` and
 * `migrations` jobs an origin/main to compare against (ALP-651).
 *
 * Each case builds real repositories in a temporary directory and runs the
 * real script, because what it promises is Git state: after a pass,
 * `refs/remotes/origin/main` is the base main, never HEAD; after a failure,
 * stderr says why.
 *
 * `test:related` cannot select this file: it runs the shell script from disk,
 * so it has no import edge to it (`docs/TESTING.md`). Run it with
 * `pnpm run test:named`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bashFixturePath, bashGateArgs } from "@/lib/__tests__/helpers/bash-fixture-path";

// INV-SSOT: the ref the file-size ratchet and the fast-census runner judge a
// change against is owned by this module. The helper is bash and cannot import
// it, so every ref these cases read is built from it: if the constant moves,
// the helper's behavioural cases go red instead of the helper quietly preparing
// a ref nobody reads.
import { DEFAULT_BASE_REF } from "../../../scripts/lib/budget-base-ref.mjs";

const SCRIPT = path.join(process.cwd(), "scripts", "ci", "sekreton-prepare-base.sh");
const BASE_REF = `refs/remotes/${DEFAULT_BASE_REF}`;

/**
 * A hang-catcher, not a pass mark (`docs/TESTING.md`, "A test that launches a
 * process needs its own budget"). Each case forks about fifteen `git` and
 * `bash` processes; on Linux all eight cases together take about two seconds,
 * so this number never decides a run, it only stops a wedged fork from holding
 * the shard.
 */
const GIT_FORK_TIMEOUT_MS = 30_000;

// Hermetic Git: neither the machine's system nor the user's global config (an
// `init.defaultBranch`, a signing key, a `url.*.insteadOf`) can change a case.
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tempDir(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  ROOTS.push(root);
  return root;
}

function commit(root: string, name: string): string {
  writeFileSync(path.join(root, `${name}.txt`), `${name}\n`, "utf8");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", name);
  return git(root, "rev-parse", "HEAD");
}

/** A repository on `main` with one commit. */
function newRepo(): string {
  const root = tempDir("acb-prepare-base-");
  git(root, "init", "--quiet");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "base");
  return root;
}

/** A clone of `upstream` with the `origin/main` the clone created removed. */
function cloneWithoutOriginMain(upstream: string): string {
  const checkout = tempDir("acb-prepare-base-clone-");
  git(checkout, "clone", "--quiet", upstream, ".");
  git(checkout, "config", "user.email", "test@example.invalid");
  git(checkout, "config", "user.name", "Test");
  git(checkout, "config", "commit.gpgsign", "false");
  git(checkout, "update-ref", "-d", BASE_REF);
  return checkout;
}

/** A feature branch forked from main, with a commit of its own, checked out. */
function branchOff(root: string): string {
  git(root, "checkout", "--quiet", "-b", "feature");
  return commit(root, "feature");
}

function prepareBase(cwd: string) {
  return spawnSync("bash", bashGateArgs(bashFixturePath(SCRIPT, cwd), [], GIT_ENV), {
    cwd,
    encoding: "utf8",
  });
}

function baseRef(root: string): string {
  return git(root, "rev-parse", "--verify", `${BASE_REF}^{commit}`);
}

describe("sekreton-prepare-base.sh", () => {
  it(
    "fetches main from the origin remote when there is one",
    () => {
      const upstream = newRepo();
      const upstreamMain = commit(upstream, "upstream-only");
      const checkout = cloneWithoutOriginMain(upstream);
      // Moves on after the clone: the script must fetch, not reuse a stale ref.
      const latest = commit(upstream, "after-clone");
      expect(latest).not.toBe(upstreamMain);

      const result = prepareBase(checkout);

      expect(result.status, result.stderr).toBe(0);
      expect(baseRef(checkout)).toBe(latest);
    },
    GIT_FORK_TIMEOUT_MS,
  );

  it(
    "prepares origin/main even when the remote's configured refspec does not cover main",
    () => {
      // A shallow or single-branch checkout narrows `remote.origin.fetch`. Git
      // updates remote-tracking refs opportunistically from that configured
      // refspec, so with the default one origin/main moves whatever the script
      // names; only a narrowed refspec shows the script names the ref itself.
      const upstream = newRepo();
      const checkout = cloneWithoutOriginMain(upstream);
      git(checkout, "config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other");
      const latest = commit(upstream, "after-clone");

      const result = prepareBase(checkout);

      expect(result.status, result.stderr).toBe(0);
      expect(baseRef(checkout)).toBe(latest);
    },
    GIT_FORK_TIMEOUT_MS,
  );

  it(
    "replaces a stale origin/main that is not an ancestor of the origin's main",
    () => {
      // The `+` in the fetch refspec is what lets the ref move here. Without it
      // Git refuses the update and the gate fails on a checkout whose
      // origin/main came from an earlier snapshot or a rewritten remote main.
      const upstream = newRepo();
      const checkout = cloneWithoutOriginMain(upstream);
      git(checkout, "checkout", "--quiet", "-b", "stale");
      const stale = commit(checkout, "stale-sibling");
      git(checkout, "update-ref", BASE_REF, stale);
      const latest = commit(upstream, "after-clone");

      const result = prepareBase(checkout);

      expect(result.status, result.stderr).toBe(0);
      expect(baseRef(checkout)).toBe(latest);
      expect(baseRef(checkout)).not.toBe(stale);
    },
    GIT_FORK_TIMEOUT_MS,
  );

  it(
    "uses local main when there is no origin and main is an ancestor of HEAD",
    () => {
      const root = newRepo();
      const main = git(root, "rev-parse", "main");
      branchOff(root);

      const result = prepareBase(root);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("no origin remote");
      expect(baseRef(root)).toBe(main);
    },
    GIT_FORK_TIMEOUT_MS,
  );

  it(
    "uses local main when it has moved past the branch's fork point",
    () => {
      const root = newRepo();
      const head = branchOff(root);
      git(root, "checkout", "--quiet", "main");
      const advancedMain = commit(root, "main-moved-on");
      git(root, "checkout", "--quiet", "feature");

      const result = prepareBase(root);

      expect(result.status, result.stderr).toBe(0);
      expect(baseRef(root)).toBe(advancedMain);
      expect(baseRef(root)).not.toBe(head);
    },
    GIT_FORK_TIMEOUT_MS,
  );

  it(
    "replaces a stale origin/main that is not an ancestor of local main",
    () => {
      const root = newRepo();
      git(root, "checkout", "--quiet", "-b", "unrelated");
      git(root, "update-ref", BASE_REF, commit(root, "unrelated"));
      git(root, "checkout", "--quiet", "main");
      const main = commit(root, "main-moved-on");

      const result = prepareBase(root);

      expect(result.status, result.stderr).toBe(0);
      expect(baseRef(root)).toBe(main);
    },
    GIT_FORK_TIMEOUT_MS,
  );

  it(
    "fails with a message naming both sources when there is no origin and no main",
    () => {
      const root = newRepo();
      branchOff(root);
      git(root, "branch", "--quiet", "-D", "main");

      const result = prepareBase(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/no 'origin' remote/);
      expect(result.stderr).toMatch(/refs\/heads\/main/);
    },
    GIT_FORK_TIMEOUT_MS,
  );

  it(
    "fails, without falling back to local main, when the origin fetch fails",
    () => {
      const root = newRepo();
      branchOff(root);
      git(root, "remote", "add", "origin", path.join(root, "does-not-exist"));

      const result = prepareBase(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/could not fetch main from the origin remote/);
      expect(
        spawnSync("git", ["rev-parse", "--verify", "--quiet", BASE_REF], {
          cwd: root,
          env: { ...process.env, ...GIT_ENV },
        }).status,
      ).not.toBe(0);
    },
    GIT_FORK_TIMEOUT_MS,
  );
});
