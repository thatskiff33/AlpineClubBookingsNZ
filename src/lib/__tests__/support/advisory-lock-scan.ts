import { ADVISORY_LOCK_CALL, maskedSource } from "./advisory-lock-source";
import { balancedBrackets } from "./balanced-brackets";

// The advisory-lock site reader shared by the censuses that read lock sites from
// source: the tier and per-site registry in `advisory-lock-guard.test.ts`
// (`INV-LOCK-003`) and the lock(1) transaction budget census in
// `lock1-transaction-budget-census.test.ts` (`INV-LOCK-006`). One reader, so
// the two cannot disagree about where a lock(1) site is (`INV-SSOT-004`). The
// masking rule, the lock spelling and the file population it reads come from
// `advisory-lock-source.ts`, which the isolation census shares too.

/**
 * Which tier a raw advisory-lock statement takes, decided from the call itself.
 *
 * `GLOBAL` is the literal key `1` — the one Tier-2 key — in either the blocking
 * or the fail-fast form. `SCOPED` is a `hashtext`/`hashtextextended` key:
 * per-lodge, per-member, per-date, and the policy/singleton keyspaces.
 * `UNCLASSIFIED` is anything this scan cannot read, and it FAILS the census
 * rather than being counted as scoped — see `classifyLockArgument`.
 *
 * Deciding the tier from the CALL rather than from the registry is what makes
 * "a registered site quietly changed tier" a failure rather than a silent
 * re-approval.
 */
export type LockTier = "GLOBAL" | "SCOPED" | "UNCLASSIFIED";

export interface AdvisoryLockSite {
  /** Repository-relative path. Reported in failures; NOT part of the identity. */
  readonly rel: string;
  /** 1-based line. Reported in failures; NOT part of the identity. */
  readonly line: number;
  /** Exact character offset of the lock call in the original source. */
  readonly offset: number;
  /** Nearest enclosing top-level declaration. */
  readonly symbol: string;
  /** 1-based index of this site among the advisory sites of that symbol. */
  readonly ordinal: number;
  readonly tier: LockTier;
  /** Preferred identity — see SITE IDENTITY in `advisory-lock-guard.test.ts`. */
  readonly key: string;
  /** Always-unique fallback identity, used where `key` is ambiguous. */
  readonly qualifiedKey: string;
}

/**
 * Count occurrences of `needle` in `source`, ignoring comments and the contents
 * of every literal but a raw statement (see {@link maskedSource}).
 */
export function countCodeOccurrences(source: string, needle: string | RegExp): number {
  const masked = maskedSource(source);
  if (typeof needle !== "string") return (masked.match(needle) ?? []).length;
  let count = 0;
  let idx = masked.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = masked.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * The nearest enclosing top-level declaration is the site's symbol. Column 0 is
 * deliberate: a raw lock statement always sits inside some top-level function, so
 * the last column-0 declaration above it names the unit that a refactor moves.
 */
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var|class)\s+(\w+))/;

/** Framework-mandated handler names, which are not identities on their own. */
const ROUTE_HANDLER_SYMBOLS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/** `src/app/api/x/[id]/route.ts` -> `/api/x/[id]`; anything else -> `null`. */
function routePathOf(rel: string): string | null {
  const match = /^src\/app\/(.*)\/route\.tsx?$/.exec(rel);
  if (!match) return null;
  const segments = (match[1] ?? "")
    .split("/")
    .filter((segment) => segment.length > 0 && !/^\(.*\)$/.test(segment));
  return `/${segments.join("/")}`;
}

/**
 * The first argument of a lock call, read across line breaks from the opening
 * parenthesis. Returns `null` when the call cannot be parsed — an unbalanced or
 * unterminated argument list — which the caller must treat as unclassifiable
 * rather than as anything in particular.
 *
 * Reading ACROSS lines is load-bearing, not tidiness. Both `pg_try_` sites this
 * repository already ships are written over three lines, so a line-local reader
 * is not an edge case here: it is the shape the codebase actually uses, and it
 * would score `SELECT pg_advisory_xact_lock(\n  1\n)` as a scoped key.
 */
function firstLockArgument(text: string, openParenIndex: number): string | null {
  try {
    // `text` is already masked (`maskedSource`), and a raw statement it restored
    // must be read as code, so it is its own structure.
    return balancedBrackets(text, openParenIndex, text).parts[0] ?? "";
  } catch {
    return null;
  }
}

/**
 * FAIL CLOSED. An argument this scan cannot read is `UNCLASSIFIED`, which fails
 * the census, and is never quietly `SCOPED`.
 *
 * The direction matters because the two failure modes are not symmetric. Calling
 * a scoped key global costs a build failure and one line of registry. Calling a
 * global key scoped costs nothing at all at the time — it lands in a per-file
 * COUNT, which is the approval model #2722 exists to abolish, and the guard's own
 * remediation message is what tells the author to bump it. Only two shapes are
 * recognised, and everything else is handed to a human.
 */
