// #2693: the TypeScript surface of `sync-user-guide-wiki.mjs`, which stays
// JavaScript because the `Wiki sync` workflow runs it with a bare `node`.
// `src/lib/__tests__/wiki-sync-transform.test.ts` imports the pure transforms;
// keep this in step with the `export` statements in the `.mjs`.

/** Guide file name -> wiki page name (`README.md` -> `Home`). */
export type WikiPageMap = ReadonlyMap<string, string>;

export type WikiLinkContext = {
  readonly slug: string;
  readonly pageMap: WikiPageMap;
};

export declare function repoSlugFromPackageJson(pkgJsonText: string): string;
export declare function pageNameFromTitle(title: string): string;
export declare function firstH1(source: string): string | null;
export declare function readingOrderFromIndex(
  indexSource: string,
  guideFiles: readonly string[],
): string[];
export declare function rewriteTarget(
  target: string,
  ctx: WikiLinkContext,
): string;
export declare function transformContent(
  source: string,
  ctx: WikiLinkContext,
): string;
export declare function banner(sourceFile: string, slug: string): string;
export declare function buildSidebar(
  order: readonly string[],
  pageMap: WikiPageMap,
  titles: ReadonlyMap<string, string>,
  slug: string,
): string;
export declare function buildFooter(slug: string): string;
/** Wiki file name (`Home.md`, `_Sidebar.md`, ...) -> its content. */
export declare function buildWiki(
  sources: Readonly<Record<string, string>>,
  slug: string,
): Map<string, string>;
