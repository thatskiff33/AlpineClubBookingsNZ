import { afterDeployMention, validateDeployFragment } from "./check-pr-deploy-fragment.mjs";

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
    const releasePrep = changes("D changelog.d/5309-stuck-report.deploy.md", "D changelog.d/5379-x.md", "M CHANGELOG.md", "M package.json");
    expect(validateDeployFragment(named, releasePrep, { contentsOf: headOf({}) }).outcome).toBe("release-prep");
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
