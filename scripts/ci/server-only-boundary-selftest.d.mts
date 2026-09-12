// #2693: the TypeScript surface of `server-only-boundary-selftest.mjs`, which
// stays JavaScript because the `verify` job runs it with a bare `node`.
// `src/lib/__tests__/client-server-boundary-census.test.ts` imports
// `MARKED_ROOTS` and `MARKER_STATEMENT` from it; keep this in step with the
// `export` statements in the `.mjs`.
export declare const REPO_ROOT: string;
export declare const FIXTURE_SEGMENT: string;
export declare const FIXTURE_DIR: string;
export declare const FIXTURE_PAGE: string;
export declare const FIXTURE_BRIDGE: string;
export declare const PROTECTED_ROOTS: readonly string[];
export declare const MARKER_STATEMENT: string;
export declare const MARKED_ROOTS: readonly string[];
export declare const BOUNDARY_MESSAGE: string;
export declare const BROWSER_LAYER: string;
export declare const SUCCESS_PREFIX: string;
export declare function stripAnsi(text: string): string;
export declare function splitErrorBlocks(output: string): string[];
export declare function problemsWithSeededBuild(result: {
  exitCode: number | null;
  output: string;
}): string[];
export declare function isDirectInvocation(
  argvPath: string | undefined,
  moduleUrl: string,
): boolean;
