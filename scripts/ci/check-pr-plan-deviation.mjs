#!/usr/bin/env node
/**
 * Plan-deviation gate (#4463).
 *
 * The owner's control point is the plan behind an issue, not the diff (owner
 * decision, 27 Oct 2026): a PR built to its plan merges on the agent merge gate,
 * and a MATERIAL deviation from that plan goes back to the owner first. The
 * definition of "material" is `docs/agents/ISSUE_WORKFLOW.md` → "Plan
 * deviation". This gate makes every PR say which of the two it is, in a
 * `## Plan Deviation` section whose answer is `None` or one item per deviation,
 * and each item must link the owner's answer.
 *
 * What counts as that link (`ownerAnswerLink`):
 *   - a GitHub issue, pull request or discussion URL in THIS repository —
 *     normally the permalink of the owner's comment. The repository is
 *     `GITHUB_REPOSITORY` in CI, else the `origin` remote's owner/name; a URL
 *     into any other repository is not this project's owner answering.
 *   - a bare `#<number>`, meant as the issue whose body records the decision
 *     (the "Recording a decision" rule puts the deciding comment's link at the
 *     top of that body). A bare `#n` is TRUSTED, not resolved: this gate runs
 *     offline, so "skipped step #2 of the plan" also passes. Reviewers read
 *     the reference; the gate only proves one was given.
 * Prose such as "the owner agreed in chat" is not a link: a decision nobody can
 * open is one nobody can check.
 *
 * ROLLOUT (owner decision, 1 Nov 2026): the section ships as a WARNING for
 * seven days so open PRs can add it; while `PLAN_DEVIATION_ENFORCED` is
 * `false` a missing, empty or unlinked section prints a GitHub Actions
 * `::warning::` annotation and exits 0, and `pnpm run pr:check` reports WARN.
 * The follow-up PR that makes it a failure changes exactly these:
 *   - `PLAN_DEVIATION_ENFORCED` below, to `true`;
 *   - the `::warning::` branch of this file's entrypoint and its "warning
 *     during the rollout week" text (the `fail` branch already exists);
 *   - tests: `check-pr-plan-deviation.test.mjs` "is in its warning week" (it
 *     fails when the warning sentences below disagree with the constant) and
 *     "prints a ::warning:: annotation…", and `check-pr-body.test.mjs`
 *     "reports a missing plan-deviation section as WARN…";
 *   - the texts that say "warning": the `## Plan Deviation` comment in
 *     `.github/pull_request_template.md`, the "WARNING ONLY" comment on the
 *     `Validate PR plan deviation` step in `.github/workflows/ci.yml`, and
 *     "Two PR-body checks warn rather than fail" in `CONTRIBUTING.md`;
 *   - the Dependabot exemption (owner decision): a dependency-only DIFF rule,
 *     the same kind the concurrency gate's #2726 waiver uses — never the
 *     author. Until then a Dependabot body, which cannot carry the section,
 *     only warns.
 *
 * Runs before `pnpm install --frozen-lockfile` in the `verify` job, so it uses
 * Node built-ins only.
 */
import process from "node:process";

import { execFileSync } from "node:child_process";

import { workflowCommand } from "./dependency-mitigation.mjs";
import { escapeRegex } from "./escape-regex.mjs";
import {
  fetchLivePrBody,
  readEventPrBody,
  sectionAfterHeading,
  selectPrBody,
  stripNonAnswerText,
} from "./pr-body.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

/**
 * THE SWITCH. `false` during the warning week; the follow-up PR flips it to
 * `true`, which turns every warning this gate gives into a failure of `verify`.
 */
export const PLAN_DEVIATION_ENFORCED = false;

export const PLAN_DEVIATION_HEADING = "## Plan Deviation";

const GATE_LABEL = "PR plan deviation check";

/**
 * This repository as `owner/name`: `GITHUB_REPOSITORY` when set (always, in
 * Actions), else parsed from the `origin` remote (a local `pr:check`), else
 * null — and with null no URL counts, only a `#<number>`.
 */
