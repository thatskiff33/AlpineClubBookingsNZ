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
  latestReleaseTag,
  main,
  MAX_RELEASE_NOTES_CHARS,
  parseArgs,
  parseGitHubRemote,
  prepareRelease,
  PUBLISH_IMAGES_JOB_NAME,
  publishRelease,
  releaseBody,
  planReleaseDocs,
  ReleaseCutError,
} from "./cut-release.mjs";
import { releaseSection } from "./compile-changelog.mjs";
import { parseWorkflowYaml } from "../ci/check-workflow-suite-checkout-depth.mjs";
import { CI_WORKFLOW_FILE } from "../lib/ci-workflow.mjs";
import {
  NO_UPGRADE_STEPS,
  RUNBOOK_RELEASE_AGNOSTIC_MARKER,
  UNRELEASED_HEADING,
  hasUpgradingSection,
  UNRELEASED_LINK,
  unreleasedBlock,
  UPGRADE_CHECKLIST_HEADING,
  UPGRADING_GUIDE_HEADINGS,
  upgradingReleaseHeading,
} from "./upgrade-docs.mjs";
import { RELEASE_NOTES_UNFINISHED_MARKER } from "./release-notes.mjs";

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

/** An upgrade guide with one step waiting under `## Unreleased` above a released section. */
const UPGRADE_STEP = "### Reconnect Xero once (#4400)\n\nOpen Admin → Xero and reconnect.";
const RELEASED_UPGRADE_SECTION = "## v0.13.1 → v0.13.2\n\n### An older step (#1234)\n\nAlready shipped.\n";
// The guide's fixed sections come from upgrade-docs.mjs, so a rename there moves
// these fixtures with it instead of leaving two files that disagree about the shape.
const GUIDE_TOP = ["# Upgrading", "", ...UPGRADING_GUIDE_HEADINGS.flatMap((heading) => [heading, ""])].join("\n");
const UPGRADING = `${GUIDE_TOP}\n## Unreleased\n\n${UPGRADE_STEP}\n\n---\n\n${RELEASED_UPGRADE_SECTION}`;
const RELEASES_INDEX = "# Release notes\n\n## Published release notes\n\n- [v0.13.2](v0.13.2.md) — 2026-07-23 patch public reference release.\n";

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

// The two upgrade documents prepare checks (#4979), cut down to what it reads.
const UPGRADING_READY = [
  GUIDE_TOP,
  UNRELEASED_HEADING,
  "",
  UPGRADE_CHECKLIST_HEADING,
  "",
  "1. Rehearse.",
  "",
  "---",
  "",
  "## v0.13.1 → v0.13.2",
  "",
  "Older steps.",
  "",
].join("\n");
const RUNBOOK_AGNOSTIC = `# Production Upgrade Runbook\n\n${RUNBOOK_RELEASE_AGNOSTIC_MARKER}.\n\n## 0. Scope\n`;
const READY_DOCS = { "docs/UPGRADING.md": UPGRADING_READY, "docs/PRODUCTION_UPGRADE_RUNBOOK.md": RUNBOOK_AGNOSTIC };

/**
 * A bare origin holding one release-tagged commit plus pending fragments, and a
 * clean clone of it. Returns `{ origin, repo }`.
 */
/**
 * The budget for a case that calls makeFixture (#5472). Each builds a bare
 * origin, a seed and a clone and then runs the release script: a run of `git`
 * spawns whose cost is the host's process start-up, not the test. On a busy CI
 * runner the first such case exceeded vitest's 5,000ms default and turned
 * `main` red; the same budget as the deploy release-tag guard's suite.
 */
const FIXTURE_REPOSITORY_BUDGET = { timeout: 60_000 };

function makeFixture({
  fragments = { "4400-a-fix.md": "- **A fix (#4400).** Body.\n" },
  tags = ["v0.13.2"],
  changelog = CHANGELOG,
  upgrading = UPGRADING,
  docs = {},
} = {}) {
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
  fs.mkdirSync(path.join(seed, "docs", "releases"), { recursive: true });
  fs.writeFileSync(path.join(seed, "docs", "UPGRADING.md"), upgrading);
  fs.writeFileSync(path.join(seed, "docs", "releases", "README.md"), RELEASES_INDEX);
  fs.writeFileSync(path.join(seed, "docs", "releases", "v0.13.2.md"), "# Release v0.13.2\n");
  for (const [relative, body] of Object.entries(docs)) {
    fs.mkdirSync(path.dirname(path.join(seed, relative)), { recursive: true });
    fs.writeFileSync(path.join(seed, relative), body);
  }
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
  // `-c` sets autocrlf in the clone before its checkout (#5407 item 35): set
  // afterwards by `configure`, a host whose own git config converts line
  // endings has already checked out CRLF files over an LF index, and every
  // file reads as modified.
  execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", origin, repo], { stdio: "ignore" });
  configure(repo);
  git(repo, "config", "remote.origin.url", GITHUB_URL);
  git(repo, "config", `url.${origin}.insteadOf`, GITHUB_URL);
  return { origin, repo };
}

const GH_API = "gh api --hostname github.com repos/fixture-owner/fixture-repo/actions";
const GH_RUNS = `${GH_API}/workflows/`;
const GH_JOBS = `${GH_API}/runs/`;

