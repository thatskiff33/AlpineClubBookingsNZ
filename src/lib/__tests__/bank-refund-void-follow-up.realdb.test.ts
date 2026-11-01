/**
 * Real-PostgreSQL proof of #4162 (owner decision 17 Oct 2026, "undo, then ask
 * once", `INV-ADDPAY-042`): a voided bank-transfer refund credit note is undone
 * nightly in every app record and put back on the refund list with one
 * question.
 *
 * - The probe: an inbound void of a bank transfer's refund note now leaves the
 *   allocation, the `BANK_REFUND` line AND the total (the `INV-ADDPAY-021`
 *   floor), so only the follow-up moves them, together.
 * - The undo: allocation, line, total and the follow-up hand-back agree; the
 *   census explains the owed money by the open follow-up.
 * - A spare note moves nothing; a create in flight defers; an active mirror
 *   waits for #4161's heal; two runs raise one follow-up; a concurrent
 *   reconcile or inbound recount leaves the total equal to the detail.
 * - Both answers: a fresh note keyed and sized on the follow-up (a replay is
 *   the same row and key), and the treasurer's hand-made note, checked against
 *   a mocked Xero and then tracked, so its own void is caught again.
 * - The previous app version completing a follow-up as an ordinary hand-back.
 * - Report-only writes nothing; the count sorts one fixture per bucket; a
 *   person answers an unmatched note.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4162b-`
 * fixtures, and never runs the job over notes that are not its own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import type { ResolvedBankRefundVoidAnswer } from "@/lib/bank-refund-void-answer";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4162b";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const TXN_ID = `${P}-txn`;
const INVOICE_ID = `inv-${P}`;
const PAID_CENTS = 20_000;
const CONTACT_ID = `${P}-contact`;
/** The extra bookings the bucket count needs, one payment each. */
const BUCKET_BOOKINGS = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"].map((suffix) => `${P}-${suffix}`);

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Bank-refund void follow-up proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run bank-refund void follow-up proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Bank-refund void follow-up proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Bank-refund void follow-up proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let followUp: typeof import("@/lib/bank-refund-void-follow-up");
let scan: typeof import("@/lib/bank-refund-void-scan");
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "a voided bank-transfer refund note is undone, then asked once - real PostgreSQL (#4162)",
  { timeout: 90_000 },
  () => {
    const allBookingIds = [BOOKING_ID, ...BUCKET_BOOKINGS];
    const allPaymentIds = allBookingIds.map((id) => (id === BOOKING_ID ? PAYMENT_ID : `${id}-payment`));

    async function clearRun() {
      await prisma.auditLog.deleteMany({ where: { targetId: { in: allBookingIds } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: { in: allPaymentIds } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: allPaymentIds } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, allBookingIds);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: allBookingIds } } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: { in: allBookingIds } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: allBookingIds } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: allPaymentIds } } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: allPaymentIds } } });
      await prisma.payment.deleteMany({ where: { id: { in: allPaymentIds } } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: { in: allBookingIds } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    /** A paid bank-transfer payment on `bookingId`, with no refund yet. */
    async function paidBankTransfer(bookingId = BOOKING_ID, paymentId = PAYMENT_ID, txnId = TXN_ID) {
      await prisma.payment.create({
        data: { id: paymentId, bookingId, amountCents: PAID_CENTS, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: `${INVOICE_ID}-${bookingId}` },
      });
      await prisma.paymentTransaction.create({
        data: { id: txnId, paymentId, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: PAID_CENTS, status: "SUCCEEDED", xeroInvoiceId: `${INVOICE_ID}-${bookingId}` },
      });
    }

    /**
     * A refund handed back by bank transfer and noted in Xero, as the real
     * writers record it: the completed task, the allocation, its BANK_REFUND
     * line, the note's create row and its link. `names` is which payload key
     * names the task: `handBackTaskId` (a cancellation's note since #4162),
     * `reviewTaskId`, or none (a note from before #4162).
     */
    async function handBackNoted(
      noteId: string,
      cents: number,
      options?: {
        names?: "handBackTaskId" | "reviewTaskId" | "paidAnotherWayTaskId" | null;
        perDelta?: boolean;
        bookingId?: string;
        paymentId?: string;
        noteAmountCents?: number;
        noNote?: boolean;
        occurrenceKey?: string;
      },
    ) {
      const bookingId = options?.bookingId ?? BOOKING_ID;
      const paymentId = options?.paymentId ?? PAYMENT_ID;
      const { applyLocalRefundAllocation } = await import("@/lib/payment-transactions");
      const { postHandBackLedgerLine } = await import("@/lib/booking-ledger-hand-back");
      const { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } = await import("@/lib/xero-operation-outbox-payload");
      const taskId = `${P}-task-${noteId}`;
      await prisma.$transaction(async (tx) => {
        await tx.manualRefundTask.create({
          data: {
            id: taskId, bookingId, paymentId, kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: cents, raisedAmountCents: cents,
            status: "COMPLETED", completedAt: new Date(), completedByMemberId: OFFICER_ID, reason: P,
            ...(options?.occurrenceKey ? { occurrenceKey: options.occurrenceKey } : {}),
          },
        });
        await applyLocalRefundAllocation({ paymentId, amountCents: cents, store: tx });
        await postHandBackLedgerLine({
          bookingId, lodgeId: LODGE_ID, manualRefundTaskId: taskId, amountCents: cents, refundMethod: "internet-banking",
          paymentSource: "INTERNET_BANKING", officerMemberId: OFFICER_ID, store: tx,
        });
      });
      if (options?.noNote) return taskId;
      const noteCents = options?.noteAmountCents ?? cents;
      const key = `payment:${paymentId}:refund-credit-note:${noteCents}:v1:${noteId}`;
      const names = options?.names === undefined ? "handBackTaskId" : options.names;
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: paymentId,
          status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, xeroObjectNumber: `CN-${noteId}`,
          correlationKey: key, idempotencyKey: key, queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
          completedAt: new Date("2026-06-01T00:00:00.000Z"),
          requestPayload: {
            refundMethod: "internet-banking", refundAmountCents: noteCents, watermarkCents: noteCents,
            allocation: { invoiceId: `${INVOICE_ID}-${bookingId}`, amount: noteCents / 100 },
            ...(names ? { [names]: taskId } : {}),
            ...(options?.perDelta ? { perDelta: true } : {}),
          },
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, xeroObjectNumber: `CN-${noteId}`,
          role: "REFUND_CREDIT_NOTE", active: true,
          metadata: { amountCents: noteCents, watermarkCents: noteCents, status: "AUTHORISED", total: noteCents / 100, ...(options?.perDelta ? { perDelta: true } : {}) },
        },
      });
      if (!options?.perDelta) {
        await prisma.payment.update({ where: { id: paymentId }, data: { xeroRefundCreditNoteId: noteId } });
      }
      return taskId;
    }

    /** The inbound reconcile, reading `note` from a fake Xero (no provider call). */
    async function inbound(note: Record<string, unknown>) {
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4162b" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
        await reconcileXeroCreditNote(note.creditNoteID as string);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    function voidedNote(noteId: string, cents: number) {
      return { creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, status: "VOIDED", total: cents / 100, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [] };
    }

    async function linkIdOf(noteId: string, paymentId = PAYMENT_ID) {
      return (await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: paymentId, xeroObjectId: noteId }, select: { id: true } })).id;
    }

    /** Xero voids the note, as the inbound sync records it: the mirror lands inactive. */
    async function voidInXero(noteId: string, cents: number) {
      await inbound(voidedNote(noteId, cents));
      return linkIdOf(noteId);
    }

    async function money(paymentId = PAYMENT_ID, bookingId = BOOKING_ID) {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { refundedAmountCents: true, status: true } });
      const detail = await prisma.paymentTransaction.aggregate({ where: { paymentId }, _sum: { refundedAmountCents: true } });
      const lines = await prisma.bookingLedgerLine.findMany({
        where: { bookingId, kind: "BANK_REFUND" },
        select: { id: true, amountCents: true, postingKey: true, reversesLineId: true, anchorId: true },
        orderBy: [{ reversesLineId: { sort: "asc", nulls: "first" } }, { postingKey: "asc" }],
      });
      return { payment, detailCents: detail._sum.refundedAmountCents ?? 0, lines };
    }

    async function followUpTasks(bookingId = BOOKING_ID) {
      return prisma.manualRefundTask.findMany({
        where: { bookingId, occurrenceKey: { startsWith: "bank-refund-void:" } },
        select: { id: true, status: true, amountCents: true, occurrenceKey: true, reviewContext: true, kind: true, paymentId: true },
      });
    }

    async function census(bookingId = BOOKING_ID) {
      const { readBookingLedgerCensusRow } = await import("@/lib/booking-ledger-projection-census-store");
      const { evaluateBookingLedgerIdentities } = await import("@/lib/booking-ledger-projection-census");
      return evaluateBookingLedgerIdentities((await readBookingLedgerCensusRow(prisma, bookingId))!);
    }

    /** The booking's confirmation and cancellation charge lines, as a fully refunded cancelled booking holds them. */
    async function chargedAndCancelled() {
      const { postBookingLedgerLines } = await import("@/lib/booking-ledger-write");
      const { confirmationPromotionKey, reversalKey } = await import("@/lib/booking-ledger-posting-keys");
      const charge = {
        bookingId: BOOKING_ID, lodgeId: LODGE_ID, side: "CHARGE" as const, kind: "PROMOTION" as const, sign: 1 as const, quantity: 1,
        unitCents: PAID_CENTS, anchorKind: "CONFIRMATION" as const, anchorId: BOOKING_ID, narration: `${P} charge`,
        postingKey: confirmationPromotionKey(BOOKING_ID),
      };
      await prisma.$transaction((tx) => postBookingLedgerLines(tx, [charge]));
      const line = await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: BOOKING_ID, postingKey: charge.postingKey }, select: { id: true } });
      await prisma.$transaction((tx) =>
        postBookingLedgerLines(tx, [{ ...charge, sign: -1, anchorKind: "CANCELLATION", narration: `Reversed: ${P} charge`, reversesLineId: line.id, postingKey: reversalKey(line.id) }]),
      );
    }

    async function complete(taskId: string, answer: ResolvedBankRefundVoidAnswer | null) {
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      return resolveManualRefundTask(
        { taskId, resolution: "completed", note: null, actingMemberId: OFFICER_ID, confirmedAmountCents: null, direction: null, recordedNightPrices: null, bankRefundVoidAnswer: answer },
        CLUB_FORMAT_TEST,
      );
    }

    /** The fake Xero the "already in Xero" check reads: `getCreditNotes` answers with `notes`. */
    async function withXeroCreditNotes<T>(notes: Array<Record<string, unknown>>, run: () => Promise<T>, readBack?: Record<string, unknown>): Promise<T> {
      const xero = {
        accountingApi: {
          getCreditNotes: async () => ({ body: { creditNotes: notes } }),
          getInvoice: async () => ({ body: { invoices: [{ contact: { contactID: CONTACT_ID } }] } }),
          getCreditNote: async () => ({ body: { creditNotes: [readBack ?? notes[0]] } }),
        },
      };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4162b" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        return await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /** The outbox worker for one queued note, against a fake Xero. Returns the keys and amounts Xero was sent. */
    async function raiseQueuedNote(operationId: string, noteId: string) {
      const sent: Array<{ key: string; amount: number }> = [];
      const xero = {
        accountingApi: {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }, _s?: unknown, _u?: unknown, key?: string) => {
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            sent.push({ key: key!, amount: total });
            return { body: { creditNotes: [{ creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, total, remainingCredit: total, status: "AUTHORISED", payments: [] }] } };
          },
          getCreditNote: async () => ({ body: { creditNotes: [] } }),
        },
      };
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4162b" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-4162b"),
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

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      followUp = await import("@/lib/bank-refund-void-follow-up");
      scan = await import("@/lib/bank-refund-void-scan");
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Void", lastName: "Follow", role, ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4162b Lodge", slug: P } });
      for (const [index, id] of allBookingIds.entries()) {
        await prisma.booking.create({
          data: {
            id, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: new Date(Date.UTC(2026, 7, 1 + index * 3)),
            checkOut: new Date(Date.UTC(2026, 7, 3 + index * 3)), status: "CANCELLED", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS,
          },
        });
      }
    }, 90_000);

    beforeEach(async () => {
      await clearRun();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 90_000);

    it("probe and MUTATION (floor): an inbound void now leaves the allocation, the line AND the total - only the follow-up moves them", async () => {
      await paidBankTransfer();
      const taskId = await handBackNoted(`${P}-v`, PAID_CENTS);
      const before = await money();
      expect(before).toMatchObject({ payment: { refundedAmountCents: PAID_CENTS, status: "REFUNDED" }, detailCents: PAID_CENTS });

      const alerts = await import("@/lib/xero-error-alert");
      const alert = vi.spyOn(alerts, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      await voidInXero(`${P}-v`, PAID_CENTS);

      // INV-ADDPAY-021: Xero shows less than the detail - never applied. The
      // void waits for the follow-up, which explains it: logged, not alerted (security 12).
      expect(await money()).toEqual(before);
      expect(alert).not.toHaveBeenCalled();
      expect(before.lines).toEqual([expect.objectContaining({ amountCents: -PAID_CENTS, postingKey: `handback:${taskId}`, reversesLineId: null })]);
      expect(await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-v` }, select: { active: true } })).toEqual({ active: false });
    });

    it("the undo: allocation, line, total and one new follow-up agree; no booking event; the census explains the owed money", async () => {
      await paidBankTransfer();
      await chargedAndCancelled();
      const taskId = await handBackNoted(`${P}-v`, PAID_CENTS);
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);
      const eventsBefore = await prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID } });

      const item = await followUp.followUpVoidedBankRefundNote(linkId);

      expect(item).toMatchObject({ outcome: "undone", amountCents: PAID_CENTS, paymentId: PAYMENT_ID, creditNoteId: `${P}-v` });
      const after = await money();
      expect(after.payment).toEqual({ refundedAmountCents: 0, status: "SUCCEEDED" });
      expect(after.detailCents).toBe(0);
      const original = after.lines.find((line) => line.postingKey === `handback:${taskId}`)!;
      // MUTATION (skip the reversal): the original line is reversed by the canonical reversal.
      expect(after.lines).toEqual([
        original,
        expect.objectContaining({ amountCents: PAID_CENTS, postingKey: `reversal:${original.id}`, reversesLineId: original.id }),
      ]);
      // MUTATION (a reopen instead): the original task is untouched; ONE new open hand-back owes it.
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } })).toEqual({ status: "COMPLETED" });
      const tasks = await followUpTasks();
      expect(tasks).toEqual([
        expect.objectContaining({
          id: item!.followUpTaskId, status: "OPEN", amountCents: PAID_CENTS, kind: "CANCELLED_BOOKING_HAND_BACK", paymentId: PAYMENT_ID,
          occurrenceKey: `bank-refund-void:${PAYMENT_ID}:${P}-v`,
          reviewContext: { bankRefundVoidFollowUp: expect.objectContaining({ voidedCreditNoteId: `${P}-v`, originalTaskId: taskId, reversedLineId: original.id }) },
        }),
      ]);
      expect(await prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID } })).toBe(eventsBefore);
      expect(await prisma.auditLog.count({ where: { action: "booking-payment.bank-refund.void-undone", entityId: item!.followUpTaskId!, category: "payment" } })).toBe(1);
      // Nothing raised in Xero.
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, status: "PENDING" } })).toBe(0);

      const evaluation = await census();
      expect(evaluation.integrity).toEqual([]);
      expect(evaluation.identities.find((identity) => identity.identity === "REFUNDED")).toMatchObject({ status: "AGREE", columnCents: 0 });
      expect(evaluation.identities.find((identity) => identity.identity === "PRICE")).toMatchObject({
        status: "CLASSIFIED",
        explainedBy: [expect.objectContaining({ name: "IN_FLIGHT_HAND_BACK", cents: PAID_CENTS })],
      });

      // A later reconcile derives the total from the detail: the refund stays undone.
      const { reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
      expect((await money()).payment.refundedAmountCents).toBe(0);
      // Handled exactly once - and left out of the nightly scan in SQL (review, money 9).
      expect(await scan.readVoidedBankRefundNoteLinkIds(prisma as never)).not.toContain(linkId);
      expect(await scan.readVoidedBankRefundNoteLinkIds(prisma as never, { includeHandled: true })).toContain(linkId);
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "handled" });
      expect(await followUpTasks()).toHaveLength(1);
    });

    it("MUTATION (spare): a duplicate note's void moves nothing, and is recorded as handled", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      // A second live note for the same hand-back (a hand re-entry linked as a per-refund note).
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-dup`, xeroObjectNumber: "CN-DUP",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: PAID_CENTS, status: "AUTHORISED", total: PAID_CENTS / 100, perDelta: true },
        },
      });
      const before = await money();
      const linkId = await voidInXero(`${P}-dup`, PAID_CENTS);

      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "spare" });

      expect(await money()).toEqual(before);
      expect(await followUpTasks()).toEqual([]);
      const link = await prisma.xeroObjectLink.findUniqueOrThrow({ where: { id: linkId }, select: { metadata: true } });
      expect(link.metadata).toMatchObject({ status: "VOIDED", bankRefundVoid: { outcome: "spare", at: expect.any(String) } });
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "handled" });
    });

    it("MUTATION (money 1): a note resolved by hand whose own note Xero voided covers nothing - the void is undone, not a spare", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      const { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } = await import("@/lib/xero-operation-outbox-payload");
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-v`, manuallyResolvedAt: new Date("2026-06-02T00:00:00.000Z"),
          correlationKey: `${P}-resolved`, idempotencyKey: `${P}-resolved`, queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
          requestPayload: { queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE, refundAmountCents: PAID_CENTS, refundMethod: "internet-banking" },
        },
      });
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "undone" });
    });

    it("MUTATION (money 2): a late-capture card refund Xero never received is not owed a note - the duplicate's void is still a spare", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-dup`, xeroObjectNumber: "CN-DUP",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: PAID_CENTS, status: "AUTHORISED", total: 200, perDelta: true },
        },
      });
      // A 4000c late capture held for approval, refunded by card: INV-PAY-110 leaves it out of the eligible cash.
      await prisma.manualRefundTask.create({
        data: {
          bookingId: BOOKING_ID, paymentId: PAYMENT_ID, kind: "DELETED_BOOKING_LATE_CAPTURE", amountCents: 4_000, raisedAmountCents: 4_000,
          lateCaptureApprovalIntentId: `pi_${P}_late`, reason: P,
        },
      });
      await prisma.paymentRefund.create({
        data: { paymentId: PAYMENT_ID, stripeRefundId: `re_${P}_late`, stripePaymentIntentId: `pi_${P}_late`, amountCents: 4_000, currency: "nzd", status: "succeeded" },
      });
      const linkId = await voidInXero(`${P}-dup`, PAID_CENTS);
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "spare" });
    });

    it("MUTATION (money 4): a create row whose own note Xero voided never holds the void back; a deferral over a week is listed", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "PARTIAL", replayable: true, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-v`,
          correlationKey: `${P}-partial`, idempotencyKey: `${P}-partial`, requestPayload: { refundAmountCents: PAID_CENTS },
        },
      });
      // A create that could still mint holds it back; over a week, it is listed and counted.
      const pending = await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "PENDING", correlationKey: `${P}-pending2`, idempotencyKey: `${P}-pending2`, requestPayload: {},
        },
      });
      await prisma.$executeRaw`UPDATE "XeroObjectLink" SET "updatedAt" = ${new Date("2026-06-20T00:00:00.000Z")} WHERE "id" = ${linkId}`;
      const listed = (await scan.listBankRefundVoidsForAPerson(prisma as never)).filter((item) => item.paymentId === PAYMENT_ID);
      expect(listed).toEqual([expect.objectContaining({ linkId, reason: "deferred", pickableLines: [] })]);
      expect((await followUp.runBankRefundVoidFollowUp({ writes: false })).deferredOverdue).toBeGreaterThanOrEqual(1);
      await prisma.xeroSyncOperation.delete({ where: { id: pending.id } });
      // The voided note's own PARTIAL row does not block.
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "undone" });
    });

    it("concurrency 3: the link row held by another transaction - a spare defers with no marker, an answer is refused as busy", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-dup`, xeroObjectNumber: "CN-DUP",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: PAID_CENTS, status: "AUTHORISED", total: 200, perDelta: true },
        },
      });
      const spareLinkId = await voidInXero(`${P}-dup`, PAID_CENTS);
      const other = BUCKET_BOOKINGS[1]!;
      await paidBankTransfer(other, `${other}-payment`, `${other}-txn`);
      await handBackNoted(`${P}-paw2`, PAID_CENTS, { bookingId: other, paymentId: `${other}-payment`, names: "paidAnotherWayTaskId", perDelta: true, occurrenceKey: `card-refund-paid-another-way:${P}-op2` });
      await inbound(voidedNote(`${P}-paw2`, PAID_CENTS));
      const pawLinkId = await linkIdOf(`${P}-paw2`, `${other}-payment`);

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let lockedBoth!: () => void;
      const isLocked = new Promise<void>((resolve) => (lockedBoth = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "XeroObjectLink" WHERE "id" IN (${spareLinkId}, ${pawLinkId}) FOR UPDATE`;
          lockedBoth();
          await held;
        },
        { timeout: 30_000 },
      );
      await isLocked;
      try {
        expect(await followUp.followUpVoidedBankRefundNote(spareLinkId)).toMatchObject({ outcome: "deferred" });
        const { isPostgresLockNotAvailable } = await import("@/lib/prisma-errors");
        const answered = await withWrites(() =>
          followUp.markUnmatchedBankRefundVoidAnswered({ linkId: pawLinkId, note: "x", actingMemberId: OFFICER_ID }).then(() => null, (error: unknown) => error),
        );
        expect(isPostgresLockNotAvailable(answered)).toBe(true);
      } finally {
        release();
        await holder;
      }
      const spareLink = await prisma.xeroObjectLink.findUniqueOrThrow({ where: { id: spareLinkId }, select: { metadata: true } });
      expect(spareLink.metadata).not.toHaveProperty("bankRefundVoid");
      expect(await followUp.followUpVoidedBankRefundNote(spareLinkId)).toMatchObject({ outcome: "spare" });
    });

    it("defers while a refund-note create on the payment could still mint, then undoes", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);
      const pending = await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "PENDING", correlationKey: `${P}-pending`, idempotencyKey: `${P}-pending`, requestPayload: { refundAmountCents: PAID_CENTS },
        },
      });

      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "deferred" });
      expect((await money()).detailCents).toBe(PAID_CENTS);
      expect(await followUpTasks()).toEqual([]);

      await prisma.xeroSyncOperation.delete({ where: { id: pending.id } });
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "undone" });
    });

    it("an active voided mirror waits for #4161's heal (which defers while the Payment row is held), then is undone", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      // A mirror voided before #4091: still active, its status recorded VOIDED.
      await prisma.xeroObjectLink.updateMany({
        where: { localId: PAYMENT_ID, xeroObjectId: `${P}-v` },
        data: { metadata: { amountCents: PAID_CENTS, watermarkCents: PAID_CENTS, status: "VOIDED", total: PAID_CENTS / 100 } },
      });
      const linkId = await linkIdOf(`${P}-v`);
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "awaiting-heal" });
      expect((await money()).detailCents).toBe(PAID_CENTS);

      const { lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions");
      const { cleanupStaleCanonicalXeroObjectLinks } = await import("@/lib/xero-hardening-canonical-links");
      // A writer holds the Payment row (as the job does): the heal defers, never waits.
      await prisma.$transaction(async (tx) => {
        await lockPaymentForRefundedTotal(tx, PAYMENT_ID);
        await cleanupStaleCanonicalXeroObjectLinks();
      }, { timeout: 30_000 });
      expect(await prisma.xeroObjectLink.findUniqueOrThrow({ where: { id: linkId }, select: { active: true } })).toEqual({ active: true });

      await cleanupStaleCanonicalXeroObjectLinks();
      expect(await prisma.xeroObjectLink.findUniqueOrThrow({ where: { id: linkId }, select: { active: true } })).toEqual({ active: false });
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "undone" });
    });

    it("two runs at once raise one follow-up and unwind once", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);

      const outcomes = await Promise.all([followUp.followUpVoidedBankRefundNote(linkId), followUp.followUpVoidedBankRefundNote(linkId)]);

      expect(outcomes.map((item) => item?.outcome).sort()).toEqual(["handled", "undone"]);
      expect(await followUpTasks()).toHaveLength(1);
      expect(await money()).toMatchObject({ payment: { refundedAmountCents: 0 }, detailCents: 0 });
      expect((await money()).lines.filter((line) => line.reversesLineId !== null)).toHaveLength(1);
    });

    it("the job beside a concurrent reconcile: the total ends equal to the detail", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-a`, 5_000, { perDelta: true });
      await handBackNoted(`${P}-v`, 15_000);
      const linkId = await voidInXero(`${P}-v`, 15_000);
      const { reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
      await Promise.all([followUp.followUpVoidedBankRefundNote(linkId), reconcilePaymentAggregates({ paymentId: PAYMENT_ID })]);
      const after = await money();
      expect(after).toMatchObject({ detailCents: 5_000, payment: { refundedAmountCents: 5_000 } });
      expect(await followUpTasks()).toEqual([expect.objectContaining({ amountCents: 15_000, status: "OPEN" })]);
      const refunded = (await census()).identities.find((identity) => identity.identity === "REFUNDED");
      expect(refunded).toMatchObject({ columnCents: 5_000 });
      expect(refunded?.status === "AGREE" || refunded?.status === "CLASSIFIED").toBe(true);
    });

    it("concurrency 2 and MUTATION (floor): the inbound recount reads, the undo commits, the recount resumes - its claim is lost, it recounts, and the floor keeps the total at the detail", async () => {
      await paidBankTransfer();
      // A refund with no note in Xero yet, and one whose note Xero voided.
      await handBackNoted(`${P}-a`, 5_000, { noNote: true });
      await handBackNoted(`${P}-v`, 15_000);
      const linkId = await voidInXero(`${P}-v`, 15_000);
      expect(await money()).toMatchObject({ payment: { refundedAmountCents: 20_000 }, detailCents: 20_000 });
      const alerts = await import("@/lib/xero-error-alert");
      vi.spyOn(alerts, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      const { repairRefundedPaymentBusinessState } = await import("@/lib/xero-inbound/credit-note-repairs");
      // Force the order: the recount has read the payment; before it reads the
      // detail and writes, the undo commits.
      const aggregate = prisma.paymentTransaction.aggregate.bind(prisma.paymentTransaction);
      let paused = false;
      const detailRead = vi.spyOn(prisma.paymentTransaction, "aggregate").mockImplementation((async (args: never) => {
        if (!paused) {
          paused = true;
          detailRead.mockRestore();
          expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "undone" });
        }
        return aggregate(args);
      }) as never);
      const reads = vi.spyOn(prisma.payment, "findMany");
      // #4288: a payment holding the note's own refund-note row is claimed under
      // its row lock, on that transaction's client: observe the claims there.
      const claimed: Array<{ count: number }> = [];
      const { interceptTransactionPaymentClaims } = await import("./support/transaction-payment-claims");
      const lockSpy = interceptTransactionPaymentClaims(prisma, async (_args, run) => {
        const result = await run();
        claimed.push(result);
        return result;
      });

      try {
        await repairRefundedPaymentBusinessState({
          creditNoteId: `${P}-v`,
          creditNote: { status: "VOIDED", total: 150, appliedAmount: 0, remainingCredit: 0 } as never,
          directPaymentIds: [PAYMENT_ID],
          modificationRefundAmountsByPaymentId: new Map(),
        });
      } finally {
        lockSpy.mockRestore();
      }

      expect(paused).toBe(true);
      // The claim on the row as first read was lost, and the recount ran again from scratch.
      expect(claimed).toContainEqual({ count: 0 });
      expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(await money()).toMatchObject({ payment: { refundedAmountCents: 5_000 }, detailCents: 5_000 });
    });

    it("answer 'Yes, raise a fresh credit note': the money goes back as a hand-back completion records it, and one note keyed and sized on the follow-up is raised (a replay is the same row and key)", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-a`, 5_000, { perDelta: true });
      await handBackNoted(`${P}-v`, 15_000);
      // A stray live note no hand-back explains: the payment-wide gap is now
      // smaller than the follow-up, so only a note sized on the follow-up is right.
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-stray`, role: "REFUND_CREDIT_NOTE",
          active: true, metadata: { amountCents: 5_000, status: "AUTHORISED", total: 50, perDelta: true },
        },
      });
      const linkId = await voidInXero(`${P}-v`, 15_000);
      const undone = await followUp.followUpVoidedBankRefundNote(linkId);
      const followUpId = undone!.followUpTaskId!;
      const eventsBefore = await prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID } });

      // An older screen that does not answer is refused, and nothing moves.
      await expect(complete(followUpId, null)).rejects.toMatchObject({ status: 400 });

      const result = await complete(followUpId, { answer: "fresh-note" });

      expect(result).toMatchObject({ status: "COMPLETED", amountCents: 15_000 });
      const after = await money();
      expect(after).toMatchObject({ payment: { refundedAmountCents: 20_000, status: "REFUNDED" }, detailCents: 20_000 });
      expect(after.lines).toContainEqual(expect.objectContaining({ postingKey: `handback:${followUpId}`, amountCents: -15_000, reversesLineId: null }));
      // Q3: the money moved once; the member hears nothing new.
      expect(await prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID } })).toBe(eventsBefore);
      const rows = await prisma.xeroSyncOperation.findMany({ where: { localId: PAYMENT_ID, status: "PENDING" } });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // MUTATION (payment-wide sizing): sized on the follow-up, 15,000, never the 10,000 gap.
      expect(row.requestPayload).toMatchObject({ refundAmountCents: 15_000, paidAnotherWayTaskId: followUpId, refundMethod: "internet-banking" });
      // Nothing copied from the voided note, so it is dated today.
      expect(row.requestPayload).not.toHaveProperty("documentDate");
      expect(row.correlationKey).toContain(`paid-another-way:${followUpId}`);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "booking-payment.manual-refund-task.complete", entityId: followUpId } });
      expect(audit.metadata).toMatchObject({ bankRefundVoidAnswer: "fresh-note" });

      // A replay of the enqueue: the same row, the same key.
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const replay = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 15_000, { refundMethod: "internet-banking", paidAnotherWayTaskId: followUpId });
      expect(replay.queueOperationId).toBe(row.id);

      const sent = await raiseQueuedNote(row.id, `${P}-fresh`);
      // Xero's key is the follow-up's own (its notes' cover, v3): a retry after a crash sends it again.
      expect(sent).toEqual([{ key: `payment:${PAYMENT_ID}:refund-credit-note:paid-another-way:${followUpId}:0:v3`, amount: 150 }]);
      expect(await prisma.xeroObjectLink.findFirst({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-fresh` }, select: { active: true } })).toEqual({ active: true });
      // Covered now: a further enqueue raises nothing.
      expect((await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 15_000, { refundMethod: "internet-banking", paidAnotherWayTaskId: followUpId })).queueOperationId).toBeNull();
      // And the fresh note's own void is matched to the follow-up and undone again.
      const freshLinkId = await voidInXero(`${P}-fresh`, 15_000);
      expect(await followUp.followUpVoidedBankRefundNote(freshLinkId)).toMatchObject({ outcome: "undone" });
      expect(await followUpTasks()).toHaveLength(2);
    });

    it("answer 'Yes, I already recorded it in Xero myself': Xero is checked, refusals move nothing, and the tracked note's own void is caught", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);
      const followUpId = (await followUp.followUpVoidedBankRefundNote(linkId))!.followUpTaskId!;
      const { prepareBankRefundVoidAnswer } = await import("@/lib/bank-refund-void-answer");
      const handMade = {
        creditNoteID: `${P}-hand`, creditNoteNumber: "CN-HAND", status: "AUTHORISED", type: "ACCRECCREDIT", total: 200,
        contact: { contactID: CONTACT_ID }, allocations: [],
      };
      const prepare = (notes: Array<Record<string, unknown>>) =>
        withXeroCreditNotes(notes, () =>
          prepareBankRefundVoidAnswer({ taskId: followUpId, answer: { answer: "recorded-in-xero", creditNoteNumber: "CN-HAND" }, format: CLUB_FORMAT_TEST }),
        );

      await expect(prepare([])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("no credit note numbered") });
      await expect(prepare([{ ...handMade, total: 150 }])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("not $200.00") });
      await expect(prepare([{ ...handMade, status: "VOIDED" }])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("voided") });
      await expect(prepare([{ ...handMade, type: "ACCPAYCREDIT" }])).rejects.toMatchObject({ status: 409 });
      await expect(prepare([{ ...handMade, status: "DRAFT" }])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("not approved or paid") });
      await expect(prepare([{ ...handMade, contact: { contactID: "someone-else" } }])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("different contact") });
      await expect(prepare([{ ...handMade, allocations: [{ invoice: { invoiceID: "another-invoice" } }] }])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("another invoice") });
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: followUpId }, select: { status: true } })).toEqual({ status: "OPEN" });

      const answer = await prepare([handMade]);
      await complete(followUpId, answer);

      expect(await money()).toMatchObject({ payment: { refundedAmountCents: PAID_CENTS }, detailCents: PAID_CENTS });
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, status: "PENDING" } })).toBe(0);
      const tracked = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-hand` } });
      expect(tracked).toMatchObject({ active: true, role: "REFUND_CREDIT_NOTE", xeroObjectNumber: "CN-HAND" });
      expect(tracked.metadata).toMatchObject({ amountCents: PAID_CENTS, perDelta: true, handBackTaskId: followUpId });

      // Concurrency 1: Xero voided it between the check and the link write.
      // The read-back after the commit (the inbound reconcile) catches it.
      const { reconcileHandMadeNoteAfterCompletion } = await import("@/lib/bank-refund-void-answer");
      const alerts = await import("@/lib/xero-error-alert");
      vi.spyOn(alerts, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      await withXeroCreditNotes([], () => reconcileHandMadeNoteAfterCompletion(answer), {
        ...handMade, status: "VOIDED", appliedAmount: 0, remainingCredit: 0, payments: [],
      });
      const handLink = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-hand` }, select: { id: true, active: true } });
      expect(handLink.active).toBe(false);
      // Tracked from now on: its own void is undone again by the follow-up.
      expect(await followUp.followUpVoidedBankRefundNote(handLink.id)).toMatchObject({ outcome: "undone" });
      expect(await money()).toMatchObject({ payment: { refundedAmountCents: 0 }, detailCents: 0 });
    });

    it("MUTATION (#4288): a void that commits between the hand-made check and the link write is refused under the lock, and nothing moves", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);
      const followUpId = (await followUp.followUpVoidedBankRefundNote(linkId))!.followUpTaskId!;
      const { prepareBankRefundVoidAnswer } = await import("@/lib/bank-refund-void-answer");
      const handMade = {
        creditNoteID: `${P}-hand-race`, creditNoteNumber: "CN-HAND-RACE", status: "AUTHORISED", type: "ACCRECCREDIT", total: 200,
        updatedDateUTC: new Date("2026-06-30T11:00:00.000Z"), contact: { contactID: CONTACT_ID }, allocations: [],
      };
      const answer = await withXeroCreditNotes([handMade], () =>
        prepareBankRefundVoidAnswer({ taskId: followUpId, answer: { answer: "recorded-in-xero", creditNoteNumber: "CN-HAND-RACE" }, format: CLUB_FORMAT_TEST }),
      );
      const before = await money();

      // The inbound void's first write of the note's mirror, held open on its
      // own connection: the completion's unlocked check cannot see it.
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let written!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (written = resolve));
      const voided = prisma.$transaction(async (tx) => {
        await upsertXeroObjectLink({
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-hand-race`, xeroObjectNumber: "CN-HAND-RACE",
          role: "REFUND_CREDIT_NOTE", metadata: { status: "VOIDED", total: 200, providerUpdatedAt: "2026-06-30T12:00:00.000Z" }, mergeMetadata: true,
        }, { store: tx });
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
        written(pid);
        await released;
      }, { timeout: 30_000 });
      const completion = complete(followUpId, answer);
      void completion.catch(() => undefined);
      try {
        const pid = await Promise.race([holderPid, voided.then(() => { throw new Error("The void ended before reporting its lock"); })]);
        const startedAt = process.hrtime.bigint();
        for (;;) {
          const rows = await prisma.$queryRaw<Array<{ count: number }>>`
            SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
            WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))`;
          if ((rows[0]?.count ?? 0) >= 1) break;
          if (realElapsedMs(startedAt) > 10_000) throw new Error("The completion's link write never queued behind the void");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        release();
      }
      await voided;

      // Before #4288 the answer wrote the voided note's mirror live and the money moved.
      await expect(completion).rejects.toMatchObject({ status: 409, message: expect.stringContaining("CN-HAND-RACE was voided in Xero while this answer was being recorded") });
      expect(await money()).toEqual(before);
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: followUpId }, select: { status: true } })).toEqual({ status: "OPEN" });
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-hand-race` }, select: { active: true, metadata: true } });
      expect(link).toEqual({ active: false, metadata: { status: "VOIDED", total: 200, providerUpdatedAt: "2026-06-30T12:00:00.000Z" } });
    });

    it("MUTATION (money 6): a hand-made note tracked only by this payment's own inactive, live link is reactivated for the follow-up", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);
      const followUpId = (await followUp.followUpVoidedBankRefundNote(linkId))!.followUpTaskId!;
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-dup`, xeroObjectNumber: "CN-DUP",
          role: "REFUND_CREDIT_NOTE", active: false, metadata: { status: "AUTHORISED", amountCents: PAID_CENTS, total: 200 },
        },
      });
      const { prepareBankRefundVoidAnswer } = await import("@/lib/bank-refund-void-answer");
      const dup = { creditNoteID: `${P}-dup`, creditNoteNumber: "CN-DUP", status: "AUTHORISED", type: "ACCRECCREDIT", total: 200, contact: { contactID: CONTACT_ID }, allocations: [] };
      const answer = await withXeroCreditNotes([dup], () =>
        prepareBankRefundVoidAnswer({ taskId: followUpId, answer: { answer: "recorded-in-xero", creditNoteNumber: "CN-DUP" }, format: CLUB_FORMAT_TEST }),
      );
      await complete(followUpId, answer);
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-dup` } });
      expect(link.active).toBe(true);
      expect(link.metadata).toMatchObject({ handBackTaskId: followUpId, perDelta: true });
    });

    it("MUTATION (money 5): a fresh note on a payment with no Xero invoice is refused, and nothing moves", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);
      const followUpId = (await followUp.followUpVoidedBankRefundNote(linkId))!.followUpTaskId!;
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: null } });
      const before = await money();
      await expect(complete(followUpId, { answer: "fresh-note" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("no Xero invoice") });
      expect(await money()).toEqual(before);
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: followUpId }, select: { status: true } })).toEqual({ status: "OPEN" });
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, status: "PENDING" } })).toBe(0);
    });

    it("answer 'No, the club keeps it' is the dismissal with a reason: the refund stays out of the records", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);
      const followUpId = (await followUp.followUpVoidedBankRefundNote(linkId))!.followUpTaskId!;
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        { taskId: followUpId, resolution: "dismissed", note: "Transfer bounced; the member took a stay credit instead", actingMemberId: OFFICER_ID, recordedNightPrices: null },
        CLUB_FORMAT_TEST,
      );
      expect(await money()).toMatchObject({ payment: { refundedAmountCents: 0 }, detailCents: 0 });
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: followUpId }, select: { status: true } })).toEqual({ status: "DISMISSED" });
    });

    it("the previous app version completing a follow-up as an ordinary hand-back: the books agree and the job leaves it handled", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);
      const followUpId = (await followUp.followUpVoidedBankRefundNote(linkId))!.followUpTaskId!;
      const voidedKey = (await prisma.xeroSyncOperation.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-v` } })).correlationKey;

      // What the old completion does with a CANCELLED_BOOKING_HAND_BACK whose key it does not know.
      const { applyLocalRefundAllocation } = await import("@/lib/payment-transactions");
      const { postHandBackLedgerLine } = await import("@/lib/booking-ledger-hand-back");
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      await prisma.$transaction(async (tx) => {
        await tx.manualRefundTask.update({ where: { id: followUpId }, data: { status: "COMPLETED", completedAt: new Date(), completedByMemberId: OFFICER_ID, settlementDirection: "REFUND_TO_MEMBER" } });
        await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: PAID_CENTS, store: tx });
        await postHandBackLedgerLine({
          bookingId: BOOKING_ID, lodgeId: LODGE_ID, manualRefundTaskId: followUpId, amountCents: PAID_CENTS, refundMethod: "internet-banking",
          paymentSource: "INTERNET_BANKING", officerMemberId: OFFICER_ID, store: tx,
        });
        await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, PAID_CENTS, { refundMethod: "internet-banking", store: tx });
      });

      expect(await money()).toMatchObject({ payment: { refundedAmountCents: PAID_CENTS }, detailCents: PAID_CENTS });
      const queued = await prisma.xeroSyncOperation.findFirstOrThrow({ where: { localId: PAYMENT_ID, status: "PENDING" } });
      // INV-ADDPAY-041: never the voided note's key.
      expect(queued.correlationKey).not.toBe(voidedKey);
      expect(queued.correlationKey).toContain("after-void");
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "handled" });
      expect((await census()).integrity).toEqual([]);
    });

    it("MUTATION (report-only): the job's default run classifies and logs, and writes nothing", async () => {
      await paidBankTransfer();
      await handBackNoted(`${P}-v`, PAID_CENTS);
      const linkId = await voidInXero(`${P}-v`, PAID_CENTS);
      const before = await money();
      delete process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES;

      const result = await followUp.runBankRefundVoidFollowUp();

      expect(result.mode).toBe("report-only");
      expect(result.items.filter((item) => item.linkId === linkId)).toEqual([expect.objectContaining({ outcome: "undone", detail: expect.stringContaining("Would undo") })]);
      expect(await money()).toEqual(before);
      expect(await followUpTasks()).toEqual([]);
      expect(await prisma.xeroObjectLink.findUniqueOrThrow({ where: { id: linkId }, select: { metadata: true } })).not.toMatchObject({ bankRefundVoid: expect.anything() });
    });

    async function withWrites<T>(run: () => Promise<T>): Promise<T> {
      process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES = "true";
      try {
        return await run();
      } finally {
        delete process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES;
      }
    }

    /** A pre-#4162 note for two hand-backs at once, voided: no single line has its amount. */
    async function unmatchedTwoRefundNote() {
      await paidBankTransfer();
      const x = await handBackNoted(`${P}-x`, 5_000, { noNote: true });
      const y = await handBackNoted(`${P}-y`, 15_000, { noNote: true });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-both`, xeroObjectNumber: "CN-BOTH",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 20_000, status: "AUTHORISED", total: 200, perDelta: true },
        },
      });
      const linkId = await voidInXero(`${P}-both`, 20_000);
      const lineOf = async (taskId: string) =>
        (await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: BOOKING_ID, postingKey: `handback:${taskId}` }, select: { id: true } })).id;
      return { linkId, xLine: await lineOf(x), yLine: await lineOf(y), x, y };
    }

    it("owner 18 Oct and MUTATION (money A): a note that recorded two refunds takes two picks - both undone, then handled; a third pick is refused", async () => {
      const { linkId, xLine, yLine, x, y } = await unmatchedTwoRefundNote();
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "unmatched" });
      const listed = (await scan.listBankRefundVoidsForAPerson(prisma as never)).filter((item) => item.paymentId === PAYMENT_ID);
      expect(listed).toEqual([
        expect.objectContaining({ linkId, amountCents: 20_000, reason: "no-line", pickableLines: expect.arrayContaining([expect.objectContaining({ lineId: yLine, amountCents: 15_000 })]) }),
      ]);

      const picked = await withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: yLine, actingMemberId: OFFICER_ID }));

      // The undo a matched note gets: the picked refund comes out, its line reversed, the total from the detail.
      expect(await money()).toMatchObject({ payment: { refundedAmountCents: 5_000 }, detailCents: 5_000 });
      expect((await money()).lines).toContainEqual(expect.objectContaining({ reversesLineId: yLine, amountCents: 15_000 }));
      expect(await followUpTasks()).toEqual([
        expect.objectContaining({
          id: picked.followUpTaskId, status: "OPEN", amountCents: 15_000, occurrenceKey: `bank-refund-void:${PAYMENT_ID}:${P}-both:${yLine}`,
          reviewContext: { bankRefundVoidFollowUp: expect.objectContaining({ originalTaskId: y, reversedLineId: yLine }) },
        }),
      ]);
      expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "booking-payment.bank-refund.void-undone", entityId: picked.followUpTaskId } })).toMatchObject({ actorMemberId: OFFICER_ID });

      // 5,000 of the note is still to pick: it stays listed, partly picked, with x marked as the match.
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "unmatched" });
      expect((await scan.listBankRefundVoidsForAPerson(prisma as never)).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([
        expect.objectContaining({ linkId, amountCents: 20_000, remainingCents: 5_000, reason: "partly-picked", pickableLines: [expect.objectContaining({ lineId: xLine, amountCents: 5_000, matchesNote: true })] }),
      ]);
      // The same refund twice is refused and moves nothing.
      await expect(withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: yLine, actingMemberId: OFFICER_ID }))).rejects.toMatchObject({ status: 409 });

      const second = await withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: xLine, actingMemberId: OFFICER_ID }));
      expect(await money()).toMatchObject({ payment: { refundedAmountCents: 0 }, detailCents: 0 });
      expect((await money()).lines).toContainEqual(expect.objectContaining({ reversesLineId: xLine, amountCents: 5_000 }));
      expect(await followUpTasks()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: second.followUpTaskId, amountCents: 5_000, occurrenceKey: `bank-refund-void:${PAYMENT_ID}:${P}-both:${xLine}`, reviewContext: { bankRefundVoidFollowUp: expect.objectContaining({ originalTaskId: x }) } }),
        ]),
      );
      expect(await followUpTasks()).toHaveLength(2);
      // Both picked: the note is handled, marked "picked", and out of the nightly scan.
      expect((await prisma.xeroObjectLink.findUniqueOrThrow({ where: { id: linkId }, select: { metadata: true } })).metadata).toMatchObject({ bankRefundVoid: { outcome: "picked", memberId: OFFICER_ID } });
      expect(await scan.readVoidedBankRefundNoteLinkIds(prisma as never)).not.toContain(linkId);
      expect((await scan.listBankRefundVoidsForAPerson(prisma as never)).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([]);
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "handled" });
      // A third pick is refused and moves nothing.
      const after = await money();
      await expect(withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: xLine, actingMemberId: OFFICER_ID }))).rejects.toMatchObject({ status: 409 });
      expect(await money()).toEqual(after);
      expect(await followUpTasks()).toHaveLength(2);
      // MUTATION (money A): a marker dropped by a wholesale metadata write leaves the note handled - the picks add up.
      await prisma.xeroObjectLink.update({ where: { id: linkId }, data: { metadata: { amountCents: 20_000, status: "VOIDED", perDelta: true } } });
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "handled" });
      expect(await money()).toEqual(after);
    });

    it("MUTATION (money A): a refund larger than what is left of the note to pick is not offered, and its pick is refused", async () => {
      const { linkId, yLine } = await unmatchedTwoRefundNote();
      await withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: yLine, actingMemberId: OFFICER_ID }));
      const z = await handBackNoted(`${P}-z`, 10_000, { noNote: true });
      const zLine = (await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: BOOKING_ID, postingKey: `handback:${z}` }, select: { id: true } })).id;
      const listed = (await scan.listBankRefundVoidsForAPerson(prisma as never)).filter((item) => item.paymentId === PAYMENT_ID);
      expect(listed[0]?.pickableLines.map((line) => line.lineId)).not.toContain(zLine);
      const before = await money();
      await expect(withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: zLine, actingMemberId: OFFICER_ID }))).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("larger than what is left"),
      });
      expect(await money()).toEqual(before);
      expect(await followUpTasks()).toHaveLength(1);
    });

    it("MUTATION (money B): a refund its own live note still records is neither offered, matched by the job, nor picked", async () => {
      await paidBankTransfer();
      const x = await handBackNoted(`${P}-x`, 5_000, { noNote: true });
      // w's own note is live in Xero, naming w.
      const w = await handBackNoted(`${P}-w`, 15_000, { perDelta: true });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-v`, xeroObjectNumber: "CN-V",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 15_000, status: "AUTHORISED", total: 150, perDelta: true },
        },
      });
      const linkId = await voidInXero(`${P}-v`, 15_000);
      const lineOf = async (taskId: string) =>
        (await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: BOOKING_ID, postingKey: `handback:${taskId}` }, select: { id: true } })).id;
      const [xLine, wLine] = [await lineOf(x), await lineOf(w)];
      const before = await money();
      // The job does not take w's refund back by amount: w's own note still records it.
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "unmatched" });
      expect(await money()).toEqual(before);
      const listed = (await scan.listBankRefundVoidsForAPerson(prisma as never)).filter((item) => item.paymentId === PAYMENT_ID);
      expect(listed).toEqual([expect.objectContaining({ reason: "no-line", pickableLines: [expect.objectContaining({ lineId: xLine, matchesNote: false })] })]);
      await expect(withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: wLine, actingMemberId: OFFICER_ID }))).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("still records some or all of that refund"),
      });
      expect(await money()).toEqual(before);
      expect(await followUpTasks()).toEqual([]);
    });

    it("MUTATION (money B): a refund a hand-made note's live link records (handBackTaskId, no create row) is neither matched nor offered", async () => {
      await paidBankTransfer();
      const x = await handBackNoted(`${P}-x`, 5_000, { noNote: true });
      const w = await handBackNoted(`${P}-w`, 15_000, { noNote: true });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-hm`, xeroObjectNumber: "CN-HM",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 15_000, status: "AUTHORISED", total: 150, perDelta: true, handBackTaskId: w },
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-v`, xeroObjectNumber: "CN-V",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 15_000, status: "AUTHORISED", total: 150, perDelta: true },
        },
      });
      const linkId = await voidInXero(`${P}-v`, 15_000);
      const xLine = (await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: BOOKING_ID, postingKey: `handback:${x}` }, select: { id: true } })).id;
      const before = await money();
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "unmatched" });
      expect(await money()).toEqual(before);
      const listed = (await scan.listBankRefundVoidsForAPerson(prisma as never)).filter((item) => item.paymentId === PAYMENT_ID);
      expect(listed).toEqual([expect.objectContaining({ pickableLines: [expect.objectContaining({ lineId: xLine })] })]);
    });

    it("MUTATION (money B, re-check): a refund its own live note records only in part is not offered, matched or picked; the other refund still is", async () => {
      await paidBankTransfer();
      // CN-C (6,000) recorded 3,000 of x and 3,000 of y; x (5,000) also has its own live 2,000 note.
      const x = await handBackNoted(`${P}-x`, 5_000, { noteAmountCents: 2_000, perDelta: true });
      const y = await handBackNoted(`${P}-y`, 3_000, { noNote: true });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-c`, xeroObjectNumber: "CN-C",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 6_000, status: "AUTHORISED", total: 60, perDelta: true },
        },
      });
      const linkId = await voidInXero(`${P}-c`, 6_000);
      const lineOf = async (taskId: string) =>
        (await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: BOOKING_ID, postingKey: `handback:${taskId}` }, select: { id: true } })).id;
      const [xLine, yLine] = [await lineOf(x), await lineOf(y)];
      const before = await money();
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "unmatched" });
      const listed = (await scan.listBankRefundVoidsForAPerson(prisma as never)).filter((item) => item.paymentId === PAYMENT_ID);
      expect(listed).toEqual([
        expect.objectContaining({
          pickableLines: [expect.objectContaining({ lineId: yLine, amountCents: 3_000 })],
          partlyCoveredLines: [expect.objectContaining({ lineId: xLine, amountCents: 5_000, coveredCents: 2_000 })],
        }),
      ]);
      await expect(withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: xLine, actingMemberId: OFFICER_ID }))).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("still records some or all of that refund"),
      });
      expect(await money()).toEqual(before);
      // y is picked as usual; x then goes to the answer path, nothing left to pick.
      await withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: yLine, actingMemberId: OFFICER_ID }));
      expect((await money()).detailCents).toBe(before.detailCents - 3_000);
      const after = (await scan.listBankRefundVoidsForAPerson(prisma as never)).filter((item) => item.paymentId === PAYMENT_ID);
      expect(after).toEqual([expect.objectContaining({ reason: "partly-picked", remainingCents: 3_000, pickableLines: [] })]);
      await withWrites(() => followUp.markUnmatchedBankRefundVoidAnswered({ linkId, note: "x's other 3,000 checked in Xero", actingMemberId: OFFICER_ID }));
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "handled" });
    });

    it("MUTATION (money re-check): a create row closed as covered by another hand-back's note covers nothing of its own - that hand-back is still offered and matched", async () => {
      await paidBankTransfer();
      // A (5,000) has its own live note N_A; B's (3,000) create row completed as covered by N_A, minting nothing.
      const a = await handBackNoted(`${P}-na`, 5_000, { perDelta: true });
      const b = await handBackNoted(`${P}-b`, 3_000, { noNote: true });
      const { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } = await import("@/lib/xero-operation-outbox-payload");
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-na`, xeroObjectNumber: `CN-${P}-na`,
          correlationKey: `${P}-b-covered`, idempotencyKey: `${P}-b-covered`, queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
          completedAt: new Date("2026-06-02T00:00:00.000Z"),
          requestPayload: { refundMethod: "internet-banking", refundAmountCents: 3_000, handBackTaskId: b },
          responsePayload: { existingCreditNoteId: `${P}-na`, coveredByExistingNote: true },
        },
      });
      const lineOf = async (taskId: string) =>
        (await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: BOOKING_ID, postingKey: `handback:${taskId}` }, select: { id: true } })).id;
      const [aLine, bLine] = [await lineOf(a), await lineOf(b)];
      // B is offerable (A, which N_A covers, is not).
      const offered = (await scan.readPickableHandBackLines(prisma as never, PAYMENT_ID, BOOKING_ID, null)).map((line) => line.lineId);
      expect(offered).toContain(bLine);
      expect(offered).not.toContain(aLine);
      // B's voided note (an older one naming no task) is matched to B and undone.
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-vb`, xeroObjectNumber: "CN-VB",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 3_000, status: "AUTHORISED", total: 30, perDelta: true },
        },
      });
      const linkId = await voidInXero(`${P}-vb`, 3_000);
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "undone" });
      expect((await money()).lines).toContainEqual(expect.objectContaining({ reversesLineId: bLine, amountCents: 3_000 }));
    });

    it("MUTATION (money A): a note whose amount cannot be read takes one pick only", async () => {
      await paidBankTransfer();
      const x = await handBackNoted(`${P}-x`, 5_000, { noNote: true });
      const y = await handBackNoted(`${P}-y`, 15_000, { noNote: true });
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-un`, role: "REFUND_CREDIT_NOTE", active: false, metadata: { status: "VOIDED" } },
      });
      const linkId = await linkIdOf(`${P}-un`);
      const lineOf = async (taskId: string) =>
        (await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: BOOKING_ID, postingKey: `handback:${taskId}` }, select: { id: true } })).id;
      const listed = (await scan.listBankRefundVoidsForAPerson(prisma as never)).filter((item) => item.paymentId === PAYMENT_ID);
      expect(listed).toEqual([expect.objectContaining({ reason: "amount-unknown", amountCents: null, remainingCents: null })]);
      expect(listed[0]!.pickableLines).toHaveLength(2);
      const [xLine, yLine] = [await lineOf(x), await lineOf(y)];
      await withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: xLine, actingMemberId: OFFICER_ID }));
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "handled" });
      const after = await money();
      await expect(withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: yLine, actingMemberId: OFFICER_ID }))).rejects.toMatchObject({ status: 409 });
      expect(await money()).toEqual(after);
      expect(await followUpTasks()).toHaveLength(1);
      // MUTATION (money A): with its marker dropped, the one pick still answers it.
      await prisma.xeroObjectLink.update({ where: { id: linkId }, data: { metadata: { status: "VOIDED" } } });
      await expect(withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: yLine, actingMemberId: OFFICER_ID }))).rejects.toMatchObject({ status: 409 });
      expect(await followUpTasks()).toHaveLength(1);
    });

    it("MUTATION (report-only): a pick while the follow-up is report-only is refused and writes nothing", async () => {
      const { linkId, yLine } = await unmatchedTwoRefundNote();
      const before = await money();
      delete process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES;
      await expect(followUp.pickRefundForUnmatchedVoid({ linkId, lineId: yLine, actingMemberId: OFFICER_ID })).rejects.toMatchObject({ status: 409 });
      expect(await money()).toEqual(before);
      expect(await followUpTasks()).toEqual([]);
    });

    it("MUTATION (pick guards): a line of another payment, or one already reversed, is refused under the locks and nothing moves", async () => {
      const other = BUCKET_BOOKINGS[0]!;
      await paidBankTransfer(other, `${other}-payment`, `${other}-txn`);
      const otherTask = await handBackNoted(`${P}-other`, 15_000, { bookingId: other, paymentId: `${other}-payment`, noNote: true });
      const otherLine = (await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: other, postingKey: `handback:${otherTask}` }, select: { id: true } })).id;
      const { linkId, xLine } = await unmatchedTwoRefundNote();
      const before = await money();
      await expect(withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: otherLine, actingMemberId: OFFICER_ID }))).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("not a live bank refund on this payment"),
      });
      // Reverse x's line as a second note's undo would, then pick it.
      const { settlementLineReversal } = await import("@/lib/booking-ledger-settlement-posting");
      const { buildBookingLedgerRows, writeBookingLedgerRows } = await import("@/lib/booking-ledger-write");
      const { findPostedSettlementLines } = await import("@/lib/booking-ledger-read");
      const posted = (await findPostedSettlementLines(prisma as never, BOOKING_ID, { kind: "BANK_REFUND" })).find((line) => line.id === xLine)!;
      await prisma.$transaction((tx) => writeBookingLedgerRows(tx, buildBookingLedgerRows([settlementLineReversal({ bookingId: BOOKING_ID, lodgeId: LODGE_ID }, posted)])));
      await expect(withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: xLine, actingMemberId: OFFICER_ID }))).rejects.toMatchObject({ status: 409 });
      expect((await money()).detailCents).toBe(before.detailCents);
      expect(await followUpTasks()).toEqual([]);
    });

    it("MUTATION (money 7): a voided note of a card refund paid another way goes to a person with nothing to pick, and is never undone", async () => {
      await paidBankTransfer();
      const close = await handBackNoted(`${P}-paw`, PAID_CENTS, { names: "paidAnotherWayTaskId", perDelta: true, occurrenceKey: `card-refund-paid-another-way:${P}-op` });
      const linkId = await voidInXero(`${P}-paw`, PAID_CENTS);
      const before = await money();
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "unmatched" });
      expect(await money()).toEqual(before);
      const listed = (await scan.listBankRefundVoidsForAPerson(prisma as never)).filter((item) => item.paymentId === PAYMENT_ID);
      expect(listed).toEqual([expect.objectContaining({ reason: "paid-another-way", pickableLines: [] })]);
      const closeLine = (await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: BOOKING_ID, postingKey: `handback:${close}` }, select: { id: true } })).id;
      await expect(withWrites(() => followUp.pickRefundForUnmatchedVoid({ linkId, lineId: closeLine, actingMemberId: OFFICER_ID }))).rejects.toMatchObject({ status: 409 });
      // Nothing to pick: the answer is recorded, and moves nothing.
      await withWrites(() => followUp.markUnmatchedBankRefundVoidAnswered({ linkId, note: "Re-raised from the repair tool", actingMemberId: OFFICER_ID }));
      expect(await money()).toEqual(before);
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).toMatchObject({ outcome: "handled" });
    });

    it("the read-only count sorts one fixture per bucket", async () => {
      const { countBankRefundVoids } = await import("@/lib/bank-refund-void-count");
      const fixture = async (index: number) => {
        const bookingId = BUCKET_BOOKINGS[index]!;
        const paymentId = `${bookingId}-payment`;
        await paidBankTransfer(bookingId, paymentId, `${bookingId}-txn`);
        return { bookingId, paymentId };
      };
      const alerts = await import("@/lib/xero-error-alert");
      vi.spyOn(alerts, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      const voidOn = async (paymentId: string, noteId: string, cents: number) => {
        await inbound(voidedNote(noteId, cents));
        return linkIdOf(noteId, paymentId);
      };

      // undo, total equal to the detail (the floor kept it).
      const equal = await fixture(0);
      await handBackNoted(`${P}-eq`, PAID_CENTS, { ...equal });
      const eqLink = await voidOn(equal.paymentId, `${P}-eq`, PAID_CENTS);
      // undo, total already below the detail (an older recount lowered it).
      const below = await fixture(1);
      await handBackNoted(`${P}-lo`, PAID_CENTS, { ...below });
      const loLink = await voidOn(below.paymentId, `${P}-lo`, PAID_CENTS);
      await prisma.payment.update({ where: { id: below.paymentId }, data: { refundedAmountCents: 0, status: "SUCCEEDED" } });
      // spare.
      const spare = await fixture(2);
      await handBackNoted(`${P}-sp`, PAID_CENTS, { ...spare });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: spare.paymentId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-sp2`, role: "REFUND_CREDIT_NOTE",
          active: true, metadata: { amountCents: PAID_CENTS, status: "AUTHORISED", total: 200, perDelta: true },
        },
      });
      const spLink = await voidOn(spare.paymentId, `${P}-sp2`, PAID_CENTS);
      // awaiting the heal: an active mirror recorded VOIDED.
      const active = await fixture(3);
      await handBackNoted(`${P}-ac`, PAID_CENTS, { ...active });
      await prisma.xeroObjectLink.updateMany({ where: { localId: active.paymentId }, data: { metadata: { amountCents: PAID_CENTS, status: "VOIDED" } } });
      const acLink = await linkIdOf(`${P}-ac`, active.paymentId);
      // unmatched: the note's amount cannot be read.
      const unknown = await fixture(4);
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: unknown.paymentId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-un`, role: "REFUND_CREDIT_NOTE", active: false, metadata: { status: "VOIDED" } },
      });
      const unLink = await linkIdOf(`${P}-un`, unknown.paymentId);
      // deferred: a create could still mint.
      const deferred = await fixture(5);
      await handBackNoted(`${P}-de`, PAID_CENTS, { ...deferred });
      const deLink = await voidOn(deferred.paymentId, `${P}-de`, PAID_CENTS);
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: deferred.paymentId,
          status: "PENDING", correlationKey: `${P}-de-pending`, idempotencyKey: `${P}-de-pending`, requestPayload: {},
        },
      });
      // total below the detail with no void at all.
      const gap = await fixture(6);
      const { applyLocalRefundAllocation } = await import("@/lib/payment-transactions");
      await applyLocalRefundAllocation({ paymentId: gap.paymentId, amountCents: 7_000 });
      await prisma.payment.update({ where: { id: gap.paymentId }, data: { refundedAmountCents: 2_000 } });

      const count = await countBankRefundVoids(prisma as never);
      const bucketOf = (linkId: string) => Object.entries(count.buckets).find(([, entry]) => entry?.linkIds.includes(linkId))?.[0];
      expect(bucketOf(eqLink)).toBe("undo-total-equal-detail");
      expect(bucketOf(loLink)).toBe("undo-total-below-detail");
      expect(bucketOf(spLink)).toBe("spare");
      expect(bucketOf(acLink)).toBe("awaiting-heal");
      expect(bucketOf(unLink)).toBe("unmatched-amount-unknown");
      expect(bucketOf(deLink)).toBe("deferred");
      expect(count.totalBelowDetailWithoutVoid.paymentIds).toContain(gap.paymentId);
      expect(count.totalBelowDetailWithoutVoid.paymentIds).not.toContain(below.paymentId);
      // Read-only: nothing moved.
      expect(await prisma.manualRefundTask.count({ where: { bookingId: { in: BUCKET_BOOKINGS }, occurrenceKey: { startsWith: "bank-refund-void:" } } })).toBe(0);
    });
  },
);
