import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

// #2289 — the guard that keeps raw SQL honest.
//
// ENFORCES INV-OPS-001 (`docs/invariants/operations.md`), which names this file
// as one of its two enforcement arms. Every census assertion below repeats the
// id in its failure message, so whoever trips one is handed the rule rather than
// having to go and find it (#2691).
//
// `prisma.$queryRaw<SomeRow[]>` is an UNCHECKED CAST. Raw SQL returns the
// PHYSICAL column names; the type argument declares whatever the author
// believed. Nothing verifies the two agree, so where they disagreed every
// property arrived `undefined` — which silently disabled a promo redemption cap
// and a FREE_NIGHTS discount in a live deployment for months, invisible to the
// compiler (the cast) and to the tests (a mock returns the author's own wrong
// belief).
//
// The ESLint rules in `eslint.config.mjs` refuse the type argument and a
// `SELECT *` in a raw template. This file covers what a syntactic lint rule
// cannot see: WHICH statements exist, what each one is for, and whether the ones
// that actually read a result validate it. Every production raw READ must either
// go through `decodeRawRows` or appear, counted and reasoned, in
// `RAW_READ_OPT_OUTS` below — so a new one has to be classified rather than
// merely written.
//
// Advisory locks and their composition order live in
// `advisory-lock-guard.test.ts`; this file is only about result SHAPE.

/**
 * Every directory of non-test TypeScript this guard walks.
 *
 * `src/` is the application. `scripts/` and `prisma/` are here because they are
 * where hand-written SQL is MOST likely — Prisma cannot express a bulk
 * correlated update, so a one-off repair CLI is exactly where somebody reaches
 * for `$queryRaw`, and `scripts/` holds the money-adjacent backfills
 * (`backfill-orphaned-applied-credits.ts`, `backfill-cancel-flattened-payments`,
 * `backfill-finance-monthly-facts`, `xero-booking-repair`). A guard that stopped
 * at `src/` would leave the surface with the highest chance of the #2289 failure
 * mode entirely unwatched while CONTRIBUTING.md promised otherwise.
 *
 * `e2e/` is deliberately absent: it is entirely Playwright tests, exempt for the
 * same reason `src/**\/__tests__` is — a test's raw statement runs against a
 * throwaway database and its result is asserted on the spot.
 */
const SCANNED_DIRS = ["src", "scripts", "prisma"];

/**
 * Every non-test file scanned that calls `$queryRaw` / `$queryRawUnsafe` —
 * the two entry points that hand back a RESULT SET and can therefore lie about
 * its shape. `$executeRaw` / `$executeRawUnsafe` return an affected-row count
 * and are immune by construction, so they are not inventoried here.
 *
 * Shrinking a count is always fine (delete the entry at zero). Adding one means
 * a new raw read: route it through `decodeRawRows` and say so here, or justify
 * an opt-out below.
 */
const RAW_READ_INVENTORY: Record<string, number> = {
  // The Sentry/observability bootstrap's connectivity probe. `SELECT 1` returns
  // one anonymous column that nothing reads; the call is awaited purely to see
  // whether the database answers at all.
  "src/instrumentation.node.ts": 1,
  // The health endpoint's liveness probe, same statement and same reasoning.
  "src/lib/health-check.ts": 1,
  // THE ONE REAL RAW READ IN THE CODEBASE, and it is validated. The rate
  // limiter's window is one atomic `INSERT … ON CONFLICT … CASE … RETURNING`
  // upsert, which Prisma cannot express and which must stay a single statement
  // or the read-modify-write race it exists to close reopens. Its result goes
  // through `decodeRawRows`.
  "src/lib/rate-limit.ts": 1,
  // The non-blocking adult-hosting policy-set lock reads the one boolean
  // returned by `pg_try_advisory_xact_lock`; the row is schema-decoded before
  // the worker decides whether it may proceed.
  "src/lib/adult-member-hosting-policy-set.ts": 1,
  // The hosting coverage participant protocol's fail-fast lock reads the boolean
  // returned by `pg_try_advisory_xact_lock` and schema-decodes it before deciding
  // whether the outer transaction must retry.
  //
  // STILL ONE AFTER #3039 ADDED A SECOND LOCK FAMILY, and that is the point rather
  // than luck. The per-TRIP `hosting-coverage-group` key has the same fail-fast
  // spelling as the per-owner one — for a stronger reason than its sibling, since a
  // trip key is shared with other accounts, so a blocking wait on it is both a
  // cross-account stall and a real deadlock edge between two transactions that
  // discover two trip keys in opposite orders. Identical statement, identical
  // decoder, identical schema: the only per-family facts are the namespace constant
  // and the decode label, so both families go through ONE `tryLockCoverageKeys`
  // parameterised on those two (`INV-SSOT-001`). A second copy would be a second
  // place for the `AS "locked"` alias or the decoder to drift.
  "src/lib/adult-member-hosting-coverage-lock.ts": 1,
};