const json = (value) => ({ status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" });
const ciRuns = (...runs) => json({ total_count: runs.length, workflow_runs: runs });
const ciJobs = (...jobs) => json({ total_count: jobs.length, jobs });
const ciRun = (id, conclusion = "success") => ({ id, status: conclusion === null ? "in_progress" : "completed", conclusion });
const ciJob = (id, name, conclusion = "success") => ({ id, name, status: conclusion === null ? "queued" : "completed", conclusion });
/** A run whose publish job succeeded: what every main commit's CI run leaves when it completes. */
const PUBLISHED_JOBS = ciJobs(ciJob(1, "Verify"), ciJob(2, PUBLISH_IMAGES_JOB_NAME));

/** What `gh` answers when a test does not say otherwise. */
/** The post-deploy checklist issues GitHub lists by label (#5379), and who owns the repository. */
const GH_CHECKLISTS = "gh api --hostname github.com repos/fixture-owner/fixture-repo/issues?labels=post-deploy-checklist&state=all";
const GH_OWNER_TYPE = "gh api --hostname github.com users/fixture-owner --jq .type";

const GH_DEFAULTS = {
  "gh repo view": { status: 0, stdout: "fixture-owner/fixture-repo\n", stderr: "" },
  [GH_OWNER_TYPE]: { status: 0, stdout: "User\n", stderr: "" },
  "gh release view": { status: 1, stdout: "", stderr: "release not found" },
  [GH_RUNS]: ciRuns(ciRun(101)),
  [GH_JOBS]: PUBLISHED_JOBS,
};

/**
 * Real git in the fixture, except that `git push` and every `gh` call are
 * recorded and answered from `stubs`, then `GH_DEFAULTS`, then success. An
 * answer may be a function of the whole command line.
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
      if (!key) return { status: 0, stdout: "", stderr: "" };
      return typeof answers[key] === "function" ? answers[key](line) : answers[key];
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
    upgrading: fs.readFileSync(path.join(repo, "docs", "UPGRADING.md"), "utf8"),
    releaseNotes: fs.readdirSync(path.join(repo, "docs", "releases")).sort(),
    releasesIndex: fs.readFileSync(path.join(repo, "docs", "releases", "README.md"), "utf8"),
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
    expect(() => parseArgs(["prepare", "--checklist-assignee", "someone"])).toThrow(/belong to publish/);
    expect(parseArgs(["publish", "--checklist-assignee", "club-owner"])).toMatchObject({ checklistAssignee: "club-owner" });
    expect(parseArgs(["publish", "--checklist-assignee", "@me"])).toMatchObject({ checklistAssignee: "@me" });
    expect(parseArgs(["publish"])).toMatchObject({ checklistAssignee: null });
    expect(() => parseArgs(["publish", "--checklist-assignee", "two words"])).toThrow(/GitHub login or @me/);
    expect(() => parseArgs(["publish", "--checklist-assignee", "-dash"])).toThrow(/GitHub login or @me/);
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

  // Vitest's transform tolerates what Node refuses (an identifier imported twice after a merge, a
  // missing export), so every other test here can pass over a script `pnpm run release:cut` cannot load.
  it("loads and runs under Node itself, not only through Vitest", () => {
    const script = path.resolve(import.meta.dirname, "cut-release.mjs");
    const result = spawnSync(process.execPath, [script, "nonsense"], { encoding: "utf8" });
    expect(result.stderr).not.toMatch(/SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export/);
    expect(result.stderr).toMatch(/release:cut stopped: Name a phase/);
    expect(result.status).toBe(1);
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

describe("release:cut prepare on a fixture repository", FIXTURE_REPOSITORY_BUDGET, () => {
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
    expect(text).toContain(
      'docs/UPGRADING.md: rename "## Unreleased" to "## v0.13.2 → v0.14.0" (1 step(s)), with a fresh empty "## Unreleased" above it',
    );
    expect(text).toContain("docs/releases/v0.14.0.md: new notes stub, marked unfinished until it is written");
    expect(text).toContain('docs/releases/README.md: list v0.14.0 first under "Published release notes"');
    expect(text).toContain('4. fold docs/UPGRADING.md "## Unreleased" into "## v0.13.2 → v0.14.0", leaving an empty "## Unreleased"');
    expect(text).toContain("5. write docs/releases/v0.14.0.md, docs/releases/README.md");
    expect(text).toContain("6. git add --all -- CHANGELOG.md package.json changelog.d size-allowances.d docs/UPGRADING.md docs/releases");
    expect(text).toContain('7. git commit -m "release: cut v0.14.0"');
    expect(text).toContain("Finish docs/releases/v0.14.0.md: write the overview, then delete the stub note, its marker and the placeholder before merging");
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
      "A\tdocs/releases/v0.13.3.md",
      "D\tchangelog.d/4400-a-fix.md",
      "D\tsize-allowances.d/4300-spent.md",
      "M\tCHANGELOG.md",
      "M\tdocs/UPGRADING.md",
      "M\tdocs/releases/README.md",
      "M\tpackage.json",
    ]);
    const upgrading = fs.readFileSync(path.join(repo, "docs", "UPGRADING.md"), "utf8");
    expect(upgrading).toBe(
      `${GUIDE_TOP}\n## Unreleased\n\n---\n\n## v0.13.2 → v0.13.3\n\n${UPGRADE_STEP}\n\n---\n\n${RELEASED_UPGRADE_SECTION}`,
    );
    expect(fs.readFileSync(path.join(repo, "docs", "releases", "v0.13.3.md"), "utf8")).toContain(RELEASE_NOTES_UNFINISHED_MARKER);
    expect(fs.readFileSync(path.join(repo, "docs", "releases", "README.md"), "utf8")).toContain(
      "## Published release notes\n\n- [v0.13.3](v0.13.3.md) — 2026-10-31 patch public reference release.\n- [v0.13.2]",
    );
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

  it("folds the upgrade guide's Unreleased steps into the release's heading (#4979)", () => {
    const { repo } = makeFixture({ docs: READY_DOCS });
    const dryLog = silentLog();
    prepareRelease({ repoRoot: repo, date: "2026-10-31", run: fixtureRunner(repo), log: dryLog });
    expect(dryLog.text()).toContain(
      `4. fold docs/UPGRADING.md "${UNRELEASED_HEADING}" into "## v0.13.2 → v0.13.3", leaving an empty "${UNRELEASED_HEADING}"`,
    );
    expect(dryLog.text()).toContain("git add --all -- CHANGELOG.md package.json changelog.d size-allowances.d docs/UPGRADING.md");
    expect(dryLog.text()).not.toContain("it does NOT yet");

    prepareRelease({ repoRoot: repo, execute: true, date: "2026-10-31", run: fixtureRunner(repo), log: silentLog() });

    const folded = fs.readFileSync(path.join(repo, "docs", "UPGRADING.md"), "utf8");
    expect(folded).toContain(
      [UNRELEASED_HEADING, "", "---", "", "## v0.13.2 → v0.13.3", "", UPGRADE_CHECKLIST_HEADING].join("\n"),
    );
    expect(folded.split("\n").filter((line) => line === UNRELEASED_HEADING)).toHaveLength(1);
    expect(git(repo, "show", "--name-status", "--format=", "HEAD").split("\n")).toContain("M\tdocs/UPGRADING.md");
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("gives an empty Unreleased block a no-steps section (#4983), and warns when the checklist is missing", () => {
    // #4979 skipped an empty block; #4983 needs every tag to have a section.
    const empty = makeFixture({
      docs: { ...READY_DOCS, "docs/UPGRADING.md": `${GUIDE_TOP}${UNRELEASED_HEADING}\n\n---\n\n## v0.13.1 → v0.13.2\n` },
    });
    const emptyLog = silentLog();
    prepareRelease({ repoRoot: empty.repo, date: "2026-10-31", run: fixtureRunner(empty.repo), log: emptyLog });
    expect(emptyLog.text()).toContain('docs/UPGRADING.md: add "## v0.13.2 → v0.13.3" saying there are no manual steps');
    expect(emptyLog.text()).not.toContain("it does NOT yet");

    const bare = makeFixture({
      docs: { ...READY_DOCS, "docs/UPGRADING.md": `${GUIDE_TOP}${UNRELEASED_HEADING}\n\n### A step (#4500)\n\nDo it.\n` },
    });
    const bareLog = silentLog();
    prepareRelease({ repoRoot: bare.repo, date: "2026-10-31", run: fixtureRunner(bare.repo), log: bareLog });
    expect(bareLog.text()).toContain("(it does NOT yet: write one)");
  });

  it("refuses a release-specific section above the guide's Unreleased block, dry run included", () => {
    const misplaced = UPGRADING_READY.replace(UNRELEASED_HEADING, `### Review this first (#4457)\n\n${UNRELEASED_HEADING}`);
    const { repo } = makeFixture({ docs: { ...READY_DOCS, "docs/UPGRADING.md": misplaced } });
    const before = snapshot(repo);
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /upgrade documents are not ready[\s\S]*"### Review this first \(#4457\)"/,
    );
    expect(error.recovery).toContain("Public Reference Release Checklist");
    expect(snapshot(repo)).toEqual(before);
  });

  it("refuses a runbook still scoped to a release older than the one being cut", () => {
    const stale = "# Production Upgrade Runbook\n\nFrom `v0.9.0` up to `v0.10.0`.\n\n## 0. Scope\n";
    const { repo } = makeFixture({ docs: { ...READY_DOCS, "docs/PRODUCTION_UPGRADE_RUNBOOK.md": stale } });
    expectRefusal(
      () => prepareRelease({ repoRoot: repo, execute: true, run: fixtureRunner(repo), log: silentLog() }),
      /scopes it to v0\.10\.0, older than v0\.13\.3/,
    );
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("holds the runbook to the release being cut, the census's threshold, not origin's latest tag", () => {
    // v0.13.2 is origin's latest tag and passes a check against it, but the
    // release being cut is v0.13.3, and package.json carries that once the
    // release-prep pull request is open, where the census would then fail.
    const scopedToPrevious = "# Production Upgrade Runbook\n\nFrom `v0.13.1` up to `v0.13.2`.\n\n## 0. Scope\n";
    const previous = makeFixture({ docs: { ...READY_DOCS, "docs/PRODUCTION_UPGRADE_RUNBOOK.md": scopedToPrevious } });
    expectRefusal(
      () => prepareRelease({ repoRoot: previous.repo, run: fixtureRunner(previous.repo), log: silentLog() }),
      /scopes it to v0\.13\.2, older than v0\.13\.3/,
    );

    const scopedToNew = "# Production Upgrade Runbook\n\nFrom `v0.13.2` up to `v0.13.3`.\n\n## 0. Scope\n";
    const current = makeFixture({ docs: { ...READY_DOCS, "docs/PRODUCTION_UPGRADE_RUNBOOK.md": scopedToNew } });
    expect(prepareRelease({ repoRoot: current.repo, run: fixtureRunner(current.repo), log: silentLog() })).toMatchObject({
      version: "0.13.3",
    });
  });

  it("explains a refusal to fold into a release heading that already exists, and changes nothing", () => {
    const taken = UPGRADING_READY.replace("## v0.13.1 → v0.13.2", "## v0.13.2 → v0.13.3\n\nSteps already placed by hand.\n\n## v0.13.1 → v0.13.2");
    const { repo } = makeFixture({ docs: { ...READY_DOCS, "docs/UPGRADING.md": taken } });
    const before = snapshot(repo);
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /Cannot fold docs\/UPGRADING\.md: .*already has "## v0\.13\.2 → v0\.13\.3"\. Its "## Unreleased" steps would have nowhere to go\./,
    );
    expect(error.recovery).toContain('into "## v0.13.2 → v0.13.3" in a pull request to main, then re-run.');
    expect(snapshot(repo)).toEqual(before);
  });

  it("refuses a plain prepare when the release's section already exists, even with nothing waiting (#4983)", () => {
    const handWritten = `${GUIDE_TOP}\n## Unreleased\n\n---\n\n## v0.13.2 → v0.13.3\n\nSteps placed by hand.\n\n---\n\n${RELEASED_UPGRADE_SECTION}`;
    const { repo } = makeFixture({ upgrading: handWritten });
    const before = snapshot(repo);
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, execute: true, date: "2026-10-31", run: fixtureRunner(repo), log: silentLog() }),
      /Cannot fold docs\/UPGRADING\.md: it already has "## v0\.13\.2 → v0\.13\.3"\. A release's upgrade section is only rolled once\./,
    );
    expect(error.recovery).toContain("prepare --amend --execute");
    expect(snapshot(repo)).toEqual(before);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
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

/** Stands in for the maintainer writing the notes stub on the release-prep branch. */
function finishNotes(repo, version) {
  const file = path.join(repo, "docs", "releases", `v${version}.md`);
  fs.writeFileSync(file, `# Release v${version}\n\nWhat this release changes, written by a maintainer.\n`);
  git(repo, "commit", "-qam", `docs: write the v${version} release notes`);
}

/** A fixture whose release-prep pull request (notes written) has merged to origin/main (fast-forward). */
function mergedReleaseFixture(options) {
  const fixture = makeFixture(options);
  const plan = prepareRelease({ repoRoot: fixture.repo, execute: true, date: "2026-10-31", run: fixtureRunner(fixture.repo), log: silentLog() });
  finishNotes(fixture.repo, plan.version);
  git(fixture.repo, "push", "-q", "origin", "HEAD:main"); // stands in for merging the release-prep PR
  return { ...fixture, merged: git(fixture.repo, "rev-parse", "HEAD") };
}

/**
 * The late-fragment race: a fragment-bearing PR merges to main while the
 * release-prep PR is open, then the prep PR merges with a merge commit.
 * Returns the prep commit (never main's tip) and the merge commit.
 */
function lateFragmentFixture({ lateName = "4500-late.md", bump = null, docs = {} } = {}) {
  const fixture = makeFixture({ docs });
  const plan = prepareRelease({ repoRoot: fixture.repo, execute: true, bump, date: "2026-10-31", run: fixtureRunner(fixture.repo), log: silentLog() });
  finishNotes(fixture.repo, plan.version);
  const prep = git(fixture.repo, "rev-parse", "HEAD");
  git(fixture.repo, "switch", "-q", "--detach", "origin/main");
  fs.writeFileSync(path.join(fixture.repo, "changelog.d", lateName), "- **Late (#4500).**\n");
  git(fixture.repo, "add", "--all");
  git(fixture.repo, "commit", "-qm", "Merge pull request #4500");
  git(fixture.repo, "merge", "-q", "--no-ff", "-m", `Merge pull request #4501 from ${plan.branch}`, prep);
  git(fixture.repo, "push", "-q", "origin", "HEAD:main");
  return { ...fixture, prep, merge: git(fixture.repo, "rev-parse", "HEAD") };
}

describe("late fragments: release:cut prepare --amend and publish --carry-late-fragments", FIXTURE_REPOSITORY_BUDGET, () => {
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

  it("folds late upgrade steps into the untagged release on --amend (#4983; #4979 left them by hand)", () => {
    const { repo } = lateFragmentFixture({ docs: READY_DOCS });
    // A late pull request adds a step under the fresh, empty "## Unreleased" the first prepare left.
    const guide = path.join(repo, "docs", "UPGRADING.md");
    fs.writeFileSync(
      guide,
      fs.readFileSync(guide, "utf8").replace(`${UNRELEASED_HEADING}\n\n---`, `${UNRELEASED_HEADING}\n\n### A late step (#4500)\n\nDo it.\n\n---`),
    );
    git(repo, "commit", "-qam", "Merge pull request #4502");
    git(repo, "push", "-q", "origin", "HEAD:main");

    const dry = silentLog();
    prepareRelease({ repoRoot: repo, amend: true, run: fixtureRunner(repo), log: dry });
    expect(dry.text()).toContain(`move docs/UPGRADING.md's late "${UNRELEASED_HEADING}" steps to the end of "## v0.13.2 → v0.13.3"`);
    expect(dry.text()).not.toContain("by hand and commit");

    prepareRelease({ repoRoot: repo, amend: true, execute: true, date: "2026-11-02", run: fixtureRunner(repo), log: silentLog() });
    expect(git(repo, "show", "--name-status", "--format=", "HEAD").split("\n")).toContain("M\tdocs/UPGRADING.md");
    const folded = fs.readFileSync(guide, "utf8");
    expect(unreleasedBlock(folded).hasSteps).toBe(false);
    expect(folded).toContain(["## v0.13.2 → v0.13.3", "", UPGRADE_CHECKLIST_HEADING, "", "1. Rehearse.", "", "### A late step (#4500)"].join("\n"));
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

  it("still prepares when package.json is ahead but no section was compiled for it", () => {
    const { repo } = makeFixture();
    fs.writeFileSync(path.join(repo, "package.json"), bumpPackageJson(PACKAGE_JSON, "0.13.3"));
    git(repo, "commit", "-qam", "a hand bump with no compile");
    git(repo, "push", "-q", "origin", "HEAD:main");
    const log = silentLog();
    expect(prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log })).toMatchObject({ version: "0.13.3" });
    expect(log.text()).toContain("Note: package.json says 0.13.3, not the latest tag's 0.13.2.");
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

describe("release documents: the upgrade guide and notes page (#4983)", FIXTURE_REPOSITORY_BUDGET, () => {
  /** Commit `edit(repo)` straight to origin/main, as a merged pull request. */
  function mergeToMain(repo, message, edit) {
    git(repo, "switch", "-q", "--detach", "origin/main");
    edit(repo);
    git(repo, "add", "--all");
    git(repo, "commit", "-qm", message);
    git(repo, "push", "-q", "origin", "HEAD:main");
  }
  const upgradingPath = (repo) => path.join(repo, "docs", "UPGRADING.md");
  const editUpgrading = (repo, change) => fs.writeFileSync(upgradingPath(repo), change(fs.readFileSync(upgradingPath(repo), "utf8")));
  const LATE_STEP = "### Run the pre-deploy check (#4610)\n\nRun it before deploying.";
  const addLateStep = (repo) => editUpgrading(repo, (text) => text.replace("## Unreleased\n\n", `## Unreleased\n\n${LATE_STEP}\n\n`));

  it("gives a release with no waiting upgrade steps a section that says so", () => {
    const { repo } = makeFixture({ upgrading: UPGRADING.replace(`${UPGRADE_STEP}\n\n`, "") });
    prepareRelease({ repoRoot: repo, execute: true, date: "2026-10-31", run: fixtureRunner(repo), log: silentLog() });
    expect(fs.readFileSync(upgradingPath(repo), "utf8")).toContain(`## v0.13.2 → v0.13.3\n\n${NO_UPGRADE_STEPS}\n\n---\n\n${RELEASED_UPGRADE_SECTION}`);
  });

  it("refuses a prepare whose upgrade guide has no Unreleased heading, changing nothing", () => {
    const { repo } = makeFixture({ upgrading: UPGRADING.replace("## Unreleased", "## Next") });
    const before = snapshot(repo);
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, execute: true, run: fixtureRunner(repo), log: silentLog() }),
      /upgrade documents are not ready[\s\S]*docs\/UPGRADING\.md must have exactly one "## Unreleased" heading; it has 0/,
    );
    expect(error.recovery).toContain("Public Reference Release Checklist");
    expect(snapshot(repo)).toEqual(before);
  });

  it("refuses to publish while the notes page is still the unfinished stub", () => {
    const { repo } = makeFixture();
    prepareRelease({ repoRoot: repo, execute: true, date: "2026-10-31", run: fixtureRunner(repo), log: silentLog() });
    git(repo, "push", "-q", "origin", "HEAD:main");
    const run = fixtureRunner(repo);
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }),
      /docs\/releases\/v0\.13\.3\.md at [0-9a-f]{12} is still the unfinished stub/,
    );
    expect(error.recovery).toContain("delete the stub note, its marker line and the placeholder");
    expect(run.sideEffects()).toEqual([]);
  });

  it("refuses to publish when only the marker was deleted and the stub's own text remains", () => {
    const { repo } = makeFixture();
    prepareRelease({ repoRoot: repo, execute: true, date: "2026-10-31", run: fixtureRunner(repo), log: silentLog() });
    const page = path.join(repo, "docs", "releases", "v0.13.3.md");
    fs.writeFileSync(page, fs.readFileSync(page, "utf8").replace(`${RELEASE_NOTES_UNFINISHED_MARKER}\n`, ""));
    git(repo, "commit", "-qam", "docs: delete only the marker");
    git(repo, "push", "-q", "origin", "HEAD:main");
    expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /is still the unfinished stub \(it still has the "Unfinished stub" note, the placeholder paragraph\)/,
    );
  });

  it("refuses to publish when the notes page is missing", () => {
    const { repo } = mergedReleaseFixture();
    mergeToMain(repo, "Merge pull request #4611", (dir) => fs.rmSync(path.join(dir, "docs", "releases", "v0.13.3.md")));
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /docs\/releases\/v0\.13\.3\.md is missing at [0-9a-f]{12}: v0\.13\.3 has no release-notes page/,
    );
    expect(error.recovery).toContain("pnpm run release:cut prepare --amend --execute");

    // The recovery it names must work in the very state it was printed for: the page is gone but
    // its index line is still there, so the fold writes the stub and leaves the index alone.
    const indexPath = path.join(repo, "docs", "releases", "README.md");
    const indexBefore = fs.readFileSync(indexPath, "utf8");
    expect(indexBefore).toContain("](v0.13.3.md)");
    prepareRelease({ repoRoot: repo, amend: true, execute: true, run: fixtureRunner(repo), log: silentLog() });
    expect(fs.readFileSync(path.join(repo, "docs", "releases", "v0.13.3.md"), "utf8")).toContain(RELEASE_NOTES_UNFINISHED_MARKER);
    expect(fs.readFileSync(indexPath, "utf8")).toBe(indexBefore);
  });

  it("refuses to publish when the upgrade guide has no section for the release", () => {
    const { repo } = mergedReleaseFixture();
    mergeToMain(repo, "Merge pull request #4612", (dir) =>
      editUpgrading(dir, (text) => text.replace("## v0.13.2 → v0.13.3", "## Next release")),
    );
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /docs\/UPGRADING\.md at [0-9a-f]{12} has no "## v0\.13\.2 → v0\.13\.3" section/,
    );
    expect(error.recovery).toContain("pnpm run release:cut prepare --amend --execute");
  });

  const addStepToReleased = (repo) =>
    editUpgrading(repo, (text) => text.replace("Already shipped.\n", "Already shipped.\n\n### Merged into a released section (#4620)\n\nDo it.\n"));

  it("refuses a prepare when a step was added to a section origin's latest tag already released", () => {
    const { repo } = makeFixture();
    mergeToMain(repo, "Merge pull request #4620", addStepToReleased);
    expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /docs\/UPGRADING\.md has upgrade step\(s\) in a section already released, which v0\.13\.2 did not have \(### Merged into a released section \(#4620\)\)/,
    );
  });

  it("lets a prepare and a publish through when only a released step's title was reworded", () => {
    const reword = (dir) => editUpgrading(dir, (text) => text.replace("### An older step (#1234)", "### An older step (#1234, typo fixed)"));
    const prepared = makeFixture();
    mergeToMain(prepared.repo, "Merge pull request #4621", reword);
    expect(prepareRelease({ repoRoot: prepared.repo, run: fixtureRunner(prepared.repo), log: silentLog() })).toMatchObject({ executed: false });

    const { repo } = mergedReleaseFixture();
    mergeToMain(repo, "Merge pull request #4621", reword);
    expect(publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() })).toMatchObject({ tag: "v0.13.3" });
  });

  /** A release section that arrives whole, as when a fork merges an upstream release tag. */
  const addWholeReleasedSection = (repo) =>
    editUpgrading(repo, (text) =>
      text.replace(RELEASED_UPGRADE_SECTION, `${RELEASED_UPGRADE_SECTION}\n---\n\n## v0.13.0 → v0.13.1\n\n### Upstream step (#4600)\n\nDo it.\n`),
    );

  it("does not take a release section that arrived whole since the tag for a late step, in prepare or publish", () => {
    const prepared = makeFixture();
    mergeToMain(prepared.repo, "Merge upstream release v0.13.1", addWholeReleasedSection);
    prepareRelease({ repoRoot: prepared.repo, execute: true, date: "2026-10-31", run: fixtureRunner(prepared.repo), log: silentLog() });
    expect(fs.readFileSync(upgradingPath(prepared.repo), "utf8")).toContain("### Upstream step (#4600)");

    const { repo } = mergedReleaseFixture();
    mergeToMain(repo, "Merge upstream release v0.13.1", addWholeReleasedSection);
    expect(publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() })).toMatchObject({ tag: "v0.13.3" });
  });

  it("still catches a late step in a section the tag had, beside one that arrived whole", () => {
    const { repo } = makeFixture();
    mergeToMain(repo, "Merge upstream release v0.13.1", addWholeReleasedSection);
    mergeToMain(repo, "Merge pull request #4620", addStepToReleased);
    expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /has upgrade step\(s\) in a section already released, which v0\.13\.2 did not have \(### Merged into a released section \(#4620\)\)/,
    );
  });

  it("refuses rather than skip the released-section check when the previous tag's commit is not in this clone", () => {
    const { repo } = makeFixture();
    const real = fixtureRunner(repo);
    // A shallow clone: the commit origin's tag names is not here to read.
    const run = (command, args) =>
      command === "git" && args[0] === "cat-file" && args[1] === "-e" ? { status: 1, stdout: "", stderr: "" } : real(command, args);
    run.calls = real.calls;
    const before = snapshot(repo);
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, execute: true, run, log: silentLog() }),
      /v0\.13\.2 is at [0-9a-f]{12} on origin, but that commit is not in this clone/,
    );
    expect(error.recovery).toContain("git fetch --no-tags origin");
    expect(snapshot(repo)).toEqual(before);
  });

  it("refuses a prepare while a document links the guide's Unreleased heading, which the roll would leave empty", () => {
    const { repo } = makeFixture();
    // Built, not written out: this file is tracked, and `prepare` refuses a tracked file naming the link.
    const link = `[the guide](${UNRELEASED_LINK})`;
    mergeToMain(repo, "Merge pull request #4630", (dir) => fs.writeFileSync(path.join(dir, "docs", "RUNBOOK.md"), `See ${link}.\n`));
    const before = snapshot(repo);
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, execute: true, run: fixtureRunner(repo), log: silentLog() }),
      /docs\/RUNBOOK\.md links to UPGRADING\.md#unreleased, which would point at an empty section once the steps are filed under "## v0\.13\.2 → v0\.13\.3"/,
    );
    expect(error.recovery).toContain("link the step's own heading instead");
    expect(snapshot(repo)).toEqual(before);

    // History is not guidance, and a release with no steps orphans nothing.
    mergeToMain(repo, "Merge pull request #4631", (dir) => {
      fs.rmSync(path.join(dir, "docs", "RUNBOOK.md"));
      fs.appendFileSync(path.join(dir, "changelog.d", "4631-history.md"), `- **Old note (#4631).** See ${link}.\n`);
    });
    expect(prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() })).toMatchObject({ executed: false });
    const none = makeFixture({ upgrading: UPGRADING.replace(`${UPGRADE_STEP}\n\n`, "") });
    mergeToMain(none.repo, "Merge pull request #4630", (dir) => fs.writeFileSync(path.join(dir, "docs", "RUNBOOK.md"), `See ${link}.\n`));
    expect(prepareRelease({ repoRoot: none.repo, run: fixtureRunner(none.repo), log: silentLog() })).toMatchObject({ executed: false });
  });

  it("refuses rather than pass when the search for links to the guide's Unreleased heading itself fails", () => {
    const { repo } = makeFixture();
    const real = fixtureRunner(repo);
    const run = (command, args) => (command === "git" && args[0] === "grep" ? { status: 128, stdout: "", stderr: "fatal: not a git repository" } : real(command, args));
    run.calls = real.calls;
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, execute: true, run, log: silentLog() }),
      /Could not search for links to UPGRADING\.md#unreleased: fatal: not a git repository/,
    );
    expect(error.recovery).toContain("Nothing was changed");
  });

  it("refuses to publish when a step merged into a released section instead of the release's own", () => {
    const { repo } = mergedReleaseFixture();
    mergeToMain(repo, "Merge pull request #4620", addStepToReleased);
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /At [0-9a-f]{12}: docs\/UPGRADING\.md has upgrade step\(s\) in a section already released/,
    );
    expect(error.recovery).toContain('Move them under "## Unreleased" with a pull request');
    // Reworded prose in a released section is not a new step.
    mergeToMain(repo, "Merge pull request #4621", (dir) =>
      editUpgrading(dir, (text) => text.replace("### Merged into a released section (#4620)\n\nDo it.\n", "").replace("Already shipped.", "Shipped.")),
    );
    expect(publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() })).toMatchObject({ tag: "v0.13.3" });
  });

  it("refuses late upgrade steps, even with --carry-late-fragments, until --amend files them under the release", () => {
    const { repo } = mergedReleaseFixture();
    mergeToMain(repo, "Merge pull request #4610", addLateStep);

    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /docs\/UPGRADING\.md at [0-9a-f]{12} still has upgrade steps under "## Unreleased" \(### Run the pre-deploy check \(#4610\)\)/,
    );
    expect(error.recovery).toContain("pnpm run release:cut prepare --amend --execute");
    expect(error.recovery).toContain("--carry-late-fragments does not carry upgrade steps");
    expectRefusal(
      () => publishRelease({ repoRoot: repo, carryLateFragments: true, run: fixtureRunner(repo), log: silentLog() }),
      /still has upgrade steps under "## Unreleased"/,
    );

    const dry = silentLog();
    prepareRelease({ repoRoot: repo, amend: true, run: fixtureRunner(repo), log: dry });
    expect(dry.text()).toContain('docs/UPGRADING.md: move 1 late step(s) from "## Unreleased" into "## v0.13.2 → v0.13.3"');
    prepareRelease({ repoRoot: repo, amend: true, execute: true, run: fixtureRunner(repo), log: silentLog() });
    expect(git(repo, "show", "--name-status", "--format=", "HEAD")).toBe("M\tdocs/UPGRADING.md");
    const upgrading = fs.readFileSync(upgradingPath(repo), "utf8");
    expect(unreleasedBlock(upgrading).hasSteps).toBe(false);
    expect(upgrading).toContain(`## v0.13.2 → v0.13.3\n\n${UPGRADE_STEP}\n\n${LATE_STEP}\n\n---\n\n${RELEASED_UPGRADE_SECTION}`);

    git(repo, "push", "-q", "origin", "HEAD:main"); // the fold's pull request merges
    expect(publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() })).toMatchObject({ tag: "v0.13.3" });
  });

  it("prints a docs-only fold truthfully: no compile step, no changelog to re-read, a neutral commit message", () => {
    const { repo } = mergedReleaseFixture();
    mergeToMain(repo, "Merge pull request #4610", addLateStep);

    const dry = silentLog();
    prepareRelease({ repoRoot: repo, amend: true, run: fixtureRunner(repo), log: dry });
    const text = dry.text();
    expect(text).not.toContain("node scripts/release/compile-changelog.mjs");
    expect(text).not.toContain('Read "## 0.13.3 - 2026-10-31" end to end');
    expect(text).not.toContain("Finish docs/releases/v0.13.3.md");
    expect(text).toContain('Read "## v0.13.2 → v0.13.3" in docs/UPGRADING.md');
    expect(text).toContain('git commit -m "release: fold late documents into v0.13.3"');

    prepareRelease({ repoRoot: repo, amend: true, execute: true, run: fixtureRunner(repo), log: silentLog() });
    expect(git(repo, "log", "-1", "--format=%s")).toBe("release: fold late documents into v0.13.3");
  });

  it("says a missing notes page is the thing to finish when only the page was never written", () => {
    const { repo } = mergedReleaseFixture();
    // A release prepared before the tool wrote notes: neither the page nor its index line exists.
    mergeToMain(repo, "Merge pull request #4611", (dir) => {
      fs.rmSync(path.join(dir, "docs", "releases", "v0.13.3.md"));
      fs.writeFileSync(path.join(dir, "docs", "releases", "README.md"), RELEASES_INDEX);
    });
    const dry = silentLog();
    prepareRelease({ repoRoot: repo, amend: true, run: fixtureRunner(repo), log: dry });
    const text = dry.text();
    expect(text).toContain("Finish docs/releases/v0.13.3.md: write the overview");
    expect(text).not.toContain("Read \"## v0.13.2 → v0.13.3\"");
  });

  it("refuses an amend whose changelog heading has no readable date, rather than write it into the notes stub", () => {
    const { repo } = mergedReleaseFixture();
    mergeToMain(repo, "Merge pull request #4640", (dir) => {
      const changelog = path.join(dir, "CHANGELOG.md");
      fs.writeFileSync(changelog, fs.readFileSync(changelog, "utf8").replace("## 0.13.3 - 2026-10-31", "## 0.13.3 (2026-10-31)"));
      fs.rmSync(path.join(dir, "docs", "releases", "v0.13.3.md"));
    });
    const before = snapshot(repo);
    const error = expectRefusal(
      () => prepareRelease({ repoRoot: repo, amend: true, execute: true, run: fixtureRunner(repo), log: silentLog() }),
      /CHANGELOG\.md's "## 0\.13\.3 \(2026-10-31\)" is not shaped "## 0\.13\.3 - <YYYY-MM-DD>"/,
    );
    expect(error.recovery).toContain("Restore the heading");
    expect(snapshot(repo)).toEqual(before);
  });
});

