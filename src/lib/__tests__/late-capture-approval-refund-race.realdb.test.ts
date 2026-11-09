/**
 * Real-PostgreSQL proof for #4824 (`INV-PAY-106`): a treasurer's approval of a
 * held late capture plans its refund from what the capture still holds, read
 * under the booking's Payment row.
 *
 * A `charge.refunded` sync records a refund of the capture under that row
 * (`recordStripeRefundsAgainstTransaction`, no advisory key). Before #4824 the
 * approval read the capture first and took the row only before its claim, so a
 * refund committing in between was planned again: the task COMPLETED and its
 * refund debt owed money Stripe had already sent back. Here the sync holds the
 * row with the refund recorded and uncommitted, the REAL approval
 * (`resolveManualRefundTask`) queues behind it, and once the sync commits the
 * approval must read the refund and refuse - the task stays OPEN, no debt, no
 * Stripe call. A control approves the same capture with nothing racing it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4824-` fixtures. No Stripe call leaves the process: refunds go to the
 * harness's one shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
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

const MEMBER_ID = "race-4824-member";
const OFFICER_ID = "race-4824-officer";
const LODGE_ID = "race-4824-lodge";
const BOOKING_ID = "race-4824-booking";
const PAYMENT_ID = "race-4824-payment";
const PRIMARY_TX_ID = "race-4824-primary";
const LATE_TX_ID = "race-4824-late";
const TASK_ID = "race-4824-task";
const PRIMARY_INTENT = "pi_race_4824_primary";
const LATE_INTENT = "pi_race_4824_late";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const PRIMARY_CENTS = 20_000;
const LATE_CENTS = 8_000;
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: PrismaClient;
let webhookClient: PrismaClient;
let observerClient: PrismaClient;
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let resolveManualRefundTask: (typeof import("@/lib/manual-refund-task-resolution"))["resolveManualRefundTask"];
let recordStripeRefundsAgainstTransaction: (typeof import("@/lib/payment-transactions"))["recordStripeRefundsAgainstTransaction"];

(RUN ? describe : describe.skip)(
  "a late capture's approval plans under the Payment row - real PostgreSQL (#4824)",
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

    /** The treasurer's approval, through the whole completion door. */
    function approve() {
      return resolveManualRefundTask(
        {
          taskId: TASK_ID,
          resolution: "completed",
          note: null,
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
      throw new Error(`Timed out waiting for the approval to queue behind the Payment row held by pid ${blockerPid}.`);
    }

    /**
     * The `charge.refunded` sync of `refundCents` of the late capture, on its own
     * connection: it records the refund under the Payment row and holds the row,
     * uncommitted, until `release` is called.
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
            refunds: [
              {
                id: `re_race_4824_${refundCents}`,
                amount: refundCents,
                currency: "nzd",
                status: "succeeded",
                reason: null,
                created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
                charge: "ch_race_4824_late",
                payment_intent: LATE_INTENT,
              },
            ] as never,
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

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Late-capture approval refund race");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));
      ({ resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution"));
      ({ recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions"));
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
      webhookClient = separate("race-4824-webhook");
      observerClient = separate("race-4824-observer");
      await Promise.all([webhookClient.$connect(), observerClient.$connect()]);

      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Late",
            lastName: "Capture",
            ageTier: "ADULT",
          },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4824 Lodge", slug: "race-4824" } });
    });

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deleteBookingRows();
      // A cancelled card booking whose change payment was captured after the
      // cancel and held for a treasurer (the club's approval setting).
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
      await prisma.manualRefundTask.create({
        data: {
          id: TASK_ID,
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          kind: "DELETED_BOOKING_LATE_CAPTURE",
          status: "OPEN",
          lateCaptureApprovalIntentId: LATE_INTENT,
          amountCents: LATE_CENTS,
          raisedAmountCents: LATE_CENTS,
          reason: `The booking's change payment ${LATE_INTENT} was captured after the booking was cancelled (race proof).`,
        },
      });
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      await Promise.all(
        [webhookClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())),
      );
      if (!prisma) return;
      await deleteFixtures();
    });

    const approvalDebts = () =>
      prisma.paymentRecoveryOperation.findMany({
        where: { bookingId: BOOKING_ID, idempotencyKey: { startsWith: "late_capture_approval_refund_recovery_" } },
        select: { amountCents: true, allocationPlan: true },
      });

    it("control: with nothing racing it, the approval refunds the whole capture on its own charge", async () => {
      const asked: number[] = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.amountCents);
        return {
          id: "re_race_4824_approved",
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: "ch_race_4824_late",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };

      const result = await approve();

      expect(result.settlementRoute).toMatchObject({ kind: "late-capture-refund", paymentIntentId: LATE_INTENT });
      expect(asked).toEqual([LATE_CENTS]);
      expect(await approvalDebts()).toEqual([
        expect.objectContaining({ amountCents: LATE_CENTS, allocationPlan: [expect.objectContaining({ paymentTransactionId: LATE_TX_ID, amountCents: LATE_CENTS })] }),
      ]);
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: TASK_ID } })).toMatchObject({ status: "COMPLETED" });
    });

    // MUTATION (#4824): read the capture before the Payment row again and both cases fail - the approval plans the
    // whole capture from its stale read, waits for the row only at its claim, and completes over Stripe's refund.
    it.each([
      ["the whole capture", LATE_CENTS],
      ["part of the capture, leaving less than the task asks", 3_000],
    ])("a refund of %s recorded while the approval waits for the Payment row is read by the approval, which refuses", async (_label, refundCents) => {
      stripeRaceHooks.refund = async () => {
        throw new Error("no card refund may be asked for: the capture was refunded while the approval waited");
      };
      const webhook = await holdWebhookRefund(refundCents);

      const approving = approve();
      // Handled at once: released, the approval can refuse before `await webhook.done` returns. Asserted below.
      approving.catch(() => undefined);
      await waitForBlockedBy(webhook.pid);
      webhook.release();
      await webhook.done;

      await expect(approving).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already been refunded") });
      // Stripe's refund alone: the task is still OPEN for a treasurer to dismiss, and no second refund is owed.
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: TASK_ID } })).toMatchObject({ status: "OPEN", completedAt: null });
      expect(await approvalDebts()).toEqual([]);
      expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: LATE_TX_ID } })).refundedAmountCents).toBe(refundCents);
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(1);
    });
  },
);
