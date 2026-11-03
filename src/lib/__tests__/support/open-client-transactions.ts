import type { PrismaClient } from "@prisma/client";

import { realElapsedMs } from "../helpers/clock";

const SETTLE_TIMEOUT_MS = 1_000;
const POLL_MS = 25;

type OpenTransaction = {
  pid: number;
  query: string;
  xact_start: Date;
  application_name: string;
};

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
 * Allow in-flight work to settle for at most one second (#4695). A provider
 * callback awaited inside a transaction keeps that transaction open throughout
 * the probe, so it still fails. Realdb files already take turns (#4367); do not
 * filter by process and hide a connection left behind by an earlier suite.
 * On timeout, report the backends as well as returning their count.
 *
 * `excludeApplicationName` leaves out one named client - a test's own second
 * connection that is meant to be mid-transaction at that moment.
 */
export async function openClientTransactionsElsewhere(
  client: Pick<PrismaClient, "$queryRaw">,
  options: { excludeApplicationName?: string } = {},
): Promise<number> {
  const excluded = options.excludeApplicationName ?? null;
  const startedAt = process.hrtime.bigint();
  for (;;) {
    const rows = await client.$queryRaw<OpenTransaction[]>`
      SELECT pid, query, xact_start, application_name FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND backend_type = 'client backend' AND xact_start IS NOT NULL
        AND (${excluded}::text IS NULL OR application_name <> ${excluded}::text)
    `;
    if (rows.length === 0) return 0;
    if (realElapsedMs(startedAt) >= SETTLE_TIMEOUT_MS) {
      console.error("Client transactions still open at the provider call (#4695)", rows);
      return rows.length;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
