import { pathToFileURL } from "node:url";

import {
  fetchLivePrBody,
  gitDiffChangedFiles,
  parseNameStatus,
  selectPrBody,
} from "./pr-body.mjs";

const HEADING = "## Concurrency And Lock Impact";

const GATE_LABEL = "PR concurrency declaration check";

export const REQUIRED_FIELDS = [
  "Writer class(es), canonical lock key(s), and acquisition order",
  "Immutable pre-lock key source and mutable under-lock re-read",
  "Status-guarded claim and proof that a lost claim runs no side effect",
  "Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence",
  "Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`)",
];

const SENSITIVE_PATH = /^(?:src\/(?:app\/api|lib)\/.*(?:booking|capacity|payment|refund|credit|settlement|waitlist|webhook|cron|xero|stripe|membership|member-lifecycle)|prisma\/schema\.prisma|prisma\/migrations\/)/i;

// Pure test/spec files never move money, capacity, or lifecycle state, so they
// must not force a full concurrency declaration. Filter them out before the
// sensitive-path check: a test-only PR may legitimately check N/A, while a PR
// that also touches real sensitive source still needs the full declaration.
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match a required field bullet whose value sits on the SAME line as its label.
// Horizontal-whitespace classes (`[^\S\r\n]`) keep `\s` from swallowing the
// newline(s) after an empty bullet and capturing the next bullet as the value;
// the trailing `\r?` tolerates GitHub's CRLF-stored PR bodies. A value of only
// whitespace fails because the capture must start with `\S`.
function fieldValuePattern(field) {
  return new RegExp(
    `^[^\\S\\r\\n]*-[^\\S\\r\\n]*${escapeRegex(field)}:[^\\S\\r\\n]*(\\S[^\\r\\n]*?)[^\\S\\r\\n]*\\r?$`,
    "m",
  );
}

/**
 * Validate a PR body's concurrency declaration against the PR's diff.
 *
 * `changedFiles` carries the diff and has THREE meaningful states, not two:
 *   - a non-empty array — the changed paths;
 *   - an empty array — the diff is known and touches nothing;
 *   - `null` (or omitted) — the diff is UNKNOWN, because the caller had no
 *     `PR_BASE_SHA`/`PR_HEAD_SHA` or could not resolve a local merge base.
 *
 * Unknown is NOT the same as empty, and conflating the two is what would turn
 * the #2726 short-circuit below into a hole: an unknown diff would look
 * non-sensitive and waive the section for every PR. Unknown is therefore
 * treated as possibly sensitive, on BOTH paths that consult the diff — the
 * section stays required, and a ticked `N/A` is refused rather than taken on
 * trust, because "I could not look" is not evidence that nothing sensitive
 * changed. Only a complete declaration passes on an unknown diff.
 */
