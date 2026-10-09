#!/usr/bin/env node
/**
 * Collect the raw evidence for the fragility review (ALP-4 proposes business
 * areas from it, ALP-7 ranks them by "bugs that came back").
 *
 *   GITHUB_TOKEN=… pnpm run audit:fragility:collect
 *   pnpm run audit:fragility:collect --git-only   # collectors 2 and 3 only
 *
 * Writes `tmp/fragility/*.json` (git-ignored) under the checkout root, wherever
 * it is run from. Every run rebuilds every file it owns from scratch, so a
 * later task in a fresh checkout just runs it again.
 *
 * 1. github.json  — every issue and PR, every comment, and every `reopened`
 *    event on the repository, via the REST API. Needs a read-only
 *    `GITHUB_TOKEN`; there is deliberately no anonymous fallback, because the
 *    60-requests-an-hour limit cannot finish the ~390 pages this needs.
 * 2. fix-units.json — one unit per merged fix PR (a `fix` title, or a `fix/…`
 *    branch when the title is not conventional), plus each `fix…` commit made
 *    straight on main, with its issue numbers, commits, `fix(<scope>)` scopes,
 *    files and date.
 * 3. code-repeats.json — for each fix unit, `git blame -w -M -C` on its parent
 *    over the lines it changed or deleted. Lines last written by an earlier
 *    fix unit for a different issue make a repeat pair (earlier → later).
 *    Sweeps (>50 files) and refactor/chore/style/docs commits are not fixes;
 *    tests, docs and lockfiles are not blamed; pairs need 5+ blamed lines.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  MIN_PAIR_LINES,
  REPO,
  blameCommitCounts,
  changedOldRanges,
  closingReferences,
  concernDifferentIssues,
  isBlameIgnoredPath,
  isExcludedEarlierCommit,
  isFixPr,
  isFixSubject,
  isRateLimited,
  issueNumbersFromBranch,
  pairKey,
  parseFixScope,
  parseMergeSubject,
} from "./fragility-lib.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = path.join(ROOT, "tmp/fragility");
const MAIN = "main";
const BLAME_CONCURRENCY = 3;
const GIT_BUFFER = 512 * 1024 * 1024;

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: GIT_BUFFER });
}

function write(name, data) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(data, null, 1)}\n`);
  console.error(`wrote tmp/fragility/${name}`);
}

// ---------------------------------------------------------------------------
// 1. GitHub
// ---------------------------------------------------------------------------

async function collectGithub(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "alpineclubbookings-fragility-audit",
  };

  async function* pages(endpoint) {
    let url = `https://api.github.com/repos/${REPO}${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100`;
    let page = 0;
    while (url) {
      const response = await fetch(url, { headers });
      if (isRateLimited(response.status, response.headers)) {
        await waitForReset(response);
        continue;
      }
      if (!response.ok) throw new Error(`GitHub ${response.status} for ${url}: ${await response.text()}`);
      page += 1;
      if (page % 20 === 0) console.error(`  ${endpoint}: page ${page}`);
      yield await response.json();
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining !== null && Number(remaining) < 20) await waitForReset(response);
      url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
    }
  }

  async function all(endpoint, map) {
    const items = [];
    for await (const batch of pages(endpoint)) items.push(...batch.map(map).filter(Boolean));
    return items;
  }

  console.error("GitHub: issues and PRs");
  const issues = await all("/issues?state=all&direction=asc", (issue) => ({
    number: issue.number,
    isPr: Boolean(issue.pull_request),
    title: issue.title,
    body: issue.body ?? "",
    labels: issue.labels.map((label) => (typeof label === "string" ? label : label.name)),
    state: issue.state,
    stateReason: issue.state_reason ?? null,
    createdAt: issue.created_at,
    closedAt: issue.closed_at,
    mergedAt: issue.pull_request?.merged_at ?? null,
  }));
  console.error("GitHub: comments");
  const comments = await all("/issues/comments?direction=asc", (comment) => ({
    issue: Number(/\/issues\/(\d+)$/.exec(comment.issue_url)?.[1]),
    id: comment.id,
    createdAt: comment.created_at,
    body: comment.body ?? "",
    url: comment.html_url,
  }));
  console.error("GitHub: events (keeping reopened)");
  const reopened = await all("/issues/events", (event) =>
    event.event === "reopened" ? { issue: event.issue?.number, createdAt: event.created_at } : null,
  );

  const highest = Math.max(...issues.map((issue) => issue.number));
  console.error(`GitHub: ${issues.length} issues/PRs (highest #${highest}), ${comments.length} comments, ${reopened.length} reopens`);
  return { collectedAt: new Date().toISOString(), highestNumber: highest, issues, comments, reopened };
}

async function waitForReset(response) {
  const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
  const retryAfter = Number(response.headers.get("retry-after")) * 1000;
  const wait = Math.max(retryAfter || 0, reset ? reset - Date.now() + 2000 : 60_000, 1000);
  console.error(`GitHub rate limit: waiting ${Math.ceil(wait / 1000)}s`);
  await new Promise((resolve) => setTimeout(resolve, wait));
}

// ---------------------------------------------------------------------------
// 2. Git fix units
// ---------------------------------------------------------------------------

/** Every commit reachable from main: parents, date (UTC), subject, body, files (non-merges). */
function readCommits() {
  const raw = git(["log", MAIN, "--format=%x1e%H%x1f%P%x1f%aI%x1f%s%x1f%b%x1f", "--name-only", "--no-renames"]);
  const commits = new Map();
  for (const record of raw.split("\x1e").slice(1)) {
    const [sha, parents, date, subject, body, files] = record.split("\x1f");
    commits.set(sha, {
      sha,
      parents: parents.split(" ").filter(Boolean),
      date: new Date(date).toISOString(), // UTC, so it compares with GitHub timestamps as text
      subject,
      body: body.trim(),
      files: files.split("\n").filter(Boolean),
    });
  }
  return commits;
}

