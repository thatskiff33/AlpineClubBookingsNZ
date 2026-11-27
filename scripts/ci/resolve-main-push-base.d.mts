// Types for resolve-main-push-base.mjs (INV-OPS-021, #5356), which stays
// JavaScript because `verify` and `migration-drift` run it with a bare `node`
// before installing. Keep this in step with its `export` statements.
export type GateStep = string | { name: string; was?: string[] };
export type WorkflowRun = { id: number; run_number: number; head_sha: string; status: string; conclusion: string | null };
type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
type Log = { log(message: string): void };

export declare const MainPushBaseError: { new (message?: string): Error; prototype: Error };
export declare function gitIsAncestor(sha: string): boolean;
export declare function resolveMainPushBase(options: {
  apiUrl?: string;
  repository: string;
  token: string;
  runNumber: number;
  headSha: string;
  job: string;
  jobWas?: string[];
  steps: GateStep[];
  isAncestor?: (sha: string) => boolean;
  fetchImpl?: FetchLike;
}): Promise<{ sha: string; run: WorkflowRun }>;
export declare function parseArgs(argv: string[]): { job: string; jobWas: string[]; steps: Array<{ name: string; was: string[] }> };
export declare function main(options?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  isAncestor?: (sha: string) => boolean;
  log?: Log;
}): Promise<number>;
