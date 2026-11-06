/**
 * Real-PostgreSQL proof of #4421 (owner decision 26 Oct 2026, `INV-INT-025`:
 * one note, one refund): "Resolve by hand" on a payment refund credit-note
 * create that names no note of its own records the Xero note the officer made,
 * and that note then records no other refund - whichever writer comes first.
 *
 * The shape is #4321's: H1's $200 note V, which Xero voids, so the nightly
 * follow-up (the real writer) undoes H1 and asks the treasurer once; H2's own
 * $200 note, queued by the real enqueue, FAILED before Xero returned a note.
 * The officer made one $200 note X in Xero by hand. Two writers can record X:
 * - the officer's "Resolve by hand" on H2's row, through the real route;
 * - the treasurer's "already recorded it in Xero myself" answer to the
 *   follow-up, through the real completion (`resolveManualRefundTask`).
 * Only one may. Proven in sequence both ways and with each writer holding its
 * transaction past its own check while the other runs. And the resolve tracks
 * the note through the payment's link, so when Xero voids it the inbound sync
 * records the void and the nightly follow-up undoes the refund (#4421 review,
 * money F1).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4421-`
 * fixtures. No Stripe or Xero call is made.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { NextRequest } from "next/server";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { raceSession } from "@/lib/__tests__/support/race-session-double";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

// The harness's one `@/lib/auth` double: the resolve route reads the officer's session from it.
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4421";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const TXN_ID = `${P}-txn`;
const INVOICE_ID = `inv-${P}`;
const CONTACT_ID = `${P}-contact`;
const NOTE_X = `${P}-x`;
const PAID_CENTS = 60_000;
const LOCK_WAIT_TIMEOUT_MS = 10_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let fences: typeof import("@/lib/xero-resolved-in-xero-fences");
let followUp: typeof import("@/lib/bank-refund-void-follow-up");
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "Resolve by hand records the refund note the officer made, once - real PostgreSQL (#4421)",
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

    /** A cancellation hand-back recorded by the real writers and, unless `noNote`, its live $-sized note V. */
    async function handBack(noteId: string, cents: number, options?: { noNote?: boolean }) {
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
          requestPayload: { refundMethod: "internet-banking", refundAmountCents: cents, watermarkCents: cents, allocation: { invoiceId: INVOICE_ID, amount: cents / 100 }, handBackTaskId: taskId },
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, xeroObjectNumber: `CN-${noteId}`,
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: cents, watermarkCents: cents, status: "AUTHORISED", total: cents / 100 },
        },
      });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroRefundCreditNoteId: noteId } });
      return taskId;
    }

    /** Swap in a fake Xero (no provider call) for the length of `run`; the contact and refund-account reads a raising run makes, too. */
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
        vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "record", bankCode: "090" }),
      ];
      try {
        return await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /** Xero holding the officer's hand-made $200 note X, approved, for the member's contact. */
    const xeroWithNoteX = {
      getCreditNotes: async () => ({
        body: { creditNotes: [{ creditNoteID: NOTE_X, creditNoteNumber: `CN-${NOTE_X}`, status: "AUTHORISED", type: "ACCRECCREDIT", total: 200, contact: { contactID: CONTACT_ID }, allocations: [] }] },
      }),
      getInvoice: async () => ({ body: { invoices: [{ contact: { contactID: CONTACT_ID } }] } }),
      getCreditNote: async () => ({
        body: { creditNotes: [{ creditNoteID: NOTE_X, creditNoteNumber: `CN-${NOTE_X}`, status: "AUTHORISED", total: 200, appliedAmount: 0, remainingCredit: 200, allocations: [], payments: [] }] },
      }),
    };

    /** The inbound reconcile of a note Xero reports voided. */
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

    /**
     * H1's voided note V, undone by the real nightly follow-up; H2's own $200
     * note queued by the real enqueue and FAILED before Xero returned a note -
     * the row "Resolve by hand" now asks a number of.
     */
    async function failedNoteBesideFollowUp() {
      await handBack(`${P}-v`, 20_000);
      const h2 = await handBack(`${P}-h2`, 20_000, { noNote: true });
      const outcome = await followUp.followUpVoidedBankRefundNote(await voidInXero(`${P}-v`, 20_000));
      expect(outcome).toMatchObject({ outcome: "undone" });
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 20_000, { refundMethod: "internet-banking", paidAnotherWayTaskId: h2 });
      const rowId = queued.queueOperationId!;
      expect(rowId).toEqual(expect.any(String));
      // As the outbox leaves a create Xero refused: FAILED, no note.
      await prisma.xeroSyncOperation.update({ where: { id: rowId }, data: { status: "FAILED", lastErrorMessage: "Xero refused the credit note", completedAt: new Date() } });
      const { resolveCreditNotePrompt } = await import("@/lib/xero-resolve-refund-note");
      expect(resolveCreditNotePrompt(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: rowId } }))).toMatchObject({
        resolveAsksCreditNoteNumber: true,
        resolveCreditNoteAmountCents: 20_000,
      });
      return { h2, rowId, followUpId: outcome!.followUpTaskId! };
    }

    /** The officer's "Resolve by hand" with note X, through the real route, against the fake Xero. */
    async function resolveWithX(rowId: string) {
      const { POST } = await import("@/app/api/admin/xero/operations/[id]/resolve/route");
      return withFakeXero(xeroWithNoteX, () =>
        POST(
          new NextRequest(`http://localhost/api/admin/xero/operations/${rowId}/resolve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "Made the note by hand in Xero", creditNoteNumber: `CN-${NOTE_X}` }),
          }),
          { params: Promise.resolve({ id: rowId }) },
        ),
      );
    }

    /** The treasurer's "already recorded it in Xero myself" answer naming X, checked against the fake Xero. */
    async function answerWithX(followUpId: string) {
      const { prepareBankRefundVoidAnswer } = await import("@/lib/bank-refund-void-answer");
      return withFakeXero(xeroWithNoteX, () =>
        prepareBankRefundVoidAnswer({ taskId: followUpId, answer: { answer: "recorded-in-xero", creditNoteNumber: `CN-${NOTE_X}` }, format: CLUB_FORMAT_TEST }),
      );
    }

    /** The follow-up's completion, through the real resolution, with that answer. */
    async function complete(followUpId: string, answer: Awaited<ReturnType<typeof answerWithX>>) {
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      return resolveManualRefundTask(
        { taskId: followUpId, resolution: "completed", note: null, actingMemberId: OFFICER_ID, confirmedAmountCents: null, direction: null, recordedNightPrices: null, bankRefundVoidAnswer: answer },
        CLUB_FORMAT_TEST,
      );
    }

    /**
     * Every record of X here, by the refund it records: a create row naming it,
     * and each link with the record it names (the resolved row, or the
     * follow-up). One note, one refund: every record names the same refund.
     */
    async function recordsOfX() {
      const rows = await prisma.xeroSyncOperation.findMany({ where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_X }, select: { id: true } });
      const links = await prisma.xeroObjectLink.findMany({ where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_X }, select: { active: true, metadata: true } });
      return {
        rows: rows.map((row) => row.id),
        links: links.map((link) => {
          const metadata = (link.metadata ?? {}) as Record<string, unknown>;
          return { active: link.active, resolvedOperationId: metadata.resolvedOperationId ?? null, handBackTaskId: metadata.handBackTaskId ?? null };
        }),
      };
    }

    /** The money, the payment's refund-note coverage, and the two refunds' states. */
    async function books(rowId: string, followUpId: string) {
      const resolved = await fences.readResolvedRefundCreditNoteCoverage(PAYMENT_ID);
      return {
        refundedAmountCents: (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).refundedAmountCents,
        coverageCents: await fences.sumRefundCreditNoteCoverageCents(PAYMENT_ID, resolved),
        row: await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: rowId }, select: { status: true, xeroObjectId: true, xeroObjectNumber: true } }),
        rowResolved: (await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: rowId }, select: { manuallyResolvedAt: true } })).manuallyResolvedAt !== null,
        followUpStatus: (await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: followUpId }, select: { status: true } })).status,
      };
    }

    /** Wait until some session here is queued on an advisory lock - the global `lock(1)` - and report it. */
    async function untilWaitingOnAdvisoryLock(): Promise<boolean> {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_WAIT_TIMEOUT_MS) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
        `;
        if ((rows[0]?.count ?? 0) > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Resolve records refund note");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      fences = await import("@/lib/xero-resolved-in-xero-fences");
      followUp = await import("@/lib/bank-refund-void-follow-up");
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Resolve", lastName: "Note", role, ageTier: "ADULT", canLogin: true },
        });
      }
      await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4421 Lodge", slug: P } });
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
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
      });
      await prisma.paymentTransaction.create({
        data: { id: TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: PAID_CENTS, status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
      });
    });

    afterEach(() => {
      raceSession.current = null;
    });

    afterAll(async () => {
      raceSession.current = null;
      if (!prisma) return;
      await deleteFixtures();
    }, 90_000);

    const refusedAnswer = { status: 409, message: expect.stringContaining(`CN-${NOTE_X} is already recorded`) };

    it("MUTATION (#4421): a resolve records the note it was given; the hand-made answer then refuses that note, and the refund is counted once", async () => {
      const { rowId, followUpId } = await failedNoteBesideFollowUp();
      // H1 undone: $200 refunded (H2), nothing yet covers H2.
      expect(await books(rowId, followUpId)).toMatchObject({ refundedAmountCents: 20_000, coverageCents: 0, rowResolved: false, followUpStatus: "OPEN" });

      const response = await resolveWithX(rowId);
      expect(response.status).toBe(200);
      const resolved = await books(rowId, followUpId);
      expect(resolved).toMatchObject({
        refundedAmountCents: 20_000, coverageCents: 20_000, rowResolved: true, followUpStatus: "OPEN",
        row: { status: "FAILED", xeroObjectId: NOTE_X, xeroObjectNumber: `CN-${NOTE_X}` },
      });

      // The row and the payment's live link both name X for H2's row: the link counts it, the row adds nothing.
      const recorded = { rows: [rowId], links: [{ active: true, resolvedOperationId: rowId, handBackTaskId: null }] };
      expect(await recordsOfX()).toEqual(recorded);

      // Before #4421 the row named no note, X passed #4419's guard, and one $200 note covered $400.
      await expect(complete(followUpId, await answerWithX(followUpId))).rejects.toMatchObject(refusedAnswer);
      expect(await books(rowId, followUpId)).toEqual(resolved);
      expect(await recordsOfX()).toEqual(recorded);
    });

    it("MUTATION (#4421, reverse order): once the hand-made answer records the note, a resolve offering it is refused and writes nothing", async () => {
      const { rowId, followUpId } = await failedNoteBesideFollowUp();
      await complete(followUpId, await answerWithX(followUpId));
      const answered = await books(rowId, followUpId);
      expect(answered).toMatchObject({ refundedAmountCents: 40_000, coverageCents: 20_000, rowResolved: false, followUpStatus: "COMPLETED", row: { xeroObjectId: null } });

      const response = await resolveWithX(rowId);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain(`CN-${NOTE_X} is already recorded against another refund or booking here`);
      expect(await books(rowId, followUpId)).toEqual(answered);
      expect(await recordsOfX()).toEqual({ rows: [], links: [{ active: true, resolvedOperationId: null, handBackTaskId: followUpId }] });
    });

    it("MUTATION (#4421, interleaving): a resolve arriving while the answer holds its locks past its guard waits on lock(1), then refuses; the note is recorded once", async () => {
      const { rowId, followUpId } = await failedNoteBesideFollowUp();
      const answer = await answerWithX(followUpId);

      // The completion passes its guard and pauses at its link write, inside its transaction, holding lock(1).
      const xeroSync = await import("@/lib/xero-sync");
      const realUpsert = xeroSync.upsertXeroObjectLink;
      let reachedLinkWrite!: () => void;
      const atLinkWrite = new Promise<void>((resolve) => (reachedLinkWrite = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const spy = vi.spyOn(xeroSync, "upsertXeroObjectLink").mockImplementation(async (...args: Parameters<typeof realUpsert>) => {
        if (args[0].xeroObjectId === NOTE_X) {
          reachedLinkWrite();
          await released;
        }
        return realUpsert(...args);
      });
      try {
        const completion = complete(followUpId, answer);
        void completion.catch(() => undefined);
        await atLinkWrite;

        // Session B: the officer resolves H2's row with X. Its Xero check runs unlocked; its claim queues on lock(1).
        const resolving = resolveWithX(rowId);
        expect(await untilWaitingOnAdvisoryLock()).toBe(true);
        release();
        await completion;

        const response = await resolving;
        expect(response.status).toBe(409);
        expect((await response.json()).error).toContain(`CN-${NOTE_X} is already recorded`);
      } finally {
        release();
        spy.mockRestore();
      }

      expect(await books(rowId, followUpId)).toMatchObject({ refundedAmountCents: 40_000, coverageCents: 20_000, rowResolved: false, followUpStatus: "COMPLETED", row: { xeroObjectId: null } });
      expect(await recordsOfX()).toEqual({ rows: [], links: [{ active: true, resolvedOperationId: null, handBackTaskId: followUpId }] });
    });

    it("MUTATION (#4421, interleaving): an answer arriving while the resolve holds lock(1) past its checks waits, then refuses; the note is recorded once", async () => {
      const { rowId, followUpId } = await failedNoteBesideFollowUp();
      const answer = await answerWithX(followUpId);

      // The resolve's claim passes its reads and pauses before its write, inside its transaction, holding lock(1).
      const realTransaction = prisma.$transaction.bind(prisma) as (run: (tx: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>;
      let reachedClaim!: () => void;
      const atClaim = new Promise<void>((resolve) => (reachedClaim = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(((run: (tx: Record<string, unknown>) => Promise<unknown>, options?: unknown) =>
        realTransaction(
          (tx) => {
            const client = tx as Record<string, unknown> & { xeroSyncOperation: { updateMany: (...args: unknown[]) => Promise<unknown> } };
            const operations = client.xeroSyncOperation;
            const paused = new Proxy(operations, {
              get(target, property, receiver) {
                if (property !== "updateMany") return Reflect.get(target, property, receiver);
                return async (...args: unknown[]) => {
                  reachedClaim();
                  await released;
                  return target.updateMany(...args);
                };
              },
            });
            return run(new Proxy(client, { get: (target, property, receiver) => (property === "xeroSyncOperation" ? paused : Reflect.get(target, property, receiver)) }));
          },
          options,
        )) as never);
      try {
        const resolving = resolveWithX(rowId);
        void resolving.catch(() => undefined);
        await atClaim;
        spy.mockRestore();

        // Session B: the treasurer's completion queues on lock(1), its first lock.
        const completion = complete(followUpId, answer);
        void completion.catch(() => undefined);
        expect(await untilWaitingOnAdvisoryLock()).toBe(true);
        release();
        expect((await resolving).status).toBe(200);
        await expect(completion).rejects.toMatchObject(refusedAnswer);
      } finally {
        release();
        spy.mockRestore();
      }

      expect(await books(rowId, followUpId)).toMatchObject({
        refundedAmountCents: 20_000, coverageCents: 20_000, rowResolved: true, followUpStatus: "OPEN", row: { xeroObjectId: NOTE_X },
      });
      expect(await recordsOfX()).toEqual({ rows: [rowId], links: [{ active: true, resolvedOperationId: rowId, handBackTaskId: null }] });
    });

    it("MUTATION (#4421 round 2, a retry already raised the note): once the row's retry made CN-0200, a resolve with a hand-made note for the same $200 is refused, and the refund keeps one note", async () => {
      const { rowId, followUpId } = await failedNoteBesideFollowUp();
      const NOTE_RETRY = `${P}-0200`;

      // Monday: the officer retries the FAILED row; the real retry queue replays it against a fake Xero that raises CN-0200 and records its refund payment.
      await withFakeXero(
        {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }) => {
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            return { body: { creditNotes: [{ creditNoteID: NOTE_RETRY, creditNoteNumber: "CN-0200", total, remainingCredit: total, status: "AUTHORISED", payments: [] }] } };
          },
          createPayments: async () => ({ body: { payments: [{ paymentID: `${P}-refund-payment`, amount: 200, status: "AUTHORISED" }] } }),
          getCreditNote: async () => ({ body: { creditNotes: [] } }),
          getCreditNotes: async () => ({ body: { creditNotes: [] } }),
        },
        async () => {
          const { enqueueXeroSyncOperationRetry, processQueuedXeroOperationRetries } = await import("@/lib/xero-operation-queue");
          await enqueueXeroSyncOperationRetry(rowId, { createdByMemberId: OFFICER_ID });
          await processQueuedXeroOperationRetries({ limit: 5 }, CLUB_FORMAT_TEST);
        },
      );
      const runs = await prisma.xeroSyncOperation.findMany({
        where: { localId: PAYMENT_ID, status: { in: ["SUCCEEDED", "PARTIAL"] }, xeroObjectId: NOTE_RETRY },
        select: { id: true, status: true },
      });
      expect(runs.length).toBeGreaterThan(0);
      // The original stays FAILED naming no note, so before round 2 it still asked for a number.
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: rowId }, select: { status: true, xeroObjectId: true } })).toEqual({ status: "FAILED", xeroObjectId: null });
      const before = await books(rowId, followUpId);
      expect(before).toMatchObject({ coverageCents: 20_000, rowResolved: false });

      // The panel says so before anything is typed.
      const { GET } = await import("@/app/api/admin/xero/operations/route");
      const listed = await (await GET(new NextRequest(`http://localhost/api/admin/xero/operations?localModel=Payment&localId=${PAYMENT_ID}`))).json();
      expect(listed.data.find((row: { id: string }) => row.id === rowId)).toMatchObject({
        resolveAsksCreditNoteNumber: false,
        resolveRefusal: expect.stringContaining("already made its note"),
      });

      // Tuesday: the officer resolves the original with a hand-made $200 note X as well.
      const response = await resolveWithX(rowId);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("already made its note");
      // Before: two live notes, $400 of coverage for a $200 refund. Now: one.
      expect(await books(rowId, followUpId)).toEqual(before);
      expect(await recordsOfX()).toEqual({ rows: [], links: [] });
    });

    it("MUTATION (#4421, the void path): once Xero voids the note a resolve recorded, the link records the void, nothing covers H2, and the nightly follow-up undoes it and asks once", async () => {
      const { rowId, followUpId } = await failedNoteBesideFollowUp();
      expect((await resolveWithX(rowId)).status).toBe(200);
      expect(await books(rowId, followUpId)).toMatchObject({ refundedAmountCents: 20_000, coverageCents: 20_000, rowResolved: true });

      // Xero voids X; the real inbound reconcile finds it through the link the resolve wrote.
      const linkId = await voidInXero(NOTE_X, 20_000);
      const link = await prisma.xeroObjectLink.findUniqueOrThrow({ where: { id: linkId }, select: { active: true, metadata: true } });
      expect(link.active).toBe(false);
      expect((link.metadata as Record<string, unknown>).status).toBe("VOIDED");
      // Neither the voided link nor the resolved row naming it covers anything: $200 refunded, $0 noted.
      expect(await books(rowId, followUpId)).toMatchObject({ refundedAmountCents: 20_000, coverageCents: 0, rowResolved: true });

      // The real nightly follow-up undoes H2's $200 and asks once, as for any voided bank refund note.
      const outcome = await followUp.followUpVoidedBankRefundNote(linkId);
      expect(outcome).toMatchObject({ outcome: "undone" });
      expect(await books(rowId, followUpId)).toMatchObject({ refundedAmountCents: 0, coverageCents: 0 });
      const asked = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID, status: "OPEN" }, select: { id: true, amountCents: true } });
      expect(asked).toHaveLength(2);
      expect(asked.find((task) => task.id === outcome!.followUpTaskId)).toMatchObject({ amountCents: 20_000 });
      // Run again: handled, nothing more.
      expect(await followUp.followUpVoidedBankRefundNote(linkId)).not.toMatchObject({ outcome: "undone" });
    });
  },
);
