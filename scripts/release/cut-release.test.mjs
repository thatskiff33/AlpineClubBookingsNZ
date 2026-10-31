import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  bumpPackageJson,
  bumpVersion,
  computeRelease,
  FEATURE_FRAGMENT_SUFFIX,
  fragmentBump,
  githubHeadingAnchor,
  latestReleaseTag,
  main,
  MAX_RELEASE_NOTES_CHARS,
  parseArgs,
  parseGitHubRemote,
  prepareRelease,
  publishRelease,
  releaseBody,
  ReleaseCutError,
} from "./cut-release.mjs";
import { releaseSection } from "./compile-changelog.mjs";

// Every test runs against a throwaway fixture: a bare "origin" and a clone of
// it. The clone's origin URL is a GitHub URL that git's `insteadOf` rewrites to
// the bare fixture, so fetch and ls-remote never leave the machine. `git push`
// and `gh` are never run for real — the runner below records them and answers
// on their behalf.

const GITHUB_URL = "https://github.com/fixture-owner/fixture-repo.git";
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

const NOTE = [
  "<!-- changelog-pointer-note:start -->",
  "",
  "Entries live in `changelog.d/`.",
  "",
  "<!-- changelog-pointer-note:end -->",
].join("\n");

const CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  NOTE,
  "",
  "## 0.13.2 - 2026-07-23",
  "",
  "- **An older, already released entry (#1234).**",
  "",
].join("\n");

const PACKAGE_JSON = `{\n  "name": "fixture-club-app",\n  "version": "0.13.2",\n  "private": true,\n  "scripts": {\n    "x": "node -e \\"1\\""\n  }\n}\n`;

const tempRoots = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configure(cwd) {
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.test");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "config", "tag.gpgsign", "false");
  git(cwd, "config", "core.autocrlf", "false");
  // Keep the operator's own hooks out of the fixture.
  git(cwd, "config", "core.hooksPath", path.join(cwd, ".no-hooks"));
}

/**
 * A bare origin holding one release-tagged commit plus pending fragments, and a
 * clean clone of it. Returns `{ origin, repo }`.
 */
function makeFixture({ fragments = { "4400-a-fix.md": "- **A fix (#4400).** Body.\n" }, tags = ["v0.13.2"], changelog = CHANGELOG } = {}) {
  const origin = path.join(tempDir("release-cut-origin-"), "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = tempDir("release-cut-seed-");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  configure(seed);
  fs.writeFileSync(path.join(seed, "CHANGELOG.md"), changelog);
  fs.writeFileSync(path.join(seed, "package.json"), PACKAGE_JSON);
  fs.mkdirSync(path.join(seed, "changelog.d"));
  fs.writeFileSync(path.join(seed, "changelog.d", "README.md"), "# Fragments\n");
  fs.mkdirSync(path.join(seed, "size-allowances.d"));
  fs.writeFileSync(path.join(seed, "size-allowances.d", "README.md"), "# Allowances\n");
  fs.writeFileSync(path.join(seed, "size-allowances.d", "4300-spent.md"), "lines: 900\n");
  git(seed, "add", "--all");
  git(seed, "commit", "-qm", "released base");
  for (const tag of tags) git(seed, "tag", "-a", tag, "-m", tag);
  for (const [name, body] of Object.entries(fragments)) {
    fs.writeFileSync(path.join(seed, "changelog.d", name), body);
  }
  git(seed, "add", "--all");
  git(seed, "commit", "-qm", "work since the release", "--allow-empty");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main", "--tags");

  const repo = path.join(tempDir("release-cut-clone-"), "repo");
  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
  configure(repo);
  git(repo, "config", "remote.origin.url", GITHUB_URL);
  git(repo, "config", `url.${origin}.insteadOf`, GITHUB_URL);
  return { origin, repo };
}

/** What `gh` answers when a test does not say otherwise. */
const GH_DEFAULTS = {
  "gh repo view": { status: 0, stdout: "fixture-owner/fixture-repo\n", stderr: "" },
  "gh release view": { status: 1, stdout: "", stderr: "release not found" },
};

/**
 * Real git in the fixture, except that `git push` and every `gh` call are
 * recorded and answered from `stubs`, then `GH_DEFAULTS`, then success.
 * `calls` holds every command in the order it ran.
 */
function fixtureRunner(cwd, stubs = {}) {
  const calls = [];
  const answers = { ...GH_DEFAULTS, ...stubs };
  const run = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    if (command === "gh" || (command === "git" && args[0] === "push")) {
      const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
      return key ? answers[key] : { status: 0, stdout: "", stderr: "" };
    }
    const result = spawnSync(command, args, { cwd, encoding: "utf8", env: GIT_ENV });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  run.calls = calls;
  run.sideEffects = () => calls.filter((call) => /^(git (tag -a|push)|gh release create)/.test(call));
  return run;
}

function silentLog() {
  const lines = [];
  const log = (line) => lines.push(String(line));
  log.text = () => lines.join("\n");
  return log;
}

function snapshot(repo) {
  return {
    status: git(repo, "status", "--porcelain", "--untracked-files=all"),
    head: git(repo, "rev-parse", "HEAD"),
    branches: git(repo, "branch", "--list"),
    tags: git(repo, "tag", "--list"),
    changelog: fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8"),
    packageJson: fs.readFileSync(path.join(repo, "package.json"), "utf8"),
    fragments: fs.readdirSync(path.join(repo, "changelog.d")).sort(),
  };
}

function expectRefusal(fn, pattern) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReleaseCutError);
  expect(caught.message).toMatch(pattern);
  return caught;
}

function notesWriter() {
  const file = path.join(tempDir("release-notes-"), "notes.md");
  const writeNotes = (tag, text) => {
    fs.writeFileSync(file, text);
    return file;
  };
  writeNotes.file = file;
  return writeNotes;
}

afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe("version computation", () => {
  it("is a patch release when no fragment is a feature", () => {
    const plan = computeRelease({ tags: ["v0.13.2", "v0.13.1"], fragmentNames: ["4400-a-fix.md", "4401-b.md"] });
    expect(plan).toMatchObject({ previousTag: "v0.13.2", suggestedBump: "patch", bump: "patch", version: "0.13.3" });
    expect(plan.tag).toBe("v0.13.3");
    expect(plan.branch).toBe("release/v0.13.3");
  });

  it("is a minor release when any fragment is a feature, and names them", () => {
    const plan = computeRelease({
      tags: ["v0.13.2"],
      fragmentNames: ["4400-a-fix.md", `4465-release-cut${FEATURE_FRAGMENT_SUFFIX}`, "4470-X.FEATURE.MD"],
    });
    expect(plan).toMatchObject({ suggestedBump: "minor", bump: "minor", version: "0.14.0" });
    expect(plan.featureFragments).toEqual(["4465-release-cut.feature.md", "4470-X.FEATURE.MD"]);
  });

  it("does not read a feature into a slug that merely contains the word", () => {
    expect(fragmentBump(["3844-multi-feature-foundation.md", "4000-featured.md"]).bump).toBe("patch");
  });

  it("starts from 0.0.0 when there is no previous release tag", () => {
    expect(computeRelease({ tags: [], fragmentNames: ["1-x.md"] })).toMatchObject({ previousTag: null, version: "0.0.1" });
    expect(computeRelease({ tags: ["not-a-tag", "v1.2"], fragmentNames: ["1-x.feature.md"] })).toMatchObject({
      previousTag: null,
      version: "0.1.0",
    });
  });

  it("picks the highest version, not the last listed or a lexically larger one", () => {
    expect(latestReleaseTag(["v0.9.0", "v0.13.2", "v0.10.1", "v0.13.10-rc.1", "v01.0.0"]).tag).toBe("v0.13.2");
    expect(latestReleaseTag(["v0.9.0", "v0.10.0"]).version).toBe("0.10.0");
  });

  it("lets an explicit bump override the suggestion and says so", () => {
    const plan = computeRelease({ tags: ["v0.13.2"], fragmentNames: ["1-x.md"], override: "minor" });
    expect(plan).toMatchObject({ suggestedBump: "patch", bump: "minor", overridden: true, version: "0.14.0" });
    expect(bumpVersion("0.13.2", "major")).toBe("1.0.0");
    expect(() => bumpVersion("0.13.2", "huge")).toThrow(/--bump must be one of/);
  });
});

