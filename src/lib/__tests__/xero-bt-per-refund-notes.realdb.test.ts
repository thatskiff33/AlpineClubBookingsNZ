/**
 * Real-PostgreSQL proofs for #4287 (owner decision 22 Oct 2026,
 * `INV-ADDPAY-043`): on a bank-transfer payment, a cancellation hand-back
 * completed after the payment has its canonical refund note, or on a payment
 * holding card money, gets a note of its own, keyed and sized on its task -
 * never absorbed into the canonical note.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking; the payment and its charge rows (what an Internet
 *   Banking receipt, and on the mixed payment an edit's card capture, leave);
 *   each OPEN cancellation hand-back (the shape the cancel's manual branch
 *   raises - no writer raises a second one beside an existing one, and #4230
 *   reproduced the absorption with exactly this shape); and, in one case, what
 *   a completion before #4287 left (task, allocation and ledger line, written
 *   through `applyLocalRefundAllocation` and `postHandBackLedgerLine`).
 * - REAL: completions (`resolveManualRefundTask`); card refunds
 *   (`refundPaymentTransactions`, Stripe's create answered as Stripe would);
 *   the card note through the enqueue call a card note with no keyed options
 *   makes (the cancel's card branch; before #4312, a refund request's card
 *   part too, which `xero-bt-card-refund-notes` now proves on its own); every
 *   note through the outbox worker and every Xero event through the inbound
 *   reconcile, both against a fake Xero transport (no provider call); the
 *   nightly undo of a voided note (`followUpVoidedBankRefundNote`).
 *
 * Proven: one note per refund and no absorption, including two equal-amount
 * hand-backs racing; a card refund landing after the completion cannot shrink
 * the note; the hand-back's note never squeezes a card note, and once Xero
 * voids it and the nightly undo takes its refund back it no longer counts
 * anywhere; the coverage and gap readers show nothing uncovered, the #4162
 * floor raises no alert, and the deploy note lists nothing; a refund the old
 * release absorbed is never given a note; the nightly self-heal never selects a
 * bank-transfer payment.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4287-`
 * fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import type { ResolvedBankRefundVoidAnswer } from "@/lib/bank-refund-void-answer";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4287";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const BANK_TXN_ID = `${P}-bank-txn`;
const CARD_TXN_ID = `${P}-card-txn`;
const CARD_INTENT_ID = "pi_race_4287";
const INVOICE_ID = `${P}-invoice`;

let prisma: (typeof import("@/lib/prisma"))["prisma"];

/** Stripe's refund create, answered once per idempotency key as Stripe does, while a case runs. */
const stripe = { createdSeconds: 0, byKey: new Map<string, unknown>() };
function answerRefundsAsStripeWould(params: { paymentIntentId: string; amountCents: number; metadata?: Record<string, string>; idempotencyKey?: string }) {
  const key = params.idempotencyKey ?? `${P}-${stripe.byKey.size}`;
  if (!stripe.byKey.has(key)) {
    stripe.createdSeconds += 1;
    stripe.byKey.set(key, {
      id: `re_race_4287_${stripe.byKey.size}`, object: "refund", amount: params.amountCents, currency: "nzd", status: "succeeded",
      reason: "requested_by_customer", created: stripe.createdSeconds, charge: "ch_race_4287", payment_intent: params.paymentIntentId, metadata: params.metadata ?? {},
    });
  }
  return Promise.resolve(stripe.byKey.get(key) as never);
}

