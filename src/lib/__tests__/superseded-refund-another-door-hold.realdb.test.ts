/**
 * Real-PostgreSQL proof of #4858 (`INV-PAY-145`): a superseded intent's refund
 * with no stored plan holds, rather than sends, while its charge carries a
 * counted refund another door made since the row was raised.
 *
 * The row (R) is sized on its charge's ledger, so the other door's refund (X)
 * counts as R's progress. Before #4858 R sent the rest; were X to fail later
 * while R was still open, the failed-later writer (`findOwner`) owed X on a row
 * of its own (X lacks R's metadata) while R re-sized with X's headroom back:
 * X paid twice. Run here through the REAL `runPaymentRecoveryOperationNow`,
 * the real ledger writer and the real failed-later writer:
 *
 * - the issue's race: X's ledger write holds the Payment row while R's
 *   preflight waits on it; R then holds - nothing sent, the outside-app hold's
 *   terminal failure, alert and payment audit. X then fails later: it is owed
 *   once, on a row of its own, which re-sends it; R is never claimed again.
 * - another door's refund made before R was raised is only taken off the ask
 *   (#4699): R sends the rest.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4858-` fixtures. Stripe is the harness's one shared double.
 */
import type Stripe from "stripe";
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

const MEMBER_ID = "race-4858-member";
const LODGE_ID = "race-4858-lodge";
const BOOKING_ID = "race-4858-booking";
const PAYMENT_ID = "race-4858-payment";
const PRIMARY_TXN = "race-4858-txn-primary";
const SUPERSEDED_TXN = "race-4858-txn-superseded";
const PRIMARY_INTENT = "pi_race_4858_primary";
const SUPERSEDED_INTENT = "pi_race_4858_superseded";
const OTHER_DOOR_REFUND = "re_race_4858_other_door";
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const PRIMARY_CENTS = 13_000;
const SUPERSEDED_CENTS = 6_500;
const OTHER_DOOR_CENTS = 2_000;

const LEDGER_MIGRATION = "20260509090000_enrich_payment_refund_ledger";
const CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let recordStripeRefundsAgainstTransaction: (typeof import("@/lib/payment-transactions"))["recordStripeRefundsAgainstTransaction"];
let listDeadCardRefunds: (typeof import("@/lib/card-refund-paid-another-way"))["listDeadCardRefunds"];
let keys: typeof import("@/lib/payment-recovery-keys");
let recoveryAlert: typeof import("@/lib/payment-recovery-alert");
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let MAX_PAYMENT_RECOVERY_ATTEMPTS: number;
let realElapsedMs: (typeof import("@/lib/__tests__/helpers/clock"))["realElapsedMs"];
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;
let harnessRole: { restore: () => void } | undefined;
/** Whole seconds after the refund ledger and the failed-later cutoff arrived on this database: when R was raised. */
let raisedSeconds = 0;

