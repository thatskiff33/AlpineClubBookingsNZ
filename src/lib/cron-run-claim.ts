import "server-only";
import { Client } from "pg";
import { z } from "zod";
import { resolvePoolAcquisitionTimeoutMillis } from "@/lib/prisma-adapter";
import { decodeRawRows } from "@/lib/raw-sql-rows";

const CLAIM_ROW = z.object({ claimed: z.boolean() });

/**
 * One dedicated, autocommit PostgreSQL session owns this whole-cycle claim.
 * Never borrow a pooled connection: session locks survive returning it to a pool.
 * No transaction is open during work. A dead process's connection closes and
 * PostgreSQL releases the claim; there is no expiring lease to overlap a live run.
 */
export async function withCronRunClaim<T>(
  jobName: string,
  work: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<{ claimed: false } | { claimed: true; result: T }> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for a cron run claim.");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: resolvePoolAcquisitionTimeoutMillis(connectionString),
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
  });
  let lost = false;
  client.on("error", () => { lost = true; });
  client.on("end", () => { lost = true; });
  try {
    await client.connect();
    // INV-LOCK-001/002/003: outer run coordination only, not a domain lock.
    const response = await client.query(
      "SELECT pg_try_advisory_lock(hashtext('cron-run-claim'), hashtext($1)) AS claimed",
      [jobName],
    );
    const [row] = decodeRawRows(response.rows, CLAIM_ROW, "cron run claim");
    if (!row?.claimed) return { claimed: false };
    const assertOwned = async () => {
      if (lost) throw new Error("The sync run claim connection was lost; retry the sync.");
      // A liveness probe between tasks fails closed on a broken connection.
      await client.query("SELECT 1");
      if (lost) throw new Error("The sync run claim connection was lost; retry the sync.");
    };
    const result = await work(assertOwned);
    await assertOwned();
    return { claimed: true, result };
  } finally {
    // Closing this dedicated session releases its claim even when work throws.
    await client.end();
  }
}
