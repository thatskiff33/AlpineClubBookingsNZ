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
  planDeviationItems,
  planDeviationVerdict,
  validatePlanDeviation,
} from "./check-pr-plan-deviation.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const gate = join(repoRoot, "scripts", "ci", "check-pr-plan-deviation.mjs");
const COMMENT_URL = "https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4463#issuecomment-1234567890";

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
      "- Column added, https://github.com/o/r/blob/main/x.md",
    ]) {
      expect(() => validatePlanDeviation(body(fake)), fake).toThrow(/do not link/);
    }
  });

  it("fails None alongside listed items", () => {
    expect(() => validatePlanDeviation(body("- None", `- Column: ${COMMENT_URL}`))).toThrow(/says `None` and also lists/);
  });

  it("ignores the heading and answers inside HTML comments and code fences", () => {
    const quoted = ["```md", PLAN_DEVIATION_HEADING, "- None", "```", "<!-- ## Plan Deviation\n- None -->", ""].join("\n");
    expect(() => validatePlanDeviation(quoted)).toThrow(/must include/);
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
  });
});

describe("planDeviationVerdict: the rollout switch", () => {
  it("is in its warning week: the shipped constant is not enforced", () => {
    // The follow-up PR flips this to `true` and updates this one assertion.
    expect(PLAN_DEVIATION_ENFORCED).toBe(false);
    expect(planDeviationVerdict("no section").status).toBe("warn");
  });

  it("warns while not enforced and fails once enforced, on the same body", () => {
    const unlinked = body("- Added a column");
    expect(planDeviationVerdict(unlinked, { enforced: false })).toMatchObject({ status: "warn" });
    expect(planDeviationVerdict(unlinked, { enforced: true })).toMatchObject({ status: "fail" });
    expect(planDeviationVerdict(unlinked, { enforced: true }).message).toMatch(/do not link/);
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
