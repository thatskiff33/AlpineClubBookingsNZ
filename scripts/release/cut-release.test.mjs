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
  parseArgs,
  prepareRelease,
  publishRelease,
  ReleaseCutError,
} from "./cut-release.mjs";
import { releaseSection } from "./compile-changelog.mjs";

// Every test runs against a throwaway fixture: a bare "origin" and a clone of
// it. `git push` and `gh` are never run for real — the runner below records
// them and answers on their behalf.

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
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
 * clean clone of it with `origin/main` fetched. Returns `{ origin, repo }`.
 */
function makeFixture({ fragments = { "4400-a-fix.md": "- **A fix (#4400).** Body.\n" }, tags = ["v0.13.2"] } = {}) {
  const origin = path.join(tempDir("release-cut-origin-"), "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = tempDir("release-cut-seed-");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  configure(seed);
  fs.writeFileSync(path.join(seed, "CHANGELOG.md"), CHANGELOG);
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
  return { origin, repo };
}

/**
 * Real git in the fixture, except that `git push` and every `gh` call are
 * recorded and answered from `stubs` (default: success). `calls` holds every
 * command in the order it ran.
 */
function fixtureRunner(cwd, stubs = {}) {
  const calls = [];
  const run = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    if (command === "gh" || (command === "git" && args[0] === "push")) {
      const key = Object.keys(stubs).find((prefix) => line.startsWith(prefix));
      return key ? stubs[key] : { status: 0, stdout: "", stderr: "" };
    }
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  run.calls = calls;
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
    expect(() => parseArgs(["prepare", "--commit", "abc"])).toThrow(/belongs to publish/);
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

describe("package.json and section helpers", () => {
  it("rewrites only the top-level version and keeps the formatting", () => {
    const next = bumpPackageJson(PACKAGE_JSON, "0.14.0");
    expect(next).toBe(PACKAGE_JSON.replace('"version": "0.13.2"', '"version": "0.14.0"'));
  });

  it("refuses a package.json whose first version key is not the top-level one", () => {
    const nested = `{\n  "engines": {\n    "version": "x"\n  },\n  "version": "0.13.2"\n}\n`;
    expect(() => bumpPackageJson(nested, "0.14.0")).toThrow(/Could not rewrite/);
  });

  it("reads one compiled section without its heading or its neighbours", () => {
    const text = "## Unreleased\n\n## 0.14.0 - 2026-10-31\n\n- **New (#1).**\n  More.\n\n## 0.13.2 - 2026-07-23\n\n- **Old.**\n";
    expect(releaseSection(text, "0.14.0")).toBe("- **New (#1).**\n  More.");
    expect(releaseSection(text, "0.13.2")).toBe("- **Old.**");
    expect(releaseSection(text, "0.14")).toBeNull();
    expect(releaseSection(text, "0.15.0")).toBeNull();
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
    expect(releaseSection(changelog, "0.13.3")).toBe("- **A fix (#4400).** Body.");
    expect(git(repo, "show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual([
      "D\tchangelog.d/4400-a-fix.md",
      "D\tsize-allowances.d/4300-spent.md",
      "M\tCHANGELOG.md",
      "M\tpackage.json",
    ]);
    expect(run.calls.some((call) => call.startsWith("git push") || call.startsWith("gh "))).toBe(false);
    expect(git(origin, "branch", "--list")).toBe("* main");
    expect(git(repo, "tag", "--list")).toBe("v0.13.2");
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

  it("refuses when the release-prep branch already exists", () => {
    const { repo } = makeFixture();
    git(repo, "branch", "release/v0.13.3");
    expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /Branch release\/v0\.13\.3 already exists locally/,
    );
  });

  it("refuses a tag that exists only on the remote", () => {
    const { repo } = makeFixture();
    const run = fixtureRunner(repo);
    const remoteOnly = (command, args) =>
      command === "git" && args[0] === "ls-remote"
        ? { status: 0, stdout: "0123456789abcdef\trefs/tags/v0.13.3\n", stderr: "" }
        : run(command, args);
    expectRefusal(
      () => prepareRelease({ repoRoot: repo, run: remoteOnly, log: silentLog() }),
      /origin already has refs\/tags\/v0\.13\.3/,
    );
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

/** A fixture whose release-prep commit has merged to origin/main. */
function mergedReleaseFixture() {
  const fixture = makeFixture();
  prepareRelease({ repoRoot: fixture.repo, execute: true, date: "2026-10-31", run: fixtureRunner(fixture.repo), log: silentLog() });
  git(fixture.repo, "push", "-q", "origin", "HEAD:main"); // stands in for merging the release-prep PR
  return { ...fixture, merged: git(fixture.repo, "rev-parse", "HEAD") };
}

describe("release:cut publish on a fixture repository", () => {
  it("prints the plan in a dry run and creates nothing", () => {
    const { repo, merged } = mergedReleaseFixture();
    const run = fixtureRunner(repo);
    const log = silentLog();

    const result = publishRelease({ repoRoot: repo, run, log });

    expect(result).toMatchObject({ executed: false, tag: "v0.13.3", commit: merged });
    expect(result.notes).toBe("- **A fix (#4400).** Body.");
    const text = log.text();
    expect(text).toContain("Publish v0.13.3 (dry run");
    expect(text).toContain(`Commit: ${merged} (on origin/main); previous release tag: v0.13.2`);
    expect(text).toContain("3. git push origin refs/tags/v0.13.3");
    expect(text).toContain("4. gh release create v0.13.3 --verify-tag --title v0.13.3 --notes-file <section>");
    expect(text).toContain("DEPLOY_REF=v0.13.3 ./scripts/run-production-blue-green-deploy.sh");
    expect(git(repo, "tag", "--list")).toBe("v0.13.2");
    expect(run.calls.some((call) => call.startsWith("git push") || call.startsWith("gh ") || call.startsWith("git tag -a"))).toBe(false);
  });

  it("tags the merged commit, then pushes the tag, then publishes, in that order", () => {
    const { repo, merged } = mergedReleaseFixture();
    const run = fixtureRunner(repo);
    const notesFile = path.join(tempDir("release-notes-"), "v0.13.3.md");
    const writeNotes = (tag, text) => {
      fs.writeFileSync(notesFile, text);
      return notesFile;
    };

    publishRelease({ repoRoot: repo, execute: true, run, writeNotes, log: silentLog() });

    const sideEffects = run.calls.filter((call) => /^(git (tag -a|push)|gh )/.test(call));
    expect(sideEffects).toEqual([
      "gh auth status",
      `git tag -a v0.13.3 -m fixture-club-app v0.13.3\n\nRelease notes: the "## 0.13.3" section of CHANGELOG.md. ${merged}`,
      "git push origin refs/tags/v0.13.3",
      `gh release create v0.13.3 --verify-tag --title v0.13.3 --notes-file ${notesFile}`,
    ]);
    // Every precondition read ran before the first side effect.
    const firstSideEffect = run.calls.indexOf("gh auth status");
    expect(run.calls.slice(0, firstSideEffect)).toEqual(
      expect.arrayContaining(["git fetch --tags origin main", "git ls-remote origin refs/tags/v0.13.3"]),
    );
    expect(git(repo, "cat-file", "-t", "v0.13.3")).toBe("tag"); // annotated
    expect(git(repo, "rev-parse", "v0.13.3^{commit}")).toBe(merged);
    expect(fs.readFileSync(notesFile, "utf8")).toBe("- **A fix (#4400).** Body.\n");
  });

  it("refuses a commit that is not on origin/main", () => {
    const { repo } = makeFixture();
    prepareRelease({ repoRoot: repo, execute: true, date: "2026-10-31", run: fixtureRunner(repo), log: silentLog() });
    const unmerged = git(repo, "rev-parse", "HEAD");
    expectRefusal(
      () => publishRelease({ repoRoot: repo, commit: unmerged, run: fixtureRunner(repo), log: silentLog() }),
      /is not on origin\/main.*merge the release-prep pull request first/,
    );
  });

  it("refuses a version that is not newer than the latest tag", () => {
    const { repo } = makeFixture({ fragments: {} });
    expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /v0\.13\.2 is not newer than the latest release tag v0\.13\.2/,
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

  it("refuses to tag a later main that carries unreleased fragments, and names --commit", () => {
    const { repo, merged } = mergedReleaseFixture();
    fs.writeFileSync(path.join(repo, "changelog.d", "4500-later.md"), "- **Later (#4500).**\n");
    git(repo, "add", "--all");
    git(repo, "commit", "-qm", "merged after the release");
    git(repo, "push", "-q", "origin", "HEAD:main");

    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /still holds 1 unreleased fragment\(s\) \(4500-later\.md\)/,
    );
    expect(error.recovery).toContain("pnpm run release:cut publish --commit <merge-sha>");
    expect(publishRelease({ repoRoot: repo, commit: merged, run: fixtureRunner(repo), log: silentLog() }).tag).toBe("v0.13.3");
  });

  it("refuses a tag that already exists", () => {
    const { repo, merged } = mergedReleaseFixture();
    git(repo, "tag", "-a", "v0.13.3", "-m", "by hand", merged);
    expectRefusal(
      () => publishRelease({ repoRoot: repo, run: fixtureRunner(repo), log: silentLog() }),
      /not newer than the latest release tag v0\.13\.3/,
    );
  });

  it("creates nothing when gh is not signed in", () => {
    const { repo } = mergedReleaseFixture();
    const run = fixtureRunner(repo, { "gh auth status": { status: 1, stdout: "", stderr: "not logged in" } });
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: () => "/notes.md", log: silentLog() }),
      /`gh auth status` failed:\nnot logged in/,
    );
    expect(error.recovery).toContain("Nothing was created");
    expect(git(repo, "tag", "--list")).toBe("v0.13.2");
  });

  it("keeps the local tag and prints the retry when the tag push fails", () => {
    const { repo } = mergedReleaseFixture();
    const run = fixtureRunner(repo, { "git push": { status: 1, stdout: "", stderr: "rejected" } });
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: () => "/tmp/n/v0.13.3.md", log: silentLog() }),
      /`git push origin refs\/tags\/v0\.13\.3` failed:\nrejected/,
    );
    expect(error.recovery).toContain("exists locally but was NOT pushed");
    expect(error.recovery).toContain(
      "Retry: git push origin refs/tags/v0.13.3 && gh release create v0.13.3 --verify-tag --title v0.13.3 --notes-file /tmp/n/v0.13.3.md",
    );
    expect(error.recovery).toContain("Or discard it: git tag -d v0.13.3");
    expect(run.calls.some((call) => call.startsWith("gh release"))).toBe(false);
    expect(git(repo, "tag", "--list", "v0.13.3")).toBe("v0.13.3");
  });

  it("never deletes a pushed tag when publishing the release fails", () => {
    const { repo } = mergedReleaseFixture();
    const run = fixtureRunner(repo, { "gh release": { status: 1, stdout: "", stderr: "HTTP 502" } });
    const error = expectRefusal(
      () => publishRelease({ repoRoot: repo, execute: true, run, writeNotes: () => "/tmp/n/v0.13.3.md", log: silentLog() }),
      /`gh release create v0\.13\.3 .*` failed:\nHTTP 502/,
    );
    expect(error.recovery).toContain("Tag v0.13.3 IS pushed, but the GitHub release was NOT published");
    expect(error.recovery).toContain("Retry: gh release create v0.13.3 --verify-tag --title v0.13.3 --notes-file /tmp/n/v0.13.3.md");
    expect(run.calls.filter((call) => call.startsWith("git tag -d") || call.startsWith("git push --delete"))).toEqual([]);
    expect(git(repo, "tag", "--list", "v0.13.3")).toBe("v0.13.3");
  });
});
