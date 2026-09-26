/**
 * Real-PostgreSQL proof of the one card-refund writer (#3640, `INV-PAY-104`).
 *
 * `recordStripeRefundsAgainstTransaction` ADDS a refund it newly recorded to the
 * transaction's `refundedAmountCents`, and two things a mock can only imitate
 * keep that addition exact under concurrency:
 *
 *  1. "Newly recorded" is answered by `createMany({ skipDuplicates: true })` -
 *     PostgreSQL's `INSERT ... ON CONFLICT DO NOTHING`. Two writers recording ONE
 *     refund at once (the inline refund and its own `charge.refunded` webhook)
 *     must see exactly one insert, so the refund is added once.
 *  2. The mirror write is a compare-and-set re-read on a miss. Two writers
 *     recording DIFFERENT refunds at once must lose neither increment: under
 *     READ COMMITTED the loser's guarded UPDATE re-checks its predicate against
 *     the winner's committed row, matches nothing, and retries from the new value.
 *
 *  3. A member's cancel settling its credit (`applyLocalRefundAllocation`) while
 *     a dashboard refund's webhook lands: the allocation's compare-and-set
 *     misses, re-reads, and succeeds against the fresh total instead of rolling
 *     the cancel back.
 *
 * None of the cases hopes for the interleaving. A third connection holds the
 * transaction ROW with `FOR NO KEY UPDATE` - which does not block the refund
 * insert's foreign-key check (`FOR KEY SHARE`) but does block an UPDATE - so
 * every writer reads the mirror, reaches its compare-and-set and queues there;
 * both are released only once both are queued, read from `pg_blocking_pids` on
 * a fourth connection (the method `edit-financial-review-races.realdb.test.ts`
 * uses). The loser's miss is therefore structural, not scheduling.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-3640-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3640-member";
const LODGE_ID = "race-3640-lodge";
const BOOKING_ID = "race-3640-booking";
const PAYMENT_ID = "race-3640-payment";
const TRANSACTION_ID = "race-3640-txn";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");

const PAID_CENTS = 40_000;
const CREDIT_CENTS = 10_000;

/** A barrier gives up with a named diagnostic before Vitest's timeout does. */
const LOCK_POLL_TIMEOUT_MS = 2_000;
const RACE_TEST_TIMEOUT_MS = 20_000;

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeCardRefundRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Card-refund race proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run card-refund race proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Card-refund race proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Card-refund race proof DB name must contain 'concurrency_race_1881'.");
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * When the ledger-writers migration finished on this database, in seconds - the
 * writer's own "pre-ledger" boundary. Read in `beforeAll`; the refunds below are
 * dated a minute after it, so the writer counts them.
 */
let ledgerStartSeconds = 0;