describe("argument parsing", () => {
  it("defaults to a dry run and needs a phase", () => {
    expect(parseArgs(["prepare"])).toMatchObject({ phase: "prepare", execute: false });
    expect(parseArgs(["--", "publish", "--execute", "--commit", "abc"])).toMatchObject({
      phase: "publish",
      execute: true,
      commit: "abc",
    });
    expect(() => parseArgs([])).toThrow(/Name a phase/);
    expect(() => parseArgs(["tag"])).toThrow(/Name a phase/);
  });

  it("refuses contradictory or misplaced options", () => {
    expect(() => parseArgs(["prepare", "--execute", "--dry-run"])).toThrow(/contradict/);
    expect(() => parseArgs(["prepare", "--bump", "huge"])).toThrow(/--bump must be/);
    expect(() => parseArgs(["prepare", "--bump"])).toThrow(/needs a value/);
    expect(() => parseArgs(["prepare", "--date", "31/10/2026"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(["prepare", "--commit", "abc"])).toThrow(/belong to publish/);
    expect(() => parseArgs(["prepare", "--carry-late-fragments"])).toThrow(/belong to publish/);
    expect(() => parseArgs(["prepare", "--amend", "--bump", "minor"])).toThrow(/--amend keeps the prepared version/);
    expect(() => parseArgs(["publish", "--amend"])).toThrow(/belong to prepare/);
    expect(parseArgs(["prepare", "--amend", "--execute"])).toMatchObject({ amend: true, execute: true });
    expect(parseArgs(["publish", "--carry-late-fragments"])).toMatchObject({ carryLateFragments: true, execute: false });
    expect(() => parseArgs(["publish", "--bump", "minor"])).toThrow(/belong to prepare/);
    expect(() => parseArgs(["prepare", "--force"])).toThrow(/Unknown option/);
  });

  it("prints the recovery and usage and exits 1 on a refusal", () => {
    const errors = silentLog();
    expect(main(["nonsense"], { log: silentLog(), error: errors })).toBe(1);
    expect(errors.text()).toMatch(/release:cut stopped: Name a phase/);
    expect(errors.text()).toMatch(/Usage: pnpm run release:cut prepare/);
  });
});


describe("package.json, remote and release-body helpers", () => {
  it("rewrites only the top-level version and keeps the formatting", () => {
    const next = bumpPackageJson(PACKAGE_JSON, "0.14.0");
    expect(next).toBe(PACKAGE_JSON.replace('"version": "0.13.2"', '"version": "0.14.0"'));
  });

  it("refuses a package.json whose first version key is not the top-level one", () => {
    const nested = `{\n  "engines": {\n    "version": "x"\n  },\n  "version": "0.13.2"\n}\n`;
    expect(() => bumpPackageJson(nested, "0.14.0")).toThrow(/Could not rewrite/);
    // Already at the target, the top-level check alone would pass while the nested key was rewritten.
    const alreadyBumped = `{\n  "engines": {\n    "version": "x"\n  },\n  "version": "0.14.0"\n}\n`;
    expect(() => bumpPackageJson(alreadyBumped, "0.14.0")).toThrow(/Could not rewrite/);
  });

  it("reads one compiled section with its heading and without its neighbours", () => {
    const text = "## Unreleased\n\n## 0.14.0 - 2026-10-31\n\n- **New (#1).**\n  More.\n\n## 0.13.2 - 2026-07-23\n\n- **Old.**\n";
    expect(releaseSection(text, "0.14.0")).toEqual({ heading: "## 0.14.0 - 2026-10-31", body: "- **New (#1).**\n  More." });
    expect(releaseSection(text, "0.13.2").body).toBe("- **Old.**");
    expect(releaseSection(text, "0.14")).toBeNull();
  });

  it("names the GitHub repository from https, ssh and scp-style remote URLs", () => {
    const repo = { host: "github.com", owner: "o", name: "r" };
    expect(parseGitHubRemote("https://github.com/o/r.git")).toEqual(repo);
    expect(parseGitHubRemote("https://github.com/o/r/")).toEqual(repo);
    expect(parseGitHubRemote("https://x-access-token:secret@github.com/o/r.git")).toEqual(repo);
    expect(parseGitHubRemote("git@github.com:o/r.git")).toEqual(repo);
    expect(parseGitHubRemote("git@github.com:o/r")).toEqual(repo);
    expect(parseGitHubRemote("ssh://git@github.com/o/r.git")).toEqual(repo);
    expect(parseGitHubRemote("ssh://git@github.com:22/o/r.git")).toEqual(repo);
    expect(parseGitHubRemote("https://GHE.example.org/o/r.git")).toEqual({ host: "ghe.example.org", owner: "o", name: "r" });
    expect(parseGitHubRemote("https://www.github.com/o/r.git")).toEqual(repo);
    expect(parseGitHubRemote("git@WWW.GitHub.com:o/r.git")).toEqual(repo);
    expect(parseGitHubRemote("/srv/git/origin.git")).toBeNull();
    expect(parseGitHubRemote("file:///srv/git/origin.git")).toBeNull();
    expect(parseGitHubRemote("https://github.com/o")).toBeNull();
    expect(parseGitHubRemote("")).toBeNull();
  });

  it("computes the anchor GitHub gives a release heading", () => {
    expect(githubHeadingAnchor("## 0.13.3 - 2026-10-31")).toBe("0133---2026-10-31");
    expect(githubHeadingAnchor("## Unreleased")).toBe("unreleased");
  });

  it("publishes the section as-is up to the limit and a short linked body beyond it", () => {
    const repo = { host: "github.com", owner: "o", name: "r" };
    const heading = "## 0.13.3 - 2026-10-31";
    const atLimit = `- ${"a".repeat(MAX_RELEASE_NOTES_CHARS - 2)}`;
    expect(releaseBody({ section: { heading, body: atLimit }, tag: "v0.13.3", repo })).toEqual({
      kind: "full",
      text: `${atLimit}\n`,
    });
    const over = `${atLimit}\n- second\n  continued`;
    const short = releaseBody({ section: { heading, body: over }, tag: "v0.13.3", repo });
    expect(short.kind).toBe("short");
    expect(short.entries).toBe(2);
    expect(short.text).toBe(
      "**v0.13.3** has 2 changelog entries — more than a GitHub release can hold.\n\n" +
        "Read them in [CHANGELOG.md](https://github.com/o/r/blob/v0.13.3/CHANGELOG.md#0133---2026-10-31).\n",
    );
    expect(MAX_RELEASE_NOTES_CHARS).toBeLessThan(125_000);
  });
});

describe("release:cut prepare on a fixture repository", () => {
  it("prints the whole plan in a dry run and changes nothing", () => {
    const { origin, repo } = makeFixture({
      fragments: { "4400-a-fix.md": "- **A fix (#4400).**\n", "4465-cut.feature.md": "- **Cut releases (#4465).**\n" },
    });
    const before = snapshot(repo);
    const run = fixtureRunner(repo);
    const log = silentLog();

    const result = prepareRelease({ repoRoot: repo, date: "2026-10-31", run, log });

    expect(result).toMatchObject({ executed: false, version: "0.14.0", previousTag: "v0.13.2", suggestedBump: "minor" });
    const text = log.text();
    expect(text).toContain("Release prep for v0.14.0 (dry run");
    expect(text).toContain("latest release tag on origin: v0.13.2");
    expect(text).toContain("Fragment types suggest a minor release (1 *.feature.md: 4465-cut.feature.md)");
    expect(text).toContain("changelog.d/4400-a-fix.md (would be deleted)");
    expect(text).toContain("size-allowances.d/4300-spent.md (spent allowance; would be deleted)");
    expect(text).toContain("1. git switch -c release/v0.14.0");
    expect(text).toContain('2. set package.json "version" 0.13.2 -> 0.14.0');
    expect(text).toContain("3. node scripts/release/compile-changelog.mjs 0.14.0 2026-10-31");
    expect(text).toContain("4. git add --all -- CHANGELOG.md package.json changelog.d size-allowances.d");
    expect(text).toContain('5. git commit -m "release: cut v0.14.0"');
    expect(text).toContain("this phase never pushes");
    expect(text).toContain("Dry run: nothing was changed");
    expect(snapshot(repo)).toEqual(before);
    expect(run.calls).toContain("git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main");
    expect(run.calls.some((call) => call.startsWith("git push") || call.startsWith("gh "))).toBe(false);
    expect(git(origin, "branch", "--list")).toBe("* main");
  });

  it("makes the local release-prep commit with --execute and pushes nothing", () => {
    const { origin, repo } = makeFixture();
    const base = git(repo, "rev-parse", "HEAD");
    const run = fixtureRunner(repo);

    const result = prepareRelease({ repoRoot: repo, execute: true, date: "2026-10-31", run, log: silentLog() });

    expect(result).toMatchObject({ executed: true, version: "0.13.3", branch: "release/v0.13.3" });
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release/v0.13.3");
    expect(git(repo, "rev-parse", "HEAD~1")).toBe(base);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("release: cut v0.13.3");
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version).toBe("0.13.3");
    const changelog = fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
    expect(releaseSection(changelog, "0.13.3")).toEqual({ heading: "## 0.13.3 - 2026-10-31", body: "- **A fix (#4400).** Body." });
    expect(git(repo, "show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual([
      "D\tchangelog.d/4400-a-fix.md",
      "D\tsize-allowances.d/4300-spent.md",
      "M\tCHANGELOG.md",
      "M\tpackage.json",
    ]);
    expect(run.calls.some((call) => call.startsWith("git push") || call.startsWith("gh "))).toBe(false);
    expect(git(origin, "branch", "--list")).toBe("* main");
  });

  it("refuses a dirty tree, including an untracked fragment draft", () => {
    const { repo } = makeFixture();
    fs.writeFileSync(path.join(repo, "changelog.d", "9999-draft.md"), "- **Draft.**\n");
    const before = snapshot(repo);
    expectRefusal(
      () => prepareRelease({ repoRoot: repo, execute: true, run: fixtureRunner(repo), log: silentLog() }),
      /working tree is not clean[\s\S]*changelog\.d\/9999-draft\.md/,
    );
    expect(snapshot(repo)).toEqual(before);
  });

  it("refuses a stale base that origin/main has moved past", () => {
    const { repo } = makeFixture();
    const stale = git(repo, "rev-parse", "HEAD");
    git(repo, "commit", "-q", "--allow-empty", "-m", "merged elsewhere");
    git(repo, "push", "-q", "origin", "HEAD:main");
    git(repo, "reset", "-q", "--hard", stale);
    git(repo, "update-ref", "refs/remotes/origin/main", stale); // this clone has not fetched yet

    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, execute: true, run: fixtureRunner(repo), log: silentLog() }),
      /is behind origin\/main \([0-9a-f]{12}\): the base is stale/,
    );
    expect(error.recovery).toContain("git switch --detach origin/main");
    expect(git(repo, "branch", "--list", "release/*")).toBe("");
  });

  it("refuses local commits that are not on origin/main", () => {
    const { repo } = makeFixture();
    git(repo, "commit", "-q", "--allow-empty", "-m", "unmerged");
    expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /carries commits that are not on origin\/main/,
    );
  });

  it("refuses when the release-prep branch already exists here or on origin", () => {
    const { repo } = makeFixture();
    git(repo, "branch", "release/v0.13.3");
    expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /Branch release\/v0\.13\.3 already exists locally/,
    );
    git(repo, "push", "-q", "origin", "release/v0.13.3");
    git(repo, "branch", "-D", "release/v0.13.3");
    expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /origin already has branch release\/v0\.13\.3/,
    );
  });

  it("works out the version from origin's tags, never this clone's", () => {
    const { repo } = makeFixture();
    git(repo, "tag", "-a", "v0.20.0", "-m", "local only");
    git(repo, "tag", "-a", "v0.13.5", "-m", "pushed then deleted here");
    git(repo, "push", "-q", "origin", "refs/tags/v0.13.5");
    git(repo, "tag", "-d", "v0.13.5");

    const plan = prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() });

    expect(plan).toMatchObject({ previousTag: "v0.13.5", version: "0.13.6" });
  });

  it("refuses a local tag for the planned version that origin does not have", () => {
    const { repo } = makeFixture();
    git(repo, "tag", "-a", "v0.13.3", "-m", "leftover", "HEAD~1");
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /This clone has a tag v0\.13\.3 that origin does not/,
    );
    expect(error.recovery).toContain("git tag -d v0.13.3");
  });

  it("refuses when there is nothing to release", () => {
    const { repo } = makeFixture({ fragments: {} });
    expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /Nothing to release/,
    );
  });

  it("stops with a recovery message when the compile fails part way", () => {
    const { repo } = makeFixture();
    const base = git(repo, "rev-parse", "HEAD");
    const compile = (options) => {
      if (!options.dryRun) throw new Error("disk full");
      return { fragments: ["4400-a-fix.md"], foldedLegacyEntries: false };
    };
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, execute: true, run: fixtureRunner(repo), compile, log: silentLog() }),
      /Release prep failed: disk full/,
    );
    expect(error.recovery).toContain("You are on release/v0.13.3");
    expect(error.recovery).toContain(`git switch --discard-changes --detach ${base} && git branch -D release/v0.13.3`);
    // The recovery it prints really does restore the starting point.
    git(repo, "switch", "-q", "--discard-changes", "--detach", base);
    git(repo, "branch", "-q", "-D", "release/v0.13.3");
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});

