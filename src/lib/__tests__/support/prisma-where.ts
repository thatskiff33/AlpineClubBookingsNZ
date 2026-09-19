/**
 * The one in-memory evaluator for a Prisma `where` object (#3434).
 *
 * A fake `findMany({ where })` has to answer the way PostgreSQL would, or the test
 * driving it passes for a reason unrelated to its claim. Nine suites each wrote
 * their own interpreter for that, and each supported a different slice of the
 * grammar — so a shape one file applied correctly, another silently read as
 * "matches everything" or "matches nothing". This module is the single home
 * (`INV-SSOT-001`); a suite that needs an operator it lacks teaches it here, with
 * a case in `prisma-where.test.ts`, rather than growing a tenth copy.
 *
 * WHAT IT MODELS. The union of what the nine copies used:
 *
 * - scalar equality, including `null` (IS NULL) and `Date` compared by instant;
 * - the scalar filter object: `equals`, `not` (nested: `not: null`,
 *   `not: { in }`), `in`, `notIn`, `lt`, `lte`, `gt`, `gte`, `startsWith`,
 *   `contains`;
 * - the logical keys `AND`, `OR`, `NOT`, each accepting one clause or a list;
 * - relation filters: to-one `is` / `isNot` (`is: null` is "no related row"),
 *   to-many `some` / `none`, and Prisma's to-one shorthand
 *   (`booking: { deletedAt: null }`);
 * - a compound-unique key (`memberId_seasonYear: { memberId, seasonYear }`),
 *   evaluated as the nested conditions on the same row;
 * - a condition of `undefined`, which Prisma drops and so does this.
 *
 * Comparisons follow SQL: a NULL column never satisfies `lt`/`lte`/`gt`/`gte`,
 * `startsWith` or `contains`, so `{ checkOut: { gt: d } }` on a row whose
 * `checkOut` is null is false rather than a coerced-number accident.
 *
 * WHAT IT REFUSES, LOUDLY. Anything else THROWS, naming the operator and the
 * column: a filter operator it does not implement (`mode`, `every`, `has`, …),
 * a column the row does not carry, a relation filter on a scalar value. A fake
 * row that omits a column the production query filters on is the exact
 * vacuous-pass hazard this helper exists to remove, so it is an error, not a
 * NULL. That guard is mutation-verified by the unit test.
 *
 * Relations live on the row by default (`row.guests` is the list `guests: { some }`
 * inspects). A store that resolves relations through foreign keys instead — the
 * booking-evidence double — passes `relation` to look them up, and `column` to
 * check a filter key against its model spec rather than against the row.
 */

/** A row as a fake store holds it: plain columns, plain nested relations. */
export type WhereRow = Record<string, unknown>;

/** A Prisma-shaped `where` object, untyped because every model's differs. */
export type WhereInput = Record<string, unknown>;

/** What `relation` returns for a key that IS a relation on this row. */
export interface RelationLookup {
  /** The related row (to-one), rows (to-many), or `null` / `undefined` for none. */
  related: unknown;
  /**
   * How to evaluate a nested `where` against one related row. Defaults to this
   * evaluator with the same options; a model-aware store overrides it so the
   * related row is checked against ITS model's columns.
   */
  matches?: (relatedRow: WhereRow, where: WhereInput) => boolean;
}

export interface MatchesWhereOptions {
  /** Names the caller in error messages, e.g. `"booking-evidence double (booking)"`. */
  label?: string;
  /**
   * Whether `key` is a column of `row`. Default: `key in row`. A store with a
   * model spec answers from the spec so an unselected column still counts.
   */
  column?: (row: WhereRow, key: string) => boolean;
  /**
   * Resolve `key` as a relation of `row`. Return `undefined` when it is not
   * one; the evaluator then reads `row[key]` and decides from the condition's
   * shape whether it is a scalar filter or an embedded relation.
   */
  relation?: (row: WhereRow, key: string) => RelationLookup | undefined;
}

const SCALAR_OPERATORS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "startsWith",
  "contains",
]);

