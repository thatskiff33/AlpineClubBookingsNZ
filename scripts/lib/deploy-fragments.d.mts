// #5379: the TypeScript surface of `deploy-fragments.mjs`, which stays
// JavaScript because the `verify` gate and `release:cut` run it under bare
// node. The census `src/lib/__tests__/changelog-fragment-shape.test.ts`
// imports it; keep this in step with the `export` statements in the `.mjs`.
export type DeployStep = { name: string; pr: number | null; who: string; what: string; check: string };
export type DeployRepository = { host: string; owner: string; name: string };
export declare const DEPLOY_FRAGMENT_SUFFIX: string;
export declare const DEPLOY_HEADINGS: readonly string[];
export declare const DEPLOY_ROLES: readonly string[];
export declare const AFTER_DEPLOY_TITLE: string;
export declare const DEPLOY_STEPS_START: string;
export declare const DEPLOY_STEPS_END: string;
export declare const DEPLOY_STEPS_INTRO: string;
export declare function isDeployFragmentName(name: string): boolean;
export declare function deployFragmentProblems(name: string, text: string): string[];
export declare function parseDeployFragment(name: string, text: string): DeployStep;
export declare function renderDeployStepItems(steps: DeployStep[], repo?: DeployRepository | null): string[];
export declare function deployStepsBlock(items: string[]): string[];
export declare function findDeploySteps(text: string): { start: number; end: number; items: string[] } | null;
export declare function countDeploySteps(items: string[]): number;
export declare function appendDeploySteps(text: string, items: string[]): string;
