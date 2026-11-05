#!/usr/bin/env node
/**
 * The money-module test ratchet (#4459, programme #4450).
 *
 *   node scripts/ci/money-test-ratchet.mjs coverage [--summary <file>] [--base-ref <ref>]
 *   node scripts/ci/money-test-ratchet.mjs coverage --update  [--summary <file>]
 *   node scripts/ci/money-test-ratchet.mjs mutation [--report <file>] [--base-ref <ref>]
 *   node scripts/ci/money-test-ratchet.mjs mutation --update  [--report <file>]
 *   node scripts/ci/money-test-ratchet.mjs list-files
 *
 * WHAT IT JUDGES. `coverage` reads the `json-summary` Vitest wrote for the money
 * modules (`scripts/lib/money-modules.mjs`) and fails when any of the four
 * percentages is below the committed baseline, `money-test-baseline.json`.
 * `mutation` reads Stryker's `mutation.json`, reports the score, and fails below
 * the baseline's `breakBelowPercent` (Stryker's own `thresholds.break` stops a
 * run on the same figure; this is the report and the check for a stored report).
 *
 * THE BASELINE ONLY GOES UP, and nothing makes a lane edit it. Judging a PR
 * never writes the file, so unrelated lanes do not collide on it (the
 * fragment-directory rule, `changelog.d/README.md`, is for artifacts every lane
 * adds to; this one is raised on purpose, by `--update`, which keeps the higher
 * of the stored and measured figure). Given `--base-ref`, a baseline LOWER than
 * the base branch's also fails, so lowering the bar is a visible, refused edit
 * rather than a quiet one in a PR that removed well-covered code.
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
/** The four figures a Vitest `json-summary` carries per file and in total. */
export const COVERAGE_METRICS = ["lines", "statements", "functions", "branches"];
/** Stryker's own margin for timing noise: a score may sit this far under its stored figure. */
export const MUTATION_BREAK_MARGIN = 1;

const round2 = (value) => Math.round(value * 100) / 100;

/** A percentage read from a summary, or null when the report has none ("Unknown"). */
function pct(entry) {
  return typeof entry?.pct === "number" && Number.isFinite(entry.pct) ? entry.pct : null;
}

/**
 * Judge the summary's `total` against the baseline. A metric the summary has
 * no figure for (no branches in the measured files) cannot regress and passes.
 *
 * @returns {{ ok: boolean, rows: Array<{ metric: string, baseline: number, current: number | null, delta: number | null, ok: boolean }> }}
 */
export function evaluateCoverage(total, baseline) {
  const rows = COVERAGE_METRICS.map((metric) => {
    const stored = baseline.coverage?.[metric];
    if (typeof stored !== "number") throw new Error(`The baseline has no coverage.${metric} figure`);
    const current = pct(total?.[metric]);
    const delta = current === null ? null : round2(current - stored);
    return { metric, baseline: stored, current, delta, ok: current === null || current >= stored };
  });
  return { ok: rows.every((row) => row.ok), rows };
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
    `### Money-module coverage: ${result.ok ? "at or above the baseline" : "BELOW THE BASELINE"}`,
    "",
    "| Metric | Baseline | Now | Change | |",
    "| --- | ---: | ---: | ---: | --- |",
    ...result.rows.map((row) => {
      const change = row.delta === null ? "n/a" : `${row.delta > 0 ? "+" : ""}${row.delta}`;
      return `| ${row.metric} | ${row.baseline}% | ${row.current ?? "n/a"}% | ${change} | ${row.ok ? "ok" : "**lower**"} |`;
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

function baselineAtRef(ref) {
  try {
    return JSON.parse(execFileSync("git", ["show", `${ref}:${BASELINE_PATH}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    // The base predates the file: nothing to lower.
    return null;
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, update: false, summary: DEFAULT_COVERAGE_SUMMARY, report: DEFAULT_MUTATION_REPORT, baseRef: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--update") options.update = true;
    else if (arg === "--summary") options.summary = rest[++i];
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

export function main(argv) {
  const options = parseArgs(argv);
  if (options.command === "list-files") {
    process.stdout.write(`${listMoneyFiles().join("\n")}\n`);
    return 0;
  }
  if (options.command !== "coverage" && options.command !== "mutation") {
    process.stderr.write("Usage: money-test-ratchet.mjs coverage|mutation|list-files [--update] [--base-ref <ref>]\n");
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
    const result = evaluateCoverage(summary.total, baseline);
    emit(renderCoverageReport(result, summary));
    if (!result.ok) problems.push("money-module coverage is below the committed baseline");
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
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
