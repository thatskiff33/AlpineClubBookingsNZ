/**
 * #5407: clear the global alert windows before every real-PostgreSQL test.
 *
 * `notifyXeroSyncError` holds its window as one `AlertCooldown` row for every
 * Xero error, and the test clock is frozen, so a claim one test leaves never
 * expires: it would suppress the next test's alert, in this file or any file
 * after it on the shared race database, and make a call count depend on order.
 * A per-key alert is owned by the suite that names its subject and cleaned
 * there; a global key no suite owns is cleared here, once, so a new suite is
 * covered without knowing about it.
 *
 * Registered by `vitest.setup.ts` beside the file lock, under the same
 * `RUN_CONCURRENCY_RACE_TESTS` switch every realdb suite runs under, and only
 * for realdb files with a race database configured. One connection per file,
 * opened on the first test and closed after the last; a database without the
 * table yet (a suite that builds its own schema) is left alone.
 */
import { Client } from "pg";
import { afterAll, beforeEach, expect } from "vitest";

import { XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY } from "../../xero-sync-error-alert-key";
import { assertSafeRaceDbUrl } from "./race-db-url";
import { isRealdbTestFile, type RealdbLockClient } from "./realdb-file-serialisation";

/** The `AlertCooldown` keys shared by every test, cleared before each one. */
export const REALDB_GLOBAL_ALERT_KEYS: readonly string[] = [XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY];

const QUERY_TIMEOUT_MS = 30_000;
const UNDEFINED_TABLE = "42P01";

export interface RealdbAlertWindowResetDeps {
  beforeEach: (fn: () => Promise<void>) => void;
  afterAll: (fn: () => Promise<void>) => void;
  testPath: () => string | undefined;
  raceDatabaseUrl: () => string;
  connect: (url: string) => RealdbLockClient;
}

const defaultDeps: RealdbAlertWindowResetDeps = {
  beforeEach: (fn) => beforeEach(fn),
  afterAll: (fn) => afterAll(fn),
  testPath: () => expect.getState().testPath,
  raceDatabaseUrl: () => process.env.CONCURRENCY_RACE_DATABASE_URL ?? "",
  connect: (connectionString) => new Client({ connectionString, query_timeout: QUERY_TIMEOUT_MS }),
};

export function resetRealdbGlobalAlertWindows(deps: RealdbAlertWindowResetDeps = defaultDeps): void {
  let client: RealdbLockClient | undefined;
  deps.beforeEach(async () => {
    const url = deps.raceDatabaseUrl();
    if (!isRealdbTestFile(deps.testPath()) || url === "") return;
    if (client === undefined) {
      assertSafeRaceDbUrl(url, "Realdb alert window reset");
      const opened = deps.connect(url);
      // A dropped backend fails the next query loudly; without a listener it
      // would crash the worker unnamed.
      opened.on("error", () => undefined);
      await opened.connect();
      client = opened;
    }
    try {
      await client.query('DELETE FROM "AlertCooldown" WHERE "key" = ANY($1)', [[...REALDB_GLOBAL_ALERT_KEYS]]);
    } catch (error) {
      if ((error as { code?: unknown }).code !== UNDEFINED_TABLE) throw error;
    }
  });
  deps.afterAll(async () => {
    const open = client;
    client = undefined;
    await open?.end();
  });
}
