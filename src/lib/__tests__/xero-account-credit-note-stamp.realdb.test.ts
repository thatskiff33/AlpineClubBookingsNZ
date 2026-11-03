/**
 * Real-PostgreSQL proof of #4685: an account-credit Xero note stamps the one
 * member credit it was raised for, by id, so two equal credits on one booking
 * each carry their own note.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the member, the cancelled booking, its Internet Banking payment, and
 *   the cancellation credits (equal amounts, one booking, one description).
 * - REAL: the account-credit enqueue (`enqueueXeroAccountCreditNoteOperation`)
 *   or, for the deployed release's shape, a row queued without the credit id
 *   (`startXeroSyncOperation`); the outbox worker
 *   (`processQueuedXeroOutboxOperations`) parsing the row and running
 *   `createUnappliedXeroCreditNote` against a fake Xero, whose every create
 *   answers with a new note; the stamp (`stampCancellationCreditXeroNote`).
 *
 * Proven:
 * - two equal credits each get their own note: the note queued for the newer
 *   credit stamps that credit only, and the next note the older one. The
 *   payment holds one live account-credit link and the enqueue keys its note on
 *   the amount, and no writer retires an `ACCOUNT_CREDIT_NOTE` link (the void
 *   path retires refund-note roles only), so a second note on one payment is
 *   not reachable through today's pipeline: this test retires the link
 *   directly to reach the stamp (`INV-INT-036`'s limit);
 * - a queued row whose Xero create failed keeps its credit on the executed
 *   payload, and the officer's Retry stamps that credit, not the older one the
 *   old match would pick (PR #4706 review);
 * - a row queued without the credit id still stamps, by the old match;
 * - a replay of a linked note stamps no second credit: the old match stamped
 *   every equal credit, and now a note stamps one;
 * - #4705: the inbound credit-note reconcile (`reconcileXeroCreditNote`, its
 *   Xero read faked) stamps through the same stamp - one of two equal
 *   cancellation credits, oldest first, where no outbox row names one, and the
 *   credit the note's own outbox row named where one does; and none where a
 *   lot of another kind already records the note, or where only a link no
 *   account-credit outbox row explains reaches the payment (PR #4711 review);
 * - #4712: a note #1925's local provenance resolves (an admin-adjustment lot's
 *   note, applied to this booking) links the payment as no account-credit
 *   note, so the booking's own cancellation note still queues, and the note
 *   is never counted as refunded on it; and the one-off repair
 *   (`xero-applied-credit-account-note-link-repair.ts`) retires such a link
 *   written before the fix, recounts the payment, and leaves a link it cannot
 *   explain, or one the note was raised for, alone.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4685-`
 * fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4685";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const OLDER_CREDIT = `${P}-credit-older`;
const NEWER_CREDIT = `${P}-credit-newer`;
const CREDIT_CENTS = 5_000;
/** #4712: an admin-adjustment lot's note, spent on this booking through one slice. */
const APPLIED_NOTE = `${P}-applied-note`;
const APPLIED_LOT = `${P}-credit-applied-lot`;
const APPLIED_SLICE = `${P}-applied-slice`;
const APPLIED_INVOICE = `${P}-applied-invoice`;
const APPLIED_CENTS = 2_000;
/** The already-cancelled Internet Banking arm's description (`invoice-paid-effects.ts`). */
const DESCRIPTION = `Internet Banking payment credit for cancelled booking ${BOOKING_ID.slice(0, 8)}`;

let prisma: (typeof import("@/lib/prisma"))["prisma"];

/** A fake Xero whose every account-credit create answers with a new note, unless told to refuse the next. */
function fakeXero() {
  const created: string[] = [];
  const control = { refuseNext: false };
  const accountingApi = {
    createCreditNotes: async (_tenant: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }) => {
      if (control.refuseNext) {
        control.refuseNext = false;
        throw new Error(`${P}: Xero refused the create`);
      }
      const id = `${P}-note-${created.length + 1}`;
      created.push(id);
      const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
      return { body: { creditNotes: [{ creditNoteID: id, creditNoteNumber: `CN-${created.length}`, total, remainingCredit: total, status: "AUTHORISED" }] } };
    },
  };
  return { accountingApi, created, control };
}

