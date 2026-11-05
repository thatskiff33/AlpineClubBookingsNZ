// #4459: the TypeScript surface of `money-test-ratchet.mjs`, imported by its own
// test. The script stays JavaScript because a workflow runs it with a bare
// `node`. Keep this in step with its `export` statements.
export type MoneyTestBaseline = {
  coverage: Record<string, number>;
  mutation: { score: number; breakBelowPercent: number };
};
export type CoverageFigure = { pct: number | string; total?: number; covered?: number };
export type CoverageTotal = Record<string, CoverageFigure | undefined>;
export type CoverageSummary = Record<string, Record<string, CoverageFigure | undefined>>;
export type CoverageRow = {
  metric: string;
  against: "main" | "floor";
  reference: number;
  bar: number;
  current: number | null;
  delta: number | null;
  ok: boolean;
};
export type CoverageResult = { ok: boolean; against: "main" | "floor"; rows: CoverageRow[] };
export type MutationReport = {
  files?: Record<
    string,
    { mutants?: Array<{ status: string; mutatorName?: string; location?: { start?: { line?: number } } }> }
  >;
};
export type ScoredMutation = {
  score: number;
  counts: Record<"Killed" | "Timeout" | "Survived" | "NoCoverage", number>;
  judged: number;
  survivors: Array<{ file: string; line?: number; mutator?: string; status: string }>;
};

export const BASELINE_PATH: string;
export const DEFAULT_COVERAGE_SUMMARY: string;
export const DEFAULT_MUTATION_REPORT: string;
export const COVERAGE_METRICS: readonly string[];
export const MUTATION_BREAK_MARGIN: number;
export const COVERAGE_TOLERANCE_PP: number;
export const COVERAGE_WORKFLOW_FILE: string;
export function evaluateCoverage(total: CoverageTotal | undefined, baseline: Partial<MoneyTestBaseline>, base?: CoverageTotal | null): CoverageResult;
export function worstFiles(summary: CoverageSummary, limit?: number, cwd?: string): Array<{ file: string; uncovered: number; pct: number | null }>;
export function renderCoverageReport(result: CoverageResult, summary: CoverageSummary, extra?: string[]): string;
export function scoreFromMutationReport(report: MutationReport): ScoredMutation;
export function evaluateMutation(score: number, baseline: MoneyTestBaseline): { ok: boolean; floor: number; recorded: number };
export function renderMutationReport(result: { ok: boolean; floor: number; recorded: number }, scored: ScoredMutation): string;
export function raiseCoverageBaseline(baseline: MoneyTestBaseline, total: CoverageTotal | undefined): MoneyTestBaseline;
export function raiseMutationBaseline(baseline: MoneyTestBaseline, score: number): MoneyTestBaseline;
export function baselineLowered(base: Partial<MoneyTestBaseline>, current: Partial<MoneyTestBaseline>): string[];
export function listMoneyFiles(root?: string): string[];
export function baselineAtRef(ref: string, cwd?: string): MoneyTestBaseline | null;
export function latestMainRunId(options: {
  repository: string;
  token: string;
  fetchImpl?: (url: string, init?: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}): Promise<number | null>;
export function main(argv: string[]): Promise<number>;
