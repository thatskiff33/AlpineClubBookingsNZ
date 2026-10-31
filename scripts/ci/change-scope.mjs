import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { gitDiffChangedFiles, parseNameStatus } from "./pr-body.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

// #4397, #4425: whether a pull request's change can move what a required CI
// job proves. A job runs this as a STEP and skips its heavy steps only when it
// writes `needed=false` (a missing or garbled answer runs them), so the
// required check still reports a real pass or failure (CONTRIBUTING.md ->
// "Branch protection": never a job-level `if:`). Every run that is not a pull
// request answers "needed", and so does every failure to list or classify the
// change. `e2e-scope.mjs` asks the browser suite's question through the same
// machinery; the scopes below are the CLI's (`node scripts/ci/change-scope.mjs
// <scope>`).
//
// These are TRIGGER lists: a scope is needed when any changed file matches one
// of its patterns. Narrowing a list is a policy change; widening one only ever
// runs more.
const WORKFLOW_AND_CLASSIFIER = [
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/ci\/change-scope\.mjs$/,
  /^scripts\/ci\/pr-body\.mjs$/,
];

export const CHANGE_SCOPES = {
  // `Migration drift check` and `Data migration verification` (#4425): the
  // schema, the migrations and their fixtures, and the real-Postgres harness
  // those two jobs run - each test, helper and script their steps name - plus
  // the toolchain that runs it. NOT the application modules the race harnesses
  // import: their import closure covers most of src/lib, which would make
  // this skip almost never fire (measured: 84 of the last 100 merged PRs).
  // Such a change runs these jobs on the push to `main`.
  // `change-scope.test.mjs` fails when a step of either job names a file this
  // list does not match.
  migrations: {
    subject: "the migration and real-Postgres jobs",
    triggers: [
      /^prisma\//,
      /^prisma\.config\.ts$/,
      /^package\.json$/,
      /^pnpm-lock\.yaml$/,
      /^pnpm-workspace\.yaml$/,
      /^patches\//,
      /^vitest\.config\.mts$/,
      /^tsconfig(?:\.[\w-]+)?\.json$/,
      /^vitest\.[\w-]+\.ts$/,
      /^src\/lib\/__tests__\/[^/]+\.realdb\.test\.ts$/,
      /^src\/lib\/__tests__\/(?:helpers|support)\//,
      /^src\/lib\/__tests__\/(?:xero-member-grouping-migration|email-message-annotation-strip|public-book-now-default-off-migration|booking-guest-range-triggers|manual-refund-task-constraints)\.test\.ts$/,
      /^scripts\/check-migration-safety-coverage\.sh$/,
      /^scripts\/validate-blue-green-migrations\.sh$/,
      /^scripts\/check-data-migration-verification\.sh$/,
      /^scripts\/data-migration-verification-grandfathered\.txt$/,
      /^scripts\/lib\/split-sql-statements\.awk$/,
      /^scripts\/check-partial-indexes\.sh$/,
      /^scripts\/booking-ledger-seed-gate\.sh$/,
      /^scripts\/booking-ledger-census\.ts$/,
      /^scripts\/backfill-booking-ledger\.ts$/,
      ...WORKFLOW_AND_CLASSIFIER,
    ],
  },
  // `Image security gate (Trivy CRITICAL)` (#4425, owner decision 26 Oct
  // 2026): only a change to the dependencies or the image definition can bring
  // a new package into the image, so only one of those, or a change to the
  // workflow, rebuilds and scans it on a pull request. `.trivyignore` joins
  // the owner's list because it changes the scan's verdict, not the image.
  image: {
    subject: "the image build and Trivy scan",
    triggers: [
      /^package\.json$/,
      /^pnpm-lock\.yaml$/,
      /^pnpm-workspace\.yaml$/,
      /^patches\//,
      /^Dockerfile$/,
      /^docker-compose[^/]*\.yml$/,
      /^\.dockerignore$/,
      /^\.trivyignore$/,
      ...WORKFLOW_AND_CLASSIFIER,
    ],
  },
};

/** A trigger-list answer: needed when any changed file matches. */
export function touchesAny(files, triggers, subject) {
  if (!Array.isArray(files) || files.length === 0) {
    return { needed: true, reason: `no changed-file list, so ${subject} run` };
  }
  // Git quotes a path holding `"`, `\\`, a tab or a newline even with
  // core.quotePath=false; a quoted path can't be matched reliably, so it runs.
  const quoted = files.find((file) => file.startsWith('"'));
  if (quoted !== undefined) return { needed: true, reason: `${quoted} is a quoted path, so ${subject} run` };
  const hit = files.find((file) => triggers.some((pattern) => pattern.test(file)));
  if (hit !== undefined) return { needed: true, reason: `${hit} can change ${subject}` };
  return { needed: false, reason: `none of the ${files.length} changed file(s) can change ${subject}` };
}

/**
 * The pull request's own change: the merge commit GitHub tests, against its
 * first parent (the base tip), read with the repository's one changed-file
 * reader (`pr-body.mjs`; a rename counts as both of its paths). The checkout
 * needs `fetch-depth: 2` for that parent.
 */
export function pullRequestChangedFiles({
  run = (args) => execFileSync("git", args, { encoding: "utf8" }),
  diff = () => gitDiffChangedFiles("HEAD^1", "HEAD"),
} = {}) {
  const parents = run(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
  if (parents.length !== 3) throw new Error(`HEAD is not a two-parent merge commit (${parents.length - 1} parent(s))`);
  return parseNameStatus(diff()).map((record) => record.path);
}

/**
 * The one fail-toward-running rule: only a pull request whose change lists
 * and classifies cleanly can answer "not needed".
 */
export function decideScope(eventName, classify, listFiles = pullRequestChangedFiles) {
  if (eventName !== "pull_request") {
    return { needed: true, reason: `a ${eventName || "non-PR"} run always runs in full` };
  }
  try {
    const answer = classify(listFiles());
    if (typeof answer?.needed !== "boolean") throw new Error("the classifier gave no answer");
    return answer;
  } catch (error) {
    return { needed: true, reason: `could not classify the change (${error.message}), so it runs` };
  }
}

/** Print the answer and hand it to later steps as `steps.<id>.outputs.needed`. */
export function reportScope(label, { needed, reason }, outputPath = process.env.GITHUB_OUTPUT) {
  console.log(`${label} ${needed ? "needed" : "not needed"}: ${reason}`);
  if (outputPath) appendFileSync(outputPath, `needed=${needed}\n`);
}

if (isMainModule(import.meta.url)) {
  const name = process.argv[2];
  const scope = Object.hasOwn(CHANGE_SCOPES, name ?? "") ? CHANGE_SCOPES[name] : undefined;
  // An unknown scope is a classification error like any other: run.
  const answer = scope
    ? decideScope(process.env.GITHUB_EVENT_NAME, (files) => touchesAny(files, scope.triggers, scope.subject))
    : { needed: true, reason: `unknown scope ${JSON.stringify(name)}, so it runs` };
  reportScope(scope ? `Scope "${name}"` : "Scope", answer);
}
