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
 *     next version, creates `release/v<version>`, bumps `package.json`, folds
 *     `changelog.d/` into `CHANGELOG.md` with `compile-changelog.mjs`, and
 *     commits. It never pushes: the maintainer reads and edits the new section,
 *     then pushes the branch and opens the release-prep pull request.
 *
 *   pnpm run release:cut publish [--commit <sha>] [--execute]
 *     After that pull request merges: creates the annotated `v<version>` tag on
 *     the merged commit (default `origin/main`), pushes the tag, and publishes
 *     the GitHub release with the compiled section as its notes.
 *
 * Both phases print the whole plan and change nothing unless `--execute` is
 * given. With `--execute`, local steps run first and remote ones (tag push,
 * `gh release create`) only after every local step succeeded; a failure part
 * way stops with the exact commands to recover or retry.
 *
 * The version is the latest `vX.Y.Z` tag plus a bump chosen from the fragment
 * types (`changelog.d/README.md`, "Patch or minor"): any `*.feature.md`
 * fragment makes it a minor release, otherwise a patch. `--bump` overrides it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { ALLOWANCE_DIR } from "../lib/allowance-dir.mjs";
import { compileChangelog, FRAGMENTS_DIRNAME, readFragments, releaseSection, todayInNewZealand } from "./compile-changelog.mjs";

const REPO_ROOT = path.resolve(path.join(import.meta.dirname, "..", ".."));

