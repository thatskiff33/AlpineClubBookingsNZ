/**
 * Split a migration file into the statements PostgreSQL will run, byte for byte
 * (#2418).
 *
 * WHY THIS EXISTS ALONGSIDE scripts/lib/split-sql-statements.awk
 *
 * The awk splitter serves the shell gates: it must run before `npm ci`, with no
 * Node, and it normalises each statement onto one line because its consumers
 * only ever *read* statements (does this one start with UPDATE, does that one
 * mention CURRENT_TIMESTAMP). Normalising is exactly wrong for EXECUTION: a
 * newline inside a dollar-quoted HTML payload is part of the value, and turning
 * it into a space would store bytes production never stores.
 *
 * So this one preserves the source verbatim and is used only to execute. The two
 * cannot drift apart unnoticed: `data-migration-verification-gate.test.ts` runs
 * both over every committed migration and fails if they disagree about how many
 * statements a file holds or what each one starts with.
 *
 * WHY EXECUTION NEEDS SPLITTING AT ALL. `pg` sends a multi-statement string as a
 * single simple query, which PostgreSQL treats as one implicit transaction
 * block — and `ALTER TYPE ... ADD VALUE` cannot be used later in the same block
 * ("unsafe use of new value"). `20260528120000_add_booking_admin_review_workflow`
 * does exactly that, and it deploys fine because Prisma applies statements one at
 * a time. Replaying it any other way would fail on history that is already live.
 *
 * QUOTING RULES IMPLEMENTED (PostgreSQL): single-quoted strings with `''`
 * doubling, `E'...'` strings with backslash escapes, double-quoted identifiers,
 * arbitrary `$tag$...$tag$` dollar quoting (tag is empty or
 * `[A-Za-z_][A-Za-z0-9_]*`), `--` line comments, and nested block comments.
 */

import { must } from "../../src/lib/indexed-access";

/** True when `value[index]` begins a valid dollar-quote tag; returns the tag. */
function dollarTagAt(value: string, index: number): string | null {
  let cursor = index + 1;
  let first = true;
  while (cursor < value.length) {
    // The loop condition just above is exactly what makes this in range.
    const char = must(value[cursor], `dollarTagAt: cursor ${cursor} out of range for a string of length ${value.length}`);
    if (char === "$") return value.slice(index, cursor + 1);
    if (first) {
      if (!/[A-Za-z_]/.test(char)) return null;
      first = false;
      cursor += 1;
      continue;
    }
    if (!/[A-Za-z0-9_]/.test(char)) return null;
    cursor += 1;
  }
  return null;
}

/** True when the `'` at `index` opens an escape-aware `E'...'` string. */
function isEscapeString(value: string, index: number): boolean {
  const previous = value[index - 1];
  if (previous !== "E" && previous !== "e") return false;
  const beforeThat = value[index - 2];
  return beforeThat === undefined || !/[A-Za-z0-9_]/.test(beforeThat);
}

/**
 * Every statement in `sql`, verbatim, in order. Statements that hold nothing but
 * whitespace and comments are dropped: PostgreSQL has nothing to run for them,
 * and this repository's migrations open with long comment headers.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }

    if (char === "/" && sql[index + 1] === "*") {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
          continue;
        }
        if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
          continue;
        }
        index += 1;
      }
      continue;
    }

    if (char === "'") {
      const escapeAware = isEscapeString(sql, index);
      index += 1;
      while (index < sql.length) {
        if (escapeAware && sql[index] === "\\") {
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          // A doubled '' is an escaped quote: skip both and stay inside.
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === '"') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === "$") {
      const tag = dollarTagAt(sql, index);
      if (tag) {
        const close = sql.indexOf(tag, index + tag.length);
        if (close === -1) {
          throw new Error(
            `unterminated dollar-quoted string ${tag} — refusing to execute a file that cannot be tokenised`,
          );
        }
        index = close + tag.length;
        continue;
      }
      index += 1;
      continue;
    }

    if (char === ";") {
      statements.push(sql.slice(start, index + 1));
      index += 1;
      start = index;
      continue;
    }

    index += 1;
  }

  if (start < sql.length) statements.push(sql.slice(start));

  return statements.filter((statement) => hasExecutableText(statement));
}

/**
 * `sql` with `--` line comments and `/* … *​/` blocks BLANKED OUT — replaced by
 * spaces, newlines kept — so byte offsets and line numbers survive. Blanking
 * rather than deleting is what keeps the offsets usable: the audit-writer census
 * reports the line of every raw-SQL statement, and the door-code migration
 * discusses `UPDATE "AuditLog"` in its header comment as well as performing it,
 * so a scan that did not strip comments would over-count exactly the way a
 * docblock false positive does. Single-quoted literals are respected, so a `--`
 * inside a string stays. Block comments do not nest here (the splitter above
 * nests them; no committed migration nests one inside a literal-bearing
 * statement, and a nested opener inside a comment is still inside a comment).
 *
 * ONE HOME (`INV-SSOT`): the census (`scripts/audit/audit-writer-census.ts`) and
 * the backfill contract tests both strip comments before reading a migration,
 * and a second copy is how the two would come to disagree on what counts as SQL.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let index = 0;
  let inLine = false;
  let inBlock = false;
  let inString = false;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      } else {
        out += " ";
      }
      index += 1;
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        out += "  ";
        index += 2;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (inString) {
      // Postgres doubles a quote to escape it; either way the state machine only
      // has to know it is still inside the literal.
      if (char === "'") inString = false;
      out += char;
      index += 1;
      continue;
    }
    if (char === "'") {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      inLine = true;
      out += "  ";
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      out += "  ";
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }

  return out;
}

/** True when a chunk holds something other than whitespace and comments. */
function hasExecutableText(statement: string): boolean {
  let index = 0;
  while (index < statement.length) {
    // The loop condition just above is exactly what makes this in range.
    const char = must(statement[index], `hasExecutableText: index ${index} out of range for a string of length ${statement.length}`);
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && statement[index + 1] === "-") {
      const newline = statement.indexOf("\n", index);
      if (newline === -1) return false;
      index = newline + 1;
      continue;
    }
    if (char === "/" && statement[index + 1] === "*") {
      let depth = 1;
      index += 2;
      while (index < statement.length && depth > 0) {
        if (statement[index] === "/" && statement[index + 1] === "*") {
          depth += 1;
          index += 2;
          continue;
        }
        if (statement[index] === "*" && statement[index + 1] === "/") {
          depth -= 1;
          index += 2;
          continue;
        }
        index += 1;
      }
      continue;
    }
    if (char === ";") {
      index += 1;
      continue;
    }
    return true;
  }
  return false;
}
