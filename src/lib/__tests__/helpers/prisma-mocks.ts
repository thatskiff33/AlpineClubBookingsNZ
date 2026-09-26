/**
 * Typed helpers for Prisma mocks and transaction doubles.
 *
 * Tests in this repo commonly mock @/lib/prisma at module load and then
 * cast individual delegates with `as any` to override return values.
 * The helpers here keep types honest while still allowing per-test
 * overrides.
 */
import { Prisma } from "@prisma/client";
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
 * Pass the `model` (as `honourSelect(mock, "Member")` does) and relations are
 * known EXACTLY, from the generated client's schema: a relation selected `true`
 * keeps only its scalar fields, while `Json` values and scalar lists always pass
 * whole, as the client returns them. Without a model the helper has to guess,
 * and guesses that a plain object, or an array holding one, is a relation; a
 * primitive array still passes. See the helpers README for the full contract.
 */
export function projectSelect(
  row: unknown,
  select: unknown,
  model?: Prisma.ModelName,
): unknown {
  if (row === null || row === undefined) return row;
  if (!isPlainRecord(select)) return row;
  if (Array.isArray(row)) {
    return row.map((item) => projectSelect(item, select, model));
  }
  if (!isPlainRecord(row)) return row;

  const relations = relationsOf(model);
  const projected: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select)) {
    if (!spec || !(key in row)) continue;
    const value = row[key];
    const nested = isPlainRecord(spec) ? spec : null;
    if (isRelationField(key, value, relations)) {
      projected[key] = projectRelation(value, spec, relations?.get(key));
    } else if (nested?.select) {
      // `_count: { select: { … } }` and the like: not a schema relation, but
      // shaped by its own select all the same.
      projected[key] = projectSelect(value, nested.select);
    } else {
      projected[key] = value;
    }
  }
  return projected;
}

/**
 * Project a fixture row through a Prisma `include`: every scalar field, plus
 * the included relations shaped by their own arguments. The same rules as
 * {@link projectSelect}; an absent `include` leaves the scalars alone.
 */
export function projectInclude(
  row: unknown,
  include: unknown,
  model?: Prisma.ModelName,
): unknown {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) {
    return row.map((item) => projectInclude(item, include, model));
  }
  if (!isPlainRecord(row)) return row;

  const relations = relationsOf(model);
  const projected = scalarsOf(row, relations) as Record<string, unknown>;
  if (isPlainRecord(include)) {
    for (const [key, spec] of Object.entries(include)) {
      if (!spec || !(key in row)) continue;
      projected[key] = projectRelation(row[key], spec, relations?.get(key));
    }
  }
  return projected;
}

/**
 * Wrap a `findUnique`/`findFirst` mock so every resolved fixture is shaped by
 * the caller's arguments: through `select` when given, else through `include`,
 * else to the row's scalar fields (what the client returns for a bare query).
 * Use it in a `vi.mock("@/lib/prisma")` factory, naming the model so relations
 * are known exactly:
 *
 *   findUnique: honourSelect(mockFindUnique, "Member"),
 *
 * and keep driving `mockFindUnique.mockResolvedValue(row)` as before.
 */
export function honourSelect(
  mock: (args?: unknown) => unknown,
  model?: Prisma.ModelName,
): (args?: { select?: unknown; include?: unknown }) => Promise<unknown> {
  return async (args) => {
    const row = await mock(args);
    if (args?.select) return projectSelect(row, args.select, model);
    return projectInclude(row, args?.include, model);
  };
}

type RelationMap = ReadonlyMap<string, Prisma.ModelName>;

const relationMaps = new Map<Prisma.ModelName, RelationMap>();

/** Each relation field of `model`, mapped to the model it points at. */
function relationsOf(model: Prisma.ModelName | undefined): RelationMap | null {
  if (!model) return null;
  const cached = relationMaps.get(model);
  if (cached) return cached;
  const definition = Prisma.dmmf.datamodel.models.find(
    (candidate) => candidate.name === model,
  );
  if (!definition) throw new Error(`projectSelect: unknown Prisma model "${model}"`);
  const relations = new Map(
    definition.fields
      .filter((field) => field.kind === "object")
      .map((field) => [field.name, field.type as Prisma.ModelName] as const),
  );
  relationMaps.set(model, relations);
  return relations;
}

function isRelationField(
  key: string,
  value: unknown,
  relations: RelationMap | null,
): boolean {
  if (relations) return relations.has(key);
  // No model to consult: an object, or an array holding one, is taken to be a
  // relation. A primitive array (a scalar list) is not.
  return (
    isPlainRecord(value) ||
    (Array.isArray(value) && value.some((item) => isPlainRecord(item)))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * A row's scalar fields: every field that is not a relation, including `Json`
 * values and scalar lists. What the client returns for a relation selected
 * `true`, or for a query with no `select`.
 */
function scalarsOf(row: unknown, relations: RelationMap | null): unknown {
  if (Array.isArray(row)) return row.map((item) => scalarsOf(item, relations));
  if (!isPlainRecord(row)) return row;
  const scalars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isRelationField(key, value, relations)) continue;
    scalars[key] = value;
  }
  return scalars;
}

/** One relation, shaped by the argument it was selected or included with. */
function projectRelation(
  value: unknown,
  spec: unknown,
  model: Prisma.ModelName | undefined,
): unknown {
  if (spec === true) return scalarsOf(value, relationsOf(model));
  if (isPlainRecord(spec)) {
    if (spec.select) return projectSelect(value, spec.select, model);
    return projectInclude(value, spec.include, model);
  }
  return value;
}
