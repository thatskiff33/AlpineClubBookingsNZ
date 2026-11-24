import fs from "node:fs";
import path from "node:path";

import { afterDeployMention, validateDeployFragment } from "./check-pr-deploy-fragment.mjs";

/** Real merged PR bodies, trimmed to the two step sections (`_source` in the file says where from). */
const REAL_BODIES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "pr-after-deploy-bodies.json"), "utf8"));

const GOOD = "## Who\n\nowner\n\n## What to do\n\nRun the report once.\n\n## How to check it worked\n\nIt lists no rows.\n";
const BAD = "## Who\n\neveryone\n\n## What to do\n\nRun it.\n";

/** `"A src/x.ts"` pairs as diff records. */
const changes = (...pairs) =>
  pairs.map((pair) => {
    const [status, path] = pair.split(" ");
    return { status, path };
  });

/** A `contentsOf` reader over an in-memory head. */
const headOf = (files) => (path) => {
  if (!(path in files)) throw new Error(`fatal: path '${path}' does not exist in 'HEAD'`);
  return [files[path]];
};

const body = ({ manual = "- None.", impact = "- None." } = {}) =>
  `## Summary\n\n- Work.\n\n## Migration Or Deployment Impact\n\n${impact}\n\n## Docs Updated\n\n- After deploy, nothing.\n\n## Manual Checks Required\n\n${manual}\n`;

const CODE = changes("M src/lib/xero/outbox.ts");

