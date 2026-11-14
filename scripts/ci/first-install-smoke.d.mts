// #4977: the TypeScript surface of `first-install-smoke.mjs`, which stays
// JavaScript so the CI step runs it with a bare `node` and no install.
// `src/lib/__tests__/first-install-seed-contract.test.ts` imports
// `firstInstallSteps` and `fillPlaceholders` from it; keep this in step with the
// `export` statements in the `.mjs`.
export declare const DEPLOYMENT_DOC: string;
export declare const FIRST_BOOTSTRAP_HEADING: string;
export declare const SMOKE_PROJECT: string;
export declare function firstBootstrapBlocks(markdown: string): Array<{ lang: string; text: string }>;
export declare function firstInstallSteps(
  markdown: string,
): Record<string, { text: string; line: string }>;
export declare function fillPlaceholders(text: string, values: Record<string, string>): string;
