import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { decodeRawRows } from "@/lib/raw-sql-rows";

/**
 * Serialize capacity and roster-eligibility mutations for one immutable lodge
 * id. Kept dependency-light so configuration import does not load the capacity
 * engine or club configuration during bootstrap imports.
 */
export async function acquireLodgeCapacityLock(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  lodgeId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lodgeId}, 0))`;
}

const LODGE_CAPACITY_TRY_LOCK_ROW = z.object({ acquired: z.boolean() });

/**
 * The same per-lodge key, without waiting.
 *
 * Member merge calls this for a lodge that appeared while a participant
 * attempt was rolled back. That transaction already holds its
 * member-lifecycle keys, so a blocking acquire would wait for a lodge key
 * after a member key. False means the caller refuses; it does not retry
 * the lock. A true result is re-entrant when this transaction already holds
 * the key.
 */
export async function tryAcquireLodgeCapacityLock(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  lodgeId: string,
): Promise<boolean> {
  const returned = await tx.$queryRaw`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${lodgeId}, 0)) AS "acquired"
  `;
  const [result] = decodeRawRows(
    returned,
    LODGE_CAPACITY_TRY_LOCK_ROW,
    "lodge capacity try-lock",
  );
  return result?.acquired === true;
}