/** A fixture whose release-prep commit has merged to origin/main (fast-forward). */
function mergedReleaseFixture(options) {
  const fixture = makeFixture(options);
  prepareRelease({ repoRoot: fixture.repo, execute: true, date: "2026-10-31", run: fixtureRunner(fixture.repo), log: silentLog() });
  git(fixture.repo, "push", "-q", "origin", "HEAD:main"); // stands in for merging the release-prep PR
  return { ...fixture, merged: git(fixture.repo, "rev-parse", "HEAD") };
}

/**
 * The late-fragment race: a fragment-bearing PR merges to main while the
 * release-prep PR is open, then the prep PR merges with a merge commit.
 * Returns the prep commit (never main's tip) and the merge commit.
 */
function lateFragmentFixture({ lateName = "4500-late.md", bump = null } = {}) {
  const fixture = makeFixture();
  const plan = prepareRelease({ repoRoot: fixture.repo, execute: true, bump, date: "2026-10-31", run: fixtureRunner(fixture.repo), log: silentLog() });
  const prep = git(fixture.repo, "rev-parse", "HEAD");
  git(fixture.repo, "switch", "-q", "--detach", "origin/main");
  fs.writeFileSync(path.join(fixture.repo, "changelog.d", lateName), "- **Late (#4500).**\n");
  git(fixture.repo, "add", "--all");
  git(fixture.repo, "commit", "-qm", "Merge pull request #4500");
  git(fixture.repo, "merge", "-q", "--no-ff", "-m", `Merge pull request #4501 from ${plan.branch}`, prep);
  git(fixture.repo, "push", "-q", "origin", "HEAD:main");
  return { ...fixture, prep, merge: git(fixture.repo, "rev-parse", "HEAD") };
}

