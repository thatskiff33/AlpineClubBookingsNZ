#!/usr/bin/env node
/**
 * Turn the collected evidence into candidate "bugs that came back" pairs.
 *
 *   pnpm run audit:fragility:signals
 *   pnpm run audit:fragility:signals -- --github-until <ISO time>
 *
 * `--github-until` ignores every issue, PR, comment and reopen event created
 * after that time. GitHub text is collected live, so this is how a rerun on a
 * later day sees the evidence an earlier run saw (the ranking doc records the
 * time its run used).
 *
 * Reads `tmp/fragility/{github,fix-units,code-repeats}.json` (written by
 * `fragility-collect.mjs`) and writes `tmp/fragility/repeats.json`: one entry
 * per earlier → later pair, with every signal that found it and a link for
 * each, so a reader can check any pair by hand.
 *
 * Signals:
 * - refix         — one issue needed a second (third, …) fix unit.
 * - reopened      — an issue was reopened after a fix had landed for it.
 * - mention       — an issue/PR body or comment cites an earlier, already-fixed
 *                   issue or PR in the same sentence as "regressed", "again",
 *                   "still", "came back", "follow-up to", "reintroduced", ….
 * - revert        — a fix commit was reverted.
 * - code-history  — the later fix rewrote lines an earlier fix (for another
 *                   issue) had written; see fragility-collect.mjs.
 *
 * This proposes candidates; it does not rank areas or judge root causes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  AUDIT_CUTOFF,
  closingReferences,
  commitUrl,
  DEFAULT_REF,
  issueUrl,
  pairKey,
  parseFixScope,
  pullUrl,
  repeatMentions,
  revertedCommit,
  unwrapRevertSubject,
} from "./fragility-lib.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = path.join(ROOT, "tmp/fragility");

/**
 * Build the repeat entries.
 *
 * @param {object} input
 * @param {Array} input.units        fix units (fix-units.json), sorted by date
 * @param {Array} input.codePairs    code-history pairs (code-repeats.json)
 * @param {object} input.github      github.json: { issues, comments, reopened }
 * @param {Array} input.reverts      [{ sha, date, subject, reverts, files }] revert commits on the analysed ref
 */
export function buildRepeats({ units, codePairs, github, reverts }) {
  const byNumber = new Map(github.issues.map((issue) => [issue.number, issue]));

  // A PR body's "Fixes #N" links the unit to issues its branch and commits did not name.
  const linked = units.map((unit) => {
    const prBody = unit.pr ? (byNumber.get(unit.pr)?.body ?? "") : "";
    const issues = new Set([...unit.issues, ...closingReferences(prBody)]);
    if (unit.pr) issues.delete(unit.pr);
    return { ...unit, issues: [...issues].sort((a, b) => a - b) };
  });
  const unitById = new Map(linked.map((unit) => [unit.id, unit]));

  /** Fix units that fixed issue-or-PR `number`, oldest first. */
  const unitsFor = (number) => linked.filter((unit) => unit.pr === number || unit.issues.includes(number));

  const entries = new Map();
  function add(earlier, later, signal) {
    const key = pairKey(earlier.key, later.key);
    const entry = entries.get(key) ?? { earlier, later, laterDate: later.date, signals: [], evidence: [] };
    if (!entry.signals.includes(signal.kind)) entry.signals.push(signal.kind);
    entry.evidence.push(signal);
    entries.set(key, entry);
  }

  for (const issue of github.issues.filter((item) => !item.isPr)) {
    const fixes = unitsFor(issue.number);
    for (let i = 1; i < fixes.length; i += 1) {
      add(unitRef(fixes[i - 1]), unitRef(fixes[i]), {
        kind: "refix",
        url: issueUrl(issue.number),
        note: `#${issue.number} fixed again by ${fixes[i].id} after ${fixes[i - 1].id}`,
      });
    }
  }

  for (const reopen of github.reopened) {
    const fixes = unitsFor(reopen.issue);
    const before = fixes.filter((unit) => unit.date < reopen.createdAt).at(-1);
    if (!before) continue; // reopened before any fix landed: not a repeat
    const after = fixes.find((unit) => unit.date > reopen.createdAt);
    add(unitRef(before), after ? unitRef(after) : issueRef(byNumber.get(reopen.issue), reopen.createdAt, reopen.issue), {
      kind: "reopened",
      url: issueUrl(reopen.issue),
      note: `#${reopen.issue} reopened ${reopen.createdAt.slice(0, 10)} after ${before.id}`,
    });
  }

  const texts = [
    ...github.issues.map((item) => ({
      number: item.number,
      date: item.createdAt,
      body: `${item.title}\n\n${item.body}`,
      url: item.isPr ? pullUrl(item.number) : issueUrl(item.number),
    })),
    ...github.comments.map((comment) => ({ number: comment.issue, date: comment.createdAt, body: comment.body, url: comment.url })),
  ];
  for (const text of texts) {
    for (const mention of repeatMentions(text.body)) {
      if (mention.number === text.number) continue;
      const earlier = unitsFor(mention.number).filter((unit) => unit.date < text.date).at(-1);
      if (!earlier) continue;
      if (earlier.pr === text.number || earlier.issues.includes(text.number)) continue; // same problem: a refix, not a mention
      const later = unitsFor(text.number).find((unit) => unit.date > earlier.date);
      add(unitRef(earlier), later ? unitRef(later) : issueRef(byNumber.get(text.number), text.date, text.number), {
        kind: "mention",
        url: text.url,
        wording: mention.wording,
        note: `cites #${mention.number} ("${mention.wording}"): ${mention.excerpt}`,
      });
    }
  }

  for (const revert of reverts) {
    const earlier = linked.find((unit) => unit.commits.some((sha) => sha.startsWith(revert.reverts)));
    if (!earlier) continue;
    // A revert undoes one commit, not the whole fix unit: both sides carry that
    // commit's own scope and files, so a wide PR's union of scopes does not
    // spread one revert across every area the PR touched.
    const reverted = { scopes: parseFixScope(unwrapRevertSubject(revert.subject) ?? "").scopes, files: revert.files ?? [] };
    add({ ...unitRef(earlier), ...reverted }, { key: `commit-${revert.sha.slice(0, 12)}`, commit: revert.sha, date: revert.date, title: revert.subject, ...reverted, url: commitUrl(revert.sha) }, {
      kind: "revert",
      url: commitUrl(revert.sha),
      note: `reverts ${revert.reverts.slice(0, 12)} from ${earlier.id}`,
    });
  }

  for (const pair of codePairs) {
    const earlier = unitById.get(pair.earlier);
    const later = unitById.get(pair.later);
    if (!earlier || !later) continue;
    add(unitRef(earlier), unitRef(later), {
      kind: "code-history",
      url: later.pr ? pullUrl(later.pr) : commitUrl(later.tip),
      note: `${pair.lines} lines last written by ${pair.earlier} (${pair.commits.map((sha) => sha.slice(0, 9)).join(", ")}) in ${Object.keys(pair.files).join(", ")}`,
      files: pair.files,
    });
  }

  return [...entries.values()]
    .map((entry) => ({ ...entry, sinceAudit: entry.laterDate >= AUDIT_CUTOFF }))
    .sort((a, b) => a.laterDate.localeCompare(b.laterDate));
}

