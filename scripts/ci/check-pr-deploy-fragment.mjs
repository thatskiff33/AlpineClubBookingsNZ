#!/usr/bin/env node
/**
 * After-deploy step gate (#5379, owner decision D3, 22 Nov 2026).
 *
 * A step someone must do once a release is deployed used to live only in the
 * pull request's description, and was found again — or not — when someone read
 * every merged description by hand (#5378). Now it is a
 * `changelog.d/<pr-number>-<slug>.deploy.md` fragment written in the same pull
 * request (`scripts/lib/deploy-fragments.mjs`), and the release cutter files it.
 *
 * A PR fails when:
 *   1. its "Manual Checks Required" or "Migration Or Deployment Impact" section
 *      names a step for after the deploy or the release ("after deploy", "after
 *      the release", "owner runs", "once after upgrading", …) and the diff adds
 *      or changes no `.deploy.md` fragment. A release-prep PR, which deletes
 *      the fragments it files and edits `CHANGELOG.md`, is exempt: its body
 *      describes the steps it is filing. There is no escape marker: a PR with
 *      no such step says so without the phrase;
 *   2. a `.deploy.md` fragment it adds or changes is malformed;
 *   3. its diff is unknown, since neither rule can then be judged.
 *
 * HTML comments and fenced code are not read as answers, so the template's
 * own guidance never trips it. Runs before `pnpm install --frozen-lockfile` in
 * the `verify` job, so it uses Node built-ins only.
 */
import path from "node:path";
import process from "node:process";

import { gitContentsReader } from "./check-pr-concurrency-declaration.mjs";
import {
  fetchLivePrBody,
  gitDiffChangedFiles,
  parseNameStatus,
  readEventPrBody,
  sectionAfterHeading,
  selectPrBody,
  stripNonAnswerText,
} from "./pr-body.mjs";
import { DEPLOY_FRAGMENT_SUFFIX, deployFragmentProblems, isDeployFragmentName } from "../lib/deploy-fragments.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

const GATE_LABEL = "PR after-deploy step check";

/** The body sections where a pull request names what has to happen around its deploy. */
export const DEPLOY_STEP_SECTIONS = Object.freeze(["## Manual Checks Required", "## Migration Or Deployment Impact"]);

/** Phrases that name a step for after the deploy or the release. */
const AFTER_DEPLOY_PHRASES = [
  /\bafter[ -](?:the[ -])?deploy(?:ing|ment|s|ed)?\b/i,
  /\bpost[ -]deploy(?:ment)?\b/i,
  /\bafter (?:the|this|each) release\b/i,
  /\bowner runs?\b/i,
  /\bonce after upgrading\b/i,
];

const isDeployFragmentPath = (file) => /^changelog\.d\/[^/]+$/i.test(file) && isDeployFragmentName(path.posix.basename(file));

/**
 * The first phrase in the step sections of `body` naming an after-deploy step,
 * as `{ section, phrase }`, or `null`. Comments and fenced code are skipped.
 */
export function afterDeployMention(body) {
  const answers = stripNonAnswerText(body);
  for (const heading of DEPLOY_STEP_SECTIONS) {
    const section = sectionAfterHeading(answers, heading);
    if (section === null) continue;
    for (const pattern of AFTER_DEPLOY_PHRASES) {
      const match = pattern.exec(section);
      if (match) return { section: heading, phrase: match[0] };
    }
  }
  return null;
}

/**
 * Decide the gate over the PR body and its diff (`[{ status, path }]` from
 * `parseNameStatus`, or `null` when the diff is unknown). `contentsOf(file)`
 * returns `[headText, baseText?]` (`gitContentsReader`). Throws with an
 * actionable message on a failure; returns `{ outcome }` on a pass.
 */
export function validateDeployFragment(body, changes, { contentsOf } = {}) {
  if (!Array.isArray(changes)) {
    throw new Error(
      "The PR diff is unknown, so whether it carries its after-deploy steps cannot be decided. " +
        "Make the diff readable (PR_BASE_SHA and PR_HEAD_SHA in CI; fetch the base branch or pass --base locally).",
    );
  }
  const written = changes.filter((change) => (change.status === "A" || change.status === "M") && isDeployFragmentPath(change.path));
  const malformed = [];
  for (const change of written) {
    if (typeof contentsOf !== "function") throw new Error(`Cannot read ${change.path} at the PR head to check it.`);
    const problems = deployFragmentProblems(path.posix.basename(change.path), contentsOf(change.path)[0]);
    if (problems.length > 0) malformed.push(`${change.path}: ${problems.join("; ")}.`);
  }
  if (malformed.length > 0) {
    throw new Error(
      `${malformed.length} after-deploy step fragment(s) are malformed (changelog.d/README.md, "After-deploy steps"):\n` +
        malformed.map((line) => `  - ${line}`).join("\n"),
    );
  }
  if (written.length > 0) return { outcome: "fragment-present" };

  const mention = afterDeployMention(body);
  if (mention === null) return { outcome: "no-step" };
  const releasePrep =
    changes.some((change) => change.status === "D" && isDeployFragmentPath(change.path)) &&
    changes.some((change) => change.path === "CHANGELOG.md");
  if (releasePrep) return { outcome: "release-prep" };
  throw new Error(
    `"${mention.section}" names a step for after the deploy ("${mention.phrase}"), but the PR adds no ` +
      `changelog.d/<pr-number>-<slug>${DEPLOY_FRAGMENT_SUFFIX} fragment. Write each such step as one ` +
      `(changelog.d/README.md, "After-deploy steps") so the release's post-deploy checklist carries it. ` +
      "If there is no such step, say so without that phrase.",
  );
}

const OUTCOME_MESSAGES = {
  "fragment-present": "the PR writes its after-deploy steps as well-formed changelog.d fragments.",
  "no-step": "the PR names no step for after the deploy.",
  "release-prep": "a release-prep PR files the after-deploy steps it deletes.",
};

/** The line a passing run prints. */
export function deployFragmentPassMessage(outcome) {
  return `After-deploy step check passed: ${OUTCOME_MESSAGES[outcome]}`;
}

if (isMainModule(import.meta.url)) {
  try {
    const base = process.env.PR_BASE_SHA;
    const head = process.env.PR_HEAD_SHA;
    if (!base || !head) {
      throw new Error("PR_BASE_SHA and PR_HEAD_SHA must both be set so the changed files can be read.");
    }
    const changes = parseNameStatus(gitDiffChangedFiles(base, head));
    const fetchedBody = await fetchLivePrBody(GATE_LABEL);
    const body = selectPrBody({ fetchedBody, eventBody: readEventPrBody() });
    const { outcome } = validateDeployFragment(body, changes, { contentsOf: gitContentsReader({ base, head }) });
    console.log(deployFragmentPassMessage(outcome));
  } catch (error) {
    console.error(`${GATE_LABEL} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
