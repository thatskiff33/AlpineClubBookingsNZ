import { describe, expect, it } from "vitest";

import {
  blameCommitCounts,
  changedOldRanges,
  closingReferences,
  concernDifferentIssues,
  isBlameIgnoredPath,
  isExcludedEarlierCommit,
  isFixPr,
  isRateLimited,
  issueNumbersFromBranch,
  parseFixScope,
  parseMergeSubject,
  repeatMentions,
  revertedCommit,
} from "./fragility-lib.mjs";
import { buildRepeats } from "./fragility-signals.mjs";

/**
 * The fragility review's evidence rules: which merges are fixes, which issue
 * a fix belongs to, and which pairs of fixes count as a problem coming back.
 * Fixtures use the real branch, subject and comment shapes from this
 * repository's history; nothing here touches git or GitHub.
 */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("fix units", () => {
  it("reads the PR number and branch from a GitHub merge subject", () => {
    expect(parseMergeSubject("Merge pull request #3834 from thatskiff33/fix/3793-paid-cancel-read-under-lock")).toEqual({
      pr: 3834,
      branch: "fix/3793-paid-cancel-read-under-lock",
    });
    expect(parseMergeSubject("Merge branch 'main' into fix/3793")).toBeNull();
  });

  it("lets a conventional PR title overrule a fix-looking branch", () => {
    expect(isFixPr({ branch: "fix/issue-2322-logo", title: "feat(#2322): serve the club logo as a real image" })).toBe(false);
    expect(isFixPr({ branch: "fix/issue-3498-one-review-item-per-edit", title: "" })).toBe(true);
    expect(isFixPr({ branch: "compose/3635-late-capture-xero", title: "fix(#3635): a late capture is recorded" })).toBe(true);
    expect(isFixPr({ branch: "claude/fix-xero-import-429-9uLYV", title: "Add Xero API rate limit handling" })).toBe(true);
    expect(isFixPr({ branch: "epic/3795-security-secrets-privacy", title: "Security epic" })).toBe(false);
  });

  it("takes the issue number from the branch shapes this repository uses", () => {
    expect(issueNumbersFromBranch("fix/3843-braces-depth-mitigation")).toEqual([3843]);
    expect(issueNumbersFromBranch("fix/issue-3824-migrate-node-build-options")).toEqual([3824]);
    expect(issueNumbersFromBranch("codex/issue-1555-guest-form-help")).toEqual([1555]);
    expect(issueNumbersFromBranch("compose/3635-late-capture-xero")).toEqual([3635]);
    // An HTTP status in the middle of a name is not an issue number.
    expect(issueNumbersFromBranch("claude/fix-xero-import-429-9uLYV")).toEqual([]);
  });

  it("splits fix scopes into area names and issue numbers, folding plurals", () => {
    expect(parseFixScope("fix(#2080): x")).toEqual({ scopes: [], issues: [2080] });
    expect(parseFixScope("fix(2255): x")).toEqual({ scopes: [], issues: [2255] });
    expect(parseFixScope("fix(bookings): x")).toEqual({ scopes: ["booking"], issues: [] });
    expect(parseFixScope("fix(booking): x").scopes).toEqual(parseFixScope("fix(bookings): x").scopes);
    expect(parseFixScope("fix(xero+booking): x").scopes).toEqual(["xero+booking"]);
    expect(parseFixScope("feat(xero): x")).toEqual({ scopes: [], issues: [] });
  });

  it("reads closing keywords, including lists", () => {
    expect(closingReferences("Fixes #12, #13 and #14.\nCloses: #20\nSee #99")).toEqual([12, 13, 14, 20]);
    expect(closingReferences("Related to #12")).toEqual([]);
  });
});