(RUN ? describe : describe.skip)(
  "a later refund on a bank-transfer payment gets its own Xero credit note - real PostgreSQL (#4287)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.xeroObjectLink.deleteMany({ where: { localModel: "BookingModification", localId: { startsWith: P } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "BookingModification", localId: { startsWith: P } } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: OFFICER_ID }, { targetId: BOOKING_ID }] } });
      stripe.byKey.clear();
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Bank-transfer per-refund notes (#4287)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Per", lastName: "Refund", role, ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4287 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 25_000, finalPriceCents: 25_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
    }, 60_000);

    let refundSpy: { mockRestore: () => void } | undefined;
    beforeEach(async () => {
      await clearRun();
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "CANCELLED" } });
      const stripeModule = await import("@/lib/stripe");
      refundSpy = vi.spyOn(stripeModule, "processRefund").mockImplementation(answerRefundsAsStripeWould);
    });

    afterEach(() => {
      refundSpy?.mockRestore();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /** A $200 Internet Banking receipt (and, `withCard`, an edit's $50 card capture on it): what the receipt and capture writers leave. */
    async function paid(options: { withCard?: boolean } = {}) {
      const cardCents = options.withCard ? 5_000 : 0;
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000 + cardCents, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
      });
      await prisma.paymentTransaction.create({
        data: { id: BANK_TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 20_000, status: "SUCCEEDED" },
      });
      if (options.withCard) {
        await prisma.paymentTransaction.create({
          // Captured before the receipt was recorded, so a hand-back's allocation (newest first) takes the bank row.
          data: { id: CARD_TXN_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: CARD_INTENT_ID, amountCents: cardCents, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
        });
      }
    }

    /** An OPEN cancellation hand-back on the payment, as the cancel's manual branch raises it. */
    async function raiseHandBack(id: string, cents: number) {
      await prisma.manualRefundTask.create({
        data: { id, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: cents, raisedAmountCents: cents, kind: "CANCELLED_BOOKING_HAND_BACK", reason: `${P} hand-back` },
      });
      return id;
    }

    async function complete(taskId: string) {
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      return resolveManualRefundTask(
        { taskId, resolution: "completed", note: null, actingMemberId: OFFICER_ID, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null },
        CLUB_FORMAT_TEST,
      );
    }

    /** The edit capture's card refund, made through the real refund writer with Stripe answered as Stripe would. */
    async function refundCard(cents: number) {
      const { refundPaymentTransactions } = await import("@/lib/payment-transactions");
      await refundPaymentTransactions({ paymentId: PAYMENT_ID, amountCents: cents, idempotencyKeyPrefix: `${P}-card`, format: CLUB_FORMAT_TEST });
    }

    /** The refund-note rows on the payment, oldest first: amount asked, the record it names, its key. */
    async function noteRows() {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, status: true, correlationKey: true, requestPayload: true },
      });
      const { parsePaymentCreditNoteRetryInput } = await import("@/lib/xero-payment-credit-note-payload");
      return rows.map((row) => {
        // Either shape the row holds: as queued, or as the worker rewrote it.
        const recorded = parsePaymentCreditNoteRetryInput(row);
        return { id: row.id, status: row.status, cents: recorded?.amountCents, ownRecord: recorded?.paidAnotherWayTaskId ?? null, handBackTaskId: recorded?.handBackTaskId ?? null, key: row.correlationKey };
      });
    }

    /** The outbox worker for one queued note, against a fake Xero. Returns what Xero was asked to raise. */
    async function raiseQueuedNote(operationId: string, noteId: string) {
      const sent: number[] = [];
      const xero = {
        accountingApi: {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }) => {
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            sent.push(Math.round(total * 100));
            return { body: { creditNotes: [{ creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, total, remainingCredit: total, status: "AUTHORISED", payments: [] }] } };
          },
          getCreditNote: async () => ({ body: { creditNotes: [] } }),
          createCreditNoteAllocation: async (_t: string, _id: string, body: unknown) => ({ body }),
        },
      };
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4287" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-4287"),
        vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (opts: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
          opts.run({ contactId: opts.currentContactId })) as never),
        vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: P }),
      ];
      try {
        // Oldest first is the worker's order: this row goes first, alone.
        await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${operationId}`;
        const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
        await processQueuedXeroOutboxOperations({ limit: 1 });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return sent;
    }

    /** The inbound reconcile of one note, read from a fake Xero, and the refund-ledger divergence alerts it raised. */
    async function reconcile(noteId: string, cents: number, status = "AUTHORISED", allocated = false): Promise<string[]> {
      const note = { creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, status, total: cents / 100,
        appliedAmount: allocated ? cents / 100 : 0, remainingCredit: allocated ? 0 : cents / 100,
        allocations: allocated ? [{ invoice: { invoiceID: INVOICE_ID }, amount: cents / 100 }] : [], payments: [] };
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const alerting = await import("@/lib/xero-error-alert");
      const alertSpy = vi.spyOn(alerting, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4287" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
        await reconcileXeroCreditNote(noteId);
        return alertSpy.mock.calls
          .map(([input]) => input as { errorType: string; operation: string })
          .filter((input) => input.errorType === "refund-ledger-divergence")
          .map((input) => input.operation);
      } finally {
        for (const spy of spies) spy.mockRestore();
        alertSpy.mockRestore();
      }
    }

    /** Xero voids the note (its event reconciled), then the #4162 nightly follow-up undoes its refund. */
    async function voidAndUndo(noteId: string, cents: number) {
      await reconcile(noteId, cents, "VOIDED");
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: noteId, role: "REFUND_CREDIT_NOTE" }, select: { id: true, active: true } });
      expect(link.active).toBe(false);
      const { followUpVoidedBankRefundNote } = await import("@/lib/bank-refund-void-follow-up");
      expect(await followUpVoidedBankRefundNote(link.id)).toMatchObject({ outcome: "undone" });
    }

    /** The #4230 deploy note's read-only query, run as an operator would: whether it lists this payment. */
    async function deployNoteLists(): Promise<boolean> {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const doc = readFileSync(resolve(__dirname, "../../../docs/xero/ARCHITECTURE.md"), "utf8");
      const sql = /```sql\n([\s\S]*?)\n```/.exec(doc.slice(doc.indexOf("**Deploy note (#4230).**")))?.[1];
      expect(sql).toBeDefined();
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(sql!);
      return rows.some((row) => row.id === PAYMENT_ID);
    }

    /** What the coverage and gap readers report, and the payment's refunded total against its charge rows. */
    async function readers() {
      const { readResolvedRefundCreditNoteCoverage, sumRefundCreditNoteCoverageCents } = await import("@/lib/xero-resolved-in-xero-fences");
      const { readRefundCreditNoteGap } = await import("@/lib/xero-admin-health");
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { id: true, bookingId: true, refundedAmountCents: true } });
      const rows = await prisma.paymentTransaction.aggregate({ where: { paymentId: PAYMENT_ID }, _sum: { refundedAmountCents: true } });
      const coveredCents = await sumRefundCreditNoteCoverageCents(PAYMENT_ID, await readResolvedRefundCreditNoteCoverage(PAYMENT_ID));
      return {
        refundedCents: payment.refundedAmountCents,
        rowsCents: rows._sum.refundedAmountCents ?? 0,
        coveredCents,
        uncoveredCents: (await readRefundCreditNoteGap(payment)).uncoveredCents,
      };
    }

    /** The first hand-back, completed and noted through the real writers: the payment's canonical note. */
    async function firstHandBackNoted() {
      const first = await raiseHandBack(`${P}-first`, 10_000);
      await complete(first);
      const [row] = await noteRows();
      expect(row).toMatchObject({ cents: 10_000, ownRecord: null, handBackTaskId: first });
      expect(await raiseQueuedNote(row!.id, `${P}-canonical`)).toEqual([10_000]);
      // Xero's event for the new note arrives: its reconcile records it, and nothing is short.
      expect(await reconcile(`${P}-canonical`, 10_000)).toEqual([]);
      const field = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } });
      expect(field.xeroRefundCreditNoteId).toBe(`${P}-canonical`);
      return first;
    }

    it.each([false, true])("an early edit note moves no cash before completion, including dismissal/reopen=%s (#4315 item 1)", async (dismissAndReopen) => {
      await paid();
      // An edit on a live booking can also be dismissed and reopened by an officer.
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "CONFIRMED" } });
      const modificationId = `${P}-early-edit`;
      const noteId = `${P}-early-edit-note`;
      // Only the edit's stored price change is seeded. Its hand-back and note
      // are raised by their real writers, then worker, inbound and completion run.
      await prisma.bookingModification.create({ data: {
        id: modificationId, bookingId: BOOKING_ID, memberId: MEMBER_ID,
        modificationType: "BATCH_MODIFY", previousData: {}, newData: {}, priceDiffCents: -5_000,
      } });
      const { raiseEditRefundHandBackIfOwed } = await import("@/lib/edit-refund-hand-back");
      const { enqueueXeroModificationCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await raiseEditRefundHandBackIfOwed(tx, {
          bookingId: BOOKING_ID, paymentId: PAYMENT_ID, bookingModificationId: modificationId,
          adjusted: { refundAmountCents: 5_000, hasSucceededPayment: false }, editLabel: "price reduction",
          booking: { organiserSettled: false, parentBookingId: null, payment: { source: "INTERNET_BANKING" } },
        });
        return enqueueXeroModificationCreditNoteOperation({
          bookingId: BOOKING_ID, bookingModificationId: modificationId,
          refundAmountCents: 5_000, refundMethod: "internet-banking",
        }, { store: tx });
      });
      expect(await raiseQueuedNote(queued.queueOperationId!, noteId)).toEqual([5_000]);
      const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID } });
      expect(task.status).toBe("OPEN");
      const { repairRefundedPaymentBusinessState } = await import("@/lib/xero-inbound/credit-note-repairs");
      const recount = () => repairRefundedPaymentBusinessState({
        creditNoteId: null, creditNote: {}, directPaymentIds: [],
        modificationRefundAmountsByPaymentId: new Map(), retryPaymentIds: [PAYMENT_ID],
      });
      const refunded = async () => (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).refundedAmountCents;
      // Simulate the mirror an old inbound worker left; the task and note
      // above were created by real writers. Normal inbound resync must repair
      // this historical projection without a separate forced recount.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" } });
      await reconcile(noteId, 5_000, "AUTHORISED", true);
      expect(await refunded()).toBe(0);
      await recount();
      expect(await refunded()).toBe(0);
      expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" } })).toBe(0);
      if (dismissAndReopen) {
        const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
        await resolveManualRefundTask({
          taskId: task.id, resolution: "dismissed", note: "No bank payment was made.",
          actingMemberId: OFFICER_ID, recordedNightPrices: null,
        }, CLUB_FORMAT_TEST);
        expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "DISMISSED" });
        await reconcile(noteId, 5_000, "AUTHORISED", true);
        await recount();
        expect(await refunded()).toBe(0);
        expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" } })).toBe(0);
        const { reopenManualRefundTask } = await import("@/lib/manual-refund-task-reopen");
        await reopenManualRefundTask({ taskId: task.id, actingMemberId: OFFICER_ID, note: "The bank refund is still owed." });
        await reconcile(noteId, 5_000, "AUTHORISED", true);
        await recount();
        expect(await refunded()).toBe(0);
      }
      await complete(task.id);
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "COMPLETED" });
      expect(await refunded()).toBe(5_000);
      await reconcile(noteId, 5_000, "AUTHORISED", true);
      await recount();
      expect(await refunded()).toBe(5_000);
      expect(await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" }, select: { amountCents: true } })).toEqual([{ amountCents: -5_000 }]);
    });

    it("a second cancellation hand-back gets its own note, keyed and sized on its task: one note per refund, no absorption", async () => {
      await paid();
      await firstHandBackNoted();
      const second = await raiseHandBack(`${P}-second`, 3_000);
      await complete(second);

      const rows = await noteRows();
      expect(rows.map(({ cents, ownRecord, handBackTaskId }) => ({ cents, ownRecord, handBackTaskId }))).toEqual([
        { cents: 10_000, ownRecord: null, handBackTaskId: `${P}-first` },
        { cents: 3_000, ownRecord: second, handBackTaskId: second },
      ]);
      expect(rows[1]!.key).toContain(`:paid-another-way:${second}`);
      expect(await raiseQueuedNote(rows[1]!.id, `${P}-second-note`)).toEqual([3_000]);
      expect(await reconcile(`${P}-second-note`, 3_000)).toEqual([]);

      // Its link is a per-refund one beside the canonical, which keeps the payment's pointer.
      const links = await prisma.xeroObjectLink.findMany({ where: { localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE", active: true }, select: { xeroObjectId: true, metadata: true }, orderBy: { xeroObjectId: "asc" } });
      expect(links.map((link) => [link.xeroObjectId, (link.metadata as { perDelta?: boolean }).perDelta ?? false])).toEqual([
        [`${P}-canonical`, false],
        [`${P}-second-note`, true],
      ]);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } })).xeroRefundCreditNoteId).toBe(`${P}-canonical`);

      // The readers count it through its link: nothing uncovered, the floor raises nothing, the deploy note lists nothing.
      expect(await readers()).toEqual({ refundedCents: 13_000, rowsCents: 13_000, coveredCents: 13_000, uncoveredCents: 0 });
      expect(await reconcile(`${P}-canonical`, 10_000)).toEqual([]);
      expect(await reconcile(`${P}-second-note`, 3_000)).toEqual([]);
      expect((await readers()).refundedCents).toBe(13_000);
      expect(await deployNoteLists()).toBe(false);

      // A replay of the completion's own ask is the same row, never a second note.
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 3_000, { createdByMemberId: OFFICER_ID, refundMethod: "internet-banking", handBackTaskId: second, paidAnotherWayTaskId: second });
      expect(await noteRows()).toHaveLength(2);
    });

    it("two hand-backs completed at once on a payment with no note yet: one canonical note and one of its own, never both canonical (race)", async () => {
      await paid();
      const a = await raiseHandBack(`${P}-race-a`, 6_000);
      const b = await raiseHandBack(`${P}-race-b`, 4_000);
      await Promise.all([complete(a), complete(b)]);

      const rows = await noteRows();
      expect(rows).toHaveLength(2);
      // Whichever took the Payment row lock first is the canonical one; the other is keyed on its own task.
      const canonical = rows.filter((row) => row.ownRecord === null);
      const own = rows.filter((row) => row.ownRecord !== null);
      expect(canonical).toHaveLength(1);
      expect(own).toHaveLength(1);
      expect(own[0]!.ownRecord).toBe(own[0]!.handBackTaskId);
      expect(new Set(rows.map((row) => row.handBackTaskId))).toEqual(new Set([a, b]));

      // Raised in either order, each note is its own refund's amount.
      const sentOwn = await raiseQueuedNote(own[0]!.id, `${P}-race-own`);
      const sentCanonical = await raiseQueuedNote(canonical[0]!.id, `${P}-race-canonical`);
      await reconcile(`${P}-race-own`, sentOwn[0]!);
      expect(await reconcile(`${P}-race-canonical`, sentCanonical[0]!)).toEqual([]);
      expect(sentOwn).toEqual([own[0]!.cents]);
      expect(sentCanonical).toEqual([canonical[0]!.cents]);
      expect(sentOwn[0]! + sentCanonical[0]!).toBe(10_000);
      expect(await readers()).toEqual({ refundedCents: 10_000, rowsCents: 10_000, coveredCents: 10_000, uncoveredCents: 0 });
      expect(await deployNoteLists()).toBe(false);
    });

    it("two hand-backs of the same amount completed at once: two notes, never one key deduped into one row (review F5)", async () => {
      await paid();
      const a = await raiseHandBack(`${P}-equal-a`, 5_000);
      const b = await raiseHandBack(`${P}-equal-b`, 5_000);
      await Promise.all([complete(a), complete(b)]);

      const rows = await noteRows();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.handBackTaskId))).toEqual(new Set([a, b]));
      expect(rows.filter((row) => row.ownRecord !== null)).toHaveLength(1);
      const raised = [...(await raiseQueuedNote(rows[0]!.id, `${P}-equal-1`)), ...(await raiseQueuedNote(rows[1]!.id, `${P}-equal-2`))];
      expect(raised).toEqual([5_000, 5_000]);
      expect((await readers()).coveredCents).toBe(10_000);
    });

    it("a card refund landing after the hand-back completes cannot shrink its note: a payment holding card money takes the own route (review F2)", async () => {
      await paid({ withCard: true });
      const handBack = await raiseHandBack(`${P}-before-card`, 10_000);
      await complete(handBack);
      const [own] = await noteRows();
      expect(own).toMatchObject({ cents: 10_000, ownRecord: handBack });
      // The edit capture's card refund lands before the hand-back's note runs.
      await refundCard(4_000);
      expect(await raiseQueuedNote(own!.id, `${P}-before-card-note`)).toEqual([10_000]);
    });

    it("once Xero voids the hand-back's own note and the nightly undo takes its refund back, a later card note is raised in full (review F1)", async () => {
      await paid({ withCard: true });
      const handBack = await raiseHandBack(`${P}-voided-own`, 10_000);
      await complete(handBack);
      const [own] = await noteRows();
      expect(own).toMatchObject({ ownRecord: handBack });
      await raiseQueuedNote(own!.id, `${P}-voided-own-note`);
      await reconcile(`${P}-voided-own-note`, 10_000);
      await voidAndUndo(`${P}-voided-own-note`, 10_000);
      expect((await readers()).refundedCents).toBe(0);
      // Its refund no longer stands, so it is no noted bank cash (what the void scan and the capacity-race check read).
      const { readPaidAnotherWayCash } = await import("@/lib/card-refund-paid-another-way-cash");
      expect((await readPaidAnotherWayCash(prisma, PAYMENT_ID)).notedCents).toBe(0);

      // Later, a card refund and its note: the enqueue a card note with no keyed options makes (the cancel's card branch).
      await refundCard(4_000);
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 4_000, { createdByMemberId: OFFICER_ID });
      expect(await raiseQueuedNote(queued.queueOperationId!, `${P}-after-void-card`)).toEqual([4_000]);
    });

    /** The follow-up the nightly undo raised for a task's voided note. */
    async function followUpOf(taskId: string) {
      return prisma.manualRefundTask.findFirstOrThrow({
        where: { bookingId: BOOKING_ID, occurrenceKey: { startsWith: "bank-refund-void:" }, reviewContext: { path: ["bankRefundVoidFollowUp", "originalTaskId"], equals: taskId } },
        select: { id: true, amountCents: true, status: true },
      });
    }

    /**
     * The treasurer re-confirms a follow-up (`resolveManualRefundTask`): with a fresh note, or with a
     * note made by hand in Xero. The hand-made answer is passed already checked, as the completion
     * route passes it after `prepareBankRefundVoidAnswer` has read the note from Xero - so no Xero call.
     */
    async function reconfirmWithFreshNote(followUpId: string, answer: ResolvedBankRefundVoidAnswer = { answer: "fresh-note" }) {
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        { taskId: followUpId, resolution: "completed", note: null, actingMemberId: OFFICER_ID, confirmedAmountCents: null, direction: null, recordedNightPrices: null, bankRefundVoidAnswer: answer },
        CLUB_FORMAT_TEST,
      );
    }

    /** A note the treasurer made by hand in Xero for the whole $100, as the "already in Xero" check returns it. */
    const handMadeNote = (id: string) => ({ answer: "recorded-in-xero" as const, note: { creditNoteId: id, creditNoteNumber: `CN-${id}`, amountCents: 10_000, status: "AUTHORISED", total: 100, updatedDateUTC: null } });

    /** A later card refund and its note, through the enqueue a card note with no keyed options makes: what Xero is asked to raise. */
    async function laterCardNote(noteId: string) {
      await refundCard(4_000);
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 4_000, { createdByMemberId: OFFICER_ID });
      return raiseQueuedNote(queued.queueOperationId!, noteId);
    }

    async function notedBankCents() {
      const { readPaidAnotherWayCash } = await import("@/lib/card-refund-paid-another-way-cash");
      return (await readPaidAnotherWayCash(prisma, PAYMENT_ID)).notedCents;
    }

    /** A mixed payment's hand-back noted on its own task, its note voided in Xero and undone: its follow-up. */
    async function handBackVoidedAndUndone() {
      await paid({ withCard: true });
      const handBack = await raiseHandBack(`${P}-reconfirm`, 10_000);
      await complete(handBack);
      const [own] = await noteRows();
      await raiseQueuedNote(own!.id, `${P}-reconfirm-note`);
      await reconcile(`${P}-reconfirm-note`, 10_000);
      await voidAndUndo(`${P}-reconfirm-note`, 10_000);
      return followUpOf(handBack);
    }

    /** That follow-up re-confirmed with a fresh note, raised and reconciled. */
    async function reconfirmedAfterVoid() {
      const followUp = await handBackVoidedAndUndone();
      await reconfirmWithFreshNote(followUp.id);
      const fresh = (await noteRows()).at(-1)!;
      expect(fresh).toMatchObject({ cents: 10_000, ownRecord: followUp.id });
      expect(await raiseQueuedNote(fresh.id, `${P}-fresh-note`)).toEqual([10_000]);
      await reconcile(`${P}-fresh-note`, 10_000);
      return followUp.id;
    }

    it("a re-confirmed follow-up's fresh note counts beside its cash: a later card note is raised in full (#4315 item 2)", async () => {
      await reconfirmedAfterVoid();
      // The hand-back nets to nothing; the re-confirmed refund counts once, as the follow-up's.
      expect(await notedBankCents()).toBe(10_000);
      expect(await laterCardNote(`${P}-after-reconfirm-card`)).toEqual([4_000]);
      expect(await readers()).toMatchObject({ refundedCents: 14_000, rowsCents: 14_000, coveredCents: 14_000, uncoveredCents: 0 });
    });

    it("the re-confirmed follow-up's own note voided and undone in turn: it counts for nothing, dismissed after it too, and a later card note is raised in full (#4315 item 2)", async () => {
      const followUpId = await reconfirmedAfterVoid();
      await voidAndUndo(`${P}-fresh-note`, 10_000);
      const second = await followUpOf(followUpId);
      expect(await notedBankCents()).toBe(0);
      // The transfer bounced: the second follow-up is dismissed, and nothing counts.
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        { taskId: second.id, resolution: "dismissed", note: "The transfer bounced.", actingMemberId: OFFICER_ID, recordedNightPrices: null },
        CLUB_FORMAT_TEST,
      );
      expect(await notedBankCents()).toBe(0);
      expect(await laterCardNote(`${P}-after-second-void-card`)).toEqual([4_000]);
    });

    it("a follow-up re-confirmed with a note made by hand in Xero counts once and that note covers it: a later card note is raised in full (#4315 item 2)", async () => {
      const followUp = await handBackVoidedAndUndone();
      await reconfirmWithFreshNote(followUp.id, handMadeNote(`${P}-hand`));
      // No create row raised it: the link names the follow-up and is marked made by hand.
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-hand` } })).toBe(0);
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-hand` }, select: { active: true, metadata: true } });
      expect(link).toMatchObject({ active: true, metadata: expect.objectContaining({ handBackTaskId: followUp.id, recordedByHand: true }) });
      const { readPaidAnotherWayUncoveredCents } = await import("@/lib/card-refund-paid-another-way-cash");
      expect(await notedBankCents()).toBe(10_000);
      expect(await readPaidAnotherWayUncoveredCents(prisma, PAYMENT_ID)).toBe(0);
      expect(await laterCardNote(`${P}-after-hand-card`)).toEqual([4_000]);
      expect(await readers()).toMatchObject({ refundedCents: 14_000, rowsCents: 14_000, coveredCents: 14_000, uncoveredCents: 0 });
    });

    it("that hand-made note voided in Xero and undone in turn: the follow-up counts for nothing, and a later card note is raised in full (#4315 item 2)", async () => {
      const followUp = await handBackVoidedAndUndone();
      await reconfirmWithFreshNote(followUp.id, handMadeNote(`${P}-hand-voided`));
      await reconcile(`${P}-hand-voided`, 10_000);
      await voidAndUndo(`${P}-hand-voided`, 10_000);
      expect(await followUpOf(followUp.id)).toMatchObject({ amountCents: 10_000 });
      expect(await notedBankCents()).toBe(0);
      expect(await laterCardNote(`${P}-after-hand-void-card`)).toEqual([4_000]);
    });

    it("once Xero voids a hand-back's own note and the nightly undo takes it back, a later canonical note on a bank transfer is raised in full (review F1)", async () => {
      await paid();
      const first = await firstHandBackNoted();
      const second = await raiseHandBack(`${P}-voided-second`, 4_000);
      await complete(second);
      const [, own] = await noteRows();
      expect(own).toMatchObject({ ownRecord: second });
      await raiseQueuedNote(own!.id, `${P}-voided-second-note`);
      await reconcile(`${P}-voided-second-note`, 4_000);
      // Xero voids both notes; the nightly undo takes both refunds back, so the payment has no canonical note.
      await voidAndUndo(`${P}-voided-second-note`, 4_000);
      await voidAndUndo(`${P}-canonical`, 10_000);
      expect((await readers()).refundedCents).toBe(0);
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID, reviewContext: { path: ["bankRefundVoidFollowUp", "originalTaskId"], equals: first } } })).toBe(1);

      // A new hand-back is the payment's canonical refund again, and its note is its whole amount.
      const third = await raiseHandBack(`${P}-after-voids`, 5_000);
      await complete(third);
      const latest = (await noteRows()).at(-1)!;
      expect(latest).toMatchObject({ ownRecord: null, handBackTaskId: third });
      expect(await raiseQueuedNote(latest.id, `${P}-after-voids-note`)).toEqual([5_000]);
    });

    it("on a payment with a card refund, the hand-back's own note never squeezes the card note raised after it", async () => {
      await paid({ withCard: true });
      await refundCard(4_000);
      // The cancel's card branch's own call (`booking-cancel.ts`, no keyed options): the card note, still queued.
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 4_000, { createdByMemberId: OFFICER_ID });
      const handBack = await raiseHandBack(`${P}-mixed`, 10_000);
      await complete(handBack);

      const [card, own] = await noteRows();
      expect(card).toMatchObject({ cents: 4_000, ownRecord: null });
      expect(own).toMatchObject({ cents: 10_000, ownRecord: handBack, handBackTaskId: handBack });
      // The hand-back's note lands first (the card note's run failed and is retried
      // later). While the card note is still missing from Xero the floor's alert is true.
      expect(await raiseQueuedNote(own!.id, `${P}-mixed-own`)).toEqual([10_000]);
      expect(await reconcile(`${P}-mixed-own`, 10_000)).toEqual([`inbound-credit-note-repair:${P}-mixed-own`]);
      expect(await raiseQueuedNote(card!.id, `${P}-mixed-card`)).toEqual([4_000]);
      expect(await reconcile(`${P}-mixed-card`, 4_000)).toEqual([]);

      expect(await readers()).toEqual({ refundedCents: 14_000, rowsCents: 14_000, coveredCents: 14_000, uncoveredCents: 0 });
      expect(await reconcile(`${P}-mixed-own`, 10_000)).toEqual([]);
      expect(await deployNoteLists()).toBe(false);
    });

    it("on a payment with card refunds and no note yet, even the first hand-back is noted on its own record (the card cash would floor a canonical one)", async () => {
      await paid({ withCard: true });
      await refundCard(4_000);
      const handBack = await raiseHandBack(`${P}-first-mixed`, 10_000);
      await complete(handBack);

      const [own] = await noteRows();
      expect(own).toMatchObject({ cents: 10_000, ownRecord: handBack, handBackTaskId: handBack });
      expect(await raiseQueuedNote(own!.id, `${P}-first-mixed-own`)).toEqual([10_000]);
    });

    it("a refund the old release absorbed is never given a note: the next hand-back's note is its own amount alone", async () => {
      await paid();
      await firstHandBackNoted();
      // What a completion before #4287 left when its note was absorbed: the task,
      // its allocation and ledger line, and no note row of its own.
      const absorbed = `${P}-absorbed`;
      const { applyLocalRefundAllocation } = await import("@/lib/payment-transactions");
      const { postHandBackLedgerLine } = await import("@/lib/booking-ledger-hand-back");
      await prisma.$transaction(async (tx) => {
        await tx.manualRefundTask.create({
          data: {
            id: absorbed, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: 2_000, raisedAmountCents: 2_000, kind: "CANCELLED_BOOKING_HAND_BACK",
            status: "COMPLETED", completedAt: new Date("2026-06-01T00:00:00.000Z"), completedByMemberId: OFFICER_ID, settlementDirection: "REFUND_TO_MEMBER", reason: `${P} absorbed`,
          },
        });
        await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 2_000, store: tx });
        await postHandBackLedgerLine({
          bookingId: BOOKING_ID, lodgeId: LODGE_ID, manualRefundTaskId: absorbed, amountCents: 2_000, refundMethod: "internet-banking",
          paymentSource: "INTERNET_BANKING", officerMemberId: OFFICER_ID, store: tx,
        });
      });
      expect(await deployNoteLists()).toBe(true);

      const next = await raiseHandBack(`${P}-after-release`, 3_000);
      await complete(next);
      const rows = await noteRows();
      expect(rows.map((row) => [row.cents, row.ownRecord])).toEqual([[10_000, null], [3_000, next]]);
      expect(await raiseQueuedNote(rows[1]!.id, `${P}-after-release-note`)).toEqual([3_000]);
      // Xero is still short the absorbed $20, so the floor keeps the total and its alert stays true.
      expect(await reconcile(`${P}-after-release-note`, 3_000)).toEqual([`inbound-credit-note-repair:${P}-after-release-note`]);
      // Nothing was raised for the absorbed $20: it stays on the deploy note's list for the officer's hand-made note.
      expect(rows.some((row) => row.handBackTaskId === absorbed || row.ownRecord === absorbed)).toBe(false);
      expect(await readers()).toMatchObject({ refundedCents: 15_000, rowsCents: 15_000, coveredCents: 13_000 });
      expect(await deployNoteLists()).toBe(true);
    });

    it("the nightly self-heal never selects a bank-transfer payment, so it never asks for a note there", async () => {
      await paid({ withCard: true });
      await refundCard(4_000);
      const { getRefundsMissingXeroCreditNotes } = await import("@/lib/xero-admin-health");
      // A year after the payment last changed, well past the self-heal's grace window.
      const listed = async () => {
        const { updatedAt } = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { updatedAt: true } });
        const now = new Date(updatedAt.getTime() + 365 * 24 * 60 * 60 * 1000);
        return (await getRefundsMissingXeroCreditNotes({ now })).payments.some((payment) => payment.paymentId === PAYMENT_ID);
      };
      expect(await listed()).toBe(false);
      // The same uncovered card refund on a card payment is listed: the source is what leaves it out.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { source: "STRIPE" } });
      expect(await listed()).toBe(true);
    });
  },
);