const RELATION_OPERATORS = new Set(["is", "isNot", "some", "none"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function isNull(value: unknown): boolean {
  return value === null || value === undefined;
}

function unsupported(label: string, what: string): never {
  throw new Error(
    `${label}: unsupported ${what}. ` +
      "Teach src/lib/__tests__/support/prisma-where.ts the shape (with a case in " +
      "its unit test) rather than letting an unrecognised predicate match vacuously.",
  );
}

function toList(condition: unknown): WhereInput[] {
  return (Array.isArray(condition) ? condition : [condition]) as WhereInput[];
}

/** One scalar column against one condition: a literal, `null`, or a filter object. */
function matchesScalar(
  actual: unknown,
  condition: unknown,
  at: string,
  label: string,
): boolean {
  if (condition === null) return isNull(actual);
  if (condition instanceof Date) return comparable(actual) === condition.getTime();
  if (!isPlainObject(condition)) return actual === condition;
  for (const [operator, operand] of Object.entries(condition)) {
    if (operand === undefined) continue;
    switch (operator) {
      case "equals":
        if (!matchesScalar(actual, operand, at, label)) return false;
        break;
      case "not":
        if (matchesScalar(actual, operand, at, label)) return false;
        break;
      case "in":
        if (!(operand as unknown[]).some((v) => matchesScalar(actual, v, at, label)))
          return false;
        break;
      case "notIn":
        if ((operand as unknown[]).some((v) => matchesScalar(actual, v, at, label)))
          return false;
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        if (isNull(actual)) return false;
        const left = comparable(actual) as number;
        const right = comparable(operand) as number;
        const holds =
          operator === "lt"
            ? left < right
            : operator === "lte"
              ? left <= right
              : operator === "gt"
                ? left > right
                : left >= right;
        if (!holds) return false;
        break;
      }
      case "startsWith":
        if (typeof actual !== "string" || !actual.startsWith(operand as string))
          return false;
        break;
      case "contains":
        if (typeof actual !== "string" || !actual.includes(operand as string))
          return false;
        break;
      default:
        unsupported(label, `filter operator "${operator}" on ${at}`);
    }
  }
  return true;
}

/** A relation value against `is` / `isNot` / `some` / `none`, or the to-one shorthand. */
function matchesRelation(
  lookup: RelationLookup,
  condition: unknown,
  at: string,
  label: string,
  options: MatchesWhereOptions,
): boolean {
  const related = lookup.related;
  const nested =
    lookup.matches ??
    ((relatedRow: WhereRow, where: WhereInput) => matchesWhere(relatedRow, where, options));
  const toOne = (): WhereRow | null => {
    if (isNull(related)) return null;
    if (!isPlainObject(related)) {
      unsupported(label, `to-one relation filter on ${at}, whose value is not a row`);
    }
    return related;
  };
  const toMany = (): WhereRow[] => {
    if (isNull(related)) return [];
    if (!Array.isArray(related)) {
      unsupported(label, `to-many relation filter on ${at}, whose value is not a list`);
    }
    return related as WhereRow[];
  };
  if (!isPlainObject(condition)) {
    // `guests: null` is not a Prisma shape; a to-one `booking: null` is not one
    // either (Prisma spells it `is: null`).
    unsupported(label, `relation condition ${JSON.stringify(condition)} on ${at}`);
  }
  const keys = Object.keys(condition).filter((key) => condition[key] !== undefined);
  if (keys.length === 0) return true;
  const relationKeys = keys.filter((key) => RELATION_OPERATORS.has(key));
  if (relationKeys.length === 0) {
    // Prisma's to-one shorthand: `booking: { deletedAt: null }`. A list has no
    // shorthand, so a bare key on one is an operator we do not model (`every`).
    if (Array.isArray(related)) {
      unsupported(label, `filter operator "${keys[0]}" on ${at}`);
    }
    const row = toOne();
    return row !== null && nested(row, condition);
  }
  if (relationKeys.length !== keys.length) {
    unsupported(label, `relation filter mixing ${keys.join(", ")} on ${at}`);
  }
  for (const operator of relationKeys) {
    const operand = condition[operator];
    switch (operator) {
      case "is": {
        const row = toOne();
        if (operand === null) {
          if (row !== null) return false;
        } else if (row === null || !nested(row, operand as WhereInput)) {
          return false;
        }
        break;
      }
      case "isNot": {
        const row = toOne();
        if (operand === null) {
          if (row === null) return false;
        } else if (row !== null && nested(row, operand as WhereInput)) {
          return false;
        }
        break;
      }
      case "some":
        if (!toMany().some((row) => nested(row, operand as WhereInput))) return false;
        break;
      case "none":
        if (toMany().some((row) => nested(row, operand as WhereInput))) return false;
        break;
    }
  }
  return true;
}

/**
 * Does `row` satisfy `where`? `undefined` / `{}` matches every row, as Prisma's
 * does. Throws — never guesses — on any shape it does not model.
 */
export function matchesWhere(
  row: object,
  where: WhereInput | undefined | null,
  options: MatchesWhereOptions = {},
): boolean {
  if (where === undefined || where === null) return true;
  const label = options.label ?? "prisma-where test evaluator";
  const record = row as WhereRow;
  const hasColumn = options.column ?? ((r: WhereRow, key: string) => key in r);
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "AND") {
      if (!toList(condition).every((clause) => matchesWhere(record, clause, options)))
        return false;
      continue;
    }
    if (key === "OR") {
      if (!toList(condition).some((clause) => matchesWhere(record, clause, options)))
        return false;
      continue;
    }
    if (key === "NOT") {
      if (toList(condition).some((clause) => matchesWhere(record, clause, options)))
        return false;
      continue;
    }
    const lookup = options.relation?.(record, key);
    if (lookup) {
      if (!matchesRelation(lookup, condition, key, label, options)) return false;
      continue;
    }
    if (hasColumn(record, key)) {
      const value = record[key];
      if (
        isPlainObject(condition) &&
        Object.keys(condition).some((operator) => !SCALAR_OPERATORS.has(operator))
      ) {
        // Not a scalar filter object, so a relation filter (`is` / `some` / …) or
        // the to-one shorthand on an embedded relation. Both of those describe
        // a row or a list; on a scalar column it is an operator we do not know.
        if (!isNull(value) && !isPlainObject(value) && !Array.isArray(value)) {
          const unknown = Object.keys(condition).filter((k) => !SCALAR_OPERATORS.has(k));
          unsupported(label, `filter operator "${unknown[0]}" on ${key}`);
        }
        if (!matchesRelation({ related: value }, condition, key, label, options))
          return false;
        continue;
      }
      if (!matchesScalar(value, condition, key, label)) return false;
      continue;
    }
    // A compound-unique key names its columns joined by `_`, and its value is
    // those columns' conditions.
    if (
      isPlainObject(condition) &&
      Object.keys(condition).length > 0 &&
      Object.keys(condition).every((part) => hasColumn(record, part))
    ) {
      if (!matchesWhere(record, condition, options)) return false;
      continue;
    }
    unsupported(
      label,
      `filter on "${key}", which is neither a column nor a relation of the row ` +
        `(${JSON.stringify(condition)})`,
    );
  }
  return true;
}
