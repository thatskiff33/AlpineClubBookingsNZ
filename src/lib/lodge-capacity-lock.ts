import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { decodeRawRows } from "@/lib/raw-sql-rows";

const LODGE_CAPACITY_HELD_ROW = z.object({ held: z.boolean() });

export class LodgeCapacityLockNotHeldError extends Error {
  constructor(readonly lodgeId: string, readonly context: string) {
    super(`${context} requires the caller's transaction to hold its lodge capacity key (INV-LOCK-002).`);
    this.name = "LodgeCapacityLockNotHeldError";
  }
}

/** Inspect the bigint key's unsigned high/low halves; never acquire a lock. */
export async function assertLodgeCapacityLockHeld(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  lodgeId: string,
  context: string,
): Promise<void> {
  const returned = await tx.$queryRaw`
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_locks, (SELECT hashtextextended(${lodgeId}, 0) AS key) AS lodge
      WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
        AND mode = 'ExclusiveLock'
        AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
        AND classid = ((lodge.key >> 32) & 4294967295)::oid
        AND objid = (lodge.key & 4294967295)::oid AND objsubid = 1
    ) AS "held"
  `;
  const rows = decodeRawRows(returned, LODGE_CAPACITY_HELD_ROW, "lodge capacity lock held");
  if (rows[0]?.held !== true) throw new LodgeCapacityLockNotHeldError(lodgeId, context);
}

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
