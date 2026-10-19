/**
 * Real-PostgreSQL proof of #4214 (owner decision, 17 Oct 2026): an officer
 * re-raises a refund request's own Xero credit note that Xero voided.
 *
 * Two officers clicking "Raise a fresh credit note" at once queue ONE note:
 * both reach the request's link lock while another transaction holds it, then
 * run one after the other, and the second is refused with 409 because the
 * first's row is in flight. The REAL outbox then raises that note (Xero is a
 * stub): one live request note beside the voided one, under the after-void
 * key, with the refunded total untouched, so nothing is credited twice. A
 * third click, once the fresh note is live, is refused, and the request
 * leaves the Xero Operations list.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4214-`
 * fixtures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertNoForeignPendingXeroOperations } from "./support/race-harness-outbox-guard";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4214-member";
const LODGE_ID = "race-4214-lodge";
const BOOKING_ID = "race-4214-booking";
const PAYMENT_ID = "race-4214-payment";
const REQUEST_ID = "race-4214-request";
const VOIDED_NOTE = "cn-race-4214-voided";
const FRESH_NOTE = "cn-race-4214-fresh";
const REQUEST_KEY = `payment:${PAYMENT_ID}:refund-request-credit-note:${REQUEST_ID}:v1`;
const AFTER_VOID_KEY = `${REQUEST_KEY}:after-void:${VOIDED_NOTE}`;

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "an officer re-raises a refund request's voided Xero note once - real PostgreSQL (#4214)",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.auditLog.deleteMany({ where: { targetId: PAYMENT_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Refund-request note re-raise");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Reraise", lastName: "Proof", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4214 Lodge", slug: "race-4214" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CONFIRMED", totalPriceCents: 20_000, finalPriceCents: 20_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
      // The treasurer paid the request's $50 back by hand: the refunded total holds it.
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED",
          refundedAmountCents: 5_000, xeroInvoiceId: "inv-race-4214",
        },
      });
      // The request's note was raised and SUCCEEDED...
      await prisma.xeroSyncOperation.create({
        data: {
          id: "race-4214-op-raised", direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment",
          localId: PAYMENT_ID, status: "SUCCEEDED", idempotencyKey: REQUEST_KEY, correlationKey: REQUEST_KEY, queueType: "REFUND_CREDIT_NOTE",
          requestPayload: { allocation: { invoiceId: "inv-race-4214", amount: 50 }, refundMethod: "internet-banking", refundRequestId: REQUEST_ID },
          xeroObjectType: "CREDIT_NOTE", xeroObjectId: VOIDED_NOTE, completedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      // ...and then voided in Xero: the inbound sync wrote its mirror off (#4195).
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: VOIDED_NOTE, xeroObjectNumber: "CN-4214",
          role: "REFUND_REQUEST_CREDIT_NOTE", active: false, metadata: { amountCents: 5_000, refundRequestId: REQUEST_ID, status: "VOIDED" },
        },
      });
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /**
     * Poll until `count` backends wait on a lock: the first behind `blockerPid`
     * itself, the next behind the first (a row lock queues its waiters).
     */
    async function waitForBlockedBy(blockerPid: number, count: number) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < 10_000) {
        const rows = await prisma.$queryRaw<Array<{ direct: number; waiting: number }>>`
          SELECT COUNT(*) FILTER (WHERE ${blockerPid}::int = ANY(pg_blocking_pids(pid)))::int AS "direct",
                 COUNT(*) FILTER (WHERE cardinality(pg_blocking_pids(pid)) > 0)::int AS "waiting"
          FROM pg_stat_activity WHERE datname = current_database()
        `;
        if ((rows[0]?.direct ?? 0) >= 1 && (rows[0]?.waiting ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${count} re-raises to queue behind the link lock held by pid ${blockerPid}.`);
    }

    /** Swap in a fake Xero (no provider call) for the length of `run`. */
    async function withFakeXero<T>(accountingApi: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi }, tenantId: "tenant-4214" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-4214"),
        vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
          options.run({ contactId: options.currentContactId })) as never),
        // No bank-transfer refund account mapped: the note is left unsettled, which this proof does not read.
        vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: "race-4214" }),
      ];
      try {
        return await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    async function requestLinks() {
      const links = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT_ID, role: "REFUND_REQUEST_CREDIT_NOTE" },
        select: { xeroObjectId: true, active: true, metadata: true },
        orderBy: { xeroObjectId: "asc" },
      });
      return links.map((link) => ({ id: link.xeroObjectId, active: link.active, status: (link.metadata as Record<string, unknown>).status ?? null }));
    }

    it("two officers at once queue one note; the outbox raises it under the after-void key; a third click is refused", async () => {
      const { reraiseVoidedRefundRequestNote, listVoidedRefundRequestNotes } = await import("@/lib/xero-refund-request-note-reraise");
      const ours = async () => (await listVoidedRefundRequestNotes()).filter((request) => request.paymentId === PAYMENT_ID);
      expect(await ours()).toEqual([
        expect.objectContaining({ paymentId: PAYMENT_ID, refundRequestId: REQUEST_ID, amountCents: 5_000, activeOperationId: null }),
      ]);

      // Another transaction holds the request's link row, so both clicks reach the lock together.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (locked = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "XeroObjectLink" WHERE "localId" = ${PAYMENT_ID} AND "xeroObjectId" = ${VOIDED_NOTE} FOR UPDATE`;
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
          locked(pid);
          await released;
        },
        { timeout: 15_000 },
      );
      const pid = await holderPid;
      const clicks = Promise.allSettled([
        reraiseVoidedRefundRequestNote({ paymentId: PAYMENT_ID, refundRequestId: REQUEST_ID, actingMemberId: MEMBER_ID }),
        reraiseVoidedRefundRequestNote({ paymentId: PAYMENT_ID, refundRequestId: REQUEST_ID, actingMemberId: MEMBER_ID }),
      ]);
      await waitForBlockedBy(pid, 2);
      release();
      await holder;
      const outcomes = await clicks;

      const queued = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const refused = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(queued).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ name: "RefundRequestNoteReraiseError", status: 409 });
      const pending = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, status: "PENDING" },
        select: { correlationKey: true, idempotencyKey: true, requestPayload: true },
      });
      expect(pending).toEqual([
        {
          correlationKey: AFTER_VOID_KEY,
          idempotencyKey: AFTER_VOID_KEY,
          requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5_000, refundMethod: "internet-banking", refundRequestId: REQUEST_ID },
        },
      ]);
      expect(await prisma.auditLog.count({ where: { targetId: PAYMENT_ID, action: "xero.refund_request_note.reraised", category: "xero" } })).toBe(1);

      // The outbox raises it. A Xero that remembers the request's plain key would hand the voided note back.
      await assertNoForeignPendingXeroOperations(prisma, [PAYMENT_ID]);
      const keys: string[] = [];
      const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
      const result = await withFakeXero(
        {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }, _s?: unknown, _u?: unknown, key?: string) => {
            keys.push(key!);
            const replay = key === REQUEST_KEY;
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            return {
              body: {
                creditNotes: [{
                  creditNoteID: replay ? VOIDED_NOTE : FRESH_NOTE, creditNoteNumber: replay ? "CN-4214" : "CN-4214-2",
                  total, remainingCredit: total, status: "AUTHORISED", payments: [],
                }],
              },
            };
          },
          getCreditNote: async () => ({ body: { creditNotes: [] } }),
        },
        () => processQueuedXeroOutboxOperations({ limit: 1 }),
      );

      expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
      expect(keys).toEqual([AFTER_VOID_KEY]);
      // One live note for the request, beside the voided one: never a second credit.
      expect(await requestLinks()).toEqual([
        { id: FRESH_NOTE, active: true, status: null },
        { id: VOIDED_NOTE, active: false, status: "VOIDED" },
      ]);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true, xeroRefundCreditNoteId: true } });
      expect(payment).toEqual({ refundedAmountCents: 5_000, xeroRefundCreditNoteId: null });

      // A third click, now the fresh note is live, is refused and queues nothing.
      await expect(
        reraiseVoidedRefundRequestNote({ paymentId: PAYMENT_ID, refundRequestId: REQUEST_ID, actingMemberId: MEMBER_ID }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await prisma.xeroSyncOperation.count({ where: { localModel: "Payment", localId: PAYMENT_ID } })).toBe(2);
      expect(await ours()).toEqual([]);
    });
  },
);
