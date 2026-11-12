// #4977: the TypeScript surface of `first-install-smoke.mjs`, which stays
// JavaScript so the CI step runs it with a bare `node` and no install.
// `src/lib/__tests__/first-install-seed-contract.test.ts` imports
// `firstInstallCommands` from it; keep this in step with the `export`
// statements in the `.mjs`.
export declare const DEPLOYMENT_DOC: string;
export declare const FIRST_BOOTSTRAP_HEADING: string;
export declare const SMOKE_PROJECT: string;
export declare function firstBootstrapBlock(markdown: string): string;
export declare function firstInstallCommands(markdown: string): {
  postgres: string;
  migrate: string;
  seed: string;
};
