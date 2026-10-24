import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { decodeRawRows } from "@/lib/raw-sql-rows";

/**
 * #3640, #4104, #4312 (`INV-SSOT`): WHEN A NAMED MIGRATION FINISHED ON THIS
 * INSTALL - the one read of `_prisma_migrations`, which the refund ledger's
 * start (`payment-transactions.ts`), the failed-later card refund cutoff
 * (`card-refund-failed-later.ts`) and the bank-transfer card refund note
 * cutover (`card-refund-own-note-share.ts`) each date a fact of the install by.
 * A marker migration rolled back and applied again moves its fact to the new
 * finish; a squash that drops its name leaves none (`BLUE_GREEN_MIGRATION_POLICY.md`).
 *
 * Read raw because no Prisma model covers the table (`INV-OPS-001`: each row is
 * decoded, never cast). A database built with `prisma db push` (a dev
 * convenience) has no such table, and naming a missing table aborts the whole
 * transaction, so its presence is asked first: `history: false`. With the
 * table, the migration's first un-rolled-back finish, in whole seconds (Stripe
 * dates a refund in seconds), or null when it has not finished here - each
 * caller says what that means for it.
 */
export type MigrationFinishedAt = { history: false } | { history: true; finishedAtSeconds: number | null };

const HISTORY_PRESENT_ROW = z.object({ present: z.boolean() });
const FINISHED_AT_ROW = z.object({ finished_at: z.date() });

export async function readMigrationFinishedAt(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  migrationName: string,
): Promise<MigrationFinishedAt> {
  const presence = decodeRawRows(
    await db.$queryRaw`SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS "present"`,
    HISTORY_PRESENT_ROW,
    "migration history present",
  );
  if (!presence[0]?.present) return { history: false };
  const rows = await db.$queryRaw`
    SELECT "finished_at" FROM "_prisma_migrations"
    WHERE "migration_name" = ${migrationName}
      AND "finished_at" IS NOT NULL
      AND "rolled_back_at" IS NULL
    ORDER BY "finished_at" ASC
    LIMIT 1
  `;
  const [row] = decodeRawRows(rows, FINISHED_AT_ROW, `migration ${migrationName} finished`);
  return { history: true, finishedAtSeconds: row ? Math.floor(row.finished_at.getTime() / 1000) : null };
}
