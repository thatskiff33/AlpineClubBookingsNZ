import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * REAL cross-connection contention proof for the per-lodge capacity lock (#172,
 * H1 from the PR #1911 adversarial review).
 *
 * Mock-level route tests can only assert that `acquireLodgeCapacityLock` is
 * *called*; they cannot prove that two genuine Postgres connections actually
 * serialise on the same advisory key. This suite does exactly that, against a
 * reachable database.
 *
 * It replicates the exact SQL both call sites emit:
 *   - the admission path (`acquireLodgeCapacityLock`, src/lib/capacity.ts) and
 *   - the exclusive-hold / hold-set path (same helper, exclusive-hold/route.ts)
 * both run `SELECT pg_advisory_xact_lock(hashtextextended($lodgeId, 0))`, so a
 * confirm-pending-guests admission and a hold-set for the *same* lodge must
 * mutually exclude. The legacy club-wide `pg_advisory_xact_lock(1)` this route
 * used to take is a disjoint key and never excluded either — which is the bug.
 *
 * Gated on CONTENTION_TEST_DATABASE_URL so the dummy-DATABASE_URL unit gate
 * skips it cleanly; run it locally against the dev Postgres:
 *   CONTENTION_TEST_DATABASE_URL="postgresql://tac:tacdev@localhost:5433/tacbookings" \
 *     pnpm exec vitest run src/lib/__tests__/lodge-capacity-lock.integration.test.ts
 *
 * Uses advisory locks only — creates and mutates no rows — and disconnects both
 * connections cleanly.
 */

const CONTENTION_DB_URL = process.env.CONTENTION_TEST_DATABASE_URL;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A lodgeId that never collides with a concurrent run. The lock key is derived
// from it via hashtextextended, exactly as the real helper does.
const LODGE_ID = `lodge-contention-${process.pid}-${Date.now()}`;

// The two call sites' shared key expression. Passing the lodgeId as a bind
// parameter and letting Postgres compute hashtextextended on each connection
// proves the keys collide for the same lodgeId (not merely that we reused a
// literal number).
const PER_LODGE_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";
const PER_LODGE_TRY_LOCK =
  "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got";
const LEGACY_LOCK = "SELECT pg_advisory_xact_lock(1)";
const LEGACY_TRY_LOCK = "SELECT pg_try_advisory_xact_lock(1) AS got";

describe.skipIf(!CONTENTION_DB_URL)(
  "per-lodge capacity lock cross-connection contention (#172)",
  () => {
    let connA: Client;
    let connB: Client;

    beforeAll(async () => {
      connA = new Client({ connectionString: CONTENTION_DB_URL });
      connB = new Client({ connectionString: CONTENTION_DB_URL });
      await connA.connect();
      await connB.connect();
    });

    afterAll(async () => {
      // Best-effort unwind of any open transaction, then disconnect cleanly.
      await connA?.query("ROLLBACK").catch(() => {});
      await connB?.query("ROLLBACK").catch(() => {});
      await connA?.end().catch(() => {});
      await connB?.end().catch(() => {});
    });

    it("(a) same lodgeId key collides: B's acquisition BLOCKS until A commits", async () => {
      // Connection A takes the per-lodge lock in an open transaction, standing
      // in for a hold-set (exclusive-hold route).
      await connA.query("BEGIN");
      await connA.query(PER_LODGE_LOCK, [LODGE_ID]);

      // Connection B — standing in for a confirm-pending-guests admission —
      // requests the identical key with the blocking variant. It must NOT
      // resolve while A still holds the lock.
      await connB.query("BEGIN");
      let bAcquired = false;
      const bAcquisition = connB
        .query(PER_LODGE_LOCK, [LODGE_ID])
        .then(() => {
          bAcquired = true;
        });

      await delay(500);
      expect(bAcquired).toBe(false);

      // Releasing A (commit ends its transaction-scoped lock) must unblock B —
      // and nothing else could, since A is the only holder.
      await connA.query("COMMIT");
      await bAcquisition;
      expect(bAcquired).toBe(true);

      // Release B's now-held lock so the connection is clean for teardown.
      await connB.query("COMMIT");
    });

    it("(b) legacy pg_advisory_xact_lock(1) does NOT block the per-lodge key", async () => {
      // Connection A holds the LEGACY club-wide key — the key confirm-pending
      // -guests used to take before #172.
      await connA.query("BEGIN");
      await connA.query(LEGACY_LOCK);

      await connB.query("BEGIN");

      // The per-lodge key is disjoint from key 1, so B acquires it immediately
      // (try-lock returns true with no wait) — documenting precisely why the
      // old code failed to serialise a hold-set against this admission path.
      const perLodge = await connB.query(PER_LODGE_TRY_LOCK, [LODGE_ID]);
      expect(perLodge.rows[0].got).toBe(true);

      // Control: the legacy key IS genuinely contended right now — so try-lock
      // does detect a real same-key collision, ruling out a false positive
      // above. B cannot take key 1 while A holds it.
      const legacy = await connB.query(LEGACY_TRY_LOCK);
      expect(legacy.rows[0].got).toBe(false);

      await connB.query("ROLLBACK");
      await connA.query("ROLLBACK");
    });
  }
);
