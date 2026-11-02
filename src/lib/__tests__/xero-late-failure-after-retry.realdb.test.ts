/**
 * Real-PostgreSQL proof of #4673 (`INV-INT-029`): a stalled Xero run's late
 * failure never undoes the Retry an officer queued after a stale reset. A
 * failure lands only on its own claim's row; one that lost its claim is dropped,
 * and the queued run writes its own outcome.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking, its payment row, and the Xero invoice in a fake Xero
 *   (a $60 organiser extra with $20 paid, $40 due).
 * - REAL: the organiser adjustment's queued row (`startXeroSyncOperation`), an
 *   in-place requeue type; the outbox worker running it
 *   (`processQueuedXeroOutboxOperations`) against the fake Xero, whose
 *   credit-note create answers or fails only when the test says (no provider
 *   call); the officer's Reset stale running
 *   (`markStaleRunningXeroOperationFailed`, given an instant past the stale
 *   threshold); the officer's Retry (`retryXeroSyncOperation`, which hands the
 *   row back to PENDING in place); and the outbox's failure write
 *   (`failXeroSyncOperation` under `outcomeWriteGuard`).
 *
 * Proven, each after a stall then a reset:
 * - Retry queued, then the stalled create fails: the row stays PENDING with no
 *   error, the stalled run counts it skipped, not failed, and the queued run
 *   raises its note and completes the row;
 * - Retry queued, the queued run fails under its own claim, then the stalled
 *   create fails: the row keeps the queued run's failure;
 * - control, no Retry: the stalled create's failure lands on its own claim's
 *   reset row, replacing the reset's message;
 * - PR #4687 review: Retry queued, the queued run fails, then the stalled run
 *   meets a pre-HTTP cooldown - the outbox's give-back to PENDING leaves the
 *   queued run's FAILED row and error as they are;
 * - PR #4687 review: a withdrawal cancels the reset row (FAILED to CANCELLED,
 *   `startedAt` kept, as `settleKeptLateCaptureRecordOnApproval` writes it),
 *   then the stalled run's handler self-fails without `keepCancelled` - the
 *   row stays CANCELLED. The withdrawal is that writer's status-guarded
 *   `updateMany` shape on this row, not the writer itself.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4673-`
 * fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { FROZEN_TEST_CLOCK_BASE_ISO, realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4673";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const INVOICE_ID = `${P}-extra-invoice`;
const NOTE_QUEUED = `${P}-note-queued`;
const STALE_MS = 16 * 60_000;
/** When the queued run claims the row: past the stale threshold, so its claim is a later one. */
const QUEUED_RUN_AT = new Date("2026-07-01T00:40:00.000Z");

let prisma: (typeof import("@/lib/prisma"))["prisma"];

interface FakeNote {
  creditNoteID: string;
  creditNoteNumber: string;
  total: number;
  status: string;
  allocations: Array<{ invoice: { invoiceID: string }; amount: number }>;
  payments: unknown[];
  lineItems: Array<{ description: string; quantity: number; unitAmount: number }>;
}

