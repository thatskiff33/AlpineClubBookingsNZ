#!/usr/bin/env node
/**
 * Read a GitHub issue the way it has to be read: body AND every comment, in one
 * command, with the decision state called out.
 *
 *   npm run issue -- 2777
 *   npm run issue -- https://github.com/<owner>/<repo>/issues/2777
 *
 * ## Why this exists
 *
 * `gh issue view <n>` prints the body. Comments need `--comments` or
 * `--json comments`. **The short, obvious, default command returns the stale
 * half** — and in this repository the decision is very often in a comment, made
 * after the body was written. So an agent reads a list of unticked
 * `- [ ] **Recommended** …` options, concludes the question is open, and either
 * re-asks the owner something they already answered or builds the option they
 * rejected. That happened again on #2777: four unticked options in the body, the
 * owner's decision sitting in a comment from the previous evening.
 *
 * `AGENTS.md` says to read the comments. `CLAUDE.md` says it. There is a memory
 * note about it. It kept happening anyway, because instructions lose to
 * ergonomics: the cheap command was the incomplete one. This script makes the
 * complete read the cheap one, which is the only version of this rule that has
 * ever held (epic #2680's thesis — a rule enforced by review drifts, a rule
 * enforced mechanically holds).
 *
 * ## There is deliberately no flag that prints less
 *
 * No `--body-only`, no `--no-comments`, no `--quiet`. A short flag that returns
 * the stale half would rebuild the exact foot-gun this replaces, and it would be
 * reached for under time pressure — which is when the mistake is made. Anyone
 * who genuinely wants only the body still has `gh` itself; this tool has one
 * behaviour and it is the complete one.
 *
 * ## What it decides, and what it only reports
 *
 * The **stale-body warning** is the load-bearing output: the body still presents
 * unticked options while a comment records a decision. That is the precise state
 * that causes the failure above, so it is printed loudly, at the top, before
 * anything else. Everything else here is reporting — the thread is printed in
 * full and in order, and the reader still does the reading.
 *
 * Detection is pattern-matching over prose, so it is a smoke alarm, not a judge.
 * It can miss a decision written in a form nobody has used before, and it can
 * flag a comment that merely discusses one. Both failure modes are noisy rather
 * than silent: the full thread is printed either way.
 *
 * The fix for a thread this flags is in `docs/agents/ISSUE_WORKFLOW.md` →
 * "Recording a decision: the body must carry the answer" — the body gets a
 * `> **DECIDED …**` header and its option list struck through. That is a binding
 * obligation on whoever records the decision, not a nicety.
 */
import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** How many `#NNNN` references from the body get a state lookup. */
export const LINKED_ISSUE_LIMIT = 12;

/**
 * The `> **DECIDED …**` header the issue-body convention requires.
 *
 * Anchored to the start of a line and to the bold marker so that prose merely
 * containing the word "decided" cannot satisfy it. The blockquote marker is
 * optional because the header still does its job unquoted.
 */
export const DECIDED_HEADER_PATTERN = /^\s{0,3}>?\s*\*\*DECIDED\b/m;

/**
 * The shapes a decision record actually takes in this repository's issue
 * threads. These are observed, not invented — `## Owner decision` headings,
 * the owner's `ready to action` go-ahead, and the three "decisions
 * recorded/added/taken" phrasings orchestrator sessions post after a planning
 * pass.
 *
 * Kept deliberately broad. A false positive costs a reader ten seconds of
 * checking a comment that turned out to be discussion; a false negative is the
 * whole failure this file exists to stop.
 */
export const DECISION_MARKERS = [
  {
    id: "owner-decision",
    label: "an `Owner decision` heading",
    pattern: /^#{1,6}\s*\**\s*owner decision\b/im,
  },
  {
    id: "ready-to-action",
    label: "the `ready to action` go-ahead",
    pattern: /\bready to action\b/i,
  },
  {
    id: "decisions-recorded",
    label: "a `Decisions recorded` note",
    pattern: /\bdecisions?\s+recorded\b/i,
  },
  {
    id: "decisions-added",
    label: "a `Decisions added` note",
    pattern: /\bdecisions?\s+added\b/i,
  },
  {
    id: "decision-taken",
    label: "a `Decision taken` note",
    pattern: /\bdecisions?\s+taken\b/i,
  },
  {
    id: "orchestrator-decision",
    label: "an `orchestrator decision`",
    pattern: /\borchestrator decision\b/i,
  },
  {
    id: "decided-header",
    label: "a `DECIDED` header",
    pattern: DECIDED_HEADER_PATTERN,
  },
];

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const CHECKBOX_PATTERN = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/;
const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/;

