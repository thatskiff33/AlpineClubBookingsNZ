/**
 * Real-PostgreSQL proof that a payment's aggregate is rebuilt from rows read
 * UNDER the `Payment` row lock, and that every ledger-row writer takes that lock
 * before its first row write (#4217, `INV-LOCK-002`).
 *
 * Before #4217 `reconcilePaymentAggregates` read a payment's rows and only then
 * reached the `Payment` row, through its update. A rebuild could therefore read
 * the rows, queue on the `Payment` row behind a refund writer that holds it, and
 * then write totals worked out from the rows it read before that writer
 * committed: the refunded total no longer matched the detail. And the five
 * writers wrote their row BEFORE the `Payment` row - the reverse of the order
 * the card-refund writer takes (#3640) - so the two could deadlock.
 *
 * Every interleaving here is forced, not hoped for. A second connection holds
 * the `Payment` row, as the counterpart writer's first step does; the REAL
 * writer under test starts and queues on that row, read from
 * `pg_blocking_pids` on a third connection; only then does the holder make its
 * change through the REAL counterpart writer and commit.
 *
 *  1. A capture webhook (`markPaymentIntentTransactionSucceeded`) racing an
 *     account-credit allocation (`applyLocalRefundAllocation`).
 *  2. The same webhook racing a #4162-shaped unwind: `lock(1)`, the `Payment`
 *     row, then a compare-and-set taking a refund back out.
 *  3. A settle re-recording a captured row (`upsertPaymentIntentTransaction`
 *     under `lock(1)`) racing a card refund on that row: no deadlock.
 *  4. A writer that reaches only the rebuild (the superseded-intent late
 *     capture's shape in `payment-recovery.ts`: a row write, then
 *     `reconcilePaymentAggregates` on the root client) racing an allocation.
 *  5. The Internet Banking settle (#4094) racing a card refund on the same
 *     payment: its refunded total is read under the lock.
 *  6. The cost (#4217 review): a capture queued past its transaction's 5 s
 *     limit behind a holder of the Payment row fails with P2028, rolled back
 *     whole - nothing it would have written is written.
 *  7. A manual-payment reversal (#4217 review) racing the recovery runner's
 *     claim hold re-queueing a stale ask's cancellation: no deadlock.
 *
 * In races 1-5 the payment's refunded total must end equal to the sum of its
 * rows; race 6 is the cost race (a P2028 that writes nothing) and race 7 the
 * reversal's no-deadlock race. The two reduction races - the retire against
 * the capture webhook, and a credit give-back's reduction against the runner's
 * claim hold - live beside their fixtures in
 * `additional-ask-reduction.realdb.test.ts`.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4217-` fixtures.
 */
import type { Invoice } from "xero-node";
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4217-member";
const LODGE_ID = "race-4217-lodge";
const BOOKING_ID = "race-4217-booking";
const GUEST_ID = "race-4217-guest";
const PAYMENT_ID = "race-4217-payment";
const PRIMARY_ID = "race-4217-primary";
const ADDITIONAL_ID = "race-4217-additional";
const IB_PRIMARY_ID = "race-4217-ib-primary";
const PRIMARY_INTENT = "pi_race_4217_primary";
const ADDITIONAL_INTENT = "pi_race_4217_additional";
const INVOICE_ID = "race-4217-invoice";
const CHECK_IN = new Date("2027-09-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-09-02T00:00:00.000Z");

