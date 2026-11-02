/**
 * Real-PostgreSQL proof of #4656 (`INV-INT-028`, `INV-INT-029`, `INV-ADDPAY-041`):
 * the payment refund-note create's record (`recordCreatedRefundNote`) asks that
 * no other create row records its note under the Payment row, and waits for that
 * row on its own budget; a wait that still runs out records nothing, fails
 * nothing, and is traced.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking; a $200 Internet Banking payment and its charge row;
 *   for the freshness race, two RUNNING create rows on the payment (two runs
 *   Xero answered with one note, as one key does); the other connection that
 *   holds the Payment row, standing in for its longest holders (the nightly
 *   bank-refund void follow-up, a group cancel's enqueue).
 * - REAL: the record itself, with its real link writer; for the timeout, the
 *   hand-back's completion (`resolveManualRefundTask`) queueing the note and the
 *   outbox worker (`processQueuedXeroOutboxOperations`) raising it against a
 *   fake Xero (no provider call), the once-ever alert's claim with only the
 *   email send replaced, and the audit writer.
 *
 * Proven:
 * 1. Two records of one note on two rows, the first held inside its
 *    transaction: the second queues on the Payment row - though neither note
 *    takes the pointer - and is refused fresh once the first commits. One row
 *    names the note, one link records it.
 * 2. A record behind a Payment row held past Prisma's 5s default still records.
 * 3. A record behind a Payment row held past its whole budget writes nothing:
 *    no pointer, no link, no note on the row, no settlement; the row stays
 *    RUNNING (never FAILED), one `xero` audit row and one alert name the note.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4656-`
 * fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4656";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const TXN_ID = `${P}-bank-txn`;
const INVOICE_ID = `${P}-invoice`;
const HAND_BACK_ID = `${P}-hand-back`;
const NOTE = `${P}-note`;

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "the refund-note create's record checks its note fresh under the Payment row and survives a long holder - real PostgreSQL (#4656)",
  { timeout: 120_000 },
  () => {
    async function clearRun() {
      const ops = await prisma.xeroSyncOperation.findMany({ where: { localModel: "Payment", localId: PAYMENT_ID }, select: { id: true } });
      await prisma.alertCooldown.deleteMany({ where: { key: { in: ops.flatMap((op) => [`xero-success-after-resolution:${op.id}:${NOTE}`, `xero-success-after-resolution:${op.id}`]) } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: OFFICER_ID }, { targetId: BOOKING_ID }, { entityId: { in: ops.map((op) => op.id) } }] } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Refund-note record gaps (#4656)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Record", lastName: "Gap", role, ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4656 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
    }, 60_000);

    let send: ReturnType<typeof vi.fn>;
    beforeEach(async () => {
      await clearRun();
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
      });
      await prisma.paymentTransaction.create({
        data: { id: TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 20_000, status: "SUCCEEDED" },
      });
      const email = await import("@/lib/email");
      send = vi.fn(async () => ({ deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 }));
      vi.spyOn(email, "sendAdminXeroSyncErrorAlert").mockImplementation(send as never);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await clearRun();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /** A RUNNING create row on the payment, as a run that has called Xero leaves it. */
    async function runningCreateRow(name: string): Promise<string> {
      const row = await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "RUNNING", startedAt: new Date(), idempotencyKey: `${P}-${name}`, correlationKey: `${P}-${name}`,
        },
        select: { id: true },
      });
      return row.id;
    }

    /** The record of NOTE on `operationId`, as the create makes it; a per-refund note by default (no pointer). */
    async function record(operationId: string, writesPointer = false) {
      const { recordCreatedRefundNote } = await import("@/lib/xero-refund-note-record");
      return recordCreatedRefundNote({
        paymentId: PAYMENT_ID, bookingId: BOOKING_ID, operationId, creditNoteId: NOTE, creditNoteNumber: "CN-4656", amountCents: 20_000,
        xeroStatus: "AUTHORISED", writesPointer, linkRole: "REFUND_CREDIT_NOTE", linkMetadata: { amountCents: 20_000, perDelta: true },
      });
    }

    /** Holds the FIRST record to reach its link write inside its transaction, reporting its backend pid, until `release()`. */
    async function holdFirstRecordAtLink() {
      const sync = await import("@/lib/xero-sync");
      const original = sync.upsertXeroObjectLink;
      let reportPid!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (reportPid = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let held = false;
      vi.spyOn(sync, "upsertXeroObjectLink").mockImplementation((async (link: { xeroObjectId: string }, options?: { store?: { $queryRaw: (q: TemplateStringsArray) => Promise<Array<{ pid: number }>> } }) => {
        if (!held && link.xeroObjectId === NOTE && options?.store) {
          held = true;
          const [{ pid }] = await options.store.$queryRaw`SELECT pg_backend_pid() AS "pid"`;
          reportPid(pid);
          await released;
        }
        return original(link as never, options as never);
      }) as never);
      return { holderPid, release };
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

    /** Which table's row the backend blocked by `blockerPid` is queued on (a row-lock waiter holds the row's `tuple` lock). */
    async function rowWaitedOn(blockerPid: number): Promise<string[]> {
      const rows = await prisma.$queryRaw<Array<{ relname: string }>>`
        SELECT DISTINCT c.relname FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'tuple' AND ${blockerPid}::int = ANY(pg_blocking_pids(a.pid))
      `;
      return rows.map((row) => row.relname);
    }

    /** The rows naming NOTE, the payment's pointer, and NOTE's links. */
    async function recordsOfNote() {
      const rows = await prisma.xeroSyncOperation.findMany({ where: { localId: PAYMENT_ID, xeroObjectId: NOTE }, select: { id: true } });
      const links = await prisma.xeroObjectLink.findMany({ where: { localId: PAYMENT_ID, xeroObjectId: NOTE }, select: { active: true } });
      const { xeroRefundCreditNoteId } = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } });
      return { rows: rows.map((row) => row.id), links, pointer: xeroRefundCreditNoteId };
    }

    it("MUTATION: two records of one note on two rows - the second queues on the Payment row though neither takes the pointer, and is refused fresh; one row names the note", async () => {
      const first = await runningCreateRow("first");
      const second = await runningCreateRow("second");
      const held = await holdFirstRecordAtLink();
      const firstRecord = record(first);
      const holder = await held.holderPid;
      const secondRecord = record(second);
      void secondRecord.catch(() => undefined);
      try {
        await waitForBlockedBy(holder);
        // Before #4656 a note taking no pointer locked no Payment row and the check ran before the
        // transaction: the second passed it while the first was uncommitted, and both rows named the note.
        expect(await rowWaitedOn(holder)).toEqual(["Payment"]);
      } finally {
        held.release();
      }
      await expect(firstRecord).resolves.toBe("recorded");
      await expect(secondRecord).rejects.toThrow(/already raised it, so this create would relabel another refund's note \(INV-ADDPAY-041\)/);

      expect(await recordsOfNote()).toEqual({ rows: [first], links: [{ active: true }], pointer: null });
      // The refused record rolled back whole: its row names nothing and is left for the create's catch to fail.
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: second }, select: { status: true, xeroObjectId: true } })).toEqual({ status: "RUNNING", xeroObjectId: null });
      expect(send).not.toHaveBeenCalled();
    });

    it("MUTATION: a record behind a Payment row held past Prisma's 5s default still records on the row's budget", async () => {
      const operationId = await runningCreateRow("budget");
      const holder = await holdPaymentRow(7_000);
      const recorded = record(operationId, true);
      await waitForBlockedBy(holder.holderPid);
      await holder.done;
      await expect(recorded).resolves.toBe("recorded");
      expect(await recordsOfNote()).toEqual({ rows: [operationId], links: [{ active: true }], pointer: NOTE });
      const { PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS } = await import("@/lib/payment-transactions");
      // Sized to the row's longest documented holders, which run 30s transactions.
      expect(PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS.timeout).toBeGreaterThanOrEqual(30_000);
    });

    /** The hand-back completed through the real writer, which queues the payment's $200 refund note. */
    async function queuedRefundNote(): Promise<string> {
      await prisma.manualRefundTask.create({
        data: { id: HAND_BACK_ID, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: 20_000, raisedAmountCents: 20_000, kind: "CANCELLED_BOOKING_HAND_BACK", reason: `${P} hand-back` },
      });
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        { taskId: HAND_BACK_ID, resolution: "completed", note: null, actingMemberId: OFFICER_ID, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null },
        CLUB_FORMAT_TEST,
      );
      const row = await prisma.xeroSyncOperation.findFirstOrThrow({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE", status: "PENDING" },
        select: { id: true },
      });
      return row.id;
    }

    /** The outbox worker raising the queued note against a fake Xero answering at once with NOTE. */
    async function raise(operationId: string) {
      const paymentsMade: string[] = [];
      const accountingApi = {
        createCreditNotes: async (_tenant: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }) => {
          const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
          return { body: { creditNotes: [{ creditNoteID: NOTE, creditNoteNumber: "CN-4656", total, remainingCredit: total, status: "AUTHORISED", payments: [] }] } };
        },
        createPayments: async (_tenant: string, body: { payments: Array<{ creditNote: { creditNoteID: string }; amount: number }> }) => {
          paymentsMade.push(body.payments[0]!.creditNote.creditNoteID);
          return { body: { payments: [{ paymentID: `${P}-xero-payment`, amount: body.payments[0]!.amount }] } };
        },
      };
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi }, tenantId: `tenant-${P}` } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
      vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue(`${P}-contact`);
      vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
        options.run({ contactId: options.currentContactId })) as never);
      vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "record", bankCode: "090" });
      // Oldest first is the worker's order: this row goes first, alone.
      await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${operationId}`;
      const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
      return { run: processQueuedXeroOutboxOperations({ limit: 1 }), paymentsMade };
    }

    it("MUTATION: a record behind a Payment row held past its whole budget writes nothing and fails nothing - the row stays RUNNING, and one audit row and one alert name the note", async () => {
      const operationId = await queuedRefundNote();
      const { PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS } = await import("@/lib/payment-transactions");
      const holder = await holdPaymentRow(PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS.timeout + 3_000);
      const raised = await raise(operationId);
      await waitForBlockedBy(holder.holderPid);
      const result = await raised.run;
      await holder.done;

      // The worker returns as for any handled row: nothing threw into its catch, which would fail the row.
      expect(result).toMatchObject({ failed: 0 });
      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true, xeroObjectId: true, lastErrorCode: true, completedAt: true } });
      expect(row).toEqual({ status: "RUNNING", xeroObjectId: null, lastErrorCode: null, completedAt: null });
      expect(await recordsOfNote()).toEqual({ rows: [], links: [], pointer: null });
      // Never settled: no refund payment was recorded against the note in Xero.
      expect(raised.paymentsMade).toEqual([]);

      const { LATE_REFUND_NOTE_NOT_RECORDED_ACTION } = await import("@/lib/xero-refund-note-record");
      expect(await prisma.auditLog.findMany({ where: { action: LATE_REFUND_NOTE_NOT_RECORDED_ACTION, entityId: operationId }, select: { category: true, targetId: true, metadata: true } })).toEqual([
        {
          category: "xero",
          targetId: BOOKING_ID,
          metadata: expect.objectContaining({ reason: "record-wait-lost", creditNoteId: NOTE, creditNoteNumber: "CN-4656", amountCents: 20_000, paymentId: PAYMENT_ID, recordedCreditNoteId: null, rowFound: true }),
        },
      ]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        errorType: "XERO_SUCCESS_AFTER_RESOLUTION",
        errorMessage: expect.stringMatching(/Xero made credit note CN-4656 for \$200\.00 \(Xero id race-4656-note, booking race-4656-booking\) for this refund.*did not mark the operation failed/),
      }));
      const { xeroSuccessAfterResolutionAlertKey } = await import("@/lib/xero-success-after-resolution-alert");
      expect(await prisma.alertCooldown.count({ where: { key: xeroSuccessAfterResolutionAlertKey(operationId, NOTE) } })).toBe(1);
    });
  },
);
