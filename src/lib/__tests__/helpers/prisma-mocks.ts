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
 * What it models, and where it stops (see the helpers README):
 *  - a scalar key selected `true` passes through;
 *  - a relation selected with a nested `select` is projected through it;
 *  - a relation selected `true`, or with only `where`/`orderBy`/`take`, keeps
 *    only its SCALAR fields, and one with `include` keeps its scalars plus the
 *    included relations — as the client returns it;
 *  - a key selected but absent from the fixture stays absent.
 * It cannot tell a relation from a `Json` column holding an object, so a Json
 * object selected `true` is treated as a relation and keeps only its top-level
 * scalar members; give such a test a nested `select`, or assert on the query's
 * arguments instead. `where`, `orderBy` and `take` are not applied.
 */
export function projectSelect(row: unknown, select: unknown): unknown {
  if (row === null || row === undefined) return row;
  if (!isPlainRecord(select)) return row;
  if (Array.isArray(row)) return row.map((item) => projectSelect(item, select));
  if (!isPlainRecord(row)) return row;

  const projected: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select)) {
    if (!spec || !(key in row)) continue;
    const value = row[key];
    projected[key] =
      spec === true && !Array.isArray(value) && !isPlainRecord(value)
        ? value
        : projectRelation(value, spec);
  }
  return projected;
}

/**
 * Project a fixture row through a Prisma `include`: every scalar field, plus
 * the included relations shaped by their own arguments. The same rules as
 * {@link projectSelect}; an absent `include` leaves the scalars alone.
 */
export function projectInclude(row: unknown, include: unknown): unknown {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) return row.map((item) => projectInclude(item, include));
  if (!isPlainRecord(row)) return row;

  const projected = scalarsOf(row) as Record<string, unknown>;
  if (isPlainRecord(include)) {
    for (const [key, spec] of Object.entries(include)) {
      if (!spec || !(key in row)) continue;
      projected[key] = projectRelation(row[key], spec);
    }
  }
  return projected;
}

/**
 * Wrap a `findUnique`/`findFirst` mock so every resolved fixture is shaped by
 * the caller's arguments: through `select` when given, else through `include`,
 * else to the row's scalar fields (what the client returns for a bare query).
 * Use it in a `vi.mock("@/lib/prisma")` factory:
 *
 *   findUnique: honourSelect(mockFindUnique),
 *
 * and keep driving `mockFindUnique.mockResolvedValue(row)` as before.
 */
export function honourSelect(
  mock: (args?: unknown) => unknown,
): (args?: { select?: unknown; include?: unknown }) => Promise<unknown> {
  return async (args) => {
    const row = await mock(args);
    if (args?.select) return projectSelect(row, args.select);
    return projectInclude(row, args?.include);
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/** A row's scalar fields only: what the client returns for a relation selected `true`. */
function scalarsOf(row: unknown): unknown {
  if (Array.isArray(row)) return row.map(scalarsOf);
  if (!isPlainRecord(row)) return row;
  const scalars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value) || isPlainRecord(value)) continue;
    scalars[key] = value;
  }
  return scalars;
}

/** One relation, shaped by the argument it was selected or included with. */
function projectRelation(value: unknown, spec: unknown): unknown {
  if (spec === true) return scalarsOf(value);
  if (isPlainRecord(spec)) {
    if (spec.select) return projectSelect(value, spec.select);
    return projectInclude(value, spec.include);
  }
  return value;
}