describe("release:cut publish on a fixture repository", FIXTURE_REPOSITORY_BUDGET, () => {
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
    expect(text).toContain('Release documents: "## v0.13.2 → v0.13.3" in docs/UPGRADING.md, and docs/releases/v0.13.3.md.');
    expect(text).toContain('Release body: the "## 0.13.3 - 2026-10-31" section, 26 characters.');
    expect(text).toContain("4. git push origin refs/tags/v0.13.3");
    expect(text).toContain("5. gh release create v0.13.3 --repo fixture-owner/fixture-repo --verify-tag --title v0.13.3 --notes-file <body>");
    expect(text).toContain("DEPLOY_REF=v0.13.3 ./scripts/run-production-blue-green-deploy.sh");
    expect(text).toContain('CI: ci.yml run 101 published its images ("Publish GHCR images": success).');
    expect(run.calls.filter((call) => call.startsWith("gh "))).toEqual([
      `${GH_RUNS}ci.yml/runs?head_sha=${merged}&event=push&branch=main&per_page=100`,
      `${GH_JOBS}101/jobs?filter=all&per_page=100`,
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
      `${GH_RUNS}ci.yml/runs?head_sha=${merged}&event=push&branch=main&per_page=100`,
      `${GH_JOBS}101/jobs?filter=all&per_page=100`,
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

  it("will not resume on a pushed tag that is off main's first-parent chain", () => {
    const { repo, prep } = lateFragmentFixture();
    git(repo, "tag", "-a", "v0.13.3", "-m", "v0.13.3", prep);
    git(repo, "push", "-q", "origin", "refs/tags/v0.13.3");
    const run = fixtureRunner(repo);
    expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }),
      /is not on origin\/main's first-parent chain/,
    );
    expect(run.sideEffects()).toEqual([]);
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
      /origin's URL is not a GitHub repository URL: /,
    );
    // Joined from parts so no literal here reads as a comment delimiter.
    const redacted = ["https:", "", "***@localhost", "o", "r.git"].join("/");
    expect(error.message).toBe(`origin's URL is not a GitHub repository URL: ${redacted}`);
    expect(`${error.message}\n${error.recovery}`).not.toContain("SECRET-TOKEN");
    expect(`${error.message}\n${error.recovery}`).not.toContain("release-bot");
  });
});