(RUN ? describe : describe.skip)(
  "an account-credit Xero note stamps the one credit it was raised for - real PostgreSQL (#4685)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [PAYMENT_ID, APPLIED_SLICE] } } });
      // #4712: the applied credit's slice holds its lot.
      await prisma.memberCreditNoteAllocation.deleteMany({ where: { appliedToBookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      // #4705: the inbound reconcile's audit rows, its mirror's re-check slots, and its recount of the payment.
      await prisma.auditLog.deleteMany({ where: { targetId: PAYMENT_ID } });
      await prisma.xeroSyncCursor.deleteMany({ where: { scope: { contains: P } } });
      await prisma.payment.updateMany({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 0, status: "SUCCEEDED" } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Account-credit note stamp by id (#4685)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Stamp", lastName: "ById", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4685 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 10_000, finalPriceCents: 10_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
      await prisma.payment.create({ data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 10_000, source: "INTERNET_BANKING", status: "SUCCEEDED" } });
    }, 60_000);

    let xero: ReturnType<typeof fakeXero>;
    beforeEach(async () => {
      await clearRun();
      xero = fakeXero();
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi: xero.accountingApi }, tenantId: `tenant-${P}` } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
      vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue(`${P}-contact`);
      vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
        options.run({ contactId: options.currentContactId })) as never);
      // Two equal credits on one booking, the older first.
      for (const [id, createdAt] of [[OLDER_CREDIT, "2026-06-01T00:00:00.000Z"], [NEWER_CREDIT, "2026-06-02T00:00:00.000Z"]] as const) {
        await prisma.memberCredit.create({
          data: { id, memberId: MEMBER_ID, amountCents: CREDIT_CENTS, type: "CANCELLATION_REFUND", description: DESCRIPTION, sourceBookingId: BOOKING_ID, createdAt: new Date(createdAt) },
        });
      }
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await clearRun();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    async function runOutbox() {
      const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
      return processQueuedXeroOutboxOperations({ limit: 1 });
    }

    async function notes(): Promise<Record<string, string | null>> {
      const rows = await prisma.memberCredit.findMany({ where: { memberId: MEMBER_ID }, select: { id: true, xeroCreditNoteId: true } });
      return Object.fromEntries(rows.map((row) => [row.id, row.xeroCreditNoteId]));
    }

    async function enqueueFor(memberCreditId: string) {
      const { enqueueXeroAccountCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroAccountCreditNoteOperation(PAYMENT_ID, CREDIT_CENTS, { memberCreditId });
      expect(queued.queueOperationId).not.toBeNull();
      expect((await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: queued.queueOperationId! } })).requestPayload)
        .toMatchObject({ queueType: "ACCOUNT_CREDIT_NOTE", refundAmountCents: CREDIT_CENTS, memberCreditId });
    }

    it("MUTATION: two equal credits on one booking each get their own note", async () => {
      // The newer credit's note first: the old match would have stamped both, the older first.
      await enqueueFor(NEWER_CREDIT);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(xero.created).toEqual([`${P}-note-1`]);
      expect(await notes()).toEqual({ [OLDER_CREDIT]: null, [NEWER_CREDIT]: `${P}-note-1` });

      // No writer retires an account-credit link today; the test retires it to reach a second note's stamp.
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID, role: "ACCOUNT_CREDIT_NOTE" }, data: { active: false } });
      await enqueueFor(OLDER_CREDIT);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(xero.created).toEqual([`${P}-note-1`, `${P}-note-2`]);
      expect(await notes()).toEqual({ [OLDER_CREDIT]: `${P}-note-2`, [NEWER_CREDIT]: `${P}-note-1` });
    });

    it("MUTATION: a failed create keeps the credit on its executed payload, and the Retry stamps that credit", async () => {
      await enqueueFor(NEWER_CREDIT);
      xero.control.refuseNext = true;
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 0, failed: 1 });
      const failed = await prisma.xeroSyncOperation.findFirstOrThrow({ where: { localId: PAYMENT_ID, status: "FAILED" } });
      // The executed shape (the handler rewrote the payload before calling Xero), still naming its credit.
      expect(failed.requestPayload).toMatchObject({ creditNotes: expect.any(Array), memberCreditId: NEWER_CREDIT });
      expect(await notes()).toEqual({ [OLDER_CREDIT]: null, [NEWER_CREDIT]: null });

      const { retryXeroSyncOperation } = await import("@/lib/xero-operation-retry");
      await expect(retryXeroSyncOperation(failed.id, CLUB_FORMAT_TEST)).resolves.toMatchObject({ message: "Retried Xero account-credit note creation." });
      expect(xero.created).toEqual([`${P}-note-1`]);
      expect(await notes()).toEqual({ [OLDER_CREDIT]: null, [NEWER_CREDIT]: `${P}-note-1` });
    });

    it("MUTATION: a row queued without the credit id, as the deployed release queues it, still stamps by the old match", async () => {
      const { startXeroSyncOperation } = await import("@/lib/xero-sync");
      const key = `payment:${PAYMENT_ID}:unapplied-credit-note:${CREDIT_CENTS}:v1`;
      await startXeroSyncOperation({
        direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
        status: "PENDING", idempotencyKey: key, correlationKey: key,
        requestPayload: { queueType: "ACCOUNT_CREDIT_NOTE", refundAmountCents: CREDIT_CENTS },
      });

      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      // One credit, the oldest - never both.
      expect(await notes()).toEqual({ [OLDER_CREDIT]: `${P}-note-1`, [NEWER_CREDIT]: null });
    });

    it("a replay of the linked note stamps no second credit", async () => {
      await enqueueFor(NEWER_CREDIT);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });

      // A retry that finds the note already linked: named credit, and a row with none.
      const { createUnappliedXeroCreditNote } = await import("@/lib/xero-credit-notes");
      await expect(createUnappliedXeroCreditNote(PAYMENT_ID, CREDIT_CENTS, CLUB_FORMAT_TEST, { memberCreditId: OLDER_CREDIT })).resolves.toBe(`${P}-note-1`);
      await expect(createUnappliedXeroCreditNote(PAYMENT_ID, CREDIT_CENTS, CLUB_FORMAT_TEST)).resolves.toBe(`${P}-note-1`);
      expect(xero.created).toEqual([`${P}-note-1`]);
      expect(await notes()).toEqual({ [OLDER_CREDIT]: null, [NEWER_CREDIT]: `${P}-note-1` });
    });

    /** #4705: the inbound reconcile of `noteId`, Xero's read of the note faked as an unspent account-credit note, or as `overrides` say. */
    async function reconcileInbound(noteId: string, overrides: Record<string, unknown> = {}) {
      const total = CREDIT_CENTS / 100;
      const creditNote = { creditNoteID: noteId, creditNoteNumber: `CN-IN-${noteId}`, status: "AUTHORISED", total, appliedAmount: 0, remainingCredit: total, allocations: [], payments: [], ...overrides };
      const apiClient = await import("@/lib/xero-api-client");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({
        xero: { accountingApi: { ...xero.accountingApi, getCreditNote: async () => ({ body: { creditNotes: [creditNote] } }) } },
        tenantId: `tenant-${P}`,
      } as never);
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      return reconcileXeroCreditNote(noteId);
    }

    it("MUTATION #4705: an inbound note on a booking with two equal cancellation credits stamps one only, the oldest", async () => {
      // The cancellation flow's description: the one the inbound handler's own
      // updateMany matched, so the old stamp put this note on both credits.
      const { cancellationCreditDescription } = await import("@/lib/cancellation-settled-money");
      await prisma.memberCredit.updateMany({ where: { memberId: MEMBER_ID }, data: { description: cancellationCreditDescription(BOOKING_ID) } });
      // The note's outbox row was queued before #4685, naming no credit; the
      // outbox raised it, and its stamp is cleared to leave the inbound
      // reconcile the only writer.
      const { startXeroSyncOperation } = await import("@/lib/xero-sync");
      const key = `payment:${PAYMENT_ID}:unapplied-credit-note:${CREDIT_CENTS}:v1`;
      await startXeroSyncOperation({
        direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
        status: "PENDING", idempotencyKey: key, correlationKey: key,
        requestPayload: { queueType: "ACCOUNT_CREDIT_NOTE", refundAmountCents: CREDIT_CENTS },
      });
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      const noteId = `${P}-note-1`;
      await prisma.memberCredit.updateMany({ where: { memberId: MEMBER_ID }, data: { xeroCreditNoteId: null } });

      await expect(reconcileInbound(noteId)).resolves.toMatchObject({ handled: true, matchedAccountCreditPayments: 1, updatedCredits: 1 });
      expect(await notes()).toEqual({ [OLDER_CREDIT]: noteId, [NEWER_CREDIT]: null });

      // A replay of the event stamps nothing more.
      await expect(reconcileInbound(noteId)).resolves.toMatchObject({ updatedCredits: 0 });
      expect(await notes()).toEqual({ [OLDER_CREDIT]: noteId, [NEWER_CREDIT]: null });
    });

    it("MUTATION #4705: an inbound note reaching the payment by a link no account-credit outbox row explains stamps nothing", async () => {
      // A stale link, as #1925's local provenance left one before #4712: no lot or
      // slice records the note, and no outbox row raised it as an account-credit note.
      const { cancellationCreditDescription } = await import("@/lib/cancellation-settled-money");
      await prisma.memberCredit.updateMany({ where: { memberId: MEMBER_ID }, data: { description: cancellationCreditDescription(BOOKING_ID) } });
      const noteId = `${P}-stale-link-note`;
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, role: "ACCOUNT_CREDIT_NOTE", active: true },
      });

      await expect(reconcileInbound(noteId)).resolves.toMatchObject({ handled: true, matchedAccountCreditPayments: 1, updatedCredits: 0 });
      expect(await notes()).toEqual({ [OLDER_CREDIT]: null, [NEWER_CREDIT]: null });
    });

    it("MUTATION #4705: an inbound note a lot of another kind already records stamps no cancellation credit", async () => {
      const { cancellationCreditDescription } = await import("@/lib/cancellation-settled-money");
      await prisma.memberCredit.updateMany({ where: { memberId: MEMBER_ID }, data: { description: cancellationCreditDescription(BOOKING_ID) } });
      const noteId = `${P}-remainder-note`;
      // An admin-adjustment lot holds the note: the stamp's own holder check,
      // scoped to the booking's cancellation credits, never sees it.
      await prisma.memberCredit.create({
        data: { id: `${P}-credit-admin`, memberId: MEMBER_ID, amountCents: CREDIT_CENTS, type: "ADMIN_ADJUSTMENT", description: `${P} remainder`, xeroCreditNoteId: noteId },
      });
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, role: "ACCOUNT_CREDIT_NOTE", active: true },
      });

      await expect(reconcileInbound(noteId)).resolves.toMatchObject({ handled: true, updatedCredits: 0 });
      expect(await notes()).toEqual({ [OLDER_CREDIT]: null, [NEWER_CREDIT]: null, [`${P}-credit-admin`]: noteId });
    });

    it("MUTATION #4705: an inbound note stamps the credit its own outbox row named, not the older equal one", async () => {
      await enqueueFor(NEWER_CREDIT);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      // Clears the outbox's own stamp to simulate it absent, so the inbound
      // reconcile alone must find the credit - pinning the reader's wiring, not
      // a path the outbox is known to reach.
      await prisma.memberCredit.updateMany({ where: { memberId: MEMBER_ID }, data: { xeroCreditNoteId: null } });

      await expect(reconcileInbound(`${P}-note-1`)).resolves.toMatchObject({ handled: true, updatedCredits: 1 });
      expect(await notes()).toEqual({ [OLDER_CREDIT]: null, [NEWER_CREDIT]: `${P}-note-1` });
    });

    /** #4712: the admin-adjustment lot whose note was spent on this booking, as the allocation engine records it. */
    async function seedAppliedCredit() {
      await prisma.memberCredit.create({
        data: { id: APPLIED_LOT, memberId: MEMBER_ID, amountCents: APPLIED_CENTS, type: "ADMIN_ADJUSTMENT", description: `${P} admin lot`, xeroCreditNoteId: APPLIED_NOTE },
      });
      await prisma.memberCreditNoteAllocation.create({
        data: { id: APPLIED_SLICE, memberCreditId: APPLIED_LOT, xeroCreditNoteId: APPLIED_NOTE, appliedToBookingId: BOOKING_ID, amountCents: APPLIED_CENTS },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "MemberCreditNoteAllocation", localId: APPLIED_SLICE, xeroObjectType: "ALLOCATION", xeroObjectId: `${APPLIED_NOTE}:${APPLIED_INVOICE}`,
          role: "APPLIED_CREDIT_ALLOCATION", active: true, metadata: { creditNoteId: APPLIED_NOTE, invoiceId: APPLIED_INVOICE, amountCents: APPLIED_CENTS },
        },
      });
    }

    /** The note as Xero reads it: fully spent on this booking's invoice. */
    const appliedNoteReading = {
      total: APPLIED_CENTS / 100,
      appliedAmount: APPLIED_CENTS / 100,
      remainingCredit: 0,
      allocations: [{ invoice: { invoiceID: APPLIED_INVOICE }, amount: APPLIED_CENTS / 100 }],
    };

    async function accountNoteLinks() {
      return prisma.xeroObjectLink.findMany({ where: { localId: PAYMENT_ID, role: "ACCOUNT_CREDIT_NOTE" }, select: { xeroObjectId: true, active: true } });
    }

    it("MUTATION #4712: a note resolved only through local provenance links no account-credit note, so the booking's own cancellation note still queues", async () => {
      await seedAppliedCredit();

      await expect(reconcileInbound(APPLIED_NOTE, appliedNoteReading)).resolves.toMatchObject({ handled: true, matchedAccountCreditPayments: 0, matchedAppliedCreditPayments: 1 });

      expect(await accountNoteLinks()).toEqual([]);
      // The note was spent here, not paid back.
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true, status: true } }))
        .toEqual({ refundedAmountCents: 0, status: "SUCCEEDED" });
      // The cancellation's own note queues, and the outbox raises it.
      await enqueueFor(NEWER_CREDIT);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(xero.created).toEqual([`${P}-note-1`]);
      expect(await notes()).toMatchObject({ [NEWER_CREDIT]: `${P}-note-1`, [APPLIED_LOT]: APPLIED_NOTE });
    });

    it("MUTATION #4712: the repair retires a link local provenance wrote before the fix, recounts the payment, and the cancellation note then queues", async () => {
      const repair = await import("@/lib/xero-applied-credit-account-note-link-repair");
      await seedAppliedCredit();
      // What the reconcile wrote before #4712: the link, and the note counted as refunded.
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: APPLIED_NOTE, role: "ACCOUNT_CREDIT_NOTE", active: true, metadata: { status: "AUTHORISED", total: APPLIED_CENTS / 100 } },
      });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: APPLIED_CENTS, status: "PARTIALLY_REFUNDED" } });
      const { enqueueXeroAccountCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      await expect(enqueueXeroAccountCreditNoteOperation(PAYMENT_ID, CREDIT_CENTS, { memberCreditId: NEWER_CREDIT })).resolves.toMatchObject({ queueOperationId: null });

      const report = await repair.findStaleAppliedCreditAccountNoteLinks();
      expect(report.stale.filter((link) => link.paymentId === PAYMENT_ID)).toEqual([expect.objectContaining({ creditNoteId: APPLIED_NOTE, classification: "STALE" })]);
      expect(await accountNoteLinks()).toEqual([{ xeroObjectId: APPLIED_NOTE, active: true }]); // the dry run wrote nothing

      await expect(repair.applyStaleAppliedCreditAccountNoteLinkRepair([PAYMENT_ID])).resolves.toMatchObject({ retired: [expect.objectContaining({ paymentId: PAYMENT_ID })], notStale: [], recountUnsettledPaymentIds: [] });
      expect(await accountNoteLinks()).toEqual([{ xeroObjectId: APPLIED_NOTE, active: false }]);
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true, status: true } }))
        .toEqual({ refundedAmountCents: 0, status: "SUCCEEDED" });
      // A second apply finds nothing left to retire.
      await expect(repair.applyStaleAppliedCreditAccountNoteLinkRepair([PAYMENT_ID])).resolves.toMatchObject({ retired: [], notStale: [{ paymentId: PAYMENT_ID, reason: expect.any(String) }] });

      await enqueueFor(NEWER_CREDIT);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(await notes()).toMatchObject({ [NEWER_CREDIT]: `${P}-note-1` });
    });

    it("MUTATION #4712: the repair leaves alone a link it cannot explain and one the note was raised for", async () => {
      const repair = await import("@/lib/xero-applied-credit-account-note-link-repair");
      // Neither raised for this payment nor applied to its booking.
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `${P}-unexplained-note`, role: "ACCOUNT_CREDIT_NOTE", active: true },
      });
      let report = await repair.findStaleAppliedCreditAccountNoteLinks({ paymentIds: [PAYMENT_ID] });
      expect(report).toMatchObject({ stale: [], unexplained: [expect.objectContaining({ creditNoteId: `${P}-unexplained-note` })], raisedForPayment: 0 });
      await expect(repair.applyStaleAppliedCreditAccountNoteLinkRepair([PAYMENT_ID])).resolves.toMatchObject({ retired: [] });
      expect(await accountNoteLinks()).toEqual([{ xeroObjectId: `${P}-unexplained-note`, active: true }]);

      // The outbox raised a note for this payment, which a slice also spent here.
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await enqueueFor(NEWER_CREDIT);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      // Its outbox row alone must say so: the credit's stamp is cleared.
      await prisma.memberCredit.updateMany({ where: { memberId: MEMBER_ID }, data: { xeroCreditNoteId: null } });
      await prisma.memberCredit.create({
        data: { id: APPLIED_LOT, memberId: MEMBER_ID, amountCents: APPLIED_CENTS, type: "ADMIN_ADJUSTMENT", description: `${P} admin lot` },
      });
      await prisma.memberCreditNoteAllocation.create({
        data: { id: APPLIED_SLICE, memberCreditId: APPLIED_LOT, xeroCreditNoteId: `${P}-note-1`, appliedToBookingId: BOOKING_ID, amountCents: APPLIED_CENTS },
      });
      report = await repair.findStaleAppliedCreditAccountNoteLinks({ paymentIds: [PAYMENT_ID] });
      expect(report).toMatchObject({ stale: [], unexplained: [], raisedForPayment: 1 });
      await expect(repair.applyStaleAppliedCreditAccountNoteLinkRepair([PAYMENT_ID])).resolves.toMatchObject({ retired: [] });
      expect(await accountNoteLinks()).toEqual([{ xeroObjectId: `${P}-note-1`, active: true }]);
    });
  },
);