/**
 * Raw reads that deliberately do NOT validate their rows, with the reason each
 * one is safe. Both are `SELECT 1` connectivity probes: they name no column, so
 * there is no column name to get wrong, and nothing reads the returned value —
 * only whether the promise settled. Wrapping them in a decoder would add a
 * schema that asserts nothing about anything anybody uses.
 *
 * They stay on `$queryRaw` rather than being converted to `$executeRaw` because
 * these are LIVENESS probes: changing how the one statement that reports
 * "database reachable" is issued is a real risk taken for a purely cosmetic
 * consistency gain.
 *
 * Anything else added here needs the same standard — the returned rows are
 * genuinely never read — and not merely an author's confidence about the shape.
 */
const RAW_READ_OPT_OUTS: Record<string, string> = {
  "src/instrumentation.node.ts": "SELECT 1 connectivity probe; no column is named or read",
  "src/lib/health-check.ts": "SELECT 1 liveness probe; no column is named or read",
};

/** Where the sanctioned decoder lives. */
const DECODER_MODULE = "src/lib/raw-sql-rows.ts";
const DECODER = "decodeRawRows";

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.includes(".integration.")
  );
}

/**
 * Drop comments so a docblock discussing `$queryRaw` is not a call site.
 *
 * Through the canonical scanner since #3164, which changes two things for the
 * better. The line filter this replaced kept a raw call that shared its line
 * with a trailing comment — and it DELETED comment lines rather than blanking
 * them, so the joined text ran a docblock's neighbours together.
 */
function codeLines(source: string): string {
  return stripComments(source);
}

/**
 * Every raw-SQL statement in `source`, with its method, any type argument, and
 * the SQL text. Raw SQL templates in this repository never nest a backtick, so
 * the body match is exact.
 *
 * BOTH CALL FORMS, deliberately. Prisma takes a raw statement as a tagged
 * template (``$queryRaw`SELECT …` ``) and as an ordinary call over a composed
 * `Prisma.Sql` (`$queryRaw(Prisma.sql`SELECT …`)`) — and the second is this
 * repository's own idiom for anything longer than a one-liner
 * (`src/lib/audit-retention.ts` builds its archive statements that way). A
 * matcher that required a backtick immediately after the method name saw NONE of
 * those, so the "no type argument", "no `SELECT *`" and "every `FOR UPDATE` on
 * `$executeRaw` over a constant" assertions below all passed vacuously on the
 * style the codebase actually writes. `$queryRawUnsafe("…")` string arguments
 * are matched for the same reason.
 *
 * One residual, closed in lint rather than here: a statement composed into a
 * variable on one line and passed to `$queryRaw` on another has no SQL text at
 * the call site to read. `NO_SELECT_STAR_IN_PRISMA_SQL` in `eslint.config.mjs`
 * is anchored on `Prisma.sql` itself precisely so that form is still caught.
 */
function rawStatements(
  source: string,
): { tag: string; typeArgument: string | null; sql: string }[] {
  const pattern =
    /\$(executeRaw|queryRaw)(Unsafe)?\s*(<[^>]*>)?\s*(?:`([^`]*)`|\(\s*(?:Prisma\.sql\s*)?(?:`([^`]*)`|"([^"]*)"|'([^']*)'))/g;
  const found: { tag: string; typeArgument: string | null; sql: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    found.push({
      tag: `$${match[1]}${match[2] ?? ""}`,
      typeArgument: match[3] ?? null,
      sql: match[4] ?? match[5] ?? match[6] ?? match[7] ?? "",
    });
  }
  return found;
}

function rawReadCount(source: string): number {
  return rawStatements(source).filter((statement) =>
    statement.tag.startsWith("$queryRaw"),
  ).length;
}

