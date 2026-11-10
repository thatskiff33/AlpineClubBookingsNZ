/**
 * Real-PostgreSQL proof of a dead card refund's two no-money settlements
 * (#4368, owner decision 25 Oct 2026; `INV-PAY-149`): "Try the card again"
 * and "Nothing left owed", beside "Paid another way".
 *
 * - ONE ROW, ONE WINNER (#4492). A re-arm and a "Paid another way" close of
 *   the same dead row both take `lock(1)`, then the Payment row, and claim the
 *   row on the same dead, on-plan guard. Queued behind a held `lock(1)` in both
 *   orders, whichever runs first wins and the other is refused and writes
 *   nothing: a closed row is never re-armed, and a re-armed row is offered no
 *   close. A write under the Payment row alone, landing between an action's
 *   read and its claim, fails the claim.
 * - "NOTHING LEFT OWED" AGAINST A REFUND ARRIVING. The close reads the owed
 *   figure under the Payment row, which every refund recorder takes first: a
 *   refund recorded while it waits is read (it closes, naming it), and a close
 *   that ran first, with money owed, is refused. Against the covering refund
 *   failing later, in both orders, through the real writer: a failure first
 *   puts money owed back and the close is refused (and, with the failed-later
 *   row open, so is a re-arm - the #4492 pair); a close first leaves the
 *   failure to the failed-later writer, which owes it once on a row of its own.
 * - THE RUNNER'S STRIPE CHECK STILL RUNS (`INV-PAY-145`, #4359). Re-armed, the
 *   row is claimed by the real runner, whose preflight reads Stripe before any
 *   send: a refund made outside the app holds it again and nothing is sent;
 *   with none, exactly what is owed is sent.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4368-` fixtures. Stripe is the harness's one shared double.
 */
import type Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4368-member";
const OFFICER_ID = "race-4368-officer";
const LODGE_ID = "race-4368-lodge";
const BOOKING_ID = "race-4368-booking";
const PAYMENT_ID = "race-4368-payment";
const TRANSACTION_ID = "race-4368-txn";
const OPERATION_ID = "race-4368-op";
const INTENT = "pi_race_4368";
const CHARGE = "ch_race_4368";
const LATER_REFUND = "re_race_4368_later";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const RAISED_AT = new Date("2026-06-20T00:00:00.000Z");

const PAID_CENTS = 20_000;
const REFUND_CENTS = 5_000;
const PLAN = [{ paymentTransactionId: TRANSACTION_ID, amountCents: REFUND_CENTS }];

