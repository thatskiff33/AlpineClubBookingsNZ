#!/usr/bin/env node
/**
 * The money-module test ratchet (#4459, programme #4450).
 *
 *   node scripts/ci/money-test-ratchet.mjs coverage [--summary <file>] [--base-summary <file>] [--base-ref <ref>]
 *   node scripts/ci/money-test-ratchet.mjs coverage --update  [--summary <file>]
 *   node scripts/ci/money-test-ratchet.mjs mutation [--report <file>] [--base-ref <ref>]
 *   node scripts/ci/money-test-ratchet.mjs mutation --update  [--report <file>]
 *   node scripts/ci/money-test-ratchet.mjs find-main-run
 *   node scripts/ci/money-test-ratchet.mjs list-files
 *
 * WHAT IT JUDGES. `coverage` reads the `json-summary` Vitest wrote for the money
 * modules (`scripts/lib/money-modules.mjs`) and fails when any of the four
 * percentages is lower than the bar. The bar is the latest successful `main`
 * run's own figure (`--base-summary`, that run's `money-coverage-summary`
 * artifact) less `COVERAGE_TOLERANCE_PP`, so a pull request that LOWERS the
 * percentage fails; with no such summary it is the committed floor in
 * `money-test-baseline.json`, and the report says which it used. `mutation` reads
 * Stryker's `mutation.json`, reports the score, and fails below the baseline's
 * `breakBelowPercent` (Stryker's own `thresholds.break` stops a run on the same
 * figure; this is the report and the check for a stored report).
 *
 * THE COMMITTED FLOOR ONLY GOES UP, and nothing makes a lane edit it. Judging a
 * PR never writes the file, so unrelated lanes do not collide on it (the
 * fragment-directory rule, `changelog.d/README.md`, is for artifacts every lane
 * adds to; this one is raised on purpose, by `--update`, which keeps the higher
 * of the stored and measured figure). Given `--base-ref`, a floor LOWER than
 * the base branch's also fails, so lowering the bar is a visible, refused edit
 * rather than a quiet one in a PR that removed well-covered code. A ref that is
 * not in the checkout, or a baseline that is not JSON, is an error: the guard
 * never passes by failing to look.
 *
 * It is report-and-fail, not required: the `Money coverage` workflow is not a
 * branch-protection context and this script writes its table to the job summary.
 *
 * Node built-ins only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { MONEY_MODULE_EXCLUDE_GLOBS, MONEY_MODULE_GLOBS } from "../lib/money-modules.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

export const BASELINE_PATH = "scripts/ci/money-test-baseline.json";
export const DEFAULT_COVERAGE_SUMMARY = "coverage/coverage-summary.json";
export const DEFAULT_MUTATION_REPORT = "reports/mutation/mutation.json";
/** The workflow whose latest successful `main` run supplies the base summary. */
export const COVERAGE_WORKFLOW_FILE = "money-coverage.yml";
/** The four figures a Vitest `json-summary` carries per file and in total. */
export const COVERAGE_METRICS = ["lines", "statements", "functions", "branches"];
/** Stryker's own margin for timing noise: a score may sit this far under its stored figure. */
export const MUTATION_BREAK_MARGIN = 1;
/**
 * How far below `main`'s own figure a pull request may measure before it fails.
 * Two decimals are compared; this absorbs a flaky test or a timing-dependent
 * branch, and is small enough that a PR dropping a real test of a module is seen.
 */
export const COVERAGE_TOLERANCE_PP = 0.1;

const round2 = (value) => Math.round(value * 100) / 100;

/** A percentage read from a summary, or null when the report has none ("Unknown"). */
function pct(entry) {
  return typeof entry?.pct === "number" && Number.isFinite(entry.pct) ? entry.pct : null;
}