describe("code history", () => {
  it("keeps the pre-image lines a change modified or deleted, not pure additions", () => {
    const diff = [
      "diff --git a/src/lib/x.ts b/src/lib/x.ts",
      "--- a/src/lib/x.ts",
      "+++ b/src/lib/x.ts",
      "@@ -10,3 +10,4 @@ fn",
      "@@ -20 +21 @@",
      "@@ -30,0 +32,5 @@",
      "diff --git a/src/old.ts b/src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -5,2 +5,2 @@",
      "diff --git a/src/added.ts b/src/added.ts",
      "--- /dev/null",
      "+++ b/src/added.ts",
      "@@ -0,0 +1,9 @@",
    ].join("\n");
    expect(Object.fromEntries(changedOldRanges(diff))).toEqual({
      "src/lib/x.ts": [
        [10, 12],
        [20, 20],
      ],
      "src/old.ts": [[5, 6]],
    });
  });

  it("counts every blamed line, not only the first line of each group", () => {
    const porcelain = [
      `${SHA_A} 10 10 2`,
      "author A",
      "filename src/x.ts",
      "\tline one",
      `${SHA_A} 11 11`,
      "\tline two",
      `${SHA_B} 3 12 1`,
      "previous cccccccccccccccccccccccccccccccccccccccc src/x.ts",
      "filename src/x.ts",
      `\t${SHA_A} 1 1 looks like a header but is content`,
    ].join("\n");
    expect(Object.fromEntries(blameCommitCounts(porcelain))).toEqual({ [SHA_A]: 2, [SHA_B]: 1 });
  });

  it("does not blame tests, docs or lockfiles", () => {
    expect(isBlameIgnoredPath("src/lib/__tests__/late-capture.test.ts")).toBe(true);
    expect(isBlameIgnoredPath("src/components/guests-step.test.tsx")).toBe(true);
    expect(isBlameIgnoredPath("e2e/booking.spec.ts")).toBe(true);
    expect(isBlameIgnoredPath("docs/ARCHITECTURE.md")).toBe(true);
    expect(isBlameIgnoredPath("pnpm-lock.yaml")).toBe(true);
    expect(isBlameIgnoredPath("src/lib/booking-cancel.ts")).toBe(false);
  });

  it("never treats a sweep or a non-fix commit as the earlier fix", () => {
    expect(isExcludedEarlierCommit({ subject: "refactor: split booking-service.ts", fileCount: 3 })).toBe(true);
    expect(isExcludedEarlierCommit({ subject: "fix(#2080): x", fileCount: 51 })).toBe(true);
    expect(isExcludedEarlierCommit({ subject: "fix(#2080): x", fileCount: 50 })).toBe(false);
  });

  it("treats fixes sharing an issue as the same problem, and unnumbered fixes as different", () => {
    expect(concernDifferentIssues({ id: "a", issues: [1, 2] }, { id: "b", issues: [2] })).toBe(false);
    expect(concernDifferentIssues({ id: "a", issues: [1] }, { id: "b", issues: [2] })).toBe(true);
    expect(concernDifferentIssues({ id: "a", issues: [] }, { id: "b", issues: [2] })).toBe(true);
    expect(concernDifferentIssues({ id: "a", issues: [] }, { id: "a", issues: [] })).toBe(false);
  });
});

describe("GitHub rate limits", () => {
  it("waits out a spent budget but fails fast on a 403 that is a permission error", () => {
    expect(isRateLimited(429, new Headers())).toBe(true);
    expect(isRateLimited(403, new Headers({ "x-ratelimit-remaining": "0" }))).toBe(true);
    expect(isRateLimited(403, new Headers({ "retry-after": "60" }))).toBe(true);
    // Bad token or no access: retrying would loop forever.
    expect(isRateLimited(403, new Headers({ "x-ratelimit-remaining": "4999" }))).toBe(false);
    expect(isRateLimited(404, new Headers({ "x-ratelimit-remaining": "0" }))).toBe(false);
  });
});

describe("repeat wording", () => {
  it("pairs a reference with repeat wording only inside one sentence, outside code", () => {
    const text = "Related to #10. The guest form regressed after #20 landed. `#30 again` is code.\n\nFollow-up to #40";
    expect(repeatMentions(text).map((mention) => mention.number)).toEqual([20, 40]);
  });

  it("reads the reverted sha from a revert body", () => {
    expect(revertedCommit(`This reverts commit ${SHA_A}.`)).toBe(SHA_A);
    expect(revertedCommit("Revert nothing")).toBeNull();
  });
});