function classifyLockArgument(argument: string | null): LockTier {
  if (argument === null) return "UNCLASSIFIED";
  const normalised = argument.replace(/\s+/g, "").replace(/::[A-Za-z0-9_]+$/, "");
  if (normalised === "1") return "GLOBAL";
  if (/^hashtext(?:extended)?\(/.test(normalised)) return "SCOPED";
  return "UNCLASSIFIED";
}

/**
 * Every raw advisory-lock acquisition in non-test `src/`, with its tier and its
 * stable identity.
 *
 * `pg_try_advisory_xact_lock` is scanned by the SAME matcher and classified by
 * the same argument reader as the blocking form, deliberately: a fail-fast
 * acquisition of key `1` is a Tier-2 acquisition. Matching the blocking spelling
 * alone left it in neither census — the tier test did not see it because the
 * anchored pattern failed, and the scoped count did not see it because
 * `pg_try_advisory_xact_lock(` does not contain the substring
 * `pg_advisory_xact_lock(`. Both censuses now derive from this one function, so
 * the two cannot disagree about what a site is again.
 */
export function collectAdvisoryLockSites(
  sources: ReadonlyArray<{ rel: string; text: string }>,
): AdvisoryLockSite[] {
  const sites: AdvisoryLockSite[] = [];
  for (const { rel, text } of sources) {
    const routePath = routePathOf(rel);
    const ordinals = new Map<string, number>();

    // One masked copy of the whole file. It is the SAME LENGTH as the original
    // and every line break is where it was, so an offset in it still names a
    // line while the argument reader can cross line breaks.
    const maskedText = maskedSource(text);
    const maskedLines = maskedText.split("\n");
    const lineStarts: number[] = [];
    let offset = 0;
    for (const maskedLine of maskedLines) {
      lineStarts.push(offset);
      offset += maskedLine.length + 1;
    }
    const lineOf = (index: number): number => {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((lineStarts[middle] ?? 0) <= index) low = middle;
        else high = middle - 1;
      }
      return low;
    };

    // The symbol is read line by line from the MASKED lines, which is what stops
    // a declaration written inside a comment opening a symbol: the comment is
    // spaces, and a column-0 anchor cannot match spaces. Re-testing the RAW line
    // for comment-ness — what this did before #3196 — only ever caught a comment
    // the private scanner recognised, and it recognised neither a trailing one
    // nor a block-comment body line without a leading star.
    const symbolByLine: string[] = [];
    let symbol = "(module scope)";
    maskedLines.forEach((maskedLine, index) => {
      const declaration = TOP_LEVEL_DECLARATION.exec(maskedLine);
      if (declaration) {
        symbol = declaration[1] ?? declaration[2] ?? symbol;
      }
      symbolByLine[index] = symbol;
    });

    for (const match of maskedText.matchAll(ADVISORY_LOCK_CALL)) {
      const index = match.index ?? 0;
      const lineIndex = lineOf(index);
      const siteSymbol = symbolByLine[lineIndex] ?? "(module scope)";
      const tier = classifyLockArgument(
        firstLockArgument(maskedText, index + match[0].length - 1),
      );
      const ordinal = (ordinals.get(siteSymbol) ?? 0) + 1;
      ordinals.set(siteSymbol, ordinal);
      const key =
        routePath !== null && ROUTE_HANDLER_SYMBOLS.has(siteSymbol)
          ? `${siteSymbol} ${routePath}#${ordinal}`
          : `${siteSymbol}#${ordinal}`;
      sites.push({
        rel,
        line: lineIndex + 1,
        offset: index,
        symbol: siteSymbol,
        ordinal,
        tier,
        key,
        qualifiedKey: `${rel}::${siteSymbol}#${ordinal}`,
      });
    }
  }
  return sites;
}

/** The symbol half of a site key or a registry entry — the key without `#n`. */
export function symbolOfKey(key: string): string {
  return key.replace(/#\d+$/, "");
}

/** Both accepted spellings of every site, so an entry may use either form. */
export function indexSitesByKey(sites: readonly AdvisoryLockSite[]): Map<string, AdvisoryLockSite[]> {
  const byKey = new Map<string, AdvisoryLockSite[]>();
  const add = (key: string, site: AdvisoryLockSite) => {
    const existing = byKey.get(key);
    if (existing) existing.push(site);
    else byKey.set(key, [site]);
  };
  for (const site of sites) {
    add(site.key, site);
    if (site.qualifiedKey !== site.key) add(site.qualifiedKey, site);
  }
  return byKey;
}
