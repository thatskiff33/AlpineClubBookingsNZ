/**
 * Real-PostgreSQL proof for the deploy guard's migration lock timeout (#3377).
 *
 * ## What it is proving, and why a mock could not
 *
 * Eighty rows of `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` end their lock-impact
 * plan with some form of "let the deploy guard stop on lock timeout". Until
 * #3377 that named a control nothing implemented: no `lock_timeout` was set at
 * any level, so it resolved to `0` — wait forever. The fix puts the bound on the
 * `migrate` service's `DATABASE_URL` in `docker-compose.yml` as a libpq
 * `options` startup parameter, which is the only place that reaches every path
 * that runs a migration.
 *
 * Every claim in that sentence is a claim about software this repository does
 * not own: that PostgreSQL accepts the parameter at connect time, that it
 * cancels a *waiting* lock request at the bound rather than a running one, that
 * it raises SQLSTATE `55P03` doing so, and — the one most likely to break
 * silently on an upgrade — that **Prisma's schema engine threads the `options`
 * parameter through instead of dropping it with the connector arguments it
 * understands**. A fake can prove we asked. Only a real server proves it agreed.
 *
 * ## The chain, and which link each test pins
 *
 *   1. the shipped `migrate` service — whose `command` IS `prisma migrate
 *      deploy` — carries the option on its URL, with a sane bound;   (no DB)
 *   2. a connection opened with exactly that option really reports the bound;
 *   3. a blocked `ALTER TABLE` on it is cancelled at the bound with `55P03`;
 *   4. the control: WITHOUT the option the same blocked `ALTER TABLE` waits for
 *      the blocker and then succeeds, so (3) proves the option and not a
 *      coincidence of timing;
 *   5. Prisma's own schema engine — the binary `prisma migrate deploy` is — is
 *      cancelled the same way when it runs DDL against a locked table.
 *
 * The bound is read out of `docker-compose.yml` rather than restated here. A
 * test that declared its own 5000 would keep passing after someone deleted the
 * option from the file it is supposed to be pinning.
 *
 * ## What this suite does NOT prove, stated rather than implied
 *
 * It does not run `prisma migrate deploy` itself. Doing that needs a pending
 * migration against a database at a known revision, and a throwaway migration
 * directory needs its own Prisma config file, which Prisma 7 resolves relative
 * to itself — enough moving parts to be its own source of red. Test 5 runs
 * `prisma db execute`, which is the same schema-engine binary, the same
 * connection-string parser and the same DDL path, one CLI verb away. The
 * `migrate deploy` case was measured by hand when the guard was built and
 * recorded in `docs/CONCURRENCY_AND_LOCKING.md`: Prisma `P3018`, SQLSTATE
 * `55P03`, `applied_steps_count = 0`, recovered with
 * `prisma migrate resolve --rolled-back`.
 *
 * ## Safety envelope — the same as its sibling harnesses
 *
 * OFF by default and a no-op in ordinary `npm test`:
 *   - the proof describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`;
 *   - it reads ONLY `CONCURRENCY_RACE_DATABASE_URL` and requires a loopback
 *     host, port 55442+, and the dedicated `concurrency_race_1881` marker;
 *   - hosted CI reaches it because `concurrency-lock-races.realdb.test.ts`
 *     imports this file, and `blue-green-ledger-named-controls.test.ts` fails if
 *     that import goes missing, so the proof cannot be silently unplugged.
 *
 * To run it directly against a throwaway Docker Postgres:
 *   docker run -d --name lt3377-pg -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=concurrency_race_1881 \
 *     -p 127.0.0.1:55442:5432 postgres:16-alpine
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881 \
 *     npx vitest run src/lib/__tests__/migration-lock-timeout.realdb.test.ts
 *
 * It needs no migrations deployed: it owns its own scratch table.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realElapsedMs } from "./helpers/clock";
import {
  MIGRATION_LOCK_TIMEOUT_CEILING_MS,
  readMigrateServiceLockTimeout,
} from "./helpers/migration-lock-timeout-config";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

/** This suite's own table, so it never touches a migrated one. */
const PROBE_TABLE = "migration_lock_timeout_probe_3377";

/** PostgreSQL raises a `lock_timeout` cancellation as `lock_not_available`. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Guard: never run against a default/production Postgres. The same envelope as
 * `assertSafeRaceDbUrl` in `concurrency-lock-races.realdb.test.ts`, re-declared
 * here so this file can be run standalone without importing (and
 * re-registering) that whole harness.
 */
export function assertSafeMigrationLockTimeoutDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Migration lock-timeout proof needs a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run the migration lock-timeout proof against port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+ (never the default 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Migration lock-timeout proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "Migration lock-timeout proof DB name must contain the dedicated marker 'concurrency_race_1881'.",
    );
  }
}

describe("migration lock-timeout proof DB safety guard (#3377)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeMigrationLockTimeoutDbUrl(
        "postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881",
      ),
    ).not.toThrow();
  });

  it.each([
    "postgresql://user:pass@db.example.org:55442/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://user:pass@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeMigrationLockTimeoutDbUrl(url)).toThrow();
  });
});

/**
 * Link 1 of the chain. No database, so it runs in ordinary `npm test` and is the
 * check that fails first when someone edits the option off the service.
 */
describe("the migrate service carries the deploy guard's lock timeout (#3377)", () => {
  const wiring = readMigrateServiceLockTimeout();

  it("sets lock_timeout on the service whose command is `prisma migrate deploy`", () => {
    expect(
      wiring.serviceRunsMigrateDeploy,
      "the `migrate` service in docker-compose.yml no longer runs `prisma migrate deploy`, so the lock timeout may no longer be where migrations run",
    ).toBe(true);
    expect(
      wiring.optionsParameter,
      "docker-compose.yml no longer sets `options=-c lock_timeout=...` on the migrate service's DATABASE_URL: every migration would wait forever again (#3377)",
    ).toContain("lock_timeout");
  });

  it("keeps the default bound inside the measured window", () => {
    // Above zero because PostgreSQL reads 0 as "wait forever", not as "unset" —
    // the failure mode that makes this the easiest guard in the repository to
    // disable by accident.
    expect(wiring.defaultMs).toBeGreaterThan(0);
    // Strictly under the web slots' `pool_timeout=10` (seconds): past that, a
    // reader blocked behind the migration has already exhausted its pool and is
    // being refused with Prisma P2024, so the guard could not fire in time to
    // prevent anything it exists to prevent.
    expect(wiring.defaultMs).toBeLessThan(MIGRATION_LOCK_TIMEOUT_CEILING_MS);
  });
});