function firstParentShas() {
  return new Set(git(["rev-list", "--first-parent", MAIN]).split("\n").filter(Boolean));
}

function netFiles(base, tip) {
  return git(["diff", "--name-only", base, tip]).split("\n").filter(Boolean);
}

function buildFixUnits(commits) {
  const mainLine = firstParentShas();
  const prMerges = [];
  for (const commit of commits.values()) {
    const merge = commit.parents.length === 2 ? parseMergeSubject(commit.subject) : null;
    if (!merge) continue;
    const members = git(["rev-list", `${commit.parents[0]}..${commit.parents[1]}`]).split("\n").filter(Boolean);
    prMerges.push({ ...merge, commit, title: commit.body.split("\n")[0] ?? "", members });
  }

  // A commit inside an inner PR (fix PR merged into an epic branch) belongs to
  // the innermost PR, so assign the smallest PRs first.
  prMerges.sort((a, b) => a.members.length - b.members.length);
  const prOfCommit = new Map();
  for (const pr of prMerges) {
    prOfCommit.set(pr.commit.sha, pr.pr);
    for (const sha of pr.members) if (!prOfCommit.has(sha)) prOfCommit.set(sha, pr.pr);
  }

  const units = [];
  for (const pr of prMerges) {
    if (!isFixPr(pr)) continue;
    const own = pr.members.filter((sha) => prOfCommit.get(sha) === pr.pr);
    // A wrapper whose every commit belongs to an inner PR fixed nothing itself;
    // counting it would pair it with its own inner fix as a fake refix.
    if (own.every((sha) => commits.get(sha)?.parents.length !== 1)) continue;
    const messages = [pr.title, pr.commit.body, ...own.map((sha) => `${commits.get(sha)?.subject}\n${commits.get(sha)?.body}`)];
    const subjects = [pr.title, ...own.map((sha) => commits.get(sha)?.subject ?? "")];
    units.push(
      makeUnit({
        id: `pr-${pr.pr}`,
        pr: pr.pr,
        branch: pr.branch,
        title: pr.title,
        date: pr.commit.date,
        base: pr.commit.parents[0],
        tip: pr.commit.sha,
        commits: own,
        subjects,
        messages,
        branchIssues: issueNumbersFromBranch(pr.branch),
      }),
    );
  }

  for (const sha of mainLine) {
    const commit = commits.get(sha);
    if (!commit || commit.parents.length !== 1 || !isFixSubject(commit.subject)) continue;
    const squashedPr = /\(#(\d+)\)$/.exec(commit.subject)?.[1];
    units.push(
      makeUnit({
        id: `commit-${sha.slice(0, 12)}`,
        pr: squashedPr ? Number(squashedPr) : null,
        branch: null,
        title: commit.subject,
        date: commit.date,
        base: commit.parents[0],
        tip: sha,
        commits: [sha],
        subjects: [commit.subject],
        messages: [`${commit.subject}\n${commit.body}`],
        branchIssues: [],
      }),
    );
  }

  units.sort((a, b) => a.date.localeCompare(b.date));
  for (const unit of units) unit.files = netFiles(unit.base, unit.tip);
  return units;
}

function makeUnit({ subjects, messages, branchIssues, ...unit }) {
  const scopes = new Set();
  const issues = new Set(branchIssues);
  for (const subject of subjects) {
    const parsed = parseFixScope(subject);
    parsed.scopes.forEach((scope) => scopes.add(scope));
    parsed.issues.forEach((issue) => issues.add(issue));
  }
  for (const message of messages) closingReferences(message).forEach((issue) => issues.add(issue));
  if (unit.pr) issues.delete(unit.pr);
  return { ...unit, issues: [...issues].sort((a, b) => a - b), scopes: [...scopes].sort() };
}

// ---------------------------------------------------------------------------
// 3. Code-history repeats
// ---------------------------------------------------------------------------

async function findCodeRepeats(units, commits) {
  const unitOfCommit = new Map();
  for (const unit of units) for (const sha of unit.commits) unitOfCommit.set(sha, unit);
  const unitById = new Map(units.map((unit) => [unit.id, unit]));

  const pairs = new Map();
  let done = 0;
  const queue = [...units];
  async function worker() {
    for (let later = queue.shift(); later; later = queue.shift()) {
      const diff = git(["diff", "-U0", "-w", "-M", later.base, later.tip]);
      for (const [file, ranges] of changedOldRanges(diff)) {
        if (isBlameIgnoredPath(file)) continue;
        const args = ["blame", "-w", "-M", "-C", "--porcelain"];
        for (const [start, end] of ranges) args.push("-L", `${start},${end}`);
        let counts;
        try {
          const { stdout } = await execFileAsync("git", [...args, later.base, "--", file], { cwd: ROOT, maxBuffer: GIT_BUFFER });
          counts = blameCommitCounts(stdout);
        } catch {
          continue; // file absent at base under this name (rename edge cases)
        }
        for (const [sha, lines] of counts) {
          const earlier = unitOfCommit.get(sha);
          const commit = commits.get(sha);
          if (!earlier || !commit || commit.parents.length !== 1) continue;
          if (isExcludedEarlierCommit({ subject: commit.subject, fileCount: commit.files.length })) continue;
          if (!concernDifferentIssues(earlier, later)) continue;
          const key = pairKey(earlier.id, later.id);
          const pair = pairs.get(key) ?? { earlier: earlier.id, later: later.id, lines: 0, files: {}, commits: [] };
          pair.lines += lines;
          pair.files[file] = (pair.files[file] ?? 0) + lines;
          if (!pair.commits.includes(sha)) pair.commits.push(sha);
          pairs.set(key, pair);
        }
      }
      done += 1;
      if (done % 50 === 0) console.error(`  blame: ${done}/${units.length} fix units`);
    }
  }
  await Promise.all(Array.from({ length: BLAME_CONCURRENCY }, worker));

  return [...pairs.values()]
    .filter((pair) => pair.lines >= MIN_PAIR_LINES)
    .map((pair) => ({ ...pair, laterDate: unitById.get(pair.later).date }))
    .sort((a, b) => a.laterDate.localeCompare(b.laterDate));
}

// ---------------------------------------------------------------------------

async function main() {
  const gitOnly = process.argv.includes("--git-only");
  const token = process.env.GITHUB_TOKEN;
  if (!gitOnly && !token) {
    console.error(
      "GITHUB_TOKEN is not set. The fragility review needs a read-only token (fine-grained, public repositories);\n" +
        "the anonymous 60-requests-an-hour limit cannot finish the ~390 pages this collects.\n" +
        "Set GITHUB_TOKEN, or pass --git-only to run collectors 2 and 3 without it.",
    );
    process.exit(2);
  }

  if (!gitOnly) write("github.json", await collectGithub(token));

  console.error("git: fix units");
  const commits = readCommits();
  const units = buildFixUnits(commits);
  write("fix-units.json", { collectedAt: new Date().toISOString(), head: git(["rev-parse", MAIN]).trim(), units });
  console.error(`git: ${units.length} fix units`);

  console.error("git: code-history repeats (blame)");
  const pairs = await findCodeRepeats(units, commits);
  write("code-repeats.json", { collectedAt: new Date().toISOString(), pairs });
  console.error(`git: ${pairs.length} code-history repeat pairs`);
}

await main();
