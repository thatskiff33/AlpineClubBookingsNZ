// #5214: the TypeScript surface of `fragment-links.mjs`, which stays JavaScript
// because the release compiler runs it under bare node. The census
// `src/lib/__tests__/changelog-fragment-shape.test.ts` imports it; keep this in
// step with the `export` statements in the `.mjs`.
export declare const FRAGMENTS_DIRNAME: string;
export declare function rebaseFragmentLink(target: string, fragmentName?: string): string;
export declare function rebaseFragmentLinks(body: string, fragmentName?: string): string;
