/**
 * Real-PostgreSQL PROOF for the AI Diagnostics read-only seam (AID-7b, #2786).
 *
 * WHY THIS EXISTS, and why the unit suite is not enough. The seam's whole premise
 * is that a `server_owned` entry's read-only-ness must be **a property of the
 * server** rather than a property of the code: those entries run on the
 * application's own full-privilege Prisma connection, where the SELECT-only role's
 * grants are not the boundary and nothing but `SET TRANSACTION READ ONLY` stands
 * between an evidence source and a write.
 *
 * `tools/__tests__/read-only-transaction.test.ts` mocks `@/lib/prisma` down to a
 * bare `$transaction`, so the strongest thing it can say is *"the string
 * `SET TRANSACTION READ ONLY` was handed to a doubled `$executeRaw` first"*. That
 * proves we ASKED. It cannot prove PostgreSQL AGREED — and the composition being
 * relied on here (a Prisma interactive transaction, an `isolationLevel`, and two
 * utility statements sent through the extended query protocol) is exactly the kind
 * of thing this repository has been burned by before: `registry.ts` records that
 * "the real-PostgreSQL proof caught a string assertion that looked right and was
 * not."
 *
 * The asymmetry was the argument for writing it. The `select_only_sql` path — the
 * LESS dangerous one, because PostgreSQL's own role privileges already bound it —
 * has had a real-database privilege proof since AID-5
 * (`ai-diagnostics-select-only-role.realdb.test.ts`). The `server_owned` path had
 * none.
 *
 * FIVE THINGS ARE ESTABLISHED AGAINST A REAL SERVER:
 *   1. the transaction really is READ ONLY inside the callback;
 *   2. it really is REPEATABLE READ, which is what makes the reads share one
 *      snapshot — the property an earlier revision of the docblock claimed while
 *      passing no isolation level at all;
 *   3. `statement_timeout` really took, at the value the one shared bound derives;
 *   4. an actual INSERT inside the seam is refused with SQLSTATE `25006`, on a
 *      connection whose privileges would otherwise permit it;
 *   5. the timeout is RELEASED at commit rather than leaking onto the pooled
 *      application connection — `set_config(..., is_local => true)` is what makes
 *      that true, and a `false` there would poison every later query on that
 *      connection while every unit test stayed green.
 *
 * SAFETY ENVELOPE, identical to the sibling harnesses. OFF by default and a no-op
 * in ordinary `pnpm test`:
 *   - runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`; otherwise `describe.skip`, so
 *     it never imports Prisma and never connects to anything;
 *   - reads ONLY `CONCURRENCY_RACE_DATABASE_URL`, and `assertSafeDiagnosticsRaceDbUrl`
 *     requires a loopback host, port 55442+, and the dedicated
 *     `concurrency_race_1881` database marker;
 *   - hosted CI reaches it because `concurrency-lock-races.realdb.test.ts` imports
 *     this file. TWO SEPARATE PINS hold that chain, and it is worth being exact
 *     about which covers what: `review-findings-contracts.test.ts` pins the
 *     WORKFLOW STEP that runs the concurrency harness (so the harness always runs
 *     in CI), and `ai-diagnostics-usage.test.ts` pins the IMPORT EDGE — that the
 *     harness still contains `import "./ai-diagnostics-readonly-seam.realdb.test";`
 *     (so deleting that line, which would silently unplug THIS proof while every
 *     suite stayed green, fails a test). The import-edge pin is the AID-8 F2
 *     addition; before it, only the step was pinned and the edge was not.
 *
 * It writes nothing that survives: the only write it attempts is the one it expects
 * PostgreSQL to REFUSE, and the probe table is created and dropped by this file.
 *
 * To run it directly against a throwaway Docker Postgres:
 *   docker run -d --name aid7b-pg -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=concurrency_race_1881 \
 *     -p 127.0.0.1:55442:5432 postgres:16-alpine
 *
 * It needs no migrations deployed, unlike its siblings: it creates and drops the one
 * table it writes to, and every other statement asks the SERVER about itself.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881 \
 *     pnpm exec vitest run src/lib/__tests__/ai-diagnostics-readonly-seam.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

/**
 * Guard: never run against a default/production Postgres. Require the dedicated env
 * URL, loopback, an unusual high port, and the shared race-harness database marker.
 *
 * RE-DECLARED RATHER THAN IMPORTED, which is this harness family's own convention
 * and not laziness: `ai-diagnostics-budget-race.realdb.test.ts` says in as many words
 * that it re-declares it "so this file can be run standalone without importing (and
 * re-registering) that whole harness". Importing the guard from there was the first
 * attempt here and proved the point immediately — it dragged that suite's `beforeAll`
 * into this file's run, so this suite could not start without every migration
 * deployed, for reasons that had nothing to do with what it proves.
 */
function assertSafeDiagnosticsRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "The read-only seam proof needs a valid CONCURRENCY_RACE_DATABASE_URL.",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run the read-only seam proof against port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+ (never the default 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("The read-only seam proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error(
      "The read-only seam proof DB name must contain the dedicated marker 'concurrency_race_1881'.",
    );
  }
}

/** A table this file owns outright, so the refused write targets something real. */
const PROBE_TABLE = "aid7b_seam_write_probe";

