/**
 * Real-PostgreSQL proof of #4879 (`INV-PAY-150`): an edit financial review's
 * card refund and a "Paid another way" close leave a live superseded capture
 * to the refund that returns it.
 *
 * A superseded intent's refund with no stored plan (R) sizes its one request on
 * its charge's ledger. Both doors below used to plan or allocate newest-charge-
 * first over that same headroom, so they could take part of R's charge and R
 * then closed short. Run here through the real door, then the real
 * `runPaymentRecoveryOperationNow` on R. Closing R itself as paid another way
 * still records the money on R's own charge.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4879-` fixtures. Stripe is the harness's one shared double, refusing
 * any refund larger than what the charge still holds.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { releaseBookingFinancialHistoryForTeardown } from "./support/booking-financial-history-teardown";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The shared doubles: the LAST file to register a factory wins, so every realdb file registers these same ones. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4879-member";
const LODGE_ID = "race-4879-lodge";
const BOOKING_ID = "race-4879-booking";
const PAYMENT_ID = "race-4879-payment";
const PRIMARY_TXN = "race-4879-txn-primary";
const SUPERSEDED_TXN = "race-4879-txn-superseded";
const PRIMARY_INTENT = "pi_race_4879_primary";
const SUPERSEDED_INTENT = "pi_race_4879_superseded";
const MOD_ID = "race-4879-mod";
const DEAD_ROW_ID = "race-4879-dead-refund";
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const PRIMARY_CENTS = 13_000;
const SUPERSEDED_CENTS = 6_500;
const SLICE_CENTS = 4_000;
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let reconcilePaymentAggregates: (typeof import("@/lib/payment-transactions"))["reconcilePaymentAggregates"];
let lockPaymentForRefundedTotal: (typeof import("@/lib/payment-transactions"))["lockPaymentForRefundedTotal"];
let resolveManualRefundTask: (typeof import("@/lib/manual-refund-task-resolution"))["resolveManualRefundTask"];
let closeCardRefundPaidAnotherWay: (typeof import("@/lib/card-refund-paid-another-way"))["closeCardRefundPaidAnotherWay"];
let REVIEW_REFUND_EXCEEDS_CAPTURED_MESSAGE: string;
let keys: typeof import("@/lib/payment-recovery-keys");
let recoveryAlert: typeof import("@/lib/payment-recovery-alert");
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let realElapsedMs: (typeof import("@/lib/__tests__/helpers/clock"))["realElapsedMs"];
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;
let harnessRole: { restore: () => void } | undefined;

(RUN ? describe : describe.skip)(
  "an edit review and a Paid another way close leave a live superseded capture to its own refund - real PostgreSQL (#4879)",
  { timeout: 60_000 },
  () => {
    let alertSpy: MockInstance<(typeof import("@/lib/payment-recovery-alert"))["alertPaymentRecoveryOfficers"]>;
    let made: Array<{ paymentIntentId: string; amountCents: number }> = [];

    async function deleteBookingRows() {
      await prisma.emailLog.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: BOOKING_ID } } });
      const operations = await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { targetId: { in: [BOOKING_ID, PAYMENT_ID] } },
            { entityId: { in: [BOOKING_ID, PAYMENT_ID, MOD_ID, ...operations.map((row) => row.id), ...tasks.map((row) => row.id)] } },
          ],
        },
      });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID, ...tasks.map((row) => row.id)] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await releaseBookingFinancialHistoryForTeardown(prisma, [BOOKING_ID]);
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.updateMany({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * A booking paid in full on the primary charge, beside a later superseded charge.
     * "refund": captured, R live with no plan ("dead" spends its attempts).
     * "handing-off": not yet captured, its cancel row live.
     */
    async function seed(superseded: "refund" | "dead" | "handing-off" = "refund"): Promise<string> {
      const captured = superseded !== "handing-off";
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT,
          status: "PAID", totalPriceCents: PRIMARY_CENTS, finalPriceCents: PRIMARY_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PRIMARY_CENTS + (captured ? SUPERSEDED_CENTS : 0),
          source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: PRIMARY_INTENT,
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: PRIMARY_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT,
          amountCents: PRIMARY_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: SUPERSEDED_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE",
          stripePaymentIntentId: SUPERSEDED_INTENT, amountCents: SUPERSEDED_CENTS, status: captured ? "SUCCEEDED" : "PENDING",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      const row = await prisma.paymentRecoveryOperation.create({
        data: captured
          ? {
              type: "REFUND_SUPERSEDED_PAYMENT", status: superseded === "dead" ? "FAILED" : "PENDING", bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
              paymentTransactionId: SUPERSEDED_TXN, paymentIntentId: SUPERSEDED_INTENT, amountCents: SUPERSEDED_CENTS,
              idempotencyKey: keys.buildSupersededPaymentRefundRecoveryIdempotencyKey(SUPERSEDED_TXN, SUPERSEDED_INTENT),
              attempts: superseded === "dead" ? 5 : 0, nextRetryAt: superseded === "dead" ? null : new Date(0),
              createdAt: new Date("2026-06-15T00:00:00.000Z"),
            }
          : {
              type: "CANCEL_PAYMENT_INTENT", status: "PENDING", bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
              paymentTransactionId: SUPERSEDED_TXN, paymentIntentId: SUPERSEDED_INTENT, amountCents: SUPERSEDED_CENTS,
              idempotencyKey: `race-4879-cancel-${SUPERSEDED_INTENT}`, nextRetryAt: new Date(0),
              createdAt: new Date("2026-06-15T00:00:00.000Z"),
            },
      });
      return row.id;
    }

    const refunded = (id: string) => prisma.paymentTransaction.findUniqueOrThrow({ where: { id }, select: { refundedAmountCents: true } }).then((row) => row.refundedAmountCents);
    const madeOn = (paymentIntentId: string) => made.filter((refund) => refund.paymentIntentId === paymentIntentId).reduce((sum, refund) => sum + refund.amountCents, 0);

    /** An open edit financial review on the paid booking, completed through the real door. */
    async function completeReview(cents: number) {
      await prisma.bookingModification.create({
        data: { id: MOD_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "DATE_CHANGE", previousData: {}, newData: {}, priceDiffCents: -cents },
      });
      const task = await prisma.manualRefundTask.create({
        data: {
          bookingId: BOOKING_ID, paymentId: PAYMENT_ID, kind: "EDIT_FINANCIAL_REVIEW", status: "OPEN",
          amountCents: cents, raisedAmountCents: cents, occurrenceKey: "race-4879-review", reason: "race-4879 review",
          reviewContext: {
            version: 1,
            occurrence: {
              bookingId: BOOKING_ID, bookingGuestId: "race-4879-guest", cause: "NO_STORED_NIGHT_PRICES",
              surrenderedNightDates: ["2026-08-02"], addedNightDates: [],
              storedEvidence: { guestTotalCents: null, nightPrices: [] },
            },
            guestMemberId: MEMBER_ID, bookingCheckIn: "2026-08-01", bookingCheckOut: "2026-08-03", bookingModificationId: MOD_ID,
          },
        },
      });
      const settle = () =>
        resolveManualRefundTask(
          { taskId: task.id, resolution: "completed", note: "race-4879 review", actingMemberId: MEMBER_ID, confirmedAmountCents: cents, direction: "REFUND_TO_MEMBER", recordedNightPrices: null },
          CLUB_FORMAT_TEST,
        );
      return { taskId: task.id, settle };
    }

    /** The review's frozen card plan, as its refund debt stores it. */
    async function reviewPlan() {
      const debt = await prisma.paymentRecoveryOperation.findFirstOrThrow({
        where: { bookingId: BOOKING_ID, type: "REFUND_BOOKING_MODIFICATION" }, select: { allocationPlan: true },
      });
      return debt.allocationPlan as Array<{ paymentTransactionId: string; amountCents: number }>;
    }

    /** A different dead card refund with no stored plan, its five attempts spent: nothing it prefers. */
    async function deadPlanlessRefund() {
      await prisma.paymentRecoveryOperation.create({
        data: {
          id: DEAD_ROW_ID, type: "REFUND_BOOKING_MODIFICATION", status: "FAILED", bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
          paymentIntentId: PRIMARY_INTENT, amountCents: SLICE_CENTS, idempotencyKey: "race-4879-dead-refund",
          attempts: 5, nextRetryAt: null, createdAt: new Date("2026-06-20T00:00:00.000Z"),
        },
      });
    }

    const paidAnotherWay = (operationId: string, cents: number) =>
      closeCardRefundPaidAnotherWay({
        operationId, amountCents: cents, paidBack: "full", expectedOwedCents: cents,
        note: "Bank transfer, ref RACE-4879", actingMemberId: MEMBER_ID,
      });

    async function returnCapture(rowId: string) {
      expect(await refunded(SUPERSEDED_TXN)).toBe(0);
      expect(madeOn(SUPERSEDED_INTENT)).toBe(0);
      expect(await runPaymentRecoveryOperationNow(rowId, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(madeOn(SUPERSEDED_INTENT)).toBe(SUPERSEDED_CENTS);
      expect(await refunded(SUPERSEDED_TXN)).toBe(SUPERSEDED_CENTS);
    }

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

    /** The hand-off holds the Payment row with the charge flipped captured and its cancel row still in flight. */
    async function behindHandoff(door: () => Promise<unknown>) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let ready!: (pid: number) => void;
      const started = new Promise<number>((resolve) => { ready = resolve; });
      const done = lockHolderClient.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        await lockPaymentForRefundedTotal(tx, PAYMENT_ID);
        await tx.paymentRecoveryOperation.updateMany({
          where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT" },
          data: { status: "PROCESSING", processingStartedAt: new Date() },
        });
        await tx.paymentTransaction.update({ where: { id: SUPERSEDED_TXN }, data: { status: "SUCCEEDED" } });
        await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: tx });
        ready(pid);
        await released;
      }, { timeout: 20_000 });
      const pid = await started;
      const pending = door();
      await waitForBlockedBy(pid);
      release();
      await done;
      return pending;
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4879 superseded capture at the edit review and Paid another way");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      ({ runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ reconcilePaymentAggregates, lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions"));
      ({ resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution"));
      ({ closeCardRefundPaidAnotherWay } = await import("@/lib/card-refund-paid-another-way"));
      ({ REVIEW_REFUND_EXCEEDS_CAPTURED_MESSAGE } = await import("@/lib/edit-financial-review-refund-refusals"));
      keys = await import("@/lib/payment-recovery-keys");
      recoveryAlert = await import("@/lib/payment-recovery-alert");
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));
      ({ realElapsedMs } = await import("@/lib/__tests__/helpers/clock"));
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"), import("@/lib/prisma-adapter"),
      ]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = separate("race-4879-holder");
      observerClient = separate("race-4879-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);
      await deleteFixtures();
      await prisma.member.create({ data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Ada", lastName: "Proof", ageTier: "ADULT" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4879 Lodge", slug: "race-4879" } });
    }, 60_000);

    beforeEach(async () => {
      await deleteBookingRows();
      resetStripeRaceHooks();
      alertSpy = vi.spyOn(recoveryAlert, "alertPaymentRecoveryOfficers").mockResolvedValue(null);
      made = [];
      const capturedByIntent = new Map([[PRIMARY_INTENT, PRIMARY_CENTS], [SUPERSEDED_INTENT, SUPERSEDED_CENTS]]);
      stripeRaceHooks.refund = async (args) => {
        const left = (capturedByIntent.get(args.paymentIntentId) ?? 0) - madeOn(args.paymentIntentId);
        if (args.amountCents > left) throw new Error(`Refund amount (${args.amountCents}) is greater than unrefunded amount on charge (${left})`);
        made.push({ paymentIntentId: args.paymentIntentId, amountCents: args.amountCents });
        return {
          id: `re_race_4879_${made.length}`, object: "refund", amount: args.amountCents, currency: "nzd", status: "succeeded",
          reason: "requested_by_customer", created: 4_070_908_800, charge: `ch_${args.paymentIntentId}`,
          payment_intent: args.paymentIntentId, metadata: args.metadata ?? {},
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
        await Promise.all([lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())));
        if (typeof prisma !== "undefined") await deleteFixtures();
      } finally {
        harnessRole?.restore();
      }
    });

    describe("an edit financial review's card refund", () => {
      it("is planned only on the booking's charge, and R returns the whole capture", async () => {
        const supersededRefund = await seed();
        const review = await completeReview(SLICE_CENTS);
        await review.settle();
        expect(await reviewPlan()).toEqual([expect.objectContaining({ paymentTransactionId: PRIMARY_TXN, amountCents: SLICE_CENTS })]);
        expect(made).toEqual([{ paymentIntentId: PRIMARY_INTENT, amountCents: SLICE_CENTS }]);
        await returnCapture(supersededRefund);
      });

      it("is refused, the task left open, when only the superseded charge could make up the amount", async () => {
        const supersededRefund = await seed();
        const review = await completeReview(PRIMARY_CENTS + SLICE_CENTS);
        await expect(review.settle()).rejects.toMatchObject({ message: REVIEW_REFUND_EXCEEDS_CAPTURED_MESSAGE });
        expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: review.taskId }, select: { status: true } })).toEqual({ status: "OPEN" });
        expect(made).toEqual([]);
        await returnCapture(supersededRefund);
      });

      it("waits out the hand-off on the Payment row, then plans around the capture it flipped", async () => {
        await seed("handing-off");
        const review = await completeReview(SLICE_CENTS);
        await behindHandoff(review.settle);
        expect(JSON.stringify(await reviewPlan())).not.toContain(SUPERSEDED_TXN);
        expect(await refunded(SUPERSEDED_TXN)).toBe(0);
        expect(madeOn(SUPERSEDED_INTENT)).toBe(0);
        expect(madeOn(PRIMARY_INTENT)).toBe(SLICE_CENTS);
      });
    });

    describe("a Paid another way close", () => {
      it("of a different plan-less dead refund records the money on the booking's charge, and R returns the whole capture", async () => {
        const supersededRefund = await seed();
        await deadPlanlessRefund();
        await paidAnotherWay(DEAD_ROW_ID, SLICE_CENTS);
        expect(await refunded(PRIMARY_TXN)).toBe(SLICE_CENTS);
        expect(await refunded(SUPERSEDED_TXN)).toBe(0);
        await returnCapture(supersededRefund);
      });

      it("of the superseded refund itself records the money on its own charge and asks Stripe for nothing", async () => {
        const supersededRefund = await seed("dead");
        await paidAnotherWay(supersededRefund, SUPERSEDED_CENTS);
        expect(await refunded(SUPERSEDED_TXN)).toBe(SUPERSEDED_CENTS);
        expect(await refunded(PRIMARY_TXN)).toBe(0);
        expect(made).toEqual([]);
      });

      it("waits out the hand-off on the Payment row, then leaves the capture it flipped alone", async () => {
        await seed("handing-off");
        await deadPlanlessRefund();
        await behindHandoff(() => paidAnotherWay(DEAD_ROW_ID, SLICE_CENTS));
        expect(await refunded(SUPERSEDED_TXN)).toBe(0);
        expect(await refunded(PRIMARY_TXN)).toBe(SLICE_CENTS);
      });
    });
  },
);
