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
 * What counts as that link (`OWNER_ANSWER_LINK`): a GitHub issue, pull request
 * or discussion URL — normally the permalink of the owner's comment — or a
 * `#<number>` reference to the issue whose body records the decision (the
 * "Recording a decision" rule puts the deciding comment's link at the top of
 * that body). Prose such as "the owner agreed in chat" is not a link: a decision
 * nobody can open is one nobody can check.
 *
 * ROLLOUT (owner decision, 1 Nov 2026): the section ships as a WARNING for
 * seven days so open PRs can add it; a small follow-up PR then sets
 * `PLAN_DEVIATION_ENFORCED` to `true` and nothing else changes. While it is
 * `false` a missing or unlinked section prints a GitHub Actions `::warning::`
 * annotation and exits 0, and `pnpm run pr:check` reports WARN.
 *
 * Runs before `pnpm install --frozen-lockfile` in the `verify` job, so it uses
 * Node built-ins only.
 */
import process from "node:process";

import { workflowCommand } from "./dependency-mitigation.mjs";
import { fetchLivePrBody, readEventPrBody, selectPrBody } from "./pr-body.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

/**
 * THE SWITCH. `false` during the warning week; the follow-up PR flips it to
 * `true`, which turns every warning this gate gives into a failure of `verify`.
 */
export const PLAN_DEVIATION_ENFORCED = false;

export const PLAN_DEVIATION_HEADING = "## Plan Deviation";

const GATE_LABEL = "PR plan deviation check";

const HEADING_PATTERN = /^[^\S\r\n]*##[^\S\r\n]+Plan Deviation[^\S\r\n]*\r?$/im;

/**
 * A link to the owner's answer: a GitHub issue/PR/discussion URL (a comment
 * permalink is one of these with an `#issuecomment-…` anchor), or a `#<number>`
 * reference that is not part of a longer token such as `&#123;` or `a#1`.
 */
export const OWNER_ANSWER_LINK =
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull|discussions)\/\d+|(?<![\w&#/])#\d+\b/;

/** A top-level list item opener: `-`, `*`, `+` or `1.` / `1)`, at most 3 spaces in. */
const ITEM_START = /^ {0,3}(?:[-*+]|\d+[.)])(?:[^\S\r\n]+|$)/;

/**
 * Text the gate must not read as an answer: HTML comments (the template's own
 * instructions mention `None` and `#<number>`) and fenced code blocks (a body
 * explaining this gate may quote the heading).
 */
export function stripNonAnswerText(body) {
  return body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1[^\S\r\n]*$/gm, "");
}

class PlanDeviationError extends Error {}

/** The section's text, or null when the body has no `## Plan Deviation` heading. */
export function planDeviationSection(body) {
  const text = stripNonAnswerText(body);
  const match = HEADING_PATTERN.exec(text);
  if (!match) return null;
  const after = text.slice(match.index + match[0].length);
  const next = after.search(/\r?\n[^\S\r\n]*#{1,2}[^\S\r\n#]/);
  return next >= 0 ? after.slice(0, next) : after;
}

/** The section's items: each top-level list item with its continuation lines. */
export function planDeviationItems(section) {
  const items = [];
  for (const line of section.split(/\r?\n/)) {
    if (ITEM_START.test(line)) {
      items.push(line.replace(ITEM_START, ""));
    } else if (line.trim()) {
      if (items.length === 0) items.push("");
      items[items.length - 1] += `\n${line}`;
    }
  }
  return items.map((item) => item.trim()).filter(Boolean);
}

const isNone = (item) => /^none\b/i.test(item.replace(/[`*_~[\]]/g, "").trim());

/**
 * Decide the section. Returns `{ outcome }` or throws a `PlanDeviationError`
 * with an actionable message.
 */
export function validatePlanDeviation(body) {
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
  const unlinked = items.filter((item) => !OWNER_ANSWER_LINK.test(item));
  if (unlinked.length > 0) {
    const first = unlinked[0].split("\n")[0];
    throw new PlanDeviationError(
      `${unlinked.length} ${PLAN_DEVIATION_HEADING} item(s) do not link the owner's answer ` +
        `(first: "${first.length > 80 ? `${first.slice(0, 77)}...` : first}"). Each item needs ` +
        "the owner's comment URL (https://github.com/<owner>/<repo>/issues/<n>#issuecomment-<id>) " +
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
export function planDeviationVerdict(body, { enforced = PLAN_DEVIATION_ENFORCED } = {}) {
  try {
    const { outcome } = validatePlanDeviation(body);
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
