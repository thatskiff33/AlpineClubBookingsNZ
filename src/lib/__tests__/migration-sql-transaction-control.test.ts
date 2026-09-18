import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  splitSqlStatements,
  stripSqlComments,
} from "../../../prisma/migration-verification/split-statements";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations");

/**
 * Statements that END a transaction or start a second one. `ROLLBACK TO
 * <savepoint>` is deliberately not one of them: it unwinds to a savepoint and
 * leaves the transaction open, which is an ordinary thing for a migration to do.
 */
const TRANSACTION_CONTROL =
  /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+TO\b)|PREPARE\s+TRANSACTION)\b/i;

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Transaction-control statements in a script BEYOND its own single outer
 * `BEGIN;`/`COMMIT;` envelope, if it has one.
 *
 * COMMENT-AWARE, AND THAT IS THE WHOLE POINT (#3369). The original matcher
 * anchored `BEGIN;` at the first byte of the file. Every `migration.sql` here
 * opens with `BEGIN;`, so every one of them was read correctly — and every
 * `rollback.sql` opens with its operator header, a block of `--` comments, so
 * not one of them matched. Each was therefore treated as having no envelope at
 * all, and its `BEGIN;`/`COMMIT;` counted as loose transaction control that
 * nothing was looking at.
 *
 * `stripSqlComments` blanks comments to spaces and keeps every newline, so its
 * result is the same LENGTH as the source and offsets found in it index
 * straight back into the verbatim bytes. That is what lets this find the
 * envelope without ever producing a re-rendered copy of the SQL — this function
 * returns findings, never SQL, so nothing can execute what it derives.
 */
function transactionControlBeyondOuterEnvelope(sql: string): string[] {
  const bare = stripSqlComments(sql);
  const open = bare.match(/^\s*BEGIN\s*;/i);
  const close = bare.match(/\bCOMMIT\s*;\s*$/i);
  const inner =
    open && close ? sql.slice(open[0].length, bare.length - close[0].length) : sql;
  return splitSqlStatements(inner)
    .map((statement) => stripSqlComments(statement).trim())
    .filter((statement) => TRANSACTION_CONTROL.test(statement));
}

describe("committed migration SQL steers no transaction but its own (#3369)", () => {
  /*
    WHY THIS IS A SEPARATE FILE, AND A STATIC ONE.

    A nested `BEGIN`/`COMMIT` inside a migration or a rollback script is a defect
    on its own terms, whatever runs it: PostgreSQL answers the nested `BEGIN`
    with a warning and then HONOURS the inner `COMMIT`, so the script commits
    half of itself and a later failure can no longer roll the rest back. An
    operator pasting the file gets that behaviour just as a test harness does.

    It was found by a harness, though, and the harness is why it mattered so
    much at the time. Verification cases used to wrap their work in
    BEGIN/ROLLBACK and run migrations inside it, so a surviving `COMMIT` made
    the case's own seed rows PERMANENT. Measured on a real PostgreSQL before the
    fix: after #3369's two reverse scripts ran, the shared chain database still
    held the case's 4 bookings and 3 members, `Booking.memberId` was back to NOT
    NULL because a rollback script's `SET NOT NULL` had committed, and replaying
    the next migration died on "null value in column memberId violates not-null
    constraint". Nothing in that failure pointed at a rollback script.

    That harness no longer rewrites SQL at all — a script carrying its own
    envelope runs byte-for-byte in a disposable database (INV-SSOT-002), which
    is a better answer and removes the sharp edge. The CHECK survives the answer
    because the defect it finds is not about the harness, and because a property
    proved by reading every committed file is worth more than one proved only
    where a fixture happens to exercise it: this grades every `migration.sql`
    and every `rollback.sql` in the repository, including the ones no fixture
    runs. It needs no database, so it fails in `verify` in seconds rather than
    in the slow job that stands PostgreSQL up.
  */
  it("finds no transaction control beyond each script's own outer envelope", () => {
    const offenders: string[] = [];
    for (const name of migrationNames()) {
      for (const file of ["migration.sql", "rollback.sql"]) {
        const full = path.join(MIGRATIONS_DIR, name, file);
        if (!existsSync(full)) continue;
        // Test helper: the repo's own migrations directory joined with a name
        // read from that same directory listing; no user input.
        const leaked = transactionControlBeyondOuterEnvelope(
          readFileSync(full, "utf8"),
        );
        if (leaked.length > 0) {
          offenders.push(
            `${name}/${file}: ${leaked
              .map((statement) => JSON.stringify(statement.slice(0, 60)))
              .join(", ")}`,
          );
        }
      }
    }
    expect(
      offenders,
      `These scripts steer a transaction beyond their own outer BEGIN/COMMIT. PostgreSQL honours an inner COMMIT after warning about the nested BEGIN, so the script commits part of itself and a later failure cannot roll the rest back (#3369):\n\n${offenders.join(
        "\n\n",
      )}`,
    ).toEqual([]);
  });

  it("reads through the operator header a rollback script opens with", () => {
    // The mutation that matters, pinned as a test rather than left to a comment:
    // an envelope behind a comment block must still be recognised AS an
    // envelope, or every rollback script in the repository reads as one long
    // leak and this whole check inverts into noise.
    const behindAHeader = [
      "-- Rollback for 20260101000000_example",
      "-- Operator: run inside the maintenance window.",
      "BEGIN;",
      'ALTER TABLE "Member" DROP COLUMN "example";',
      "COMMIT;",
      "",
    ].join("\n");
    expect(transactionControlBeyondOuterEnvelope(behindAHeader)).toEqual([]);

    const nested = [
      "-- Rollback for 20260101000000_example",
      "BEGIN;",
      'ALTER TABLE "Member" DROP COLUMN "example";',
      "COMMIT;",
      "BEGIN;",
      'ALTER TABLE "Member" DROP COLUMN "second";',
      "COMMIT;",
      "",
    ].join("\n");
    expect(transactionControlBeyondOuterEnvelope(nested).length).toBeGreaterThan(
      0,
    );

    // And a savepoint unwind is not transaction control: it leaves the
    // transaction open, which is an ordinary thing for a migration to do.
    const savepoint = [
      "BEGIN;",
      "SAVEPOINT before_repair;",
      'UPDATE "Member" SET "example" = NULL;',
      "ROLLBACK TO before_repair;",
      "COMMIT;",
      "",
    ].join("\n");
    expect(transactionControlBeyondOuterEnvelope(savepoint)).toEqual([]);
  });
});