const LEDGER_MIGRATION = "20260509090000_enrich_payment_refund_ledger";
const CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let actions: typeof import("@/lib/card-refund-dead-row-actions");
let closeCardRefundPaidAnotherWay: (typeof import("@/lib/card-refund-paid-another-way"))["closeCardRefundPaidAnotherWay"];
let listDeadCardRefunds: (typeof import("@/lib/card-refund-paid-another-way"))["listDeadCardRefunds"];
let CardRefundPaidAnotherWayError: (typeof import("@/lib/card-refund-paid-another-way"))["CardRefundPaidAnotherWayError"];
let recordStripeRefundsAgainstTransaction: (typeof import("@/lib/payment-transactions"))["recordStripeRefundsAgainstTransaction"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let openCardRefundOwedCents: (typeof import("@/lib/open-card-refund-owed"))["openCardRefundOwedCents"];
let netCollectedCardRefundSelect: (typeof import("@/lib/additional-ledger-gap"))["netCollectedCardRefundSelect"];
let recoveryAlert: typeof import("@/lib/payment-recovery-alert");
let cardRefundOperationRefundMetadata: (typeof import("@/lib/payment-recovery-keys"))["cardRefundOperationRefundMetadata"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let realElapsedMs: (typeof import("@/lib/__tests__/helpers/clock"))["realElapsedMs"];
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;
/** When a later refund was made: after the migrations its writers read finished on this database. */
let refundCreatedSeconds = 0;

(RUN ? describe : describe.skip)(
  "a dead card refund's Try the card again and Nothing left owed — real PostgreSQL (#4368)",
  { timeout: 30_000 },
  () => {
    let alertSpy: MockInstance<(typeof import("@/lib/payment-recovery-alert"))["alertPaymentRecoveryOfficers"]>;
    /** Every Stripe refund the runner asked for. */
    let asked: Array<{ idempotencyKey?: string; amountCents: number }> = [];

    async function deletePaymentRows() {
      await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: `card-refund-cap-overflow:${TRANSACTION_ID}:` } } });
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { entityId: OPERATION_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4368 dead card refund settlements");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      actions = await import("@/lib/card-refund-dead-row-actions");
      ({ closeCardRefundPaidAnotherWay, listDeadCardRefunds, CardRefundPaidAnotherWayError } = await import("@/lib/card-refund-paid-another-way"));
      ({ recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions"));
      ({ runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ openCardRefundOwedCents } = await import("@/lib/open-card-refund-owed"));
      ({ netCollectedCardRefundSelect } = await import("@/lib/additional-ledger-gap"));
      recoveryAlert = await import("@/lib/payment-recovery-alert");
      ({ cardRefundOperationRefundMetadata } = await import("@/lib/payment-recovery-keys"));
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
      lockHolderClient = separate("race-4368-holder");
      observerClient = separate("race-4368-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      // A later refund made on this install since the refund ledger and the
      // failed-later cutoff arrived. Read, never rewritten.
      const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
        SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" IN (${LEDGER_MIGRATION}, ${CUTOFF_MIGRATION})`;
      if (rows.length !== 2 || rows.some((row) => row.finished_at === null)) {
        throw new Error("The race database lacks the refund ledger migrations: run prisma migrate deploy against it first.");
      }
      refundCreatedSeconds = Math.max(...rows.map((row) => Math.floor(row.finished_at!.getTime() / 1000))) + 3_600;

      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Refund", lastName: "Proof", ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4368 Lodge", slug: "race-4368" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CANCELLED",
          totalPriceCents: PAID_CENTS,
          finalPriceCents: PAID_CENTS,
        },
      });
    });

    beforeEach(async () => {
      await deletePaymentRows();
      alertSpy = vi.spyOn(recoveryAlert, "alertPaymentRecoveryOfficers").mockResolvedValue(null);
      asked = [];
      // Review B: the re-arm reads Stripe's refunds on the row's charge before its locks; none unless a case lists some.
      stripeRaceHooks.listRefunds = async () => [];
      // A Payment with no Xero invoice: a "Paid another way" close queues no note, so nothing here touches Xero.
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: INTENT },
      });
      await prisma.paymentTransaction.create({
        data: { id: TRANSACTION_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT, amountCents: PAID_CENTS, status: "SUCCEEDED" },
      });
      // The cancellation's card refund, its five attempts spent.
      await prisma.paymentRecoveryOperation.create({
        data: {
          id: OPERATION_ID,
          type: "REFUND_BOOKING_MODIFICATION",
          status: "FAILED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: INTENT,
          amountCents: REFUND_CENTS,
          allocationPlan: PLAN,
          idempotencyKey: `booking_cancel_refund_recovery_${BOOKING_ID}`,
          attempts: 5,
          nextRetryAt: null,
          lastError: "Stripe: card_declined",
          createdAt: RAISED_AT,
        },
      });
      expect(await owedNow()).toBe(REFUND_CENTS);
    });

    afterEach(() => {
      alertSpy.mockRestore();
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      await Promise.all(
        [lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())),
      );
      if (!prisma) return;
      await deleteFixtures();
    });

    // -------------------------------------------------------------- helpers

    async function owedNow(): Promise<number> {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });
      return openCardRefundOwedCents(payment);
    }

    const operationNow = () => prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: OPERATION_ID } });
    const auditActions = async () =>
      (await prisma.auditLog.findMany({ where: { entityId: OPERATION_ID }, select: { action: true }, orderBy: { createdAt: "asc" } })).map((row) => row.action);

    async function waitForBlockedBy(blockerPid: number, count = 1) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
        `;
        if ((rows[0]?.count ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${count} transaction(s) to queue behind pid ${blockerPid}.`);
    }

    /**
     * A transaction on the holder client that runs `inside` and then holds its
     * locks open until released. Resolves once `inside` has run.
     */
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

    const tryAgain = () => actions.tryDeadCardRefundAgain({ operationId: OPERATION_ID, expectedOwedCents: REFUND_CENTS, actingMemberId: OFFICER_ID });
    const nothingLeftOwed = (ids: string[] = [LATER_REFUND]) =>
      actions.closeCardRefundNothingLeftOwed({ operationId: OPERATION_ID, expectedStripeRefundIds: ids, actingMemberId: OFFICER_ID });
    const payAnotherWay = () =>
      closeCardRefundPaidAnotherWay({
        operationId: OPERATION_ID,
        amountCents: REFUND_CENTS,
        paidBack: "full",
        expectedOwedCents: REFUND_CENTS,
        note: "Bank transfer, ref RACE 4368",
        actingMemberId: OFFICER_ID,
      });

    /** A Stripe refund of the whole slice on the charge, as `charge.refunded` or the preflight lists it. */
    const stripeRefund = (status: string, metadata: Record<string, string> = { bookingId: BOOKING_ID }) =>
      ({
        id: LATER_REFUND,
        object: "refund",
        amount: REFUND_CENTS,
        currency: "nzd",
        status,
        reason: null,
        created: refundCreatedSeconds,
        charge: CHARGE,
        payment_intent: INTENT,
        metadata,
      }) as unknown as Stripe.Refund;

    const record = (status: string, store?: unknown) =>
      recordStripeRefundsAgainstTransaction({
        paymentId: PAYMENT_ID,
        paymentTransactionId: TRANSACTION_ID,
        refunds: [stripeRefund(status)] as never,
        fallbackPaymentIntentId: INTENT,
        ...(store ? { store: store as never } : {}),
      });

    /** Two actions queued behind a held `lock(1)`, `first` ahead of `second`; the key then released. */
    async function queuedBehindGlobalKey<A, B>(first: () => Promise<A>, second: () => Promise<B>) {
      const holder = await holdOpen(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      });
      const firstRun = settle(first());
      await waitForBlockedBy(holder.pid, 1);
      const secondRun = settle(second());
      await waitForBlockedBy(holder.pid, 2);
      holder.release();
      await holder.done;
      return { first: await firstRun, second: await secondRun };
    }

    // ---------------------------------------------- one row, one winner (#4492)

    describe("Try the card again against Paid another way, on one row (#4492)", () => {
      it("MUTATION: re-armed first: the close is refused and records nothing, and the row is offered no close", async () => {
        const { first, second } = await queuedBehindGlobalKey(tryAgain, payAnotherWay);

        expect(first).toMatchObject({ ok: true, value: { operationId: OPERATION_ID, owedCents: REFUND_CENTS } });
        expect(second.ok).toBe(false);
        expect((second as { error: unknown }).error).toBeInstanceOf(CardRefundPaidAnotherWayError);
        expect((second as { error: { status: number; message: string } }).error).toMatchObject({ status: 409, message: expect.stringContaining("still being retried") });

        expect(await operationNow()).toMatchObject({ status: "PENDING", attempts: 0, lastError: null, succeededAt: null });
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).refundedAmountCents).toBe(0);
        expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
        expect(await auditActions()).toEqual(["booking-payment.card-refund.try-card-again"]);
        // Still owed, now in flight: off the dead list, so neither close is offered until it is given up again.
        expect(await owedNow()).toBe(REFUND_CENTS);
        expect((await listDeadCardRefunds()).map((row) => row.operationId)).not.toContain(OPERATION_ID);
        await expect(nothingLeftOwed()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("being tried again") });
      });

      it("MUTATION: closed first: the re-arm is refused and writes nothing - a closed row is never re-armed", async () => {
        const { first, second } = await queuedBehindGlobalKey(payAnotherWay, tryAgain);

        expect(first).toMatchObject({ ok: true, value: { operationId: OPERATION_ID, amountCents: REFUND_CENTS } });
        expect(second.ok).toBe(false);
        expect((second as { error: unknown }).error).toBeInstanceOf(actions.DeadCardRefundActionError);
        expect((second as { error: { status: number; message: string } }).error).toMatchObject({ status: 409, message: "This card refund has already been closed." });

        const operation = await operationNow();
        expect(operation).toMatchObject({ status: "SUCCEEDED", attempts: 5, nextRetryAt: null });
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).refundedAmountCents).toBe(REFUND_CENTS);
        expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
        expect(await auditActions()).toEqual(["booking-payment.card-refund.paid-another-way"]);
        expect(await owedNow()).toBe(0);
        // The runner never claims it: nothing is ever sent for it.
        expect(await runPaymentRecoveryOperationNow(OPERATION_ID, CLUB_FORMAT_TEST)).toBe("not-claimed");
      });

      it("a double click re-arms once", async () => {
        const settled = await Promise.all([settle(tryAgain()), settle(tryAgain())]);
        expect(settled.filter((outcome) => outcome.ok)).toHaveLength(1);
        expect(settled.find((outcome) => !outcome.ok)).toMatchObject({ error: { status: 409 } });
        expect(await auditActions()).toEqual(["booking-payment.card-refund.try-card-again"]);
      });

      it("MUTATION: the row's plan moved under the Payment row while the re-arm waited: its claim matches nothing, and nothing is written", async () => {
        // A writer without lock(1) - the failed-later re-plan's shape - holds the Payment row and moves the dead row's plan.
        const holder = await holdOpen(async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${PAYMENT_ID} FOR NO KEY UPDATE`;
          await tx.paymentRecoveryOperation.update({
            where: { id: OPERATION_ID },
            data: { allocationPlan: [{ ...PLAN[0]!, stripeKeySuffix: "r1" }] },
          });
        });
        const rearming = settle(tryAgain());
        await waitForBlockedBy(holder.pid);
        holder.release();
        await holder.done;

        expect(await rearming).toMatchObject({ ok: false, error: { status: 409, message: expect.stringContaining("changed while you were settling it") } });
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
        expect(await auditActions()).toEqual([]);
      });
    });

    // ------------------------------------- Nothing left owed and a refund arriving

    describe("Nothing left owed against a refund arriving", () => {
      it("MUTATION: the refund recorded while the close waits for the Payment row is read by it: it closes, naming that refund, and moves no money", async () => {
        // `charge.refunded`: no advisory key, the Payment row first.
        const holder = await holdOpen(async (tx) => {
          await record("succeeded", tx);
        });
        const closing = settle(nothingLeftOwed());
        await waitForBlockedBy(holder.pid);
        holder.release();
        await holder.done;

        expect(await closing).toMatchObject({ ok: true, value: { coveredBy: [{ stripeRefundId: LATER_REFUND, amountCents: REFUND_CENTS }] } });
        expect(await operationNow()).toMatchObject({ status: "SUCCEEDED", lastError: actions.NOTHING_LEFT_OWED_MARKER, nextRetryAt: null });
        // Only Stripe's refund: the close recorded no money, no hand-back and no Xero row.
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).refundedAmountCents).toBe(REFUND_CENTS);
        expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
        expect(await prisma.xeroSyncOperation.count({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } })).toBe(0);
        expect(await auditActions()).toEqual(["booking-payment.card-refund.nothing-left-owed"]);
        expect(await owedNow()).toBe(0);
        expect((await listDeadCardRefunds()).map((row) => row.operationId)).not.toContain(OPERATION_ID);
      });

      it("MUTATION: the close first, with money still owed, is refused and writes nothing; once the refund arrives the list offers the close", async () => {
        await expect(nothingLeftOwed()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Something is owed") });
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
        expect(await auditActions()).toEqual([]);

        await record("succeeded");
        const row = (await listDeadCardRefunds()).find((each) => each.operationId === OPERATION_ID);
        expect(row).toMatchObject({ owedCents: 0, laterStripeRefunds: [{ stripeRefundId: LATER_REFUND, amountCents: REFUND_CENTS }] });
        expect(row?.tryCardAgainRefusal).toMatch(/Nothing is left owed/);
        await nothingLeftOwed(row!.laterStripeRefunds.map((each) => each.stripeRefundId));
        expect(await operationNow()).toMatchObject({ status: "SUCCEEDED" });
      });

      it("MUTATION: the row moved off dead under the Payment row while the close waited is not claimed", async () => {
        await record("succeeded");
        const holder = await holdOpen(async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${PAYMENT_ID} FOR NO KEY UPDATE`;
          // Moved off "dead" while still open, so the refund is still this row's and every read check passes:
          // only the claim's dead guard can refuse it. (A row closed outright reads nothing owed and is refused before
          // the claim - see the "closed first" case above.)
          await tx.paymentRecoveryOperation.update({
            where: { id: OPERATION_ID },
            data: { status: "PROCESSING", processingStartedAt: new Date() },
          });
        });
        const closing = settle(nothingLeftOwed());
        await waitForBlockedBy(holder.pid);
        holder.release();
        await holder.done;

        expect(await closing).toMatchObject({ ok: false, error: { status: 409, message: expect.stringContaining("changed while you were settling it") } });
        expect(await auditActions()).toEqual([]);
      });
    });

    describe("Nothing left owed against the covering refund failing later, through the real failed-later writer", () => {
      beforeEach(async () => {
        await record("succeeded");
        expect(await owedNow()).toBe(0);
      });

      it("MUTATION: the failure first: money is owed again, the close is refused - and with the failed-later row open, so is a re-arm (#4492)", async () => {
        const holder = await holdOpen(async (tx) => {
          await record("failed", tx);
        });
        const closing = settle(nothingLeftOwed());
        await waitForBlockedBy(holder.pid);
        holder.release();
        await holder.done;

        expect(await closing).toMatchObject({ ok: false, error: { status: 409, message: expect.stringContaining("Something is owed") } });
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
        expect(await auditActions()).toEqual([]);
        const failedLater = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: `card_refund_failed_later_${LATER_REFUND}` } });
        expect(failedLater).toMatchObject({ amountCents: REFUND_CENTS, status: "PENDING" });
        await expect(payAnotherWay()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("may be the same money") });
        expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
        expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, type: "BANK_REFUND" } })).toBe(0);
        // The #4492 pair: the given-up row and the failed-later row may be the same money; the re-arm is refused.
        await expect(tryAgain()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("failed later is on this payment") });
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
        expect((await listDeadCardRefunds()).find((row) => row.operationId === OPERATION_ID)?.tryCardAgainRefusal).toMatch(/failed later is on this payment/);

        // Review A: the failed-later row is re-sent and paid. The given-up row still reads its 5,000 owed, but the
        // member has had it back: a re-arm now would pay twice, so it is still refused.
        stripeRaceHooks.refund = async (args) => {
          asked.push({ idempotencyKey: args.idempotencyKey, amountCents: args.amountCents });
          return { id: "re_race_4368_resent", object: "refund", amount: args.amountCents, currency: "nzd", status: "succeeded",
            created: refundCreatedSeconds + 60, charge: CHARGE, payment_intent: args.paymentIntentId, metadata: args.metadata ?? {} };
        };
        expect(await runPaymentRecoveryOperationNow(failedLater.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        expect(asked).toEqual([expect.objectContaining({ amountCents: REFUND_CENTS })]);
        expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: failedLater.id } })).toMatchObject({ status: "SUCCEEDED" });
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
        await expect(tryAgain()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("failed later is on this payment") });
        await expect(payAnotherWay()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("may be the same money") });
        expect((await listDeadCardRefunds()).find((row) => row.operationId === OPERATION_ID)?.paidAnotherWayRefusal).toMatch(/may be the same money/);
        expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).refundedAmountCents).toBe(REFUND_CENTS);
        expect(asked).toHaveLength(1);
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
      });

      it("the close first: the failure is owed once more on a row of its own, never on the closed row", async () => {
        await nothingLeftOwed();
        await record("failed");

        expect(await operationNow()).toMatchObject({ status: "SUCCEEDED", lastError: actions.NOTHING_LEFT_OWED_MARKER });
        const raised = await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING_ID, id: { not: OPERATION_ID } } });
        expect(raised).toEqual([expect.objectContaining({ idempotencyKey: `card_refund_failed_later_${LATER_REFUND}`, amountCents: REFUND_CENTS })]);
        // Owed exactly once: the refund that failed, never the closed row's slice too.
        expect(await owedNow()).toBe(REFUND_CENTS);
      });
    });

    // ------------------------- review B and C: what the app cannot prove, it refuses

    describe("review B: a refund this row's own request made, unmatched, refuses the re-arm", () => {
      it("MUTATION: Stripe lists a refund with this row's door metadata and no slice key that nothing here accounts for: 409, nothing re-armed", async () => {
        const row = await operationNow();
        // Made under the row's key before refunds carried slice evidence, its answer lost; never recorded here.
        stripeRaceHooks.listRefunds = async () => [
          { ...stripeRefund("succeeded", cardRefundOperationRefundMetadata(row)), id: "re_race_4368_lost_answer" },
        ];
        await expect(tryAgain()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("re_race_4368_lost_answer") });
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
        expect(await auditActions()).toEqual([]);
      });

      it("MUTATION (review F1): $50 + $50, the first made by an unmarked own refund the owed figure counts: 409 - the runner would send both", async () => {
        const HALF = REFUND_CENTS / 2;
        await prisma.paymentRecoveryOperation.update({
          where: { id: OPERATION_ID },
          data: { allocationPlan: [{ paymentTransactionId: TRANSACTION_ID, amountCents: HALF }, { paymentTransactionId: TRANSACTION_ID, amountCents: HALF }] },
        });
        const row = await operationNow();
        // Slice 1's refund: made under the row's door with no slice key, recorded and matched - never marked on the plan.
        const made = { ...stripeRefund("succeeded", cardRefundOperationRefundMetadata(row)), id: "re_race_4368_unmarked", amount: HALF };
        await recordStripeRefundsAgainstTransaction({ paymentId: PAYMENT_ID, paymentTransactionId: TRANSACTION_ID, refunds: [made] as never, fallbackPaymentIntentId: INTENT });
        stripeRaceHooks.listRefunds = async () => [made];
        // The treasurer is shown $25.00 owed; the runner would send both unmarked slices, $50.00.
        expect(await owedNow()).toBe(HALF);
        await expect(
          actions.tryDeadCardRefundAgain({ operationId: OPERATION_ID, expectedOwedCents: HALF, actingMemberId: OFFICER_ID }),
        ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already refunded without being marked") });
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
        expect((await listDeadCardRefunds()).find((each) => each.operationId === OPERATION_ID)?.tryCardAgainRefusal).toMatch(/without being marked/);
        expect(await auditActions()).toEqual([]);
      });

      it("a refund Stripe lists with this row's metadata AND its slice key is the runner's to adopt: the re-arm goes ahead", async () => {
        const row = await operationNow();
        stripeRaceHooks.listRefunds = async () => [
          { ...stripeRefund("succeeded", { ...cardRefundOperationRefundMetadata(row), refundSliceKey: "a-slice-key" }), id: "re_race_4368_stamped" },
        ];
        await expect(tryAgain()).resolves.toMatchObject({ operationId: OPERATION_ID });
      });

      it("MUTATION: a Stripe list that cannot be read refuses the re-arm, and nothing is written", async () => {
        stripeRaceHooks.listRefunds = async () => {
          throw new Error("Stripe refund preflight is incomplete (INV-PAY-145); no refund was sent.");
        };
        await expect(tryAgain()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("could not be read") });
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
      });
    });

    describe("review S1: a superseded intent's refund with no plan is sized on its charge", () => {
      it("MUTATION: re-armed against what its charge holds, part refunded before; a legacy row with no plan is still refused", async () => {
        // The row becomes a superseded intent's refund of the charge, with no stored plan; Stripe refunded part of the
        // charge before the row was raised, so its runner sends only what the charge still holds.
        await prisma.paymentTransaction.update({ where: { id: TRANSACTION_ID }, data: { refundedAmountCents: PAID_CENTS - REFUND_CENTS } });
        await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: PAID_CENTS - REFUND_CENTS, status: "PARTIALLY_REFUNDED" } });
        await prisma.paymentRecoveryOperation.update({
          where: { id: OPERATION_ID },
          data: { type: "REFUND_SUPERSEDED_PAYMENT", paymentTransactionId: TRANSACTION_ID, allocationPlan: Prisma.DbNull },
        });
        await expect(tryAgain()).resolves.toMatchObject({ operationId: OPERATION_ID });
        expect(await operationNow()).toMatchObject({ status: "PENDING", attempts: 0 });
      });

      it("MUTATION (review R1): another door's refund of its charge, given to it by the owed figure, refuses the re-arm", async () => {
        // The superseded intent's whole charge is what its refund returns.
        await prisma.paymentTransaction.update({ where: { id: TRANSACTION_ID }, data: { amountCents: REFUND_CENTS } });
        await prisma.paymentRecoveryOperation.update({
          where: { id: OPERATION_ID },
          data: { type: "REFUND_SUPERSEDED_PAYMENT", paymentTransactionId: TRANSACTION_ID, allocationPlan: Prisma.DbNull },
        });
        // An edit's inline refund of part of the same charge, made after the row was raised: recorded, and taken by the
        // owed figure as this row's progress. Were it to fail later, it would be owed on a row of its own while this
        // row's runner re-sized on the ledger with its headroom back - so the re-arm is refused.
        const otherDoor = { ...stripeRefund("succeeded", { bookingId: BOOKING_ID, reason: "booking_modification" }), id: "re_race_4368_other_door", amount: 2_000 };
        await recordStripeRefundsAgainstTransaction({ paymentId: PAYMENT_ID, paymentTransactionId: TRANSACTION_ID, refunds: [otherDoor] as never, fallbackPaymentIntentId: INTENT });
        stripeRaceHooks.listRefunds = async () => [otherDoor];
        await expect(
          actions.tryDeadCardRefundAgain({ operationId: OPERATION_ID, expectedOwedCents: REFUND_CENTS - 2_000, actingMemberId: OFFICER_ID }),
        ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("part refunded by another refund (re_race_4368_other_door)") });
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
        expect(await auditActions()).toEqual([]);
      });

      it("MUTATION: a legacy booking modification's refund with no plan is refused, and points to Paid another way", async () => {
        await prisma.paymentRecoveryOperation.update({ where: { id: OPERATION_ID }, data: { allocationPlan: Prisma.DbNull } });
        await expect(tryAgain()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Settle it with Paid another way") });
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
      });
    });

    describe("review C: Nothing left owed names only what paid this row", () => {
      it("MUTATION: a $0 off the payment's cap alone - a dashboard refund of the whole charge, not this row's slice - is not listed and is refused", async () => {
        // A refund of the whole charge: the payment holds nothing more, but it fills no slice of this row.
        await recordStripeRefundsAgainstTransaction({
          paymentId: PAYMENT_ID,
          paymentTransactionId: TRANSACTION_ID,
          refunds: [{ ...stripeRefund("succeeded", {}), id: "re_race_4368_whole", amount: PAID_CENTS }] as never,
          fallbackPaymentIntentId: INTENT,
        });
        expect(await owedNow()).toBe(0);
        expect((await listDeadCardRefunds()).map((row) => row.operationId)).not.toContain(OPERATION_ID);
        await expect(nothingLeftOwed(["re_race_4368_whole"])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("No Stripe refund on this payment is matched") });
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5 });
      });
    });

    // ---------------------------------- the runner's Stripe check after a re-arm

    describe("re-armed, the runner's Stripe check runs before any send (INV-PAY-145)", () => {
      beforeEach(() => {
        stripeRaceHooks.refund = async (args) => {
          asked.push({ idempotencyKey: args.idempotencyKey, amountCents: args.amountCents });
          return {
            id: `re_race_4368_sent_${asked.length}`,
            object: "refund",
            amount: args.amountCents,
            currency: "nzd",
            status: "succeeded",
            created: refundCreatedSeconds + 60,
            charge: CHARGE,
            payment_intent: args.paymentIntentId,
            metadata: args.metadata ?? {},
          };
        };
      });

      it("MUTATION: a refund made outside the app since the debt arose holds the row again, and nothing is sent; Nothing left owed then closes it", async () => {
        stripeRaceHooks.listRefunds = async () => [stripeRefund("succeeded", {})];
        await tryAgain();
        await runPaymentRecoveryOperationNow(OPERATION_ID, CLUB_FORMAT_TEST);

        expect(asked).toEqual([]);
        expect(await operationNow()).toMatchObject({ status: "FAILED", attempts: 5, nextRetryAt: null });
        // The preflight recorded the dashboard refund; it covers the row, which now reads nothing left owed.
        const row = (await listDeadCardRefunds()).find((each) => each.operationId === OPERATION_ID);
        expect(row).toMatchObject({ owedCents: 0, laterStripeRefunds: [expect.objectContaining({ stripeRefundId: LATER_REFUND })] });
        await nothingLeftOwed();
        expect(await operationNow()).toMatchObject({ status: "SUCCEEDED" });
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).refundedAmountCents).toBe(REFUND_CENTS);
      });

      it("with nothing on the charge, exactly what is owed is sent, under the row's own key", async () => {
        stripeRaceHooks.listRefunds = async () => [];
        await tryAgain();
        expect(await runPaymentRecoveryOperationNow(OPERATION_ID, CLUB_FORMAT_TEST)).toBe("succeeded");

        expect(asked).toEqual([{ idempotencyKey: expect.stringContaining(`booking_cancel_refund_${BOOKING_ID}`), amountCents: REFUND_CENTS }]);
        expect(await operationNow()).toMatchObject({ status: "SUCCEEDED" });
        expect(await owedNow()).toBe(0);
      });
    });
  },
);