/**
 * Judge the summary's `total`. The bar for each figure is the base summary's
 * figure less `COVERAGE_TOLERANCE_PP` (`base`, a `main` run's `total`) where it
 * has one, else the committed floor. A metric the summary has no figure for (no
 * branches in the measured files) cannot regress and passes.
 *
 * @returns {{ ok: boolean, against: "main" | "floor", rows: Array<{ metric: string, against: "main" | "floor", reference: number, bar: number, current: number | null, delta: number | null, ok: boolean }> }}
 */
export function evaluateCoverage(total, baseline, base = null) {
  const rows = COVERAGE_METRICS.map((metric) => {
    const floor = baseline.coverage?.[metric];
    if (typeof floor !== "number") throw new Error(`The baseline has no coverage.${metric} figure`);
    const mainPct = base ? pct(base[metric]) : null;
    const against = mainPct === null ? "floor" : "main";
    const reference = mainPct ?? floor;
    const bar = mainPct === null ? floor : round2(mainPct - COVERAGE_TOLERANCE_PP);
    const current = pct(total?.[metric]);
    const delta = current === null ? null : round2(current - reference);
    return { metric, against, reference, bar, current, delta, ok: current === null || current >= bar };
  });
  return { ok: rows.every((row) => row.ok), against: rows.every((row) => row.against === "main") ? "main" : "floor", rows };
}

/** Every file in the summary with uncovered lines, the worst first. */
export function worstFiles(summary, limit = 10, cwd = process.cwd()) {
  return Object.entries(summary)
    .filter(([file]) => file !== "total")
    .map(([file, entry]) => ({
      file: path.isAbsolute(file) ? path.relative(cwd, file) : file,
      uncovered: (entry.lines?.total ?? 0) - (entry.lines?.covered ?? 0),
      pct: pct(entry.lines),
    }))
    .filter((row) => row.uncovered > 0)
    .sort((a, b) => b.uncovered - a.uncovered || a.file.localeCompare(b.file))
    .slice(0, limit);
}

