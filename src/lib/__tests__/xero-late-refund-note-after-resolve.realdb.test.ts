/**
 * Real-PostgreSQL proof of #4426 (`INV-INT-029`, with #4421's `INV-INT-028`):
 * a refund credit-note create that stalls in Xero, is reset, and is resolved by
 * hand while it waits never overwrites the note the officer recorded.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking; a $200 Internet Banking payment and its charge row;
 *   one OPEN cancellation hand-back on it.
 * - REAL: the hand-back's completion (`resolveManualRefundTask`), which queues
 *   the payment's refund note; the outbox worker raising it
 *   (`processQueuedXeroOutboxOperations`) against a fake Xero whose create
 *   answers only when the test lets it (no provider call); the officer's
 *   "Mark failed" on the stalled row (`markStaleRunningXeroOperationFailed`,
 *   given an instant past the stale threshold); "Resolve by hand"'s one writer
 *   (`claimResolveRecordingRefundNote`, #4421), recording note A the officer
 *   made; the once-ever alert's claim, with only the email send replaced.
 *
 * Proven: when the stalled run returns with note B, note A stays recorded on
 * the row and linked, B is never linked, never takes the payment's pointer and
 * is never settled, and B is audited once and the officers alerted once. When
 * the officer resolved with B itself (Xero committed it, its answer was lost),
 * nothing is written or alerted. A plain resolve (no note recorded,
 * `claimResolvedInXeroMark`) lets B land, settle and complete as before #4426,
 * with #4374's alert. The control: a Mark failed with no resolve records B as
 * before. And the other half of the race, each transaction held open while the
 * other runs: the create's record holding the Payment row makes the resolve's
 * claim wait on it - for a canonical note and (#4656, which takes the Payment
 * row for every note) a per-refund note alike; either way the create's record
 * stands and the resolve's claim is lost.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4426-`
 * fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4426";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const TXN_ID = `${P}-bank-txn`;
const INVOICE_ID = `${P}-invoice`;
const HAND_BACK_ID = `${P}-hand-back`;
const NOTE_A = `${P}-note-a`;
const NOTE_B = `${P}-note-b`;
const STALE_MS = 16 * 60_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a stalled refund-note create returning after a reset and a resolve by hand records nothing - real PostgreSQL (#4426)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      const ops = await prisma.xeroSyncOperation.findMany({ where: { localModel: "Payment", localId: PAYMENT_ID }, select: { id: true } });
      await prisma.alertCooldown.deleteMany({ where: { key: { in: ops.map((op) => `xero-success-after-resolution:${op.id}:${NOTE_B}`) } } });
      await prisma.alertCooldown.deleteMany({ where: { key: { in: ops.map((op) => `xero-success-after-resolution:${op.id}`) } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: OFFICER_ID }, { targetId: BOOKING_ID }, { targetId: { in: ops.map((op) => op.id) } }] } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Late refund note after resolve (#4426)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Late", lastName: "Note", role, ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4426 Lodge", slug: P } });
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

    /**
     * The outbox worker raising the queued note against a fake Xero whose create
     * reports it was reached, then answers with note B only when `answer()` is
     * called. Settlement records a bank payment (`createPayments`, counted).
     */
    async function stalledRaise(operationId: string) {
      let reached!: () => void;
      const reachedXero = new Promise<void>((resolve) => (reached = resolve));
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      const paymentsMade: string[] = [];
      const accountingApi = {
        createCreditNotes: async (_tenant: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }) => {
          reached();
          await answered;
          const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
          return { body: { creditNotes: [{ creditNoteID: NOTE_B, creditNoteNumber: "CN-B", total, remainingCredit: total, status: "AUTHORISED", payments: [] }] } };
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
      const run = processQueuedXeroOutboxOperations({ limit: 1 });
      await reachedXero;
      return { run, answer, paymentsMade };
    }

    /** "Mark failed" on the stalled row, as an officer presses it once the row is past the stale threshold. */
    async function resetStale(operationId: string) {
      const { startedAt, status } = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { startedAt: true, status: true } });
      expect(status).toBe("RUNNING");
      const { markStaleRunningXeroOperationFailed } = await import("@/lib/xero-stale-operations");
      const marked = await markStaleRunningXeroOperationFailed(operationId, async () => undefined, new Date(startedAt!.getTime() + STALE_MS));
      expect(marked).toMatchObject({ outcome: "marked", returnedTo: "FAILED" });
    }

    /** "Resolve by hand" recording a note (A by default), through its one writer (#4421); answers the claim's outcome. */
    async function resolveRecording(operationId: string, noteId = NOTE_A, number = "CN-A", options: { checkPrompt?: boolean } = {}) {
      const { claimResolveRecordingRefundNote, resolveCreditNotePrompt } = await import("@/lib/xero-resolve-refund-note");
      if (options.checkPrompt !== false) {
        expect(resolveCreditNotePrompt(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } }))).toMatchObject({
          resolveAsksCreditNoteNumber: true,
          resolveCreditNoteAmountCents: 20_000,
        });
      }
      const claim = await claimResolveRecordingRefundNote({
        operationId,
        paymentId: PAYMENT_ID,
        note: { creditNoteId: noteId, creditNoteNumber: number, amountCents: 20_000, status: "AUTHORISED", total: 200, updatedDateUTC: null },
        readAt: new Date(),
        reason: "Made the note by hand in Xero",
        resolvedById: OFFICER_ID,
      });
      return claim.outcome;
    }

    async function resolveWithNoteA(operationId: string) {
      expect(await resolveRecording(operationId)).toBe("claimed");
    }

    /** The late-note audit rows written for this operation. */
    async function lateNoteAudits(operationId: string) {
      const { LATE_REFUND_NOTE_NOT_RECORDED_ACTION } = await import("@/lib/xero-refund-note-record");
      return prisma.auditLog.findMany({ where: { action: LATE_REFUND_NOTE_NOT_RECORDED_ACTION, entityId: operationId }, select: { category: true, targetId: true, metadata: true } });
    }

    /**
     * A completed hand-back on the payment recorded by the real writers with no
     * note yet, and its own note queued by the real enqueue as a paid-another-way
     * close's: a per-refund note, which never takes the payment's pointer.
     */
    async function queuedPerRefundNote(): Promise<string> {
      const { applyLocalRefundAllocation } = await import("@/lib/payment-transactions");
      const { postHandBackLedgerLine } = await import("@/lib/booking-ledger-hand-back");
      await prisma.$transaction(async (tx) => {
        await tx.manualRefundTask.create({
          data: {
            id: HAND_BACK_ID, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 20_000, raisedAmountCents: 20_000,
            status: "COMPLETED", completedAt: new Date(), completedByMemberId: OFFICER_ID, reason: P,
          },
        });
        await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 20_000, store: tx });
        await postHandBackLedgerLine({
          bookingId: BOOKING_ID, lodgeId: LODGE_ID, manualRefundTaskId: HAND_BACK_ID, amountCents: 20_000, refundMethod: "internet-banking",
          paymentSource: "INTERNET_BANKING", officerMemberId: OFFICER_ID, store: tx,
        });
      });
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 20_000, { refundMethod: "internet-banking", paidAnotherWayTaskId: HAND_BACK_ID });
      expect(queued.queueOperationId).toEqual(expect.any(String));
      return queued.queueOperationId!;
    }

    /**
     * Holds the create's record transaction open at its link write (after its
     * pointer UPDATE, when it takes one, and its row claim), reporting that
     * transaction's backend pid, until `release()`.
     */
    async function holdRecordAtLink() {
      const sync = await import("@/lib/xero-sync");
      const original = sync.upsertXeroObjectLink;
      let reportPid!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (reportPid = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(sync, "upsertXeroObjectLink").mockImplementation((async (link: { xeroObjectId: string }, options?: { store?: { $queryRaw: (q: TemplateStringsArray) => Promise<Array<{ pid: number }>> } }) => {
        if (link.xeroObjectId === NOTE_B && options?.store) {
          const [{ pid }] = await options.store.$queryRaw`SELECT pg_backend_pid() AS "pid"`;
          reportPid(pid);
          await released;
        }
        return original(link as never, options as never);
      }) as never);
      return { holderPid, release };
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
      throw new Error(`Timed out waiting for the resolve to queue behind the create's record held by pid ${blockerPid}.`);
    }

    /**
     * Which table's row the backend blocked by `blockerPid` is queued on: a row-lock
     * waiter holds the row's `tuple` lock while it waits on the holder's transaction.
     */
    async function rowWaitedOn(blockerPid: number): Promise<string[]> {
      const rows = await prisma.$queryRaw<Array<{ relname: string }>>`
        SELECT DISTINCT c.relname FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'tuple' AND ${blockerPid}::int = ANY(pg_blocking_pids(a.pid))
      `;
      return rows.map((row) => row.relname);
    }

    /** The row, the payment's pointer, and every link of either note, by note. */
    async function recorded(operationId: string) {
      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({
        where: { id: operationId },
        select: { status: true, xeroObjectId: true, xeroObjectNumber: true, manuallyResolvedAt: true },
      });
      const links = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT_ID, xeroObjectId: { in: [NOTE_A, NOTE_B] } },
        select: { xeroObjectId: true, active: true },
        orderBy: { xeroObjectId: "asc" },
      });
      const { xeroRefundCreditNoteId } = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } });
      return { row: { ...row, resolved: row.manuallyResolvedAt !== null, manuallyResolvedAt: undefined }, links, pointer: xeroRefundCreditNoteId };
    }

    it("MUTATION: reset, resolve by hand with note A, then the stalled run returns note B - A stays recorded and linked, B is alerted once and never linked or settled", async () => {
      const operationId = await queuedRefundNote();
      const stalled = await stalledRaise(operationId);
      try {
        await resetStale(operationId);
        await resolveWithNoteA(operationId);
      } finally {
        stalled.answer();
      }
      await stalled.run;

      expect(await recorded(operationId)).toEqual({
        row: { status: "FAILED", xeroObjectId: NOTE_A, xeroObjectNumber: "CN-A", resolved: true, manuallyResolvedAt: undefined },
        links: [{ xeroObjectId: NOTE_A, active: true }],
        pointer: null,
      });
      // B was never settled: no bank payment was recorded against it in Xero.
      expect(stalled.paymentsMade).toEqual([]);
      // The coverage readers count A once, and nothing for B.
      const { readResolvedRefundCreditNoteCoverage, sumRefundCreditNoteCoverageCents } = await import("@/lib/xero-resolved-in-xero-fences");
      expect(await sumRefundCreditNoteCoverageCents(PAYMENT_ID, await readResolvedRefundCreditNoteCoverage(PAYMENT_ID))).toBe(20_000);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        errorType: "XERO_SUCCESS_AFTER_RESOLUTION",
        errorMessage: expect.stringMatching(/recording credit note CN-A.*credit note CN-B for \$200\.00 \(Xero id race-4426-note-b, booking race-4426-booking\).*did not record it/),
      }));
      const { xeroSuccessAfterResolutionAlertKey } = await import("@/lib/xero-success-after-resolution-alert");
      expect(await prisma.alertCooldown.count({ where: { key: xeroSuccessAfterResolutionAlertKey(operationId, NOTE_B) } })).toBe(1);
      // The durable record of B: one `xero` audit row naming it, the amount and the booking.
      expect(await lateNoteAudits(operationId)).toEqual([
        {
          category: "xero",
          targetId: BOOKING_ID,
          metadata: expect.objectContaining({ creditNoteId: NOTE_B, creditNoteNumber: "CN-B", amountCents: 20_000, bookingId: BOOKING_ID, recordedCreditNoteId: NOTE_A }),
        },
      ]);
    });

    it("MUTATION: the officer resolved with B itself (Xero committed it, its answer was lost) - the stalled run's B changes nothing and alerts nobody", async () => {
      const operationId = await queuedRefundNote();
      const stalled = await stalledRaise(operationId);
      try {
        await resetStale(operationId);
        expect(await resolveRecording(operationId, NOTE_B, "CN-B")).toBe("claimed");
      } finally {
        stalled.answer();
      }
      await stalled.run;

      expect(await recorded(operationId)).toEqual({
        row: { status: "FAILED", xeroObjectId: NOTE_B, xeroObjectNumber: "CN-B", resolved: true, manuallyResolvedAt: undefined },
        links: [{ xeroObjectId: NOTE_B, active: true }],
        pointer: null,
      });
      // The resolve's link is the one there is: it names the resolved row.
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: NOTE_B }, select: { metadata: true } });
      expect(link.metadata).toMatchObject({ resolvedOperationId: operationId, recordedByHand: true });
      // Settling B is the officer's, as the resolve already assumes: the create records no payment.
      expect(stalled.paymentsMade).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      expect(await lateNoteAudits(operationId)).toEqual([]);
    });

    it("MUTATION: a plain resolve recorded no note - B lands, links, settles and completes as before #4426, and #4374's alert tells the officers", async () => {
      const operationId = await queuedRefundNote();
      const stalled = await stalledRaise(operationId);
      const resolvedAt = new Date("2026-07-01T00:30:00.000Z");
      try {
        await resetStale(operationId);
        const { claimResolvedInXeroMark } = await import("@/lib/xero-operation-resolve-guards");
        // Pins the claim's predicate on a plainly resolved row. The route sends this canonical (asks-number)
        // row through resolveRecordingRefundNote, so the flow that really reaches a plain resolve is a
        // refund request's note (#4391, no pointer), covered in the unit suite (delta review F4).
        await expect(claimResolvedInXeroMark({ id: operationId, resolvedAt, reason: "Done in Xero", resolvedById: OFFICER_ID })).resolves.toBe(true);
      } finally {
        stalled.answer();
      }
      await stalled.run;

      expect(await recorded(operationId)).toEqual({
        row: { status: "SUCCEEDED", xeroObjectId: NOTE_B, xeroObjectNumber: "CN-B", resolved: true, manuallyResolvedAt: undefined },
        links: [{ xeroObjectId: NOTE_B, active: true }],
        pointer: NOTE_B,
      });
      expect(stalled.paymentsMade).toEqual([NOTE_B]);
      expect(send).toHaveBeenCalledTimes(1);
      const { xeroSuccessAfterResolutionAlertKey } = await import("@/lib/xero-success-after-resolution-alert");
      expect(await prisma.alertCooldown.count({ where: { key: xeroSuccessAfterResolutionAlertKey(operationId) } })).toBe(1);
      expect(await lateNoteAudits(operationId)).toEqual([]);
    });

    it("race, canonical note: the create's record holding the Payment row makes the resolve's claim wait on it; the record stands and the resolve is lost", async () => {
      const operationId = await queuedRefundNote();
      const stalled = await stalledRaise(operationId);
      await resetStale(operationId);
      const held = await holdRecordAtLink();
      stalled.answer();
      const holder = await held.holderPid;
      const resolve = resolveRecording(operationId, NOTE_A, "CN-A", { checkPrompt: false });
      try {
        await waitForBlockedBy(holder);
        expect(await rowWaitedOn(holder)).toEqual(["Payment"]);
      } finally {
        held.release();
      }
      await stalled.run;
      await expect(resolve).resolves.toBe("lost");
      expect(await recorded(operationId)).toEqual({
        row: { status: "SUCCEEDED", xeroObjectId: NOTE_B, xeroObjectNumber: "CN-B", resolved: false, manuallyResolvedAt: undefined },
        links: [{ xeroObjectId: NOTE_B, active: true }],
        pointer: NOTE_B,
      });
      expect(send).not.toHaveBeenCalled();
    });

    it("race, per-refund note (no pointer): the resolve's claim still waits on the Payment row the create's record holds (#4656), and loses", async () => {
      const operationId = await queuedPerRefundNote();
      const stalled = await stalledRaise(operationId);
      await resetStale(operationId);
      const held = await holdRecordAtLink();
      stalled.answer();
      const holder = await held.holderPid;
      const resolve = resolveRecording(operationId, NOTE_A, "CN-A", { checkPrompt: false });
      try {
        await waitForBlockedBy(holder);
        // #4656: the record takes the Payment row for a note that takes no pointer too, so the resolve
        // queues there before its reads, as for a canonical note (before #4656 it waited on the operation row).
        expect(await rowWaitedOn(holder)).toEqual(["Payment"]);
      } finally {
        held.release();
      }
      await stalled.run;
      await expect(resolve).resolves.toBe("lost");
      const after = await recorded(operationId);
      expect(after.row).toEqual({ status: "SUCCEEDED", xeroObjectId: NOTE_B, xeroObjectNumber: "CN-B", resolved: false, manuallyResolvedAt: undefined });
      expect(after.links).toEqual([{ xeroObjectId: NOTE_B, active: true }]);
      expect(after.pointer).toBeNull();
      expect(send).not.toHaveBeenCalled();
    });

    it("control: a reset with no resolve - B lands on the row no claim holds (INV-INT-029), is linked, takes the pointer, is settled and completes the row, alerting nobody", async () => {
      const operationId = await queuedRefundNote();
      const stalled = await stalledRaise(operationId);
      try {
        await resetStale(operationId);
      } finally {
        stalled.answer();
      }
      await stalled.run;

      expect(await recorded(operationId)).toEqual({
        row: { status: "SUCCEEDED", xeroObjectId: NOTE_B, xeroObjectNumber: "CN-B", resolved: false, manuallyResolvedAt: undefined },
        links: [{ xeroObjectId: NOTE_B, active: true }],
        pointer: NOTE_B,
      });
      expect(stalled.paymentsMade).toEqual([NOTE_B]);
      expect(send).not.toHaveBeenCalled();
    });
  },
);
