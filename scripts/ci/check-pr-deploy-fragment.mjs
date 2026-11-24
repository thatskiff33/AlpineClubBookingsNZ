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
 *      release", "post-release", "once deployed", "the owner should run",
 *      "after the upgrade", `WHEN_WORDS`) and the diff adds or changes no
 *      `.deploy.md` fragment. A negated answer names no step: "None. No
 *      after-deploy step." and "None after deploy." pass, unless its clause
 *      goes on "unless", "if", "but" or "except". A release-prep PR, which
 *      deletes the fragments it files, edits `CHANGELOG.md` and changes
 *      nothing outside the paths `release:cut prepare` writes
 *      (`RELEASE_PREP_PATHS`), is exempt: its body describes the steps it is
 *      filing. There is no escape marker or phrase (owner decision, 25 Nov
 *      2026): a sentence that only describes behaviour after the deploy is
 *      reworded;
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
import { RELEASE_PREP_PATHS } from "../release/cut-release.mjs";

const GATE_LABEL = "PR after-deploy step check";

/** The body sections where a pull request names what has to happen around its deploy. */
export const DEPLOY_STEP_SECTIONS = Object.freeze(["## Manual Checks Required", "## Migration Or Deployment Impact"]);

/** The space between two words: spaces, or one line break where the text wraps. */
const GAP = String.raw`(?:[ \t]+|[ \t]*\r?\n[ \t]*)`;

/** `source` with each space read as a `GAP`, and each `[ -]` as a hyphen or a `GAP`. */
function wrapping(source) {
  return source
    .split("[ -]")
    .map((part) => part.split(" ").join(GAP))
    .join(`(?:-|${GAP})`);
}

/**
 * When a step would happen, one source each, case-insensitive: "after deploy",
 * "post-deploy", "after the next deploy"; "after release", "after the new
 * release", "post-release" (not "after release-prep merges", nor "after this
 * release's webhook", where a possessive names a thing of the release, though
 * "after this release's deploy" still names a time, `RELEASE_EVENT`); "after
 * the new colour"; "after upgrading", "after the upgrade"; "after cutover";
 * "once this ships", "once deployed", "once it is live", "once the new release
 * is serving". The gate reads them as a step, and the negated answer
 * below reads the same list, so the two cannot drift apart. A space in a
 * source is a `GAP` and `[ -]` a hyphen or a `GAP` (`wrapping`), so a phrase
 * that wraps onto the next line is still read.
 */
/**
 * A release's event, so "after this release's deploy" and "after the new
 * release's migration finishes" still name a time; any other noun after the
 * possessive ("after this release's webhook sent one", #5471) does not.
 */
const RELEASE_EVENT = String.raw`(?:(?:first|initial|full|schema|database|data)\s+)?(?:deploy|migrat|upgrad|roll-?out|cut-?over|release|launch|go-?live|backfill|switch)`;
/** After "release": not "release-prep", nor a possessive unless an event follows it. */
const NOT_RELEASE_THING = String.raw`(?!-|['’]s\b(?!\s+${RELEASE_EVENT}))`;

const WHEN_WORDS = [
  String.raw`(?:after|post)[ -](?:(?:the|this|each|a)[ -])?(?:(?:next|new)[ -])?deploy(?:ing|ment|s|ed)?\b`,
  String.raw`after (?:(?:the|this|each|a) )?(?:new )?release\b${NOT_RELEASE_THING}`,
  String.raw`post[ -]release\b${NOT_RELEASE_THING}`,
  String.raw`after (?:the )?new colou?r\b`,
  String.raw`after (?:(?:the|this|an?) )?upgrad(?:e|ing)\b`,
  String.raw`(?:after|post)[ -](?:the )?cut-?over\b`,
  String.raw`once (?:this|it) ships\b`,
  String.raw`once (?:(?:this|it|the (?:new )?(?:release|colou?r|version)) (?:is|has been) )?(?:deployed|released|live|serving)\b`,
].map(wrapping);

/** Phrases that name a step for after the deploy or the release, in the order they are reported. */
const AFTER_DEPLOY_PHRASES = [
  ...WHEN_WORDS.map((source) => new RegExp(String.raw`\b${source}`, "i")),
  new RegExp(wrapping(String.raw`\b(?:owner|operator) (?:(?:should|must|will|needs to) )?runs?\b`), "i"),
];

