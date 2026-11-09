/**
 * Real-PostgreSQL proof of #4866 (`INV-PAY-145`): a cancellation leaves a live
 * superseded intent's capture to the machinery returning it.
 *
 * A superseded intent's refund with no stored plan (R) sizes its one request on
 * its charge's ledger (#4699). Before #4866 a cancellation counted that capture
 * as money paid for the booking and its card plan (`planCardRefundFromLedger`,
 * newest charge first) could refund part of it (X) for the booking. R then sent
 * only what the charge still held, the rest less X, and closed: the member was
 * short X, or, where the booking's own money did not reach the policy's cap,
 * had R's money tiered by the policy. Nothing told an officer.
 *
 * Run here through the REAL `cancelBooking` and `runPaymentRecoveryOperationNow`:
 *
 * - the booking paid in full besides the capture (different money): the cancel
 *   refunds the booking's money from the booking's charge, and R returns the
 *   whole capture;
 * - the booking's own money short of the cap (the same money, in part): the
 *   policy tiers the booking's money only, and R returns the whole capture;
 * - the capture the payment's only money: the cancel refunds nothing of it, and
 *   R returns it all;
 * - the race: the superseded intent's hand-off flips its charge captured under
 *   the Payment row while the cancel waits on that row. The cancel then sees a
 *   captured charge whose refund row is not yet written, its cancel row still
 *   live, and leaves it alone too.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4866-` fixtures. Stripe is the harness's one shared double, here
 * refusing any refund larger than what the charge still holds, as Stripe does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { releaseBookingFinancialHistoryForTeardown } from "./support/booking-financial-history-teardown";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4866-member";
const LODGE_ID = "race-4866-lodge";
const BOOKING_ID = "race-4866-booking";
const PAYMENT_ID = "race-4866-payment";
const PRIMARY_TXN = "race-4866-txn-primary";
const SUPERSEDED_TXN = "race-4866-txn-superseded";
const PRIMARY_INTENT = "pi_race_4866_primary";
const SUPERSEDED_INTENT = "pi_race_4866_superseded";
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const PRIMARY_CENTS = 13_000;
const SUPERSEDED_CENTS = 6_500;
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let reconcilePaymentAggregates: (typeof import("@/lib/payment-transactions"))["reconcilePaymentAggregates"];
let lockPaymentForRefundedTotal: (typeof import("@/lib/payment-transactions"))["lockPaymentForRefundedTotal"];
let keys: typeof import("@/lib/payment-recovery-keys");
let recoveryAlert: typeof import("@/lib/payment-recovery-alert");
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let realElapsedMs: (typeof import("@/lib/__tests__/helpers/clock"))["realElapsedMs"];
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;
let harnessRole: { restore: () => void } | undefined;

(RUN ? describe : describe.skip)(
  "a cancellation leaves a live superseded capture to its own refund - real PostgreSQL (#4866)",
  { timeout: 60_000 },
  () => {
    let alertSpy: MockInstance<(typeof import("@/lib/payment-recovery-alert"))["alertPaymentRecoveryOfficers"]>;
    /** Every refund Stripe made, by intent, in order. */
    let made: Array<{ paymentIntentId: string; amountCents: number }> = [];

    async function deleteBookingRows() {
      await prisma.emailLog.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: "superseded-payment-refund-report:" } } });
      const operations = await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { targetId: { in: [BOOKING_ID, PAYMENT_ID] } },
            { entityId: { in: [BOOKING_ID, PAYMENT_ID, ...operations.map((row) => row.id)] } },
          ],
        },
      });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await releaseBookingFinancialHistoryForTeardown(prisma, [BOOKING_ID]);
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.updateMany({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * A booking whose superseded intent was captured anyway, beside its own
     * primary capture (when `primaryCents` is above zero). The superseded
     * charge is the newer, so a newest-first plan reaches it first.
     */
    async function seed({
      status,
      priceCents,
      primaryCents,
      refundPercentage,
      superseded,
    }: {
      status: "PAID" | "PAYMENT_PENDING";
      priceCents: number;
      primaryCents: number;
      refundPercentage: number;
      /** "refund": captured, its refund row (R) live with no plan; "handing-off": not yet captured, its cancel row live. */
      superseded: "refund" | "handing-off";
    }): Promise<string> {
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage, fixedFeeCents: 0 } });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status, totalPriceCents: priceCents, finalPriceCents: priceCents },
      });
      const captured = superseded === "refund";
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: primaryCents + (captured ? SUPERSEDED_CENTS : 0),
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: primaryCents > 0 ? PRIMARY_INTENT : SUPERSEDED_INTENT,
        },
      });
      if (primaryCents > 0) {
        await prisma.paymentTransaction.create({
          data: { id: PRIMARY_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT, amountCents: primaryCents, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
        });
      }
      await prisma.paymentTransaction.create({
        data: {
          id: SUPERSEDED_TXN,
          paymentId: PAYMENT_ID,
          kind: primaryCents > 0 ? "ADDITIONAL" : "PRIMARY",
          source: "STRIPE",
          stripePaymentIntentId: SUPERSEDED_INTENT,
          amountCents: SUPERSEDED_CENTS,
          status: captured ? "SUCCEEDED" : "PENDING",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      const row = await prisma.paymentRecoveryOperation.create({
        data: captured
          ? {
              type: "REFUND_SUPERSEDED_PAYMENT",
              status: "PENDING",
              bookingId: BOOKING_ID,
              paymentId: PAYMENT_ID,
              paymentTransactionId: SUPERSEDED_TXN,
              paymentIntentId: SUPERSEDED_INTENT,
              amountCents: SUPERSEDED_CENTS,
              idempotencyKey: keys.buildSupersededPaymentRefundRecoveryIdempotencyKey(SUPERSEDED_TXN, SUPERSEDED_INTENT),
              nextRetryAt: new Date(0),
              createdAt: new Date("2026-06-15T00:00:00.000Z"),
            }
          : {
              type: "CANCEL_PAYMENT_INTENT",
              status: "PENDING",
              bookingId: BOOKING_ID,
              paymentId: PAYMENT_ID,
              paymentTransactionId: SUPERSEDED_TXN,
              paymentIntentId: SUPERSEDED_INTENT,
              amountCents: SUPERSEDED_CENTS,
              idempotencyKey: `race-4866-cancel-${SUPERSEDED_INTENT}`,
              nextRetryAt: new Date(0),
              createdAt: new Date("2026-06-15T00:00:00.000Z"),
            },
      });
      return row.id;
    }

    async function cancel() {
      const { cancelBooking } = await import("@/lib/booking-cancel");
      return cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
    }

    /** The cancellation's frozen card plan, by charge. */
    async function cancelPlan(): Promise<Array<{ paymentTransactionId: string; amountCents: number }>> {
      const row = await prisma.paymentRecoveryOperation.findFirst({
        where: { bookingId: BOOKING_ID, type: "REFUND_BOOKING_MODIFICATION" },
        select: { allocationPlan: true },
      });
      return ((row?.allocationPlan ?? []) as Array<{ paymentTransactionId: string; amountCents: number }>).map(({ paymentTransactionId, amountCents }) => ({
        paymentTransactionId,
        amountCents,
      }));
    }

    const madeOn = (paymentIntentId: string) =>
      made.filter((refund) => refund.paymentIntentId === paymentIntentId).reduce((sum, refund) => sum + refund.amountCents, 0);

    async function waitForBlockedBy(blockerPid: number) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
        `;
        if ((rows[0]?.count ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for a transaction to queue behind pid ${blockerPid}.`);
    }

    /** A transaction on the holder client that runs `inside`, then holds its locks until released. */
    async function holdOpen(inside: (tx: Parameters<Parameters<typeof lockHolderClient.$transaction>[0]>[0]) => Promise<void>) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: (pid: number) => void;
      const started = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const done = lockHolderClient.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          await inside(tx);
          ready(pid);
          await released;
        },
        { timeout: 20_000 },
      );
      const pid = await started;
      return { pid, release, done };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4866 superseded capture at a cancellation");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      ({ runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ reconcilePaymentAggregates, lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions"));
      keys = await import("@/lib/payment-recovery-keys");
      recoveryAlert = await import("@/lib/payment-recovery-alert");
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));
      ({ realElapsedMs } = await import("@/lib/__tests__/helpers/clock"));
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = separate("race-4866-holder");
      observerClient = separate("race-4866-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Ada", lastName: "Proof", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4866 Lodge", slug: "race-4866" } });
    }, 60_000);

    beforeEach(async () => {
      await deleteBookingRows();
      resetStripeRaceHooks();
      alertSpy = vi.spyOn(recoveryAlert, "alertPaymentRecoveryOfficers").mockResolvedValue(null);
      made = [];
      // Stripe refuses a refund larger than what the charge still holds.
      const capturedByIntent = new Map([[PRIMARY_INTENT, PRIMARY_CENTS], [SUPERSEDED_INTENT, SUPERSEDED_CENTS]]);
      stripeRaceHooks.refund = async (args) => {
        const left = (capturedByIntent.get(args.paymentIntentId) ?? 0) - madeOn(args.paymentIntentId);
        if (args.amountCents > left) {
          throw new Error(`Refund amount (${args.amountCents}) is greater than unrefunded amount on charge (${left})`);
        }
        made.push({ paymentIntentId: args.paymentIntentId, amountCents: args.amountCents });
        return {
          id: `re_race_4866_${made.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.now() / 1000),
          charge: `ch_${args.paymentIntentId}`,
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
    });

    afterEach(() => {
      alertSpy.mockRestore();
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      try {
        resetStripeRaceHooks();
        await Promise.all(
          [lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())),
        );
        if (typeof prisma !== "undefined") await deleteFixtures();
      } finally {
        harnessRole?.restore();
      }
    });

    it("different money - the booking paid in full besides the capture: the cancel refunds the booking's charge, and R returns the whole capture", async () => {
      const supersededRefund = await seed({ status: "PAID", priceCents: PRIMARY_CENTS, primaryCents: PRIMARY_CENTS, refundPercentage: 100, superseded: "refund" });

      expect(await cancel()).toMatchObject({ status: 200, data: { refundAmountCents: PRIMARY_CENTS } });
      // Before #4866 the plan took the superseded charge first: [superseded 6500, primary 6500].
      expect(await cancelPlan()).toEqual([{ paymentTransactionId: PRIMARY_TXN, amountCents: PRIMARY_CENTS }]);
      expect(madeOn(SUPERSEDED_INTENT)).toBe(0);

      // R then returns the whole capture: before #4866 it found nothing left on its charge and closed short.
      expect(await runPaymentRecoveryOperationNow(supersededRefund, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(madeOn(SUPERSEDED_INTENT)).toBe(SUPERSEDED_CENTS);
      expect(madeOn(PRIMARY_INTENT)).toBe(PRIMARY_CENTS);
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it("the same money in part - the booking's own money short of the cap: the policy tiers the booking's money only, and R returns the whole capture", async () => {
      // The price rose to $195.00; $130.00 paid; the superseded $65.00 ask captured anyway; a 50% tier.
      const supersededRefund = await seed({ status: "PAID", priceCents: PRIMARY_CENTS + SUPERSEDED_CENTS, primaryCents: PRIMARY_CENTS, refundPercentage: 50, superseded: "refund" });

      // Before #4866: 50% of $195.00, the superseded money counted as paid, planned on the superseded charge first.
      expect(await cancel()).toMatchObject({ status: 200, data: { refundAmountCents: PRIMARY_CENTS / 2 } });
      expect(await cancelPlan()).toEqual([{ paymentTransactionId: PRIMARY_TXN, amountCents: PRIMARY_CENTS / 2 }]);

      expect(await runPaymentRecoveryOperationNow(supersededRefund, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(madeOn(SUPERSEDED_INTENT)).toBe(SUPERSEDED_CENTS);
      expect(madeOn(PRIMARY_INTENT)).toBe(PRIMARY_CENTS / 2);
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    });

    it("the same money - the capture the payment's only money: the cancel refunds none of it and raises nothing, and R returns it all", async () => {
      const supersededRefund = await seed({ status: "PAYMENT_PENDING", priceCents: SUPERSEDED_CENTS, primaryCents: 0, refundPercentage: 50, superseded: "refund" });

      // Before #4866: 50% of the capture, refunded from it, and R the rest: the right total, the policy's figures wrong.
      expect(await cancel()).toMatchObject({ status: 200, data: { refundAmountCents: 0 } });
      expect(await cancelPlan()).toEqual([]);
      expect(made).toEqual([]);

      expect(await runPaymentRecoveryOperationNow(supersededRefund, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(made).toEqual([{ paymentIntentId: SUPERSEDED_INTENT, amountCents: SUPERSEDED_CENTS }]);
      // No hand-back for a "shortfall" the card plan never had to carry.
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
    });

    it("the race: the hand-off flips the superseded charge captured under the Payment row while the cancel waits; the cancel leaves it to the hand-off", async () => {
      const handingOff = await seed({ status: "PAID", priceCents: PRIMARY_CENTS, primaryCents: PRIMARY_CENTS, refundPercentage: 100, superseded: "handing-off" });

      // The hand-off's own transaction (`handoffSucceededSupersededIntentToRefund`): the Payment row, the cancel row
      // claimed, the charge flipped captured and the payment rebuilt. Its refund row is written after it commits.
      const holder = await holdOpen(async (tx) => {
        await lockPaymentForRefundedTotal(tx, PAYMENT_ID);
        await tx.paymentRecoveryOperation.update({ where: { id: handingOff }, data: { status: "PROCESSING", processingStartedAt: new Date() } });
        await tx.paymentTransaction.update({ where: { id: SUPERSEDED_TXN }, data: { status: "SUCCEEDED" } });
        await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: tx });
      });
      const cancelling = cancel();
      // The cancel's claim takes the same Payment row: it queues behind the hand-off.
      await waitForBlockedBy(holder.pid);
      holder.release();
      await holder.done;

      expect(await cancelling).toMatchObject({ status: 200, data: { refundAmountCents: PRIMARY_CENTS } });
      // The captured charge the hand-off still owns is in no slice, and none of it was refunded for the booking.
      expect(await cancelPlan()).toEqual([{ paymentTransactionId: PRIMARY_TXN, amountCents: PRIMARY_CENTS }]);
      expect(madeOn(SUPERSEDED_INTENT)).toBe(0);
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: SUPERSEDED_TXN }, select: { refundedAmountCents: true } })).toEqual({
        refundedAmountCents: 0,
      });
    });
  },
);