describe("buildRepeats", () => {
  const unit = (id, date, extra = {}) => ({
    id,
    pr: null,
    issues: [],
    scopes: [],
    title: id,
    date,
    tip: SHA_A,
    commits: [],
    files: [],
    ...extra,
  });
  const issue = (number, extra = {}) => ({
    number,
    isPr: false,
    title: `issue ${number}`,
    body: "",
    labels: [],
    createdAt: "2026-05-01T00:00:00Z",
    ...extra,
  });
  const github = (extra = {}) => ({ issues: [], comments: [], reopened: [], ...extra });

  it("pairs consecutive fixes for one issue, linking PRs through their Fixes line", () => {
    const repeats = buildRepeats({
      units: [unit("pr-11", "2026-05-02T00:00:00.000Z", { pr: 11 }), unit("pr-12", "2026-05-09T00:00:00.000Z", { pr: 12, issues: [10] })],
      codePairs: [],
      github: github({ issues: [issue(10), issue(11, { isPr: true, body: "Fixes #10" }), issue(12, { isPr: true })] }),
      reverts: [],
    });
    expect(repeats.map((entry) => [entry.earlier.unit, entry.later.unit, entry.signals])).toEqual([["pr-11", "pr-12", ["refix"]]]);
  });

  it("counts a reopen only when a fix had already landed", () => {
    const repeats = buildRepeats({
      units: [unit("pr-21", "2026-06-02T00:00:00.000Z", { pr: 21, issues: [20] })],
      codePairs: [],
      github: github({
        issues: [issue(20), issue(30)],
        reopened: [
          { issue: 20, createdAt: "2026-06-05T00:00:00Z" },
          { issue: 30, createdAt: "2026-06-05T00:00:00Z" },
        ],
      }),
      reverts: [],
    });
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toMatchObject({ signals: ["reopened"], earlier: { unit: "pr-21" }, later: { key: "issue-20" } });
  });

  it("links a regression report to the earlier fix it cites and the fix that followed", () => {
    const repeats = buildRepeats({
      units: [unit("pr-41", "2026-08-01T00:00:00.000Z", { pr: 41, issues: [40] }), unit("pr-51", "2026-08-20T00:00:00.000Z", { pr: 51, issues: [50] })],
      codePairs: [{ earlier: "pr-41", later: "pr-51", lines: 12, files: { "src/lib/x.ts": 12 }, commits: [SHA_A] }],
      github: github({
        issues: [issue(40), issue(50, { createdAt: "2026-08-10T00:00:00Z", body: "The cancellation refund regressed after #40." })],
      }),
      reverts: [],
    });
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toMatchObject({ earlier: { unit: "pr-41" }, later: { unit: "pr-51" }, signals: ["mention", "code-history"], sinceAudit: true });
  });

  it("ignores a citation of a fix that had not landed when the text was written", () => {
    const repeats = buildRepeats({
      units: [unit("pr-41", "2026-08-15T00:00:00.000Z", { pr: 41, issues: [40] })],
      codePairs: [],
      github: github({ issues: [issue(40), issue(50, { createdAt: "2026-08-10T00:00:00Z", body: "Still broken, like #40." })] }),
      reverts: [],
    });
    expect(repeats).toEqual([]);
  });

  it("pairs a reverted fix with its revert", () => {
    const repeats = buildRepeats({
      units: [unit("pr-61", "2026-07-01T00:00:00.000Z", { pr: 61, issues: [60], commits: [SHA_A] })],
      codePairs: [],
      github: github({ issues: [issue(60)] }),
      reverts: [{ sha: SHA_B, date: "2026-07-02T00:00:00.000Z", subject: 'Revert "fix(#60)"', reverts: SHA_A.slice(0, 12) }],
    });
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toMatchObject({ signals: ["revert"], earlier: { unit: "pr-61" }, sinceAudit: false });
  });
});