// Under Prisma's 5 s default for an interactive transaction: a contender on
// the root client opens one, so a poll that outlived it would read a timeout as
// a queue (#4217 review, flake guard).
const LOCK_POLL_TIMEOUT_MS = 3_000;

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafePaymentLockRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Payment-lock race proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run payment-lock race proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Payment-lock race proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Payment-lock race proof DB name must contain 'concurrency_race_1881'.");
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** True when `error`, or anything in its cause chain, is a PostgreSQL deadlock (40P01). */
function isDeadlock(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 8; depth += 1) {
    const text = `${(current as { code?: unknown }).code ?? ""} ${(current as { message?: unknown }).message ?? ""}`;
    if (text.includes("40P01") || /deadlock/i.test(text)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let payments: typeof import("@/lib/payment-transactions");
let holderClient: PrismaClient;
let observerClient: PrismaClient;
let ledgerStartSeconds = 0;

(RUN ? describe : describe.skip)(
  "#4217: the Payment row is locked before any ledger row is written or the rebuild reads - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { OR: [{ localId: { in: [PAYMENT_ID, BOOKING_ID] } }, { xeroObjectId: INVOICE_ID }] } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [BOOKING_ID, PAYMENT_ID] } }, { targetId: BOOKING_ID }] } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    /**
     * A $200 card-paid booking with an unpaid $50 top-up: the PRIMARY capture,
     * the ADDITIONAL ask, and the payment's columns as the rebuild derives them.
     * `primaryRefundedCents` seeds refund history already on the capture.
     */
    async function cardPaidWithTopUp({ primaryRefundedCents = 0 } = {}) {
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: 25_000, finalPriceCents: 25_000 },
      });
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: PRIMARY_INTENT },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: PRIMARY_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT,
          amountCents: 20_000, refundedAmountCents: primaryRefundedCents,
          status: primaryRefundedCents >= 20_000 ? "REFUNDED" : primaryRefundedCents > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: ADDITIONAL_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: ADDITIONAL_INTENT,
          amountCents: 5_000, status: "PENDING", createdAt: new Date("2026-06-10T00:00:00.000Z"),
        },
      });
      await payments.reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
    }

    /** The payment's columns beside what its rows add up to. */
    async function totals() {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { amountCents: true, refundedAmountCents: true, status: true },
      });
      const rows = await prisma.paymentTransaction.findMany({
        where: { paymentId: PAYMENT_ID },
        select: { refundedAmountCents: true },
      });
      return { payment, rowsRefundedCents: rows.reduce((sum, row) => sum + row.refundedAmountCents, 0) };
    }

    async function queuedBehind(blockerPid: number): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
      `;
      return rows[0]?.count ?? 0;
    }

    /**
     * Hold the `Payment` row on the holder connection (after `beforeLock`, for
     * a holder that takes `lock(1)` first), start `contender`, wait until it
     * queues behind the holder, then run `afterQueued` on the holder's
     * transaction and commit. Returns the contender's result or error and the
     * holder's error, if any.
     */
    async function raceAgainstHeldPayment<T>({
      beforeLock,
      afterQueued,
      contender,
      holderTimeoutMs = 30_000,
    }: {
      beforeLock?: (tx: Prisma.TransactionClient) => Promise<void>;
      afterQueued: (tx: Prisma.TransactionClient) => Promise<void>;
      contender: () => Promise<T>;
      holderTimeoutMs?: number;
    }): Promise<{ result: T | undefined; error: unknown; holderError: unknown; queued: number }> {
      const lockHeld = deferred();
      const contenderQueued = deferred();
      let holderPid = 0;
      let holderError: unknown;
      const holder = holderClient
        .$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
            holderPid = rows[0]?.pid ?? 0;
            if (beforeLock) await beforeLock(tx);
            await payments.lockPaymentForRefundedTotal(tx, PAYMENT_ID);
            lockHeld.resolve();
            await contenderQueued.promise;
            await afterQueued(tx);
          },
          { maxWait: 5_000, timeout: holderTimeoutMs },
        )
        .catch((error: unknown) => {
          holderError = error;
          lockHeld.resolve();
        });
      await lockHeld.promise;
      if (holderError) throw new Error(`The holder connection could not hold the Payment row: ${String(holderError)}`);

      let result: T | undefined;
      let error: unknown;
      const running = contender().then(
        (value) => {
          result = value;
        },
        (caught: unknown) => {
          error = caught;
        },
      );

      let queued = 0;
      try {
        const startedAt = process.hrtime.bigint();
        while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
          queued = await queuedBehind(holderPid);
          if (queued >= 1) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        // Release on every path so nothing is left committing during cleanup.
        contenderQueued.resolve();
        await holder;
        await running;
      }
      return { result, error, holderError, queued };
    }

    beforeAll(async () => {
      assertSafePaymentLockRaceDbUrl(RACE_DB_URL);
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
      holderClient = createSeparateClient("race-4217-holder");
      observerClient = createSeparateClient("race-4217-observer");
      await Promise.all([holderClient.$connect(), observerClient.$connect()]);
      const startRows = await observerClient.$queryRaw<Array<{ finished_at: Date }>>`
        SELECT "finished_at" FROM "_prisma_migrations"
        WHERE "migration_name" = '20260509090000_enrich_payment_refund_ledger'
          AND "finished_at" IS NOT NULL
        LIMIT 1
      `;
      ledgerStartSeconds = Math.floor((startRows[0]?.finished_at ?? new Date(0)).getTime() / 1000);

      await deleteFixtures();
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Lock", lastName: "Proof", ageTier: "ADULT" },
      });
      // No beds: a booking holding its beds settles to PAID (#1982), as in the
      // #3979 settle proof this file's fifth race borrows its shape from.
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4217 Lodge", slug: "race-4217" } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
    }, 60_000);

    beforeEach(async () => {
      await deleteFixtures();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await Promise.all([holderClient?.$disconnect(), observerClient?.$disconnect()]);
    });

    it("RACE 1: a top-up capture webhook racing an account-credit allocation keeps the allocation in the refunded total", async () => {
      await cardPaidWithTopUp();

      const race = await raceAgainstHeldPayment({
        afterQueued: (tx) => payments.applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 10_000, store: tx }),
        contender: () =>
          payments.markPaymentIntentTransactionSucceeded({ paymentIntentId: ADDITIONAL_INTENT, amountCents: 5_000, paymentMethodId: "pm_race_4217" }),
      });

      expect(race.holderError).toBeUndefined();
      expect(race.error).toBeUndefined();
      expect(race.queued, "the capture never queued behind the allocation's Payment row").toBeGreaterThanOrEqual(1);
      const { payment, rowsRefundedCents } = await totals();
      // Read before the allocation committed, the capture wrote $0 refunded
      // over the $100 the rows hold.
      expect(rowsRefundedCents).toBe(10_000);
      expect(payment.refundedAmountCents).toBe(rowsRefundedCents);
      expect(payment.amountCents).toBe(25_000);
      expect(payment.status).toBe("PARTIALLY_REFUNDED");
    });

    it("RACE 2: the capture webhook racing a #4162-shaped unwind under lock(1) keeps the unwind", async () => {
      await cardPaidWithTopUp({ primaryRefundedCents: 20_000 });
      expect((await totals()).payment.refundedAmountCents).toBe(20_000);

      const race = await raceAgainstHeldPayment({
        beforeLock: async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        },
        afterQueued: async (tx) => {
          // A voided bank-transfer refund confirmed cancelled: the $200 comes back out.
          await payments.compareAndSetRefundedAmount(tx, PRIMARY_ID, (row) => Math.max(row.refundedAmountCents - 20_000, 0), { writeStatus: true });
          await payments.reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: tx });
        },
        contender: () =>
          payments.markPaymentIntentTransactionSucceeded({ paymentIntentId: ADDITIONAL_INTENT, amountCents: 5_000 }),
      });

      expect(race.holderError).toBeUndefined();
      expect(race.error).toBeUndefined();
      expect(race.queued).toBeGreaterThanOrEqual(1);
      const { payment, rowsRefundedCents } = await totals();
      // The issue's example: read before the unwind, the capture put the $200 back.
      expect(rowsRefundedCents).toBe(0);
      expect(payment.refundedAmountCents).toBe(0);
      expect(payment.amountCents).toBe(25_000);
      expect(payment.status).toBe("SUCCEEDED");
    });

    it("RACE 3: a settle re-recording a captured charge under lock(1), racing a card refund on that charge, does not deadlock", async () => {
      await cardPaidWithTopUp();

      const race = await raceAgainstHeldPayment({
        afterQueued: async (tx) => {
          await payments.recordStripeRefundsAgainstTransaction({
            paymentId: PAYMENT_ID,
            paymentTransactionId: PRIMARY_ID,
            refunds: [
              {
                id: "re_race_4217_dashboard",
                amount: 6_000,
                currency: "nzd",
                status: "succeeded",
                reason: "requested_by_customer",
                created: ledgerStartSeconds + 60,
                charge: "ch_race_4217",
                payment_intent: PRIMARY_INTENT,
              },
            ],
            fallbackPaymentIntentId: PRIMARY_INTENT,
            store: tx,
          });
        },
        // A webhook redelivery of the capture, settled under lock(1) as the
        // settle does: before #4217 it wrote the charge's row, then queued on
        // the Payment row the refund held while the refund queued on that row.
        contender: () =>
          prisma.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
              await payments.upsertPaymentIntentTransaction({
                paymentId: PAYMENT_ID,
                kind: "PRIMARY",
                paymentIntentId: PRIMARY_INTENT,
                amountCents: 20_000,
                status: "SUCCEEDED",
                paymentMethodId: "pm_race_4217",
                store: tx,
              });
            },
            { maxWait: 5_000, timeout: 30_000 },
          ),
      });

      expect(isDeadlock(race.holderError), `the card refund deadlocked: ${String(race.holderError)}`).toBe(false);
      expect(isDeadlock(race.error), `the settle deadlocked: ${String(race.error)}`).toBe(false);
      expect(race.holderError).toBeUndefined();
      expect(race.error).toBeUndefined();
      expect(race.queued).toBeGreaterThanOrEqual(1);
      const { payment, rowsRefundedCents } = await totals();
      expect(rowsRefundedCents).toBe(6_000);
      expect(payment.refundedAmountCents).toBe(rowsRefundedCents);
      // The late write keeps the refund's status (#4081: no write lowers a captured row's status).
      const primary = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: PRIMARY_ID }, select: { status: true, refundedAmountCents: true } });
      expect(primary).toEqual({ status: "PARTIALLY_REFUNDED", refundedAmountCents: 6_000 });
    });

    it("RACE 4: a writer that reaches only the rebuild (a row write, then the root-client reconcile) reads its rows under the lock", async () => {
      await cardPaidWithTopUp();

      const race = await raceAgainstHeldPayment({
        afterQueued: (tx) => payments.applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 10_000, preferTransactionIds: [PRIMARY_ID], store: tx }),
        // `payment-recovery.ts`'s superseded-intent late capture: its own
        // autocommit row write, then the rebuild on the root client.
        contender: async () => {
          await prisma.paymentTransaction.update({
            where: { id: ADDITIONAL_ID },
            data: { amountCents: 5_000, status: "SUCCEEDED", reason: "zero_dollar_batch_modification_late_capture" },
          });
          return payments.reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
        },
      });

      expect(race.holderError).toBeUndefined();
      expect(race.error).toBeUndefined();
      expect(race.queued).toBeGreaterThanOrEqual(1);
      const { payment, rowsRefundedCents } = await totals();
      expect(rowsRefundedCents).toBe(10_000);
      expect(payment.refundedAmountCents).toBe(rowsRefundedCents);
      expect(payment.amountCents).toBe(25_000);
    });

    it("RACE 5: the Internet Banking settle racing a card refund on the same payment records the refunded total read under the lock (#4094)", async () => {
      // #1765's shape: a card charge part refunded before the switch to bank
      // transfer, then a held booking whose invoice Xero now reports paid.
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "CONFIRMED", totalPriceCents: 20_000, finalPriceCents: 20_000 },
      });
      await prisma.bookingGuest.create({
        data: {
          id: GUEST_ID, bookingId: BOOKING_ID, firstName: "Settle", lastName: "Proof", ageTier: "ADULT", isMember: true,
          stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: 20_000,
          nights: { create: [{ stayDate: CHECK_IN, priceCents: 20_000, priceSource: "SOLD" }] },
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "PENDING",
          reference: "BOOKING-RACE4217", internetBankingHoldSlots: true, xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-4217",
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: PRIMARY_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT,
          amountCents: 30_000, refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED", createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: IB_PRIMARY_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 20_000, status: "PENDING",
          reference: "BOOKING-RACE4217", reason: "internet_banking_booking_payment", xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-4217",
        },
      });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 10_000 } });
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
      });
      const paidInvoice = {
        invoiceID: INVOICE_ID,
        invoiceNumber: "INV-4217",
        status: "PAID",
        amountPaid: 200,
        payments: [{ paymentID: "race-4217-xpay", amount: 200, status: "AUTHORISED" }],
      } as unknown as Invoice;
      const { syncInternetBankingPaymentsForPaidInvoice } = await import("@/lib/xero-inbound/invoice-paid-effects");

      const race = await raceAgainstHeldPayment({
        // A dashboard refund of another $100 on the old card charge.
        afterQueued: async (tx) => {
          await payments.recordStripeRefundsAgainstTransaction({
            paymentId: PAYMENT_ID,
            paymentTransactionId: PRIMARY_ID,
            refunds: [
              {
                id: "re_race_4217_ib",
                amount: 10_000,
                currency: "nzd",
                status: "succeeded",
                reason: "requested_by_customer",
                created: ledgerStartSeconds + 60,
                charge: "ch_race_4217",
                payment_intent: PRIMARY_INTENT,
              },
            ],
            fallbackPaymentIntentId: PRIMARY_INTENT,
            store: tx,
          });
        },
        contender: () => syncInternetBankingPaymentsForPaidInvoice(paidInvoice, [PAYMENT_ID], CLUB_FORMAT_TEST),
      });

      expect(race.holderError).toBeUndefined();
      expect(race.error).toBeUndefined();
      expect(race.queued, "the settle never queued behind the card refund's Payment row").toBeGreaterThanOrEqual(1);
      const { payment, rowsRefundedCents } = await totals();
      expect(rowsRefundedCents).toBe(20_000);
      // Read before the refund committed, the settle wrote the $100 it saw.
      expect(payment.refundedAmountCents).toBe(rowsRefundedCents);
      // The receipt is the cash, beside the card charge (#3979).
      expect(payment.amountCents).toBe(50_000);
      const receipt = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: IB_PRIMARY_ID }, select: { status: true, amountCents: true } });
      expect(receipt).toEqual({ status: "SUCCEEDED", amountCents: 20_000 });
      // And the ledger's own projection agrees with what the settle wrote.
      await payments.reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
      expect((await totals()).payment).toMatchObject({ amountCents: 50_000, refundedAmountCents: 20_000 });
    });

    it("RACE 6 (the cost): a capture queued past its 5 s transaction limit behind the Payment row fails P2028 and writes nothing", async () => {
      await cardPaidWithTopUp();
      const before = await totals();

      const race = await raceAgainstHeldPayment({
        // A long holder: the Payment row kept past the capture's limit.
        afterQueued: () => new Promise((resolve) => setTimeout(resolve, 6_500)),
        holderTimeoutMs: 30_000,
        contender: () =>
          payments.markPaymentIntentTransactionSucceeded({ paymentIntentId: ADDITIONAL_INTENT, amountCents: 5_000 }),
      });

      expect(race.holderError).toBeUndefined();
      expect(race.queued).toBeGreaterThanOrEqual(1);
      expect((race.error as { code?: string } | undefined)?.code, `expected P2028, got ${String(race.error)}`).toBe("P2028");
      // Rolled back whole: the top-up is still unpaid and the payment unmoved,
      // so Stripe's retry records it as if it were the first delivery.
      const additional = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: ADDITIONAL_ID }, select: { status: true } });
      expect(additional.status).toBe("PENDING");
      expect(await totals()).toEqual(before);
      // And the retry, with the row free, records it.
      await payments.markPaymentIntentTransactionSucceeded({ paymentIntentId: ADDITIONAL_INTENT, amountCents: 5_000 });
      expect((await totals()).payment.amountCents).toBe(25_000);
    }, 30_000);

    it("RACE 7: a manual-payment reversal racing the recovery runner's claim hold re-queueing a stale ask's cancellation does not deadlock", async () => {
      // A booking an officer marked paid in cash, with a stale card top-up whose
      // cancellation is queued - the operation the reversal disarms.
      const STALE_ID = "race-4217-stale-ask";
      const STALE_INTENT = "pi_race_4217_stale";
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: 20_000, finalPriceCents: 20_000 },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "SUCCEEDED",
          manuallyMarkedPaidAt: new Date("2026-06-20T00:00:00.000Z"), manuallyMarkedPaidByMemberId: MEMBER_ID,
          manuallyMarkedPaidPreviousStatus: "PAYMENT_PENDING",
        },
      });
      await prisma.paymentTransaction.create({
        data: { id: IB_PRIMARY_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 20_000, status: "SUCCEEDED", reason: "manual_mark_paid" },
      });
      await prisma.paymentTransaction.create({
        data: { id: STALE_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: STALE_INTENT, amountCents: 5_000, status: "PENDING" },
      });
      const { enqueuePaymentIntentCancellationRecovery } = await import("@/lib/payment-recovery");
      const cancellation = { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, paymentTransactionId: STALE_ID, paymentIntentId: STALE_INTENT, amountCents: 5_000 };
      await enqueuePaymentIntentCancellationRecovery(cancellation);
      const { reverseManualBookingPayment } = await import("@/lib/payment-reconciliation");

      const race = await raceAgainstHeldPayment({
        // The claim hold's shape: the Payment row, then the cancellation rows its
        // supersede upserts (`queueSupersededAdditionalIntentCancellationRows`).
        afterQueued: async (tx) => {
          await enqueuePaymentIntentCancellationRecovery({ ...cancellation, store: tx });
        },
        // Before #4217's review the reversal deleted the cancellation row first
        // and reached the Payment row only at its own write: a deadlock.
        contender: () => reverseManualBookingPayment({ bookingId: BOOKING_ID, actingAdminMemberId: MEMBER_ID, note: null }),
      });

      expect(isDeadlock(race.holderError), `the claim hold deadlocked: ${String(race.holderError)}`).toBe(false);
      expect(isDeadlock(race.error), `the reversal deadlocked: ${String(race.error)}`).toBe(false);
      expect(race.holderError).toBeUndefined();
      expect(race.error).toBeUndefined();
      expect(race.queued, "the reversal never queued behind the claim hold's Payment row").toBeGreaterThanOrEqual(1);
      // The reversal ran after the hold committed and restored the booking. The
      // ask is stale (the payment names no live ask), so its cancellation - the
      // one the hold re-queued - stands (#4320: the reversal re-derives it).
      expect(await prisma.paymentRecoveryOperation.findMany({ where: { paymentId: PAYMENT_ID, type: "CANCEL_PAYMENT_INTENT" }, select: { paymentIntentId: true, status: true } })).toEqual([
        { paymentIntentId: STALE_INTENT, status: "PENDING" },
      ]);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("PAYMENT_PENDING");
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { manuallyMarkedPaidAt: true } })).manuallyMarkedPaidAt).toBeNull();
    });
  },
);
