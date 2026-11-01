#!/usr/bin/env node
/**
 * Soft PR-size gate (#4463).
 *
 * The owner approves plans, not diffs, so a reviewer lens is what reads the
 * diff — and review quality falls off with size (median merged PR ~590 changed
 * lines, slowest tenth over 4,000, largest 17,411 when #4463 was filed). A PR
 * over `LARGE_PR_LINE_THRESHOLD` changed lines must say why in a one-line
 * `large-pr: <reason>` in its body. It is SOFT by the issue's own words: a
 * missing reason prints a GitHub Actions `::warning::` annotation and never
 * fails `verify`, and that stays true after the plan-deviation section is
 * enforced.
 *
 * What is counted: added + deleted lines over the PR's three-dot range, from
 * `git diff --numstat` (a binary file counts 0; a detected rename counts only
 * its edits). What is NOT counted: any path `.gitattributes` marks
 * `linguist-generated` — the lockfile and the regenerated pin and golden files.
 * That attribute is GitHub's own convention, so the one list both collapses
 * those files in the PR diff view and keeps them out of this count; add a
 * generated file there, never to a list in this script.
 *
 * The attributes are read from the PR's BASE (`git check-attr --source`, git
 * 2.40+), never from its own tree: otherwise a PR could mark its own files
 * generated in `.gitattributes` and shrink its own count. The cost is that a
 * PR adding a generated file AND its `.gitattributes` line is counted in full
 * once; every later PR sees the line.
 *
 * Runs before `pnpm install --frozen-lockfile` in the `verify` job, so it uses
 * Node built-ins only.
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

import { workflowCommand } from "./dependency-mitigation.mjs";
import { fetchLivePrBody, readEventPrBody, selectPrBody, stripNonAnswerText } from "./pr-body.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

export const LARGE_PR_LINE_THRESHOLD = 800;

/** The `.gitattributes` attribute that marks a file generated (see the header). */
export const GENERATED_ATTRIBUTE = "linguist-generated";

const GATE_LABEL = "PR size check";

/**
 * Parse `git diff --numstat -z` output into
 * `[{ path, oldPath, added, deleted, binary }]`. With `-z` a plain record is
 * `added\tdeleted\tpath\0`, a rename or copy is `added\tdeleted\t\0old\0new\0`,
 * and paths arrive unquoted, so a non-ASCII or spaced name parses as itself.
 */
export function parseNumstat(stdout) {
  const tokens = stdout.split("\0");
  const records = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const [added, deleted, path = ""] = token.split("\t");
    const binary = added === "-" || deleted === "-";
    const counts = {
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    };
    if (path === "") {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      records.push({ path: newPath, oldPath, ...counts });
    } else {
      records.push({ path, oldPath: null, ...counts });
    }
  }
  return records;
}

/**
 * Which of `paths` `.gitattributes` marks generated, as of the commit `source`
 * (the PR's base; see the header), read with `git check-attr --source`.
 */
export function generatedPaths(paths, { cwd, source }) {
  if (!source) throw new Error("generatedPaths needs the commit to read .gitattributes from (source).");
  if (paths.length === 0) return new Set();
  const stdout = execFileSync("git", ["check-attr", "-z", `--source=${source}`, GENERATED_ATTRIBUTE, "--stdin"], {
    encoding: "utf8",
    input: `${paths.join("\0")}\0`,
    ...(cwd ? { cwd } : {}),
  });
  const generated = new Set();
  const fields = stdout.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, , value] = fields.slice(i, i + 3);
    if (value === "set" || value === "true") generated.add(path);
  }
  return generated;
}

/**
 * Sum the reviewable lines. A record is excluded when its path (or, for a
 * rename, either endpoint) is generated.
 */
export function countReviewableLines(records, generated) {
  let lines = 0;
  let excludedLines = 0;
  const excluded = [];
  for (const record of records) {
    const changed = record.added + record.deleted;
    if (generated.has(record.path) || (record.oldPath && generated.has(record.oldPath))) {
      excludedLines += changed;
      excluded.push(record.path);
    } else {
      lines += changed;
    }
  }
  return { lines, excludedLines, excluded };
}

/** Measure a PR's range (three-dot, as the other PR gates read it). */
export function measurePrSize(base, head, { cwd } = {}) {
  const stdout = execFileSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--numstat", "-z", `${base}...${head}`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...(cwd ? { cwd } : {}) },
  );
  const records = parseNumstat(stdout);
  const paths = [...new Set(records.flatMap((r) => (r.oldPath ? [r.path, r.oldPath] : [r.path])))];
  return countReviewableLines(records, generatedPaths(paths, { cwd, source: base }));
}

/**
 * The body's `large-pr:` reason, or null. It must start its own line
 * (optionally as a list item or in bold/code markers) and carry a non-empty
 * reason on that line. HTML comments and code fences are ignored
 * (`stripNonAnswerText`), so neither the template's own instruction nor a
 * quoted example can satisfy it.
 */
export function largePrReason(body) {
  const text = stripNonAnswerText(body);
  const match = /^[^\S\r\n]*(?:[-*+>][^\S\r\n]*)*[`*_]*large-pr:[`*_]*[^\S\r\n]*(\S[^\r\n]*?)[^\S\r\n]*\r?$/im.exec(
    text,
  );
  return match ? match[1] : null;
}

/**
 * The verdict, never `fail`: `pass` when the PR is within the threshold or
 * gives a reason, `warn` otherwise — including when the size could not be
 * measured (`size` is null), which is said rather than passed silently.
 */
export function prSizeVerdict(body, size) {
  if (!size) {
    return {
      status: "warn",
      message: "the PR's changed lines could not be measured (no diff range), so the size check did not run.",
    };
  }
  const { lines, excludedLines, excluded } = size;
  const counted =
    `${lines} changed line(s)` +
    (excluded.length > 0
      ? `, not counting ${excludedLines} in ${excluded.length} generated file(s) (${excluded.join(", ")})`
      : "");
  if (lines <= LARGE_PR_LINE_THRESHOLD) {
    return { status: "pass", outcome: "within-threshold", message: `${counted}.` };
  }
  const reason = largePrReason(body);
  if (reason) {
    return { status: "pass", outcome: "reason-given", message: `${counted}; large-pr: ${reason}` };
  }
  return {
    status: "warn",
    outcome: "large-without-reason",
    message:
      `${counted}, over the ${LARGE_PR_LINE_THRESHOLD}-line soft limit. Add a one-line ` +
      "`large-pr: <reason>` to the PR body, or split the PR (money work lands its pinning " +
      'tests first: docs/agents/ISSUE_WORKFLOW.md → "Plan deviation").',
  };
}

if (isMainModule(import.meta.url)) {
  // Soft by design: every outcome, including an error measuring the diff,
  // exits 0. A size check must never be the reason `verify` is red.
  try {
    const base = process.env.PR_BASE_SHA;
    const head = process.env.PR_HEAD_SHA;
    const size = base && head ? measurePrSize(base, head) : null;
    const fetchedBody = await fetchLivePrBody(GATE_LABEL);
    const body = selectPrBody({ fetchedBody, eventBody: readEventPrBody() });
    const verdict = prSizeVerdict(body, size);
    if (verdict.status === "pass") {
      console.log(`PR size check passed: ${verdict.message}`);
    } else {
      console.log(workflowCommand("warning", "Large PR (soft limit)", verdict.message));
    }
  } catch (error) {
    console.log(workflowCommand("warning", "Large PR (soft limit)", `${GATE_LABEL} could not run: ${error.message}`));
  }
}
