/**
 * Real-PostgreSQL proof of #5228 (`INV-INT-025`): every writer that puts an
 * outbound Xero row with a queue type on PENDING leaves a request the outbox
 * can claim and send under that queue type - or writes nothing and leaves the
 * row where an officer sees it. Run against PostgreSQL because the guarded
 * write is a compare-and-set on a `jsonb` column, including its NULL.
 *
 * The writers, named in `xero-pending-writer-census.test.ts`, and where each
 * is proven:
 * - the guarded write itself (`returnOutboxRowToPending`): here, every branch;
 * - the outbox's cooldown give-back: `xero-cooldown-giveback-queued-request.realdb.test.ts`
 *   (five real handlers), and `xero-outbox-fail-fast.test.ts`;
 * - the outbox's busy-wait give-back: `xero-operation-outbox.test.ts`;
 * - an officer's Retry requeue (`requeueOutboxRowForRetry`) and the
 *   applied-credit Retry, queued in place: here, through `retryXeroSyncOperation`;
 *   the officer's REQUEUE row and its drain: `xero-stuck-queued-request.realdb.test.ts`;
 * - the kept late-capture requeues: `xero-kept-late-capture-invoice.test.ts`;
 * - the supplementary-invoice revival: `xero-operation-outbox.test.ts`,
 *   `late-capture-kept-xero.test.ts`;
 * - the WAITING_PAYMENT releases, and an enqueue: here.
 *
 * Every row here is seeded directly (synthetic ids, no booking behind them):
 * the writers under test read only the operation row. No Xero call is made.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-5228t-`
 * fixtures.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-5228t-";
const EXECUTION_REQUEST = { creditNotes: [{ total: 50 }], allocation: { invoiceId: "inv-x", amount: 50 }, refundMethod: "card" };
const QUEUED_NOTE = { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5_000, watermarkCents: 5_000 };
const GUARD = { status: "FAILED", manuallyResolvedAt: null } as const;
const CLEARED = { startedAt: null, completedAt: null, lastErrorCode: null, lastErrorMessage: null };

let prisma: PrismaClient;
let pending: typeof import("@/lib/xero-outbox-pending-request");
let payloads: typeof import("@/lib/xero-operation-outbox-payload");
let sequence = 0;

(RUN ? describe : describe.skip)(
  "every PENDING writer leaves a request the outbox can claim, or writes nothing - real PostgreSQL (#5228)",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "PENDING request transitions (#5228)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      pending = await import("@/lib/xero-outbox-pending-request");
      payloads = await import("@/lib/xero-operation-outbox-payload");
    });

    const clean = () => prisma.xeroSyncOperation.deleteMany({ where: { localId: { startsWith: PREFIX } } });
    afterEach(clean);
    afterAll(async () => {
      if (prisma) await clean();
    });

    /** One outbound row, seeded in the state a writer finds it in. */
    async function seed(row: {
      entityType?: string; operationType?: string; localModel?: string; queueType: string | null; status: string;
      requestPayload: Prisma.InputJsonValue | null;
    }) {
      const { requestPayload, ...rest } = row;
      return prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: `${PREFIX}${++sequence}`,
          startedAt: new Date("2026-06-30T00:00:00.000Z"), completedAt: new Date("2026-06-30T00:01:00.000Z"), lastErrorMessage: "refused",
          ...rest,
          ...(requestPayload === null ? {} : { requestPayload }),
        },
      });
    }

    const read = (id: string) =>
      prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id }, select: { status: true, queueType: true, requestPayload: true, startedAt: true, completedAt: true } });

    /** The invariant: a PENDING row holds a request the outbox can claim and send under its column. */
    async function claimable(id: string) {
      const row = await read(id);
      expect(row.status).toBe("PENDING");
      expect(payloads.readQueuedOutboxRequestFor(row.queueType, row.requestPayload), JSON.stringify(row.requestPayload)).not.toBeNull();
      return row;
    }

    describe("returnOutboxRowToPending", () => {
      it("MUTATION: replaces an execution request with the queued request the dispatch claimed", async () => {
        const row = await seed({ queueType: "REFUND_CREDIT_NOTE", status: "FAILED", requestPayload: EXECUTION_REQUEST });
        await expect(pending.returnOutboxRowToPending({ operationId: row.id, where: GUARD, data: CLEARED, request: { keep: true, fallback: QUEUED_NOTE } }))
          .resolves.toEqual({ outcome: "pending", requestWritten: true });
        expect(await claimable(row.id)).toMatchObject({ requestPayload: QUEUED_NOTE, startedAt: null, completedAt: null });
      });

      it("MUTATION: keeps what the handler recorded beside the queued request, never a key that changes how it reads", async () => {
        // A booking invoice's figures at link (`persistPrimaryInvoiceLink`) beside the invoice it sent.
        const atLink = { xeroInvoiceId: "inv-x", paymentIntentIdsRecordedAtLink: ["pi_x"] };
        const queuedInvoice = { queueType: "BOOKING_INVOICE", bookingId: `${PREFIX}booking` };
        const invoiceRow = await seed({ entityType: "INVOICE", queueType: "BOOKING_INVOICE", status: "FAILED", requestPayload: { invoices: [{ type: "ACCREC" }], primaryInvoiceBilledFee: atLink } });
        await pending.returnOutboxRowToPending({ operationId: invoiceRow.id, where: GUARD, data: CLEARED, request: { keep: true, fallback: queuedInvoice } });
        expect(await claimable(invoiceRow.id)).toMatchObject({ requestPayload: { ...queuedInvoice, primaryInvoiceBilledFee: atLink } });

        // A refund note's execution-time method and wording would turn the queued card note into a cash one: neither is kept.
        const noteRow = await seed({ queueType: "REFUND_CREDIT_NOTE", status: "FAILED", requestPayload: { ...EXECUTION_REQUEST, refundMethod: "internet-banking", noteWording: "cash" } });
        await pending.returnOutboxRowToPending({ operationId: noteRow.id, where: GUARD, data: CLEARED, request: { keep: true, fallback: QUEUED_NOTE } });
        const note = await claimable(noteRow.id);
        expect(note.requestPayload).not.toHaveProperty("refundMethod");
        expect(payloads.readQueuedOutboxPayload(note.requestPayload)).toEqual(payloads.readQueuedOutboxPayload(QUEUED_NOTE));
      });

      it("MUTATION: a second refusal keeps the second attempt's figures, never the first give-back's", async () => {
        const row = await seed({ queueType: "REFUND_CREDIT_NOTE", status: "FAILED", requestPayload: EXECUTION_REQUEST });
        await pending.returnOutboxRowToPending({ operationId: row.id, where: GUARD, data: CLEARED, request: { keep: true, fallback: QUEUED_NOTE } });
        // The next pass claims the layered request; the handler saves a fresh execution request with new figures, and is refused again.
        const firstGiveBack = (await claimable(row.id)).requestPayload as Prisma.JsonObject;
        expect(firstGiveBack).toMatchObject({ creditNotes: [{ total: 50 }], allocation: { amount: 50 } });
        const secondAttempt = { creditNotes: [{ total: 30 }], allocation: { invoiceId: "inv-y", amount: 30 } };
        await prisma.xeroSyncOperation.update({ where: { id: row.id }, data: { status: "FAILED", requestPayload: secondAttempt } });
        await expect(pending.returnOutboxRowToPending({ operationId: row.id, where: GUARD, data: CLEARED, request: { keep: true, fallback: firstGiveBack } }))
          .resolves.toEqual({ outcome: "pending", requestWritten: true });
        const second = await claimable(row.id);
        expect(second.requestPayload).toMatchObject({ ...QUEUED_NOTE, ...secondAttempt });
        expect(payloads.readQueuedOutboxPayload(second.requestPayload)).toEqual(payloads.readQueuedOutboxPayload(QUEUED_NOTE));
      });

      it("MUTATION: never lets a stored key dispatch reads outside the queued reading override the claimed request's value", async () => {
        // `refundRequestId` (link role, idempotency-key scope) and `reviewTaskId` (`queuedReviewTaskId`) leave
        // `readQueuedOutboxPayload` unchanged, so only the execution-record allow-list keeps a stored one out.
        const claimed = { ...QUEUED_NOTE, refundRequestId: "rr-claimed", reviewTaskId: "task-claimed" };
        const row = await seed({ queueType: "REFUND_CREDIT_NOTE", status: "FAILED", requestPayload: { ...EXECUTION_REQUEST, refundRequestId: "rr-stored", reviewTaskId: "task-stored" } });
        await expect(pending.returnOutboxRowToPending({ operationId: row.id, where: GUARD, data: CLEARED, request: { keep: true, fallback: claimed } }))
          .resolves.toEqual({ outcome: "pending", requestWritten: true });
        const written = (await claimable(row.id)).requestPayload;
        expect(written).toMatchObject({ refundRequestId: "rr-claimed", reviewTaskId: "task-claimed" });
        expect(written).toMatchObject({ creditNotes: EXECUTION_REQUEST.creditNotes, allocation: EXECUTION_REQUEST.allocation });
      });

      it("keeps a handler's checkpoint that is still a queued request, whatever its key order", async () => {
        const checkpoint = { watermarkCents: 5_000, documentDate: "2026-06-30", refundAmountCents: 5_000, queueType: "REFUND_CREDIT_NOTE" };
        const row = await seed({ queueType: "REFUND_CREDIT_NOTE", status: "FAILED", requestPayload: checkpoint });
        await expect(pending.returnOutboxRowToPending({ operationId: row.id, where: GUARD, data: CLEARED, request: { keep: true, fallback: QUEUED_NOTE } }))
          .resolves.toEqual({ outcome: "pending", requestWritten: false });
        expect(await claimable(row.id)).toMatchObject({ requestPayload: checkpoint });
      });

      it("a row with no stored request: restored from the claimed one, or, with none, left as it is", async () => {
        const restored = await seed({ queueType: "REFUND_CREDIT_NOTE", status: "FAILED", requestPayload: null });
        await expect(pending.returnOutboxRowToPending({ operationId: restored.id, where: GUARD, data: CLEARED, request: { keep: true, fallback: QUEUED_NOTE } }))
          .resolves.toMatchObject({ outcome: "pending" });
        await claimable(restored.id);

        const left = await seed({ queueType: "REFUND_CREDIT_NOTE", status: "FAILED", requestPayload: null });
        await expect(pending.returnOutboxRowToPending({ operationId: left.id, where: GUARD, data: CLEARED, request: { keep: true } }))
          .resolves.toEqual({ outcome: "unclaimable" });
        expect(await read(left.id)).toMatchObject({ status: "FAILED", requestPayload: null });
      });

      it.each([
        ["an execution request with nothing to put back", { keep: true } as const, EXECUTION_REQUEST],
        ["a replacement for another queue type", { replace: { queueType: "ACCOUNT_CREDIT_NOTE", refundAmountCents: 5_000 } }, QUEUED_NOTE],
        ["a replacement too incomplete to read", { replace: { queueType: "REFUND_CREDIT_NOTE" } }, QUEUED_NOTE],
        ["a fallback that is itself an execution request", { keep: true, fallback: EXECUTION_REQUEST } as const, EXECUTION_REQUEST],
      ])("MUTATION: writes nothing for %s; the row stays FAILED", async (_name, request, stored) => {
        const row = await seed({ queueType: "REFUND_CREDIT_NOTE", status: "FAILED", requestPayload: stored });
        await expect(pending.returnOutboxRowToPending({ operationId: row.id, where: GUARD, data: CLEARED, request })).resolves.toEqual({ outcome: "unclaimable" });
        expect(await read(row.id)).toMatchObject({ status: "FAILED", requestPayload: stored });
      });

      it("a row with no outbox queue type is never put on PENDING by it", async () => {
        const row = await seed({ queueType: null, status: "FAILED", requestPayload: QUEUED_NOTE });
        await expect(pending.returnOutboxRowToPending({ operationId: row.id, where: GUARD, data: CLEARED, request: { keep: true } })).resolves.toEqual({ outcome: "unclaimable" });
        expect((await read(row.id)).status).toBe("FAILED");
      });

      it("loses, writing nothing, when the caller's guard no longer matches", async () => {
        const row = await seed({ queueType: "REFUND_CREDIT_NOTE", status: "RUNNING", requestPayload: EXECUTION_REQUEST });
        await expect(pending.returnOutboxRowToPending({ operationId: row.id, where: GUARD, data: CLEARED, request: { keep: true, fallback: QUEUED_NOTE } }))
          .resolves.toEqual({ outcome: "lost" });
        expect(await read(row.id)).toMatchObject({ status: "RUNNING", requestPayload: EXECUTION_REQUEST });
      });

      it("MUTATION: loses, writing nothing, when another writer changes the stored request between its read and its write", async () => {
        const row = await seed({ queueType: "REFUND_CREDIT_NOTE", status: "FAILED", requestPayload: EXECUTION_REQUEST });
        const concurrent = { ...EXECUTION_REQUEST, creditNotes: [{ total: 70 }] };
        // The status guard still matches; only the request half of the compare-and-set can refuse the write.
        const store = {
          xeroSyncOperation: {
            findUnique: async (args: Prisma.XeroSyncOperationFindUniqueArgs) => {
              const read = await prisma.xeroSyncOperation.findUnique(args);
              await prisma.xeroSyncOperation.update({ where: { id: row.id }, data: { requestPayload: concurrent } });
              return read;
            },
            updateMany: (args: Prisma.XeroSyncOperationUpdateManyArgs) => prisma.xeroSyncOperation.updateMany(args),
          },
        } as unknown as Prisma.TransactionClient;
        await expect(pending.returnOutboxRowToPending({ operationId: row.id, where: GUARD, data: CLEARED, request: { keep: true, fallback: QUEUED_NOTE }, store }))
          .resolves.toEqual({ outcome: "lost" });
        expect(await read(row.id)).toMatchObject({ status: "FAILED", requestPayload: concurrent, completedAt: expect.any(Date) });
      });
    });

    describe("an officer's Retry, queued in place (`retryXeroSyncOperation`)", () => {
      const retry = async (id: string) => (await import("@/lib/xero-operation-retry")).retryXeroSyncOperation(id, CLUB_FORMAT_TEST);
      const allocation = (requestPayload: Prisma.InputJsonValue) =>
        seed({ entityType: "ALLOCATION", operationType: "ALLOCATE", queueType: "APPLIED_CREDIT_ALLOCATION", status: "FAILED", requestPayload });

      it("an applied-credit allocation goes back with its checkpointed queued request", async () => {
        const checkpoint = { queueType: "APPLIED_CREDIT_ALLOCATION", bookingId: `${PREFIX}booking`, allocatedNoteIds: ["cn-1"] };
        const row = await allocation(checkpoint);
        await expect(retry(row.id)).resolves.toEqual({ message: "Queued applied-credit allocation retry." });
        expect(await claimable(row.id)).toMatchObject({ requestPayload: checkpoint });
      });

      it("MUTATION: an applied-credit allocation holding no queued request is refused and left FAILED", async () => {
        const row = await allocation({ allocations: [{ invoice: { invoiceID: "inv-x" }, amount: 20 }] });
        await expect(retry(row.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("not queued again") });
        expect((await read(row.id)).status).toBe("FAILED");
      });

      it("a group settlement invoice whose worker overwrote its request goes back with the queued request rebuilt from the row", async () => {
        const row = await seed({
          entityType: "INVOICE", localModel: "GroupBookingSettlement", queueType: "GROUP_SETTLEMENT_INVOICE", status: "FAILED",
          requestPayload: { invoices: [{ type: "ACCREC" }] },
        });
        await expect(retry(row.id)).resolves.toMatchObject({ message: expect.stringContaining("group settlement invoice") });
        expect(await claimable(row.id)).toMatchObject({ requestPayload: { queueType: "GROUP_SETTLEMENT_INVOICE", settlementId: expect.stringContaining(PREFIX) } });
      });
    });

    describe("rows that were never dispatched", () => {
      it("a WAITING_PAYMENT supplementary invoice released for its payment holds its enqueue's queued request", async () => {
        const row = await seed({
          entityType: "INVOICE", localModel: "BookingModification", queueType: "SUPPLEMENTARY_INVOICE", status: "WAITING_PAYMENT",
          requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", bookingId: `${PREFIX}booking`, priceDiffCents: 3_000, changeFeeCents: 0, paymentIntentId: `pi_${PREFIX}` },
        });
        const { releaseWaitingSupplementaryInvoiceOperations } = await import("@/lib/xero-operation-outbox");
        await expect(releaseWaitingSupplementaryInvoiceOperations([row.id])).resolves.toMatchObject({ released: 1 });
        await claimable(row.id);
      });

      it("an enqueue writes the queue type column from the queued request it stores", async () => {
        const { startXeroSyncOperation } = await import("@/lib/xero-sync");
        const row = await startXeroSyncOperation({
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: `${PREFIX}enqueued`,
          status: "PENDING", requestPayload: QUEUED_NOTE,
        });
        expect(await claimable(row.id)).toMatchObject({ queueType: "REFUND_CREDIT_NOTE" });
      });
    });
  },
);
