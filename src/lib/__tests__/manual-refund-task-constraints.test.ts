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
 * #3213: registers `UNCOLLECTED_EDIT_REVIEW_SHARE` and RESTATES two constraints
 * around it - `ManualRefundTask_non_edit_review_amount_present`, so that label
 * may carry a NULL amount, and
 * `ManualRefundTask_edit_review_occurrence_key_present`, so it may NOT carry a
 * null occurrence key. Applied last, in real deploy order, so the predicates
 * these tests meet are the ones the shipped migrations actually leave behind
 * rather than hand-copied approximations of them.
 */
const WITHHELD_SHARE_MIGRATION =
  "prisma/migrations/20260910010000_register_uncollected_edit_review_share_kind/migration.sql";
/**
 * #3639: the treasurer-approval marker `lateCaptureApprovalIntentId` - a nullable
 * column, its unique index (one approval item per capture) and the CHECK that
 * only a `DELETED_BOOKING_LATE_CAPTURE` row may carry it. No new kind label, so
 * the previous app version can read every row. Its `BookingDefaults` column is
 * filtered out with every other statement that names another table.
 */
const LATE_CAPTURE_APPROVAL_MIGRATION =
  "prisma/migrations/20261013010000_add_late_capture_refund_approval/migration.sql";
/**
 * #3643 (owner decision 28 Sep 2026): the part-payment review marker
 * `partPaymentReviewPaymentId` - a nullable column, its unique index (one review
 * per payment), a widened `ManualRefundTask_non_edit_review_amount_present`
 * (a marked row may carry no amount) and the shape CHECK (a marked row is an
 * amountless, paymentless CANCELLED_BOOKING_HAND_BACK). No new kind label.
 */