const sources = SCANNED_DIRS.flatMap((dir) => {
  const full = path.join(process.cwd(), dir);
  return fs.existsSync(full) ? walk(full) : [];
})
  .map((file) => ({
    rel: path.relative(process.cwd(), file).split(path.sep).join("/"),
    text: fs.readFileSync(file, "utf8"),
  }))
  .filter(({ rel }) => !isTestFile(rel))
  .map(({ rel, text }) => ({ rel, text, code: codeLines(text) }));

describe("raw SQL cannot lie about its result shape (#2289)", () => {
  // A source-scanning guard's real failure mode is passing VACUOUSLY: the
  // matcher stops recognising the shape it is supposed to police, every
  // assertion below goes green over an empty list, and the guard reads as
  // covered while covering nothing. That is precisely what the original
  // backtick-anchored matcher did to the `Prisma.sql` call form. So pin the
  // matcher itself, in both directions.
  it("recognises every way a raw statement can be written", () => {
    const seen = rawStatements(
      [
        'await db.$queryRaw<Row[]>`SELECT * FROM "A"`;',
        'await db.$executeRaw`SELECT 1 FROM "B" FOR UPDATE`;',
        'await db.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM "C" FOR UPDATE`);',
        'await db.$executeRaw(Prisma.sql`DELETE FROM "D"`);',
        'await db.$queryRawUnsafe<Row[]>("SELECT * FROM E");',
        "await db.$queryRawUnsafe(`SELECT * FROM \"F\"`);",
      ].join("\n"),
    );

    expect(
      seen.map((s) => `${s.tag}${s.typeArgument ?? ""}`),
      "The raw-statement matcher stopped seeing one of the forms Prisma " +
        "accepts. Every assertion in this file iterates it, so a form it " +
        "cannot see is a form nothing here checks (#2289).",
    ).toEqual([
      "$queryRaw<Row[]>",
      "$executeRaw",
      "$queryRaw<Row[]>",
      "$executeRaw",
      "$queryRawUnsafe<Row[]>",
      "$queryRawUnsafe",
    ]);
    // The SQL text has to come out too, or the SELECT-*/constant assertions
    // would inspect an empty string and pass on anything.
    expect(seen.map((s) => s.sql.trim())).toEqual([
      'SELECT * FROM "A"',
      'SELECT 1 FROM "B" FOR UPDATE',
      'SELECT * FROM "C" FOR UPDATE',
      'DELETE FROM "D"',
      "SELECT * FROM E",
      'SELECT * FROM "F"',
    ]);
  });

  it("sees the call-form statements this repository actually ships", () => {
    // `audit-retention.ts` composes with `Prisma.sql`, which is the idiom the
    // matcher used to miss entirely. If this file ever stops using it, replace
    // the anchor rather than deleting the check.
    const auditRetention = sources.find(
      ({ rel }) => rel === "src/lib/audit-retention.ts",
    );
    expect(auditRetention, "src/lib/audit-retention.ts has moved").toBeDefined();

    const seen = rawStatements(auditRetention!.code);
    // Two `$executeRaw(Prisma.sql`…`)` compositions (archive insert, archive
    // prune) and four `$executeRawUnsafe(`…`)` DDL statements — each one a
    // call, not a tagged template, and every one of them invisible to the
    // original matcher.
    expect(
      seen.filter((s) => s.tag === "$executeRaw").length,
      "The matcher no longer sees `$executeRaw(Prisma.sql`…`)` in the one " +
        "production file that writes raw SQL that way.",
    ).toBeGreaterThanOrEqual(2);
    expect(
      seen.filter((s) => s.tag === "$executeRawUnsafe").length,
      "The matcher no longer sees `$executeRawUnsafe(`…`)` call arguments.",
    ).toBeGreaterThanOrEqual(4);
    expect(seen.some((s) => /INSERT INTO "AuditLogArchive"/.test(s.sql))).toBe(
      true,
    );
    // Nothing in this file is a READ, which is why it is not in the inventory.
    expect(seen.some((s) => s.tag.startsWith("$queryRaw"))).toBe(false);
  });

  it("keeps every raw READ inside the reviewed inventory", () => {
    const found: Record<string, number> = {};
    for (const { rel, code } of sources) {
      const count = rawReadCount(code);
      if (count > 0) found[rel] = count;
    }

    expect(
      found,
      "INV-OPS-001 (docs/invariants/operations.md): " +
        "Raw-SQL READ sites changed. `$queryRaw`/`$queryRawUnsafe` hand back a " +
        "result set whose column names are the DATABASE's, not Prisma's, so a " +
        "name the code gets wrong arrives as `undefined` rather than as an " +
        "error (#2289). Only there for a row lock? Use `$executeRaw` on a " +
        "statement selecting a constant and read through the Prisma model. " +
        "Genuinely need the rows? Validate them with `decodeRawRows` and add " +
        "the file here.",
    ).toEqual(RAW_READ_INVENTORY);
  });

  it("validates every raw read that is not a documented opt-out", () => {
    // Derived from what is actually in the tree, not from the inventory above,
    // so a raw read added without touching either list fails here as well.
    //
    // COUNTED, not merely mentioned. "Does this file contain the string
    // `decodeRawRows` anywhere" is a FILE-level check, and it stops meaning
    // anything the moment a file legitimately decodes one statement: every
    // further raw read in `rate-limit.ts` would have been waved through by its
    // neighbour's decoder call, and the inventory test above only compares
    // counts, so bumping a number and leaving the new read unvalidated passed
    // both guards. Requiring at least one decoder CALL per raw read makes the
    // guard scale with the statements rather than with the filenames.
    const unvalidated = sources
      .filter(({ rel }) => !(rel in RAW_READ_OPT_OUTS))
      .map(({ rel, code }) => ({
        rel,
        reads: rawReadCount(code),
        decodes: (code.match(new RegExp(`\\b${DECODER}\\s*\\(`, "g")) ?? []).length,
      }))
      .filter(({ reads }) => reads > 0)
      .filter(({ rel, reads, decodes }) =>
        // The decoder's own module defines the function rather than calling it.
        rel === DECODER_MODULE ? false : decodes < reads,
      )
      .map(({ rel, reads, decodes }) => `${rel}: ${reads} raw read(s), ${decodes} ${DECODER}() call(s)`);

    expect(
      unvalidated,
      "INV-OPS-001 (docs/invariants/operations.md): " +
        `Raw read(s) neither validated with ${DECODER} (${DECODER_MODULE}) nor ` +
        "listed in RAW_READ_OPT_OUTS with a reason. An opt-out is only honest " +
        "when the returned rows are genuinely never read. Note this counts " +
        `${DECODER}() CALLS against raw reads per file: one decoded statement ` +
        "does not cover a second, undecoded one beside it.",
    ).toEqual([]);
  });

  it("keeps the opt-out list to statements that really read nothing", () => {
    // The list is pinned as data so it cannot grow silently, and every entry is
    // re-checked against the source: a probe that starts naming columns is no
    // longer a probe.
    expect(Object.keys(RAW_READ_OPT_OUTS).sort()).toEqual(
      ["src/instrumentation.node.ts", "src/lib/health-check.ts"].sort(),
    );
    for (const rel of Object.keys(RAW_READ_OPT_OUTS)) {
      const source = sources.find((entry) => entry.rel === rel);
      expect(source, `${rel} is on the opt-out list but does not exist`).toBeDefined();
      expect(source?.code, `${rel} must still be a bare SELECT 1 probe`).toMatch(
        /SELECT 1/,
      );
      // Every opt-out must be in the inventory, so removing the statement
      // forces the list to be tidied too.
      expect(RAW_READ_INVENTORY[rel]).toBeGreaterThan(0);
    }
  });

  it("never types a raw result (the unchecked cast itself)", () => {
    const offenders: string[] = [];
    for (const { rel, code } of sources) {
      for (const template of rawStatements(code)) {
        if (template.typeArgument) {
          offenders.push(`${rel}: ${template.tag}${template.typeArgument}`);
        }
      }
      // `$queryRawUnsafe<T>(…)` is a call, not a tagged template.
      const unsafeCast = code.match(/\$(query|execute)RawUnsafe\s*<[^>]*>\s*\(/g);
      if (unsafeCast) offenders.push(`${rel}: ${unsafeCast.join(", ")}`);
    }

    expect(
      offenders,
      "A raw-SQL result was given a type argument. That is the unchecked cast " +
        "this issue is about: it tells the compiler what the answer looks like " +
        "and verifies nothing (#2289). Use a Prisma model read, or " +
        `${DECODER}.`,
    ).toEqual([]);
  });

  it("never SELECT *s in a raw statement", () => {
    const offenders: string[] = [];
    for (const { rel, code } of sources) {
      for (const template of rawStatements(code)) {
        if (/SELECT\s+\*/i.test(template.sql)) {
          offenders.push(`${rel}: ${template.sql.trim().slice(0, 60)}`);
        }
      }
    }

    expect(
      offenders,
      "`SELECT *` makes the returned column set whatever the database " +
        "currently has, so a migration changes the result shape with nothing " +
        "in the source to review it against (#2289). Name the columns, or " +
        "select a constant if the statement is only there for a lock.",
    ).toEqual([]);
  });

  it("takes every row lock with $executeRaw on a constant (lock raw, read typed)", () => {
    const offenders: string[] = [];
    for (const { rel, code } of sources) {
      for (const template of rawStatements(code)) {
        // #2623 T9(d): every row-lock strength, not just FOR UPDATE. A
        // `FOR KEY SHARE` lock was exempt from this rule AND from the counted
        // inventory in advisory-lock-guard, so a new one written as `$queryRaw`
        // projecting columns would have passed every gate — the exact #2289
        // failure mode this rule exists to stop.
        if (!/FOR (UPDATE|KEY SHARE|NO KEY UPDATE|SHARE)/i.test(template.sql)) {
          continue;
        }
        if (template.tag !== "$executeRaw") {
          offenders.push(`${rel}: row lock issued through ${template.tag}`);
        }
        if (!/^\s*SELECT\s+1\b/i.test(template.sql)) {
          offenders.push(
            `${rel}: row lock projects columns instead of a constant — ${template.sql
              .trim()
              .slice(0, 60)}`,
          );
        }
      }
    }

    expect(
      offenders,
      "INV-OPS-001 (docs/invariants/operations.md): " +
        "A row lock must select a CONSTANT through `$executeRaw` and read its " +
        "data back through the Prisma model under that same lock (#2289). " +
        "Projecting columns into a raw result is how booking creation ended up " +
        "reading a promo row whose column names it had guessed — silently " +
        "disabling a redemption cap and a discount. See " +
        "docs/CONCURRENCY_AND_LOCKING.md -> 'Lock raw, read typed'.",
    ).toEqual([]);
  });

  /**
   * #2623 T9(b). `rawStatements` only matches a raw call whose SQL is a literal
   * immediately after the method or after `(`. That is deliberate — it is what
   * lets the shape assertions above read the SQL — but it means a composed form
   * like `tx.$queryRaw(composedSql)` matches NOTHING and silently counts zero.
   *
   * Counting zero is not neutral: it drops the file out of RAW_READ_INVENTORY
   * and out of the `reads > 0` filter that forces the decoder, so a raw read
   * could reach production covered by neither. The narrowing that introduced
   * this arrived with the hosting participant fence work, whose module mentions
   * `$queryRaw` in type positions the old identifier count miscounted — a
   * motivated change that over-corrected.
   *
   * So: assert the matcher SEES every raw call, and fail loudly on a form it
   * cannot read rather than scoring it zero.
   */
  it("never scores a raw call zero just because it cannot read its SQL", () => {
    // Only the RESULT-SET forms. `$executeRaw*` returns an affected-row count
    // and cannot lie about column names, so a composed one is not a shape risk
    // and is inventoried nowhere by design.
    const invocation = /\$queryRaw(?:Unsafe)?\s*(?:<[^>]*>)?\s*[(`]/g;
    const unreadable: string[] = [];

    for (const { rel, code } of sources) {
      const seen = rawStatements(code).filter((statement) =>
        statement.tag.startsWith("$queryRaw"),
      ).length;
      const invoked = (code.match(invocation) ?? []).length;
      if (invoked > seen) {
        unreadable.push(`${rel}: ${invoked} raw read(s), ${seen} readable`);
      }
    }

    expect(
      unreadable,
      "A raw call whose SQL this guard cannot read is invisible to the raw-read " +
        "census and to the decoder rule, so it would ship covered by neither. " +
        "Inline the SQL as a literal at the call site (which is also what makes " +
        "it reviewable), or extend `rawStatements` to read the new form.",
    ).toEqual([]);
  });

  it("keeps the decoder in one place", () => {
    const definers = sources
      .filter(({ code }) => new RegExp(`function\\s+${DECODER}\\b`).test(code))
      .map(({ rel }) => rel);

    expect(
      definers,
      `${DECODER} must be defined once, in ${DECODER_MODULE}. A second copy ` +
        "drifts from the first and the guard above stops meaning anything.",
    ).toEqual([DECODER_MODULE]);
  });
});