(RUN ? describe : describe.skip)(
  "a plan-less superseded refund holds while another door's refund sizes it - real PostgreSQL (#4858)",
  { timeout: 60_000 },
  () => {
    let alertSpy: MockInstance<(typeof import("@/lib/payment-recovery-alert"))["alertPaymentRecoveryOfficers"]>;
    /** Every Stripe refund a runner asked for. */
    let asked: Array<{ idempotencyKey?: string; amountCents: number }> = [];
    let operationId = "";

    async function deleteBookingRows() {
      await prisma.emailLog.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: "superseded-payment-refund-report:" } } });
      await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: `card-refund-cap-overflow:${SUPERSEDED_TXN}:` } } });
      const operations = await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { targetId: { in: [BOOKING_ID, PAYMENT_ID] } },
            { entityId: { in: [BOOKING_ID, PAYMENT_ID, OTHER_DOOR_REFUND, ...operations.map((row) => row.id)] } },
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
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** A paid booking whose superseded ask was captured anyway: R raised to refund the whole capture, no stored plan. */
    async function seedSupersededRefund(): Promise<string> {
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          status: "PAID",
          totalPriceCents: PRIMARY_CENTS,
          finalPriceCents: PRIMARY_CENTS,
        },
      });
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PRIMARY_CENTS + SUPERSEDED_CENTS, source: "STRIPE", status: "SUCCEEDED" },
      });
      await prisma.paymentTransaction.create({
        data: { id: PRIMARY_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT, amountCents: PRIMARY_CENTS, status: "SUCCEEDED" },
      });
      await prisma.paymentTransaction.create({
        data: { id: SUPERSEDED_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: SUPERSEDED_INTENT, amountCents: SUPERSEDED_CENTS, status: "SUCCEEDED" },
      });
      const row = await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_SUPERSEDED_PAYMENT",
          status: "PENDING",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentTransactionId: SUPERSEDED_TXN,
          paymentIntentId: SUPERSEDED_INTENT,
          amountCents: SUPERSEDED_CENTS,
          idempotencyKey: keys.buildSupersededPaymentRefundRecoveryIdempotencyKey(SUPERSEDED_TXN, SUPERSEDED_INTENT),
          nextRetryAt: new Date(0),
          createdAt: new Date(raisedSeconds * 1000),
        },
      });
      return row.id;
    }

    /** An edit's inline card refund of part of the superseded charge, that succeeded first time: no row behind it. */
    const otherDoorRefund = (status: string, createdSeconds: number) =>
      ({
        id: OTHER_DOOR_REFUND,
        object: "refund",
        amount: OTHER_DOOR_CENTS,
        currency: "nzd",
        status,
        reason: "requested_by_customer",
        created: createdSeconds,
        charge: "ch_race_4858_superseded",
        payment_intent: SUPERSEDED_INTENT,
        metadata: keys.buildBookingModificationRefundMetadata(BOOKING_ID, "date_change_price_decrease"),
      }) as unknown as Stripe.Refund;

    /** The ledger writer `charge.refunded` and the doors share, on the superseded charge. */
    const record = (refund: Stripe.Refund, store?: unknown) =>
      recordStripeRefundsAgainstTransaction({
        paymentId: PAYMENT_ID,
        paymentTransactionId: SUPERSEDED_TXN,
        refunds: [refund] as never,
        fallbackPaymentIntentId: SUPERSEDED_INTENT,
        ...(store ? { store: store as never } : {}),
      });

    const rowNow = (id: string) => prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id } });

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

    /** Settled into a value at once, so a refusal before it is awaited is never reported unhandled. */
    const settle = <T,>(promise: Promise<T>) =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4858 superseded refund hold");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      ({ runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions"));
      ({ listDeadCardRefunds } = await import("@/lib/card-refund-paid-another-way"));
      keys = await import("@/lib/payment-recovery-keys");
      recoveryAlert = await import("@/lib/payment-recovery-alert");
      ({ MAX_PAYMENT_RECOVERY_ATTEMPTS } = await import("@/lib/payment-recovery-constants"));
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
      lockHolderClient = separate("race-4858-holder");
      observerClient = separate("race-4858-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      // Refunds made on this install since the refund ledger and the failed-later cutoff arrived. Read, never rewritten.
      const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
        SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" IN (${LEDGER_MIGRATION}, ${CUTOFF_MIGRATION})`;
      if (rows.length !== 2 || rows.some((row) => row.finished_at === null)) {
        throw new Error("The race database lacks the refund ledger migrations: run prisma migrate deploy against it first.");
      }
      raisedSeconds = Math.max(...rows.map((row) => Math.floor(row.finished_at!.getTime() / 1000))) + 7_200;

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Ada", lastName: "Proof", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4858 Lodge", slug: "race-4858" } });
    }, 60_000);

    beforeEach(async () => {
      await deleteBookingRows();
      resetStripeRaceHooks();
      alertSpy = vi.spyOn(recoveryAlert, "alertPaymentRecoveryOfficers").mockResolvedValue(null);
      asked = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push({ idempotencyKey: args.idempotencyKey, amountCents: args.amountCents });
        return {
          id: `re_race_4858_sent_${asked.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          created: raisedSeconds + 3_600 + asked.length,
          charge: "ch_race_4858_superseded",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      operationId = await seedSupersededRefund();
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

    it("the issue's race: another door's refund recorded while the runner's preflight waits for the Payment row holds the row, nothing sent; that refund failing later is owed once, on a row of its own", async () => {
      const madeSeconds = raisedSeconds + 60;
      // Stripe made the other door's refund; its ledger write holds the Payment row, uncommitted.
      stripeRaceHooks.listRefunds = async () => [otherDoorRefund("succeeded", madeSeconds)];
      const holder = await holdOpen(async (tx) => {
        await record(otherDoorRefund("succeeded", madeSeconds), tx);
      });
      const running = settle(runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST));
      // The runner's preflight records what Stripe lists under the same Payment row: it queues behind the door.
      await waitForBlockedBy(holder.pid);
      holder.release();
      await holder.done;

      expect(await running).toEqual({ ok: true, value: "failed" });
      // Held, not sized on the other door's refund: nothing asked of Stripe, the outside-app hold's terminal failure.
      expect(asked).toEqual([]);
      const held = await rowNow(operationId);
      expect(held).toMatchObject({ status: "FAILED", attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null, succeededAt: null });
      expect(held.lastError).toContain("#4858");
      expect(alertSpy).toHaveBeenCalledTimes(1);
      const audits = await prisma.auditLog.findMany({ where: { entityId: operationId }, select: { action: true, category: true, metadata: true } });
      expect(audits).toEqual([
        { action: "booking-payment.card-refund.resend-held", category: "payment", metadata: { stripeRefundIds: [OTHER_DOOR_REFUND], paymentId: PAYMENT_ID } },
      ]);
      expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: SUPERSEDED_TXN } })).refundedAmountCents).toBe(OTHER_DOOR_CENTS);

      // The other door's refund fails later, through the real writer: owed on a row of its own, as `findOwner` decides.
      stripeRaceHooks.listRefunds = async () => [otherDoorRefund("failed", madeSeconds)];
      await record(otherDoorRefund("failed", madeSeconds));
      const failedLater = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
        where: { idempotencyKey: keys.buildCardRefundFailedLaterRecoveryKey(OTHER_DOOR_REFUND) },
      });
      expect(failedLater).toMatchObject({ amountCents: OTHER_DOOR_CENTS, status: "PENDING" });
      // Review F1, the state an officer sees now, as it stands (the #4492 question is not decided here): the held
      // row owes its whole charge again beside the failed-later row, and "Try the card again" is refused for it.
      // The hold's message tells the officer not to close it with "Paid another way" but to ask a developer.
      const panel = (await listDeadCardRefunds()).find((row) => row.operationId === operationId);
      expect(panel).toMatchObject({ owedCents: SUPERSEDED_CENTS });
      expect(panel?.tryCardAgainRefusal).toMatch(/failed later is on this payment/);
      expect((await rowNow(operationId)).lastError).toMatch(/has since failed .* ask a developer \(#4492\)/);

      // The held row is never claimed again; the failed-later row re-sends the other door's refund, once.
      expect(await runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("not-claimed");
      expect(await runPaymentRecoveryOperationNow(failedLater.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(asked).toEqual([expect.objectContaining({ amountCents: OTHER_DOOR_CENTS })]);
      expect(await rowNow(operationId)).toMatchObject({ status: "FAILED", attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS });
    });

    it("another door's refund made before the row was raised is only taken off the ask (#4699): the rest is sent", async () => {
      const before = otherDoorRefund("succeeded", raisedSeconds - 60);
      stripeRaceHooks.listRefunds = async () => [before];

      expect(await runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(asked).toEqual([expect.objectContaining({ amountCents: SUPERSEDED_CENTS - OTHER_DOOR_CENTS })]);
      expect(await rowNow(operationId)).toMatchObject({ status: "SUCCEEDED" });
      expect(alertSpy).not.toHaveBeenCalled();
    });
  },
);
