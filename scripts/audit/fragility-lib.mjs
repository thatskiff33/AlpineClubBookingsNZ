/**
 * Pure parsing and matching rules for the fragility review (ALP-4 / ALP-7).
 *
 * `fragility-collect.mjs` and `fragility-signals.mjs` do the I/O (git, the
 * GitHub REST API, `tmp/fragility/*.json`); every decision about what counts as
 * a fix, which issue a fix belongs to, and what counts as "the same problem
 * came back" lives here, so it can be tested without a repository or network.
 *
 * Node built-ins only, like the rest of `scripts/`.
 */

export const REPO = "thatskiff33/AlpineClubBookingsNZ";

/** The 8 Aug 2026 audit (epics #2680, #2725): repeats after it are counted separately. */
export const AUDIT_CUTOFF = "2026-08-08";

/** A blamed commit touching more files than this is a sweep (the July file split), not a fix. */
export const SWEEP_FILE_LIMIT = 50;

/** A code-history pair needs at least this many blamed lines; smaller overlaps were incidental in the spot-checks. */
export const MIN_PAIR_LINES = 5;

/** Conventional-commit types whose commits never count as the earlier fix of a repeat. */
const NON_FIX_TYPES = /^(refactor|chore|style|docs)\b/i;

/** Conventional-commit types that say a PR is not a fix, whatever its branch is called. */
const OTHER_TYPES = /^(feat|refactor|perf|chore|docs|style|test|build|ci|revert)(\([^)]*\))?!?:/i;

/**
 * Files whose blame says nothing about a bug coming back. Tests are the big
 * one: fixes routinely edit shared test files, and the first spot-check found
 * test-only overlaps were nearly half of all code-history pairs.
 */
const BLAME_IGNORED = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /\.snap$/,
  /\.md$/,
  /(^|\/)__tests__\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /^e2e\//,
];

/** `Merge pull request #123 from owner/branch-name` → `{ pr, branch }`, else null. */
export function parseMergeSubject(subject) {
  const match = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject);
  return match ? { pr: Number(match[1]), branch: match[2] } : null;
}

/**
 * True when the PR title, or failing that its branch name, marks the PR as a
 * fix. A conventional title wins over the branch: `fix/2322-…` branches
 * titled `feat(#2322): …` were features in the spot-check.
 */
export function isFixPr({ branch = "", title = "" }) {
  if (isFixSubject(title)) return true;
  if (OTHER_TYPES.test(title)) return false;
  return /(^|\/)(hot)?fix(es)?[/-]/i.test(branch);
}

/** `fix: …`, `fix(scope): …`, `fix!: …`, or a plain `Fix …` sentence. */
export function isFixSubject(subject) {
  return /^fix(\([^)]*\))?!?:/i.test(subject) || /^fix(es|ed)?\s/i.test(subject);
}

/**
 * The issue number a branch name carries: `fix/2080-…`, `fix/issue-2080-…`,
 * `codex/issue-1555-…`, `compose/3635-…`. A number buried mid-name
 * (`claude/fix-xero-import-429-…`, an HTTP status) is not an issue.
 */
export function issueNumbersFromBranch(branch) {
  const match =
    /(?:^|[/-])issue-(\d{2,5})(?=$|[-_/])/i.exec(branch) ??
    /(?:^|\/)(?:(?:hot)?fix(?:es)?[/-])?(?:gh-|#)?(\d{2,5})(?=$|[-_/])/i.exec(branch);
  return match ? [Number(match[1])] : [];
}

/**
 * The scope of a conventional `fix(<scope>):` subject, split into the named
 * area scopes (`xero`, `bed-allocation`) and issue-number scopes (`#2080`,
 * `2080`, `#2080, #2081`).
 */
export function parseFixScope(subject) {
  const match = /^fix\(([^)]*)\)!?:/i.exec(subject);
  if (!match) return { scopes: [], issues: [] };
  const scopes = [];
  const issues = [];
  for (const part of match[1].split(/[,\s]+/).filter(Boolean)) {
    const number = /^#?(\d{2,5})$/.exec(part);
    if (number) issues.push(Number(number[1]));
    else scopes.push(normaliseScope(part));
  }
  return { scopes, issues };
}

