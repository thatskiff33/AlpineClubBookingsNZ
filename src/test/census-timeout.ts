/**
 * Timeouts for tests that read the whole source tree (#5439).
 *
 * A test that walks and reads every file under `src/` (or more) does heavy
 * synchronous work that vitest's 5,000 ms default does not cover on a loaded CI
 * runner. Every such case, or the `describe` or file holding it, states one of
 * these budgets instead of a local literal. The census
 * `src/lib/__tests__/census-timeout-coverage.test.ts` checks that callers of
 * the known whole-tree readers import one. See `docs/TESTING.md`.
 */

/** Reading and stripping every source file: a budget for the scan, not a flake allowance. */
export const CENSUS_TIMEOUT_MS = 90_000;

/**
 * A full TypeScript AST parse of `src`, `scripts` and `prisma` through
 * `scanAuditWriterCensus()` (`scripts/audit/audit-writer-census.ts`): the same
 * budget that census's own suite uses.
 */
export const AST_CENSUS_TIMEOUT_MS = 180_000;
