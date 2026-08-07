// #2621 (epic #2629) — the `Booking.expectedArrivalTime` retirement guard,
// POST-DROP.
//
// The column is gone. `20260808000000_contract_drop_booking_expected_arrival_time`
// drops it under a maintenance window (owner decisions D-M1/D-M2, 8 Aug 2026) and
// this release removes the field from prisma/schema.prisma in the SAME commit —
// there is no soak release in between, which is exactly why the migration is
// declared `windowed` rather than `yes`.
//
// WHY A FILE OF ITS OWN, and what it is for. This is the #2520 precedent
// (src/lib/__tests__/family-group-role-retirement.test.ts) applied to a second
// contract drop. Three separate artefacts have to agree for the drop to be safe,
// and each of them is edited by a different kind of change:
//
//   * prisma/schema.prisma must declare NO such field, or the generated client
//     puts the column name back into ordinary SQL and every read of "Booking"
//     fails with Postgres 42703 / Prisma P2022 — on the hottest table in the
//     product;
//   * the migration must actually DROP that column, or the field's absence is a
//     lie the drift gate catches late and an operator catches later;
//   * a `windowed` migration must ship `rollback.sql` beside `migration.sql` and
//     must be DECLARED `windowed` in the safety ledger, because that declaration
//     is the only thing that makes the deploy demand a maintenance window instead
//     of a rolling cutover.
//
// Any one of the three drifting silently is a production incident, and none of
// them is protected by the compiler. Nothing here duplicates
// pre-arrival-arrival-token-retirement.test.ts, which covers the OTHER end of the
// same retirement: the email tokens a customising club may still hold.
//
// NOT COVERED HERE, deliberately: a raw-SQL scan of the #2520 kind. That scan
// exists because `FamilyGroupMember.role` had a real history of column names
// inside `$queryRaw` strings and psql heredocs. `expectedArrivalTime` never
// appeared in raw SQL — it was read and written only through the Prisma client,
// whose field is now gone — so a scan would pin a surface that never existed and
// would pass vacuously. If raw SQL ever starts naming "Booking" columns by hand,
// copy the #2520 scan rather than inventing one.

import fs from "node:fs";
import path from "node:path";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma", "schema.prisma");
const DROP_MIGRATION =
  "20260808000000_contract_drop_booking_expected_arrival_time";
const MIGRATION_DIR = path.join(
  REPO_ROOT,
  "prisma",
  "migrations",
  DROP_MIGRATION,
);
const DROPPED_COLUMN = "expectedArrivalTime";

