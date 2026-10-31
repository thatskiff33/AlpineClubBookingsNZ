import { decideScope, pullRequestChangedFiles, reportScope } from "./change-scope.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

// #4397: whether a pull request can change what the browser suite exercises.
// 23 of 100 merged PRs touched only docs, unit tests or agent notes, and each
// waited ~29 minutes for an E2E verdict their diff could not move. The E2E
// jobs run this as a STEP and skip their heavy steps only when it writes
// `needed=false` (a missing or garbled answer runs the suite), so every
// required check still reports a real pass or failure (CONTRIBUTING.md ->
// "Branch protection": never a job-level `if:`). The change list and the
// fail-toward-running rule are `change-scope.mjs`'s, shared with the CI jobs
// that skip the same way (#4425).
//
// An allowlist, never a denylist: a path joins only when it cannot reach the
// app image, the seeded database or a spec. Anything unmatched - the rest of
// src/, e2e/, prisma/ (a README in a migration folder included), scripts/,
// workflows, package files, config - runs the suite. Every failure to
// classify answers "needed".
const NOT_EXERCISED_BY_E2E = [
  /^docs\//,
  /^changelog\.d\//,
  /^size-allowances\.d\//,
  /^dependency-mitigations\.d\//,
  /^\.claude\//,
  /^\.codex\//,
  /^\.sekreton\//,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/pull_request_template\.md$/,
  /^\.gitleaks\.toml$/,
  /^\.gitleaksignore$/,
  // Markdown at the repository root only (AGENTS.md, CONTRIBUTING.md, ...).
  /^[^/]+\.md$/,
  // Unit tests and their fixtures: never loaded by the app or by Playwright.
  /^src\/(?:.+\/)?__tests__\//,
  /^src\/.+\.test\.tsx?$/,
  /^scripts\/(?:.+\/)?[^/]+\.test\.m?[jt]s$/,
];

export function e2eNeeded(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { needed: true, reason: "no changed-file list, so the suite runs" };
  }
  const exercised = files.filter((file) => !NOT_EXERCISED_BY_E2E.some((pattern) => pattern.test(file)));
  if (exercised.length > 0) {
    return { needed: true, reason: `${exercised.length} changed file(s) can reach the suite, e.g. ${exercised[0]}` };
  }
  return { needed: false, reason: `all ${files.length} changed file(s) are docs, unit tests or agent notes` };
}

export function decide(eventName, listFiles = pullRequestChangedFiles) {
  return decideScope(eventName, e2eNeeded, listFiles);
}

if (isMainModule(import.meta.url)) {
  reportScope("E2E", decide(process.env.GITHUB_EVENT_NAME));
}