const PLAN_GUIDE = [
  "# Upgrading",
  "",
  "## Unreleased",
  "",
  "### Reconnect Xero once (#4600)",
  "",
  "Open Admin → Xero and reconnect.",
  "",
  "### Run the pre-deploy check (#4601)",
  "",
  "Run it.",
  "",
  "---",
  "",
  "## v0.13.1 → v0.13.2",
  "",
  "### An older step (#1000)",
  "",
].join("\n");
const PLAN_HEADING = upgradingReleaseHeading("0.13.2", "0.14.0");

describe("planReleaseDocs on a directory (#4983)", () => {
  const PLAN_INDEX = "# Release notes\n\n## Published release notes\n\n- [v0.13.2](v0.13.2.md) — older.\n";
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-plan-"));
    fs.mkdirSync(path.join(root, "docs", "releases"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "UPGRADING.md"), PLAN_GUIDE);
    fs.writeFileSync(path.join(root, "docs", "releases", "README.md"), PLAN_INDEX);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const plan = (amend = false) =>
    planReleaseDocs({
      repoRoot: root,
      version: "0.14.0",
      previousTag: "v0.13.2",
      date: "2026-11-20",
      bump: "minor",
      changelogHeading: "## 0.14.0 - 2026-11-20",
      amend,
    });

  it("plans the roll, the stub and the index line without writing anything", () => {
    const docs = plan();
    expect(docs.files.map((file) => file.relative)).toEqual(["docs/UPGRADING.md", "docs/releases/v0.14.0.md", "docs/releases/README.md"]);
    expect(docs.describe).toEqual([
      'docs/UPGRADING.md: rename "## Unreleased" to "## v0.13.2 → v0.14.0" (2 step(s)), with a fresh empty "## Unreleased" above it',
      "docs/releases/v0.14.0.md: new notes stub, marked unfinished until it is written",
      'docs/releases/README.md: list v0.14.0 first under "Published release notes"',
    ]);
    expect(fs.readFileSync(path.join(root, "docs", "UPGRADING.md"), "utf8")).toBe(PLAN_GUIDE);
    expect(fs.existsSync(path.join(root, "docs", "releases", "v0.14.0.md"))).toBe(false);

    for (const file of docs.files) fs.writeFileSync(path.join(root, file.relative), file.text);
    expect(hasUpgradingSection(fs.readFileSync(path.join(root, "docs", "UPGRADING.md"), "utf8"), PLAN_HEADING)).toBe(true);
    // A second prepare refuses rather than writing a second heading or page.
    expect(() => plan()).toThrow(/already has "## v0\.13\.2 → v0\.14\.0"\. A release's upgrade section is only rolled once/);
    // --amend with nothing waiting and the page already written changes nothing.
    expect(plan(true).files).toEqual([]);
  });

  it("refuses to overwrite a notes page that already exists", () => {
    fs.writeFileSync(path.join(root, "docs", "releases", "v0.14.0.md"), "# Written by hand\n");
    expect(() => plan()).toThrow(/v0\.14\.0\.md already exists/);
    const docs = plan(true);
    expect(docs.files.map((file) => file.relative)).toEqual(["docs/UPGRADING.md"]);
  });
});

describe("release:cut publish asks GitHub whether CI published the commit's images (INV-OPS-021)", () => {
  it("names a workflow file and a job that exist, and the job publishes only from main pushes", () => {
    const workflow = parseWorkflowYaml(fs.readFileSync(path.join(import.meta.dirname, "..", "..", ".github", "workflows", CI_WORKFLOW_FILE), "utf8"));
    const publishing = Object.values(workflow.jobs).filter((job) => job.name === PUBLISH_IMAGES_JOB_NAME);
    expect(publishing).toHaveLength(1);
    expect(publishing[0].if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  });

  const refusals = [
    ["the run was cancelled before publishing", { [GH_RUNS]: ciRuns(ciRun(101, "cancelled")), [GH_JOBS]: ciJobs(ciJob(2, PUBLISH_IMAGES_JOB_NAME, "cancelled")) }, /Found: run 101 \(cancelled\): "Publish GHCR images" cancelled\./],
    ["the run failed and publishing was skipped", { [GH_RUNS]: ciRuns(ciRun(101, "failure")), [GH_JOBS]: ciJobs(ciJob(1, "Verify", "failure"), ciJob(2, PUBLISH_IMAGES_JOB_NAME, "skipped")) }, /run 101 \(failure\): "Publish GHCR images" skipped/],
    ["the publish job itself failed", { [GH_JOBS]: ciJobs(ciJob(2, PUBLISH_IMAGES_JOB_NAME, "failure")) }, /run 101 \(success\): "Publish GHCR images" failure/],
    ["the run is still going", { [GH_RUNS]: ciRuns(ciRun(101, null)), [GH_JOBS]: ciJobs(ciJob(2, PUBLISH_IMAGES_JOB_NAME, null)) }, /run 101 \(in_progress\): "Publish GHCR images" queued/],
    ["the run has no publish job", { [GH_JOBS]: ciJobs(ciJob(1, "Verify")) }, /run 101 \(success\): "Publish GHCR images" never ran/],
    ["GitHub has no run for the commit", { [GH_RUNS]: ciRuns() }, /GitHub has no such run for it\./],
  ];
  for (const [label, stubs, pattern] of refusals) {
    it(`refuses before any tag or release when ${label}, in the dry run and with --execute`, () => {
      const { repo, merged } = mergedReleaseFixture();
      for (const execute of [false, true]) {
        const run = fixtureRunner(repo, stubs);
        const error = expectRefusal(
          () => publishRelease({ repoRoot: repo, execute, run, writeNotes: notesWriter(), log: silentLog() }),
          new RegExp(`^${merged.slice(0, 12)} has no ci\\.yml push run on main whose "Publish GHCR images" job succeeded`),
        );
        expect(error.message).toMatch(pattern);
        expect(error.recovery).toMatch(/^Nothing was created\./);
        expect(run.sideEffects()).toEqual([]);
        expect(git(repo, "tag", "--list", "v0.13.3")).toBe("");
      }
    });
  }

  it("gives the re-run command when a run exists, and a different remedy when none does", () => {
    const { repo } = mergedReleaseFixture();
    const cancelled = expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo, { [GH_RUNS]: ciRuns(ciRun(4242, "cancelled")), [GH_JOBS]: ciJobs() }), log: silentLog() }),
      /run 4242/,
    );
    expect(cancelled.recovery).toContain("gh run rerun 4242 --repo fixture-owner/fixture-repo");
    // A re-run replaces main's pending run (INV-OPS-021), so the hint says to check first.
    expect(cancelled.recovery).toContain("gh run list --workflow ci.yml --branch main --status pending --repo fixture-owner/fixture-repo");
    const absent = expectRefusal(() => publishRelease({ repoRoot: repo, run: fixtureRunner(repo, { [GH_RUNS]: ciRuns() }), log: silentLog() }), /no such run/);
    expect(absent.recovery).toBe("Nothing was created. Tag a main commit whose ci.yml run published its images.");
  });

  it("accepts images an earlier attempt published, and reports the latest attempt when none did", () => {
    const { repo } = mergedReleaseFixture();
    const rerunFailed = ciJobs({ ...ciJob(3, PUBLISH_IMAGES_JOB_NAME, "failure"), run_attempt: 2 }, { ...ciJob(2, PUBLISH_IMAGES_JOB_NAME), run_attempt: 1 });
    const log = silentLog();
    publishRelease({ repoRoot: repo, run: fixtureRunner(repo, { [GH_RUNS]: ciRuns(ciRun(101, "failure")), [GH_JOBS]: rerunFailed }), log });
    expect(log.text()).toContain("CI: ci.yml run 101 published its images");

    const neither = ciJobs({ ...ciJob(3, PUBLISH_IMAGES_JOB_NAME, "failure"), run_attempt: 2 }, { ...ciJob(2, PUBLISH_IMAGES_JOB_NAME, "cancelled"), run_attempt: 1 });
    expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo, { [GH_RUNS]: ciRuns(ciRun(101, "failure")), [GH_JOBS]: neither }), log: silentLog() }),
      /run 101 \(failure\): "Publish GHCR images" failure\./,
    );
  });

  it("publishes when a later run for the commit published, even if an earlier one did not", () => {
    const { repo } = mergedReleaseFixture();
    const run = fixtureRunner(repo, {
      [GH_RUNS]: ciRuns(ciRun(101, "cancelled"), ciRun(102)),
      [GH_JOBS]: (line) => (line.includes("/runs/102/") ? PUBLISHED_JOBS : ciJobs(ciJob(2, PUBLISH_IMAGES_JOB_NAME, "cancelled"))),
    });
    const log = silentLog();
    expect(publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log }).executed).toBe(true);
    expect(log.text()).toContain("CI: ci.yml run 102 published its images");
  });

  const unreadable = [
    ["the API call fails", { [GH_RUNS]: { status: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" } }, /failed:\nHTTP 403/],
    ["the answer is not JSON", { [GH_RUNS]: { status: 0, stdout: "<html>", stderr: "" } }, /answered in a shape this script does not read/],
    ["the runs list is missing", { [GH_RUNS]: json({ total_count: 0 }) }, /answered in a shape/],
    ["a run has no id", { [GH_RUNS]: json({ total_count: 1, workflow_runs: [{ status: "completed", conclusion: "success" }] }) }, /answered in a shape/],
    ["a jobs page is shorter than GitHub says the answer holds", { [GH_JOBS]: json({ total_count: 150, jobs: [ciJob(2, PUBLISH_IMAGES_JOB_NAME)] }) }, /answered in a shape/],
    ["the jobs call fails", { [GH_JOBS]: { status: 1, stdout: "", stderr: "HTTP 502" } }, /failed:\nHTTP 502/],
  ];
  for (const [label, stubs, pattern] of unreadable) {
    it(`fails closed when ${label}`, () => {
      const { repo } = mergedReleaseFixture();
      const run = fixtureRunner(repo, stubs);
      const error = expectRefusal(() => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }), pattern);
      expect(error.recovery).toMatch(/^Nothing was created\./);
      expect(run.sideEffects()).toEqual([]);
      expect(git(repo, "tag", "--list", "v0.13.3")).toBe("");
    });
  }

  /** A full page of jobs that are not the publish job: what a run re-run several times fills the first pages with. */
  const fullPage = (first) => Array.from({ length: 100 }, (_, index) => ({ ...ciJob(first + index, "Verify"), run_attempt: 1 }));

  it("reads every page of a run's jobs, so a run re-run several times still counts", () => {
    const { repo } = mergedReleaseFixture();
    const published = { ...ciJob(9001, PUBLISH_IMAGES_JOB_NAME), run_attempt: 6 };
    const run = fixtureRunner(repo, {
      [GH_JOBS]: (line) => json({ total_count: 101, jobs: line.endsWith("&page=2") ? [published] : fullPage(1) }),
    });
    const log = silentLog();
    publishRelease({ repoRoot: repo, run, log });
    expect(log.text()).toContain("CI: ci.yml run 101 published its images");
    expect(run.calls.filter((call) => call.startsWith(GH_JOBS))).toEqual([
      `${GH_JOBS}101/jobs?filter=all&per_page=100`,
      `${GH_JOBS}101/jobs?filter=all&per_page=100&page=2`,
    ]);
  });

  it("refuses with its own message, not an API-change one, when an answer outgrows the pages it reads", () => {
    const { repo } = mergedReleaseFixture();
    const run = fixtureRunner(repo, { [GH_JOBS]: (line) => json({ total_count: 5000, jobs: fullPage(Number(/&page=(\d+)$/.exec(line)?.[1] ?? 1) * 100) }) });
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }),
      /runs\/101\/jobs\?filter=all&per_page=100 holds more than 10 pages of 100, more than this script reads/,
    );
    expect(error.recovery).toMatch(/^Nothing was created\. A run re-run this many times is unusual/);
    expect(error.recovery).not.toContain("API has changed");
    expect(run.calls.filter((call) => call.startsWith(GH_JOBS))).toHaveLength(10);
    expect(run.sideEffects()).toEqual([]);
    expect(git(repo, "tag", "--list", "v0.13.3")).toBe("");
  });

  /** Origin holds v0.13.3 on the merged commit with no release, and main has moved to a commit CI has not published. */
  function resumeFixture() {
    const fixture = mergedReleaseFixture();
    git(fixture.repo, "tag", "-a", "v0.13.3", "-m", "v0.13.3", fixture.merged);
    git(fixture.repo, "push", "-q", "origin", "refs/tags/v0.13.3");
    git(fixture.repo, "commit", "-q", "--allow-empty", "-m", "Merge pull request #4600 (docs)");
    git(fixture.repo, "push", "-q", "origin", "HEAD:main");
    return { ...fixture, moved: git(fixture.repo, "rev-parse", "HEAD") };
  }

  it("on a resume, judges the tagged commit, not main's newer tip", () => {
    const { repo, merged, moved } = resumeFixture();
    const run = fixtureRunner(repo, { [GH_RUNS]: (line) => (line.includes(`head_sha=${merged}&`) ? ciRuns(ciRun(101)) : ciRuns()) });
    const result = publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() });
    expect(result).toMatchObject({ state: "pushed", commit: merged, executed: true });
    expect(run.calls.filter((call) => call.startsWith(GH_RUNS))).toEqual([expect.stringContaining(`head_sha=${merged}&`)]);
    expect(run.calls.some((call) => call.startsWith("gh ") && call.includes(moved))).toBe(false);
  });

  it("points a local-only tag at --commit before judging main's unpublished tip", () => {
    const { repo, merged } = mergedReleaseFixture();
    git(repo, "tag", "-a", "v0.13.3", "-m", "v0.13.3", merged);
    git(repo, "commit", "-q", "--allow-empty", "-m", "Merge pull request #4600 (docs)");
    git(repo, "push", "-q", "origin", "HEAD:main");
    const run = fixtureRunner(repo, { [GH_RUNS]: (line) => (line.includes(`head_sha=${merged}&`) ? ciRuns(ciRun(101)) : ciRuns()) });
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }),
      /This clone's tag v0\.13\.3 is on [0-9a-f]{12}, not [0-9a-f]{12}, and origin has no v0\.13\.3/,
    );
    expect(error.recovery).toBe(`Resume against the tagged commit: pnpm run release:cut publish --execute --commit ${merged}`);
    expect(run.sideEffects()).toEqual([]);
  });

  it("on a resume, refuses the tagged commit when its run did not publish", () => {
    const { repo, merged } = resumeFixture();
    const run = fixtureRunner(repo, { [GH_RUNS]: (line) => (line.includes(`head_sha=${merged}&`) ? ciRuns(ciRun(101, "cancelled")) : ciRuns(ciRun(202))), [GH_JOBS]: ciJobs() });
    expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log: silentLog() }),
      new RegExp(`^${merged.slice(0, 12)} has no ci\\.yml push run`),
    );
    expect(run.sideEffects()).toEqual([]);
  });
});

