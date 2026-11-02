import type { PrismaClient } from "@prisma/client";

/**
 * How many transactions are open on OTHER client connections to this database:
 * the probe a real-database proof uses to show a provider call ran outside every
 * transaction (#3954, #4652). A transaction the code under test left open around
 * a Stripe call shows here.
 *
 * Client backends only. PostgreSQL's own workers list themselves in
 * `pg_stat_activity` under the database they work on, and an autovacuum or
 * autoanalyze worker holds a transaction while it runs. A heavy suite triggers
 * them at moments it cannot predict, so counting them made the probe report a
 * transaction the app never opened (#4669 CI). Every connection the app or a
 * test opens is a client backend, so narrowing to them drops nothing the probe
 * exists to catch.
 *
 * `excludeApplicationName` leaves out one named client - a test's own second
 * connection that is meant to be mid-transaction at that moment.
 */
export async function openClientTransactionsElsewhere(
  client: Pick<PrismaClient, "$queryRaw">,
  options: { excludeApplicationName?: string } = {},
): Promise<number> {
  const excluded = options.excludeApplicationName ?? null;
  const rows = await client.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND backend_type = 'client backend' AND xact_start IS NOT NULL
      AND (${excluded}::text IS NULL OR application_name <> ${excluded}::text)
  `;
  return rows[0]?.count ?? 0;
}