export function validateConcurrencyDeclaration(body, changedFiles = null) {
  const diffKnown = Array.isArray(changedFiles);
  const sensitiveFiles = (diffKnown ? changedFiles : []).filter(
    (file) => !TEST_FILE.test(file) && SENSITIVE_PATH.test(file),
  );

  // Anchor to the START OF A LINE. A plain indexOf also matches the heading text
  // quoted inside prose or a code span — and a PR body that explains this gate
  // will quote it. When that mention comes first, the "section" starts there and
  // runs to the next `## `, so the real declaration below is never read and every
  // field reports missing. Found exactly that way: this gate's own PR body.
  const headingMatch = new RegExp(
    `^[^\\S\\r\\n]*${escapeRegex(HEADING)}[^\\S\\r\\n]*\\r?$`,
    "m",
  ).exec(body);
  if (!headingMatch) {
    // #2726: when the diff is KNOWN and holds no non-test file on a sensitive
    // path, a missing section is not a failure — the same short-circuit the
    // changelog gate has had since #2452 (`isCodeBearing`), keyed on the very
    // condition this gate already uses to decide whether `N/A` is acceptable.
    //
    // This loses no enforcement, and the proof is exact rather than approximate:
    // the set of PRs newly allowed to omit the section is the SAME set that the
    // `N/A` branch below already accepts (`sensitiveFiles.length === 0`), so
    // every PR this waives is one the gate would have passed anyway the moment
    // the author pasted a heading and ticked a box. Nothing that must produce a
    // real declaration — booking, capacity, payment, refund, credit,
    // settlement, waitlist, webhook, cron, Xero, Stripe, membership, lifecycle,
    // `prisma/schema.prisma`, `prisma/migrations/` — changes by one byte.
    //
    // Every Dependabot PR failed here permanently before this: Dependabot writes
    // its own body and cannot use `.github/pull_request_template.md`. The fix
    // deliberately keys off the DIFF, never off the author — an actor exemption
    // would wave through a bot PR bumping `@prisma/client` or `stripe` while
    // still failing a human's docs-only PR.
    if (diffKnown && sensitiveFiles.length === 0) {
      return { outcome: "no-sensitive-paths" };
    }
    throw new Error(
      `PR body must include ${HEADING}.` +
        (sensitiveFiles.length > 0
          ? ` It is required because this PR changes concurrency-sensitive files: ${sensitiveFiles.join(", ")}`
          : ""),
    );
  }

  const afterHeading = body.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingIndex = afterHeading.search(/\n##\s+/);
  const section = nextHeadingIndex >= 0 ? afterHeading.slice(0, nextHeadingIndex) : afterHeading;

  if (/^\s*-\s*\[[xX]\]\s*N\/A\b/m.test(section)) {
    // Same three-state reading as the waiver above. `N/A` is a claim ABOUT the
    // diff, so it can only be accepted against a diff that was actually read;
    // with an unknown diff `sensitiveFiles` is empty for want of evidence, not
    // because nothing sensitive changed, and accepting it here would leave the
    // gate's most consequential answer resting on a list nobody produced.
    if (!diffKnown) {
      throw new Error(
        "Concurrency declaration cannot use N/A here: the PR diff could not be resolved, " +
          "so there is no evidence that no sensitive path changed. Make the diff readable " +
          "(fetch the base branch, or pass --base <ref> to pnpm run pr:check), or complete " +
          "the declaration fields instead.",
      );
    }
    if (sensitiveFiles.length > 0) {
      throw new Error(
        `Concurrency declaration cannot use N/A for sensitive paths: ${sensitiveFiles.join(", ")}`,
      );
    }
    return { outcome: "declared-n-a" };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!fieldValuePattern(field).test(section)) {
      // Say WHY, not just WHICH. The overwhelmingly common cause is a value
      // wrapped onto the line below its label, which reads as an empty field —
      // and an author who is told only "complete this field" while looking at a
      // field they believe they completed will re-guess the format, burning a
      // full CI cycle per attempt. Naming the same-line rule here is what makes
      // this failure self-correcting on the first try.
      const labelPresent = new RegExp(
        `^[^\\S\\r\\n]*-[^\\S\\r\\n]*${escapeRegex(field)}:`,
        "m",
      ).test(section);
      throw new Error(
        labelPresent
          ? `Concurrency declaration field "${field}:" has no value on its own line. ` +
            "Put the value on the SAME line as the label — a value wrapped onto the " +
            "following line reads as empty. Continuation lines after that first " +
            "line are fine. Check it before pushing with: pnpm run pr:check <body-file>"
          : `Concurrency declaration must complete "${field}:" or explicitly check N/A. ` +
            "Copy the field list verbatim from .github/pull_request_template.md — the " +
            "labels are matched exactly. Check it before pushing with: " +
            "pnpm run pr:check <body-file>",
      );
    }
  }

  const compatibilityEvidence = section.match(fieldValuePattern(REQUIRED_FIELDS[3]))?.[1] ?? "";
  if (!/#\d+/.test(compatibilityEvidence)) {
    throw new Error(
      "Concurrency compatibility evidence must identify at least one reviewed open or last-10 PR number.",
    );
  }

  return { outcome: "complete" };
}

// Why a passing run passed. Mirrors `OUTCOME_MESSAGES` in the changelog gate:
// a log line reading only "complete" on a PR that never carried a section is
// how a waiver quietly becomes indistinguishable from a real declaration.
const OUTCOME_MESSAGES = {
  "no-sensitive-paths":
    "no non-test file on a concurrency-sensitive path changed, so no declaration is required.",
  "declared-n-a": "the PR body declares N/A and no sensitive path changed.",
  complete: "the PR body carries a complete declaration.",
};

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const base = process.env.PR_BASE_SHA;
    const head = process.env.PR_HEAD_SHA;
    // `null`, not `[]`, when the range is missing: without it the diff is
    // UNKNOWN, and an unknown diff must not be read as "changed nothing" — that
    // is the one classification that waives the section (#2726). Fail closed and
    // keep asking for the declaration instead.
    //
    // The diff goes through `parseNameStatus`, exactly as the changelog gate and
    // the offline `pnpm run pr:check` runner do, so a RENAME arrives as its
    // delete + add pair. A bare `--name-only` listing prints only the rename's
    // destination, which let a PR move `src/lib/payment-settlement.ts` to
    // `src/lib/ledger.ts`, edit it, and match no sensitive path at all — and
    // made CI and the offline runner reach opposite verdicts on one diff.
    const changedFiles =
      base && head
        ? [
            ...new Set(
              parseNameStatus(gitDiffChangedFiles(base, head)).map((change) => change.path),
            ),
          ]
        : null;
    const fetchedBody = await fetchLivePrBody(GATE_LABEL);
    const body = selectPrBody({ fetchedBody, eventBody: process.env.PR_BODY });
    const { outcome } = validateConcurrencyDeclaration(body, changedFiles);
    console.log(`PR concurrency declaration check passed: ${OUTCOME_MESSAGES[outcome]}`);
  } catch (error) {
    console.error(`${GATE_LABEL} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