let prisma: PrismaClient;
let withBoundedReadOnlyTransaction: typeof import("@/lib/diagnostics/tools/read-only-transaction")["withBoundedReadOnlyTransaction"];
let statementTimeoutMs: number;

(RUN ? describe : describe.skip)(
  "the read-only seam, against a real PostgreSQL (#2786)",
  () => {
    beforeAll(async () => {
      // Guard the dedicated URL BEFORE importing Prisma, then point the app
      // singleton at it — the same order the sibling harnesses use, so a skipped
      // run is a true no-op rather than a connection nobody noticed.
      assertSafeDiagnosticsRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ withBoundedReadOnlyTransaction } = await import(
        "@/lib/diagnostics/tools/read-only-transaction"
      ));
      ({ statementTimeoutMs } = (
        await import("@/lib/diagnostics/tools/types")
      ).DIAGNOSTICS_TOOL_BOUNDS);

      // The write target. Created OUTSIDE the seam, on the same full-privilege
      // connection, which is the point: the refusal below is the transaction's
      // doing and not a missing grant.
      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (id integer PRIMARY KEY)`,
      );
    }, 60_000);

    afterAll(async () => {
      if (typeof prisma === "undefined") return;
      await prisma
        .$executeRawUnsafe(`DROP TABLE IF EXISTS ${PROBE_TABLE}`)
        .catch(() => {});
      await prisma.$disconnect().catch(() => {});
    });

    it("really is READ ONLY and REPEATABLE READ inside the callback", async () => {
      const [settings] = await withBoundedReadOnlyTransaction((tx) =>
        tx.$queryRaw<
          { read_only: string; isolation: string }[]
        >`SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation`,
      );

      // Not "we sent the statement" — what the server says about itself, inside
      // the transaction the evidence sources actually read in.
      expect(settings.read_only).toBe("on");
      // REPEATABLE READ is what makes the reads share ONE snapshot. An earlier
      // revision of the seam's docblock claimed the snapshot property while
      // passing no isolation level, which meant READ COMMITTED and a fresh
      // snapshot per statement. Only the server can settle which one is in force.
      expect(settings.isolation).toBe("repeatable read");
    });

    it("really applied the statement timeout, at the one shared bound", async () => {
      const [settings] = await withBoundedReadOnlyTransaction((tx) =>
        tx.$queryRaw<
          { statement_timeout: string }[]
        >`SELECT current_setting('statement_timeout') AS statement_timeout`,
      );

      // PostgreSQL normalises the milliseconds it was handed, so compare in
      // milliseconds rather than pinning whatever string form it chose ('5s').
      //
      // THIS ALSO COVERS #2804. The wait for a connection went 2 s -> 20 s and the
      // statement timeout deliberately did not move; because this compares against
      // the derived bound rather than a literal, raising the statement timeout by
      // mistake fails here against the real server. An earlier draft added a second
      // near-identical test to "prove" that separately — it proved nothing this one
      // did not, and the literal 5_000 is pinned in the unit ladder test where the
      // other decided numbers live.
      const applied = settings.statement_timeout;
      const appliedMs = applied.endsWith("ms")
        ? Number.parseInt(applied, 10)
        : applied.endsWith("s")
          ? Number.parseFloat(applied) * 1_000
          : Number.parseInt(applied, 10);
      expect(appliedMs).toBe(statementTimeoutMs);
    });

    it("REFUSES a write with SQLSTATE 25006, on a connection that could otherwise do it", async () => {
      // The proof the whole seam exists for. This connection created the table in
      // `beforeAll` and can insert into it freely; inside the seam PostgreSQL
      // itself refuses, so a `server_owned` source that drifts onto a write path
      // fails at the database rather than in review.
      // The SQLSTATE arrives as `meta.cause.originalCode` through the driver
      // adapter, not as a top-level `code`. Asserting the message alone would be
      // the weaker test — it is prose PostgreSQL is free to reword — so this pins
      // the state code and keeps the message as corroboration.
      const refusal = await withBoundedReadOnlyTransaction((tx) =>
        tx.$executeRawUnsafe(`INSERT INTO ${PROBE_TABLE} (id) VALUES (1)`),
      ).then(
        () => null,
        (error: unknown) => error,
      );

      expect(refusal, "the seam ALLOWED a write").not.toBeNull();
      expect(JSON.stringify(refusal)).toContain("25006");
      expect(String((refusal as { message?: string })?.message ?? refusal)).toMatch(
        /read-only transaction/i,
      );

      // And nothing was written, which is the operator-facing half of the claim.
      const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM ${PROBE_TABLE}`,
      );
      expect(Number(count)).toBe(0);
    });

    it("RELEASES the timeout at commit rather than leaking it onto the pooled connection", async () => {
      await withBoundedReadOnlyTransaction((tx) => tx.$queryRaw`SELECT 1`);

      // `set_config(..., is_local => true)` is what makes this true. Passing
      // `false` would poison every later query on this pooled application
      // connection with a 5s cancellation — a production incident that no unit
      // test in the tree would have failed on, because the double cannot tell a
      // transaction-scoped setting from a session-scoped one.
      const [settings] = await prisma.$queryRaw<
        { statement_timeout: string }[]
      >`SELECT current_setting('statement_timeout') AS statement_timeout`;
      expect(settings.statement_timeout).toBe("0");
    });
  },
);
