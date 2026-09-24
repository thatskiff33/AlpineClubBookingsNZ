/**
 * Typed helpers for Prisma mocks and transaction doubles.
 *
 * Tests in this repo commonly mock @/lib/prisma at module load and then
 * cast individual delegates with `as any` to override return values.
 * The helpers here keep types honest while still allowing per-test
 * overrides.
 */
import { vi, type Mock } from "vitest";

/**
 * Build a transaction shim that calls a passed callback with the
 * supplied client. Use when a service does
 * `prisma.$transaction((tx) => ...)` and you want the tx delegate to be
 * the same mock client.
 */
export function transactionShim<T extends object>(
  client: T,
): (callback: (tx: T) => Promise<unknown>) => Promise<unknown> {
  return (callback) => callback(client);
}

/**
 * Replace each value in `delegate` with `vi.fn()` while preserving the
 * delegate shape. Returns the mocked delegate typed as a record of
 * mocks so callers can call `delegate.findMany.mockResolvedValue(...)`
 * without `as any`.
 */
export function mockDelegate<K extends string>(
  methods: readonly K[],
): Record<K, Mock> {
  return methods.reduce(
    (acc, key) => {
      acc[key] = vi.fn();
      return acc;
    },
    {} as Record<K, Mock>,
  );
}

/**
 * Common Prisma delegate method names grouped by the methods most often
 * mocked in this repo. Use these to seed `mockDelegate` instead of
 * repeating the list inline.
 */
export const READ_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
] as const;

export const WRITE_METHODS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
] as const;

export const FULL_DELEGATE_METHODS = [
  ...READ_METHODS,
  ...WRITE_METHODS,
] as const;

/**
 * Project a fixture row through a Prisma `select`, the way the real client
 * would (#3603).
 *
 * A mock that resolves a whole fixture row ignores the query's `select`, so a
 * guard that stops selecting a field still receives it from the fixture and its
 * test keeps passing. That is how a gate that never selected `canLogin` kept a
 * green suite: every fixture carried the field the query did not ask for.
 * Routing the fixture through this makes the test see only what the query
 * selected — drop `canLogin` from the select and the row arrives without it.
 *
 * Nested relation selects (`accessRoles: { select: {...} }`) are applied to
 * each related row. A key selected but absent from the fixture stays absent,
 * and a query with no `select` (or an `include`) gets the row unchanged.
 */
export function projectSelect(row: unknown, select: unknown): unknown {
  if (row === null || row === undefined) return row;
  if (!select || typeof select !== "object") return row;
  if (Array.isArray(row)) return row.map((item) => projectSelect(item, select));
  if (typeof row !== "object" || row instanceof Date) return row;

  const source = row as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select as Record<string, unknown>)) {
    if (!spec || !(key in source)) continue;
    if (typeof spec === "object" && spec !== null && "select" in spec) {
      projected[key] = projectSelect(
        source[key],
        (spec as { select: unknown }).select,
      );
      continue;
    }
    projected[key] = source[key];
  }
  return projected;
}

/**
 * Wrap a `findUnique`/`findFirst` mock so every resolved fixture is projected
 * through the caller's `select`. Use it in a `vi.mock("@/lib/prisma")` factory:
 *
 *   findUnique: honourSelect(mockFindUnique),
 *
 * and keep driving `mockFindUnique.mockResolvedValue(row)` as before.
 */
export function honourSelect(
  mock: (args?: unknown) => unknown,
): (args?: { select?: unknown }) => Promise<unknown> {
  return async (args) => projectSelect(await mock(args), args?.select);
}
