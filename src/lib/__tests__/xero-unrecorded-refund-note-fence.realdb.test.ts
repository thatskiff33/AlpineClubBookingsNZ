/**
 * Real-PostgreSQL proof of #4688 (`INV-INT-028`): while Xero holds a refund
 * note on a payment that the app could not record - its create's record lost
 * its wait (#4656, `record-wait-lost`) - no later refund note on that payment
 * is sized or raised, however old the row is, until an officer's Resolve by
 * hand records it; the next note is then sized with it counted.
 *
 * The issue's example, on a card payment: a $50 refund's note A is made in
 * Xero but its record cannot get the Payment row in time; twenty minutes later
 * (past the 15-minute in-flight hold) a $30 refund arrives. Before #4688 the
 * app, counting nothing for the first refund, raised B on recorded coverage
 * alone, and the nightly self-heal asked for the whole $80 gap - Xero held more
 * notes than the refunds.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking; a $200 Stripe payment, its charge row and its
 *   refunds (`PaymentRefund`, as the webhook records them); the other
 *   connection that holds the Payment row past the record's whole budget,
 *   standing in for its longest holders; the row's age (its `startedAt`).
 * - REAL: the refund-note enqueue, the outbox worker raising each note against
 *   a fake Xero (no provider call), the record and its stamp, the audit writer
 *   and the once-ever alert's claim (only the email send replaced), Mark
 *   failed, the Retry all route and the retry enqueue, the nightly self-heal
 *   (`reconcileCreditBalances`), and the officer's Resolve by hand through its
 *   route, checked against the fake Xero.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4688-`
 * fixtures.
 */
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { raceSession } from "@/lib/__tests__/support/race-session-double";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