function unitRef(unit) {
  return {
    key: unit.id,
    unit: unit.id,
    pr: unit.pr,
    issues: unit.issues,
    scopes: unit.scopes,
    title: unit.title,
    date: unit.date,
    files: unit.files,
    url: unit.pr ? pullUrl(unit.pr) : commitUrl(unit.tip),
  };
}

/** A later side that is an issue with no fix unit (yet): reopened, or a regression report. */
function issueRef(issue, date, number) {
  return { key: `issue-${number}`, issue: number, title: issue?.title ?? null, labels: issue?.labels ?? [], date, url: issueUrl(number) };
}

/** `github` as it stood at `until` (an ISO time), or unchanged when `until` is null. */
export function githubAsOf(github, until) {
  if (!until) return github;
  const bound = Date.parse(until);
  if (Number.isNaN(bound)) throw new Error(`--github-until needs an ISO time, got ${until}`);
  const before = (item) => Date.parse(item.createdAt) <= bound;
  return { ...github, issues: github.issues.filter(before), comments: github.comments.filter(before), reopened: github.reopened.filter(before) };
}

/** The `--github-until <ISO time>` argument, or null. */
export function githubUntilFromArgs(argv) {
  const index = argv.findIndex((arg) => arg === "--github-until" || arg.startsWith("--github-until="));
  if (index === -1) return null;
  const value = argv[index].startsWith("--github-until=") ? argv[index].slice("--github-until=".length) : argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--github-until needs an ISO time, for example --github-until 2026-10-11T16:33:33Z");
  return value;
}

function readRevertCommits(ref) {
  const raw = execFileSync("git", ["log", ref, "--grep=This reverts commit", "--format=%x1e%H%x1f%aI%x1f%s%x1f%b%x1f", "--name-only", "--no-renames"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return raw
    .split("\x1e")
    .slice(1)
    .map((record) => {
      const [sha, date, subject, body, files] = record.split("\x1f");
      return { sha, date: new Date(date).toISOString(), subject, reverts: revertedCommit(body), files: files.split("\n").filter(Boolean) };
    })
    .filter((revert) => revert.reverts);
}

function readJson(name) {
  const file = path.join(OUT_DIR, name);
  if (!existsSync(file)) {
    console.error(`tmp/fragility/${name} is missing. Run pnpm run audit:fragility:collect first (with GITHUB_TOKEN, or inside a Sekreton task through its integrations endpoint).`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function main() {
  const github = githubAsOf(readJson("github.json"), githubUntilFromArgs(process.argv.slice(2)));
  const { units, ref = DEFAULT_REF } = readJson("fix-units.json");
  const { pairs } = readJson("code-repeats.json");
  const repeats = buildRepeats({ units, codePairs: pairs, github, reverts: readRevertCommits(ref) });
  writeFileSync(path.join(OUT_DIR, "repeats.json"), `${JSON.stringify({ builtAt: new Date().toISOString(), repeats }, null, 1)}\n`);
  const bySignal = {};
  for (const entry of repeats) for (const signal of entry.signals) bySignal[signal] = (bySignal[signal] ?? 0) + 1;
  console.error(`wrote tmp/fragility/repeats.json: ${repeats.length} candidate pairs ${JSON.stringify(bySignal)}`);
}

if (isMainModule(import.meta.url)) main();