export function renderCoverageReport(result, summary, extra = []) {
  const lines = [
    `### Money-module coverage: ${result.ok ? "holds the bar" : "BELOW THE BAR"}`,
    "",
    result.against === "main"
      ? `Compared with the latest successful \`main\` run, allowing ${COVERAGE_TOLERANCE_PP} percentage points of measurement noise.`
      : "Compared with the committed floor in `scripts/ci/money-test-baseline.json`: no summary from a successful `main` run was available (none yet, or its artifact expired).",
    "",
    "| Metric | Compared with | Bar | Now | Change | |",
    "| --- | --- | ---: | ---: | ---: | --- |",
    ...result.rows.map((row) => {
      const change = row.delta === null ? "n/a" : `${row.delta > 0 ? "+" : ""}${row.delta}`;
      return `| ${row.metric} | ${row.against} ${row.reference}% | ${row.bar}% | ${row.current ?? "n/a"}% | ${change} | ${row.ok ? "ok" : "**lower**"} |`;
    }),
    "",
    `Measured over the money modules in \`scripts/lib/money-modules.mjs\` (${Object.keys(summary).length - 1} files, unreached ones at 0%).`,
    "Report-only unless a figure is lower: this job is not a required check.",
    "",
    "Files with the most uncovered lines:",
    "",
    ...worstFiles(summary).map((row) => `- \`${row.file}\`: ${row.uncovered} uncovered (${row.pct ?? "n/a"}% of lines)`),
    ...extra,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Stryker's score from its JSON report: detected (killed or timed out) over
 * everything that could have been detected (survived and uncovered count against
 * it; compile and runtime errors and ignored mutants are not mutants to judge).
 */
export function scoreFromMutationReport(report) {
  const counts = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0 };
  const survivors = [];
  for (const [file, entry] of Object.entries(report.files ?? {})) {
    for (const mutant of entry.mutants ?? []) {
      if (!(mutant.status in counts)) continue;
      counts[mutant.status] += 1;
      if (mutant.status === "Survived" || mutant.status === "NoCoverage") {
        survivors.push({ file, line: mutant.location?.start?.line, mutator: mutant.mutatorName, status: mutant.status });
      }
    }
  }
  const detected = counts.Killed + counts.Timeout;
  const judged = detected + counts.Survived + counts.NoCoverage;
  if (judged === 0) throw new Error("The mutation report holds no mutants to score");
  return { score: round2((detected / judged) * 100), counts, judged, survivors };
}

export function evaluateMutation(score, baseline) {
  const floor = baseline.mutation?.breakBelowPercent;
  if (typeof floor !== "number") throw new Error("The baseline has no mutation.breakBelowPercent figure");
  return { ok: score >= floor, floor, recorded: baseline.mutation.score };
}

export function renderMutationReport(result, scored) {
  return `${[
    `### Money-module mutation score: ${scored.score}% (${result.ok ? "at or above" : "BELOW"} the ${result.floor}% floor)`,
    "",
    `Recorded score ${result.recorded}%. ${scored.counts.Killed} killed, ${scored.counts.Timeout} timed out, ${scored.counts.Survived} survived, ${scored.counts.NoCoverage} not covered, of ${scored.judged} mutants.`,
    "",
    "Survivors and uncovered mutants, by file and line (open the HTML report for the code):",
    "",
    ...scored.survivors.slice(0, 40).map((s) => `- \`${s.file}:${s.line}\` ${s.mutator} (${s.status})`),
  ].join("\n")}\n`;
}

/** Keep the higher of each stored and measured figure; the file only goes up. */
export function raiseCoverageBaseline(baseline, total) {
  const next = { ...baseline, coverage: { ...baseline.coverage } };
  for (const metric of COVERAGE_METRICS) {
    const current = pct(total?.[metric]);
    if (current !== null) next.coverage[metric] = Math.max(next.coverage[metric] ?? 0, current);
  }
  return next;
}

export function raiseMutationBaseline(baseline, score) {
  const stored = baseline.mutation?.score ?? 0;
  const raised = Math.max(stored, score);
  return {
    ...baseline,
    mutation: {
      score: raised,
      breakBelowPercent: Math.max(baseline.mutation?.breakBelowPercent ?? 0, Math.floor(raised) - MUTATION_BREAK_MARGIN),
    },
  };
}

/** Problems with `current` being lower than `base` anywhere. */
export function baselineLowered(base, current) {
  const problems = [];
  for (const metric of COVERAGE_METRICS) {
    const was = base.coverage?.[metric];
    const now = current.coverage?.[metric];
    if (typeof was === "number" && !(now >= was)) problems.push(`coverage.${metric} ${was} -> ${now}`);
  }
  for (const key of ["score", "breakBelowPercent"]) {
    const was = base.mutation?.[key];
    const now = current.mutation?.[key];
    if (typeof was === "number" && !(now >= was)) problems.push(`mutation.${key} ${was} -> ${now}`);
  }
  return problems;
}

/** The files the money globs match on disk, for `vitest related`. */
export function listMoneyFiles(root = process.cwd()) {
  const found = new Set();
  for (const pattern of MONEY_MODULE_GLOBS) {
    for (const file of fs.globSync(pattern, { cwd: root })) found.add(file.split(path.sep).join("/"));
  }
  return [...found]
    .filter((file) => !MONEY_MODULE_EXCLUDE_GLOBS.some((glob) => path.posix.matchesGlob(file, glob)))
    .sort();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The text of a failed `execFileSync`, where git wrote what went wrong. */
const failureText = (error) => `${error?.stderr ?? ""}${error?.message ?? ""}`;

/**
 * The baseline as `ref` holds it, or null where `ref` has no such file (the base
 * predates it). Everything else throws: a ref that is not a commit here (an
 * unfetched branch), a git failure, or a file that is not JSON. The guard it
 * feeds would otherwise pass by not looking.
 */
export function baselineAtRef(ref, cwd = process.cwd()) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    throw new Error(`--base-ref ${ref} is not a commit in this checkout; fetch it before judging against it`);
  }
  let raw;
  try {
    raw = git(["show", `${ref}:${BASELINE_PATH}`]);
  } catch (error) {
    if (/does not exist in|exists on disk, but not in/.test(failureText(error))) return null;
    throw error;
  }
  return JSON.parse(raw);
}

/**
 * The id of the latest successful `push` run of the coverage workflow on
 * `main`, or null where there is none. `fetchImpl` is `fetch` in CI.
 */
export async function latestMainRunId({ repository, token, fetchImpl = fetch }) {
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${COVERAGE_WORKFLOW_FILE}/runs?branch=main&event=push&status=success&per_page=1`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`Listing ${COVERAGE_WORKFLOW_FILE} runs answered ${response.status}`);
  const body = await response.json();
  const id = body?.workflow_runs?.[0]?.id;
  return typeof id === "number" ? id : null;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    update: false,
    summary: DEFAULT_COVERAGE_SUMMARY,
    baseSummary: null,
    report: DEFAULT_MUTATION_REPORT,
    baseRef: null,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--update") options.update = true;
    else if (arg === "--summary") options.summary = rest[++i];
    else if (arg === "--base-summary") options.baseSummary = rest[++i];
    else if (arg === "--report") options.report = rest[++i];
    else if (arg === "--base-ref") options.baseRef = rest[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function emit(text) {
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

/** `find-main-run`: print the run id (empty when none) and write `run_id` for the workflow. */
async function findMainRun() {
  const { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = process.env;
  if (!repository || !token) throw new Error("find-main-run needs GITHUB_REPOSITORY and GITHUB_TOKEN");
  let id = null;
  try {
    id = await latestMainRunId({ repository, token });
  } catch (error) {
    // Not fatal: the judge falls back to the committed floor and says so.
    process.stderr.write(`::warning::Could not find a main run to compare with (${error.message}); using the committed floor.\n`);
  }
  const line = `run_id=${id ?? ""}\n`;
  process.stdout.write(line);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
  return 0;
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.command === "list-files") {
    process.stdout.write(`${listMoneyFiles().join("\n")}\n`);
    return 0;
  }
  if (options.command === "find-main-run") return findMainRun();
  if (options.command !== "coverage" && options.command !== "mutation") {
    process.stderr.write("Usage: money-test-ratchet.mjs coverage|mutation|find-main-run|list-files [--update] [--base-ref <ref>]\n");
    return 2;
  }
  const baseline = readJson(BASELINE_PATH);

  const problems = [];
  if (options.baseRef) {
    const base = baselineAtRef(options.baseRef);
    if (base) problems.push(...baselineLowered(base, baseline).map((p) => `the baseline was lowered: ${p}`));
  }

  if (options.command === "coverage") {
    const summary = readJson(options.summary);
    if (options.update) {
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(raiseCoverageBaseline(baseline, summary.total), null, 2)}\n`);
      process.stdout.write(`Raised ${BASELINE_PATH} to the measured coverage (never lowered).\n`);
      return 0;
    }
    const base = options.baseSummary && fs.existsSync(options.baseSummary) ? readJson(options.baseSummary).total : null;
    const result = evaluateCoverage(summary.total, baseline, base);
    emit(renderCoverageReport(result, summary));
    if (!result.ok) problems.push(`money-module coverage is lower than the ${result.against === "main" ? "latest main run" : "committed floor"}`);
  } else {
    const scored = scoreFromMutationReport(readJson(options.report));
    if (options.update) {
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(raiseMutationBaseline(baseline, scored.score), null, 2)}\n`);
      process.stdout.write(`Raised ${BASELINE_PATH} to the measured mutation score (never lowered).\n`);
      return 0;
    }
    const result = evaluateMutation(scored.score, baseline);
    emit(renderMutationReport(result, scored));
    if (!result.ok) problems.push("the mutation score is below the committed floor");
  }

  for (const problem of problems) process.stderr.write(`::error::${problem}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
