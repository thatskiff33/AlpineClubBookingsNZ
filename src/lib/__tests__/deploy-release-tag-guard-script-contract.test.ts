import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bashFixturePath, bashGateArgs } from "@/lib/__tests__/helpers/bash-fixture-path";
import { readRepoFile } from "@/lib/__tests__/helpers/compose";
import { DEPLOY_SCRIPT, shellFunctionSource } from "@/lib/__tests__/helpers/deploy-script";

/**
 * The production deploy refuses a commit that is not a published release
 * (#4978, `INV-OPS-019`).
 *
 * `validate_deploy_commit_is_release_tag` is lifted out of the deploy script and
 * RUN against a scratch repository with a real bare "origin", so each case is a
 * real `git ls-remote` answer rather than a grep of the guard's text. Each case
 * names the deploy that would reach production if it silently changed: an
 * untagged commit, a lightweight tag, a tag only the deploy host holds, an
 * override nobody explained.
 *
 * `test:related` cannot select this file: it reads the shell script from disk,
 * so it has no import edge to it (`docs/TESTING.md`). Run it with
 * `pnpm run test:named`.
 */

const SCRIPT = readRepoFile(DEPLOY_SCRIPT);
const GUARD = "validate_deploy_commit_is_release_tag";
const ALLOW = "ALLOW_UNTAGGED_DEPLOY_COMMIT";
const REASON = "UNTAGGED_DEPLOY_COMMIT_REASON";

/** The script with whole-line comments removed, as the sibling contract suite reads it. */
const code = SCRIPT.split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

/** A script line, exactly, asserted present once. */
function exactLine(line: string): string {
  const occurrences = SCRIPT.split("\n").filter((candidate) => candidate === line);
  expect(occurrences.length, `the deploy script must carry \`${line}\` exactly once`).toBe(1);
  return line;
}

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "deploy-release-tag-guard-"));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}

/**
 * A bare origin and a clone of it with two pushed commits. Each case gets its
 * own pair, because tags pushed by one case must not satisfy another.
 */
function scratchRepository() {
  const dir = mkdtempSync(path.join(fixtureRoot, "case-"));
  const origin = path.join(dir, "origin.git");
  const clone = path.join(dir, "clone");
  git(dir, ["init", "-q", "--bare", origin]);
  mkdirSync(clone);
  git(clone, ["init", "-q", "-b", "main"]);
  git(clone, ["remote", "add", "origin", origin]);
  git(clone, ["commit", "-q", "--allow-empty", "-m", "older"]);
  const older = git(clone, ["rev-parse", "HEAD"]);
  git(clone, ["commit", "-q", "--allow-empty", "-m", "deploy me"]);
  const head = git(clone, ["rev-parse", "HEAD"]);
  git(clone, ["push", "-q", "origin", "main"]);
  return { dir, origin, clone, head, older };
}

type Env = Partial<Record<typeof ALLOW | typeof REASON, string>>;

/**
 * Runs the guard the way the wrapper does: the script's own defaults and
 * helpers, then the guard, in a shell that inherited only `env`.
 */
