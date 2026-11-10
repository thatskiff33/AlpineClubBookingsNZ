/**
 * Real-PostgreSQL proof for #4838 (`INV-PAY-106`): a #2700 hand-back of a late
 * capture - the officer's "paid back by hand" on a `DELETED_BOOKING_LATE_CAPTURE`
 * task with no approval intent - reads what its capture still holds under the
 * booking's Payment row.
 *
 * The booking was cancelled and kept its $200.00 primary charge as a fee; its
 * $80.00 change payment was captured after the cancel. The hand-back's ledger
 * mirror (`applyLocalRefundAllocation`) is capped at the whole payment, not at
 * the capture, so the only thing standing between a dashboard refund of the
 * capture and a second, by-hand count of the same money on the primary's
 * headroom is the hand-back's own check that the capture still holds it
 * (`assertLateCaptureHandBackStillOwed`). Before #4838 that check read the
 * capture unlocked, and a `charge.refunded` sync committing before the claim
 * was missed: the ledger showed $160.00 returned for $80.00 the member got.
 *
 * Two phases, each through the REAL `resolveManualRefundTask` and the REAL
 * `recordStripeRefundsAgainstTransaction` on its own connection:
 *  1. the refund committed before the hand-back starts - it is read and the
 *     hand-back refused;
 *  2. the refund recorded and held uncommitted under the Payment row while the
 *     hand-back queues behind it (whole and part) - once it commits the
 *     hand-back reads it and refuses. Read before the row, it would not.
 * And a control: with nothing racing it the hand-back records its mirror.
 *
 * #4843: every case runs twice - on a typed `DELETED_BOOKING_LATE_CAPTURE` row,
 * and on a legacy row raised before `kind` existed (NULL kind, on a deleted
 * booking, with the confirm route's #2700 sentence), which only its reason
 * identifies (`isLateCaptureHandBackTask`). Before #4843 the legacy row was
 * handed back with no check at all.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4838-` fixtures. No Stripe call is made: a hand-back sends nothing.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4838-member";
const OFFICER_ID = "race-4838-officer";
const LODGE_ID = "race-4838-lodge";
const BOOKING_ID = "race-4838-booking";
const PAYMENT_ID = "race-4838-payment";
const PRIMARY_TX_ID = "race-4838-primary";
const LATE_TX_ID = "race-4838-late";
const TASK_ID = "race-4838-task";
const PRIMARY_INTENT = "pi_race_4838_primary";
const LATE_INTENT = "pi_race_4838_late";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
/** The cancellation's kept fee: captured, never refunded - the headroom a doubled mirror would land on. */
const PRIMARY_CENTS = 20_000;
const LATE_CENTS = 8_000;
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: PrismaClient;
let webhookClient: PrismaClient;
let observerClient: PrismaClient;
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let resolveManualRefundTask: (typeof import("@/lib/manual-refund-task-resolution"))["resolveManualRefundTask"];
let recordStripeRefundsAgainstTransaction: (typeof import("@/lib/payment-transactions"))["recordStripeRefundsAgainstTransaction"];
let reasons: { cancelled: string; deleted: string };

/** #4843: the row as raised today, and as a #2700 row raised before `kind` existed. */
const TASK_VARIANTS = [
  { label: "a typed DELETED_BOOKING_LATE_CAPTURE row", kind: "DELETED_BOOKING_LATE_CAPTURE" as const, legacy: false },
  { label: "a legacy row with no kind (#4843)", kind: null, legacy: true },
];

