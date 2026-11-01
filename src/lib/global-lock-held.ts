import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { decodeRawRows } from "@/lib/raw-sql-rows";

/**
 * Whether the current transaction holds the global booking/money key
 * (`pg_advisory_xact_lock(1)`, Tier 2, `INV-LOCK-001`). It takes no lock: a
 * writer whose correctness depends on the key being held by its caller asks
 * here and refuses to proceed without it, so the precondition is enforced
 * rather than documented. `pg_locks` shows a single-bigint advisory key `1` as
 * classid 0, objid 1, objsubid 1, granted to this backend.
 */
const HELD_ROW = z.object({ held: z.boolean() });

export class GlobalLockNotHeldError extends Error {
  constructor(readonly context: string) {
    super(`${context} requires the caller's transaction to hold pg_advisory_xact_lock(1) (INV-LOCK-001).`);
    this.name = "GlobalLockNotHeldError";
  }
}

export async function assertGlobalLockHeld(tx: Pick<Prisma.TransactionClient, "$queryRaw">, context: string): Promise<void> {
  const returned = await tx.$queryRaw`
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_locks
      WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
        AND classid = 0 AND objid = 1 AND objsubid = 1
    ) AS "held"
  `;
  const rows = decodeRawRows(returned, HELD_ROW, "global lock held");
  if (rows[0]?.held !== true) throw new GlobalLockNotHeldError(context);
}