function readOriginUrl() {
  return execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * `readOrigin` is the `origin` URL, defaulting to `git remote get-url`. Tests
 * pass their own so a mirror checkout does not change the result.
 */
export function thisRepository(env = process.env, readOrigin = readOriginUrl) {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  try {
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(readOrigin())?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The link rule for one repository (see the header). The `#<number>` form must
 * not be part of a longer token such as `&#123;`, `a#1` or a URL's `/#1`.
 */
export function ownerAnswerLink(repository) {
  const reference = String.raw`(?<![\w&#/])#\d+\b`;
  if (!repository) return new RegExp(reference);
  const url = String.raw`https://github\.com/${escapeRegex(repository)}/(?:issues|pull|discussions)/\d+\b`;
  return new RegExp(`${url}|${reference}`, "i");
}

/** A list item opener: its indent, marker (`-`, `*`, `+`, `1.`, `1)`), and following spaces. */
const ITEM_MARKER = /^([^\S\r\n]*)([-*+]|\d+[.)])([^\S\r\n]+|$)/;

/** A thematic break (`* * *`, `---`), which is not a list item. */
const THEMATIC_BREAK = /^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/;

/** Column after `text`, counting a tab as the next stop of 4. */
function advanceColumn(column, text) {
  let next = column;
  for (const char of text) next = char === "\t" ? next + (4 - (next % 4)) : next + 1;
  return next;
}

class PlanDeviationError extends Error {}

/** The section's text with comments and fences removed, or null when there is no heading. */
export function planDeviationSection(body) {
  return sectionAfterHeading(stripNonAnswerText(body), PLAN_DEVIATION_HEADING);
}

/**
 * The section's answers.
 *
 * With list items: each item with its continuation lines. A marker line starts
 * a NEW item only when it sits left of the current item's content column (the
 * column its text starts in; a tab is the next stop of 4), so `  - it is
 * nullable` under `- Added a column` is part of that item, not an unlinked
 * item of its own. A thematic break is skipped. Prose before the first marker
 * ("One deviation, agreed with the owner:") is an introduction, not an answer,
 * and is ignored. A blank line and then an unindented paragraph is not part of
 * the item above it.
 *
 * With no list items: the whole of the prose is one answer, which is how a
 * plain `None` line is read.
 */
export function planDeviationItems(section) {
  const lines = section.split(/\r?\n/);
  const first = lines.findIndex((line) => ITEM_MARKER.test(line) && !THEMATIC_BREAK.test(line));
  if (first < 0) {
    const prose = lines
      .filter((line) => !THEMATIC_BREAK.test(line))
      .join("\n")
      .trim();
    return prose ? [prose] : [];
  }
  const items = [];
  let contentColumn = -1;
  let sawBlank = false;
  let ignoringLoose = false;
  for (const line of lines.slice(first)) {
    if (THEMATIC_BREAK.test(line)) continue;
    if (!line.trim()) {
      sawBlank = true;
      continue;
    }
    const marker = ITEM_MARKER.exec(line);
    const indent = advanceColumn(0, marker ? marker[1] : (/^[^\S\r\n]*/.exec(line)?.[0] ?? ""));
    if (marker && (contentColumn < 0 || indent < contentColumn)) {
      contentColumn = advanceColumn(advanceColumn(0, marker[1] + marker[2]), marker[3] || " ");
      items.push(line.slice(marker[0].length));
      sawBlank = false;
      ignoringLoose = false;
    } else if (ignoringLoose || (sawBlank && indent === 0)) {
      ignoringLoose = true;
      sawBlank = false;
    } else {
      items[items.length - 1] += `\n${line}`;
      sawBlank = false;
    }
  }
  return items.map((item) => item.trim()).filter(Boolean);
}

/**
 * `None` by itself, or with a trailing full stop or a dash-led note
 * (`None — built to the plan.`). `None, except …` is an answer, not None.
 */
const NONE_ANSWER = /^none(?:\s*[.!]|\s*[—–-]\s+\S.*)?\s*$/i;

const isNone = (item) => NONE_ANSWER.test(item.replace(/[`*_~[\]]/g, "").trim());

/** A Markdown link counts by its target, so link text `#1` cannot launder another repository's URL. */
function answerLinks(item) {
  return item.replace(/!?\[(?:[^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, "$1");
}

/**
 * Decide the section. Returns `{ outcome }` or throws a `PlanDeviationError`
 * with an actionable message.
 */
export function validatePlanDeviation(body, { repository = thisRepository() } = {}) {
  const section = planDeviationSection(body ?? "");
  if (section === null) {
    throw new PlanDeviationError(
      `PR body must include ${PLAN_DEVIATION_HEADING}, answered \`None\` or with one item per ` +
        "material deviation from the issue's plan, each linking the owner's answer " +
        '(docs/agents/ISSUE_WORKFLOW.md → "Plan deviation"). Copy the section from ' +
        ".github/pull_request_template.md.",
    );
  }
  const items = planDeviationItems(section);
  if (items.length === 0) {
    throw new PlanDeviationError(
      `${PLAN_DEVIATION_HEADING} is empty. Write \`None\` when the PR is built to the issue's plan, ` +
        "or list each material deviation with a link to the owner's answer.",
    );
  }
  if (items.some(isNone)) {
    if (items.length === 1) return { outcome: "none" };
    throw new PlanDeviationError(
      `${PLAN_DEVIATION_HEADING} says \`None\` and also lists items. Keep \`None\` only when ` +
        "there is no material deviation; otherwise remove it and link each item to the owner's answer.",
    );
  }
  const link = ownerAnswerLink(repository);
  const unlinked = items.filter((item) => !link.test(answerLinks(item)));
  if (unlinked.length > 0) {
    const first = unlinked[0].split("\n")[0];
    throw new PlanDeviationError(
      `${unlinked.length} ${PLAN_DEVIATION_HEADING} item(s) do not link the owner's answer ` +
        `(first: "${first.length > 80 ? `${first.slice(0, 77)}...` : first}"). Each item needs ` +
        `the owner's comment URL (https://github.com/${repository ?? "<owner>/<repo>"}/issues/<n>#issuecomment-<id>) ` +
        "or the `#<number>` of the issue whose body records the decision. A deviation the owner " +
        "has not answered yet goes to the owner before this PR is ready.",
    );
  }
  return { outcome: "listed", count: items.length };
}

const OUTCOME_MESSAGES = {
  none: "the PR declares no material deviation from its plan.",
  listed: "every listed deviation links the owner's answer.",
};

/**
 * The gate's verdict with the rollout switch applied: `pass`, or — for a body
 * that fails `validatePlanDeviation` — `warn` while `enforced` is false and
 * `fail` once it is true. `enforced` is a parameter only so tests can drive
 * both states; every caller leaves it to the constant.
 */
export function planDeviationVerdict(body, { enforced = PLAN_DEVIATION_ENFORCED, repository } = {}) {
  try {
    const { outcome } = validatePlanDeviation(body, repository === undefined ? {} : { repository });
    return { status: "pass", outcome, message: OUTCOME_MESSAGES[outcome] };
  } catch (error) {
    if (!(error instanceof PlanDeviationError)) throw error;
    return { status: enforced ? "fail" : "warn", message: error.message };
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const fetchedBody = await fetchLivePrBody(GATE_LABEL);
    const body = selectPrBody({ fetchedBody, eventBody: readEventPrBody() });
    const verdict = planDeviationVerdict(body);
    if (verdict.status === "pass") {
      console.log(`PR plan deviation check passed: ${verdict.message}`);
    } else if (verdict.status === "warn") {
      console.log(
        workflowCommand(
          "warning",
          "Plan deviation (warning only, #4463 rollout)",
          `${verdict.message} This is a warning during the rollout week; it becomes a failure of verify.`,
        ),
      );
    } else {
      console.error(`${GATE_LABEL} failed: ${verdict.message}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`${GATE_LABEL} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
