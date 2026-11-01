/**
 * #4463: the `## Plan Deviation` section — missing, `None`, an item without a
 * link, items with one — and the rollout switch that turns its warning into a
 * failure.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PLAN_DEVIATION_ENFORCED,
  PLAN_DEVIATION_HEADING,
  ownerAnswerLink,
  planDeviationItems,
  planDeviationVerdict,
  thisRepository,
  validatePlanDeviation as validateFor,
} from "./check-pr-plan-deviation.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const gate = join(repoRoot, "scripts", "ci", "check-pr-plan-deviation.mjs");
const REPO = "example-owner/example-repo";
const COMMENT_URL = `https://github.com/${REPO}/issues/4463#issuecomment-1234567890`;
/** Every shape test names its repository, so none depends on this checkout's remote. */
const validatePlanDeviation = (text) => validateFor(text, { repository: REPO });

const body = (...sectionLines) =>
  ["## Summary", "", "- does a thing", "", PLAN_DEVIATION_HEADING, "", ...sectionLines, "", "## Risk Level", "", "- [x] Low", ""].join("\n");

describe("validatePlanDeviation", () => {
  it("fails a body with no section", () => {
    expect(() => validatePlanDeviation("## Summary\n\n- a thing\n")).toThrow(/must include ## Plan Deviation/);
  });

  it("fails the template's unfilled section, comment and empty bullet", () => {
    const template = readFileSync(join(repoRoot, ".github", "pull_request_template.md"), "utf8");
    expect(template).toContain(PLAN_DEVIATION_HEADING);
    expect(() => validatePlanDeviation(template)).toThrow(/is empty/);
  });

  it("passes None, in the shapes people write it", () => {
    for (const answer of ["- None", "None", "- **None** — built to the plan.", "- `None`", "* none."]) {
      expect(validatePlanDeviation(body(answer)), answer).toEqual({ outcome: "none" });
    }
  });

  it("does not read a word that merely starts with none as None", () => {
    expect(() => validatePlanDeviation(body("- Nonetheless added a column"))).toThrow(/do not link/);
  });

  it("fails an item with no link to the owner's answer", () => {
    expect(() => validatePlanDeviation(body("- Added a `refundReason` column; the owner agreed in chat."))).toThrow(
      /1 ## Plan Deviation item\(s\) do not link the owner's answer \(first: "Added a `refundReason` column/,
    );
  });

  it("passes items that each link the answer, by comment URL or issue number", () => {
    expect(
      validatePlanDeviation(
        body(`- Added a \`refundReason\` column: [owner](${COMMENT_URL})`, "- Took D2 option (b), not (a): #4470"),
      ),
    ).toEqual({ outcome: "listed", count: 2 });
  });

  it("fails when only some items link the answer", () => {
    expect(() => validatePlanDeviation(body(`- Column: ${COMMENT_URL}`, "- Provider call added"))).toThrow(
      /1 ## Plan Deviation item\(s\).*first: "Provider call added"/,
    );
  });

  it("credits a link on an item's continuation line", () => {
    expect(validatePlanDeviation(body("- Added a money path for credits,", `  approved: ${COMMENT_URL}`))).toEqual({
      outcome: "listed",
      count: 1,
    });
  });

  it("does not take a non-reference as a link", () => {
    for (const fake of [
      "- Column added (see a#12)",
      "- Column added &#123;",
      "- Column added, https://example.com/issues/12",
      `- Column added, https://github.com/${REPO}/blob/main/x.md`,
      // Another repository's issue is not this project's owner answering.
      "- Column added, https://github.com/prisma/prisma/issues/123",
      "- Column added, https://github.com/example-owner/example-repo-fork/issues/12",
      // Link text `#12` is not a bare reference; the target is another repository.
      "- Column added, [#12](https://github.com/prisma/prisma/issues/12)",
    ]) {
      expect(() => validatePlanDeviation(body(fake)), fake).toThrow(/do not link/);
    }
  });

  it("accepts this repository's issue, PR and discussion URLs, and any bare #n", () => {
    for (const shape of [
      `- Column: https://github.com/${REPO}/issues/12`,
      `- Column: https://github.com/${REPO}/pull/12#discussion_r1`,
      `- Column: https://github.com/${REPO}/discussions/12`,
      `- Column: https://github.com/${REPO.toUpperCase()}/issues/12`,
      "- Column: #4470",
      `- Column: [#12](${COMMENT_URL})`,
      // A bare #n is TRUSTED, not resolved (documented in the gate's header):
      // the gate proves a reference was given, a reviewer reads it.
      "- Skipped step #2 of the plan",
    ]) {
      expect(validatePlanDeviation(body(shape)), shape).toEqual({ outcome: "listed", count: 1 });
    }
  });

  it("accepts only #n when the repository is unknown", () => {
    expect(ownerAnswerLink(null).test(COMMENT_URL.replace("#issuecomment-1234567890", ""))).toBe(false);
    expect(ownerAnswerLink(null).test("see #12")).toBe(true);
  });

  it("names the repository from GITHUB_REPOSITORY, else a GitHub origin URL", () => {
    expect(thisRepository({ GITHUB_REPOSITORY: "a/b" })).toBe("a/b");
    expect(thisRepository({}, () => "git@github.com:acme/lodge.git")).toBe("acme/lodge");
    expect(thisRepository({}, () => "https://github.com/acme/lodge")).toBe("acme/lodge");
    expect(thisRepository({}, () => "https://origin.cursor.com/acme/lodge")).toBeNull();
    expect(thisRepository({}, () => { throw new Error("no remote"); })).toBeNull();
  });

  it("keeps a sub-bullet indented under an item as part of that item", () => {
    expect(
      validatePlanDeviation(
        body("- Added a column, owner agreed #4463", "  - it is nullable so old code still reads it"),
      ),
    ).toEqual({ outcome: "listed", count: 1 });
    expect(validatePlanDeviation(body("1. Added a column: #4463", "   - nullable"))).toEqual({
      outcome: "listed",
      count: 1,
    });
  });

  it("still splits sibling items, and a sibling without a link fails", () => {
    expect(() => validatePlanDeviation(body("- Added a column: #4463", " - Added a provider call"))).toThrow(
      /first: "Added a provider call"/,
    );
  });

  it("ignores prose before the first item", () => {
    expect(
      validatePlanDeviation(body("One deviation, agreed with the owner:", "", `- Added a column (${COMMENT_URL})`)),
    ).toEqual({ outcome: "listed", count: 1 });
  });

  it("reads prose as the answer when there is no list", () => {
    expect(validatePlanDeviation(body("None — built to the plan."))).toEqual({ outcome: "none" });
    expect(() => validatePlanDeviation(body("Added a column without asking."))).toThrow(/do not link/);
    expect(() => validatePlanDeviation(body("None, except I added a column"))).toThrow(/do not link/);
  });

  it("keeps a tab-indented sub-bullet inside the item", () => {
    expect(validatePlanDeviation(body("-\tAdded a column #4", "\t- still that column"))).toEqual({
      outcome: "listed",
      count: 1,
    });
  });

  it("does not credit the last item with a later unindented paragraph", () => {
    expect(() => validatePlanDeviation(body("- Kept the plan: #1", "- Changed a column", "", "Both agreed: #12"))).toThrow(
      /first: "Changed a column"/,
    );
    expect(validatePlanDeviation(body("- Changed a column", "", "  owner agreed #12"))).toEqual({
      outcome: "listed",
      count: 1,
    });
  });

  it("skips a thematic break instead of reading it as an item", () => {
    expect(
      validatePlanDeviation(body("- Kept the plan: #1", "* * *", "- Changed a column: #2")),
    ).toEqual({ outcome: "listed", count: 2 });
  });

  it("fails None alongside listed items", () => {
    expect(() => validatePlanDeviation(body("- None", `- Column: ${COMMENT_URL}`))).toThrow(/says `None` and also lists/);
  });

  it("ignores the heading and answers inside HTML comments and code fences", () => {
    const quoted = ["```md", PLAN_DEVIATION_HEADING, "- None", "```", "<!-- ## Plan Deviation\n- None -->", ""].join("\n");
    expect(() => validatePlanDeviation(quoted)).toThrow(/must include/);
    // A longer closing fence still closes. If it did not, the strip would run
    // to the end and the real section below would disappear.
    const longerClose = ["```", PLAN_DEVIATION_HEADING, "- None", "````", PLAN_DEVIATION_HEADING, "", "- Added a column", ""].join("\n");
    expect(() => validatePlanDeviation(longerClose)).toThrow(/do not link/);
  });

  it("does not let a #n inside the template comment satisfy a prose answer", () => {
    const template = readFileSync(join(repoRoot, ".github", "pull_request_template.md"), "utf8");
    const filled = template.replace(/(## Plan Deviation\r?\n)[\s\S]*?\n-\r?\n/, "$1\nAdded a column without asking.\n");
    expect(filled).not.toBe(template);
    expect(() => validatePlanDeviation(filled)).toThrow(/do not link/);
  });

  it("stops the section at the next heading, so a later section's link does not count", () => {
    expect(() =>
      validatePlanDeviation(
        [PLAN_DEVIATION_HEADING, "", "- Added a column", "", "## Linked Issue", "", "- Closes #4463", ""].join("\n"),
      ),
    ).toThrow(/do not link/);
  });

  it("reads a CRLF body", () => {
    expect(validatePlanDeviation(body("- None").replace(/\n/g, "\r\n"))).toEqual({ outcome: "none" });
  });

  it("splits items at top-level bullets and numbered items only", () => {
    expect(planDeviationItems("- a\n  more\n1. b\n    - nested\n")).toEqual(["a\n  more", "b\n    - nested"]);
    expect(planDeviationItems("intro\n- a\n  - child\n- b\n")).toEqual(["a\n  - child", "b"]);
  });
});

describe("planDeviationVerdict: the rollout switch", () => {
  it("is in its warning week: the shipped constant is not enforced", () => {
    // The follow-up sets the constant to `true` and removes the warning-week
    // sentences. Either change without the other fails here.
    expect(PLAN_DEVIATION_ENFORCED).toBe(false);
    expect(planDeviationVerdict("no section").status).toBe("warn");
    const warningSentences = [
      [".github/pull_request_template.md", "`verify` warns on a missing, empty or unlinked section"],
      [".github/workflows/ci.yml", "WARNING ONLY until `PLAN_DEVIATION_ENFORCED`"],
      ["CONTRIBUTING.md", "Two PR-body checks warn rather than fail"],
    ];
    for (const [path, sentence] of warningSentences) {
      const text = readFileSync(join(repoRoot, path), "utf8").replace(/\s+/g, " ");
      expect([path, text.includes(sentence)]).toEqual([path, !PLAN_DEVIATION_ENFORCED]);
    }
  });

  it("warns while not enforced and fails once enforced, on the same body", () => {
    const unlinked = body("- Added a column");
    expect(planDeviationVerdict(unlinked, { enforced: false, repository: REPO })).toMatchObject({ status: "warn" });
    expect(planDeviationVerdict(unlinked, { enforced: true, repository: REPO })).toMatchObject({ status: "fail" });
    expect(planDeviationVerdict(unlinked, { enforced: true, repository: REPO }).message).toMatch(/do not link/);
  });

  it("passes a good body in either state", () => {
    for (const enforced of [false, true]) {
      expect(planDeviationVerdict(body("- None"), { enforced })).toMatchObject({ status: "pass", outcome: "none" });
    }
  });
});

describe("the CI entrypoint", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const run = (text) => {
    dir = mkdtempSync(join(tmpdir(), "plan-deviation-"));
    const file = join(dir, "pr-body.md");
    writeFileSync(file, text);
    const env = { ...process.env, PR_BODY_FILE: file };
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "PR_NUMBER", "GITHUB_REPOSITORY", "PR_BODY"]) delete env[key];
    return spawnSync(process.execPath, [gate], { encoding: "utf8", env });
  };

  it("prints a ::warning:: annotation and exits 0 for a missing section during the rollout", () => {
    const result = run("## Summary\n\n- a thing\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^::warning title=Plan deviation \(warning only%2C #4463 rollout\)::PR body must include/m);
  });

  it("passes a body that answers None", () => {
    const result = run(body("- None"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PR plan deviation check passed");
    expect(result.stdout).not.toContain("::warning");
  });
});
