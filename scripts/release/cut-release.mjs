#!/usr/bin/env node
/**
 * Cut a tagged public release (issue #4465): `pnpm run release:cut`.
 *
 * `main` is protected and only moves through pull requests, so a release is
 * cut in two phases with a pull request between them — the same order v0.13.2
 * was cut in (`release/v0.13.2` → PR #2225 → annotated tag on its merge commit):
 *
 *   pnpm run release:cut prepare [--bump patch|minor|major] [--date YYYY-MM-DD] [--execute]
 *     From a clean checkout of a freshly fetched `origin/main`: works out the
 *     next version from origin's tags, creates `release/v<version>`, bumps
 *     `package.json`, folds `changelog.d/` into `CHANGELOG.md` with
 *     `compile-changelog.mjs`, and commits. It never pushes.
 *
 *   pnpm run release:cut prepare --amend [--execute]
 *     When fragments merged while the release-prep pull request was open: from
 *     a fresh `origin/main`, creates `release/v<version>-late` and appends them
 *     to the existing, untagged `## <version>` section.
 *
 *   pnpm run release:cut publish [--commit <sha>] [--carry-late-fragments] [--execute]
 *     After the pull request merges: tags the merged commit (default
 *     `origin/main`, always one CI built an image for), pushes the tag, and
 *     publishes the GitHub release on the repository `origin` names. A re-run
 *     after a partial failure resumes where it stopped.
 *
 * Both phases print the whole plan and change nothing unless `--execute` is
 * given. With `--execute`, local steps run first and remote ones (tag push,
 * `gh release create`) only after every local step succeeded; a failure part
 * way stops with the exact commands to recover or retry.
 *
 * The version is the latest `vX.Y.Z` tag on origin plus a bump chosen from the
 * fragment types (`changelog.d/README.md`, "Patch or minor"): any
 * `*.feature.md` fragment makes it a minor release, otherwise a patch.
 * `--bump` overrides it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { ALLOWANCE_DIR } from "../lib/allowance-dir.mjs";
import {
  classifyUnreleased,
  compileChangelog,
  DATE_PATTERN,
  FRAGMENTS_DIRNAME,
  isFragmentName,
  MAIN_REF,
  readFragments,
  releaseHeading,
  releaseSection,
  todayInNewZealand,
} from "./compile-changelog.mjs";

const REPO_ROOT = path.resolve(path.join(import.meta.dirname, "..", ".."));

/** A fragment whose filename ends in this marks a feature: the release is minor. */
export const FEATURE_FRAGMENT_SUFFIX = ".feature.md";

/**
 * Longest release body published as-is. GitHub refuses a release body over
 * 125,000 characters; a section longer than this is published as a short
 * body that links to the section in CHANGELOG.md at the tag instead.
 */
export const MAX_RELEASE_NOTES_CHARS = 120_000;

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUMPS = ["patch", "minor", "major"];
const [REMOTE, MAIN_BRANCH] = MAIN_REF.split("/");
const MAIN_TRACKING_REF = `refs/remotes/${MAIN_REF}`;

/** A refusal or a partial failure, carrying the operator's recovery text. */
export class ReleaseCutError extends Error {
  constructor(message, recovery = "") {
    super(message);
    this.name = "ReleaseCutError";
    this.recovery = recovery;
  }
}