(RUN ? describe : describe.skip)(
  "migration lock timeout — real PostgreSQL proof (#3377)",
  () => {
    type PgClient = import("pg").Client;

    let PgClientCtor: typeof import("pg").Client;
    let admin: PgClient;
    let boundMs: number;
    /** The race URL with the SHIPPED option string appended. */
    let guardedUrl: string;

    beforeAll(async () => {
      assertSafeMigrationLockTimeoutDbUrl(RACE_DB_URL);
      ({ Client: PgClientCtor } = await import("pg"));

      const wiring = readMigrateServiceLockTimeout();
      boundMs = wiring.defaultMs;
      const url = new URL(RACE_DB_URL);
      // `optionsParameter` is the decoded `-c lock_timeout=NNNN` the shipped
      // compose URL carries. Assigning through `searchParams` re-encodes it, so
      // the probe connects with the same bytes the migrate container gets.
      url.searchParams.set("options", wiring.optionsParameter);
      guardedUrl = url.toString();

      admin = new PgClientCtor({ connectionString: RACE_DB_URL });
      await admin.connect();
      await admin.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
      await admin.query(`CREATE TABLE ${PROBE_TABLE} (id integer PRIMARY KEY)`);
    }, 60_000);

    afterAll(async () => {
      if (admin) {
        await admin.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`).catch(() => {});
        await admin.end().catch(() => {});
      }
    }, 60_000);

    /**
     * Hold a lock on the probe table that conflicts with ACCESS EXCLUSIVE, the
     * way a draining colour's in-flight read does. Returns a release function;
     * the transaction is held open until it is called, so nothing here depends
     * on `pg_sleep` racing the probe.
     */
    async function holdConflictingLock(): Promise<() => Promise<void>> {
      const blocker = new PgClientCtor({ connectionString: RACE_DB_URL });
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE ${PROBE_TABLE} IN ACCESS SHARE MODE`);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end().catch(() => {});
      };
    }

    /** Run one statement on a fresh connection and report the SQLSTATE, or null. */
    async function runOn(
      connectionString: string,
      sql: string,
    ): Promise<{ code: string | null; elapsedMs: number }> {
      const client = new PgClientCtor({ connectionString });
      const started = process.hrtime.bigint();
      try {
        await client.connect();
        await client.query(sql);
        return { code: null, elapsedMs: realElapsedMs(started) };
      } catch (err) {
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
        return { code: code || "unknown", elapsedMs: realElapsedMs(started) };
      } finally {
        await client.end().catch(() => {});
      }
    }

    it("reports the shipped bound on a connection opened with the shipped option", async () => {
      const client = new PgClientCtor({ connectionString: guardedUrl });
      await client.connect();
      try {
        const result = await client.query<{ v: string }>(
          "SELECT current_setting('lock_timeout') AS v",
        );
        // PostgreSQL formats the setting with a unit it chooses, so compare in
        // milliseconds rather than against a string.
        const raw = result.rows[0]?.v ?? "";
        const asMs = /^(\d+)s$/.test(raw)
          ? Number(raw.replace("s", "")) * 1000
          : Number(raw.replace("ms", ""));
        expect(asMs).toBe(boundMs);
      } finally {
        await client.end().catch(() => {});
      }
    }, 60_000);

    it("cancels a blocked ALTER TABLE at the bound with 55P03, rather than waiting for the blocker", async () => {
      const release = await holdConflictingLock();
      try {
        const outcome = await runOn(
          guardedUrl,
          `ALTER TABLE ${PROBE_TABLE} ADD COLUMN guarded_probe text`,
        );
        expect(outcome.code).toBe(LOCK_NOT_AVAILABLE);
        // It stopped at the bound and not merely "eventually": the blocker is
        // still held at this point, so anything that returned did so because it
        // was cancelled. The upper margin catches a bound silently multiplied by
        // a unit mistake (5000 read as seconds would land near 5,000,000 ms).
        expect(outcome.elapsedMs).toBeGreaterThanOrEqual(boundMs * 0.5);
        expect(outcome.elapsedMs).toBeLessThan(boundMs + 15_000);
      } finally {
        await release();
      }
    }, 120_000);

    it("control: without the option the same blocked ALTER TABLE waits for the blocker and succeeds", async () => {
      const release = await holdConflictingLock();
      const releaseAfterMs = boundMs + 1_500;
      const timer = setTimeout(() => {
        void release();
      }, releaseAfterMs);
      try {
        const outcome = await runOn(
          RACE_DB_URL,
          `ALTER TABLE ${PROBE_TABLE} ADD COLUMN unguarded_probe text`,
        );
        // Succeeded, having waited PAST the bound the guarded run stopped at.
        // Without this the test above could be passing off some unrelated
        // refusal, or off an ALTER that was never actually blocked.
        expect(outcome.code).toBeNull();
        expect(outcome.elapsedMs).toBeGreaterThan(boundMs);
      } finally {
        clearTimeout(timer);
        await release();
        await admin
          .query(`ALTER TABLE ${PROBE_TABLE} DROP COLUMN IF EXISTS unguarded_probe`)
          .catch(() => {});
      }
    }, 120_000);

    it("Prisma's schema engine threads the option: its DDL is cancelled too", async () => {
      // The link that would break silently on a Prisma upgrade. `db execute` is
      // the same engine binary, connection-string parser and DDL path as
      // `migrate deploy`; see the header for what that does and does not settle.
      const release = await holdConflictingLock();
      try {
        const started = process.hrtime.bigint();
        const result = spawnSync(
          process.execPath,
          [path.join("node_modules", "prisma", "build", "index.js"), "db", "execute", "--stdin"],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            input: `ALTER TABLE ${PROBE_TABLE} ADD COLUMN engine_probe text;`,
            env: { ...process.env, DATABASE_URL: guardedUrl },
            timeout: 120_000,
          },
        );
        const elapsedMs = realElapsedMs(started);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        expect(
          result.status,
          `expected the schema engine to be cancelled, got exit ${result.status}: ${output}`,
        ).not.toBe(0);
        expect(output).toContain("lock timeout");
        // CLI start-up is a second or so on top of the wait, so only the upper
        // margin is asserted: the point is that it did not sit there until the
        // blocker let go, which the control above shows is what happens without
        // the option.
        expect(elapsedMs).toBeLessThan(boundMs + 30_000);
      } finally {
        await release();
      }
    }, 180_000);
  },
);
