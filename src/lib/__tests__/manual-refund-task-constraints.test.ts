import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

/**
 * #3030 (epic #2797): the `ManualRefundTask` money constraints, exercised against
 * a real PostgreSQL rather than string-matched.
 *
 * A CHECK constraint asserted against a mocked Prisma client is not tested at
 * all: the mock accepts whatever it is given, so an assertion about the SQL text
 * passes whether or not the database would actually reject the row. Everything
 * here is proved by asking Postgres to store a bad row and reading back the
 * error code and the constraint name.
 *
 * The claim that most needs a real database is the one that motivated
 * 20260903010000 in the first place: PostgreSQL exempts NULL from a unique index,
 * so the `occurrenceKey` unique index does NOT stop two rows that both leave the
 * key NULL. That is the hole the new constraint closes, and it is asserted here
 * in both directions.
 *
 * Self-provisions a throwaway schema and applies the real migration files, so it
 * needs any reachable Postgres. It `describe.skip`s itself when the env var is
 * absent, which is exactly how a suite like this goes silently unrun - so the
 * CI step in `.github/workflows/ci.yml` (job `migration-drift`) MUST stay wired.
 */

const databaseUrl = process.env.MANUAL_REFUND_TASK_CONSTRAINT_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** The migration that made the model honest (#2797 foundation, PR #2971). */
const FOUNDATION_MIGRATION =
  "prisma/migrations/20260819130000_manual_refund_task_edit_financial_review/migration.sql";
/** The migration under test (#3030). */
const OCCURRENCE_KEY_MIGRATION =
  "prisma/migrations/20260903010000_manual_refund_task_edit_review_occurrence_key_required/migration.sql";

/**
 * The foundation migration also constrains `BookingGuest` and
 * `BookingGuestNight`, which this throwaway schema does not create. Rather than
 * hand-copying the ManualRefundTask statements - which would test a copy instead
 * of the shipped file - the real file is read and the statements naming another
 * table are dropped.
 */
async function manualRefundTaskStatements(
  migrationPath: string,
): Promise<string[]> {
  const sql = await readFile(path.join(process.cwd(), migrationPath), "utf8");
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .filter(
      (statement) =>
        statement.includes('"ManualRefundTask"') ||
        statement.includes('"ManualRefundTaskKind"'),
    );
}

async function withManualRefundTaskSchema(
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const schemaName = `manual_refund_task_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);

    // The pre-#2797 shape: NOT NULL money columns, no kind, no occurrence key.
    // `ManualRefundTaskStatus` predates all of this and is not the subject.
    await client.query(`
      CREATE TYPE "ManualRefundTaskStatus" AS ENUM ('OPEN', 'COMPLETED', 'DISMISSED');

      CREATE TABLE "ManualRefundTask" (
        "id" TEXT PRIMARY KEY,
        "bookingId" TEXT NOT NULL,
        "paymentId" TEXT NOT NULL,
        "amountCents" INTEGER NOT NULL,
        "reason" VARCHAR(500) NOT NULL,
        "status" "ManualRefundTaskStatus" NOT NULL DEFAULT 'OPEN',
        "completedByMemberId" TEXT,
        "completedAt" TIMESTAMP(3),
        "note" VARCHAR(500),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    for (const migrationPath of [
      FOUNDATION_MIGRATION,
      OCCURRENCE_KEY_MIGRATION,
    ]) {
      for (const statement of await manualRefundTaskStatements(migrationPath)) {
        await client.query(statement);
      }
    }

    await run(client);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

type InsertRow = {
  id: string;
  kind?: string | null;
  occurrenceKey?: string | null;
  amountCents?: number | null;
  raisedAmountCents?: number | null;
  status?: "OPEN" | "COMPLETED" | "DISMISSED";
  paymentId?: string | null;
};

function insert(client: Client, row: InsertRow) {
  return client.query(
    `INSERT INTO "ManualRefundTask"
       ("id", "bookingId", "paymentId", "amountCents", "raisedAmountCents",
        "kind", "occurrenceKey", "reason", "status")
     VALUES ($1, 'booking-1', $2, $3, $4, $5::"ManualRefundTaskKind", $6, 'raised by a booking edit', $7::"ManualRefundTaskStatus")`,
    [
      row.id,
      row.paymentId === undefined ? "payment-1" : row.paymentId,
      row.amountCents === undefined ? 9000 : row.amountCents,
      row.raisedAmountCents === undefined ? 9000 : row.raisedAmountCents,
      row.kind ?? null,
      row.occurrenceKey ?? null,
      row.status ?? "OPEN",
    ],
  );
}

describeWithDatabase("ManualRefundTask database constraints (#3030)", () => {
  it("refuses an EDIT_FINANCIAL_REVIEW row with no occurrence key, so a writer cannot opt out of the duplicate fence", async () => {
    await withManualRefundTaskSchema(async (client) => {
      await expect(
        insert(client, {
          id: "unkeyed",
          kind: "EDIT_FINANCIAL_REVIEW",
          occurrenceKey: null,
          amountCents: null,
          raisedAmountCents: null,
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "ManualRefundTask_edit_review_occurrence_key_present",
      });
    });
  });

  it("accepts an EDIT_FINANCIAL_REVIEW row that carries its key, with the amount genuinely unknown rather than zero", async () => {
    await withManualRefundTaskSchema(async (client) => {
      await insert(client, {
        id: "keyed",
        kind: "EDIT_FINANCIAL_REVIEW",
        occurrenceKey: "edit-financial-review:v1:abc",
        amountCents: null,
        raisedAmountCents: null,
        paymentId: null,
      });

      const { rows } = await client.query(
        `SELECT "amountCents", "paymentId" FROM "ManualRefundTask" WHERE "id" = 'keyed'`,
      );
      // NULL, not 0 - the distinction the whole epic turns on. And no payment
      // link was invented to satisfy the model (owner decision D2).
      expect(rows[0].amountCents).toBeNull();
      expect(rows[0].paymentId).toBeNull();
    });
  });

  it("leaves the three legacy kinds and every pre-#2797 row alone, keyless", async () => {
    await withManualRefundTaskSchema(async (client) => {
      // A legacy kind: "kind" <> 'EDIT_FINANCIAL_REVIEW' is TRUE, so the check
      // passes whatever the key holds.
      await insert(client, {
        id: "legacy",
        kind: "CANCELLED_BOOKING_HAND_BACK",
        occurrenceKey: null,
      });
      // A pre-#2797 row: the comparison is NULL, and a CHECK accepts anything
      // that is not FALSE. This is the claim the migration's ledger row makes
      // about old-code compatibility, proved rather than asserted.
      await insert(client, { id: "prehistoric", kind: null, occurrenceKey: null });

      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM "ManualRefundTask"`,
      );
      expect(rows[0].n).toBe(2);
    });
  });

  it("proves the hole the new constraint closes: the unique index does NOT stop two rows that both leave the key NULL", async () => {
    await withManualRefundTaskSchema(async (client) => {
      await insert(client, { id: "null-key-a", kind: null });
      // Postgres treats NULLs as distinct under a unique index, so this second
      // row is accepted. That exemption is load-bearing for the legacy kinds and
      // is exactly why an EDIT_FINANCIAL_REVIEW row cannot be allowed to use it.
      await insert(client, { id: "null-key-b", kind: null });

      // A real key, however, is unique.
      await insert(client, {
        id: "dup-a",
        kind: "EDIT_FINANCIAL_REVIEW",
        occurrenceKey: "edit-financial-review:v1:same",
      });
      await expect(
        insert(client, {
          id: "dup-b",
          kind: "EDIT_FINANCIAL_REVIEW",
          occurrenceKey: "edit-financial-review:v1:same",
        }),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "ManualRefundTask_occurrenceKey_key",
      });
    });
  });

  it("refuses to close a task with no confirmed amount, whatever the application layer does", async () => {
    await withManualRefundTaskSchema(async (client) => {
      await expect(
        insert(client, {
          id: "closed-unpriced",
          kind: "EDIT_FINANCIAL_REVIEW",
          occurrenceKey: "edit-financial-review:v1:unpriced",
          amountCents: null,
          raisedAmountCents: null,
          status: "COMPLETED",
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "ManualRefundTask_completed_amount_present",
      });
    });
  });

  it("allows a DISMISSED review to keep an unknown amount, because reviewed-and-nothing-owed is not a zero", async () => {
    await withManualRefundTaskSchema(async (client) => {
      await insert(client, {
        id: "dismissed-unpriced",
        kind: "EDIT_FINANCIAL_REVIEW",
        occurrenceKey: "edit-financial-review:v1:dismissed",
        amountCents: null,
        raisedAmountCents: null,
        status: "DISMISSED",
      });

      const { rows } = await client.query(
        `SELECT "amountCents" FROM "ManualRefundTask" WHERE "id" = 'dismissed-unpriced'`,
      );
      expect(rows[0].amountCents).toBeNull();
    });
  });

  it.each([
    ["amountCents", "ManualRefundTask_amount_nonnegative"],
    ["raisedAmountCents", "ManualRefundTask_raised_amount_nonnegative"],
  ])("refuses a negative %s (INV-MONEY-001)", async (column, constraint) => {
    await withManualRefundTaskSchema(async (client) => {
      await expect(
        insert(client, {
          id: `negative-${column}`,
          kind: "EDIT_FINANCIAL_REVIEW",
          occurrenceKey: `edit-financial-review:v1:${column}`,
          ...(column === "amountCents"
            ? { amountCents: -1 }
            : { raisedAmountCents: -1 }),
        }),
      ).rejects.toMatchObject({ code: "23514", constraint });
    });
  });
});