/** `{ major, minor, patch }` for a strict `vX.Y.Z` tag, or `null`. */
export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(String(tag).trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareParts(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function formatParts({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/** The highest strict `vX.Y.Z` tag in `tags` by version (not by date), or `null`. */
export function latestReleaseTag(tags) {
  let best = null;
  for (const tag of tags) {
    const parts = parseReleaseTag(tag);
    if (parts && (best === null || compareParts(parts, best.parts) > 0)) {
      best = { tag: tag.trim(), parts, version: formatParts(parts) };
    }
  }
  return best;
}

/** The bump that took `from` (`{ major, minor, patch }` or `null`) to `to`. */
export function releaseBump(from, to) {
  const base = from ?? { major: 0, minor: 0, patch: 0 };
  if (to.major !== base.major) return "major";
  if (to.minor !== base.minor) return "minor";
  return "patch";
}

/** The bump the fragment types call for: minor when any fragment is a feature. */
export function fragmentBump(fragmentNames) {
  const features = fragmentNames.filter((name) => name.toLowerCase().endsWith(FEATURE_FRAGMENT_SUFFIX));
  return {
    bump: features.length > 0 ? "minor" : "patch",
    features,
  };
}

/** Apply `bump` to `version` (`X.Y.Z`); a missing previous version starts at 0.0.0. */
export function bumpVersion(version, bump) {
  const parts = version ? parseReleaseTag(`v${version}`) : { major: 0, minor: 0, patch: 0 };
  if (!parts) throw new ReleaseCutError(`Not a release version: ${version}`);
  if (bump === "major") return formatParts({ major: parts.major + 1, minor: 0, patch: 0 });
  if (bump === "minor") return formatParts({ major: parts.major, minor: parts.minor + 1, patch: 0 });
  if (bump === "patch") return formatParts({ ...parts, patch: parts.patch + 1 });
  throw new ReleaseCutError(`--bump must be one of ${BUMPS.join(", ")}, got: ${bump}`);
}

/**
 * Pure version plan: the previous tag, the suggested bump from the fragments,
 * the bump actually used (`override` wins), and the resulting version and tag.
 */
export function computeRelease({ tags, fragmentNames, override = null }) {
  const previous = latestReleaseTag(tags);
  const suggested = fragmentBump(fragmentNames);
  const bump = override ?? suggested.bump;
  const version = bumpVersion(previous?.version ?? null, bump);
  return {
    previousTag: previous?.tag ?? null,
    suggestedBump: suggested.bump,
    featureFragments: suggested.features,
    bump,
    overridden: override !== null && override !== suggested.bump,
    version,
    tag: `v${version}`,
    branch: `release/v${version}`,
  };
}

/**
 * `{ host, owner, name }` for a GitHub remote URL — https (with or without
 * credentials), scp-style `git@host:owner/name` or `ssh://` — or `null`.
 */
export function parseGitHubRemote(url) {
  const text = String(url ?? "").trim();
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(text) ??
    /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(text);
  if (!match || !match[1].includes(".")) return null;
  const host = match[1].toLowerCase().replace(/^www\.github\.com$/, "github.com");
  return { host, owner: match[2], name: match[3] };
}

/** `url` with any `user:password@` / `token@` credentials replaced, safe to print. */
export function redactUrl(url) {
  return String(url ?? "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1***@");
}

/** The anchor GitHub gives a Markdown heading (lower case, punctuation dropped, spaces to hyphens). */
export function githubHeadingAnchor(heading) {
  return heading
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * The GitHub release body for a section: the section itself, or — over
 * `MAX_RELEASE_NOTES_CHARS` — a short body with the entry count and a link to
 * the section in CHANGELOG.md at the tag.
 */
export function releaseBody({ section, tag, repo }) {
  if (section.body.length <= MAX_RELEASE_NOTES_CHARS) {
    return { kind: "full", text: `${section.body}\n` };
  }
  const entries = section.body.split("\n").filter((line) => line.startsWith("- ")).length;
  const url = `https://${repo.host}/${repo.owner}/${repo.name}/blob/${tag}/CHANGELOG.md#${githubHeadingAnchor(section.heading)}`;
  return {
    kind: "short",
    entries,
    text:
      `**${tag}** has ${entries} changelog entries — more than a GitHub release can hold.\n\n` +
      `Read them in [CHANGELOG.md](${url}).\n`,
  };
}

/** Parse argv into `{ phase, execute, bump, date, commit, amend, carryLateFragments }`. */
export function parseArgs(argv) {
  const options = {
    phase: null,
    execute: false,
    dryRun: false,
    bump: null,
    date: null,
    commit: null,
    amend: false,
    carryLateFragments: false,
  };
  const flags = { "--execute": "execute", "--dry-run": "dryRun", "--amend": "amend", "--carry-late-fragments": "carryLateFragments" };
  const takesValue = { "--bump": "bump", "--date": "date", "--commit": "commit" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (flags[arg]) options[flags[arg]] = true;
    else if (takesValue[arg]) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new ReleaseCutError(`${arg} needs a value.`);
      options[takesValue[arg]] = value;
      i += 1;
    } else if (arg.startsWith("--")) throw new ReleaseCutError(`Unknown option: ${arg}`);
    else if (options.phase === null) options.phase = arg;
    else throw new ReleaseCutError(`Unexpected argument: ${arg}`);
  }
  if (options.phase !== "prepare" && options.phase !== "publish") {
    throw new ReleaseCutError(`Name a phase: "prepare" or "publish" (got: ${options.phase ?? "nothing"}).`);
  }
  if (options.execute && options.dryRun) throw new ReleaseCutError("--execute and --dry-run contradict each other.");
  if (options.bump !== null && !BUMPS.includes(options.bump)) {
    throw new ReleaseCutError(`--bump must be one of ${BUMPS.join(", ")}, got: ${options.bump}`);
  }
  if (options.date !== null && !DATE_PATTERN.test(options.date)) {
    throw new ReleaseCutError(`--date must be YYYY-MM-DD, got: ${options.date}`);
  }
  if (options.phase === "prepare" && (options.commit !== null || options.carryLateFragments)) {
    throw new ReleaseCutError("--commit and --carry-late-fragments belong to publish.");
  }
  if (options.amend && (options.bump !== null || options.date !== null)) {
    throw new ReleaseCutError("--amend keeps the prepared version and date; drop --bump and --date.");
  }
  if (options.phase === "publish" && (options.bump !== null || options.date !== null || options.amend)) {
    throw new ReleaseCutError("--bump, --date and --amend belong to prepare; publish reads the version from the merged commit.");
  }
  return options;
}

/** Default process runner: captures output, never throws on a non-zero exit. */
function defaultRun(repoRoot) {
  return (command, args) => {
    const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (result.error?.code === "ENOENT") {
      return { status: 127, stdout: "", stderr: `${command} is not on PATH.` };
    }
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

function display(command, args) {
  return [command, ...args.map((arg) => (/^[\w./:=@^{}+-]+$/.test(arg) ? arg : JSON.stringify(arg)))].join(" ");
}

/** Wrap a runner so callers can require success, test a status, or read stdout. */
function commands(run) {
  const call = (command, args) => run(command, args);
  const must = (command, args, recovery = "") => {
    const result = call(command, args);
    if (result.status !== 0) {
      const detail = `${result.stderr}${result.stdout}`.trim();
      throw new ReleaseCutError(`\`${display(command, args)}\` failed${detail ? `:\n${detail}` : "."}`, recovery);
    }
    return result.stdout.trim();
  };
  return {
    git: (args, recovery) => must("git", args, recovery),
    gitOk: (args) => call("git", args).status === 0,
    gh: (args, recovery) => must("gh", args, recovery),
    ghOk: (args) => call("gh", args).status === 0,
    run: call,
  };
}

/** Fetch `main` by an explicit refspec (no tags), then return its commit. */
function refreshMain(cmd) {
  cmd.git(["fetch", "--no-tags", REMOTE, `+refs/heads/${MAIN_BRANCH}:${MAIN_TRACKING_REF}`]);
  return cmd.git(["rev-parse", "--verify", `${MAIN_TRACKING_REF}^{commit}`]);
}

/** Release tags as origin has them — never this clone's local tags. */
function remoteReleaseTags(cmd) {
  return cmd
    .git(["ls-remote", "--tags", "--refs", REMOTE, "refs/tags/v*"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1].replace(/^refs\/tags\//, ""));
}

/** The commit origin's `tag` points at (peeled), or `null` when origin has no such tag. */
function remoteTagCommit(cmd, tag) {
  const lines = cmd.git(["ls-remote", "--tags", REMOTE, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  return (peeled ?? lines[0]).split(/\s+/)[0];
}

/** The commit this clone's `tag` points at, or `null`. */
function localTagCommit(cmd, tag) {
  return cmd.gitOk(["rev-parse", "-q", "--verify", `refs/tags/${tag}`])
    ? cmd.git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`])
    : null;
}

function configValues(cmd, key) {
  const result = cmd.run("git", ["config", "--get-all", key]);
  return result.status === 0 ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

const repoSlug = (repo) => (repo.host === "github.com" ? `${repo.owner}/${repo.name}` : `${repo.host}/${repo.owner}/${repo.name}`);

/**
 * The GitHub repository the tag is pushed to: `origin`'s push URL(s), or its
 * URL when none is set. Read as configured (before `insteadOf` rewrites), and
 * refused when the push and fetch URLs name different repositories — the
 * release would land beside a tag that was pushed somewhere else.
 */
function originRepository(cmd) {
  const fetchUrls = configValues(cmd, `remote.${REMOTE}.url`);
  const pushUrls = configValues(cmd, `remote.${REMOTE}.pushurl`);
  const urls = [...(pushUrls.length > 0 ? pushUrls : fetchUrls), ...fetchUrls];
  if (urls.length === 0) throw new ReleaseCutError(`There is no "${REMOTE}" remote.`);
  const repos = urls.map((url) => {
    const repo = parseGitHubRemote(url);
    if (!repo) {
      throw new ReleaseCutError(
        `${REMOTE}'s URL is not a GitHub repository URL: ${redactUrl(url)}`,
        `Point ${REMOTE} at the GitHub repository the release belongs to.`,
      );
    }
    return { ...repo, slug: repoSlug(repo) };
  });
  const differ = repos.find((repo) => repo.slug.toLowerCase() !== repos[0].slug.toLowerCase());
  if (differ) {
    throw new ReleaseCutError(
      `${REMOTE}'s push and fetch URLs name different repositories (${repos[0].slug} and ${differ.slug}).`,
      `Make remote.${REMOTE}.pushurl and remote.${REMOTE}.url name the same repository, then re-run.`,
    );
  }
  return repos[0];
}

/** Refuse when `branch` exists here or on origin. */
function refuseExistingBranch(cmd, branch) {
  if (cmd.gitOk(["rev-parse", "-q", "--verify", `refs/heads/${branch}`])) {
    throw new ReleaseCutError(`Branch ${branch} already exists locally; finish or delete that release-prep branch first.`);
  }
  if (cmd.git(["ls-remote", "--heads", REMOTE, `refs/heads/${branch}`]) !== "") {
    throw new ReleaseCutError(`${REMOTE} already has branch ${branch}; finish or delete that release-prep branch first.`);
  }
}

/** Replace the top-level `"version"` in package.json text, keeping its formatting. */
export function bumpPackageJson(text, version) {
  const before = JSON.parse(text);
  const next = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
  const after = JSON.parse(next);
  if (after.version !== version || JSON.stringify({ ...before, version }) !== JSON.stringify(after)) {
    throw new ReleaseCutError(`Could not rewrite the top-level "version" in package.json to ${version}.`);
  }
  return next;
}

/** Clean tree, fresh `origin/main`, HEAD exactly there; returns the main commit. */
function requireFreshMainCheckout(cmd) {
  const dirty = cmd.git(["status", "--porcelain", "--untracked-files=all"]);
  if (dirty !== "") {
    throw new ReleaseCutError(
      `The working tree is not clean; commit, move or delete these first (an untracked changelog.d/ draft would be released):\n${dirty}`,
    );
  }
  const main = refreshMain(cmd);
  const head = cmd.git(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head !== main) {
    const behind = cmd.gitOk(["merge-base", "--is-ancestor", head, main]);
    throw new ReleaseCutError(
      behind
        ? `HEAD (${head.slice(0, 12)}) is behind ${MAIN_REF} (${main.slice(0, 12)}): the base is stale.`
        : `HEAD (${head.slice(0, 12)}) carries commits that are not on ${MAIN_REF} (${main.slice(0, 12)}).`,
      `Start release prep from ${MAIN_REF} itself: git switch --detach ${MAIN_REF}`,
    );
  }
  return main;
}

/**
 * Phase 1: build the release-prep commit locally (or, with `amend`, the
 * late-fragment fold into a prepared, untagged release).
 */
export function prepareRelease({
  repoRoot = REPO_ROOT,
  execute = false,
  bump = null,
  amend = false,
  date = todayInNewZealand(),
  run = defaultRun(repoRoot),
  compile = compileChangelog,
  log = console.log,
} = {}) {
  const cmd = commands(run);
  const main = requireFreshMainCheckout(cmd);

  const fragmentNames = readFragments(path.join(repoRoot, FRAGMENTS_DIRNAME)).map((fragment) => fragment.name);
  const remoteTags = remoteReleaseTags(cmd);
  const packagePath = path.join(repoRoot, "package.json");
  const packageText = fs.readFileSync(packagePath, "utf8");
  const packageVersion = JSON.parse(packageText).version;
  const changelogText = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const latest = latestReleaseTag(remoteTags);
  const packageParts = parseReleaseTag(`v${packageVersion}`);
  // A release prepared and merged but not yet tagged: package.json is ahead of
  // origin's latest tag and CHANGELOG.md already has that version's section.
  const pendingRelease =
    packageParts !== null &&
    (latest === null || compareParts(packageParts, latest.parts) > 0) &&
    releaseSection(changelogText, packageVersion) !== null;

  let plan;
  let nextPackageText = null;
  if (amend) {
    const tag = `v${packageVersion}`;
    if (!packageParts) throw new ReleaseCutError(`package.json has no X.Y.Z version: ${packageVersion}`);
    if (remoteTags.includes(tag)) {
      throw new ReleaseCutError(
        `${tag} is already released on ${REMOTE}, so there is no untagged release to amend.`,
        "Late fragments go into the next release: pnpm run release:cut prepare",
      );
    }
    const section = releaseSection(changelogText, packageVersion);
    if (section === null) {
      throw new ReleaseCutError(
        `CHANGELOG.md has no "## ${packageVersion}" section: nothing was prepared to amend.`,
        "Prepare the release first: pnpm run release:cut prepare",
      );
    }
    // A late feature cannot ride in a patch release: the version would understate it.
    const preparedBump = releaseBump(latest?.parts ?? null, packageParts);
    const late = fragmentBump(fragmentNames);
    if (late.bump === "minor" && preparedBump === "patch") {
      throw new ReleaseCutError(
        `${tag} was prepared as a patch release, but late fragment(s) ${late.features.join(", ")} are features, which need a minor release.`,
        [
          `Either carry them into the next release: publish ${tag} with pnpm run release:cut publish --carry-late-fragments --execute`,
          `Or re-prepare as a minor release: revert the release-prep pull request's merge (its fragments come back),`,
          `  merge the revert, then run pnpm run release:cut prepare --execute from a fresh ${MAIN_REF}`,
        ].join("\n"),
      );
    }
    plan = { version: packageVersion, tag, branch: `release/${tag}-late`, heading: section.heading };
    log(`Late-fragment fold into ${tag} (${execute ? "EXECUTE" : "dry run — nothing is changed"})`);
    log(`  Base: ${MAIN_REF} ${main.slice(0, 12)}; appending to "${section.heading}"`);
  } else {
    if (pendingRelease) {
      throw new ReleaseCutError(
        `v${packageVersion} is prepared but not tagged: package.json is ahead of ${REMOTE}'s latest tag ` +
          `(${latest?.tag ?? "none"}) and CHANGELOG.md has its section. A new prepare would plan a version below it.`,
        [
          `Publish it: pnpm run release:cut publish --execute`,
          `Or, if fragments merged since its release-prep commit, fold them in first: pnpm run release:cut prepare --amend --execute`,
        ].join("\n"),
      );
    }
    plan = computeRelease({ tags: remoteTags, fragmentNames, override: bump });
    plan.heading = releaseHeading(plan.version, date);
    nextPackageText = bumpPackageJson(packageText, plan.version);
    log(`Release prep for ${plan.tag} (${execute ? "EXECUTE" : "dry run — nothing is changed"})`);
    log(`  Base: ${MAIN_REF} ${main.slice(0, 12)}; latest release tag on ${REMOTE}: ${plan.previousTag ?? "none (starting from 0.0.0)"}`);
    log(
      `  Fragment types suggest a ${plan.suggestedBump} release` +
        (plan.featureFragments.length > 0
          ? ` (${plan.featureFragments.length} *${FEATURE_FRAGMENT_SUFFIX}: ${plan.featureFragments.join(", ")})`
          : ` (no *${FEATURE_FRAGMENT_SUFFIX} fragment among ${fragmentNames.length})`),
    );
    if (bump !== null) log(`  --bump ${bump} ${plan.overridden ? "OVERRIDES" : "matches"} that suggestion.`);
    if (plan.previousTag && packageVersion !== plan.previousTag.slice(1)) {
      log(`  Note: package.json says ${packageVersion}, not the latest tag's ${plan.previousTag.slice(1)}.`);
    }
  }
  if (localTagCommit(cmd, plan.tag) !== null) {
    throw new ReleaseCutError(
      `This clone has a tag ${plan.tag} that ${REMOTE} does not; it would collide with the release.`,
      `Inspect it with git show ${plan.tag}; if it is a leftover, delete it with git tag -d ${plan.tag}`,
    );
  }
  refuseExistingBranch(cmd, plan.branch);

  // The compiler's own dry run validates the CHANGELOG and prints what it would fold.
  const preview = compile({ repoRoot, version: plan.version, date, dryRun: true, append: amend, log });
  if (preview.fragments.length === 0 && !preview.foldedLegacyEntries) {
    throw new ReleaseCutError(
      amend
        ? "Nothing to fold: changelog.d/ is empty and \"## Unreleased\" has no entries."
        : "Nothing to release: changelog.d/ is empty and \"## Unreleased\" has no entries.",
    );
  }

  // Stage deletions too: the compiler removes consumed fragments and spent allowances.
  const stagePaths = ["CHANGELOG.md", "package.json", FRAGMENTS_DIRNAME, ALLOWANCE_DIR].filter((relative) =>
    fs.existsSync(path.join(repoRoot, relative)),
  );
  const message = amend ? `release: fold late fragments into ${plan.tag}` : `release: cut ${plan.tag}`;
  const steps = [
    `git switch -c ${plan.branch}`,
    ...(amend ? [] : [`set package.json "version" ${packageVersion} -> ${plan.version}`]),
    amend
      ? `node scripts/release/compile-changelog.mjs ${plan.version} --append`
      : `node scripts/release/compile-changelog.mjs ${plan.version} ${date}`,
    `git add --all -- ${stagePaths.join(" ")}`,
    `git commit -m "${message}"`,
  ];
  log("Local steps:");
  steps.forEach((step, index) => log(`  ${index + 1}. ${step}`));
  const next = [
    `Read "${plan.heading}" end to end; edit it for order and duplication and commit.`,
    `git push -u ${REMOTE} ${plan.branch}, then open its pull request (body checked with pnpm run pr:check).`,
    `After it merges: pnpm run release:cut publish (dry run), then pnpm run release:cut publish --execute.`,
  ];
  log("Then, by hand (this phase never pushes):");
  next.forEach((step) => log(`  - ${step}`));

  if (!execute) {
    log("Dry run: nothing was changed. Re-run with --execute to make the local commit.");
    return { ...plan, amend, executed: false, date };
  }

  cmd.git(["switch", "-c", plan.branch]);
  const recovery = [
    `You are on ${plan.branch}, which may hold part of the change.`,
    `Inspect it with: git status`,
    `To abandon it and start again: git switch --discard-changes --detach ${main} && git branch -D ${plan.branch}`,
  ].join("\n");
  try {
    if (nextPackageText !== null) fs.writeFileSync(packagePath, nextPackageText);
    compile({ repoRoot, version: plan.version, date, dryRun: false, append: amend, log });
  } catch (error) {
    throw new ReleaseCutError(`Release prep failed: ${error.message}`, recovery);
  }
  cmd.git(["add", "--all", "--", ...stagePaths], recovery);
  cmd.git(["commit", "-m", message], recovery);
  const commit = cmd.git(["rev-parse", "HEAD"]);
  log(`Committed ${commit.slice(0, 12)} on ${plan.branch}. Nothing was pushed; continue with the steps above.`);
  return { ...plan, amend, executed: true, date, commit };
}

/**
 * `sha` when it is on main's first-parent chain. Only a commit CI pushed to
 * main has GHCR images, so only its tag can be deployed; a release-prep
 * branch commit inside a merge is on main but never was main's tip.
 */
function requireFirstParent(firstParent, sha) {
  if (!firstParent.includes(sha)) {
    throw new ReleaseCutError(
      `${sha.slice(0, 12)} is not on ${MAIN_REF}'s first-parent chain: it was never a commit CI pushed to ${MAIN_BRANCH}, ` +
        `so no image was built for it and a deploy of its tag could not pull one.`,
      "Tag a merge commit on main: the release-prep pull request's merge commit, or origin/main (the default).",
    );
  }
  return sha;
}

/** Recovery for fragments that reached the target after the release-prep commit. */
function lateFragmentRecovery(tag) {
  return [
    `Either fold them into ${tag}, then publish the fold's merge commit:`,
    `  git switch --detach ${MAIN_REF} && pnpm run release:cut prepare --amend --execute`,
    `  push release/${tag}-late, merge its pull request, then pnpm run release:cut publish --execute`,
    `Or publish ${tag} without them; they are carried into the next release:`,
    `  pnpm run release:cut publish --carry-late-fragments --execute`,
  ].join("\n");
}

/**
 * Phase 2: tag the merged release-prep commit and publish the GitHub release.
 * Resumable: a tag already at the target (local, or pushed) or an existing
 * release is detected and the run continues from the first step not done.
 * `writeNotes(tag, text)` returns the path of the body file `gh` reads.
 */
export function publishRelease({
  repoRoot = REPO_ROOT,
  execute = false,
  commit = null,
  carryLateFragments = false,
  run = defaultRun(repoRoot),
  writeNotes = defaultWriteNotes,
  log = console.log,
} = {}) {
  const cmd = commands(run);

  const repo = originRepository(cmd);
  const main = refreshMain(cmd);
  const firstParent = cmd.git(["rev-list", "--first-parent", main]).split("\n");
  let target = requireFirstParent(firstParent, cmd.git(["rev-parse", "--verify", `${commit ?? MAIN_TRACKING_REF}^{commit}`]));
  const versionAt = (sha) => {
    const pkg = JSON.parse(cmd.git(["show", `${sha}:package.json`]));
    const version = String(pkg.version ?? "");
    if (!parseReleaseTag(`v${version}`)) throw new ReleaseCutError(`package.json at ${sha.slice(0, 12)} has no X.Y.Z version: ${version}`);
    return { pkg, version };
  };
  const { version } = versionAt(target);
  let { pkg } = versionAt(target);
  const tag = `v${version}`;
  const ghRepo = ["--repo", repo.slug];

  const local = localTagCommit(cmd, tag);
  const remote = remoteTagCommit(cmd, tag);
  if (remote !== null && remote !== target) {
    // Released, or an earlier publish pushed the tag and stopped before the
    // release — after which main may have moved on. Only the release decides.
    if (cmd.ghOk(["release", "view", tag, ...ghRepo])) {
      throw new ReleaseCutError(
        `${REMOTE} already has ${tag} on ${remote.slice(0, 12)}, not ${target.slice(0, 12)}: ${tag} is released, and nothing newer is prepared here.`,
        "Run pnpm run release:cut prepare and merge its pull request first.",
      );
    }
    if (commit !== null) {
      throw new ReleaseCutError(
        `${REMOTE}'s ${tag} is on ${remote.slice(0, 12)}, not ${target.slice(0, 12)}, and its GitHub release is missing: an earlier publish stopped after pushing the tag.`,
        `Resume against the tagged commit: pnpm run release:cut publish --execute --commit ${remote}`,
      );
    }
    log(`  ${REMOTE}'s ${tag} is on ${remote.slice(0, 12)} and its release is missing; ${MAIN_REF} has moved since. Resuming on ${remote.slice(0, 12)}.`);
    target = requireFirstParent(firstParent, remote);
    const resumed = versionAt(target);
    if (resumed.version !== version) {
      throw new ReleaseCutError(`${REMOTE}'s ${tag} is on ${target.slice(0, 12)}, whose package.json is not ${version}.`);
    }
    pkg = resumed.pkg;
  }
  if (remote === null && local !== null && local !== target) {
    throw new ReleaseCutError(
      `This clone's tag ${tag} is on ${local.slice(0, 12)}, not ${target.slice(0, 12)}, and ${REMOTE} has no ${tag}: ` +
        `an earlier publish stopped before pushing it, and ${MAIN_REF} has moved since.`,
      `Resume against the tagged commit: pnpm run release:cut publish --execute --commit ${local}`,
    );
  }
  if (remote !== null && local !== null && local !== target) {
    throw new ReleaseCutError(
      `${REMOTE}'s ${tag} is on ${target.slice(0, 12)}, but this clone's ${tag} is on ${local.slice(0, 12)}.`,
      `Replace the local tag with origin's, then re-run: git tag -d ${tag} && git fetch ${REMOTE} tag ${tag}`,
    );
  }
  // fresh: nothing done; tagged: local tag at the target; pushed: origin has it.
  const state = remote !== null ? "pushed" : local !== null ? "tagged" : "fresh";
  if (state === "tagged" && cmd.git(["cat-file", "-t", `refs/tags/${tag}`]) !== "tag") {
    throw new ReleaseCutError(
      `This clone's ${tag} is a lightweight tag; a release tag must be annotated.`,
      `Delete it and re-run, and publish creates the annotated tag: git tag -d ${tag} && pnpm run release:cut publish --execute --commit ${target}`,
    );
  }

  const changelog = cmd.git(["show", `${target}:CHANGELOG.md`]);
  const section = releaseSection(changelog, version);
  if (section === null || section.body.trim() === "") {
    throw new ReleaseCutError(
      `CHANGELOG.md at ${target.slice(0, 12)} has no "## ${version}" section with entries.`,
      state === "fresh" ? "Run pnpm run release:cut prepare and merge its pull request first." : "",
    );
  }
  const previous = latestReleaseTag(remoteReleaseTags(cmd).filter((name) => name !== tag));
  const late = cmd
    .git(["ls-tree", "--name-only", target, `${FRAGMENTS_DIRNAME}/`])
    .split("\n")
    .filter(Boolean)
    .map((file) => path.posix.basename(file))
    .filter(isFragmentName);
  // Pushed is past the point of no return: the checks below already passed
  // when that tag was created. A local tag has not left this clone yet.
  if (state !== "pushed") {
    if (previous && compareParts(parseReleaseTag(tag), previous.parts) <= 0) {
      throw new ReleaseCutError(
        `${tag} is not newer than the latest release tag on ${REMOTE}, ${previous.tag}: there is no prepared release to publish.`,
        "Run pnpm run release:cut prepare and merge its pull request first.",
      );
    }
    const unreleased = classifyUnreleased(changelog);
    if (unreleased && unreleased.legacy.length > 0) {
      throw new ReleaseCutError(
        `CHANGELOG.md at ${target.slice(0, 12)} still has entries written directly under "## Unreleased"; ${tag}'s notes would leave them out.`,
        `Fold them into ${tag} first:\n  git switch --detach ${MAIN_REF} && pnpm run release:cut prepare --amend --execute\n` +
          `  push release/${tag}-late, merge its pull request, then pnpm run release:cut publish --execute`,
      );
    }
    if (late.length > 0 && !carryLateFragments) {
      throw new ReleaseCutError(
        `${target.slice(0, 12)} holds ${late.length} fragment(s) that merged after the release-prep commit ` +
          `(${late.slice(0, 5).join(", ")}${late.length > 5 ? ", …" : ""}), so ${tag} would ship changes its notes leave out.`,
        lateFragmentRecovery(tag),
      );
    }
  }

  const body = releaseBody({ section, tag, repo });
  const name = String(pkg.name ?? path.basename(repoRoot));
  const message = `${name} ${tag}\n\nRelease notes: the "## ${version}" section of CHANGELOG.md.`;

  log(`Publish ${tag} (${execute ? "EXECUTE" : "dry run — nothing is changed"})`);
  log(`  Commit: ${target} (on ${MAIN_REF}'s first-parent chain); latest release tag on ${REMOTE}: ${previous?.tag ?? "none"}`);
  log(`  Repository: ${repo.slug} (from ${REMOTE})`);
  log(
    body.kind === "full"
      ? `  Release body: the "${section.heading}" section, ${section.body.length} characters.`
      : `  Release body: a SHORT body with ${body.entries} entries counted and a link to CHANGELOG.md — the section is ` +
          `${section.body.length} characters, over the ${MAX_RELEASE_NOTES_CHARS} limit.`,
  );
  if (late.length > 0) {
    log(`  Carried into the next release (not in ${tag}'s notes): ${late.join(", ")}`);
  }
  if (state !== "fresh") log(`  Resuming: ${state === "tagged" ? `the local tag ${tag} is already on the commit` : `${REMOTE} already has ${tag} on the commit`}.`);

  const releaseExists = state === "pushed" && cmd.ghOk(["release", "view", tag, ...ghRepo]);
  if (releaseExists) {
    log(`Done already: the GitHub release ${tag} exists on ${repo.slug}. Nothing to do.`);
    return { version, tag, commit: target, state: "published", executed: false, body };
  }

  const steps = [
    `gh auth status --hostname ${repo.host}; gh repo view ${repo.slug}`,
    `write the release body to a file`,
    ...(state === "fresh" ? [`git tag -a ${tag} -m "${name} ${tag} …" ${target.slice(0, 12)}`] : []),
    ...(state !== "pushed" ? [`git push ${REMOTE} refs/tags/${tag}`] : []),
    `gh release create ${tag} --repo ${repo.slug} --verify-tag --title ${tag} --notes-file <body>`,
  ];
  log("Steps (local first, then remote):");
  steps.forEach((step, index) => log(`  ${index + 1}. ${step}`));
  log(`Then deploy the tag: DEPLOY_REF=${tag} ./scripts/run-production-blue-green-deploy.sh (DEPLOYMENT.md).`);

  // Read-only checks run in the dry run too: they decide whether publishing can work.
  cmd.gh(["auth", "status", "--hostname", repo.host], "Nothing was created. Run gh auth login, then re-run.");
  cmd.gh(
    ["repo", "view", repo.slug, "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    `Nothing was created. ${repo.slug} (from ${REMOTE}'s URL) is not a repository gh can reach; fix ${REMOTE} or gh's login, then re-run.`,
  );
  if (!execute) {
    log("Dry run: nothing was changed. Re-run with --execute to tag and publish.");
    return { version, tag, commit: target, state, executed: false, body };
  }

  const notesFile = writeNotes(tag, body.text);
  const releaseArgs = ["release", "create", tag, ...ghRepo, "--verify-tag", "--title", tag, "--notes-file", notesFile];
  const rerun = `Re-run: pnpm run release:cut publish --execute --commit ${target} — it resumes from this step.`;
  if (state === "fresh") {
    cmd.git(["tag", "-a", tag, "-m", message, target], "Nothing was pushed or published; fix the cause and re-run.");
  }
  if (state !== "pushed") {
    cmd.git(
      ["push", REMOTE, `refs/tags/${tag}`],
      [
        `The annotated tag ${tag} exists locally but was NOT pushed, and no release was published.`,
        rerun,
        `Or by hand: git push ${REMOTE} refs/tags/${tag} && ${display("gh", releaseArgs)}`,
        `Or discard it: git tag -d ${tag}`,
      ].join("\n"),
    );
  }
  cmd.gh(
    releaseArgs,
    [
      `Tag ${tag} IS pushed, but the GitHub release was NOT published. Do not delete or move the tag.`,
      rerun,
      `Or by hand: ${display("gh", releaseArgs)}`,
    ].join("\n"),
  );
  log(`Published ${tag} on ${target.slice(0, 12)} to ${repo.slug}.`);
  return { version, tag, commit: target, state, executed: true, body, notesFile };
}

/** Write the body where a retry can find it again; the path is printed on failure. */
function defaultWriteNotes(tag, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `release-notes-${tag}-`));
  const file = path.join(dir, `${tag}.md`);
  fs.writeFileSync(file, text);
  return file;
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.phase === "prepare") {
      prepareRelease({
        execute: options.execute,
        bump: options.bump,
        amend: options.amend,
        date: options.date ?? todayInNewZealand(),
        log,
      });
    } else {
      publishRelease({
        execute: options.execute,
        commit: options.commit,
        carryLateFragments: options.carryLateFragments,
        log,
      });
    }
    return 0;
  } catch (failure) {
    error(`release:cut stopped: ${failure.message}`);
    if (failure.recovery) error(`\nRecovery:\n${failure.recovery}`);
    error("\nUsage: pnpm run release:cut prepare [--bump patch|minor|major] [--date YYYY-MM-DD] [--execute]");
    error("       pnpm run release:cut prepare --amend [--execute]");
    error("       pnpm run release:cut publish [--commit <sha>] [--carry-late-fragments] [--execute]");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = main();
}
