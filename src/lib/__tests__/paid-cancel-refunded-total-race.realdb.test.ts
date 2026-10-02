/**
 * Real-PostgreSQL proof that a paid cancel tiers its refund off the refunded
 * total read UNDER the `Payment` row lock (#3793).
 *
 * The claim reads the booking with its payment under `lock(1)`, but the
 * card-refund writer (`charge.refunded`, a dashboard refund) takes no advisory
 * lock - only the `Payment` row (`lockPaymentForRefundedTotal`). So a refund
 * can commit after the claim's first read. Before #3793 the claim tiered off
 * that read and refunded the dashboard's money again at the tier.
 *
 * The interleaving is forced, not hoped for. A second connection holds the
 * `Payment` row; the REAL `cancelBooking` starts, reads the payment (nothing
 * refunded) and queues on that row, read from `pg_blocking_pids` on a third
 * connection; only then does the holder record a $100 dashboard refund through
 * the REAL writer and commit. $200 paid, one 50% tier, account credit: the
 * cancel must credit 50% of the $100 still refundable, $50 - never 50% of $200.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-3793-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3793-member";
const LODGE_ID = "race-3793-lodge";
const BOOKING_ID = "race-3793-booking";
const PAYMENT_ID = "race-3793-payment";
const TRANSACTION_ID = "race-3793-txn";
// A stay well after today; the lodge's one tier applies however far ahead.
const CHECK_IN = new Date("2027-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

const PAID_CENTS = 20_000;
const DASHBOARD_REFUND_CENTS = 10_000;

const LOCK_POLL_TIMEOUT_MS = 10_000;

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafePaidCancelRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Paid-cancel race proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run paid-cancel race proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Paid-cancel race proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Paid-cancel race proof DB name must contain 'concurrency_race_1881'.");
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let payments: typeof import("@/lib/payment-transactions");
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;
let ledgerStartSeconds = 0;

(RUN ? describe : describe.skip)(
  "a paid cancel tiers its refund off the refunded total read under the Payment row lock — real PostgreSQL (#3793)",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** How many sessions are queued directly behind `blockerPid`. */
    async function queuedBehind(blockerPid: number): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
      `;
      return rows[0]?.count ?? 0;
    }

    beforeAll(async () => {
      assertSafePaidCancelRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      payments = await import("@/lib/payment-transactions");

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
      lockHolderClient = createSeparateClient("race-3793-webhook");
      observerClient = createSeparateClient("race-3793-observer");
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
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Cancel", lastName: "Proof", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3793 Lodge", slug: "race-3793" } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PAID_CENTS,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: "pi_race_3793",
          transactions: {
            create: { id: TRANSACTION_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: "pi_race_3793", amountCents: PAID_CENTS, status: "SUCCEEDED" },
          },
        },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
      await Promise.all([lockHolderClient?.$disconnect(), observerClient?.$disconnect()]);
    });

    it("a dashboard refund committed after the claim's first read and before its Payment row lock is not refunded again at the tier", async () => {
      const lockHeld = deferred();
      const cancelQueued = deferred();
      let holderPid = 0;
      let holderError: unknown;
      // The webhook: hold the Payment row (as the real writer's first step
      // does), and record the dashboard refund only once the cancel waits on it.
      const webhook = lockHolderClient
        .$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
            holderPid = rows[0]?.pid ?? 0;
            await payments.lockPaymentForRefundedTotal(tx, PAYMENT_ID);
            lockHeld.resolve();
            await cancelQueued.promise;
            await payments.recordStripeRefundsAgainstTransaction({
              paymentId: PAYMENT_ID,
              paymentTransactionId: TRANSACTION_ID,
              refunds: [
                {
                  id: "re_race_3793_dashboard",
                  amount: DASHBOARD_REFUND_CENTS,
                  currency: "nzd",
                  status: "succeeded",
                  reason: "requested_by_customer",
                  created: ledgerStartSeconds + 60,
                  charge: "ch_race_3793",
                  payment_intent: "pi_race_3793",
                },
              ],
              fallbackPaymentIntentId: "pi_race_3793",
              store: tx,
            });
          },
          { maxWait: 5_000, timeout: 30_000 },
        )
        .catch((error: unknown) => {
          holderError = error;
          lockHeld.resolve();
        });
      await lockHeld.promise;
      if (holderError) throw new Error(`The webhook connection could not hold the Payment row: ${String(holderError)}`);

      const { cancelBooking } = await import("@/lib/booking-cancel");
      const cancel = cancelBooking(BOOKING_ID, MEMBER_ID, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST, "credit");

      let seen = 0;
      try {
        const startedAt = process.hrtime.bigint();
        while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
          seen = await queuedBehind(holderPid);
          if (seen >= 1) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        // Release on every path so nothing is left committing during cleanup.
        cancelQueued.resolve();
        await webhook;
      }
      const result = await cancel;
      if (holderError) throw holderError;
      expect(seen, `The cancel never queued behind the webhook's Payment row lock (pid ${holderPid}).`).toBeGreaterThanOrEqual(1);

      expect(result.status).toBe(200);
      // 50% of the $100 still refundable after the dashboard refund. Tiered off
      // the stale read, the cancel credited 50% of $200: $100 on top of the $100.
      expect(result).toMatchObject({ data: { refundAmountCents: 5_000 } });
      const credits = await prisma.memberCredit.aggregate({ where: { memberId: MEMBER_ID }, _sum: { amountCents: true } });
      expect(credits._sum.amountCents).toBe(5_000);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } });
      expect(payment.refundedAmountCents).toBe(DASHBOARD_REFUND_CENTS + 5_000);
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } });
      expect(booking.status).toBe("CANCELLED");
    });
  },
);