/** Which decision markers `text` carries, as marker records. */
export function detectDecisionMarkers(text) {
  if (!text) return [];
  return DECISION_MARKERS.filter((marker) => marker.pattern.test(text));
}

/** Does this body already carry the `> **DECIDED …**` header? */
export function hasDecidedHeader(body) {
  return DECIDED_HEADER_PATTERN.test(body ?? "");
}

/** Strip the markdown that makes an option label noisy in a one-line summary. */
function plainLabel(text) {
  const stripped = text
    .replace(/~~/g, "")
    .replace(/\*\*/g, "")
    .replace(/[`*_]/g, "")
    .trim();
  return stripped.length > 96 ? `${stripped.slice(0, 95)}…` : stripped;
}

/**
 * The decision options in an issue body, split by whether they are ticked.
 *
 * Scoped to a `## Decisions` section where the body has one, because a body's
 * other checkbox lists are not decisions — an issue's "Acceptance criteria"
 * block is unticked for the entirely normal reason that the work has not been
 * done yet, and counting those would make the stale warning fire on every open
 * issue and be ignored within a day.
 *
 * A nested heading (`### D1 — …`) stays inside the section; the next heading at
 * the same level or higher closes it. Where there is no such section the
 * fallback is narrow on purpose: only checkbox lines that name themselves
 * "Recommended" / "Not recommended", which is this repository's house format for
 * an owner-facing option list.
 *
 * Fenced code is skipped, so a body quoting an example option list does not
 * register one.
 */
export function decisionOptions(body) {
  const lines = (body ?? "").split(/\r?\n/);
  const ticked = [];
  const unticked = [];
  let sectionLevel = null;
  let hasSection = false;
  let fence = null;

  for (const line of lines) {
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (sectionLevel !== null && level <= sectionLevel) sectionLevel = null;
      const title = heading[2].replace(/[*_`#]/g, "").trim();
      if (/^decisions?\b/i.test(title)) {
        sectionLevel = level;
        hasSection = true;
      }
      continue;
    }

    const checkbox = CHECKBOX_PATTERN.exec(line);
    if (!checkbox) continue;

    const inSection = sectionLevel !== null;
    const looksLikeAnOption = /\brecommended\b/i.test(checkbox[2]);
    if (!inSection && !(!hasSection && looksLikeAnOption)) continue;

    (checkbox[1] === " " ? unticked : ticked).push(plainLabel(checkbox[2]));
  }

  return { hasSection, ticked, unticked };
}

/**
 * The whole point of the tool, as one value.
 *
 * `stale` is true for exactly one state: the body still offers unticked
 * options, at least one comment records a decision, and the body carries no
 * `DECIDED` header. That is the misread that produces wrong builds, so it is
 * the only thing raised to a warning; everything else is reported neutrally.
 *
 * `bodySilent` is the softer sibling — a decision exists in a comment and the
 * body neither ticks anything nor says so. Worth telling the reader about,
 * not worth shouting, because there is no open-looking option list to be
 * misled by.
 */
export function assessThread({ body = "", comments = [] } = {}) {
  const options = decisionOptions(body);
  const decided = hasDecidedHeader(body);

  const decisionComments = comments
    .map((comment, index) => ({
      index,
      author: comment?.author?.login ?? "unknown",
      createdAt: comment?.createdAt ?? "",
      url: comment?.url ?? "",
      markers: detectDecisionMarkers(comment?.body ?? ""),
    }))
    .filter((comment) => comment.markers.length > 0);

  const stale =
    decisionComments.length > 0 && options.unticked.length > 0 && !decided;

  const bodySilent =
    decisionComments.length > 0 &&
    !decided &&
    !stale &&
    options.ticked.length === 0;

  let verdict;
  if (stale) verdict = "stale-body";
  else if (decided) verdict = "decided-in-body";
  else if (bodySilent) verdict = "body-silent";
  else if (decisionComments.length > 0) verdict = "decided";
  else if (options.unticked.length > 0) verdict = "open";
  else verdict = "no-decision-found";

  return {
    verdict,
    stale,
    bodySilent,
    hasDecidedHeader: decided,
    options,
    decisionComments,
  };
}

/** Issue numbers this body points at, deduped and in ascending order. */
export function referencedIssueNumbers(body, self) {
  const found = new Set();
  for (const match of (body ?? "").matchAll(/(?:^|[\s([{,;:])#(\d{1,7})\b/g)) {
    const number = Number(match[1]);
    if (number !== self) found.add(number);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The banner. Written to be read by somebody who is about to skim, so the
 * stale case says what to do rather than only what is wrong.
 */
export function renderDecisionSummary(assessment) {
  const lines = ["DECISION SUMMARY"];
  const { options, decisionComments } = assessment;

  if (assessment.stale) {
    lines.push(
      "",
      "  !! STALE BODY — DO NOT TRUST THE OPTION LIST ABOVE THE COMMENTS !!",
      "",
      `  The body still offers ${options.unticked.length} unticked option(s), and ${decisionComments.length} comment(s)`,
      "  record a decision. The body is the stale half. Read the comment(s) listed",
      "  below before you plan, brief a subagent, or ask the owner anything.",
      "",
      "  Whoever recorded that decision owes this issue a body update:",
      "  docs/agents/ISSUE_WORKFLOW.md -> \"Recording a decision: the body must",
      "  carry the answer\". Doing it now is part of reading this thread.",
    );
  } else if (assessment.verdict === "decided-in-body") {
    lines.push(
      "",
      "  Decided, and the body says so (it carries a DECIDED header).",
    );
  } else if (assessment.verdict === "body-silent") {
    lines.push(
      "",
      "  A comment records a decision; the body neither ticks an option nor",
      "  carries a DECIDED header. Read the comment(s) below — and add the header",
      "  (docs/agents/ISSUE_WORKFLOW.md) so the next reader does not have to.",
    );
  } else if (assessment.verdict === "decided") {
    lines.push("", "  A comment records a decision, and no option is left open.");
  } else if (assessment.verdict === "open") {
    lines.push(
      "",
      `  No decision comment found, and ${options.unticked.length} option(s) are unticked.`,
      "  This one really does look open — but detection is pattern-matching, so",
      "  read the comments below rather than trusting this line.",
    );
  } else {
    lines.push("", "  Nothing decision-shaped found in the body or the comments.");
  }

  if (options.ticked.length > 0) {
    lines.push("", "  Ticked in the body:");
    for (const label of options.ticked) lines.push(`    [x] ${label}`);
  }
  if (options.unticked.length > 0) {
    lines.push("", "  Still unticked in the body:");
    for (const label of options.unticked) lines.push(`    [ ] ${label}`);
  }
  if (decisionComments.length > 0) {
    lines.push("", "  Comments that look like a decision record:");
    for (const comment of decisionComments) {
      lines.push(
        `    #${comment.index + 1} by ${comment.author} on ${comment.createdAt} — ${comment.markers
          .map((marker) => marker.label)
          .join(", ")}`,
      );
      if (comment.url) lines.push(`       ${comment.url}`);
    }
  }

  return lines.join("\n");
}

const RULE = "=".repeat(78);
const THIN_RULE = "-".repeat(78);

function ghJson(args) {
  try {
    return JSON.parse(
      execFileSync("gh", args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "The GitHub CLI (`gh`) is not on PATH. Install it from https://cli.github.com/ and run `gh auth login`.",
      );
    }
    const stderr = String(error?.stderr ?? "").trim();
    if (/auth login|not logged|authentication|HTTP 401/i.test(stderr)) {
      throw new Error(
        `GitHub CLI is not authenticated for this repository. Run \`gh auth login\` (or \`gh auth status\` to see why).\n${stderr}`,
      );
    }
    if (stderr) throw new Error(`\`gh ${args.join(" ")}\` failed:\n${stderr}`);
    throw error;
  }
}

/** Accepts `2777`, `#2777`, or the issue URL. Nothing else, and no flags. */
export function parseIssueArgument(argv) {
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const flags = argv.filter((arg) => arg.startsWith("-"));
  if (flags.length > 0) {
    throw new Error(
      `This tool takes an issue number and nothing else — it has no flags, deliberately (see the header of scripts/issue-thread.mjs). Unrecognised: ${flags.join(" ")}`,
    );
  }
  if (positional.length !== 1) {
    throw new Error("Usage: npm run issue -- <issue-number|issue-url>");
  }
  const match = /(?:^|\/|#)(\d{1,7})\s*$/.exec(positional[0]);
  if (!match) {
    throw new Error(`Not an issue number or issue URL: ${positional[0]}`);
  }
  return Number(match[1]);
}

function main(argv) {
  const number = parseIssueArgument(argv);
  const issue = ghJson([
    "issue",
    "view",
    String(number),
    "--json",
    "number,title,state,stateReason,url,author,createdAt,updatedAt,labels,assignees,body,comments",
  ]);

  const comments = issue.comments ?? [];
  const assessment = assessThread({ body: issue.body, comments });

  const out = [];
  out.push(RULE);
  out.push(`#${issue.number}  ${issue.title}`);
  out.push(RULE);
  out.push(`State:      ${issue.state}${issue.stateReason ? ` (${issue.stateReason})` : ""}`);
  out.push(`URL:        ${issue.url}`);
  out.push(`Opened:     ${issue.author?.login ?? "unknown"} on ${issue.createdAt}`);
  out.push(`Updated:    ${issue.updatedAt}`);
  out.push(
    `Labels:     ${(issue.labels ?? []).map((label) => label.name).join(", ") || "none"}`,
  );
  out.push(
    `Assignees:  ${(issue.assignees ?? []).map((a) => a.login).join(", ") || "none"}`,
  );
  out.push(`Comments:   ${comments.length}`);
  out.push("");
  out.push(RULE);
  out.push(renderDecisionSummary(assessment));
  out.push(RULE);
  out.push("");
  out.push("BODY");
  out.push(THIN_RULE);
  out.push(issue.body?.trim() ? issue.body.trimEnd() : "(no body)");
  out.push("");

  out.push(RULE);
  out.push(`COMMENTS (${comments.length}, oldest first)`);
  out.push(RULE);
  if (comments.length === 0) {
    out.push("(none — and that is a fact worth having, not an absence of output)");
  }
  comments.forEach((comment, index) => {
    const markers = detectDecisionMarkers(comment?.body ?? "");
    out.push("");
    out.push(THIN_RULE);
    out.push(
      `comment ${index + 1}/${comments.length} — ${comment?.author?.login ?? "unknown"} on ${comment?.createdAt ?? "unknown date"}${
        markers.length > 0 ? "   <<< looks like a DECISION RECORD" : ""
      }`,
    );
    if (comment?.url) out.push(comment.url);
    out.push(THIN_RULE);
    out.push((comment?.body ?? "").trimEnd() || "(empty comment)");
  });
  out.push("");

  const referenced = referencedIssueNumbers(issue.body, issue.number);
  out.push(RULE);
  out.push(`ISSUES REFERENCED BY THE BODY (${referenced.length})`);
  out.push(RULE);
  if (referenced.length === 0) {
    out.push("(none)");
  }
  for (const linked of referenced.slice(0, LINKED_ISSUE_LIMIT)) {
    let line;
    try {
      const other = ghJson([
        "issue",
        "view",
        String(linked),
        "--json",
        "number,title,state,body,comments",
      ]);
      const otherAssessment = assessThread({
        body: other.body,
        comments: other.comments ?? [],
      });
      const note =
        otherAssessment.verdict === "stale-body"
          ? "decision in a comment, body still open — STALE"
          : otherAssessment.decisionComments.length > 0
            ? "has a decision comment"
            : "no decision comment";
      line = `#${other.number} [${other.state}] ${note} — ${other.title}`;
    } catch {
      line = `#${linked} — could not be read (deleted, a pull request, or another repository)`;
    }
    out.push(line);
  }
  if (referenced.length > LINKED_ISSUE_LIMIT) {
    out.push(
      `… and ${referenced.length - LINKED_ISSUE_LIMIT} more, not looked up (limit ${LINKED_ISSUE_LIMIT}).`,
    );
  }

  if (assessment.stale) {
    out.push("");
    out.push(RULE);
    out.push(renderDecisionSummary(assessment));
    out.push(RULE);
  }

  console.log(out.join("\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`issue-thread: ${error.message}`);
    process.exit(1);
  }
}
