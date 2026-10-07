#!/usr/bin/env node
/**
 * Changelog fragment gate (issue #2452).
 *
 * Code-bearing pull requests must ship their changelog entry as a fragment file
 * in `changelog.d/` rather than as a direct edit to `CHANGELOG.md`, because
 * every branch editing the top of the same file conflicted daily across
 * parallel lanes (AGENTS.md "Change discipline", the fragment-directory rule).
 *
 * A PR passes when any one of these holds:
 *   1. it is not code-bearing (nothing outside tests changed under `src/` or
 *      `prisma/`) — docs-only, test-only and workflow-only PRs need no entry;
 *   2. it adds at least one `changelog.d/*.md` fragment;
 *   3. its body carries the explicit no-entry marker (`changelog: none`) on its
 *      own line, mirroring how a docs-only PR skips the entry today;
 *   4. TRANSITION ONLY — it edits `CHANGELOG.md` directly (see the note on
 *      `editsChangelogDirectly` below).
 *
 * Runs before `pnpm install --frozen-lockfile` in the `verify` job, so it uses Node built-ins only.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  fetchLivePrBody,
  gitDiffChangedFiles,
  parseNameStatus,
  selectPrBody,
} from "./pr-body.mjs";

const GATE_LABEL = "PR changelog fragment check";

/** Application and data-model source. A change here is code-bearing. */
const CODE_PATH = /^(?:src|prisma)\//;

/**
 * Pure test/spec files ship no behaviour of their own, so a test-only PR needs
 * no changelog entry. Same expression the concurrency gate uses, kept identical
 * on purpose so "code-bearing" means the same thing in both gates.
 */
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/** A compilable fragment: any `changelog.d/*.md` except the convention README. */
const FRAGMENT_PATH = /^changelog\.d\/(?!README\.md$)[^/]+\.md$/i;

/**
 * The explicit no-entry escape. Must start its own line (optionally inside a
 * list item or bold markers) so ordinary prose about the changelog cannot
 * switch the gate off by accident. Deliberately NOT present in
 * `.github/pull_request_template.md`: a marker pre-filled into every PR body
 * would disable the gate for everyone.
 */
const NONE_MARKER = /^[ \t]*(?:[-*+>][ \t]*)*[`*_]*changelog:[ \t]*none\b/im;

export function isCodeBearing(changedFiles) {
  return changedFiles.some((file) => CODE_PATH.test(file) && !TEST_FILE.test(file));
}

/**
 * Decide the gate over a parsed diff and the PR body.
 * `changes` is `[{ status, path }]` from `parseNameStatus`.
 * Throws with an actionable message when the PR needs a fragment and has none.
 */
export function validateChangelogFragment(body, changes = []) {
  const changedFiles = changes.map((change) => change.path);

  if (!isCodeBearing(changedFiles)) {
    return { outcome: "not-code-bearing" };
  }

  // Only an ADDED fragment counts. A release-compile PR deletes fragments, and
  // deleting somebody else's entry is not writing your own.
  if (changes.some((change) => change.status === "A" && FRAGMENT_PATH.test(change.path))) {
    return { outcome: "fragment-added" };
  }

  if (NONE_MARKER.test(body)) {
    return { outcome: "none-marker" };
  }

  // TRANSITION GRACE (#2452, adopted 1 Aug 2026). Pull requests opened before
  // the fragment convention landed carry their entry as a direct `CHANGELOG.md`
  // edit, and failing them would be a gate breaking work it was never meant to
  // judge. TIGHTEN LATER: once every PR open at adoption has merged or rebased,
  // delete this branch and its test ("accepts a direct CHANGELOG.md edit during
  // the transition") so a direct edit no longer satisfies the gate.
  if (changedFiles.some((file) => file === "CHANGELOG.md")) {
    return { outcome: "legacy-changelog-edit" };
  }

  throw new Error(
    "This PR changes application source, so it needs a changelog entry. Add a fragment file " +
      "(changelog.d/<pr-number>-<slug>.md — see changelog.d/README.md), or, if the change " +
      "genuinely needs no entry, put the no-entry marker documented in changelog.d/README.md " +
      "on its own line in the PR body.",
  );
}

const OUTCOME_MESSAGES = {
  "not-code-bearing": "no application source changed, so no changelog entry is required.",
  "fragment-added": "the PR adds a changelog.d fragment.",
  "none-marker": "the PR body declares that no changelog entry is needed.",
  "legacy-changelog-edit":
    "the PR edits CHANGELOG.md directly (accepted during the #2452 transition; " +
    "prefer a changelog.d fragment).",
};

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const base = process.env.PR_BASE_SHA;
    const head = process.env.PR_HEAD_SHA;
    // Fail closed: without the diff range every PR would look like it changed
    // nothing, which is the one classification that skips the gate entirely.
    if (!base || !head) {
      throw new Error(
        "PR_BASE_SHA and PR_HEAD_SHA must both be set so the changed files can be classified.",
      );
    }
    const changes = parseNameStatus(gitDiffChangedFiles(base, head));
    const fetchedBody = await fetchLivePrBody(GATE_LABEL);
    const body = selectPrBody({ fetchedBody, eventBody: process.env.PR_BODY });
    const { outcome } = validateChangelogFragment(body, changes);
    console.log(`Changelog entry check passed: ${OUTCOME_MESSAGES[outcome]}`);
  } catch (error) {
    console.error(`${GATE_LABEL} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