describe("late fragments: release:cut prepare --amend and publish --carry-late-fragments", () => {
  it("refuses the merge commit, offers both paths, and refuses the prep commit CI never built", () => {
    const { repo, prep, merge } = lateFragmentFixture();

    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /[0-9a-f]{12} holds 1 fragment\(s\) that merged after the release-prep commit \(4500-late\.md\)/,
    );
    expect(error.recovery).toContain("pnpm run release:cut prepare --amend --execute");
    expect(error.recovery).toContain("push release/v0.13.3-late, merge its pull request, then pnpm run release:cut publish --execute");
    expect(error.recovery).toContain("pnpm run release:cut publish --carry-late-fragments --execute");
    expect(error.recovery).not.toContain("--commit");

    const firstParent = expectRefusal(
      () => publishRelease({ repoRoot: repo, commit: prep, run: fixtureRunner(repo), log: silentLog() }),
      /is not on origin\/main's first-parent chain: it was never a commit CI pushed to main/,
    );
    expect(firstParent.message).toContain("no image was built for it");
    expect(merge).not.toBe(prep);
  });

  it("folds the late fragment into the untagged section, then publishes the fold's merge commit", () => {
    const { repo } = lateFragmentFixture();
    const dry = silentLog();
    const before = snapshot(repo);
    prepareRelease({ repoRoot: repo, amend: true, run: fixtureRunner(repo), log: dry });
    expect(snapshot(repo)).toEqual(before);
    expect(dry.text()).toContain('Late-fragment fold into v0.13.3 (dry run');
    expect(dry.text()).toContain('appending to "## 0.13.3 - 2026-10-31"');
    expect(dry.text()).toContain("node scripts/release/compile-changelog.mjs 0.13.3 --append");
    expect(dry.text()).not.toContain("set package.json");

    const result = prepareRelease({ repoRoot: repo, amend: true, execute: true, date: "2026-11-02", run: fixtureRunner(repo), log: silentLog() });

    expect(result).toMatchObject({ executed: true, branch: "release/v0.13.3-late", tag: "v0.13.3" });
    expect(git(repo, "log", "-1", "--format=%s")).toBe("release: fold late fragments into v0.13.3");
    expect(git(repo, "show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual([
      "D\tchangelog.d/4500-late.md",
      "M\tCHANGELOG.md",
    ]);
    const section = releaseSection(fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8"), "0.13.3");
    expect(section).toEqual({ heading: "## 0.13.3 - 2026-10-31", body: "- **A fix (#4400).** Body.\n- **Late (#4500).**" });

    git(repo, "push", "-q", "origin", "HEAD:main"); // the fold's pull request merges
    const writeNotes = notesWriter();
    const published = publishRelease({ repoRoot: repo, execute: true, run: fixtureRunner(repo), writeNotes, log: silentLog() });
    expect(published).toMatchObject({ executed: true, tag: "v0.13.3", state: "fresh" });
    expect(fs.readFileSync(writeNotes.file, "utf8")).toBe("- **A fix (#4400).** Body.\n- **Late (#4500).**\n");
  });

  it("publishes anyway with --carry-late-fragments and names what is carried", () => {
    const { repo, merge } = lateFragmentFixture();
    const run = fixtureRunner(repo);
    const log = silentLog();
    const writeNotes = notesWriter();

    const result = publishRelease({ repoRoot: repo, execute: true, carryLateFragments: true, run, writeNotes, log });

    expect(result).toMatchObject({ executed: true, commit: merge });
    expect(log.text()).toContain("Carried into the next release (not in v0.13.3's notes): 4500-late.md");
    expect(fs.readFileSync(writeNotes.file, "utf8")).toBe("- **A fix (#4400).** Body.\n");
    expect(git(repo, "rev-parse", "v0.13.3^{commit}")).toBe(merge);
  });

  it("refuses to amend a release origin has already tagged, or one never prepared", () => {
    const released = mergedReleaseFixture();
    git(released.repo, "tag", "-a", "v0.13.3", "-m", "v0.13.3", released.merged);
    git(released.repo, "push", "-q", "origin", "refs/tags/v0.13.3");
    git(released.repo, "tag", "-d", "v0.13.3");
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: released.repo, amend: true, run: fixtureRunner(released.repo), log: silentLog() }),
      /v0\.13\.3 is already released on origin, so there is no untagged release to amend/,
    );
    expect(error.recovery).toContain("pnpm run release:cut prepare");

    const unprepared = makeFixture({ tags: [], changelog: CHANGELOG.slice(0, CHANGELOG.indexOf("## 0.13.2")) });
    const never = expectRefusal(
      () => prepareRelease({ repoRoot: unprepared.repo, amend: true, run: fixtureRunner(unprepared.repo), log: silentLog() }),
      /CHANGELOG\.md has no "## 0\.13\.2" section: nothing was prepared to amend/,
    );
    expect(never.recovery).toContain("pnpm run release:cut prepare");
  });

  it("refuses a late feature in a patch release, and offers carry or re-prepare", () => {
    const { repo } = lateFragmentFixture({ lateName: "4500-late.feature.md" });
    git(repo, "switch", "-q", "--detach", "origin/main");
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, amend: true, run: fixtureRunner(repo), log: silentLog() }),
      /v0\.13\.3 was prepared as a patch release, but late fragment\(s\) 4500-late\.feature\.md are features/,
    );
    expect(error.recovery).toContain("pnpm run release:cut publish --carry-late-fragments --execute");
    expect(error.recovery).toContain("revert the release-prep pull request's merge");
  });

  it("folds a late feature into a release already prepared as minor", () => {
    const { repo } = lateFragmentFixture({ lateName: "4500-late.feature.md", bump: "minor" });
    git(repo, "switch", "-q", "--detach", "origin/main");
    expect(prepareRelease({ repoRoot: repo, amend: true, run: fixtureRunner(repo), log: silentLog() })).toMatchObject({
      tag: "v0.14.0",
      branch: "release/v0.14.0-late",
    });
  });

  it("refuses a plain prepare while a prepared release is still untagged, instead of planning a downgrade", () => {
    const { repo } = mergedReleaseFixture({ fragments: { "4400-feature.feature.md": "- **New (#4400).**\n" } });
    expect(JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version).toBe("0.14.0");
    git(repo, "switch", "-q", "--detach", "origin/main");
    fs.writeFileSync(path.join(repo, "changelog.d", "4600-fix.md"), "- **Fix (#4600).**\n");
    git(repo, "add", "--all");
    git(repo, "commit", "-qm", "Merge pull request #4600");
    git(repo, "push", "-q", "origin", "HEAD:main");

    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /v0\.14\.0 is prepared but not tagged: package\.json is ahead of origin's latest tag \(v0\.13\.2\)/,
    );
    expect(error.recovery).toContain("pnpm run release:cut publish --execute");
    expect(error.recovery).toContain("pnpm run release:cut prepare --amend --execute");
    expect(git(repo, "branch", "--list", "release/v0.13.3")).toBe("");
  });

  it("refuses to amend with nothing to fold", () => {
    const { repo } = mergedReleaseFixture();
    git(repo, "switch", "-q", "--detach", "origin/main");
    expectRefusal(
      () => prepareRelease({ repoRoot: repo, amend: true, run: fixtureRunner(repo), log: silentLog() }),
      /Nothing to fold/,
    );
  });
});

