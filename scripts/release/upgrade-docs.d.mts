// #4979: the TypeScript surface of `upgrade-docs.mjs`, which stays JavaScript
// because `release:cut` runs it under bare node. The census
// `src/lib/__tests__/upgrade-docs-scope.test.ts` imports it; keep this in step
// with the `export` statements in the `.mjs`.
export type MarkdownHeading = { level: number; line: string; index: number };
export type UnreleasedBlock = {
  start: number;
  end: number;
  hasSteps: boolean;
  opensWithChecklist: boolean;
};
export type RunbookScope = { agnostic: true } | { agnostic: false; version: string | null };
export declare const UPGRADING_PATH: string;
export declare const RUNBOOK_PATH: string;
export declare const UNRELEASED_HEADING: string;
export declare const UPGRADING_GUIDE_HEADINGS: readonly string[];
export declare const UPGRADE_CHECKLIST_HEADING: string;
export declare const RUNBOOK_RELEASE_AGNOSTIC_MARKER: string;
export declare function markdownHeadings(text: string): MarkdownHeading[];
export declare function upgradingReleaseHeading(fromVersion: string, toVersion: string): string;
export declare function unreleasedBlock(text: string): UnreleasedBlock | null;
export declare function upgradingLayoutProblems(text: string): string[];
export declare function runbookScope(text: string): RunbookScope;
export declare function runbookScopeProblem(text: string, version: string): string | null;
export declare function upgradeDocsProblems(input: {
  upgradingText: string | null;
  runbookText: string | null;
  releasedVersion: string | null;
}): string[];
export declare function foldUpgradingUnreleased(
  text: string,
  versions: { fromVersion: string; toVersion: string },
): string;
