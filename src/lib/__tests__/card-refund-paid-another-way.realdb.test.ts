/**
 * Real-PostgreSQL proof of the "Paid another way" close (#3372, owner 7 Oct
 * 2026: "Count + add close action").
 *
 * `closeCardRefundPaidAnotherWay` takes `lock(1)`, re-reads the operation, and
 * claims it with a status-guarded `updateMany` before it records any money. A
 * double click is two closes of one dead card refund at once: the global key
 * queues the second behind the first, and the second must then read the
 * operation closed and write NOTHING - no second allocation on the payment, no
 * second audit row. A mock can only imitate that queueing; this runs it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-3372-paw-` fixtures.
 *
 * #3924 round 4 (C1): the close takes the Payment row BEFORE it reads the
 * payment. The `charge.refunded` sync records a refund under that row lock and
 * no advisory key; a refund it records while the close waits for the row must
 * be read by the close, which then refuses an amount the refund already
 * covered - never pays the member a second time.
 *
 * #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit"): a late
 * capture's refund takes its approval task's row BEFORE it reads whether Xero
 * has the capture's receipt. The receipt's worker writes that receipt's link
 * under the same row; a close that waited behind it must read the receipt
 * recorded and queue its own note - never a second receipt and no note. And
 * with no receipt, the close queues the receipt and no note, and nothing may
 * size a note until the receipt's link and the note are written together.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3372-paw-member";
const OFFICER_ID = "race-3372-paw-officer";
const LODGE_ID = "race-3372-paw-lodge";
const BOOKING_ID = "race-3372-paw-booking";
const PAYMENT_ID = "race-3372-paw-payment";
const TRANSACTION_ID = "race-3372-paw-txn";
const OPERATION_ID = "race-3372-paw-op";
const APPROVAL_TASK_ID = "race-3372-paw-approval";
const LATE_INTENT = "pi_race_3372_paw";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");

const PAID_CENTS = 20_000;
// Small beside the payment, so a second allocation would still fit its headroom:
// only the claim can stop it.
const REFUND_CENTS = 5_000;

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Paid-another-way race proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run paid-another-way race proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Paid-another-way race proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Paid-another-way race proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let closeCardRefundPaidAnotherWay: (typeof import("@/lib/card-refund-paid-another-way"))["closeCardRefundPaidAnotherWay"];
let CardRefundPaidAnotherWayError: (typeof import("@/lib/card-refund-paid-another-way"))["CardRefundPaidAnotherWayError"];
let openCardRefundOwedCents: (typeof import("@/lib/open-card-refund-owed"))["openCardRefundOwedCents"];
let netCollectedCardRefundSelect: (typeof import("@/lib/additional-ledger-gap"))["netCollectedCardRefundSelect"];
let recordStripeRefundsAgainstTransaction: (typeof import("@/lib/payment-transactions"))["recordStripeRefundsAgainstTransaction"];
let realElapsedMs: (typeof import("@/lib/__tests__/helpers/clock"))["realElapsedMs"];
let resolveRefundNoteEligibleCash: (typeof import("@/lib/refund-note-eligible-cash"))["resolveRefundNoteEligibleCash"];
let notePaidAnotherWayCloseOnReceipt: (typeof import("@/lib/late-capture-refund-credit-note"))["notePaidAnotherWayCloseOnReceipt"];
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;

const LOCK_POLL_TIMEOUT_MS = 5_000;

(RUN ? describe : describe.skip)(
  "a dead card refund closes as paid another way exactly once — real PostgreSQL (#3372)",
  { timeout: 20_000 },
  () => {
    async function deleteCloseRecords() {
      await prisma.auditLog.deleteMany({ where: { entityId: OPERATION_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "ManualRefundTask", localId: APPROVAL_TASK_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localModel: "ManualRefundTask", localId: APPROVAL_TASK_ID } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await deleteCloseRecords();
      await prisma.paymentRecoveryOperation.deleteMany({ where: { id: OPERATION_ID } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    async function owedNow(): Promise<number> {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });
      return openCardRefundOwedCents(payment);
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ closeCardRefundPaidAnotherWay, CardRefundPaidAnotherWayError } = await import(
        "@/lib/card-refund-paid-another-way"
      ));
      ({ openCardRefundOwedCents } = await import("@/lib/open-card-refund-owed"));
      ({ netCollectedCardRefundSelect } = await import("@/lib/additional-ledger-gap"));
      ({ recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions"));
      ({ realElapsedMs } = await import("@/lib/__tests__/helpers/clock"));
      ({ resolveRefundNoteEligibleCash } = await import("@/lib/refund-note-eligible-cash"));
      ({ notePaidAnotherWayCloseOnReceipt } = await import("@/lib/late-capture-refund-credit-note"));
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
      lockHolderClient = separate("race-3372-paw-webhook");
      observerClient = separate("race-3372-paw-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Refund",
            lastName: "Proof",
            ageTier: "ADULT",
          },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3372 PAW Lodge", slug: "race-3372-paw" } });
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
      await deleteCloseRecords();
      await prisma.paymentRecoveryOperation.deleteMany({ where: { id: OPERATION_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      // An invoiced payment (#3924 round 5, F4: a note needs an invoice to
      // credit). The close queues its own note (an outbox row, cleaned up
      // above); Xero is not connected, so nothing runs it.
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PAID_CENTS,
          source: "STRIPE",
          status: "SUCCEEDED",
          xeroInvoiceId: "inv_race_3372_paw",
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: TRANSACTION_ID,
          paymentId: PAYMENT_ID,
          kind: "PRIMARY",
          source: "STRIPE",
          stripePaymentIntentId: "pi_race_3372_paw",
          amountCents: PAID_CENTS,
          status: "SUCCEEDED",
        },
      });
      // The cancellation's card refund, its five attempts spent.
      await prisma.paymentRecoveryOperation.create({
        data: {
          id: OPERATION_ID,
          type: "REFUND_BOOKING_MODIFICATION",
          status: "FAILED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: "pi_race_3372_paw",
          amountCents: REFUND_CENTS,
          allocationPlan: [{ paymentTransactionId: TRANSACTION_ID, amountCents: REFUND_CENTS }],
          idempotencyKey: `booking_cancel_refund_recovery_${BOOKING_ID}`,
          attempts: 5,
          nextRetryAt: null,
        },
      });
      expect(await owedNow()).toBe(REFUND_CENTS);
    });

    afterAll(async () => {
      await Promise.all(
        [lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())),
      );
      if (!prisma) return;
      await deleteFixtures();
    });

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
      throw new Error(`Timed out waiting for the close to queue behind the payment row held by pid ${blockerPid}.`);
    }

    const close = () =>
      closeCardRefundPaidAnotherWay({
        operationId: OPERATION_ID,
        amountCents: REFUND_CENTS,
        paidBack: "full",
        note: "Bank transfer, ref RACE",
        actingMemberId: OFFICER_ID,
      });

    it("a double click closes once: one allocation, one audit row, the other refused", async () => {
      const settled = await Promise.allSettled([close(), close()]);

      const fulfilled = settled.filter((outcome) => outcome.status === "fulfilled");
      const rejected = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(CardRefundPaidAnotherWayError);
      expect((rejected[0]?.reason as { status: number }).status).toBe(409);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });
      expect(payment.refundedAmountCents).toBe(REFUND_CENTS);
      const operation = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: OPERATION_ID } });
      expect(operation.status).toBe("SUCCEEDED");
      expect(operation.nextRetryAt).toBeNull();
      expect(await prisma.auditLog.count({ where: { entityId: OPERATION_ID } })).toBe(1);
      // It has left "Refunds owed": nothing is owed by card any more.
      expect(await owedNow()).toBe(0);
      // M2: one record, born COMPLETED, and one bank-refund line on it.
      const records = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID } });
      expect(records).toEqual([
        expect.objectContaining({
          status: "COMPLETED",
          kind: "CANCELLED_BOOKING_HAND_BACK",
          occurrenceKey: `card-refund-paid-another-way:${OPERATION_ID}`,
          amountCents: REFUND_CENTS,
          paymentId: PAYMENT_ID,
        }),
      ]);
      const lines = await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" } });
      expect(lines).toEqual([
        expect.objectContaining({ anchorKind: "REVIEW_TASK", anchorId: records[0]!.id, amountCents: -REFUND_CENTS }),
      ]);
      // M3: the cancellation's note, keyed on the record, for exactly the amount.
      const notes = await prisma.xeroSyncOperation.findMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      expect(notes).toHaveLength(1);
      expect(notes[0]!.correlationKey).toContain(records[0]!.id);
      expect(notes[0]!.requestPayload).toMatchObject({ refundAmountCents: REFUND_CENTS, refundMethod: "internet-banking" });
    });

    it("C1: a card refund recorded while the close waits for the payment row is read by the close, which refuses - the member is not paid twice", async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holderPid = 0;
      let recorded!: () => void;
      const recordedInHolder = new Promise<void>((resolve) => {
        recorded = resolve;
      });
      // The charge.refunded sync: no advisory key, the Payment row first. Stripe
      // did send the refund after all, for exactly the slice.
      const webhook = lockHolderClient.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          holderPid = pid;
          await recordStripeRefundsAgainstTransaction({
            paymentId: PAYMENT_ID,
            paymentTransactionId: TRANSACTION_ID,
            refunds: [
              {
                id: "re_race_3372_paw",
                amount: REFUND_CENTS,
                currency: "nzd",
                status: "succeeded",
                reason: null,
                created: Math.floor(Date.UTC(2030, 0, 1) / 1000),
                charge: "ch_race_3372_paw",
                payment_intent: "pi_race_3372_paw",
              },
            ] as never,
            fallbackPaymentIntentId: "pi_race_3372_paw",
            store: tx as never,
          });
          recorded();
          await released;
        },
        { timeout: 15_000 },
      );
      await recordedInHolder;

      const closing = close();
      await waitForBlockedBy(holderPid);
      release();
      await webhook;

      await expect(closing).rejects.toMatchObject({ status: 409 });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });
      // Only Stripe's refund: no second, by-hand allocation on top.
      expect(payment.refundedAmountCents).toBe(REFUND_CENTS);
      const operation = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: OPERATION_ID } });
      expect(operation.status).toBe("FAILED");
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { entityId: OPERATION_ID } })).toBe(0);
      // And it owes nothing more: the refund Stripe made filled its slice.
      expect(await owedNow()).toBe(0);
    });

    it("a refund still being retried is refused and nothing is written", async () => {
      await prisma.paymentRecoveryOperation.update({ where: { id: OPERATION_ID }, data: { attempts: 4 } });

      await expect(close()).rejects.toMatchObject({ status: 409 });

      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });
      expect(payment.refundedAmountCents).toBe(0);
      const operation = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: OPERATION_ID } });
      expect(operation.status).toBe("FAILED");
      expect(await prisma.auditLog.count({ where: { entityId: OPERATION_ID } })).toBe(0);
    });

    describe("round 6: a late card charge's refund - record the receipt, then credit it", () => {
      const KEPT_ROW = {
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "ManualRefundTask",
        localId: APPROVAL_TASK_ID,
        queueType: "KEPT_LATE_CAPTURE_INVOICE",
      } as const;
      const RECEIPT_LINK = {
        localModel: "ManualRefundTask",
        localId: APPROVAL_TASK_ID,
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_race_3372_paw_receipt",
        role: "KEPT_LATE_CAPTURE_INVOICE",
        active: true,
      };

      beforeEach(async () => {
        // The cancelled booking's charge was a late capture the treasurer
        // approved refunding; its card refund row is the approval's.
        await prisma.paymentRecoveryOperation.update({
          where: { id: OPERATION_ID },
          data: { idempotencyKey: `late_capture_approval_refund_recovery_${LATE_INTENT}` },
        });
        await prisma.manualRefundTask.create({
          data: {
            id: APPROVAL_TASK_ID,
            bookingId: BOOKING_ID,
            paymentId: PAYMENT_ID,
            kind: "DELETED_BOOKING_LATE_CAPTURE",
            status: "COMPLETED",
            lateCaptureApprovalIntentId: LATE_INTENT,
            amountCents: PAID_CENTS,
            completedAt: NIGHT,
            completedByMemberId: OFFICER_ID,
            reason: "Late capture approved for refund (race proof)",
          },
        });
      });

      const noteRows = () =>
        prisma.xeroSyncOperation.findMany({
          where: { localModel: "Payment", localId: PAYMENT_ID, queueType: "REFUND_CREDIT_NOTE" },
        });

      it("a close that waits on the approval task's row behind the receipt's worker reads the receipt recorded and queues its own note", async () => {
        // The worker claimed the receipt and sent it to Xero; its short
        // transaction now holds the task row and writes the receipt's link.
        await prisma.xeroSyncOperation.create({
          data: { ...KEPT_ROW, status: "RUNNING", idempotencyKey: "race-3372-paw-kept", correlationKey: "race-3372-paw-kept" },
        });
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let holderPid = 0;
        let linked!: () => void;
        const linkedInHolder = new Promise<void>((resolve) => {
          linked = resolve;
        });
        const worker = lockHolderClient.$transaction(
          async (tx) => {
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            holderPid = pid;
            await tx.$executeRaw`SELECT 1 FROM "ManualRefundTask" WHERE "id" = ${APPROVAL_TASK_ID} FOR UPDATE`;
            await tx.xeroObjectLink.create({ data: RECEIPT_LINK });
            linked();
            await released;
          },
          { timeout: 15_000 },
        );
        await linkedInHolder;

        const closing = close();
        await waitForBlockedBy(holderPid);
        release();
        await worker;
        const result = await closing;

        expect(result.xeroQueued).toBe("refund-note");
        const record = await prisma.manualRefundTask.findFirstOrThrow({
          where: { bookingId: BOOKING_ID, occurrenceKey: { startsWith: "card-refund-paid-another-way:" } },
        });
        expect(record.occurrenceKey).toBe(`card-refund-paid-another-way:${OPERATION_ID}`);
        const notes = await noteRows();
        expect(notes).toHaveLength(1);
        expect(notes[0]?.requestPayload).toMatchObject({ refundAmountCents: REFUND_CENTS, refundMethod: "internet-banking" });
        // One receipt: the worker's.
        expect(await prisma.xeroSyncOperation.count({ where: KEPT_ROW })).toBe(1);
      });

      it("with no receipt in Xero the close queues the receipt and no note; the receipt's link and the note are then written together", async () => {
        const result = await close();

        expect(result.xeroQueued).toBe("receipt-then-refund-note");
        const record = await prisma.manualRefundTask.findFirstOrThrow({
          where: { bookingId: BOOKING_ID, occurrenceKey: { startsWith: "card-refund-paid-another-way:" } },
        });
        expect(record.occurrenceKey).toBe(`card-refund-paid-another-way:${OPERATION_ID}:note-after-receipt`);
        const kept = await prisma.xeroSyncOperation.findMany({ where: KEPT_ROW });
        expect(kept).toEqual([
          expect.objectContaining({
            status: "PENDING",
            requestPayload: expect.objectContaining({ paymentIntentId: LATE_INTENT, capturedCents: PAID_CENTS }),
          }),
        ]);
        expect(await noteRows()).toHaveLength(0);
        // Until the receipt is in Xero, no note may be sized for the bank money.
        const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });
        expect((await resolveRefundNoteEligibleCash(payment)).eligibleCashCents).toBe(0);

        // The receipt's worker, once the invoice is in Xero: the link and the
        // note in one transaction under the task row
        // (`recordReceiptThenQueueItsPaidAnotherWayNote`).
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "ManualRefundTask" WHERE "id" = ${APPROVAL_TASK_ID} FOR UPDATE`;
          await tx.xeroObjectLink.create({ data: RECEIPT_LINK });
          await notePaidAnotherWayCloseOnReceipt({
            paymentIntentId: LATE_INTENT,
            clubZone: "Pacific/Auckland" as never,
            store: tx,
          });
        });

        const notes = await noteRows();
        expect(notes).toHaveLength(1);
        expect(notes[0]?.correlationKey).toContain(`paid-another-way:${record.id}`);
        expect(notes[0]?.requestPayload).toMatchObject({ refundAmountCents: REFUND_CENTS, refundMethod: "internet-banking" });
        expect((await resolveRefundNoteEligibleCash(payment)).eligibleCashCents).toBe(REFUND_CENTS);
      });
    });
  },
);