const PART_PAYMENT_REVIEW_MIGRATION =
  "prisma/migrations/20261014010000_add_unsized_part_payment_review_task/migration.sql";

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
      WITHHELD_SHARE_MIGRATION,
      LATE_CAPTURE_APPROVAL_MIGRATION,
      PART_PAYMENT_REVIEW_MIGRATION,
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

  it("accepts an UNCOLLECTED_EDIT_REVIEW_SHARE row with no amount, because the replay cannot know the figure (#3213)", async () => {
    await withManualRefundTaskSchema(async (client) => {
      // 20260910010000 relaxed "non_edit_review_amount_present" for this kind,
      // and it is a money decision rather than a convenience. There are two
      // writers of a withheld share and only one knows the figure: the
      // settlement leg holds THIS task's own settled share, while the
      // payment-recovery replay passes it as NULL by design - it re-derives the
      // edit's COMBINED total and cannot say which part the sent invoice already
      // carried.
      //
      // Storing that total here instead would put a number in the money column
      // of an item whose sentence tells an officer to bill what is missing, and
      // an officer who bills the total bills the member a SECOND time for money
      // already asked for. NULL says "not knowable"; 0 may never be used to mean
      // it, exactly as on EDIT_FINANCIAL_REVIEW.
      await insert(client, {
        id: "withheld-unknown",
        kind: "UNCOLLECTED_EDIT_REVIEW_SHARE",
        occurrenceKey: "uncollected-edit-review-share:v1:mod-1",
        amountCents: null,
        raisedAmountCents: null,
        paymentId: null,
      });

      const { rows } = await client.query(
        `SELECT "amountCents" FROM "ManualRefundTask" WHERE "id" = 'withheld-unknown'`,
      );
      expect(rows[0].amountCents).toBeNull();
    });
  });

  it("refuses an UNCOLLECTED_EDIT_REVIEW_SHARE row with no occurrence key, so one withheld share cannot become two items (#3213)", async () => {
    await withManualRefundTaskSchema(async (client) => {
      // THE DUPLICATE FENCE, and it is a CHECK rather than the unique index
      // because the unique index cannot do this job alone: PostgreSQL exempts
      // NULL from a unique index, so two rows that both leave the key unset do
      // not collide - with each other or with anything. A withheld-share writer
      // that forgot the key would raise a fresh item on every replay, and the
      // officer would be told twice to check the same booking and could bill it
      // twice. 20260903010000 made that unrepresentable for EDIT_FINANCIAL_REVIEW;
      // 20260910010000 extends the same predicate to this kind.
      await expect(
        insert(client, {
          id: "withheld-no-key",
          kind: "UNCOLLECTED_EDIT_REVIEW_SHARE",
          occurrenceKey: null,
          amountCents: 4500,
          raisedAmountCents: null,
          paymentId: null,
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "ManualRefundTask_edit_review_occurrence_key_present",
      });
    });
  });

  it("allows one treasurer-approval marker per late capture, and only on the #2700 late-capture kind (#3639)", async () => {
    await withManualRefundTaskSchema(async (client) => {
      const approval = (id: string, kind: string | null, intent: string) =>
        client.query(
          `INSERT INTO "ManualRefundTask"
             ("id", "bookingId", "paymentId", "amountCents", "raisedAmountCents",
              "kind", "lateCaptureApprovalIntentId", "reason", "status")
           VALUES ($1, 'booking-1', 'payment-1', 2500, 2500,
                   $2::"ManualRefundTaskKind", $3, 'held for a treasurer', 'OPEN')`,
          [id, kind, intent],
        );
      await approval("late-first", "DELETED_BOOKING_LATE_CAPTURE", "pi_late");
      // The duplicate fence: a second item for the same capture.
      await expect(
        approval("late-second", "DELETED_BOOKING_LATE_CAPTURE", "pi_late"),
      ).rejects.toMatchObject({ code: "23505" });
      // The marker on any other kind would route a hand-back to a card refund.
      await expect(
        approval("late-wrong-kind", "CANCELLED_BOOKING_HAND_BACK", "pi_other"),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "ManualRefundTask_late_capture_approval_kind",
      });
      // #3643 (migration review F1): nor on a row with NO kind. "kind" is
      // nullable, and #3639's plain "=" was NULL there, which a CHECK accepts;
      // 20261014010000 restates it IS NOT DISTINCT FROM.
      await expect(approval("late-no-kind", null, "pi_null")).rejects.toMatchObject({
        code: "23514",
        constraint: "ManualRefundTask_late_capture_approval_kind",
      });
      // And every unmarked row is untouched: many NULLs, any kind.
      await insert(client, { id: "legacy-a", kind: "DELETED_BOOKING_LATE_CAPTURE" });
      await insert(client, { id: "legacy-b", kind: "DELETED_BOOKING_LATE_CAPTURE" });
    });
  });

  it("allows one amountless part-payment review per payment, only as a paymentless hand-back that cannot complete (#3643)", async () => {
    await withManualRefundTaskSchema(async (client) => {
      const review = (
        id: string,
        overrides: {
          kind?: string | null;
          amountCents?: number | null;
          paymentId?: string | null;
          status?: string;
          marker?: string | null;
          xeroPaidAt?: string | null;
          xeroPaidCents?: number | null;
        } = {},
      ) =>
        client.query(
          `INSERT INTO "ManualRefundTask"
             ("id", "bookingId", "paymentId", "amountCents", "raisedAmountCents",
              "kind", "partPaymentReviewPaymentId", "partPaymentReviewXeroPaidAt",
              "partPaymentReviewXeroPaidCents", "reason", "status")
           VALUES ($1, 'booking-1', $2, $3, NULL,
                   $4::"ManualRefundTaskKind", $5, $6::timestamp(3), $7, 'settle in Xero',
                   $8::"ManualRefundTaskStatus")`,
          [
            id,
            overrides.paymentId ?? null,
            overrides.amountCents ?? null,
            // `in`, not `??`: a NULL kind is a case under test (migration review F1).
            "kind" in overrides ? overrides.kind : "CANCELLED_BOOKING_HAND_BACK",
            "marker" in overrides ? overrides.marker : "payment-1",
            overrides.xeroPaidAt ?? null,
            overrides.xeroPaidCents ?? null,
            overrides.status ?? "OPEN",
          ],
        );
      // The amountless review the widened amount CHECK now accepts.
      await review("review-first");
      // The duplicate fence: a second review of the same payment.
      await expect(review("review-second")).rejects.toMatchObject({ code: "23505" });
      // The shape: any other kind, an amount, or a paymentId is refused.
      for (const [id, overrides] of [
        ["review-wrong-kind", { kind: "DELETED_BOOKING_LATE_CAPTURE", marker: "payment-2" }],
        ["review-with-amount", { amountCents: 5000, marker: "payment-3" }],
        ["review-with-payment", { paymentId: "payment-4", marker: "payment-4" }],
        // A NULL kind: a plain "=" would be NULL here, which a CHECK accepts.
        ["review-no-kind", { kind: null, marker: "payment-7" }],
        // The sync's Xero-paid note (INV-PAY-109): both halves together, never
        // negative cents, and only on a marked row.
        ["review-paid-at-only", { xeroPaidAt: "2026-07-01T00:00:00Z", marker: "payment-8" }],
        ["review-paid-cents-only", { xeroPaidCents: 5000, marker: "payment-10" }],
        [
          "review-paid-negative",
          { xeroPaidAt: "2026-07-01T00:00:00Z", xeroPaidCents: -1, marker: "payment-11" },
        ],
        [
          "unmarked-with-paid",
          {
            marker: null,
            amountCents: 5000,
            xeroPaidAt: "2026-07-01T00:00:00Z",
            xeroPaidCents: 5000,
          },
        ],
      ] as const) {
        await expect(review(id, overrides)).rejects.toMatchObject({
          code: "23514",
          constraint: "ManualRefundTask_part_payment_review_shape",
        });
      }
      // And it can never be COMPLETED: that needs an amount the shape forbids.
      await expect(
        review("review-completed", { status: "COMPLETED", marker: "payment-5" }),
      ).rejects.toMatchObject({ code: "23514" });
      await review("review-dismissed", { status: "DISMISSED", marker: "payment-6" });
      // A review the sync has noted Xero-paid, including a zero-cash read.
      await review("review-noted", {
        xeroPaidAt: "2026-07-01T00:00:00Z",
        xeroPaidCents: 0,
        marker: "payment-9",
      });
      // The widening is for marked rows only: an unmarked hand-back still needs an amount.
      await expect(
        insert(client, { id: "legacy-no-amount", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: null, raisedAmountCents: null }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "ManualRefundTask_non_edit_review_amount_present",
      });
    });
  });

  it("refuses a SECOND withheld-share item under the same occurrence key, which is what the fence is for", async () => {
    await withManualRefundTaskSchema(async (client) => {
      const occurrenceKey = "uncollected-edit-review-share:v1:mod-1";
      await insert(client, {
        id: "withheld-first",
        kind: "UNCOLLECTED_EDIT_REVIEW_SHARE",
        occurrenceKey,
        amountCents: 4500,
        raisedAmountCents: null,
        paymentId: null,
      });

      await expect(
        insert(client, {
          id: "withheld-replay",
          kind: "UNCOLLECTED_EDIT_REVIEW_SHARE",
          occurrenceKey,
          amountCents: 4500,
          raisedAmountCents: null,
          paymentId: null,
        }),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  it("still exempts a LEGACY-kind row from the occurrence key after that widening, which is the half it would be easy to lose", async () => {
    await withManualRefundTaskSchema(async (client) => {
      // The mutation this pins: widening the occurrence-key requirement to every
      // kind - the obvious way to write it - would refuse the legacy hand-back
      // rows, which carry their idempotency in their own writers and have never
      // minted a key.
      await insert(client, {
        id: "legacy-no-key-after-3213",
        kind: "CANCELLED_BOOKING_HAND_BACK",
        occurrenceKey: null,
      });

      const { rows } = await client.query(
        `SELECT "occurrenceKey" FROM "ManualRefundTask" WHERE "id" = 'legacy-no-key-after-3213'`,
      );
      expect(rows[0].occurrenceKey).toBeNull();
    });
  });

  it("still refuses a LEGACY-kind row with no amount after that relaxation, which is the half a widened constraint would have lost", async () => {
    await withManualRefundTaskSchema(async (client) => {
      // The mutation this pins: relaxing the constraint for the new kind by
      // dropping it, or by widening it to every kind, would exempt exactly the
      // rows 20260903010000 exists to refuse. Kept beside the acceptance above
      // so the two are read together.
      await expect(
        insert(client, {
          id: "legacy-unpriced-after-3213",
          kind: "AUTOMATIC_LATE_CAPTURE_RECORD",
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
