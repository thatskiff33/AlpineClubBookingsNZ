import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { realElapsedMs } from "./helpers/clock";

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

const DATABASE_URL_ENV = "MANUAL_REFUND_TASK_CONSTRAINT_TEST_DATABASE_URL";
/** The ci.yml job that stands up the database and runs this suite. */
const CI_JOB_ID = "migration-drift";

const databaseUrl = process.env[DATABASE_URL_ENV];
const describeWithDatabase = databaseUrl ? describe : describe.skip;

/**
 * The self-guard, and it runs WITH OR WITHOUT a database.
 *
 * Everything below skips when the URL is absent, which is the only workable
 * arrangement locally - but inside the job built to run it, a skip is a lie: the
 * constraints report as covered while nothing has offered a single bad row to a
 * database. `review-findings-contracts.test.ts` pins the step from outside;
 * this fails from inside, which is the half that cannot be defeated by moving
 * the step, commenting the `env:` line out, or renaming anything.
 *
 * Scoped by GITHUB_JOB rather than by CI, because the `verify` job deliberately
 * runs the whole suite with no database and must stay green. Same pattern as
 * `data-migration-verification.realdb.test.ts` (#2418).
 */
describe("ManualRefundTask constraint suite wiring (#3030)", () => {
  it("refuses to skip inside its own CI job: the database URL must be wired", () => {
    if (process.env.GITHUB_JOB !== CI_JOB_ID) return;
    expect(
      databaseUrl,
      `${DATABASE_URL_ENV} is not set inside the ${CI_JOB_ID} job. That job runs this suite against a real PostgreSQL - see .github/workflows/ci.yml.`,
    ).toBeTruthy();
  });
});

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

/**
 * A second connection on the same throwaway schema, for the concurrency test.
 * The caller owns closing it - the outer `finally` DROPs the schema, which would
 * block behind any transaction this connection still holds.
 */
async function connectToSchema(schema: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`SET search_path TO ${schema}`);
  return client;
}