describe("after-deploy steps: filed by prepare, opened as a checklist by publish (#5379)", () => {
  const step = (who, what, check) => `## Who\n\n${who}\n\n## What to do\n\n${what}\n\n## How to check it worked\n\n${check}\n`;
  const STUCK = step("owner", "Run `pnpm run xero:stuck-queued-report` once.", "It lists no rows, or you released the ones it listed.");
  const SPOT = step("officer", "Open the finance queue.", "The review settle box is gone.");
  const DEPLOY_FRAGMENTS = {
    "4400-a-fix.md": "- **A fix (#4400).** Body.\n",
    "5309-stuck-report.deploy.md": STUCK,
    "5275-finance-queue.deploy.md": SPOT,
  };
  const ISSUE_URL = "https://github.com/fixture-owner/fixture-repo/issues/77";
  const TITLE = "v0.13.3 post-deploy checklist";

  /** Finish the notes page as a maintainer would: write the overview, keep the after-deploy list. */
  function finishNotesKeepingSteps(repo, version) {
    const file = path.join(repo, "docs", "releases", `v${version}.md`);
    const stub = fs.readFileSync(file, "utf8");
    const steps = stub.slice(stub.indexOf("## After deploying this release"));
    fs.writeFileSync(file, `# Release v${version}\n\nWhat this release changes, written by a maintainer.\n\n${steps}`);
    git(repo, "commit", "-qam", `docs: write the v${version} release notes`);
  }

  function preparedFixture(fragments = DEPLOY_FRAGMENTS) {
    const fixture = makeFixture({ fragments });
    const plan = prepareRelease({ repoRoot: fixture.repo, execute: true, date: "2026-10-31", run: fixtureRunner(fixture.repo), log: silentLog() });
    return { ...fixture, plan };
  }

  function mergedDeployFixture(fragments = DEPLOY_FRAGMENTS) {
    const fixture = preparedFixture(fragments);
    finishNotesKeepingSteps(fixture.repo, fixture.plan.version);
    git(fixture.repo, "push", "-q", "origin", "HEAD:main");
    return { ...fixture, merged: git(fixture.repo, "rev-parse", "HEAD") };
  }

  /** A notes writer that keeps every file it was asked for, by name. */
  function namedWriter() {
    const dir = tempDir("release-bodies-");
    const written = {};
    const writeNotes = (name, text) => {
      const file = path.join(dir, `${name}.md`);
      fs.writeFileSync(file, text);
      written[name] = { file, text };
      return file;
    };
    writeNotes.written = written;
    return writeNotes;
  }

  const read = (repo, relative) => fs.readFileSync(path.join(repo, relative), "utf8");

  it("files the steps at the end of the release's upgrade section and in the notes stub, and deletes their fragments", () => {
    const { repo, plan } = preparedFixture();

    expect(plan.version).toBe("0.13.3");
    const guide = read(repo, "docs/UPGRADING.md");
    const section = guide.slice(guide.indexOf("## v0.13.2 → v0.13.3"), guide.indexOf("## v0.13.1 → v0.13.2"));
    expect(section).toMatch(/^## v0\.13\.2 → v0\.13\.3\n\n### Reconnect Xero once \(#4400\)[\s\S]*\n### After deploying this release\n\n.*\n\n<!-{2} deploy-steps:start -->\n/);
    expect(section).toContain(
      [
        "- [ ] **Officer:** Open the finance queue.",
        "",
        "  How to check it worked: The review settle box is gone.",
        "",
        "  From [#5275](https://github.com/fixture-owner/fixture-repo/pull/5275).",
        "",
        "- [ ] **Owner:** Run `pnpm run xero:stuck-queued-report` once.",
      ].join("\n"),
    );
    expect(section.trimEnd().endsWith("<!-- deploy-steps:end -->\n\n---")).toBe(true);
    const notes = read(repo, "docs/releases/v0.13.3.md");
    expect(notes).toContain(RELEASE_NOTES_UNFINISHED_MARKER);
    expect(notes).toMatch(/## After deploying this release\n\n.*\n\n<!-{2} deploy-steps:start -->\n- \[ \] \*\*Officer:\*\*/);
    expect(git(repo, "show", "--name-status", "--format=", "HEAD").split("\n")).toEqual(
      expect.arrayContaining(["D\tchangelog.d/5275-finance-queue.deploy.md", "D\tchangelog.d/5309-stuck-report.deploy.md"]),
    );
    expect(fs.readdirSync(path.join(repo, "changelog.d"))).toEqual(["README.md"]);
    expect(read(repo, "CHANGELOG.md")).not.toContain("finance queue");
  });

  it("links a lane-named step to the pull request whose merge brought it to main", () => {
    const { repo } = makeFixture();
    git(repo, "switch", "-q", "-c", "lane/alp-1");
    fs.writeFileSync(path.join(repo, "changelog.d", "alp-1-map-setting.deploy.md"), SPOT);
    git(repo, "add", "--all");
    git(repo, "commit", "-qm", "Add the step");
    git(repo, "switch", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #4600 from fixture-owner/lane/alp-1", "lane/alp-1");
    git(repo, "push", "-q", "origin", "main");
    git(repo, "branch", "-q", "-D", "lane/alp-1");

    prepareRelease({ repoRoot: repo, execute: true, date: "2026-10-31", run: fixtureRunner(repo), log: silentLog() });

    expect(read(repo, "docs/releases/v0.13.3.md")).toContain("  From [#4600](https://github.com/fixture-owner/fixture-repo/pull/4600).");
  });

  it("refuses a malformed step before switching branch or changing any file, dry run included", () => {
    const { repo } = makeFixture({ fragments: { ...DEPLOY_FRAGMENTS, "5310-bad.deploy.md": step("everyone", "Run it.", "It ran.") } });
    const before = snapshot(repo);

    for (const execute of [false, true]) {
      const run = fixtureRunner(repo);
      const error = expectRefusal(
        () => prepareRelease({ repoRoot: repo, execute, date: "2026-10-31", run, log: silentLog() }),
        /1 after-deploy step fragment\(s\) in changelog\.d\/ are malformed[\s\S]*5310-bad\.deploy\.md: .*one of owner, operator, officer/,
      );
      expect(error.recovery).toMatch(/^Nothing was changed/);
      expect(run.calls.some((call) => call.startsWith("git switch"))).toBe(false);
    }
    expect(snapshot(repo)).toEqual(before);
  });

  it("adds late steps after the filed ones on --amend, in the guide and the notes page", () => {
    const { repo, plan } = preparedFixture();
    finishNotesKeepingSteps(repo, plan.version);
    const prep = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "-q", "--detach", "origin/main");
    git(repo, "merge", "-q", "--no-ff", "-m", `Merge pull request #4501 from ${plan.branch}`, prep);
    fs.writeFileSync(path.join(repo, "changelog.d", "4700-late-check.deploy.md"), step("operator", "Watch one main run.", "It is green."));
    git(repo, "add", "--all");
    git(repo, "commit", "-qm", "Merge pull request #4700");
    git(repo, "push", "-q", "origin", "HEAD:main");

    prepareRelease({ repoRoot: repo, amend: true, execute: true, run: fixtureRunner(repo), log: silentLog() });

    expect(git(repo, "show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual([
      "D\tchangelog.d/4700-late-check.deploy.md",
      "M\tdocs/UPGRADING.md",
      "M\tdocs/releases/v0.13.3.md",
    ]);
    for (const relative of ["docs/UPGRADING.md", "docs/releases/v0.13.3.md"]) {
      const text = read(repo, relative);
      const order = ["**Officer:** Open the finance queue.", "**Owner:** Run `pnpm", "**Operator:** Watch one main run."].map((item) => text.indexOf(item));
      expect(order.every((at) => at > 0), relative).toBe(true);
      expect([...order].sort((a, b) => a - b), relative).toEqual(order);
      expect(text.match(/<!-{2} deploy-steps:start -->/g), relative).toHaveLength(1);
    }
    expect(read(repo, "docs/UPGRADING.md").match(/### After deploying this release/g)).toHaveLength(1);
  });

  it("keeps filed steps last when --amend folds only late upgrade steps, so none lands under the after-deploy heading", () => {
    const { repo, plan } = preparedFixture();
    finishNotesKeepingSteps(repo, plan.version);
    const prep = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "-q", "--detach", "origin/main");
    git(repo, "merge", "-q", "--no-ff", "-m", `Merge pull request #4501 from ${plan.branch}`, prep);
    const late = "### Run the pre-deploy check (#4610)\n\nRun it before deploying.";
    fs.writeFileSync(
      path.join(repo, "docs", "UPGRADING.md"),
      read(repo, "docs/UPGRADING.md").replace("## Unreleased\n\n", `## Unreleased\n\n${late}\n\n`),
    );
    git(repo, "add", "--all");
    git(repo, "commit", "-qm", "Merge pull request #4610");
    git(repo, "push", "-q", "origin", "HEAD:main");

    prepareRelease({ repoRoot: repo, amend: true, execute: true, run: fixtureRunner(repo), log: silentLog() });

    const guide = read(repo, "docs/UPGRADING.md");
    const section = guide.slice(guide.indexOf("## v0.13.2 → v0.13.3"), guide.indexOf("## v0.13.1 → v0.13.2"));
    const order = ["### Reconnect Xero once (#4400)", "### Run the pre-deploy check (#4610)", "### After deploying this release", "**Owner:** Run `pnpm"];
    const at = order.map((text) => section.indexOf(text));
    expect(at.every((index) => index > 0), section).toBe(true);
    expect([...at].sort((a, b) => a - b), section).toEqual(at);
    expect(section.match(/<!-{2} deploy-steps:start -->/g)).toHaveLength(1);
    expect(section.trimEnd().endsWith("<!-- deploy-steps:end -->\n\n---")).toBe(true);
  });

  it("opens the labelled checklist issue assigned to the repository's owner before the release, and the release body links it", () => {
    const { repo } = mergedDeployFixture();
    const run = fixtureRunner(repo, {
      [GH_CHECKLISTS]: json([
        { number: 12, title: "v0.13.2 post-deploy checklist", html_url: "https://github.com/x/y/issues/12" },
        { number: 13, title: TITLE, html_url: "https://github.com/x/y/pull/13", pull_request: {} },
      ]),
      "gh issue create": { status: 0, stdout: `${ISSUE_URL}\n`, stderr: "" },
    });
    const writeNotes = namedWriter();

    const result = publishRelease({ repoRoot: repo, execute: true, run, writeNotes, log: silentLog() });

    const checklistFile = writeNotes.written["v0.13.3-post-deploy-checklist"].file;
    const remote = run.calls.filter((call) => /^(git push|gh (issue create|release create))/.test(call));
    expect(remote).toEqual([
      "git push origin refs/tags/v0.13.3",
      `gh issue create --repo fixture-owner/fixture-repo --title ${TITLE} --body-file ${checklistFile} --label post-deploy-checklist --assignee fixture-owner`,
      expect.stringMatching(/^gh release create v0\.13\.3 /),
    ]);
    expect(run.calls.filter((call) => call.startsWith("gh label create"))).toEqual([
      expect.stringMatching(/^gh label create post-deploy-checklist --repo fixture-owner\/fixture-repo --force /),
    ]);
    const checklist = writeNotes.written["v0.13.3-post-deploy-checklist"].text;
    expect(checklist).toContain("- Release: https://github.com/fixture-owner/fixture-repo/releases/tag/v0.13.3");
    expect(checklist).toContain(
      "[docs/releases/v0.13.3.md](https://github.com/fixture-owner/fixture-repo/blob/v0.13.3/docs/releases/v0.13.3.md#after-deploying-this-release)",
    );
    expect(checklist.match(/^- \[ \] /gm)).toHaveLength(2);
    expect(checklist).toContain("From [#5309](https://github.com/fixture-owner/fixture-repo/pull/5309).");
    const body = fs.readFileSync(run.calls.find((call) => call.startsWith("gh release create")).split("--notes-file ")[1], "utf8");
    expect(body).toBe(
      `- **A fix (#4400).** Body.\n\n## After deploying this release\n\n2 step(s) to do once v0.13.3 is deployed: work through [the ${TITLE}](${ISSUE_URL}).\n`,
    );
    expect(result.checklist).toEqual({ url: ISSUE_URL });
  });

  it("reuses the checklist issue a previous run opened, and still checks it when the release already exists", () => {
    const { repo } = mergedDeployFixture();
    const existing = json([{ number: 77, title: TITLE, html_url: ISSUE_URL }]);
    const run = fixtureRunner(repo, { [GH_CHECKLISTS]: existing });
    const log = silentLog();

    publishRelease({ repoRoot: repo, execute: true, run, writeNotes: namedWriter(), log });

    expect(run.calls.some((call) => call.startsWith("gh issue create"))).toBe(false);
    expect(log.text()).toContain(`Post-deploy checklist: reusing ${ISSUE_URL}.`);

    git(repo, "push", "-q", "origin", "refs/tags/v0.13.3"); // the first run's push, which the runner only recorded
    const again = fixtureRunner(repo, {
      [GH_CHECKLISTS]: json([]),
      "gh issue create": { status: 0, stdout: `${ISSUE_URL}\n`, stderr: "" },
      "gh release view": { status: 0, stdout: "v0.13.3\n", stderr: "" },
    });
    const done = publishRelease({ repoRoot: repo, execute: true, run: again, writeNotes: namedWriter(), log: silentLog() });
    expect(done.state).toBe("published");
    expect(again.calls.filter((call) => call.startsWith("gh issue create"))).toHaveLength(1);
    expect(again.calls.some((call) => call.startsWith("gh release create"))).toBe(false);
  });

  it("still publishes when the issue cannot be opened, printing the command and linking the notes page instead", () => {
    const { repo } = mergedDeployFixture();
    const run = fixtureRunner(repo, {
      [GH_CHECKLISTS]: json([]),
      "gh issue create": { status: 1, stdout: "", stderr: "could not assign fixture-owner" },
    });
    const writeNotes = namedWriter();
    const log = silentLog();

    const result = publishRelease({ repoRoot: repo, execute: true, run, writeNotes, log });

    expect(result).toMatchObject({ executed: true, checklist: { url: null } });
    const checklistFile = writeNotes.written["v0.13.3-post-deploy-checklist"].file;
    expect(log.text()).toContain(`The "${TITLE}" issue was NOT opened: gh issue create failed: could not assign fixture-owner.`);
    expect(log.text()).toContain(
      `gh issue create --repo fixture-owner/fixture-repo --title "${TITLE}" --body-file ${checklistFile} --label post-deploy-checklist --assignee fixture-owner`,
    );
    expect(writeNotes.written["v0.13.3"].text).toContain(
      "work through [the list in this release's notes page](https://github.com/fixture-owner/fixture-repo/blob/v0.13.3/docs/releases/v0.13.3.md#after-deploying-this-release).",
    );
    expect(run.calls.some((call) => call.startsWith("gh release create"))).toBe(true);
  });

  it("prints the checklist's title and body in a dry run and opens nothing", () => {
    const { repo } = mergedDeployFixture();
    const run = fixtureRunner(repo, { [GH_CHECKLISTS]: json([]) });
    const log = silentLog();

    publishRelease({ repoRoot: repo, run, log });

    expect(log.text()).toContain(
      `Post-deploy checklist: would open "${TITLE}", labelled post-deploy-checklist and assigned to fixture-owner, with this body:`,
    );
    expect(log.text()).toContain("assigned to fixture-owner (the owner of fixture-owner/fixture-repo)");
    expect(log.text()).toContain("    | - [ ] **Owner:** Run `pnpm run xero:stuck-queued-report` once.");
    expect(run.calls.some((call) => /^gh (issue create|release create)/.test(call))).toBe(false);
  });

  it("opens no issue for a release without after-deploy steps", () => {
    const { repo } = mergedReleaseFixture();
    const run = fixtureRunner(repo);
    const log = silentLog();

    publishRelease({ repoRoot: repo, execute: true, run, writeNotes: notesWriter(), log });

    expect(run.calls.some((call) => call.startsWith("gh issue"))).toBe(false);
    expect(log.text()).toContain("Post-deploy checklist: none");
  });

  it.each([
    ["--checklist-assignee when given", { checklistAssignee: "club-secretary" }, {}, "club-secretary", "(--checklist-assignee)"],
    [
      "@me, saying why, when an organisation owns the repository",
      {},
      { [GH_OWNER_TYPE]: { status: 0, stdout: "Organization\n", stderr: "" } },
      "@me",
      "fixture-owner, which is not a person's account",
    ],
    [
      "@me, saying why, when GitHub cannot say who owns it",
      {},
      { [GH_OWNER_TYPE]: { status: 1, stdout: "", stderr: "HTTP 401" } },
      "@me",
      "gh could not say whether fixture-owner is a person's account",
    ],
  ])("assigns the checklist issue to %s", (_case, options, stubs, login, why) => {
    const { repo } = mergedDeployFixture();
    const created = { status: 0, stdout: `${ISSUE_URL}\n`, stderr: "" };
    const run = fixtureRunner(repo, { [GH_CHECKLISTS]: json([]), "gh issue create": created, ...stubs });
    const log = silentLog();

    publishRelease({ repoRoot: repo, execute: true, run, writeNotes: namedWriter(), log, ...options });

    expect(run.calls.find((call) => call.startsWith("gh issue create"))).toMatch(new RegExp(` --assignee ${login}$`));
    expect(log.text()).toContain(why);
    expect(run.calls.some((call) => call.startsWith(GH_OWNER_TYPE))).toBe(!options.checklistAssignee);
  });

  it("opens no issue when the label cannot be made, and prints both commands", () => {
    const { repo } = mergedDeployFixture();
    const run = fixtureRunner(repo, {
      [GH_CHECKLISTS]: json([]),
      "gh label create": { status: 1, stdout: "", stderr: "HTTP 403" },
    });
    const writeNotes = namedWriter();
    const log = silentLog();

    const result = publishRelease({ repoRoot: repo, execute: true, run, writeNotes, log });

    expect(result).toMatchObject({ executed: true, checklist: { url: null } });
    expect(run.calls.some((call) => call.startsWith("gh issue create"))).toBe(false);
    expect(log.text()).toContain(`The "${TITLE}" issue was NOT opened: gh label create failed: HTTP 403.`);
    expect(log.text()).toMatch(/!! {3}gh label create post-deploy-checklist /);
    expect(log.text()).toMatch(/!! {3}gh issue create .* --label post-deploy-checklist --assignee fixture-owner/);
    expect(run.calls.some((call) => call.startsWith("gh release create"))).toBe(true);
  });

  it("refuses a deploy step that merged after the release-prep commit, like any late fragment", () => {
    const { repo } = mergedReleaseFixture();
    fs.writeFileSync(path.join(repo, "changelog.d", "4800-late.deploy.md"), SPOT);
    git(repo, "add", "--all");
    git(repo, "commit", "-qm", "Merge pull request #4800");
    git(repo, "push", "-q", "origin", "HEAD:main");

    expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /holds 1 fragment\(s\) that merged after the release-prep commit \(4800-late\.deploy\.md\)/,
    );
  });
});