/** A fragment whose filename ends in this marks a feature: the release is minor. */
export const FEATURE_FRAGMENT_SUFFIX = ".feature.md";

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUMPS = ["patch", "minor", "major"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REMOTE = "origin";
const MAIN_REF = "refs/remotes/origin/main";

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

/** Parse argv into `{ phase, execute, bump, date, commit }`. */
export function parseArgs(argv) {
  const options = { phase: null, execute: false, dryRun: false, bump: null, date: null, commit: null };
  const takesValue = { "--bump": "bump", "--date": "date", "--commit": "commit" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--execute") options.execute = true;
    else if (arg === "--dry-run") options.dryRun = true;
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
  if (options.phase === "prepare" && options.commit !== null) throw new ReleaseCutError("--commit belongs to publish.");
  if (options.phase === "publish" && (options.bump !== null || options.date !== null)) {
    throw new ReleaseCutError("--bump and --date belong to prepare; publish reads the version from the merged commit.");
  }
  return options;
}

/** Default process runner: captures output, never throws on a non-zero exit. */
function defaultRun(repoRoot) {
  return (command, args) => {
    const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.error?.code === "ENOENT") {
      return { status: 127, stdout: "", stderr: `${command} is not on PATH.` };
    }
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

function display(command, args) {
  return [command, ...args.map((arg) => (/^[\w./:=@^{}-]+$/.test(arg) ? arg : JSON.stringify(arg)))].join(" ");
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
  };
}

/** Fetch, then return the refreshed `origin/main` commit. */
function refreshMain(cmd) {
  cmd.git(["fetch", "--tags", REMOTE, "main"]);
  return cmd.git(["rev-parse", "--verify", `${MAIN_REF}^{commit}`]);
}

function releaseTags(cmd) {
  return cmd.git(["tag", "--list", "v*"]).split("\n").filter(Boolean);
}

/**
 * Refuse when `branch` exists here, or `tag` or `branch` on the remote. A local
 * `tag` cannot exist: the version is always newer than every fetched tag.
 */
function refuseExisting(cmd, { tag, branch = null }) {
  if (branch && cmd.gitOk(["rev-parse", "-q", "--verify", `refs/heads/${branch}`])) {
    throw new ReleaseCutError(`Branch ${branch} already exists locally; finish or delete that release-prep branch first.`);
  }
  const refs = [`refs/tags/${tag}`, ...(branch ? [`refs/heads/${branch}`] : [])];
  const remote = cmd.git(["ls-remote", REMOTE, ...refs]);
  if (remote !== "") {
    throw new ReleaseCutError(`${REMOTE} already has ${remote.split("\n").map((line) => line.split(/\s+/)[1]).join(", ")}.`);
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

/**
 * Phase 1: build the release-prep commit locally.
 * Returns the plan; with `execute`, also the commit it made.
 */
export function prepareRelease({
  repoRoot = REPO_ROOT,
  execute = false,
  bump = null,
  date = todayInNewZealand(),
  run = defaultRun(repoRoot),
  compile = compileChangelog,
  log = console.log,
} = {}) {
  const cmd = commands(run);

  // Preconditions — nothing below writes until all of them hold.
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
        ? `HEAD (${head.slice(0, 12)}) is behind ${REMOTE}/main (${main.slice(0, 12)}): the base is stale.`
        : `HEAD (${head.slice(0, 12)}) carries commits that are not on ${REMOTE}/main (${main.slice(0, 12)}).`,
      `Start release prep from ${REMOTE}/main itself: git switch --detach ${REMOTE}/main`,
    );
  }

  const fragmentNames = readFragments(path.join(repoRoot, FRAGMENTS_DIRNAME)).map((fragment) => fragment.name);
  const plan = computeRelease({ tags: releaseTags(cmd), fragmentNames, override: bump });
  refuseExisting(cmd, plan);
  const packagePath = path.join(repoRoot, "package.json");
  const packageText = fs.readFileSync(packagePath, "utf8");
  const nextPackageText = bumpPackageJson(packageText, plan.version);

  log(`Release prep for ${plan.tag} (${execute ? "EXECUTE" : "dry run — nothing is changed"})`);
  log(`  Base: ${REMOTE}/main ${main.slice(0, 12)}; previous release tag: ${plan.previousTag ?? "none (starting from 0.0.0)"}`);
  log(
    `  Fragment types suggest a ${plan.suggestedBump} release` +
      (plan.featureFragments.length > 0
        ? ` (${plan.featureFragments.length} *${FEATURE_FRAGMENT_SUFFIX}: ${plan.featureFragments.join(", ")})`
        : ` (no *${FEATURE_FRAGMENT_SUFFIX} fragment among ${fragmentNames.length})`),
  );
  if (bump !== null) log(`  --bump ${bump} ${plan.overridden ? "OVERRIDES" : "matches"} that suggestion.`);
  const packageVersion = JSON.parse(packageText).version;
  if (plan.previousTag && packageVersion !== plan.previousTag.slice(1)) {
    log(`  Note: package.json says ${packageVersion}, not the latest tag's ${plan.previousTag.slice(1)}.`);
  }

  // The compiler's own dry run validates the CHANGELOG and prints what it would fold.
  const preview = compile({ repoRoot, version: plan.version, date, dryRun: true, log });
  if (preview.fragments.length === 0 && !preview.foldedLegacyEntries) {
    throw new ReleaseCutError("Nothing to release: changelog.d/ is empty and \"## Unreleased\" has no entries.");
  }

  // Stage deletions too: the compiler removes consumed fragments and spent allowances.
  const stagePaths = ["CHANGELOG.md", "package.json", FRAGMENTS_DIRNAME, ALLOWANCE_DIR].filter((relative) =>
    fs.existsSync(path.join(repoRoot, relative)),
  );
  const steps = [
    `git switch -c ${plan.branch}`,
    `set package.json "version" ${packageVersion} -> ${plan.version}`,
    `node scripts/release/compile-changelog.mjs ${plan.version} ${date}`,
    `git add --all -- ${stagePaths.join(" ")}`,
    `git commit -m "release: cut ${plan.tag}"`,
  ];
  log("Local steps:");
  steps.forEach((step, index) => log(`  ${index + 1}. ${step}`));
  const next = [
    `Read the new "## ${plan.version} - ${date}" section end to end; edit it for order and duplication and commit.`,
    `git push -u ${REMOTE} ${plan.branch}, then open the release-prep pull request (body checked with pnpm run pr:check).`,
    `After it merges: pnpm run release:cut publish (dry run), then pnpm run release:cut publish --execute.`,
  ];
  log("Then, by hand (this phase never pushes):");
  next.forEach((step) => log(`  - ${step}`));

  if (!execute) {
    log("Dry run: nothing was changed. Re-run with --execute to make the local commit.");
    return { ...plan, executed: false, date };
  }

  cmd.git(["switch", "-c", plan.branch]);
  const recovery = [
    `You are on ${plan.branch}, which may hold part of the release-prep change.`,
    `Inspect it with: git status`,
    `To abandon it and start again: git switch --discard-changes --detach ${main} && git branch -D ${plan.branch}`,
  ].join("\n");
  try {
    fs.writeFileSync(packagePath, nextPackageText);
    compile({ repoRoot, version: plan.version, date, dryRun: false, log });
  } catch (error) {
    throw new ReleaseCutError(`Release prep failed: ${error.message}`, recovery);
  }
  cmd.git(["add", "--all", "--", ...stagePaths], recovery);
  cmd.git(["commit", "-m", `release: cut ${plan.tag}`], recovery);
  const commit = cmd.git(["rev-parse", "HEAD"]);
  log(`Committed ${commit.slice(0, 12)} on ${plan.branch}. Nothing was pushed; continue with the steps above.`);
  return { ...plan, executed: true, date, commit };
}

/**
 * Phase 2: tag the merged release-prep commit and publish the GitHub release.
 * `writeNotes(tag, text)` returns the path of the notes file `gh` reads.
 */
export function publishRelease({
  repoRoot = REPO_ROOT,
  execute = false,
  commit = null,
  run = defaultRun(repoRoot),
  writeNotes = defaultWriteNotes,
  log = console.log,
} = {}) {
  const cmd = commands(run);

  const main = refreshMain(cmd);
  const target = cmd.git(["rev-parse", "--verify", `${commit ?? MAIN_REF}^{commit}`]);
  if (!cmd.gitOk(["merge-base", "--is-ancestor", target, main])) {
    throw new ReleaseCutError(
      `${target.slice(0, 12)} is not on ${REMOTE}/main. A release is tagged only on a merged commit: merge the release-prep pull request first.`,
    );
  }
  const pkg = JSON.parse(cmd.git(["show", `${target}:package.json`]));
  const version = String(pkg.version ?? "");
  const tag = `v${version}`;
  if (!parseReleaseTag(tag)) throw new ReleaseCutError(`package.json at ${target.slice(0, 12)} has no X.Y.Z version: ${version}`);
  const notes = releaseSection(cmd.git(["show", `${target}:CHANGELOG.md`]), version);
  if (notes === null || notes.trim() === "") {
    throw new ReleaseCutError(
      `CHANGELOG.md at ${target.slice(0, 12)} has no "## ${version}" section with entries. Run release:cut prepare and merge its pull request first.`,
    );
  }
  const leftover = cmd
    .git(["ls-tree", "--name-only", target, `${FRAGMENTS_DIRNAME}/`])
    .split("\n")
    .map((file) => path.posix.basename(file))
    .filter((name) => name.toLowerCase().endsWith(".md") && name.toLowerCase() !== "readme.md");
  if (leftover.length > 0) {
    throw new ReleaseCutError(
      `${target.slice(0, 12)} still holds ${leftover.length} unreleased fragment(s) (${leftover.slice(0, 5).join(", ")}${leftover.length > 5 ? ", …" : ""}): ` +
        `something merged after the release-prep commit, so ${tag} would ship changes its notes leave out.`,
      `Tag the release-prep merge commit instead: pnpm run release:cut publish --commit <merge-sha>`,
    );
  }
  const previous = latestReleaseTag(releaseTags(cmd));
  if (previous && compareParts(parseReleaseTag(tag), previous.parts) <= 0) {
    throw new ReleaseCutError(`${tag} is not newer than the latest release tag ${previous.tag}.`);
  }
  refuseExisting(cmd, { tag });

  const name = String(pkg.name ?? path.basename(repoRoot));
  const message = `${name} ${tag}\n\nRelease notes: the "## ${version}" section of CHANGELOG.md.`;
  log(`Publish ${tag} (${execute ? "EXECUTE" : "dry run — nothing is changed"})`);
  log(`  Commit: ${target} (on ${REMOTE}/main); previous release tag: ${previous?.tag ?? "none"}`);
  log(`  Notes: the "## ${version}" section, ${notes.split("\n").length} line(s).`);
  log("Steps (local first, then remote):");
  log(`  1. gh auth status`);
  log(`  2. git tag -a ${tag} -m "${name} ${tag} …" ${target.slice(0, 12)}`);
  log(`  3. git push ${REMOTE} refs/tags/${tag}`);
  log(`  4. gh release create ${tag} --verify-tag --title ${tag} --notes-file <section>`);
  log(`Then deploy the tag: DEPLOY_REF=${tag} ./scripts/run-production-blue-green-deploy.sh (DEPLOYMENT.md).`);
  if (!execute) {
    log("Dry run: nothing was changed. Re-run with --execute to tag and publish.");
    return { version, tag, commit: target, executed: false, notes };
  }

  cmd.gh(["auth", "status"], "Nothing was created. Run gh auth login, then re-run.");
  cmd.git(["tag", "-a", tag, "-m", message, target], "Nothing was pushed or published; fix the cause and re-run.");
  const notesFile = writeNotes(tag, `${notes}\n`);
  const releaseArgs = ["release", "create", tag, "--verify-tag", "--title", tag, "--notes-file", notesFile];
  cmd.git(
    ["push", REMOTE, `refs/tags/${tag}`],
    [
      `The annotated tag ${tag} exists locally but was NOT pushed, and no release was published.`,
      `Retry: git push ${REMOTE} refs/tags/${tag} && ${display("gh", releaseArgs)}`,
      `Or discard it: git tag -d ${tag}`,
    ].join("\n"),
  );
  cmd.gh(
    releaseArgs,
    [
      `Tag ${tag} IS pushed, but the GitHub release was NOT published. Do not delete or move the tag.`,
      `Retry: ${display("gh", releaseArgs)}`,
    ].join("\n"),
  );
  log(`Published ${tag} on ${target.slice(0, 12)}.`);
  return { version, tag, commit: target, executed: true, notes, notesFile };
}

/** Write the notes where a retry can find them again; the path is printed on failure. */
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
      prepareRelease({ execute: options.execute, bump: options.bump, date: options.date ?? todayInNewZealand(), log });
    } else {
      publishRelease({ execute: options.execute, commit: options.commit, log });
    }
    return 0;
  } catch (failure) {
    error(`release:cut stopped: ${failure.message}`);
    if (failure.recovery) error(`\nRecovery:\n${failure.recovery}`);
    error("\nUsage: pnpm run release:cut prepare [--bump patch|minor|major] [--date YYYY-MM-DD] [--execute]");
    error("       pnpm run release:cut publish [--commit <sha>] [--execute]");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = main();
}
