import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jobBlock, stepBlock } from "../../src/lib/__tests__/helpers/ci-workflow";
import { PLAYWRIGHT_RESULTS_FILE, collectFlakyTests, renderFlakySummary } from "./summarise-playwright-flaky.mjs";

type Attempt = "passed" | "failed" | "timedOut" | "interrupted" | "skipped";
type Outcome = "expected" | "unexpected" | "skipped" | "flaky";
type Spec = { file: string; title: string; tests: ReturnType<typeof test>[] };
type Suite = { title: string; file: string; specs: Spec[]; suites?: Suite[] };
type Report = { config?: { rootDir: string }; suites: Suite[] };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const test = (status: Outcome, statuses: Attempt[], projectName = "chromium") => ({
  projectName, status, expectedStatus: "passed",
  results: statuses.map((status, retry) => ({ status, retry })),
});
const report = (...tests: ReturnType<typeof test>[]): Report => ({ suites: [{ title: "waitlist.spec.ts", file: "waitlist.spec.ts", specs: [], suites: [{
  title: "offer journey", file: "waitlist.spec.ts", specs: [{
    file: "waitlist.spec.ts", title: "accepts offer", tests,
  }],
}] }] });

const SCRIPT = path.resolve("scripts/ci/summarise-playwright-flaky.mjs");

/** Runs the script as CI does, from the checkout. `byDefault` passes no path and runs from a temp checkout holding the shared default file. */
function run(contents: string | undefined, { byDefault = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "playwright-flaky-"));
  roots.push(root);
  const file = byDefault ? path.join(root, PLAYWRIGHT_RESULTS_FILE) : path.join(root, "results.json");
  const summary = path.join(root, "summary.md");
  writeFileSync(summary, "Existing summary\n");
  mkdirSync(path.dirname(file), { recursive: true });
  if (contents !== undefined) writeFileSync(file, contents);
  const result = spawnSync(process.execPath, byDefault ? [SCRIPT] : [SCRIPT, file], {
    encoding: "utf8", cwd: byDefault ? root : process.cwd(), env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
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
    expect(collectFlakyTests(input)[0]?.file).toBe("e2e/waitlist.spec.ts");
    expect(run(JSON.stringify(input)).stdout).toContain(",file=e2e/waitlist.spec.ts::");
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
    expect(result.stdout.match(/^::warning title=Flaky Playwright test,file=waitlist\.spec\.ts::/gm)).toHaveLength(2);
    expect(result.stdout).toContain("1 failed attempt(s) out of 2");
  });

  it("reads the shared results path when given no argument, as both workflow steps run it", () => {
    const result = run(JSON.stringify(report(test("flaky", ["failed", "passed"]))), { byDefault: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning title=Flaky Playwright test");
    expect(run(undefined, { byDefault: true }).status).toBe(1);
  });

  it.each([undefined, "{", "{}", '{"suites":[{}]}', '{"suites":null}'])("fails loudly on a missing or invalid report: %j", (contents) => {
    const result = run(contents);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot summarise Playwright results:");
    expect(result.summary).not.toContain("No flaky tests");
  });

  it("escapes table cells and workflow commands so titles cannot inject output", () => {
    const input = report(test("flaky", ["failed", "passed"]));
    const spec = input.suites[0]?.suites?.[0]?.specs[0];
    if (!spec) throw new Error("fixture has no nested spec");
    spec.title = "<b>a|b</b>\n::error::injected%";
    spec.file = "spec,name.ts\n::error::file";
    const flaky = collectFlakyTests(input);
    expect(renderFlakySummary(flaky)).toContain("&lt;b&gt;a&#124;b&lt;/b&gt;<br>::error::injected%");
    const result = run(JSON.stringify(input));
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("\n::error::");
    expect(result.stdout).toContain(",file=spec%2Cname.ts%0A%3A%3Aerror%3A%3Afile::");
    expect(result.stdout).toContain("%0A::error::injected%25");
  });
});

// Reporting is lost silently on the green path if a step is dropped, reordered or
// pointed at another file, so both CI homes of the summariser are pinned (#4991).
describe("Playwright flaky reporting wiring", () => {
  const action = readFileSync(".github/actions/e2e-run/action.yml", "utf8");
  const rollover = jobBlock(readFileSync(".github/workflows/e2e-rollover-proof.yml", "utf8"), "rollover-proof");
  const NAME = "Summarise flaky Playwright tests";
  const homes = [
    { home: "e2e-run action", text: action, ran: "Run Playwright", id: "playwright", then: "Upload Playwright report" },
    { home: "rollover proof", text: rollover, ran: "Run the browser suite under the shifted clock", id: "browser-suite", then: "Upload Playwright report" },
  ];

  it.each(homes)("runs the summariser in the $home after Playwright, before the upload, with no path of its own", ({ text, ran, id, then }) => {
    const summarise = stepBlock(text, NAME);
    expect(summarise, `${NAME} step`).not.toBe("");
    // No argument: the script and the config share PLAYWRIGHT_RESULTS_FILE.
    expect(summarise).toMatch(/^\s+run: node scripts\/ci\/summarise-playwright-flaky\.mjs$/m);
    expect(summarise).toContain(`if: always() && steps.${id}.outcome != 'skipped'`);
    expect(summarise).not.toContain("continue-on-error");
    expect(stepBlock(text, ran)).toContain(`id: ${id}`);
    expect(text.indexOf(`- name: ${ran}`)).toBeLessThan(text.indexOf(`- name: ${NAME}`));
    expect(text.indexOf(`- name: ${NAME}`)).toBeLessThan(text.indexOf(`- name: ${then}`));
  });

  it("summarises the rollover proof only after the runner's clock is restored", () => {
    expect(rollover.indexOf("- name: Restore the runner's clock")).toBeGreaterThan(-1);
    expect(rollover.indexOf("- name: Restore the runner's clock")).toBeLessThan(rollover.indexOf(`- name: ${NAME}`));
  });
});
