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
 * NULL is where a two-valued evaluator and PostgreSQL part company, and this
 * one follows PostgreSQL as far as it can and throws where it cannot. A NULL
 * column never satisfies a positive comparison — a literal, `equals`, `in`,
 * `lt`/`lte`/`gt`/`gte`, `startsWith`, `contains` — so `{ checkOut: { gt: d } }`
 * on a null `checkOut` is false, as SQL's unknown is excluded at the top of a
 * `WHERE`. Under a NEGATION that unknown is still excluded by PostgreSQL, but a
 * two-valued `!false` would include the row; so `not` / `notIn` with a non-null
 * operand, and any comparison inside a logical `NOT`, THROW when they meet a
 * NULL column rather than answer either way. `null` / `not: null` (IS NULL / IS
 * NOT NULL) and the relation negations `isNot` / `none` (NOT EXISTS) are
 * two-valued in SQL too and stay ordinary.
 *
 * WHAT IT REFUSES, LOUDLY. It THROWS, naming the operator and the column, on: a
 * filter operator it does not implement (`mode`, `every`, `has`, …), a column
 * the row does not carry, a relation filter on a scalar value, a compound-unique
 * key whose parts are not all columns, and the negations over NULL above. A fake
 * row that omits a column the production query filters on is the exact
 * vacuous-pass hazard this helper exists to remove, so it is an error, not a
 * NULL. Those guards are mutation-verified by the unit test. The one shape it
 * cannot refuse: a misspelt operator that is NOT one of Prisma's, on a scalar
 * column whose value is NULL, reads as the to-one shorthand on an absent
 * relation and answers false — the operators Prisma does have are named in
 * `UNMODELLED_OPERATORS` so that at least those throw there too.
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

/**
 * Operators Prisma has and this helper does not model. Named so a filter using
 * one throws wherever it appears — including on a NULL column, where the
 * evaluator could not otherwise tell an unknown operator from the to-one
 * shorthand on an absent relation.
 */
const UNMODELLED_OPERATORS = new Set([
  "endsWith",
  "mode",
  "search",
  "every",
  "has",
  "hasEvery",
  "hasSome",
  "isEmpty",
  "isSet",
  "path",
  "string_contains",
  "string_starts_with",
  "string_ends_with",
  "array_contains",
  "array_starts_with",
  "array_ends_with",
]);

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

function nullUnderNegation(label: string, operator: string, at: string): never {
  throw new Error(
    `${label}: \`${operator}\` on ${at} met a NULL column. PostgreSQL evaluates a ` +
      "negated comparison over NULL to unknown and EXCLUDES the row, where a " +
      "two-valued evaluator would include it; give the fixture row an explicit " +
      "value, or compare with `null` / `not: null` (IS NULL / IS NOT NULL), which " +
      "are two-valued in SQL too.",
  );
}

/**
 * One scalar column against one condition: a literal, `null`, or a filter
 * object. `negated` is true inside a logical `NOT`, where a comparison over a
 * NULL column has no two-valued answer and throws instead.
 */