describe("#2621 Booking.expectedArrivalTime is dropped", () => {
  // ---------------------------------------------------------------------------
  // The proof that makes the DROP safe for the replacement runtime, and the
  // assertion the runbook's §2.4.2 step 8(c) check mirrors at the deploy host.
  // ---------------------------------------------------------------------------

  it("the generated Prisma Client does not expose the dropped column at all", () => {
    // Asserted against the generated client rather than inferred from the source:
    // with no field there is no SELECT, no INSERT column list and no implicit
    // RETURNING the client can emit that names the dropped column, whatever any
    // call site does. Prisma SELECTs every scalar of a model on any find that does
    // not narrow itself with `select:`, so this is the assertion that fires if the
    // field is put back into prisma/schema.prisma without a migration to match.
    const scalars = Object.keys(Prisma.BookingScalarFieldEnum);
    expect(
      scalars,
      `Booking.${DROPPED_COLUMN} was DROPPED from the database by ` +
        `${DROP_MIGRATION}. The generated client must not carry the field: if it ` +
        'does, Prisma names a column that no longer exists on "Booking" — the ' +
        "hottest table in the product — and the booking detail page, the member " +
        "bookings list, the lodge guests route, the pre-arrival reminder cron and " +
        "every booking-create path fail with Postgres 42703 / Prisma P2022.",
    ).not.toContain(DROPPED_COLUMN);
    // Sanity, so the assertion above cannot pass vacuously against an empty or
    // wrong enum: this really is Booking's scalar enum.
    expect(scalars).toContain("id");
    expect(scalars).toContain("checkIn");
    expect(scalars).toContain("checkOut");
  });

  it("the schema declares no expected-arrival-time field on Booking", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    const model = /model Booking \{[\s\S]*?\n\}/.exec(schema);
    expect(model, "Booking model not found in schema.prisma").not.toBeNull();
    const body = model![0];
    // Field declarations only, so the tombstone comment left in the model (which
    // names the column, deliberately) cannot fail this.
    const fieldLines = body
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    expect(
      new RegExp(`(^|\\s)${DROPPED_COLUMN}\\s+\\S`).test(fieldLines),
      `Booking must declare no \`${DROPPED_COLUMN}\` field: the database column ` +
        `is dropped (${DROP_MIGRATION}), so a field here would produce SQL ` +
        "naming a column that does not exist. The club collects no travel times " +
        "at all under the motel-stay model — presence is derived from the booked " +
        "nights alone, and a guest leaving early talks to the hut leader (owner " +
        "decision D-M1).",
    ).toBe(false);
    // The absence is documented rather than accidental, so a future author does
    // not "restore" the field as a live signal. Read off the tombstone comment
    // with its `//` markers and line wrapping flattened, so re-wrapping the
    // paragraph cannot fail this while deleting it still does.
    const tombstone = body
      .split("\n")
      .filter((line) => /^\s*\/\//.test(line))
      .map((line) => line.replace(/^\s*\/\/\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(tombstone).toContain(DROPPED_COLUMN);
    expect(tombstone).toContain(DROP_MIGRATION);
    expect(tombstone).toContain("Do not reintroduce the field");
  });

  // ---------------------------------------------------------------------------
  // The field's absence is only correct because a committed migration drops the
  // column, and a windowed migration is only valid with its reverse script.
  // ---------------------------------------------------------------------------

  it("ships the DROP migration and its reverse script", () => {
    const migrationSql = path.join(MIGRATION_DIR, "migration.sql");
    const rollbackSql = path.join(MIGRATION_DIR, "rollback.sql");
    expect(fs.existsSync(migrationSql), `${DROP_MIGRATION}/migration.sql`).toBe(
      true,
    );
    expect(
      fs.existsSync(rollbackSql),
      "A windowed migration must ship rollback.sql beside migration.sql " +
        "(docs/BLUE_GREEN_MIGRATION_POLICY.md). The deploy validator enforces " +
        "this too, as a documentation failure the ALLOW_BREAKING override cannot " +
        "rescue.",
    ).toBe(true);

    const migration = fs.readFileSync(migrationSql, "utf8");
    expect(migration).toMatch(/ALTER TABLE "Booking"/);
    expect(migration).toMatch(new RegExp(`DROP COLUMN "${DROPPED_COLUMN}"`));

    // EXACTLY that column, and nothing else. A second DROP COLUMN smuggled into
    // this folder would be a schema removal nobody declared in the ledger row,
    // and the ledger row is what the deploy gate reads.
    const statements = migration
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
    expect(statements.match(/DROP COLUMN/g)).toHaveLength(1);
    expect(statements).not.toMatch(/\bDROP TABLE\b/i);
    // And no DML: the migration reads and rewrites no rows, which is what makes
    // its lock impact one brief metadata-only ACCESS EXCLUSIVE lock on the
    // hottest table in the product rather than a rewrite.
    expect(statements).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);

    // The reverse script must restore the exact shape the previous release's
    // client expects from `String? @db.VarChar(5)` — nullable VARCHAR(5) with no
    // default, the shape 20260408060000_add_expected_arrival_time created.
    const rollback = fs.readFileSync(rollbackSql, "utf8");
    expect(rollback).toMatch(
      new RegExp(`ADD COLUMN "${DROPPED_COLUMN}" VARCHAR\\(5\\)`),
    );
    // It must keep saying, in its own words, that the VALUES do not come back.
    // That sentence is the whole reason the file is safe to hand an operator at
    // 2am: the column reappearing is not the times reappearing (owner decision
    // D-M2), and no future edit may quietly soften it into a restore promise.
    expect(rollback).toMatch(/THE ARRIVAL TIMES ARE GONE/);
  });

  it("is declared windowed in the blue/green safety ledger", () => {
    const ledger = fs.readFileSync(
      path.join(REPO_ROOT, "docs", "BLUE_GREEN_MIGRATION_SAFETY.tsv"),
      "utf8",
    );
    const row = ledger
      .split("\n")
      .find((line) => line.startsWith(`${DROP_MIGRATION}\t`));
    expect(row, `no ledger row for ${DROP_MIGRATION}`).toBeDefined();
    const fields = row!.split("\t");
    // DROP COLUMN is a destructive removal, so the validator requires
    // phase=contract with a named previous expand release; the owner directive
    // requires the honest `windowed` declaration rather than `yes`, because the
    // runtime half ships in this same commit and no colour has drained; and
    // `windowed` is only meaningful with the window written down.
    expect(fields[1]).toBe("contract");
    expect(fields[2]).not.toBe("n/a");
    expect(fields[2]).not.toBe("");
    // Exactly `windowed`. The validator's fourth column is a closed vocabulary
    // and a near-miss spelling (`Windowed`, `maybe`, blank) silently disarms the
    // declaration while the gate still reports "safety check passed".
    expect(fields[3]).toBe("windowed");
    expect(fields[4] ?? "").toContain("MAINTENANCE-WINDOW PLAN");
    // The irreversible data deletion is the one thing about this row an operator
    // must not learn from the code, so the row has to carry it.
    expect(fields[4] ?? "").toContain("IRREVERSIBLE DATA DELETION");
  });
});
