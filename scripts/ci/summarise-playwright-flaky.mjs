#!/usr/bin/env node
// Warn on retries that turned green; Playwright still owns the test verdict.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "../lib/is-main-module.mjs";

/** Extract flaky outcomes from Playwright's JSON reporter (not attempt statuses). */
export function collectFlakyTests(report, workspace = process.cwd()) {
  const flaky = [];
  const array = (value) => {
    if (!Array.isArray(value)) throw new Error("Invalid Playwright report: expected an array");
    return value;
  };
  const string = (value) => {
    if (typeof value !== "string") throw new Error("Invalid Playwright report: expected a string");
    return value;
  };
  const visit = (suite, parents = []) => {
    const title = string(suite.title);
    // The root suite names the file, which already has its own table column.
    const titles = [...parents, title];
    for (const spec of array(suite.specs)) {
      const specFile = string(spec.file);
      // JSON paths are relative to testDir; annotations are relative to the checkout.
      const file = report.config?.rootDir
        ? path.relative(workspace, path.resolve(report.config.rootDir, specFile)).split(path.sep).join("/")
        : specFile;
      const testTitle = [...titles.slice(1), string(spec.title)].join(" › ");
      for (const test of array(spec.tests)) {
        if (!["expected", "unexpected", "skipped", "flaky"].includes(test.status)) {
          throw new Error("Invalid Playwright report: unknown test outcome");
        }
        const results = array(test.results);
        const project = string(test.projectName);
        if (test.status !== "flaky") continue;
        flaky.push({
          file, title: testTitle, project,
          failedAttempts: results.filter((result) => ["failed", "timedOut", "interrupted"].includes(result.status)).length,
          attempts: results.length,
        });
      }
    }
    for (const child of array(suite.suites ?? [])) visit(child, titles);
  };
  for (const suite of array(report.suites)) visit(suite);
  return flaky;
}

function markdown(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;").replace(/\r\n|\r|\n/g, "<br>");
}

/** One job's warning-only summary, shared by the composite action and rollover proof. */
export function renderFlakySummary(tests) {
  const heading = "\n## Flaky Playwright tests\n\n";
  if (tests.length === 0) return `${heading}No flaky tests\n`;
  return heading + [
    "Policy: warn on every flaky test; flaky tests alone do not fail this job.", "",
    "| Spec | Test | Project | Failed attempts | Total attempts |",
    "| --- | --- | --- | ---: | ---: |",
    ...tests.map((test) => `| ${[test.file, test.title, test.project, test.failedAttempts, test.attempts].map(markdown).join(" | ")} |`),
    "",
  ].join("\n");
}

// GitHub workflow-command data and properties have different escaping rules.
function commandData(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

if (isMainModule(import.meta.url)) {
  try {
    const file = process.argv[2];
    if (!file) throw new Error("Usage: node scripts/ci/summarise-playwright-flaky.mjs <report.json>");
    const tests = collectFlakyTests(JSON.parse(readFileSync(file, "utf8")));
    const summary = renderFlakySummary(tests);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    else process.stdout.write(summary);
    for (const test of tests) {
      const file = commandData(test.file).replaceAll(":", "%3A").replaceAll(",", "%2C");
      const message = commandData(`[${test.project}] ${test.title}: ${test.failedAttempts} failed attempt(s) out of ${test.attempts}.`);
      console.log(`::warning file=${file}::${message}`);
    }
  } catch (error) {
    console.error(`Cannot summarise Playwright results: ${error.message}`);
    process.exitCode = 1;
  }
}