(RUN ? describe : describe.skip)(
  "a #2700 hand-back reads its late capture under the Payment row - real PostgreSQL (#4838)",
  { timeout: 30_000 },
  () => {
    async function deleteBookingRows() {
      await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: BOOKING_ID }, { entityId: TASK_ID }] } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, TASK_ID, LATE_TX_ID] } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { OR: [{ bookingId: BOOKING_ID }, { paymentId: PAYMENT_ID }] } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    /** The officer's "paid back by hand", through the whole completion door. */
    function handBack() {
      return resolveManualRefundTask(
        {
          taskId: TASK_ID,
          resolution: "completed",
          note: "paid back by bank transfer (race proof)",
          actingMemberId: OFFICER_ID,
          confirmedAmountCents: null,
          direction: "REFUND_TO_MEMBER",
          recordedNightPrices: null,
        },
        CLUB_FORMAT_TEST,
      );
    }

    /** Wait until some session is queued behind `blockerPid` (`pg_blocking_pids`). */
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
      throw new Error(`Timed out waiting for the hand-back to queue behind the Payment row held by pid ${blockerPid}.`);
    }

    function dashboardRefund(refundCents: number) {
      return [
        {
          id: `re_race_4838_${refundCents}`,
          amount: refundCents,
          currency: "nzd",
          status: "succeeded",
          reason: null,
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: "ch_race_4838_late",
          payment_intent: LATE_INTENT,
        },
      ] as never;
    }

    /** The `charge.refunded` sync of a dashboard refund of the late capture, committed. */
    function recordWebhookRefund(refundCents: number) {
      return recordStripeRefundsAgainstTransaction({
        paymentId: PAYMENT_ID,
        paymentTransactionId: LATE_TX_ID,
        refunds: dashboardRefund(refundCents),
        fallbackPaymentIntentId: LATE_INTENT,
      });
    }

    /**
     * The same sync on its own connection: it records the refund under the
     * Payment row and holds the row, uncommitted, until `release` is called.
     */
    async function holdWebhookRefund(refundCents: number) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let recorded!: () => void;
      const recordedInHolder = new Promise<void>((resolve) => {
        recorded = resolve;
      });
      let pid = 0;
      const done = webhookClient.$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
          pid = row?.pid ?? 0;
          await recordStripeRefundsAgainstTransaction({
            paymentId: PAYMENT_ID,
            paymentTransactionId: LATE_TX_ID,
            refunds: dashboardRefund(refundCents),
            fallbackPaymentIntentId: LATE_INTENT,
            store: tx as never,
          });
          recorded();
          await released;
        },
        { timeout: 20_000 },
      );
      await recordedInHolder;
      return { pid, release, done };
    }

    /** What the payment's ledger says went back, and how much of it on the kept fee. */
    async function ledgerNow() {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } });
      const primary = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: PRIMARY_TX_ID }, select: { refundedAmountCents: true } });
      return { refundedCents: payment.refundedAmountCents, primaryRefundedCents: primary.refundedAmountCents };
    }

    /** Refused: Stripe's refund alone stands, the kept fee untouched, and the task still OPEN to be dismissed. */
    async function expectRefusedLeavingStripesRefundAlone(refundCents: number) {
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: TASK_ID } })).toMatchObject({ status: "OPEN", completedAt: null });
      expect(await ledgerNow()).toEqual({ refundedCents: refundCents, primaryRefundedCents: 0 });
      expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: LATE_TX_ID } })).refundedAmountCents).toBe(refundCents);
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(1);
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Late-capture hand-back race");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));
      ({ resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution"));
      ({ recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions"));
      // The REAL builder: the frozen reason sentence is the key the hand-back finds its capture by.
      const { cancelledBookingModificationRefundReason, deletedBookingModificationRefundReason } = await import("@/lib/deleted-booking-modification-payment");
      reasons = { cancelled: cancelledBookingModificationRefundReason(LATE_INTENT), deleted: deletedBookingModificationRefundReason(LATE_INTENT) };
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
      webhookClient = separate("race-4838-webhook");
      observerClient = separate("race-4838-observer");
      await Promise.all([webhookClient.$connect(), observerClient.$connect()]);

      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Hand",
            lastName: "Back",
            ageTier: "ADULT",
          },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4838 Lodge", slug: "race-4838" } });
    });

    beforeEach(async () => {
      resetStripeRaceHooks();
      // A hand-back sends nothing to Stripe.
      stripeRaceHooks.refund = async () => {
        throw new Error("a #2700 hand-back never asks Stripe for a refund");
      };
      await deleteBookingRows();
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CANCELLED",
          totalPriceCents: PRIMARY_CENTS,
          finalPriceCents: PRIMARY_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PRIMARY_CENTS + LATE_CENTS,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: PRIMARY_INTENT,
        },
      });
      await prisma.paymentTransaction.createMany({
        data: [
          { id: PRIMARY_TX_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT, amountCents: PRIMARY_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
          { id: LATE_TX_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: LATE_INTENT, amountCents: LATE_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
        ],
      });
    });

    /**
     * The confirm route's open question about the late capture (#2700), no
     * approval intent. A legacy row (#4843) is what the route raised before
     * `kind` existed: NULL kind, on the deleted booking it is always raised on,
     * with its own sentence.
     */
    async function raiseTask(variant: (typeof TASK_VARIANTS)[number]) {
      if (variant.legacy) await prisma.booking.update({ where: { id: BOOKING_ID }, data: { deletedAt: new Date("2026-06-15T00:00:00.000Z") } });
      await prisma.manualRefundTask.create({
        data: {
          id: TASK_ID,
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          kind: variant.kind,
          status: "OPEN",
          amountCents: LATE_CENTS,
          raisedAmountCents: LATE_CENTS,
          reason: variant.legacy ? reasons.deleted : reasons.cancelled,
        },
      });
    }

    afterAll(async () => {
      resetStripeRaceHooks();
      await Promise.all(
        [webhookClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())),
      );
      if (!prisma) return;
      await deleteFixtures();
    });

    describe.each(TASK_VARIANTS)("$label", (variant) => {
    beforeEach(async () => {
      await raiseTask(variant);
      expect((await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: TASK_ID } })).kind).toBe(variant.kind);
    });

    it("control: with nothing racing it, the hand-back records the capture's money as handed back", async () => {
      const result = await handBack();

      expect(result.settlementRoute).toMatchObject({ kind: "local-allocation", refundCents: LATE_CENTS });
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: TASK_ID } })).toMatchObject({ status: "COMPLETED" });
      expect((await ledgerNow()).refundedCents).toBe(LATE_CENTS);
    });

    it("phase 1: a dashboard refund committed before the hand-back starts is read, and the hand-back refused", async () => {
      await recordWebhookRefund(LATE_CENTS);

      await expect(handBack()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already been refunded") });
      await expectRefusedLeavingStripesRefundAlone(LATE_CENTS);
    });

    // MUTATION (#4838): read the capture before the Payment row again and both cases fail - the hand-back reads the
    // capture untouched, waits for the row only at its allocation after the claim, and mirrors the $80.00 onto the
    // primary's kept fee on top of Stripe's refund. (#4843: gate the check on the kind alone again and the legacy
    // row's phase 1 and 2 cases fail too - it is not checked at all.)
    it.each([
      ["the whole capture", LATE_CENTS],
      ["part of the capture, leaving less than the task hands back", 3_000],
    ])("phase 2: a dashboard refund of %s recorded while the hand-back waits for the Payment row is read, and the hand-back refused", async (_label, refundCents) => {
      const webhook = await holdWebhookRefund(refundCents);

      const closing = handBack();
      // Handled at once: released, the hand-back can refuse before `await webhook.done` returns. Asserted below.
      closing.catch(() => undefined);
      await waitForBlockedBy(webhook.pid);
      webhook.release();
      await webhook.done;

      await expect(closing).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already been refunded") });
      await expectRefusedLeavingStripesRefundAlone(refundCents);
    });
    });
  },
);