// The harness's one `@/lib/auth` double: the Retry all and resolve routes read the officer's session from it.
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4688";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const TXN_ID = `${P}-txn`;
const INTENT_ID = `pi_${P}`;
const INVOICE_ID = `inv-${P}`;
const CONTACT_ID = `${P}-contact`;
const NOTE_A = `${P}-note-a`;
const NOTE_B = `${P}-note-b`;
const PAID_CENTS = 20_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a refund note Xero made but the app could not record fences the payment's later refund notes until Resolve by hand - real PostgreSQL (#4688)",
  { timeout: 180_000 },
  () => {
    async function clearRun() {
      const ops = await prisma.xeroSyncOperation.findMany({ where: { localModel: "Payment", localId: PAYMENT_ID }, select: { id: true } });
      await prisma.alertCooldown.deleteMany({ where: { key: { in: ops.flatMap((op) => [NOTE_A, NOTE_B].map((note) => `xero-success-after-resolution:${op.id}:${note}`)) } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: OFFICER_ID }, { targetId: { in: [BOOKING_ID, ...ops.map((op) => op.id)] } }, { entityId: { in: ops.map((op) => op.id) } }] } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Unrecorded refund-note fence (#4688)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Fence", lastName: "Note", role, ageTier: "ADULT", canLogin: true },
        });
      }
      await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4688 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CONFIRMED", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
    }, 60_000);

    let send: ReturnType<typeof vi.fn>;
    beforeEach(async () => {
      await clearRun();
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, refundedAmountCents: 0, source: "STRIPE",
          status: "SUCCEEDED", stripePaymentIntentId: INTENT_ID, xeroInvoiceId: INVOICE_ID,
          transactions: {
            create: { id: TXN_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT_ID, amountCents: PAID_CENTS, status: "SUCCEEDED" },
          },
        },
      });
      const email = await import("@/lib/email");
      send = vi.fn(async () => ({ deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 }));
      vi.spyOn(email, "sendAdminXeroSyncErrorAlert").mockImplementation(send as never);
      raceSession.current = { user: { id: OFFICER_ID, role: "ADMIN", accessRoles: [{ role: "ADMIN" }], canLogin: true } };
    });

    afterEach(async () => {
      raceSession.current = null;
      vi.restoreAllMocks();
      await clearRun();
    });

    afterAll(async () => {
      raceSession.current = null;
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /** A Stripe refund as the webhook records it, and the payment's mirror. */
    async function stripeRefund(name: string, cents: number) {
      await prisma.paymentRefund.create({
        data: {
          paymentId: PAYMENT_ID, paymentTransactionId: TXN_ID, stripeRefundId: `re_${P}-${name}`, stripePaymentIntentId: INTENT_ID,
          amountCents: cents, currency: "nzd", status: "succeeded", stripeCreatedAt: new Date("2026-06-30T00:00:00.000Z"),
        },
      });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: { increment: cents }, status: "PARTIALLY_REFUNDED" } });
    }

    /** The refund's note, queued by the real enqueue as the refund webhook queues it. */
    async function queueNote(cents: number): Promise<string> {
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, cents);
      expect(queued.queueOperationId).toEqual(expect.any(String));
      return queued.queueOperationId!;
    }

    /** Every note the fake Xero raised, in order, with its amount in cents. */
    const xeroNotes: Array<{ id: string; cents: number }> = [];

    /** A fake Xero (no provider call): creates answer NOTE_A then NOTE_B; Resolve by hand finds NOTE_A, $50, for the member. */
    async function fakeXero() {
      xeroNotes.length = 0;
      const accountingApi = {
        createCreditNotes: async (_tenant: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }) => {
          const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
          const id = xeroNotes.length === 0 ? NOTE_A : NOTE_B;
          xeroNotes.push({ id, cents: Math.round(total * 100) });
          return { body: { creditNotes: [{ creditNoteID: id, creditNoteNumber: `CN-${id}`, total, remainingCredit: total, status: "AUTHORISED", payments: [] }] } };
        },
        createPayments: async (_tenant: string, body: { payments: Array<{ amount: number }> }) => ({
          body: { payments: [{ paymentID: `${P}-xero-payment-${xeroNotes.length}`, amount: body.payments[0]!.amount }] },
        }),
        getCreditNotes: async () => ({
          body: { creditNotes: [{ creditNoteID: NOTE_A, creditNoteNumber: `CN-${NOTE_A}`, status: "AUTHORISED", type: "ACCRECCREDIT", total: 50, contact: { contactID: CONTACT_ID }, allocations: [] }] },
        }),
        getInvoice: async () => ({ body: { invoices: [{ contact: { contactID: CONTACT_ID } }] } }),
        getCreditNote: async () => ({
          body: { creditNotes: [{ creditNoteID: NOTE_A, creditNoteNumber: `CN-${NOTE_A}`, status: "AUTHORISED", total: 50, appliedAmount: 0, remainingCredit: 50, allocations: [], payments: [] }] },
        }),
      };
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi }, tenantId: `tenant-${P}` } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
      vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue(CONTACT_ID);
      vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
        options.run({ contactId: options.currentContactId })) as never);
      vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "record", bankCode: "090" });
    }

    /** The outbox worker running `operationId` alone (oldest first is its order). */
    async function runOutbox(operationId: string) {
      await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${operationId}`;
      const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
      return processQueuedXeroOutboxOperations({ limit: 1 });
    }

    /** Holds the Payment row on another connection, as its longest holders do, for `holdMs`. */
    async function holdPaymentRow(holdMs: number) {
      let reportPid!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (reportPid = resolve));
      const done = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${PAYMENT_ID} FOR NO KEY UPDATE`;
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
        reportPid(pid);
        await new Promise((resolve) => setTimeout(resolve, holdMs));
      }, { maxWait: 10_000, timeout: holdMs + 30_000 });
      return { holderPid: await holderPid, done };
    }

    /** Poll until a backend waits on a lock `blockerPid` holds. */
    async function waitForBlockedBy(blockerPid: number) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < 10_000) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
        `;
        if ((rows[0]?.count ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for a writer to queue behind pid ${blockerPid}.`);
    }

    /** The $50 refund's note A, made in Xero while its record waits out a Payment-row holder: recorded nowhere. */
    async function noteALostItsWait(): Promise<string> {
      await stripeRefund("a", 5_000);
      const rowA = await queueNote(5_000);
      const { PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS } = await import("@/lib/payment-transactions");
      const holder = await holdPaymentRow(PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS.timeout + 3_000);
      const raised = runOutbox(rowA);
      await waitForBlockedBy(holder.holderPid);
      expect(await raised).toMatchObject({ failed: 0, succeeded: 0, skipped: 1 });
      await holder.done;
      expect(xeroNotes).toEqual([{ id: NOTE_A, cents: 5_000 }]);
      return rowA;
    }

    /** Ages the row's claim past the stale threshold, so the in-flight hold no longer counts it. */
    async function pastTheInFlightHold(operationId: string) {
      const { STALE_RUNNING_XERO_OPERATION_MINUTES } = await import("@/lib/xero-stale-operations");
      await prisma.xeroSyncOperation.update({
        where: { id: operationId },
        data: { startedAt: new Date(Date.now() - (STALE_RUNNING_XERO_OPERATION_MINUTES + 5) * 60_000) },
      });
    }

    /** The nightly self-heal, with this payment's refund older than its grace period. */
    async function nightlySelfHeal() {
      await prisma.$executeRaw`UPDATE "Payment" SET "updatedAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${PAYMENT_ID}`;
      const { reconcileCreditBalances } = await import("@/lib/cron-credit-reconciliation");
      return reconcileCreditBalances();
    }

    const createRows = () =>
      prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE" },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true },
      });

    it("MUTATION: past 15 minutes, a later refund's note, the nightly self-heal and Retry all raise nothing; Resolve by hand lifts the fence; the next note is sized with A counted", async () => {
      await fakeXero();
      const rowA = await noteALostItsWait();

      // The record stamped its row: RUNNING (never failed), naming no note, carrying the fence.
      const { XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE } = await import("@/lib/xero-operation-error-codes");
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: rowA }, select: { status: true, xeroObjectId: true, lastErrorCode: true } })).toEqual({
        status: "RUNNING", xeroObjectId: null, lastErrorCode: XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE,
      });
      const { LATE_REFUND_NOTE_NOT_RECORDED_ACTION } = await import("@/lib/xero-refund-note-record");
      expect(await prisma.auditLog.findMany({ where: { action: LATE_REFUND_NOTE_NOT_RECORDED_ACTION, entityId: rowA }, select: { metadata: true } })).toEqual([
        { metadata: expect.objectContaining({ reason: "record-wait-lost", laterNotesHeld: true, creditNoteId: NOTE_A }) },
      ]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: expect.stringContaining("the app raises no other refund note on this payment") }));

      // Twenty minutes on: the in-flight hold (#3880) no longer counts row A.
      await pastTheInFlightHold(rowA);
      const { findUnrecordedRefundNoteOperation } = await import("@/lib/xero-refund-note-in-flight");
      expect(await findUnrecordedRefundNoteOperation(PAYMENT_ID)).toEqual({ id: rowA });

      // 1. A later $30 Stripe refund's note is queued, and waits at the create: no Xero call.
      await stripeRefund("b", 3_000);
      const rowB = await queueNote(3_000);
      expect(await runOutbox(rowB)).toMatchObject({ succeeded: 0, failed: 0, skipped: 1 });
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: rowB }, select: { status: true, lastErrorMessage: true } })).toEqual({
        status: "PENDING", lastErrorMessage: expect.stringContaining(`until an officer resolves ${rowA} by hand`),
      });
      expect(xeroNotes).toHaveLength(1);

      // 2. The nightly self-heal lists the payment's gap but queues nothing for it.
      const healed = await nightlySelfHeal();
      expect(healed.refundsMissingXeroCreditNotes).toBeGreaterThanOrEqual(1);
      expect(await createRows()).toEqual([{ id: rowA, status: "RUNNING" }, { id: rowB, status: "PENDING" }]);

      // Mark failed keeps the fence: the row is FAILED, still carrying the code.
      const { markStaleRunningXeroOperationFailed } = await import("@/lib/xero-stale-operations");
      await expect(markStaleRunningXeroOperationFailed(rowA, async () => undefined)).resolves.toMatchObject({ outcome: "marked", returnedTo: "FAILED" });
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: rowA }, select: { status: true, lastErrorCode: true } })).toEqual({
        status: "FAILED", lastErrorCode: XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE,
      });
      expect(await findUnrecordedRefundNoteOperation(PAYMENT_ID)).toEqual({ id: rowA });

      // 3. Retry all skips row A with its reason, queueing no retry; a single Retry is refused.
      const { POST: retryAll } = await import("@/app/api/admin/xero/operations/retry-all/route");
      const retried = (await (await retryAll()).json()) as { skippedOperations?: Array<{ id: string; reason: string }> };
      expect(retried.skippedOperations).toContainEqual({ id: rowA, reason: expect.stringContaining("Do not retry") });
      const { XERO_REQUEUE_OPERATION_TYPE } = await import("@/lib/xero-hardening-shared");
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, operationType: XERO_REQUEUE_OPERATION_TYPE } })).toBe(0);
      const { enqueueXeroSyncOperationRetry } = await import("@/lib/xero-operation-queue");
      await expect(enqueueXeroSyncOperationRetry(rowA, { createdByMemberId: OFFICER_ID })).rejects.toThrow(/Do not retry/);
      // A later self-heal and run of B still raise nothing.
      await nightlySelfHeal();
      expect(await runOutbox(rowB)).toMatchObject({ skipped: 1 });
      expect(xeroNotes).toHaveLength(1);

      // 4. The officer resolves row A by hand with note A's number, through the real route: the fence lifts.
      const { POST: resolve } = await import("@/app/api/admin/xero/operations/[id]/resolve/route");
      const resolved = await resolve(
        new NextRequest(`http://localhost/api/admin/xero/operations/${rowA}/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Note A was made in Xero; recording it by hand", creditNoteNumber: `CN-${NOTE_A}` }),
        }),
        { params: Promise.resolve({ id: rowA }) },
      );
      expect(resolved.status).toBe(200);
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: rowA }, select: { xeroObjectId: true, manuallyResolvedAt: true } })).toEqual({
        xeroObjectId: NOTE_A, manuallyResolvedAt: expect.any(Date),
      });
      expect(await findUnrecordedRefundNoteOperation(PAYMENT_ID)).toBeNull();

      // 5. B now runs, sized with A counted: $30 at the $80 watermark - never $80.
      expect(await runOutbox(rowB)).toMatchObject({ succeeded: 1 });
      expect(xeroNotes).toEqual([{ id: NOTE_A, cents: 5_000 }, { id: NOTE_B, cents: 3_000 }]);
      const linkB = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: NOTE_B }, select: { metadata: true } });
      expect(linkB.metadata).toMatchObject({ amountCents: 3_000, watermarkCents: 8_000 });

      // And the self-heal finds nothing left to ask for.
      await nightlySelfHeal();
      expect((await createRows()).map((row) => row.id)).toEqual([rowA, rowB]);
      expect(xeroNotes).toHaveLength(2);
    });
  },
);