/** Lower-case and fold plurals so `booking`/`bookings` land on one scope. */
export function normaliseScope(scope) {
  const lower = scope.toLowerCase().replace(/^#/, "");
  return lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss") ? lower.slice(0, -1) : lower;
}

/** `Fixes #12`, `closes #12, #13`, `Resolves: #14` → [12, 13, 14] (deduplicated, in order). */
export function closingReferences(text) {
  if (!text) return [];
  const found = [];
  const clause = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\b:?\s+((?:#\d+(?:\s*(?:,|and)\s*)?)+)/gi;
  for (const match of text.matchAll(clause)) {
    for (const number of match[1].matchAll(/#(\d+)/g)) found.push(Number(number[1]));
  }
  return [...new Set(found)];
}

/** Every `#123` reference in a text, deduplicated, in order. */
export function issueReferences(text) {
  if (!text) return [];
  return [...new Set([...text.matchAll(/(?<![\w/&])#(\d{1,5})\b/g)].map((m) => Number(m[1])))];
}

/** Wording that says a problem came back rather than that it is new. */
export const REPEAT_WORDING = /\b(regress\w*|again|still|re-?broke\w*|re-?break\w*|came back|comes back|follow-?up to|reintroduc\w*)\b/i;

/**
 * References that appear in the same sentence as repeat wording.
 *
 * Sentences (not whole bodies) keep "#123 is related; this one still fails"
 * style matches tight. The caller decides whether the referenced number had a
 * fix before the text was written; this only reads prose.
 */
export function repeatMentions(text) {
  if (!text) return [];
  const results = new Map();
  const withoutCode = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  for (const sentence of withoutCode.split(/(?<=[.!?])\s+|\n{2,}|\n(?=\s*[-*]\s)/)) {
    const wording = REPEAT_WORDING.exec(sentence);
    if (!wording) continue;
    for (const number of issueReferences(sentence)) {
      if (!results.has(number)) results.set(number, { number, wording: wording[0], excerpt: excerpt(sentence) });
    }
  }
  return [...results.values()];
}

function excerpt(sentence) {
  const flat = sentence.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 237)}…` : flat;
}

/** `This reverts commit <sha>.` → sha, else null. */
export function revertedCommit(body) {
  const match = /This reverts commit ([0-9a-f]{7,40})/.exec(body ?? "");
  return match ? match[1] : null;
}

/** True when a blamed commit cannot be the earlier fix of a repeat (sweep or non-fix type). */
export function isExcludedEarlierCommit({ subject, fileCount }) {
  return NON_FIX_TYPES.test(subject) || fileCount > SWEEP_FILE_LIMIT;
}

/** True when blaming this path cannot evidence a repeat. */
export function isBlameIgnoredPath(path) {
  return BLAME_IGNORED.some((pattern) => pattern.test(path));
}

/**
 * True when a GitHub error response is a rate limit worth waiting out. A 403
 * is also what a bad token or missing access returns, and retrying that would
 * loop forever, so a 403 only counts when GitHub says the budget is spent.
 */
export function isRateLimited(status, headers) {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after") !== null;
}

/**
 * Old-side line ranges per file from `git diff -U0 -M` output: the lines a
 * change modified or deleted in the pre-image. Pure additions have no old
 * lines and are omitted. Renames report the old path, which is what blame on
 * the parent needs.
 *
 * @returns {Map<string, Array<[number, number]>>} path → inclusive [start, end] ranges
 */
export function changedOldRanges(diff) {
  const ranges = new Map();
  let path = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      path = line === "--- /dev/null" ? null : line.slice(4).replace(/^a\//, "");
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (!hunk || !path) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    if (!ranges.has(path)) ranges.set(path, []);
    ranges.get(path).push([start, start + count - 1]);
  }
  return ranges;
}

/**
 * Commit per final line from `git blame --porcelain`.
 *
 * @returns {Map<string, number>} commit sha → number of blamed lines
 */
export function blameCommitCounts(porcelain) {
  const counts = new Map();
  for (const line of porcelain.split("\n")) {
    // Every blamed line gets a header (content lines start with a tab), so
    // counting headers counts lines.
    const header = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line);
    if (header) counts.set(header[1], (counts.get(header[1]) ?? 0) + 1);
  }
  return counts;
}

/** Two fix units concern different problems when their issue sets are disjoint (or both are unnumbered). */
export function concernDifferentIssues(earlier, later) {
  if (earlier.id === later.id) return false;
  if (earlier.issues.length === 0 || later.issues.length === 0) return true;
  return !earlier.issues.some((issue) => later.issues.includes(issue));
}

/** Stable key for a repeat pair, so the same pair found by several signals merges into one entry. */
export function pairKey(earlierId, laterId) {
  return `${earlierId}->${laterId}`;
}

export function issueUrl(number) {
  return `https://github.com/${REPO}/issues/${number}`;
}

export function pullUrl(number) {
  return `https://github.com/${REPO}/pull/${number}`;
}

export function commitUrl(sha) {
  return `https://github.com/${REPO}/commit/${sha}`;
}

/**
 * Parse one `issues_get` reply from Sekreton's integrations endpoint (the
 * fallback when no GITHUB_TOKEN reaches the task container). The reply is
 * text: a header block (`Issue: <ref> — <title>`, `State:`, `Labels:`, …), a
 * blank line, the body, then `--- Comment by @who (ROLE) at <ISO>` blocks.
 *
 * @returns {{ number, title, state, labels, body, comments: Array<{ author, createdAt, body }> }}
 */
export function parseIntegrationsIssue(text) {
  const lines = text
    .replace(/<\/?untrusted-issue-content>/g, "")
    .replace(/^\n+/, "")
    .split("\n");
  const header = /^Issue: \S+#(\d+) — (.*)$/.exec(lines[0] ?? "");
  if (!header) throw new Error(`unrecognised issues_get reply: ${text.slice(0, 120)}`);
  const field = (name) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? "";
  const labels = field("Labels");
  const blank = lines.indexOf("");
  const rest = blank === -1 ? [] : lines.slice(blank + 1);
  const comments = [];
  const bodyLines = [];
  let current = null;
  for (const line of rest) {
    const comment = /^--- Comment by @(\S+) \([^)]*\) at (\S+)$/.exec(line);
    if (comment) {
      current = { author: comment[1], createdAt: new Date(comment[2]).toISOString(), lines: [] };
      comments.push(current);
    } else (current ? current.lines : bodyLines).push(line);
  }
  return {
    number: Number(header[1]),
    title: header[2],
    state: field("State"),
    labels: labels && labels !== "none" ? labels.split(", ") : [],
    body: bodyLines.join("\n").trim(),
    comments: comments.map(({ lines: body, ...comment }) => ({ ...comment, body: body.join("\n").trim() })),
  };
}

/**
 * Estimated creation time of issue/PR `number` when the source gives none.
 * Numbers are handed out in creation order, so any later number's merge time
 * is an upper bound; the earliest such bound is the estimate. A first comment
 * is also an upper bound, and wins when it is earlier.
 *
 * @param {number} number
 * @param {Array<{ number: number, date: string }>} anchors PR merges, any order
 * @param {string | null} firstComment ISO time of the issue's first comment
 */
export function estimateCreatedAt(number, anchors, firstComment = null) {
  let bound = firstComment;
  for (const anchor of anchors) {
    if (anchor.number >= number && (bound === null || anchor.date < bound)) bound = anchor.date;
  }
  return bound;
}