const WHEN = `(?:${WHEN_WORDS.join("|")})`;
const FILLER = String.raw`(?:manual|further|other|extra|separate|additional|special|owner|operator|deploy(?:ment)?|steps?|actions?|checks?|tasks?|work|is|are|needed|required|necessary|to[ \t]+do)`;
/** The rest of a clause: it ends at a full stop, a semicolon or the line's end. */
const CLAUSE_REST = String.raw`[^.;\n]*`;
/** A word after a negation that makes it conditional, or turns to a step: "unless SMTP is set", "but run …". */
const UNLESS = String.raw`\b(?:unless|if|but|except)\b`;

/**
 * A negated answer: "no", "none" or "nothing" and an after-deploy word in one
 * clause, such as "None. No after-deploy step.", "None after deploy." or
 * "Nothing to do after release." (house idioms on many merged PRs), or the
 * word first, as in "After deploy: nothing". Only the negation itself is
 * blanked, so the rest of its clause is still read: "After deploy nothing
 * breaks, and the owner should run …" names a step. Only a few filler words
 * may stand between them, so "No migration, but after deploy run …" still
 * names a step, and "None before merge. After deploy, …" does too: the full
 * stop ends the clause. One line break may stand between two of its words,
 * where a wrapped answer breaks (`withoutNegatedAnswers` says when). It is not
 * a negation when the rest of its clause says "unless", "if", "but" or
 * "except": "No step is needed after deploy unless SMTP is set; then set FOO."
 * and "After deploy, nothing changes for members, but run …" name a step.
 */
const NEGATED_AFTER_DEPLOY = new RegExp(
  String.raw`\b(?:no|none|nothing)\b(?:${GAP}${FILLER})*${GAP}${WHEN}(?!${CLAUSE_REST}${UNLESS})` +
    String.raw`|\b${WHEN}[:,]?${GAP}(?:nothing|none)\b(?!${CLAUSE_REST}${UNLESS})`,
  "gi",
);

/** The rest of a wrapped negation's clause when the next line only finishes it: "step.", "is needed.", nothing. */
const NEGATION_TAIL = new RegExp(String.raw`^(?:[ \t]+${FILLER}\b)*[ \t]*$`, "i");

/**
 * `section` with each negated after-deploy answer blanked, so it cannot read as
 * a step. A match that spans a line break is blanked only when the next line
 * continues the negation: it opens lower case, and the rest of its clause is
 * filler words at most. So "None. No" then "after-deploy step." is blanked,
 * but "None" then "After deploy, run …" (a new sentence) and "None" then
 * "after deploy run …" (a step) are read as written.
 */
const withoutNegatedAnswers = (section) =>
  section.replace(NEGATED_AFTER_DEPLOY, (match, ...rest) => {
    const blanked = match.replace(/[^\n]/g, " ");
    if (!match.includes("\n")) return blanked;
    if (/\n[ \t]*[A-Z]/.test(match)) return match;
    const [offset, whole] = rest.slice(-2);
    const tail = /^[^.;\n]*/.exec(whole.slice(offset + match.length))[0];
    return NEGATION_TAIL.test(tail) ? blanked : match;
  });

/** Whether `file` is one `release:cut prepare` writes, so a release-prep PR may change it. */
const isReleasePrepPath = (file) => RELEASE_PREP_PATHS.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));

const isDeployFragmentPath = (file) => /^changelog\.d\/[^/]+$/i.test(file) && isDeployFragmentName(path.posix.basename(file));

/**
 * The first phrase in the step sections of `body` naming an after-deploy step,
 * as `{ section, phrase }`, or `null`. Comments, fenced code and negated
 * answers ("No after-deploy step") are skipped.
 */
export function afterDeployMention(body) {
  const answers = stripNonAnswerText(body);
  for (const heading of DEPLOY_STEP_SECTIONS) {
    const raw = sectionAfterHeading(answers, heading);
    if (raw === null) continue;
    const section = withoutNegatedAnswers(raw);
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
    changes.some((change) => change.path === "CHANGELOG.md") &&
    changes.every((change) => isReleasePrepPath(change.path));
  if (releasePrep) return { outcome: "release-prep" };
  throw new Error(
    `"${mention.section}" names a step for after the deploy ("${mention.phrase}"), but the PR adds no ` +
      `changelog.d/<pr-number>-<slug>${DEPLOY_FRAGMENT_SUFFIX} fragment. Write each such step as one ` +
      `(changelog.d/README.md, "After-deploy steps") so the release's post-deploy checklist carries it. ` +
      "If there is no such step, answer \"None. No after-deploy step.\", and reword any sentence that only " +
      "describes what happens after the deploy so it names no time after the deploy (changelog.d/README.md).",
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