describe("release:cut publish on a fixture repository", () => {
  it("prints the plan in a dry run, checks gh read-only, and creates nothing", () => {
    const { repo, merged } = mergedReleaseFixture();
    const run = fixtureRunner(repo);
    const log = silentLog();

    const result = publishRelease({ repoRoot: repo, run, log });

    expect(result).toMatchObject({ executed: false, tag: "v0.13.3", commit: merged, state: "fresh" });
    expect(result.body).toEqual({ kind: "full", text: "- **A fix (#4400).** Body.\n" });
    const text = log.text();
    expect(text).toContain("Publish v0.13.3 (dry run");
    expect(text).toContain(`Commit: ${merged} (on origin/main's first-parent chain); latest release tag on origin: v0.13.2`);
    expect(text).toContain("Repository: fixture-owner/fixture-repo (from origin)");
    expect(text).toContain('Release body: the "## 0.13.3 - 2026-10-31" section, 26 characters.');
    expect(text).toContain("4. git push origin refs/tags/v0.13.3");
    expect(text).toContain("5. gh release create v0.13.3 --repo fixture-owner/fixture-repo --verify-tag --title v0.13.3 --notes-file <body>");
    expect(text).toContain("DEPLOY_REF=v0.13.3 ./scripts/run-production-blue-green-deploy.sh");
    expect(run.calls.filter((call) => call.startsWith("gh "))).toEqual([
      "gh auth status --hostname github.com",
      "gh repo view fixture-owner/fixture-repo --json nameWithOwner --jq .nameWithOwner",
    ]);
    expect(run.sideEffects()).toEqual([]);
    expect(git(repo, "tag", "--list", "v0.13.3")).toBe("");
  });

  it("writes the body, tags, pushes the tag, then publishes to origin's repository, in that order", () => {
    const { repo, merged } = mergedReleaseFixture();
    const run = fixtureRunner(repo);
    const writeNotes = notesWriter();
    const recordingWriter = (tag, text) => {
      run.calls.push("write notes");
      return writeNotes(tag, text);
    };

    publishRelease({ repoRoot: repo, execute: true, run, writeNotes: recordingWriter, log: silentLog() });

    const ordered = run.calls.filter((call) => call === "write notes" || /^(git (tag -a|push)|gh )/.test(call));
    expect(ordered).toEqual([
      "gh auth status --hostname github.com",
      "gh repo view fixture-owner/fixture-repo --json nameWithOwner --jq .nameWithOwner",
      "write notes",
      `git tag -a v0.13.3 -m fixture-club-app v0.13.3\n\nRelease notes: the "## 0.13.3" section of CHANGELOG.md. ${merged}`,
      "git push origin refs/tags/v0.13.3",
      `gh release create v0.13.3 --repo fixture-owner/fixture-repo --verify-tag --title v0.13.3 --notes-file ${writeNotes.file}`,
    ]);
    expect(git(repo, "cat-file", "-t", "v0.13.3")).toBe("tag"); // annotated
    expect(git(repo, "rev-parse", "v0.13.3^{commit}")).toBe(merged);
    expect(fs.readFileSync(writeNotes.file, "utf8")).toBe("- **A fix (#4400).** Body.\n");
  });

  it("measures an oversized section before any tag and publishes a short linked body", () => {
    const entry = (n) => `- **Entry ${n}.** ${"x".repeat(65_000)}\n`;
    const { repo } = mergedReleaseFixture({ fragments: { "4401-a.md": entry(1), "4402-b.md": entry(2) } });

    const dry = silentLog();
    const dryRun = fixtureRunner(repo);
    publishRelease({ repoRoot: repo, run: dryRun, log: dry });
    expect(dry.text()).toMatch(/Release body: a SHORT body with 2 entries counted .* the section is \d+ characters, over the 120000 limit/);
    expect(dryRun.sideEffects()).toEqual([]);

    const run = fixtureRunner(repo);
    const writeNotes = notesWriter();
    const result = publishRelease({ repoRoot: repo, execute: true, run, writeNotes, log: silentLog() });
    expect(result.body.kind).toBe("short");
    const body = fs.readFileSync(writeNotes.file, "utf8");
    expect(body.length).toBeLessThan(MAX_RELEASE_NOTES_CHARS);
    expect(body).toContain("**v0.13.3** has 2 changelog entries");
    expect(body).toContain("https://github.com/fixture-owner/fixture-repo/blob/v0.13.3/CHANGELOG.md#0133---2026-10-31");
  });

  it("refuses a commit that is not on origin/main at all", () => {
    const { repo } = makeFixture();
    prepareRelease({ repoRoot: repo, execute: true, date: "2026-10-31", run: fixtureRunner(repo), log: silentLog() });
    const unmerged = git(repo, "rev-parse", "HEAD");
    expectRefusal(
      () => publishRelease({ repoRoot: repo, commit: unmerged, run: fixtureRunner(repo), log: silentLog() }),
      /is not on origin\/main's first-parent chain/,
    );
  });

  it("says nothing is prepared when origin's tag of the version is elsewhere and released", () => {
    const { repo } = makeFixture({ fragments: {} });
    const released = { "gh release view": { status: 0, stdout: "v0.13.2\n", stderr: "" } };
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo, released), log: silentLog() }),
      /origin already has v0\.13\.2 on [0-9a-f]{12}, not [0-9a-f]{12}: v0\.13\.2 is released/,
    );
    expect(error.recovery).toContain("release:cut prepare");
  });

  it("refuses a version older than origin's latest release tag", () => {
    const { repo, merged } = mergedReleaseFixture();
    git(repo, "tag", "-a", "v0.14.0", "-m", "newer", `${merged}~1`);
    git(repo, "push", "-q", "origin", "refs/tags/v0.14.0");
    expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /v0\.13\.3 is not newer than the latest release tag on origin, v0\.14\.0/,
    );
  });

  it("refuses a merged version bump with no compiled section", () => {
    const { repo } = makeFixture({ fragments: {} });
    fs.writeFileSync(path.join(repo, "package.json"), bumpPackageJson(PACKAGE_JSON, "0.13.3"));
    git(repo, "commit", "-qam", "bump without a compile");
    git(repo, "push", "-q", "origin", "HEAD:main");
    expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /CHANGELOG\.md at [0-9a-f]{12} has no "## 0\.13\.3" section/,
    );
  });

  it("refuses direct entries still under ## Unreleased until --amend folds them", () => {
    const { repo } = mergedReleaseFixture();
    git(repo, "switch", "-q", "--detach", "origin/main");
    const changelogPath = path.join(repo, "CHANGELOG.md");
    fs.writeFileSync(
      changelogPath,
      fs.readFileSync(changelogPath, "utf8").replace(`${NOTE}\n`, `${NOTE}\n\n- **Written directly (#4510).**\n`),
    );
    git(repo, "commit", "-qam", "Merge pull request #4510");
    git(repo, "push", "-q", "origin", "HEAD:main");

    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /still has entries written directly under "## Unreleased"/,
    );
    expect(error.recovery).toContain("pnpm run release:cut prepare --amend --execute");

    prepareRelease({ repoRoot: repo, amend: true, execute: true, run: fixtureRunner(repo), log: silentLog() });
    git(repo, "push", "-q", "origin", "HEAD:main");
    const result = publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() });
    expect(result.body.text).toBe("- **A fix (#4400).** Body.\n- **Written directly (#4510).**\n");
  });

  it("refuses an origin URL that names no GitHub repository", () => {
    const { repo, origin } = mergedReleaseFixture();
    git(repo, "config", "remote.origin.url", origin);
    const run = fixtureRunner(repo);
    expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }),
      /origin's URL is not a GitHub repository URL/,
    );
    expect(run.sideEffects()).toEqual([]);
  });

  it("creates nothing when gh cannot reach origin's repository or is not signed in", () => {
    for (const [stub, pattern] of [
      [{ "gh repo view": { status: 1, stdout: "", stderr: "Could not resolve to a Repository" } }, /`gh repo view fixture-owner\/fixture-repo .*` failed/],
      [{ "gh auth status": { status: 1, stdout: "", stderr: "not logged in" } }, /`gh auth status --hostname github\.com` failed:\nnot logged in/],
    ]) {
      const { repo } = mergedReleaseFixture();
      const run = fixtureRunner(repo, stub);
      const error = expectRefusal(
        () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }),
        pattern,
      );
      expect(error.recovery).toContain("Nothing was created");
      expect(run.sideEffects()).toEqual([]);
      expect(git(repo, "tag", "--list", "v0.13.3")).toBe("");
    }
  });

  it("keeps the local tag when the push fails, and a re-run resumes at the push", () => {
    const { repo, merged } = mergedReleaseFixture();
    const failing = fixtureRunner(repo, { "git push": { status: 1, stdout: "", stderr: "rejected" } });
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run: failing, writeNotes: notesWriter(), log: silentLog() }),
      /`git push origin refs\/tags\/v0\.13\.3` failed:\nrejected/,
    );
    expect(error.recovery).toContain("exists locally but was NOT pushed");
    expect(error.recovery).toContain(`Re-run: pnpm run release:cut publish --execute --commit ${merged} — it resumes from this step.`);
    expect(error.recovery).toContain("Or discard it: git tag -d v0.13.3");
    expect(error.recovery).not.toMatch(/prepare/);
    expect(failing.calls.some((call) => call.startsWith("gh release create"))).toBe(false);

    const rerun = fixtureRunner(repo);
    const log = silentLog();
    const result = publishRelease({ repoRoot: repo, execute: true, run: rerun, writeNotes: notesWriter(), log });
    expect(result.state).toBe("tagged");
    expect(log.text()).toContain("Resuming: the local tag v0.13.3 is already on the commit.");
    expect(rerun.sideEffects()).toEqual([
      "git push origin refs/tags/v0.13.3",
      expect.stringMatching(/^gh release create v0\.13\.3 --repo fixture-owner\/fixture-repo /),
    ]);
  });

  it("never deletes a pushed tag when publishing fails, and a re-run resumes at gh release create", () => {
    const { repo, merged } = mergedReleaseFixture();
    const failing = fixtureRunner(repo, { "gh release create": { status: 1, stdout: "", stderr: "HTTP 502" } });
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run: failing, writeNotes: notesWriter(), log: silentLog() }),
      /`gh release create v0\.13\.3 .*` failed:\nHTTP 502/,
    );
    expect(error.recovery).toContain("Tag v0.13.3 IS pushed, but the GitHub release was NOT published");
    expect(error.recovery).toContain(`Re-run: pnpm run release:cut publish --execute --commit ${merged}`);
    expect(error.recovery).not.toMatch(/prepare|tag -d|--delete/);

    // The push was stubbed; make origin hold the tag the way a real push would.
    git(repo, "push", "-q", "origin", "refs/tags/v0.13.3");
    const rerun = fixtureRunner(repo);
    const log = silentLog();
    const result = publishRelease({ repoRoot: repo, execute: true, run: rerun, writeNotes: notesWriter(), log });
    expect(result).toMatchObject({ state: "pushed", commit: merged });
    expect(log.text()).toContain("Resuming: origin already has v0.13.3 on the commit.");
    expect(rerun.calls).toContain("gh release view v0.13.3 --repo fixture-owner/fixture-repo");
    expect(rerun.sideEffects()).toEqual([expect.stringMatching(/^gh release create v0\.13\.3 --repo fixture-owner\/fixture-repo /)]);
  });

  it("resumes from a pushed tag even when this clone never had it", () => {
    const { repo, merged } = mergedReleaseFixture();
    git(repo, "tag", "-a", "v0.13.3", "-m", "v0.13.3", merged);
    git(repo, "push", "-q", "origin", "refs/tags/v0.13.3");
    git(repo, "tag", "-d", "v0.13.3");
    const run = fixtureRunner(repo);
    expect(publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }).state).toBe("pushed");
    expect(run.sideEffects()).toEqual([expect.stringMatching(/^gh release create v0\.13\.3 /)]);
  });

  it("reports done when the tag is pushed and the release already exists", () => {
    const { repo, merged } = mergedReleaseFixture();
    git(repo, "tag", "-a", "v0.13.3", "-m", "v0.13.3", merged);
    git(repo, "push", "-q", "origin", "refs/tags/v0.13.3");
    const run = fixtureRunner(repo, { "gh release view": { status: 0, stdout: "v0.13.3\n", stderr: "" } });
    const log = silentLog();

    const result = publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log });

    expect(result).toMatchObject({ state: "published", executed: false });
    expect(log.text()).toContain("Done already: the GitHub release v0.13.3 exists on fixture-owner/fixture-repo.");
    expect(run.sideEffects()).toEqual([]);
  });

  it("points a local-only tag elsewhere at --commit, never at prepare or deleting it", () => {
    const { repo, merged } = mergedReleaseFixture();
    git(repo, "tag", "-a", "v0.13.3", "-m", "stray", `${merged}~1`);
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run: fixtureRunner(repo), writeNotes: notesWriter(), log: silentLog() }),
      /This clone's tag v0\.13\.3 is on [0-9a-f]{12}, not [0-9a-f]{12}, and origin has no v0\.13\.3/,
    );
    expect(error.recovery).toContain(`pnpm run release:cut publish --execute --commit ${git(repo, "rev-parse", `${merged}~1`)}`);
    expect(error.recovery).not.toMatch(/prepare|tag -d/);
  });

  it("names both commits when origin's tag is on the target but this clone's is elsewhere", () => {
    const { repo, merged } = mergedReleaseFixture();
    git(repo, "tag", "-a", "v0.13.3", "-m", "v0.13.3", merged);
    git(repo, "push", "-q", "origin", "refs/tags/v0.13.3");
    git(repo, "tag", "-d", "v0.13.3");
    git(repo, "tag", "-a", "v0.13.3", "-m", "stray", `${merged}~1`);
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /origin's v0\.13\.3 is on [0-9a-f]{12}, but this clone's v0\.13\.3 is on [0-9a-f]{12}\./,
    );
    expect(error.recovery).toBe("Replace the local tag with origin's, then re-run: git tag -d v0.13.3 && git fetch origin tag v0.13.3");
  });

  it("resumes on origin's tagged commit after the release failed and main moved on", () => {
    const { repo, merged } = mergedReleaseFixture();
    const failing = fixtureRunner(repo, { "gh release create": { status: 1, stdout: "", stderr: "HTTP 502" } });
    expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run: failing, writeNotes: notesWriter(), log: silentLog() }),
      /gh release create/,
    );
    git(repo, "push", "-q", "origin", "refs/tags/v0.13.3"); // the push the stub stood in for
    git(repo, "commit", "-q", "--allow-empty", "-m", "Merge pull request #4600 (docs)");
    git(repo, "push", "-q", "origin", "HEAD:main");
    const moved = git(repo, "rev-parse", "HEAD");

    const explicit = expectRefusal(
      () => publishRelease({ repoRoot: repo, commit: moved, run: fixtureRunner(repo), log: silentLog() }),
      /origin's v0\.13\.3 is on [0-9a-f]{12}, not [0-9a-f]{12}, and its GitHub release is missing/,
    );
    expect(explicit.recovery).toBe(`Resume against the tagged commit: pnpm run release:cut publish --execute --commit ${merged}`);

    const rerun = fixtureRunner(repo);
    const log = silentLog();
    const writeNotes = notesWriter();
    const result = publishRelease({ repoRoot: repo, execute: true, run: rerun, writeNotes, log });
    expect(result).toMatchObject({ state: "pushed", commit: merged, executed: true });
    expect(log.text()).toContain("its release is missing; origin/main has moved since. Resuming on");
    expect(rerun.sideEffects()).toEqual([
      `gh release create v0.13.3 --repo fixture-owner/fixture-repo --verify-tag --title v0.13.3 --notes-file ${writeNotes.file}`,
    ]);
    expect(fs.readFileSync(writeNotes.file, "utf8")).toBe("- **A fix (#4400).** Body.\n");
  });

  it("resumes a local-only tag with --commit after the push failed and main moved on", () => {
    const { repo, merged } = mergedReleaseFixture();
    const failing = fixtureRunner(repo, { "git push": { status: 1, stdout: "", stderr: "rejected" } });
    const first = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run: failing, writeNotes: notesWriter(), log: silentLog() }),
      /git push/,
    );
    expect(first.recovery).toContain(`--commit ${merged}`);
    git(repo, "commit", "-q", "--allow-empty", "-m", "Merge pull request #4600 (docs)");
    git(repo, "push", "-q", "origin", "HEAD:main");

    const moved = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run: fixtureRunner(repo), writeNotes: notesWriter(), log: silentLog() }),
      /This clone's tag v0\.13\.3 is on [0-9a-f]{12}, not [0-9a-f]{12}, and origin has no v0\.13\.3/,
    );
    expect(moved.recovery).toBe(`Resume against the tagged commit: pnpm run release:cut publish --execute --commit ${merged}`);

    const rerun = fixtureRunner(repo);
    const result = publishRelease({ repoRoot: repo, execute: true, commit: merged, run: rerun, writeNotes: notesWriter(), log: silentLog() });
    expect(result).toMatchObject({ state: "tagged", commit: merged });
    expect(rerun.sideEffects()).toEqual([
      "git push origin refs/tags/v0.13.3",
      expect.stringMatching(/^gh release create v0\.13\.3 --repo fixture-owner\/fixture-repo /),
    ]);
  });

  it("still runs the content checks when only a local tag exists", () => {
    const { repo, merge } = lateFragmentFixture();
    git(repo, "tag", "-a", "v0.13.3", "-m", "v0.13.3", merge);
    const run = fixtureRunner(repo);
    expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }),
      /holds 1 fragment\(s\) that merged after the release-prep commit/,
    );
    expect(run.sideEffects()).toEqual([]);
    const carried = fixtureRunner(repo);
    expect(
      publishRelease({ repoRoot: repo, execute: true, carryLateFragments: true, run: carried, writeNotes: notesWriter(), log: silentLog() }).state,
    ).toBe("tagged");
  });

  it("refuses a lightweight local tag and says how to recreate it", () => {
    const { repo, merged } = mergedReleaseFixture();
    git(repo, "tag", "v0.13.3", merged);
    const run = fixtureRunner(repo);
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }),
      /This clone's v0\.13\.3 is a lightweight tag; a release tag must be annotated/,
    );
    expect(error.recovery).toBe(
      `Delete it and re-run, and publish creates the annotated tag: git tag -d v0.13.3 && pnpm run release:cut publish --execute --commit ${merged}`,
    );
    expect(run.sideEffects()).toEqual([]);
  });

  it("takes the repository from the push URL and refuses one that disagrees with the fetch URL", () => {
    const { repo } = mergedReleaseFixture();
    git(repo, "config", "remote.origin.pushurl", "git@github.com:fixture-owner/fixture-repo.git");
    const log = silentLog();
    publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log });
    expect(log.text()).toContain("Repository: fixture-owner/fixture-repo (from origin)");

    git(repo, "config", "remote.origin.pushurl", "git@github.com:someone-else/fork.git");
    const run = fixtureRunner(repo);
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }),
      /origin's push and fetch URLs name different repositories \(someone-else\/fork and fixture-owner\/fixture-repo\)/,
    );
    expect(error.recovery).toContain("remote.origin.pushurl");
    expect(run.sideEffects()).toEqual([]);
  });

  it("never prints the credentials in an unparseable origin URL", () => {
    const { repo } = mergedReleaseFixture();
    git(repo, "config", "remote.origin.url", "https://release-bot:SECRET-TOKEN@localhost/o/r.git");
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /origin's URL is not a GitHub repository URL: https:\/\/\*\*\*@localhost\/o\/r\.git/,
    );
    expect(`${error.message}\n${error.recovery}`).not.toContain("SECRET-TOKEN");
    expect(`${error.message}\n${error.recovery}`).not.toContain("release-bot");
  });
});