function runGuard(repo: { dir: string; clone: string }, resolvedRef: string, env: Env = {}) {
  const harness = path.join(repo.dir, "harness.sh");
  writeFileSync(
    harness,
    [
      "set -Eeuo pipefail",
      'info() { printf "INFO %s\\n" "$1"; }',
      'warn() { printf "WARN %s\\n" "$1"; }',
      exactLine(`${ALLOW}="\${${ALLOW}:-0}"`),
      exactLine(`${REASON}="\${${REASON}:-}"`),
      shellFunctionSource(SCRIPT, "env_flag_is_true"),
      shellFunctionSource(SCRIPT, "is_release_tag_name"),
      shellFunctionSource(SCRIPT, GUARD),
      GUARD,
      "echo GUARD_PASSED",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = spawnSync(
    "bash",
    bashGateArgs(bashFixturePath(harness), [], {
      SOURCE_REPO: bashFixturePath(repo.clone),
      RESOLVED_REF: resolvedRef,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...env,
    }),
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    passed: result.stdout.includes("GUARD_PASSED"),
  };
}

describe("an untagged commit is refused unless somebody records why (#4978)", () => {
  it("refuses a pushed commit that no tag points at, naming the commit and the override", () => {
    const repo = scratchRepository();
    const result = runGuard(repo, repo.head);
    expect(result.code).not.toBe(0);
    expect(result.passed).toBe(false);
    expect(result.stderr).toContain(`Deploy commit ${repo.head} is not a release`);
    expect(result.stderr).toContain(`${ALLOW}=1 together with a non-empty ${REASON}`);
  });

  it("passes when an annotated vX.Y.Z tag on origin points at the commit, and names it", () => {
    const repo = scratchRepository();
    git(repo.clone, ["tag", "-a", "v1.2.3", "-m", "release v1.2.3"]);
    git(repo.clone, ["push", "-q", "origin", "v1.2.3"]);
    const result = runGuard(repo, repo.head);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Deploy commit ${repo.head} is release v1.2.3, confirmed against origin.`);
    expect(result.stdout).not.toContain("WARN");
  });

  it("refuses a lightweight vX.Y.Z tag, as release:cut publish does", () => {
    const repo = scratchRepository();
    git(repo.clone, ["tag", "v1.2.3"]);
    git(repo.clone, ["push", "-q", "origin", "v1.2.3"]);
    const result = runGuard(repo, repo.head);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("is not a release");
  });

  it("refuses an annotated tag that exists only in the deploy host's clone", () => {
    const repo = scratchRepository();
    git(repo.clone, ["tag", "-a", "v1.2.3", "-m", "never pushed"]);
    const result = runGuard(repo, repo.head);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("is not a release");
  });

  it("refuses when origin's release tag points at a different commit", () => {
    const repo = scratchRepository();
    git(repo.clone, ["tag", "-a", "v1.2.3", "-m", "release", repo.older]);
    git(repo.clone, ["push", "-q", "origin", "v1.2.3"]);
    const result = runGuard(repo, repo.head);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`Deploy commit ${repo.head} is not a release`);
  });

  it("refuses an annotated tag that is not a strict vX.Y.Z release name", () => {
    const repo = scratchRepository();
    git(repo.clone, ["tag", "-a", "v1.2.3-rc1", "-m", "candidate"]);
    git(repo.clone, ["tag", "-a", "very-important", "-m", "not a release"]);
    git(repo.clone, ["push", "-q", "origin", "v1.2.3-rc1", "very-important"]);
    const result = runGuard(repo, repo.head);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("is not a release");
  });

  it("refuses the override flag without a reason", () => {
    const repo = scratchRepository();
    const result = runGuard(repo, repo.head, { [ALLOW]: "1" });
    expect(result.code).not.toBe(0);
    expect(result.passed).toBe(false);
    expect(result.stderr).toContain(`${ALLOW} is set, but ${REASON} is empty.`);
  });

  it("does not treat a reason without the flag as an override", () => {
    const repo = scratchRepository();
    const result = runGuard(repo, repo.head, { [REASON]: "staging" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("is not a release");
  });

  it("proceeds with the flag and a reason, warning loudly with the reason", () => {
    const repo = scratchRepository();
    const result = runGuard(repo, repo.head, {
      [ALLOW]: "true",
      [REASON]: "staging rehearsal of main",
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.passed).toBe(true);
    expect(result.stdout).toContain("WARN DEPLOYING A COMMIT THAT IS NOT A RELEASE.");
    expect(result.stdout).toContain("WARN Reason given: staging rehearsal of main");
  });

  // Chosen on purpose, and the opposite of the published-commit check: that
  // one has remote-tracking refs to fall back on, while here the only local
  // answer is a local tag, which is exactly what the guard distrusts.
  it("refuses when origin cannot be reached, even if the host holds a matching tag", () => {
    const repo = scratchRepository();
    git(repo.clone, ["tag", "-a", "v1.2.3", "-m", "release"]);
    git(repo.clone, ["push", "-q", "origin", "v1.2.3"]);
    git(repo.clone, ["remote", "set-url", "origin", path.join(repo.dir, "gone.git")]);
    const refused = runGuard(repo, repo.head);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(`Could not reach origin to confirm that deploy commit ${repo.head} is a release`);

    const overridden = runGuard(repo, repo.head, { [ALLOW]: "1", [REASON]: "GitHub outage" });
    expect(overridden.code, overridden.stderr).toBe(0);
    expect(overridden.stdout).toContain("WARN Reason given: GitHub outage");
  });
});

describe("one definition of a release tag (INV-SSOT)", () => {
  // The deploy and `release:cut` both decide what a release tag is. They are in
  // two languages, so the definitions are checked against each other by
  // behaviour: any name one accepts and the other refuses fails here.
  let parseReleaseTag: (tag: string) => unknown;
  beforeAll(async () => {
    const modulePath = path.resolve(process.cwd(), "scripts/release/cut-release.mjs");
    ({ parseReleaseTag } = (await import(pathToFileURL(modulePath).href)) as {
      parseReleaseTag: (tag: string) => unknown;
    });
  });

  const names = [
    "v0.13.2",
    "v0.0.0",
    "v10.20.30",
    "v1.2",
    "v1.2.3.4",
    "v01.2.3",
    "v1.02.3",
    "v1.2.03",
    "v1.2.3-rc1",
    "1.2.3",
    "V1.2.3",
    "v1.2.3 ",
    "vx.y.z",
    "v*",
  ];

  it("accepts and refuses exactly the names release:cut does", () => {
    const harness = [
      shellFunctionSource(SCRIPT, "is_release_tag_name"),
      'for name in "$@"; do if is_release_tag_name "$name"; then echo "yes"; else echo "no"; fi; done',
    ].join("\n");
    const output = execFileSync("bash", ["-c", harness, "harness", ...names], { encoding: "utf8" });
    const shell = output.trim().split("\n");
    // `parseReleaseTag` trims its input; the deploy reads tag names that git
    // never pads, so only untrimmed names are compared.
    const node = names.map((name) => (name === name.trim() && parseReleaseTag(name) ? "yes" : "no"));
    expect(shell).toEqual(node);
    expect(shell.filter((answer) => answer === "yes")).toHaveLength(3);
  });
});

describe("the guard runs before anything is resolved, built, pulled or migrated", () => {
  it("is called right after the published-commit check in deploy mode", () => {
    const resolve = code.indexOf("\nresolve_ref\n");
    const published = code.indexOf("\nvalidate_deploy_commit_is_published\n");
    const tagged = code.indexOf(`\n${GUARD}\n`);
    const images = code.indexOf("\nresolve_image_refs\n");
    const workspace = code.indexOf("\ncreate_workspace\n");

    expect(resolve).toBeGreaterThan(0);
    expect(published).toBeGreaterThan(resolve);
    expect(tagged).toBeGreaterThan(published);
    expect(images).toBeGreaterThan(tagged);
    expect(workspace).toBeGreaterThan(images);
  });

  it("is called right after the published-commit check in image-build mode", () => {
    const mode = code.slice(
      code.indexOf('if [ "$WRAPPER_MODE" = "build-and-push-images" ]; then'),
      code.indexOf("Built and pushed ${RESOLVED_REF}"),
    );
    const published = mode.indexOf("\n  validate_deploy_commit_is_published\n");
    const tagged = mode.indexOf(`\n  ${GUARD}\n`);
    const images = mode.indexOf("\n  resolve_image_refs\n");
    const workspace = mode.indexOf("\n  create_workspace\n");

    expect(published).toBeGreaterThan(0);
    expect(tagged).toBeGreaterThan(published);
    expect(images).toBeGreaterThan(tagged);
    expect(workspace).toBeGreaterThan(images);
  });

  it("is called exactly twice, once per mode", () => {
    const calls = code.split("\n").filter((line) => line.trim() === GUARD);
    expect(calls).toHaveLength(2);
  });
});

describe("the documents a club follows install a release, not main", () => {
  // A bare `git clone` leaves a new club on `main`, the development branch, as
  // it happened to be that day. Each install snippet checks out the latest
  // release tag straight after cloning and entering the checkout.
  it.each(["docs/IMPLEMENTATION_GUIDE.md", "DEPLOYMENT.md"])(
    "%s checks out the latest release tag after git clone",
    (file) => {
      const lines = readRepoFile(file).split("\n");
      const clone = lines.findIndex((line) => line.startsWith("git clone "));
      expect(clone, `${file} must have an install snippet`).toBeGreaterThan(-1);
      expect(lines[clone + 1]).toMatch(/^cd /);
      expect(lines[clone + 2]).toBe("git fetch --tags");
      // `describe` without `--tags` sees annotated tags only, and `--match`
      // keeps it to release names, so it finds the newest release on main.
      expect(lines[clone + 3]).toMatch(/^git checkout /);
      expect(lines[clone + 3]).toContain(
        `"$(git describe --abbrev=0 --match 'v[0-9]*' origin/main)"`,
      );
    },
  );

  it("documents both override settings in CONFIGURATION.md", () => {
    const configuration = readRepoFile("CONFIGURATION.md");
    expect(configuration).toContain(`\`${ALLOW}\``);
    expect(configuration).toContain(`\`${REASON}\``);
  });
});