/** A fake Xero: one organiser extra invoice, and a credit-note create that answers or fails when the test says. */
function fakeXero() {
  const invoice = {
    invoiceID: INVOICE_ID, invoiceNumber: "EXTRA-1", contact: { contactID: `${P}-organiser-contact` },
    total: 60, amountPaid: 20, amountCredited: 0, amountDue: 40, status: "AUTHORISED",
  };
  const notes = new Map<string, FakeNote>();
  const creates: Array<{ answer: (id: string, number: string) => void; fail: (error: Error) => void }> = [];
  const allocations: string[] = [];
  const accountingApi = {
    getInvoice: async () => ({ body: { invoices: [{ ...invoice }] } }),
    createCreditNotes: (_tenant: string, body: { creditNotes: Array<{ lineItems: Array<{ description: string; unitAmount: number }> }> }) =>
      new Promise((resolve, reject) => {
        const line = body.creditNotes[0]!.lineItems[0]!;
        creates.push({
          answer: (id, number) => {
            const note: FakeNote = {
              creditNoteID: id, creditNoteNumber: number, total: line.unitAmount, status: "AUTHORISED", allocations: [], payments: [],
              lineItems: [{ description: line.description, quantity: 1, unitAmount: line.unitAmount }],
            };
            notes.set(id, note);
            resolve({ body: { creditNotes: [{ ...note }] } });
          },
          fail: reject,
        });
      }),
    getCreditNote: async (_tenant: string, id: string) => ({ body: { creditNotes: [structuredClone(notes.get(id))] } }),
    createCreditNoteAllocation: async (_tenant: string, id: string, body: { allocations: Array<{ invoice: { invoiceID: string }; amount: number }> }) => {
      const allocation = body.allocations[0]!;
      notes.get(id)!.allocations.push({ invoice: allocation.invoice, amount: allocation.amount });
      invoice.amountCredited += allocation.amount;
      invoice.amountDue -= allocation.amount;
      allocations.push(id);
      return { body: { allocations: [allocation] } };
    },
  };
  /** Waits (real time, bounded) until the n-th create has reached Xero. */
  async function reached(n: number): Promise<void> {
    const started = process.hrtime.bigint();
    while (creates.length < n) {
      if (realElapsedMs(started) > 20_000) throw new Error(`Credit-note create #${n} never reached the fake Xero`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return { accountingApi, creates, allocations, reached };
}

(RUN ? describe : describe.skip)(
  "a stalled Xero run's late failure never undoes an officer's in-place Retry - real PostgreSQL (#4673)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: BOOKING_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Late failure after an in-place Retry (#4673)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Late", lastName: "Failure", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4673 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 6_000, finalPriceCents: 6_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
      await prisma.payment.create({ data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 6_000, source: "INTERNET_BANKING", status: "SUCCEEDED" } });
    }, 60_000);

    let xero: ReturnType<typeof fakeXero>;
    beforeEach(async () => {
      await clearRun();
      xero = fakeXero();
      const apiClient = await import("@/lib/xero-api-client");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi: xero.accountingApi }, tenantId: `tenant-${P}` } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
      await clearRun();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /** The $40 waiver of the extra's unpaid balance, queued as the netting reserves it. */
    async function queuedWaiver(): Promise<string> {
      const { startXeroSyncOperation } = await import("@/lib/xero-sync");
      const key = `organiser-extra:${BOOKING_ID}:cut:waive:${INVOICE_ID}`;
      const row = await startXeroSyncOperation({
        direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Booking", localId: BOOKING_ID,
        status: "PENDING", correlationKey: key, idempotencyKey: key,
        requestPayload: {
          queueType: "ORGANISER_EXTRA_ADJUSTMENT", bookingId: BOOKING_ID, scopeId: "cut", modificationId: null, invoiceId: INVOICE_ID,
          amountCents: 4_000, purpose: "waive", cashAtPlanCents: 2_000, refundPercentage: 50,
        },
      });
      // Oldest first is the worker's order: this row goes first, alone.
      await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${row.id}`;
      return row.id;
    }

    async function runOutbox() {
      const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
      return processQueuedXeroOutboxOperations({ limit: 1 });
    }

    const row = (operationId: string) => prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });

    /** The run stalls at its credit-note create, and an officer presses Reset stale running once it is past the threshold. */
    async function stalledThenReset() {
      const operationId = await queuedWaiver();
      const stalled = runOutbox();
      await xero.reached(1);
      const { startedAt, status } = await row(operationId);
      expect(status).toBe("RUNNING");
      const { markStaleRunningXeroOperationFailed } = await import("@/lib/xero-stale-operations");
      const marked = await markStaleRunningXeroOperationFailed(operationId, async () => undefined, new Date(startedAt!.getTime() + STALE_MS));
      expect(marked).toMatchObject({ outcome: "marked", returnedTo: "FAILED" });
      return { operationId, stalled, stalledClaimAt: startedAt! };
    }

    /** The officer's Retry: an organiser row goes back to PENDING in place (`requeueOutboxRowForRetry`). */
    async function retry(operationId: string) {
      const { retryXeroSyncOperation } = await import("@/lib/xero-operation-retry");
      await expect(retryXeroSyncOperation(operationId, CLUB_FORMAT_TEST)).resolves.toMatchObject({ message: "Queued organiser invoice adjustment retry." });
      expect(await row(operationId)).toMatchObject({ status: "PENDING", startedAt: null, lastErrorCode: null, lastErrorMessage: null });
    }

    it("MUTATION: stall, reset, Retry queues the row, then the stalled create fails - the row stays PENDING, the stalled run counts it skipped, and the queued run completes", async () => {
      const { operationId, stalled } = await stalledThenReset();
      await retry(operationId);

      xero.creates[0]!.fail(new Error("Xero 500: the stalled create failed"));
      await expect(stalled).resolves.toMatchObject({ succeeded: 0, failed: 0, skipped: 1 });
      expect(await row(operationId)).toMatchObject({
        status: "PENDING", startedAt: null, completedAt: null, lastErrorCode: null, lastErrorMessage: null, xeroObjectId: null,
      });

      vi.setSystemTime(QUEUED_RUN_AT);
      const queued = runOutbox();
      await xero.reached(2);
      xero.creates[1]!.answer(NOTE_QUEUED, "CN-QUEUED");
      await expect(queued).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(await row(operationId)).toMatchObject({
        status: "SUCCEEDED", startedAt: QUEUED_RUN_AT, xeroObjectId: NOTE_QUEUED, lastErrorCode: null, lastErrorMessage: null,
      });
      expect(xero.allocations).toEqual([NOTE_QUEUED]);
    });

    it("MUTATION: stall, reset, Retry, the queued run fails under its own claim, then the stalled create fails - the row keeps the queued run's failure", async () => {
      const { operationId, stalled } = await stalledThenReset();
      await retry(operationId);

      vi.setSystemTime(QUEUED_RUN_AT);
      const queued = runOutbox();
      await xero.reached(2);
      xero.creates[1]!.fail(new Error("Xero 400: the queued run's own refusal"));
      await expect(queued).resolves.toMatchObject({ succeeded: 0, failed: 1 });
      const queuedFailure = await row(operationId);
      expect(queuedFailure).toMatchObject({ status: "FAILED", startedAt: QUEUED_RUN_AT });
      expect(queuedFailure.lastErrorMessage).toContain("the queued run's own refusal");

      xero.creates[0]!.fail(new Error("Xero 500: the stalled create failed"));
      await expect(stalled).resolves.toMatchObject({ succeeded: 0, failed: 0, skipped: 1 });
      const kept = await row(operationId);
      expect(kept).toMatchObject({ status: "FAILED", startedAt: QUEUED_RUN_AT, lastErrorMessage: queuedFailure.lastErrorMessage });
      expect(kept.completedAt?.getTime()).toBe(queuedFailure.completedAt?.getTime());
    });

    it("MUTATION (PR #4687 review): stall, reset, Retry, the queued run fails, then the stalled run meets a cooldown - the queued run's FAILED row is not given back", async () => {
      const { operationId, stalled } = await stalledThenReset();
      await retry(operationId);

      vi.setSystemTime(QUEUED_RUN_AT);
      const queued = runOutbox();
      await xero.reached(2);
      xero.creates[1]!.fail(new Error("Xero 400: the queued run's own refusal"));
      await expect(queued).resolves.toMatchObject({ succeeded: 0, failed: 1 });
      const queuedFailure = await row(operationId);
      expect(queuedFailure).toMatchObject({ status: "FAILED", startedAt: QUEUED_RUN_AT });

      xero.creates[0]!.fail(Object.assign(new Error("Xero cooldown: transient outage"), { name: "XeroTransientOutageError", preHttp: true }));
      const result = await stalled;
      expect(result).toMatchObject({ succeeded: 0, failed: 0, skipped: 1 });
      expect(result.cooldownDeferred).toBeUndefined();
      const kept = await row(operationId);
      expect(kept).toMatchObject({ status: "FAILED", startedAt: QUEUED_RUN_AT, lastErrorMessage: queuedFailure.lastErrorMessage });
      expect(kept.completedAt?.getTime()).toBe(queuedFailure.completedAt?.getTime());
    });

    it("MUTATION (PR #4687 review): stall, reset, a withdrawal cancels the row, then the stalled handler self-fails - the row stays CANCELLED", async () => {
      const { operationId, stalled, stalledClaimAt } = await stalledThenReset();
      const withdrawn = await prisma.xeroSyncOperation.updateMany({
        where: { id: operationId, status: { in: ["PENDING", "FAILED"] }, manuallyResolvedAt: null },
        data: { status: "CANCELLED", completedAt: new Date(), lastErrorCode: "WITHDRAWN_FOR_TEST", lastErrorMessage: "Withdrawn unsent." },
      });
      expect(withdrawn.count).toBe(1);

      // A handler's own catch, as the kept late-capture invoice's: no `keepCancelled`.
      const { failXeroSyncOperation } = await import("@/lib/xero-sync");
      await expect(failXeroSyncOperation({ id: operationId, startedAt: stalledClaimAt }, new Error("Xero 500: the stalled create failed"))).resolves.toBeNull();
      expect(await row(operationId)).toMatchObject({ status: "CANCELLED", startedAt: stalledClaimAt, lastErrorCode: "WITHDRAWN_FOR_TEST" });

      xero.creates[0]!.fail(new Error("Xero 500: the stalled create failed"));
      await expect(stalled).resolves.toMatchObject({ succeeded: 0, failed: 0, skipped: 1 });
      expect(await row(operationId)).toMatchObject({ status: "CANCELLED", lastErrorCode: "WITHDRAWN_FOR_TEST" });
    });

    it("control: stall, reset, no Retry, then the stalled create fails - the failure lands on its own claim's reset row", async () => {
      const { operationId, stalled, stalledClaimAt } = await stalledThenReset();
      const reset = await row(operationId);
      expect(reset.lastErrorCode).toBe("ORPHANED_STALE_RUNNING");

      xero.creates[0]!.fail(new Error("Xero 500: the stalled create failed"));
      await expect(stalled).resolves.toMatchObject({ succeeded: 0, failed: 1, skipped: 0 });
      const failed = await row(operationId);
      expect(failed).toMatchObject({ status: "FAILED", startedAt: stalledClaimAt });
      expect(failed.lastErrorCode).not.toBe("ORPHANED_STALE_RUNNING");
      expect(failed.lastErrorMessage).toContain("the stalled create failed");
    });
  },
);