describe("PR after-deploy step gate (#5379)", () => {
  it("passes a step named in the body when the PR writes its fragment", () => {
    const diff = [...CODE, ...changes("A changelog.d/5309-stuck-report.deploy.md")];
    const result = validateDeployFragment(body({ manual: "- After deploy, the owner runs the stuck-row report." }), diff, {
      contentsOf: headOf({ "changelog.d/5309-stuck-report.deploy.md": GOOD }),
    });
    expect(result.outcome).toBe("fragment-present");
  });

  it("fails a step named in either section when no fragment is written", () => {
    for (const [section, text] of [
      ["Manual Checks Required", body({ manual: "- After the release, check the queue." })],
      ["Migration Or Deployment Impact", body({ impact: "- Run `pnpm run x` once after upgrading." })],
      ["Manual Checks Required", body({ manual: "- Post-deploy: confirm the webhook." })],
      ["Manual Checks Required", body({ manual: "- The owner runs the report." })],
      ["Manual Checks Required", body({ manual: "- After deploying, map the account." })],
    ]) {
      expect(() => validateDeployFragment(text, CODE, { contentsOf: headOf({}) }), text).toThrow(
        new RegExp(`"## ${section}" names a step for after the deploy .*adds no changelog\\.d/<pr-number>-<slug>\\.deploy\\.md`),
      );
    }
  });

  it("fails a malformed fragment, whatever the body says", () => {
    const diff = changes("A changelog.d/5310-bad.deploy.md", "M changelog.d/5309-good.deploy.md");
    const contentsOf = headOf({ "changelog.d/5310-bad.deploy.md": BAD, "changelog.d/5309-good.deploy.md": GOOD });
    expect(() => validateDeployFragment(body(), diff, { contentsOf })).toThrow(
      /1 after-deploy step fragment\(s\) are malformed[\s\S]*changelog\.d\/5310-bad\.deploy\.md: it has no "## How to check it worked" heading/,
    );
    expect(() =>
      validateDeployFragment(body(), changes("A changelog.d/Bad_Name.deploy.md"), { contentsOf: headOf({ "changelog.d/Bad_Name.deploy.md": GOOD }) }),
    ).toThrow(/its name must be/);
  });

  it("passes a PR that names no step for after the deploy", () => {
    expect(validateDeployFragment(body(), CODE, { contentsOf: headOf({}) }).outcome).toBe("no-step");
    expect(validateDeployFragment("", [], {}).outcome).toBe("no-step");
  });

  it("does not read the phrase in a comment, a code block or another section", () => {
    const quoted = body({
      manual: "<!-- Name every step to do after deploy as a .deploy.md fragment. -->\n\n```text\nafter the release\n```\n\n- None.",
    });
    expect(afterDeployMention(quoted)).toBeNull();
    expect(validateDeployFragment(quoted, CODE, { contentsOf: headOf({}) }).outcome).toBe("no-step");
  });

  it("does not count deleting a fragment as writing one, except in a release-prep PR", () => {
    const named = body({ impact: "- Files the after-deploy steps for v0.15.0." });
    expect(() =>
      validateDeployFragment(named, changes("D changelog.d/5309-stuck-report.deploy.md"), { contentsOf: headOf({}) }),
    ).toThrow(/names a step for after the deploy/);
    const releasePrep = changes(
      "D changelog.d/5309-stuck-report.deploy.md",
      "D changelog.d/5379-x.md",
      "M CHANGELOG.md",
      "M package.json",
      "M docs/UPGRADING.md",
      "A docs/releases/v0.15.0.md",
      "M docs/releases/README.md",
      "D size-allowances.d/5100-x.md",
    );
    expect(validateDeployFragment(named, releasePrep, { contentsOf: headOf({}) }).outcome).toBe("release-prep");
  });

  it("does not exempt a PR that looks like release prep but changes anything prepare does not write", () => {
    const step = body({ manual: "- After deploy, the owner runs the stuck-row report." });
    for (const extra of ["M src/lib/xero/outbox.ts", "M docs/MAINTENANCE.md", "A changelog.d-other/x.md", "M package.json.bak"]) {
      const diff = changes("D changelog.d/5309-stuck-report.deploy.md", "M CHANGELOG.md", extra);
      expect(() => validateDeployFragment(step, diff, { contentsOf: headOf({}) }), extra).toThrow(/names a step for after the deploy/);
    }
  });

  it("passes merged PRs whose bodies say they have no after-deploy step (#5450, #5435, #5340)", () => {
    for (const number of ["5450", "5435", "5340"]) {
      expect(afterDeployMention(REAL_BODIES[number]), number).toBeNull();
      expect(validateDeployFragment(REAL_BODIES[number], CODE, { contentsOf: headOf({}) }).outcome, number).toBe("no-step");
    }
  });

  it("fails merged PRs whose bodies name an after-deploy step without a fragment (#4998, #5107)", () => {
    for (const number of ["4998", "5107"]) {
      expect(afterDeployMention(REAL_BODIES[number]), number).toEqual({ section: "## Manual Checks Required", phrase: "After deploy" });
      expect(() => validateDeployFragment(REAL_BODIES[number], CODE, { contentsOf: headOf({}) }), number).toThrow(
        /"## Manual Checks Required" names a step for after the deploy \("After deploy"\)/,
      );
    }
  });

  it("reads a negated answer as no step, in either order and either section", () => {
    for (const answer of [
      "- None. No after-deploy step.",
      "- None. No migration and no after-deploy steps.",
      "- None after deploy.",
      "- No post-deploy action needed.",
      "- Nothing to do after release.",
      "- No step is needed after upgrading.",
      "- After deploy: nothing; the feature stays off.",
    ]) {
      expect(afterDeployMention(body({ manual: answer })), answer).toBeNull();
      expect(afterDeployMention(body({ impact: answer })), answer).toBeNull();
    }
  });

  it("still finds a step beside a negation in another clause or sentence", () => {
    for (const [answer, phrase] of [
      ["- No migration, but after deploy run the census once.", "after deploy"],
      ["- No migration but after deploy run the census once.", "after deploy"],
      ["- None before merge. After deploy, the audit log shows the recovery rows.", "After deploy"],
      ["- None. After deploy, an officer presses Try again on one exhausted row.", "After deploy"],
      ["- No after-deploy step for clubs; after deploy, the owner reads the census.", "after deploy"],
    ]) {
      expect(afterDeployMention(body({ manual: answer })), answer).toMatchObject({ phrase });
    }
  });

  it("finds the wider ways a step is written", () => {
    for (const [answer, phrase] of [
      ["- After release, run the backfill once.", "After release"],
      ["- Once this ships, the owner should run the report.", "Once this ships"],
      ["- The owner should run the report.", "owner should run"],
      ["- After upgrading, set FOO.", "After upgrading"],
      ["- Once it is deployed, map the account.", "Once it is deployed"],
    ]) {
      expect(afterDeployMention(body({ manual: answer })), answer).toEqual({ section: "## Manual Checks Required", phrase });
    }
    expect(afterDeployMention(body({ manual: "- The tag is cut after release-prep merges." }))).toBeNull();
  });

  // Review of c1eda3d9b7: wordings merged PRs used (#5424, #5367, #5112, #5049) that the gate missed.
  it.each([
    ["- Re-run `pnpm run diagnostics:provision-role` once after the new release is serving.", "after the new release"],
    ["- After the next deploy the owner may check the nightly census.", "After the next deploy"],
    ["- Once deployed, map the account.", "Once deployed"],
    ["- After the upgrade, an officer confirms the timings block.", "After the upgrade"],
    ["- Re-run the repair migration once after cutover.", "after cutover"],
    ["- Post-release: confirm the webhook.", "Post-release"],
    ["- AFTER THE NEXT DEPLOY, map the account.", "AFTER THE NEXT DEPLOY"],
    ["- Map the account once after\n  deploy.", "after\n  deploy"],
  ])("finds the step in %j", (answer, phrase) => {
    expect(afterDeployMention(body({ manual: answer }))).toEqual({ section: "## Manual Checks Required", phrase });
    expect(afterDeployMention(body({ impact: answer }))).toEqual({ section: "## Migration Or Deployment Impact", phrase });
  });

  it("does not read a possessive as a time after the release", () => {
    // #5471's wording: it describes the switch, not a step.
    const answer = "- The previous release's job can still send its own copy after this release's webhook sent one.";
    expect(afterDeployMention(body({ impact: answer }))).toBeNull();
  });

  // Review of 4eed6a2409: a possessive followed by the release's own event still names a time.
  it.each([
    ["- After this release's deploy, run X.", "After this release"],
    ["- After the new release's migration finishes, run X.", "After the new release"],
    ["- After this release's\n  first deploy, run X.", "After this release"],
    ["- Post-release's upgrade done, run X.", "Post-release"],
  ])("reads a possessive naming the release's event as a time in %j", (answer, phrase) => {
    expect(afterDeployMention(body({ manual: answer }))).toEqual({ section: "## Manual Checks Required", phrase });
  });

  it.each([
    ["- After deploy, nothing changes for members, but run `pnpm backfill` once.", "After deploy"],
    ["- No step is needed after deploy unless SMTP is set; then set FOO.", "after deploy"],
    ["- No after-deploy step if the club uses Stripe; then check the webhook.", "after-deploy"],
    ["- None after deploy, except clubs on Xero map the account.", "after deploy"],
    ["- After deploy: nothing, unless the module is on.", "After deploy"],
    ["- None\nAfter deploy, run the census.", "After deploy"],
    // Review of 4eed6a2409: the negation covers only its own words, not the rest of the sentence.
    ["- After deploy nothing breaks, and the owner should run `pnpm x`.", "owner should run"],
    ["- After deploy: nothing for members, and after release run X.", "after release"],
    // ...and wraps onto the next line only where that line finishes it, not where it goes on to a step.
    ["- None\nafter deploy run X.", "after deploy"],
    ["- No manual step\n  after the upgrade for clubs on Xero; map the account.", "after the upgrade"],
    ["- After deploy:\n  nothing for members, then run X.", "After deploy"],
  ])("does not let a negation hide the step in %j", (answer, phrase) => {
    expect(afterDeployMention(body({ manual: answer }))).toEqual({ section: "## Manual Checks Required", phrase });
  });

  it.each([
    "- None. No\n  after-deploy step.",
    "- None after\n  deploy.",
    "- No\n  after-deploy step is needed.",
    "- None after the\n  next deploy; the job reads the new column.",
    "- After deploy,\n  nothing; the feature stays off.",
    "- After deploy, nothing changes for members.",
    "- Nothing to do once deployed.",
    "- No step is needed after the upgrade.",
    "- No operator step after cutover.",
  ])("reads %j as no step, wrapped or not", (answer) => {
    expect(afterDeployMention(body({ manual: answer }))).toBeNull();
    expect(afterDeployMention(body({ impact: answer }))).toBeNull();
  });

  it("does not let a changelog entry stand in for a deploy step", () => {
    const diff = [...CODE, ...changes("A changelog.d/5309-stuck-report.md")];
    expect(() => validateDeployFragment(body({ manual: "- After deploy, run it." }), diff, { contentsOf: headOf({}) })).toThrow(
      /adds no changelog\.d/,
    );
  });

  it("fails an unknown diff rather than pass on no evidence", () => {
    expect(() => validateDeployFragment(body(), null, { contentsOf: headOf({}) })).toThrow(/The PR diff is unknown/);
  });
});