async function withManualRefundTaskSchema(
  run: (client: Client, schema: string) => Promise<void>,
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

    await run(client, schema);
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

  it("refuses a LEGACY-kind row with no amount, so an operator can never settle one at a figure they typed", async () => {
    await withManualRefundTaskSchema(async (client) => {
      // The application's stale-screen guard is
      // `amountCents !== null && amountCents !== confirmed`, so a legacy task
      // whose amount is NULL falls straight through it and closes at whatever the
      // screen posted - on exactly the kinds whose amount cancellation or capture
      // policy computed and an operator does not get to reprice.
      await expect(
        insert(client, {
          id: "legacy-unpriced",
          kind: "CANCELLED_BOOKING_HAND_BACK",
          amountCents: null,
          raisedAmountCents: null,
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "ManualRefundTask_non_edit_review_amount_present",
      });
    });
  });

  it("refuses a kind-IS-NULL row with no amount too, which the obvious <> spelling of that constraint would have exempted", async () => {
    await withManualRefundTaskSchema(async (client) => {
      // Written as ("kind" <> 'EDIT_FINANCIAL_REVIEW' OR "amountCents" IS NOT
      // NULL), this row evaluates to (NULL OR FALSE) = NULL, and a CHECK accepts
      // anything that is not FALSE - so precisely the pre-#2797 shape would slip
      // through. IS NOT DISTINCT FROM is null-safe, and this is what proves it.
      await expect(
        insert(client, {
          id: "prehistoric-unpriced",
          kind: null,
          amountCents: null,
          raisedAmountCents: null,
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "ManualRefundTask_non_edit_review_amount_present",
      });
    });
  });

  it("still accepts a legacy row that carries its amount, which is every row any released writer has ever made", async () => {
    await withManualRefundTaskSchema(async (client) => {
      await insert(client, {
        id: "legacy-priced",
        kind: "DELETED_BOOKING_LATE_CAPTURE",
        amountCents: 9000,
        raisedAmountCents: 9000,
      });
      const { rows } = await client.query(
        `SELECT "amountCents" FROM "ManualRefundTask" WHERE "id" = 'legacy-priced'`,
      );
      expect(rows[0].amountCents).toBe(9000);
    });
  });

  it("refuses a task RAISED with an amount whose amount has since become unknown, which the schema says cannot happen", async () => {
    await withManualRefundTaskSchema(async (client) => {
      await expect(
        insert(client, {
          id: "raised-then-forgotten",
          kind: "EDIT_FINANCIAL_REVIEW",
          occurrenceKey: "edit-financial-review:v1:raised",
          amountCents: null,
          raisedAmountCents: 5000,
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "ManualRefundTask_raised_amount_requires_amount",
      });
    });
  });

  it("allows the converse - raised with NO amount and completed at a confirmed one - because that is the whole feature", async () => {
    await withManualRefundTaskSchema(async (client) => {
      await insert(client, {
        id: "raised-unpriced-then-completed",
        kind: "EDIT_FINANCIAL_REVIEW",
        occurrenceKey: "edit-financial-review:v1:priced-later",
        amountCents: 4500,
        raisedAmountCents: null,
        status: "COMPLETED",
      });
      const { rows } = await client.query(
        `SELECT "amountCents", "raisedAmountCents" FROM "ManualRefundTask" WHERE "id" = 'raised-unpriced-then-completed'`,
      );
      expect(rows[0].amountCents).toBe(4500);
      expect(rows[0].raisedAmountCents).toBeNull();
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

  /**
   * #3030 finding 5: the advisory lock is the module's designated PRIMARY fence,
   * and until this test nothing exercised it. The unit test proves
   * `$executeRaw` is called before `findUnique` in ONE process; it cannot show
   * the lock serialises anything, because a mocked `$executeRaw` returns 1 and
   * blocks nobody.
   *
   * WHAT THIS COVERS AND WHAT IT DOES NOT, stated rather than implied. It drives
   * the LOCK PROTOCOL - BEGIN, `pg_advisory_xact_lock(1)`, find, insert, COMMIT -
   * against a real PostgreSQL from two connections. It does not call
   * `raiseEditFinancialReviewTask` itself, which needs the whole Prisma schema
   * and its foreign keys rather than this one disposable table. The pairing is
   * deliberate: this proves the protocol serialises, and
   * `edit-financial-review.test.ts` proves the shipped function issues exactly
   * this protocol in exactly this order.
   */
  it("MUTATION: the advisory lock SERIALISES two concurrent raises, so the second returns the first's row instead of colliding", async () => {
    await withManualRefundTaskSchema(async (client, schema) => {
      const second = await connectToSchema(schema);
      const key = "edit-financial-review:v1:race";
      const find = `SELECT "id" FROM "ManualRefundTask" WHERE "occurrenceKey" = $1`;
      const raise = async (c: Client, id: string) => {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(1)");
        const found = await c.query(find, [key]);
        if (found.rows.length > 0) {
          await c.query("COMMIT");
          return { created: false, id: found.rows[0].id as string };
        }
        await insert(c, {
          id,
          kind: "EDIT_FINANCIAL_REVIEW",
          occurrenceKey: key,
          amountCents: null,
          raisedAmountCents: null,
        });
        await c.query("COMMIT");
        return { created: true, id };
      };

      try {
        // DELIBERATELY STAGGERED. Letting both resolve in the same tick is one
        // unusually forgiving interleaving, not a neutral harness, and this
        // repository has already shipped a regression test that passed against
        // broken code for exactly that reason. The first raise is driven to the
        // point where it HOLDS the lock and has already decided to insert; only
        // then is the second started, and the test waits until PostgreSQL itself
        // reports it BLOCKED before letting the first commit.
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(1)");
        expect((await client.query(find, [key])).rows).toHaveLength(0);

        const secondRaise = raise(second, "race-b");

        const startedNs = process.hrtime.bigint();
        let blocked = false;
        while (realElapsedMs(startedNs) < 5000) {
          const waiting = await client.query(
            `SELECT count(*)::int AS n FROM pg_locks
               WHERE locktype = 'advisory' AND NOT granted`,
          );
          if (waiting.rows[0].n > 0) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // If this fails the rest proves nothing: the second raise was never
        // actually contending, so a passing result would be vacuous.
        expect(blocked).toBe(true);

        await insert(client, {
          id: "race-a",
          kind: "EDIT_FINANCIAL_REVIEW",
          occurrenceKey: key,
          amountCents: null,
          raisedAmountCents: null,
        });
        await client.query("COMMIT");

        // The second raise was blocked on the lock, not on the row - so when it
        // proceeds it SEES the committed row and returns it. Without the lock it
        // would have read an empty table before the first insert and then hit the
        // unique index (23505), which is the belt-and-braces half failing loudly
        // instead of the primary fence working quietly.
        await expect(secondRaise).resolves.toEqual({
          created: false,
          id: "race-a",
        });

        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM "ManualRefundTask" WHERE "occurrenceKey" = $1`,
          [key],
        );
        expect(rows[0].n).toBe(1);
      } finally {
        await second.query("ROLLBACK").catch(() => undefined);
        await second.end();
      }
    });
  });
});
