import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectFlakyTests, renderFlakySummary } from "./summarise-playwright-flaky.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const test = (status, statuses, projectName = "chromium") => ({
  projectName, status, expectedStatus: "passed",
  results: statuses.map((status, retry) => ({ status, retry })),
});
const report = (...tests) => ({ suites: [{ title: "waitlist.spec.ts", file: "waitlist.spec.ts", specs: [], suites: [{
  title: "offer journey", file: "waitlist.spec.ts", specs: [{
    file: "waitlist.spec.ts", title: "accepts offer", tests,
  }],
}] }] });

function run(contents) {
  const root = mkdtempSync(path.join(tmpdir(), "playwright-flaky-"));
  roots.push(root);
  const file = path.join(root, "results.json");
  const summary = path.join(root, "summary.md");
  writeFileSync(summary, "Existing summary\n");
  if (contents !== undefined) writeFileSync(file, contents);
  const result = spawnSync(process.execPath, ["scripts/ci/summarise-playwright-flaky.mjs", file], {
    encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  return { ...result, summary: readFileSync(summary, "utf8") };
}

describe("Playwright flaky reporting", () => {
  it("finds nested flaky tests per project and counts failed and total attempts", () => {
    expect(collectFlakyTests(report(
      test("flaky", ["failed", "timedOut", "passed"]),
      test("flaky", ["interrupted", "passed"], "mobile"),
      test("unexpected", ["failed", "failed", "failed"]),
      test("expected", ["passed"]), test("skipped", ["skipped"]),
    ))).toEqual([
      { file: "waitlist.spec.ts", title: "offer journey › accepts offer", project: "chromium", failedAttempts: 2, attempts: 3 },
      { file: "waitlist.spec.ts", title: "offer journey › accepts offer", project: "mobile", failedAttempts: 1, attempts: 2 },
    ]);
  });

  it("resolves JSON testDir paths relative to the checkout for warning annotations", () => {
    const input = report(test("flaky", ["failed", "passed"]));
    input.config = { rootDir: path.resolve("e2e") };
    expect(collectFlakyTests(input)[0].file).toBe("e2e/waitlist.spec.ts");
    expect(run(JSON.stringify(input)).stdout).toContain("::warning file=e2e/waitlist.spec.ts::");
  });

  it.each([
    test("expected", ["passed"]),
    test("unexpected", ["failed", "failed", "failed"]),
    test("skipped", ["skipped"]),
  ])("does not turn a non-flaky outcome into a warning: %j", (entry) => {
    const result = run(JSON.stringify(report(entry)));
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("::warning");
    expect(result.summary).toContain("No flaky tests");
  });

  it("appends a table and warns for every flaky project without failing", () => {
    const result = run(JSON.stringify(report(test("flaky", ["failed", "passed"]), test("flaky", ["failed", "passed"], "multi-lodge"))));
    expect(result.status).toBe(0);
    expect(result.summary).toContain("Existing summary\n");
    expect(result.summary).toContain("| Spec | Test | Project | Failed attempts | Total attempts |");
    expect(result.summary).toContain("| waitlist.spec.ts | offer journey › accepts offer | multi-lodge | 1 | 2 |");
    expect(result.stdout.match(/::warning file=waitlist.spec.ts::/g)).toHaveLength(2);
    expect(result.stdout).toContain("1 failed attempt(s) out of 2");
  });

  it.each([undefined, "{", "{}", '{"suites":[{}]}', '{"suites":null}'])("fails loudly on a missing or invalid report: %j", (contents) => {
    const result = run(contents);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot summarise Playwright results:");
    expect(result.summary).not.toContain("No flaky tests");
  });

  it("escapes table cells and workflow commands so titles cannot inject output", () => {
    const input = report(test("flaky", ["failed", "passed"]));
    const spec = input.suites[0].suites[0].specs[0];
    spec.title = "<b>a|b</b>\n::error::injected%";
    spec.file = "spec,name.ts\n::error::file";
    const flaky = collectFlakyTests(input);
    expect(renderFlakySummary(flaky)).toContain("&lt;b&gt;a&#124;b&lt;/b&gt;<br>::error::injected%");
    const result = run(JSON.stringify(input));
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("\n::error::");
    expect(result.stdout).toContain("file=spec%2Cname.ts%0A%3A%3Aerror%3A%3Afile::");
    expect(result.stdout).toContain("%0A::error::injected%25");
  });
});
