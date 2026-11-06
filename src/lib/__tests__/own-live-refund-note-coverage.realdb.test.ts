/**
 * Real-PostgreSQL proof of #4265 (owner decision 26 Oct 2026, `INV-INT-025`):
 * a refund-note create row covers only its OWN note, while LIVE, and never a
 * refund request's (`INV-PAY-118`). Folded in: #4258 and #4321.
 *
 * - #4265: a refund request's $300 note, raised by the real outbox, ends
 *   PARTIAL and an officer resolves it through the real resolve route. It
 *   covers nothing of the payment's refund-note coverage, live or after the
 *   real inbound void, so the nightly bank-void follow-up (#4247's spare
 *   check) undoes a voided $200 cancellation note instead of calling it spare.
 *   A live own note, and an ordinary row resolved by hand, still count.
 * - #4258: a "Paid another way" close row completed as covered by another
 *   refund's note counts nothing of its own; the raising record's rows still
 *   count that note. No current writer completes a close row that way (#4213's
 *   finding: the shape is an older release's), so the row is written as that
 *   release wrote it.
 * - #4321: the follow-up's "already recorded in Xero myself" answer refuses a
 *   note a credit-note create row records while that row is resolved by hand,
 *   or not yet SUCCEEDED so a resolve could still flip it - in sequence and
 *   with the resolve committing while the completion holds its locks - and
 *   still takes a note no row records. A row resolved after the officer made
 *   its note by hand records that note since #4421, proven by
 *   `resolve-records-refund-note.realdb.test.ts`.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4265-`
 * fixtures. No Stripe or Xero call is made.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { NextRequest } from "next/server";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { assertNoForeignPendingXeroOperations } from "@/lib/__tests__/support/race-harness-outbox-guard";
import { raceSession } from "@/lib/__tests__/support/race-session-double";

// The harness's one `@/lib/auth` double: the resolve route reads the officer's session from it.
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4265";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const TXN_ID = `${P}-txn`;
const INVOICE_ID = `inv-${P}`;
const CONTACT_ID = `${P}-contact`;
const REQUEST_ID = `${P}-request`;
const PAID_CENTS = 60_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let fences: typeof import("@/lib/xero-resolved-in-xero-fences");
let followUp: typeof import("@/lib/bank-refund-void-follow-up");
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "a refund-note row covers only its own live, non-request note - real PostgreSQL (#4265, #4258, #4321)",
  { timeout: 90_000 },
  () => {
    async function clearRun() {
      const ops = await prisma.xeroSyncOperation.findMany({ where: { localModel: "Payment", localId: PAYMENT_ID }, select: { id: true } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: { in: [BOOKING_ID, ...ops.map((op) => op.id)] } }, { memberId: OFFICER_ID }] } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
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

    /** A paid bank-transfer payment, invoiced in Xero, with no refund yet. */
    async function paidBankTransfer() {
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
      });
      await prisma.paymentTransaction.create({
        data: { id: TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: PAID_CENTS, status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
      });
    }

    /**
     * A cancellation hand-back, recorded by the real writers (the completed
     * task, the allocation, its BANK_REFUND line) and, unless `noNote`, noted
     * in Xero as the builder records it: the create row naming the task and
     * its live link.
     */
    async function handBack(noteId: string, cents: number, options?: { noNote?: boolean; names?: "handBackTaskId" | "paidAnotherWayTaskId"; perDelta?: boolean }) {
      const { applyLocalRefundAllocation } = await import("@/lib/payment-transactions");
      const { postHandBackLedgerLine } = await import("@/lib/booking-ledger-hand-back");
      const taskId = `${P}-task-${noteId}`;
      await prisma.$transaction(async (tx) => {
        await tx.manualRefundTask.create({
          data: {
            id: taskId, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: cents, raisedAmountCents: cents,
            status: "COMPLETED", completedAt: new Date(), completedByMemberId: OFFICER_ID, reason: P,
          },
        });
        await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: cents, store: tx });
        await postHandBackLedgerLine({
          bookingId: BOOKING_ID, lodgeId: LODGE_ID, manualRefundTaskId: taskId, amountCents: cents, refundMethod: "internet-banking",
          paymentSource: "INTERNET_BANKING", officerMemberId: OFFICER_ID, store: tx,
        });
      });
      if (options?.noNote) return taskId;
      const key = `payment:${PAYMENT_ID}:refund-credit-note:${cents}:v1:${noteId}`;
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, xeroObjectNumber: `CN-${noteId}`,
          correlationKey: key, idempotencyKey: key, queueType: "REFUND_CREDIT_NOTE", completedAt: new Date("2026-06-01T00:00:00.000Z"),
          requestPayload: {
            refundMethod: "internet-banking", refundAmountCents: cents, watermarkCents: cents,
            allocation: { invoiceId: INVOICE_ID, amount: cents / 100 }, [options?.names ?? "handBackTaskId"]: taskId,
            ...(options?.perDelta ? { perDelta: true } : {}),
          },
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, xeroObjectNumber: `CN-${noteId}`,
          role: "REFUND_CREDIT_NOTE", active: true,
          metadata: { amountCents: cents, watermarkCents: cents, status: "AUTHORISED", total: cents / 100, ...(options?.perDelta ? { perDelta: true } : {}) },
        },
      });
      if (!options?.perDelta) await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroRefundCreditNoteId: noteId } });
      return taskId;
    }

    /** Swap in a fake Xero (no provider call) for the length of `run`. */
    async function withFakeXero<T>(accountingApi: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi }, tenantId: `tenant-${P}` } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue(CONTACT_ID),
        vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
          options.run({ contactId: options.currentContactId })) as never),
        // A configured bank-transfer refund account, so the note's refund payment is attempted.
        vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "record", bankCode: "090" }),
      ];
      try {
        return await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /**
     * The real outbox worker runs one queued note against a fake Xero that
     * raises `noteId` and then refuses its refund payment: the row completes
     * PARTIAL, naming its note, with the note's live link.
     */
    async function raiseThenFailPayment(operationId: string, noteId: string) {
      await assertNoForeignPendingXeroOperations(prisma, [PAYMENT_ID]);
      await withFakeXero(
        {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }) => {
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            return { body: { creditNotes: [{ creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, total, remainingCredit: total, status: "AUTHORISED", payments: [] }] } };
          },
          createPayments: async () => {
            throw new Error("Xero 503 on the refund payment");
          },
          getCreditNote: async () => ({ body: { creditNotes: [] } }),
        },
        async () => {
          // Oldest first is the worker's order: this row goes first, alone.
          await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${operationId}`;
          const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
          await processQueuedXeroOutboxOperations({ limit: 1 });
        },
      );
      return prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true, xeroObjectId: true, manuallyResolvedAt: true } });
    }

    /** The officer's "Resolve" on the Xero operations panel, through the real route. */
    async function resolveByHand(operationId: string) {
      const { POST } = await import("@/app/api/admin/xero/operations/[id]/resolve/route");
      const response = await POST(
        new NextRequest(`http://localhost/api/admin/xero/operations/${operationId}/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "Made the note by hand in Xero" }),
        }),
        { params: Promise.resolve({ id: operationId }) },
      );
      expect(response.status).toBe(200);
      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { manuallyResolvedAt: true } });
      expect(row.manuallyResolvedAt).not.toBeNull();
    }

    /** The inbound reconcile of `noteId`, as Xero reports it voided. */
    async function voidInXero(noteId: string, cents: number) {
      await withFakeXero(
        {
          getCreditNote: async () => ({
            body: { creditNotes: [{ creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, status: "VOIDED", total: cents / 100, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [] }] },
          }),
        },
        async () => {
          const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
          await reconcileXeroCreditNote(noteId);
        },
      );
      return (await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: noteId }, select: { id: true } })).id;
    }

    async function coverage() {
      const resolved = await fences.readResolvedRefundCreditNoteCoverage(PAYMENT_ID);
      return { resolved, totalCents: await fences.sumRefundCreditNoteCoverageCents(PAYMENT_ID, resolved) };
    }

    /** The refund request's own $300 note: queued by the real enqueue, raised by the real outbox, PARTIAL, resolved by hand. */
    async function resolvedRequestNote(noteId: string) {
      const { enqueueXeroRefundRequestCreditNoteOperation } = await import("@/lib/xero-refund-request-credit-note-outbox");
      const queued = await enqueueXeroRefundRequestCreditNoteOperation({ paymentId: PAYMENT_ID, refundRequestId: REQUEST_ID, amountCents: 30_000 });
      expect(queued.queueOperationId).toEqual(expect.any(String));
      const raised = await raiseThenFailPayment(queued.queueOperationId!, noteId);
      expect(raised).toMatchObject({ status: "PARTIAL", xeroObjectId: noteId });
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: noteId }, select: { role: true, active: true } });
      expect(link).toEqual({ role: "REFUND_REQUEST_CREDIT_NOTE", active: true });
      await resolveByHand(queued.queueOperationId!);
      return queued.queueOperationId!;
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Own live refund-note coverage");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      fences = await import("@/lib/xero-resolved-in-xero-fences");
      followUp = await import("@/lib/bank-refund-void-follow-up");
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Own", lastName: "Cover", role, ageTier: "ADULT", canLogin: true },
        });
      }
      await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4265 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
          status: "CANCELLED", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS,
        },
      });
    }, 120_000);

    beforeEach(async () => {
      await clearRun();
      raceSession.current = { user: { id: OFFICER_ID, role: "ADMIN", accessRoles: [{ role: "ADMIN" }], canLogin: true } };
      await paidBankTransfer();
    });

    afterEach(() => {
      raceSession.current = null;
    });

    afterAll(async () => {
      raceSession.current = null;
      if (!prisma) return;
      await deleteFixtures();
    }, 90_000);

    it("MUTATION (#4265): a refund request's own note resolved by hand covers nothing, live or voided; a live own note and an ordinary resolved row still count", async () => {
      await handBack(`${P}-v`, 20_000);
      const requestRow = await resolvedRequestNote(`${P}-rq`);

      // The other direction, through the same real writers: an ordinary
      // hand-back's own note, raised PARTIAL and resolved by hand, its live
      // link then turned off with no void recorded - its recorded $100 counts.
      const h2 = await handBack(`${P}-h2`, 10_000, { noNote: true });
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const ordinary = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 10_000, { refundMethod: "internet-banking", paidAnotherWayTaskId: h2 });
      expect(ordinary.queueOperationId).toEqual(expect.any(String));
      expect(await raiseThenFailPayment(ordinary.queueOperationId!, `${P}-x2`)).toMatchObject({ status: "PARTIAL", xeroObjectId: `${P}-x2` });
      await resolveByHand(ordinary.queueOperationId!);
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-x2` }, data: { active: false } });

      // Live request note: the $200 live note and the $100 resolved row; the request's $300 is no part of it.
      let { resolved, totalCents } = await coverage();
      expect(resolved.coveredCents).toBe(10_000);
      expect(totalCents).toBe(30_000);
      // Its key is still reported, so the request's own fence holds: no second note is queued for it.
      expect(resolved.operationIds).toContain(requestRow);
      expect(resolved.unreadableOperationIds).toEqual([]);
      const { enqueueXeroRefundRequestCreditNoteOperation } = await import("@/lib/xero-refund-request-credit-note-outbox");
      expect(await enqueueXeroRefundRequestCreditNoteOperation({ paymentId: PAYMENT_ID, refundRequestId: REQUEST_ID, amountCents: 30_000 })).toEqual({
        queueOperationId: null,
        message: "An officer resolved this refund request's Xero credit note by hand in Xero, so no new note is queued.",
      });

      // Xero voids the request's note: still nothing of it counts.
      await voidInXero(`${P}-rq`, 30_000);
      ({ resolved, totalCents } = await coverage());
      expect(resolved.coveredCents).toBe(10_000);
      expect(totalCents).toBe(30_000);
      // Asked of the request's own rows alone, as one refund's share is asked: nothing.
      expect(await fences.sumRefundCreditNoteCoverageOfRowsCents(PAYMENT_ID, { id: requestRow })).toBe(0);
    });

    it("MUTATION (#4265, the issue's example): a voided $200 cancellation note beside a $300 request note resolved by hand is undone, not a spare", async () => {
      await handBack(`${P}-v`, 20_000);
      await resolvedRequestNote(`${P}-rq`);
      await voidInXero(`${P}-rq`, 30_000);
      const linkId = await voidInXero(`${P}-v`, 20_000);

      // Before #4265 the request's $300 covered the $200 hand-back: "spare", and nothing moved.
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "undone" });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } });
      expect(payment.refundedAmountCents).toBe(0);
    });

    it("MUTATION (#4258): a close row completed as covered by another refund's note counts nothing of its own; the raising record's rows still count that note", async () => {
      // A's $50 note N_A, raised by A's own row. B's ($30) close row completed
      // as covered by N_A, as a release before #3924 round 8 could complete it.
      const a = await handBack(`${P}-na`, 5_000, { names: "paidAnotherWayTaskId", perDelta: true });
      const b = await handBack(`${P}-b`, 3_000, { noNote: true });
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-na`, xeroObjectNumber: `CN-${P}-na`,
          correlationKey: `${P}-b-covered`, idempotencyKey: `${P}-b-covered`, queueType: "REFUND_CREDIT_NOTE", completedAt: new Date("2026-06-02T00:00:00.000Z"),
          requestPayload: { refundMethod: "internet-banking", refundAmountCents: 3_000, paidAnotherWayTaskId: b },
          responsePayload: { existingCreditNoteId: `${P}-na`, coveredByExistingNote: true },
        },
      });
      const { paidAnotherWayCloseNoteRowsWhere, readPaidAnotherWayCloseShare } = await import("@/lib/card-refund-paid-another-way-cash");

      expect(await fences.sumRefundCreditNoteCoverageOfRowsCents(PAYMENT_ID, paidAnotherWayCloseNoteRowsWhere(PAYMENT_ID, b))).toBe(0);
      // Before the fix B read as answered by A's $50 note, and its own $30 note was never sized.
      expect(await readPaidAnotherWayCloseShare(prisma, PAYMENT_ID, b)).toMatchObject({ amountCents: 3_000, coveredCents: 0, uncoveredCents: 3_000 });
      expect(await fences.sumRefundCreditNoteCoverageOfRowsCents(PAYMENT_ID, paidAnotherWayCloseNoteRowsWhere(PAYMENT_ID, a))).toBe(5_000);
    });

    /**
     * #4321's shape: H1's $200 note V, which Xero voids, so the nightly
     * follow-up undoes H1 and asks once; then H2's own $200 note X, raised
     * PARTIAL by the real outbox (`resolve`: then resolved by hand through the
     * real route), its mirror turned off with no void recorded - the shape the
     * single-note rule leaves on a retired duplicate, which the answer
     * otherwise reactivates (`recordHandMadeRefundNoteLink`, review money 6).
     */
    async function followUpBesideNoteX(options: { resolve: boolean }) {
      await handBack(`${P}-v`, 20_000);
      const h2 = await handBack(`${P}-h2`, 20_000, { noNote: true });
      const linkId = await voidInXero(`${P}-v`, 20_000);
      const outcome = await followUp.followUpVoidedBankRefundNote(linkId);
      expect(outcome).toMatchObject({ outcome: "undone" });

      // H2's own note, queued and raised after the follow-up (a create in flight would defer the undo).
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 20_000, { refundMethod: "internet-banking", paidAnotherWayTaskId: h2 });
      const rowId = queued.queueOperationId!;
      expect(await raiseThenFailPayment(rowId, `${P}-x`)).toMatchObject({ status: "PARTIAL", xeroObjectId: `${P}-x` });
      if (options.resolve) await resolveByHand(rowId);
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-x` }, data: { active: false } });
      return { h2, rowId, followUpId: outcome!.followUpTaskId! };
    }

    /** The treasurer's "already recorded it in Xero myself" answer naming `id`, checked against a fake Xero. */
    async function answerWith(followUpId: string, id: string) {
      const { prepareBankRefundVoidAnswer } = await import("@/lib/bank-refund-void-answer");
      const xeroNote = { creditNoteID: id, creditNoteNumber: `CN-${id}`, status: "AUTHORISED", type: "ACCRECCREDIT", total: 200, contact: { contactID: CONTACT_ID }, allocations: [] };
      return withFakeXero(
        {
          getCreditNotes: async () => ({ body: { creditNotes: [xeroNote] } }),
          getInvoice: async () => ({ body: { invoices: [{ contact: { contactID: CONTACT_ID } }] } }),
        },
        () => prepareBankRefundVoidAnswer({ taskId: followUpId, answer: { answer: "recorded-in-xero", creditNoteNumber: `CN-${id}` }, format: CLUB_FORMAT_TEST }),
      );
    }

    /** The follow-up's completion, through the real resolution, with that answer. */
    async function complete(followUpId: string, answer: Awaited<ReturnType<typeof answerWith>>) {
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      return resolveManualRefundTask(
        { taskId: followUpId, resolution: "completed", note: null, actingMemberId: OFFICER_ID, confirmedAmountCents: null, direction: null, recordedNightPrices: null, bankRefundVoidAnswer: answer },
        CLUB_FORMAT_TEST,
      );
    }

    /**
     * The money, each task's own coverage, and the follow-up's state: what a
     * refused answer must leave alone. H2's is its record's share
     * (`readPaidAnotherWayCloseShare`, its own rows); the follow-up's, while
     * open, is what the bank-void scan reads for it - the hand-made notes
     * linked to it (no create row names it).
     */
    async function books(h2: string, followUpId: string) {
      const { readPaidAnotherWayCloseShare } = await import("@/lib/card-refund-paid-another-way-cash");
      const { sumCoveredRefundCreditNoteCents } = await import("@/lib/xero-sync");
      const h2Share = (await readPaidAnotherWayCloseShare(prisma, PAYMENT_ID, h2))!;
      const handMade = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE", active: true, metadata: { path: ["handBackTaskId"], equals: followUpId } },
        select: { xeroObjectId: true },
      });
      return {
        refundedAmountCents: (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).refundedAmountCents,
        coverageCents: (await coverage()).totalCents,
        h2: { coveredCents: h2Share.coveredCents, uncoveredCents: h2Share.uncoveredCents },
        followUpCoveredCents: await sumCoveredRefundCreditNoteCents(PAYMENT_ID, prisma, handMade.map((link) => link.xeroObjectId)),
        followUpStatus: (await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: followUpId }, select: { status: true } })).status,
        xActive: (await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-x` }, select: { active: true } })).active,
      };
    }

    const refused = { status: 409, message: expect.stringContaining(`CN-${P}-x is already recorded`) };

    it("MUTATION (#4321): the hand-made answer refuses a note a row resolved by hand records, and nothing moves; a note no row records is taken", async () => {
      const { h2, followUpId } = await followUpBesideNoteX({ resolve: true });
      const before = await books(h2, followUpId);
      // H1 undone ($200 back off the total); H2's own note X covers H2 through its resolved row.
      expect(before).toEqual({
        refundedAmountCents: 20_000, coverageCents: 20_000, h2: { coveredCents: 20_000, uncoveredCents: 0 },
        followUpCoveredCents: 0, followUpStatus: "OPEN", xActive: false,
      });

      // Before the fix X was reactivated for the follow-up: one $200 note recorded both refunds.
      await expect(complete(followUpId, await answerWith(followUpId, `${P}-x`))).rejects.toMatchObject(refused);
      expect(await books(h2, followUpId)).toEqual(before);

      // A note of its own, which no row records, is taken: the $200 goes back on, and both refunds are covered once each.
      await complete(followUpId, await answerWith(followUpId, `${P}-own`));
      expect(await books(h2, followUpId)).toEqual({
        refundedAmountCents: 40_000, coverageCents: 40_000, h2: { coveredCents: 20_000, uncoveredCents: 0 },
        followUpCoveredCents: 20_000, followUpStatus: "COMPLETED", xActive: false,
      });
      expect(await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-own` }, select: { active: true } })).toEqual({ active: true });
    });

    it("MUTATION (#4321, sequential): a note whose row is still PARTIAL is refused, so resolving that row later never leaves one note recording two refunds", async () => {
      const { h2, rowId, followUpId } = await followUpBesideNoteX({ resolve: false });
      const before = await books(h2, followUpId);
      // R unresolved, X's mirror off: nothing covers H2 yet - a visible gap.
      expect(before).toMatchObject({ refundedAmountCents: 20_000, coverageCents: 0, h2: { coveredCents: 0, uncoveredCents: 20_000 }, followUpCoveredCents: 0 });

      // A resolved-only guard took X here (R unresolved), and the resolve below then made X cover H2 and the follow-up both.
      await expect(complete(followUpId, await answerWith(followUpId, `${P}-x`))).rejects.toMatchObject(refused);
      await resolveByHand(rowId);

      const after = await books(h2, followUpId);
      expect(after).toEqual({ ...before, coverageCents: 20_000, h2: { coveredCents: 20_000, uncoveredCents: 0 } });
      expect(after).toMatchObject({ refundedAmountCents: 20_000, followUpCoveredCents: 0, followUpStatus: "OPEN", xActive: false });
    });

    it("MUTATION (#4321, interleaving): a resolve committing while the completion holds its locks past the guard leaves the answer refused, and no note covers two refunds", async () => {
      const { h2, rowId, followUpId } = await followUpBesideNoteX({ resolve: false });
      const answer = await answerWith(followUpId, `${P}-x`);
      const before = await books(h2, followUpId);

      // A barrier on the link write, which runs only after the guard passes: a
      // completion that got past the guard waits there, inside its transaction,
      // while the officer's resolve commits from another session.
      const xeroSync = await import("@/lib/xero-sync");
      const realUpsert = xeroSync.upsertXeroObjectLink;
      let reachedLinkWrite!: () => void;
      const atLinkWrite = new Promise<"past-guard">((resolve) => (reachedLinkWrite = () => resolve("past-guard")));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const spy = vi.spyOn(xeroSync, "upsertXeroObjectLink").mockImplementation(async (...args: Parameters<typeof realUpsert>) => {
        if (args[0].xeroObjectId === `${P}-x`) {
          reachedLinkWrite();
          await released;
        }
        return realUpsert(...args);
      });
      try {
        const completion = complete(followUpId, answer);
        void completion.catch(() => undefined);
        const where = await Promise.race([atLinkWrite, completion.then(() => "done" as const, () => "done" as const)]);
        // Session B: the officer resolves R through the real route, and it commits.
        await resolveByHand(rowId);
        release();
        await expect(completion).rejects.toMatchObject(refused);
        // The fixed guard refuses at its read, before the link write: the barrier is never reached.
        expect(where).toBe("done");
      } finally {
        release();
        spy.mockRestore();
      }

      expect(await books(h2, followUpId)).toEqual({ ...before, coverageCents: 20_000, h2: { coveredCents: 20_000, uncoveredCents: 0 } });
    });
  },
);