function stripeRefund(id: string, amount: number) {
  return {
    id,
    amount,
    currency: "nzd",
    status: "succeeded",
    reason: "requested_by_customer",
    created: ledgerStartSeconds + 60,
    charge: "ch_race_3640",
    payment_intent: "pi_race_3640",
  };
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let recordStripeRefundsAgainstTransaction: (typeof import("@/lib/payment-transactions"))["recordStripeRefundsAgainstTransaction"];
let applyLocalRefundAllocation: (typeof import("@/lib/payment-transactions"))["applyLocalRefundAllocation"];
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

(RUN ? describe : describe.skip)(
  "the card-refund writer adds each refund exactly once — real PostgreSQL (#3640, INV-PAY-104)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    async function deleteFixtures() {
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** Sessions queued behind `blockerPid`, directly or transitively. */
    async function blockedByHolder(blockerPid: number): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        WITH RECURSIVE waits AS (
          SELECT activity.pid AS waiter, blocker.pid AS blocker
          FROM pg_stat_activity AS activity
          CROSS JOIN LATERAL unnest(pg_blocking_pids(activity.pid)) AS blocker(pid)
          WHERE activity.datname = current_database()
            AND activity.pid <> pg_backend_pid()
        ),
        chain AS (
          SELECT waiter, blocker FROM waits
          UNION
          SELECT chain.waiter, waits.blocker
          FROM chain
          JOIN waits ON waits.waiter = chain.blocker
        )
        SELECT COUNT(DISTINCT waiter)::int AS "count"
        FROM chain
        WHERE blocker = ${blockerPid}::int
      `;
      return rows[0]?.count ?? 0;
    }

    /**
     * Run both writers while a third connection holds the transaction row, and
     * release it only once BOTH are queued behind it.
     */
    async function raceBehindRowLock(
      writers: [() => Promise<unknown>, () => Promise<unknown>],
      diagnostic: string,
    ): Promise<PromiseSettledResult<unknown>[]> {
      const lockHeld = deferred();
      const releaseLock = deferred();
      let holderPid = 0;
      let holderError: unknown;
      const holder = lockHolderClient
        .$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
            holderPid = rows[0]?.pid ?? 0;
            await tx.$executeRaw`SELECT id FROM "PaymentTransaction" WHERE id = ${TRANSACTION_ID} FOR NO KEY UPDATE`;
            lockHeld.resolve();
            await releaseLock.promise;
          },
          { maxWait: 5_000, timeout: 10_000 },
        )
        .catch((error: unknown) => {
          holderError = error;
          lockHeld.resolve();
        });
      await lockHeld.promise;
      if (holderError) {
        throw new Error(`The lock-holder connection could not hold the row: ${String(holderError)}`);
      }

      const pending = writers.map((write) => write());
      let seen = 0;
      try {
        const startedAt = process.hrtime.bigint();
        while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
          seen = await blockedByHolder(holderPid);
          if (seen >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        // Release and WAIT for the writers on every path, so a failed barrier
        // cannot leave them committing while the next test deletes fixtures.
        releaseLock.resolve();
      }
      const settled = await Promise.allSettled(pending);
      await holder;
      if (seen < 2) {
        throw new Error(`Timed out waiting for both writers to queue behind pid ${holderPid} — saw ${seen}. ${diagnostic}`);
      }
      return settled;
    }

    const write = (refundId: string, amount: number) => () =>
      recordStripeRefundsAgainstTransaction({
        paymentId: PAYMENT_ID,
        paymentTransactionId: TRANSACTION_ID,
        refunds: [stripeRefund(refundId, amount)],
        fallbackPaymentIntentId: "pi_race_3640",
        store: prisma,
      });

    async function mirrorCents(): Promise<number> {
      const row = await prisma.paymentTransaction.findUniqueOrThrow({
        where: { id: TRANSACTION_ID },
        select: { refundedAmountCents: true },
      });
      return row.refundedAmountCents;
    }

    beforeAll(async () => {
      assertSafeCardRefundRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ recordStripeRefundsAgainstTransaction, applyLocalRefundAllocation } = await import("@/lib/payment-transactions"));

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const createSeparateClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = createSeparateClient("race-3640-lock-holder");
      observerClient = createSeparateClient("race-3640-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);
      const startRows = await observerClient.$queryRaw<Array<{ finished_at: Date }>>`
        SELECT "finished_at" FROM "_prisma_migrations"
        WHERE "migration_name" = '20260509090000_enrich_payment_refund_ledger'
          AND "finished_at" IS NOT NULL
        LIMIT 1
      `;
      ledgerStartSeconds = Math.floor((startRows[0]?.finished_at ?? new Date(0)).getTime() / 1000);

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Refund",
          lastName: "Proof",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3640 Lodge", slug: "race-3640" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "PAID",
          totalPriceCents: PAID_CENTS,
          finalPriceCents: PAID_CENTS,
        },
      });
    });

    beforeEach(async () => {
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "STRIPE", status: "SUCCEEDED" },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: TRANSACTION_ID,
          paymentId: PAYMENT_ID,
          kind: "PRIMARY",
          source: "STRIPE",
          stripePaymentIntentId: "pi_race_3640",
          amountCents: PAID_CENTS,
          status: "SUCCEEDED",
        },
      });
      // A $100 account-credit settlement: no refund row, only the mirror.
      await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: CREDIT_CENTS, store: prisma });
      expect(await mirrorCents()).toBe(CREDIT_CENTS);
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
      await Promise.all([lockHolderClient?.$disconnect(), observerClient?.$disconnect()]);
    });

    it("two writers recording the SAME refund at once add it once", async () => {
      const settled = await raceBehindRowLock(
        [write("re_race_3640_same", 5_000), write("re_race_3640_same", 5_000)],
        "The second writer never queued: its insert of the same refund id did not wait on the first's uncommitted row.",
      );

      const results = settled.map((outcome) => {
        if (outcome.status === "rejected") throw outcome.reason;
        return outcome.value as { createdRefundsCount: number };
      });
      expect(results.map((result) => result.createdRefundsCount).sort()).toEqual([0, 1]);
      expect(await prisma.paymentRefund.count({ where: { stripeRefundId: "re_race_3640_same" } })).toBe(1);
      expect(await mirrorCents()).toBe(CREDIT_CENTS + 5_000);
    });

    it("two writers recording DIFFERENT refunds at once lose neither", async () => {
      const settled = await raceBehindRowLock(
        [write("re_race_3640_a", 5_000), write("re_race_3640_b", 3_000)],
        "Both writers should reach the mirror's compare-and-set and queue on the transaction row.",
      );

      for (const outcome of settled) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
      // $100 credit + $50 + $30. A stale absolute write would leave $130 or $150.
      expect(await mirrorCents()).toBe(CREDIT_CENTS + 5_000 + 3_000);
    });

    it("a member's credit settlement racing a dashboard refund's webhook keeps both, without refusing", async () => {
      const settled = await raceBehindRowLock(
        [
          () => applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 5_000, store: prisma }),
          write("re_race_3640_dashboard", 3_000),
        ],
        "The allocation and the webhook should both reach the mirror's compare-and-set and queue on the transaction row.",
      );

      for (const outcome of settled) {
        // The old single-shot guard threw RefundAllocationRacedError here and
        // rolled the member's cancel back.
        if (outcome.status === "rejected") throw outcome.reason;
      }
      expect(await mirrorCents()).toBe(CREDIT_CENTS + 5_000 + 3_000);
    });
  },
);