function matchesScalar(
  actual: unknown,
  condition: unknown,
  at: string,
  label: string,
  negated: boolean,
): boolean {
  if (condition === null) return isNull(actual);
  if (!isPlainObject(condition)) {
    if (isNull(actual)) {
      if (negated) nullUnderNegation(label, "NOT", at);
      return false;
    }
    if (condition instanceof Date) return comparable(actual) === condition.getTime();
    return actual === condition;
  }
  for (const [operator, operand] of Object.entries(condition)) {
    if (operand === undefined) continue;
    switch (operator) {
      case "equals":
        if (!matchesScalar(actual, operand, at, label, negated)) return false;
        break;
      case "not":
        if (operand === null) {
          if (isNull(actual)) return false;
          break;
        }
        if (isNull(actual)) nullUnderNegation(label, "not", at);
        if (matchesScalar(actual, operand, at, label, true)) return false;
        break;
      case "in":
        if (isNull(actual)) {
          if (negated) nullUnderNegation(label, "NOT", at);
          return false;
        }
        if (
          !(operand as unknown[]).some((v) => matchesScalar(actual, v, at, label, negated))
        )
          return false;
        break;
      case "notIn":
        if (isNull(actual)) nullUnderNegation(label, "notIn", at);
        if ((operand as unknown[]).some((v) => matchesScalar(actual, v, at, label, true)))
          return false;
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        if (isNull(actual)) {
          if (negated) nullUnderNegation(label, "NOT", at);
          return false;
        }
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
      case "contains": {
        if (isNull(actual)) {
          if (negated) nullUnderNegation(label, "NOT", at);
          return false;
        }
        if (typeof actual !== "string") return false;
        const holds =
          operator === "startsWith"
            ? actual.startsWith(operand as string)
            : actual.includes(operand as string);
        if (!holds) return false;
        break;
      }
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
  // A nested where runs as its own subquery: NOT EXISTS is two-valued, so the
  // related rows are evaluated un-negated whatever surrounds the relation.
  const nested =
    lookup.matches ??
    ((relatedRow: WhereRow, where: WhereInput) => evaluate(relatedRow, where, options, false));
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
  return evaluate(row as WhereRow, where, options, false);
}

function evaluate(
  record: WhereRow,
  where: WhereInput | undefined | null,
  options: MatchesWhereOptions,
  negated: boolean,
): boolean {
  if (where === undefined || where === null) return true;
  const label = options.label ?? "prisma-where test evaluator";
  const hasColumn = options.column ?? ((r: WhereRow, key: string) => key in r);
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "AND") {
      if (!toList(condition).every((clause) => evaluate(record, clause, options, negated)))
        return false;
      continue;
    }
    if (key === "OR") {
      if (!toList(condition).some((clause) => evaluate(record, clause, options, negated)))
        return false;
      continue;
    }
    if (key === "NOT") {
      if (toList(condition).some((clause) => evaluate(record, clause, options, true)))
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
      if (isPlainObject(condition)) {
        const keys = Object.keys(condition).filter((k) => condition[k] !== undefined);
        const unmodelled = keys.find((k) => UNMODELLED_OPERATORS.has(k));
        if (unmodelled !== undefined) {
          unsupported(label, `filter operator "${unmodelled}" on ${key}`);
        }
        const scalarKeys = keys.filter((k) => SCALAR_OPERATORS.has(k));
        if (scalarKeys.length !== keys.length) {
          if (scalarKeys.length > 0) {
            unsupported(label, `filter mixing ${keys.join(", ")} on ${key}`);
          }
          // No scalar operator at all, so a relation filter (`is` / `some` / …)
          // or the to-one shorthand on an embedded relation. Both describe a
          // row or a list; on a scalar value it is an operator we do not know.
          if (!isNull(value) && !isPlainObject(value) && !Array.isArray(value)) {
            unsupported(label, `filter operator "${keys[0]}" on ${key}`);
          }
          if (!matchesRelation({ related: value }, condition, key, label, options))
            return false;
          continue;
        }
      }
      if (!matchesScalar(value, condition, key, label, negated)) return false;
      continue;
    }
    // A compound-unique key names its columns joined by `_`
    // (`memberId_seasonYear`), and its value is conditions on THOSE columns
    // only. Anything looser — say `member: { id }` on a row that never carried
    // its `member` relation — must not be re-read against the row's own
    // columns, which is how an absent relation would answer vacuously.
    const parts = key.split("_");
    if (
      parts.length > 1 &&
      isPlainObject(condition) &&
      parts.every((part) => hasColumn(record, part)) &&
      Object.keys(condition).length > 0 &&
      Object.keys(condition).every((nestedKey) => parts.includes(nestedKey))
    ) {
      if (!evaluate(record, condition, options, negated)) return false;
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
