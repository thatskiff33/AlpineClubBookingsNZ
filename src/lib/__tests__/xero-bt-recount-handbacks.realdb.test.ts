/**
 * Real-PostgreSQL pins for #4230 (`INV-ADDPAY-021`, `INV-PAY-124`): bank-transfer
 * cash the inbound refunded-total recount (`repairRefundedPaymentBusinessState`)
 * was suspected of dropping.
 *
 * Safe, and pinned as such:
 * - A group organiser's hand-back (#4042) moves no payment's refunded total.
 *   The group cancel already recorded each joiner's refund on the joiner's own
 *   payment, under that payment's own canonical note, so completing the
 *   organiser's task writes no payment row and leaves nothing for a recount to
 *   drop.
 * - The recount writes `Payment.refundedAmountCents` and never the charge rows.
 *   That split is deliberate: the paid cancel folds the difference into the
 *   rows later (#1491, `foldMirrorRefundIntoLedger`), and the rows are the
 *   detail the #4162 floor keeps, so a recount that rewrote them would erase
 *   the floor it is held to.
 *
 * A later cancellation hand-back on a bank-transfer payment that already has
 * its canonical note is queued a note of its own, keyed on its task (#4287,
 * owner decision 22 Oct 2026); `xero-bt-per-refund-notes` proves it through to
 * Xero and the readers. Since #4312 a refund request's card part on such a
 * payment is queued a note of its own too, keyed on its card refund (pinned
 * here; `xero-bt-card-refund-notes` proves it through to Xero). A refund folded
 * before either release leaves Xero genuinely short a note, so the floor keeps
 * the total and the alert is true; it names that cause and asks for the note
 * by hand. The recount deliberately does not add the
 * absorbed cash (that would silence the only signal). Which void states reach
 * the alert is pinned too (only an answered void with its cash kept), and the
 * deploy note's read-only query is run here as an operator would run it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4230-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4230-member";
const OFFICER_ID = "race-4230-officer";
const LODGE_ID = "race-4230-lodge";
const ORGANISER_BOOKING_ID = "race-4230-organiser";
const JOINER_BOOKING_ID = "race-4230-joiner";
const ORGANISER_PAYMENT_ID = "race-4230-organiser-payment";
const JOINER_PAYMENT_ID = "race-4230-joiner-payment";
const TASK_ID = "race-4230-organiser-task";
const SETTLEMENT_ID = "race-4230-settlement";
const CANONICAL_NOTE = "cn-race-4230-canonical";
const OTHER_NOTE = "cn-race-4230-other";

const BOOKING_IDS = [ORGANISER_BOOKING_ID, JOINER_BOOKING_ID];
const PAYMENT_IDS = [ORGANISER_PAYMENT_ID, JOINER_PAYMENT_ID];

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "the inbound recount of a bank-transfer payment and the cash it was suspected of dropping - real PostgreSQL (#4230)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: { in: PAYMENT_IDS } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: PAYMENT_IDS } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: PAYMENT_IDS } } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: PAYMENT_IDS } } });
      await prisma.payment.deleteMany({ where: { id: { in: PAYMENT_IDS } } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: { in: BOOKING_IDS } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Bank-transfer recount (#4230)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Hand", lastName: "Back", ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4230 Lodge", slug: "race-4230" } });
      for (const id of BOOKING_IDS) {
        await prisma.booking.create({
          data: {
            id, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
            checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
            organiserSettled: id === JOINER_BOOKING_ID,
          },
        });
      }
    }, 60_000);

    beforeEach(async () => {
      await clearRun();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    async function paymentState(id: string) {
      return prisma.payment.findUniqueOrThrow({ where: { id }, select: { refundedAmountCents: true, status: true } });
    }

    async function linkCanonicalNote(paymentId: string, cents: number) {
      await prisma.payment.update({ where: { id: paymentId }, data: { xeroRefundCreditNoteId: CANONICAL_NOTE } });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: CANONICAL_NOTE, xeroObjectNumber: "CN-4230",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: cents, status: "PAID" },
        },
      });
    }

    /** The inbound reconcile of the canonical note, read from a fake Xero (no provider call). */
    async function reconcileCanonicalNote(totalDollars: number) {
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      const note = {
        creditNoteID: CANONICAL_NOTE, creditNoteNumber: "CN-4230", status: "PAID",
        total: totalDollars, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
      };
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4230" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        return await reconcileXeroCreditNote(CANONICAL_NOTE);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /** The refund-ledger divergence alerts raised while `run` executes (#1353, #4162 floors): operation and message. */
    async function watchDivergenceAlertMessages(run: () => Promise<unknown>): Promise<Array<{ operation: string; errorMessage: string }>> {
      const alerting = await import("@/lib/xero-error-alert");
      const spy = vi.spyOn(alerting, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      try {
        await run();
        return spy.mock.calls
          .map(([input]) => input as { errorType: string; operation: string; errorMessage: string })
          .filter((input) => input.errorType === "refund-ledger-divergence")
          .map(({ operation, errorMessage }) => ({ operation, errorMessage }));
      } finally {
        spy.mockRestore();
      }
    }

    async function watchDivergenceAlerts(run: () => Promise<unknown>): Promise<string[]> {
      return (await watchDivergenceAlertMessages(run)).map((alert) => alert.operation);
    }

    /** The #4230 deploy note's read-only query, run as an operator would run it: the payments it lists. */
    async function deployNoteListedPaymentIds(): Promise<string[]> {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const doc = readFileSync(resolve(__dirname, "../../../docs/xero/ARCHITECTURE.md"), "utf8");
      const section = doc.slice(doc.indexOf("**Deploy note (#4230).**"));
      const sql = /```sql\n([\s\S]*?)\n```/.exec(section)?.[1];
      expect(sql).toBeDefined();
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(sql!);
      return rows.map((row) => row.id).filter((id) => PAYMENT_IDS.includes(id));
    }

    /** A $200 bank transfer that refunded $100 by a completed hand-back, under its one canonical note. */
    async function seedRefundedUnderCanonicalNote(extra: { amountCents?: number } = {}) {
      await prisma.payment.create({
        data: {
          id: ORGANISER_PAYMENT_ID, bookingId: ORGANISER_BOOKING_ID, amountCents: extra.amountCents ?? 20_000, source: "INTERNET_BANKING",
          status: "PARTIALLY_REFUNDED", refundedAmountCents: 10_000, xeroInvoiceId: "inv-race-4230-organiser",
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: "race-4230-txn", paymentId: ORGANISER_PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 20_000,
          refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED",
        },
      });
      await prisma.manualRefundTask.create({
        data: {
          id: "race-4230-first-hand-back", bookingId: ORGANISER_BOOKING_ID, paymentId: ORGANISER_PAYMENT_ID, amountCents: 10_000, raisedAmountCents: 10_000,
          kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED", reason: "race 4230 first hand-back",
          completedAt: new Date("2026-06-01T00:00:00.000Z"), completedByMemberId: OFFICER_ID, settlementDirection: "REFUND_TO_MEMBER",
        },
      });
      await linkCanonicalNote(ORGANISER_PAYMENT_ID, 10_000);
    }

    async function refundNoteRows() {
      return prisma.xeroSyncOperation.count({ where: { localModel: "Payment", localId: ORGANISER_PAYMENT_ID, entityType: "CREDIT_NOTE" } });
    }

    it("a group organiser's hand-back moves no payment's refunded total, and a joiner's canonical-note recount keeps the joiner's refund (#4042)", async () => {
      // What the organiser's Internet Banking group cancel wrote for the joiner
      // (`group-cancel.ts`): the child's refund mirror, with no charge rows, and
      // the child's own refund note. And the organiser's own bank-transfer payment.
      await prisma.payment.create({
        data: {
          id: JOINER_PAYMENT_ID, bookingId: JOINER_BOOKING_ID, amountCents: 10_000, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED",
          refundedAmountCents: 8_000, xeroInvoiceId: "inv-race-4230-joiner",
        },
      });
      await linkCanonicalNote(JOINER_PAYMENT_ID, 8_000);
      await prisma.payment.create({
        data: { id: ORGANISER_PAYMENT_ID, bookingId: ORGANISER_BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: "inv-race-4230-organiser" },
      });
      await prisma.manualRefundTask.create({
        data: {
          id: TASK_ID, bookingId: ORGANISER_BOOKING_ID, amountCents: 8_000, raisedAmountCents: 8_000, kind: "CANCELLED_BOOKING_HAND_BACK",
          occurrenceKey: `group-organiser-hand-back:${SETTLEMENT_ID}`, reason: "race 4230 organiser hand-back",
          reviewContext: { groupOrganiserHandBack: { settlementId: SETTLEMENT_ID, shares: [{ bookingId: JOINER_BOOKING_ID, name: "Joiner", cents: 8_000 }] } },
        },
      });

      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        {
          taskId: TASK_ID, resolution: "completed", note: null, actingMemberId: OFFICER_ID,
          confirmedAmountCents: 8_000, direction: "REFUND_TO_MEMBER", recordedNightPrices: null,
        },
        CLUB_FORMAT_TEST,
      );

      // The completion wrote no payment row and queued no note: there is no cash of its own to drop.
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: TASK_ID }, select: { status: true, paymentId: true } })).toEqual({ status: "COMPLETED", paymentId: null });
      expect(await paymentState(JOINER_PAYMENT_ID)).toEqual({ refundedAmountCents: 8_000, status: "PARTIALLY_REFUNDED" });
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 0, status: "SUCCEEDED" });
      expect(await prisma.xeroSyncOperation.count({ where: { localModel: "Payment", localId: { in: PAYMENT_IDS } } })).toBe(0);

      // The joiner's refund is its own canonical note's, so the recount keeps it and alerts nothing.
      const alerts = await watchDivergenceAlerts(() => reconcileCanonicalNote(80));
      expect(await paymentState(JOINER_PAYMENT_ID)).toEqual({ refundedAmountCents: 8_000, status: "PARTIALLY_REFUNDED" });
      expect(alerts).toEqual([]);
    });

    it("the recount writes the payment's refunded total and never its charge rows: the rows stay the #4162 floor's detail (#1491)", async () => {
      await prisma.payment.create({
        data: {
          id: ORGANISER_PAYMENT_ID, bookingId: ORGANISER_BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED",
          refundedAmountCents: 10_000, xeroInvoiceId: "inv-race-4230-organiser",
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: "race-4230-txn", paymentId: ORGANISER_PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 20_000,
          refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED",
        },
      });
      await linkCanonicalNote(ORGANISER_PAYMENT_ID, 10_000);
      const rows = () => prisma.paymentTransaction.findMany({ where: { paymentId: ORGANISER_PAYMENT_ID }, select: { refundedAmountCents: true, status: true } });

      // Xero shows the note raised to $150: the recount follows it on the payment only.
      await reconcileCanonicalNote(150);
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
      expect(await rows()).toEqual([{ refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" }]);

      // Back to $100: the total comes down to Xero's figure, which the rows still hold, so no alert.
      let alerts = await watchDivergenceAlerts(() => reconcileCanonicalNote(100));
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" });
      expect(alerts).toEqual([]);

      // Below the rows' $100: kept at the rows and alerted. Had the recount
      // written the rows, the floor would have had nothing to keep.
      alerts = await watchDivergenceAlerts(() => reconcileCanonicalNote(60));
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" });
      expect(alerts).toEqual([`inbound-credit-note-repair:${CANONICAL_NOTE}`]);
      expect(await rows()).toEqual([{ refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" }]);
    });

    it("a payment whose refunds all have notes is not listed by the deploy note's query", async () => {
      await seedRefundedUnderCanonicalNote();
      expect(await deployNoteListedPaymentIds()).toEqual([]);
    });

    it("a second cancellation hand-back is queued its own note, keyed on its task - never absorbed into the canonical note (#4287)", async () => {
      await seedRefundedUnderCanonicalNote();
      await prisma.manualRefundTask.create({
        data: {
          id: TASK_ID, bookingId: ORGANISER_BOOKING_ID, paymentId: ORGANISER_PAYMENT_ID, amountCents: 3_000, raisedAmountCents: 3_000,
          kind: "CANCELLED_BOOKING_HAND_BACK", reason: "race 4230 second hand-back",
        },
      });
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        { taskId: TASK_ID, resolution: "completed", note: null, actingMemberId: OFFICER_ID, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null },
        CLUB_FORMAT_TEST,
      );
      // Paid and recorded, and queued a note of its own: keyed and sized on its task, while the
      // payment still points at its one canonical note (#4287; flipped from the #4230 pin).
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 13_000, status: "PARTIALLY_REFUNDED" });
      const [own] = await prisma.xeroSyncOperation.findMany({ where: { localModel: "Payment", localId: ORGANISER_PAYMENT_ID, entityType: "CREDIT_NOTE" }, select: { id: true, status: true, correlationKey: true, requestPayload: true } });
      expect(own).toMatchObject({ status: "PENDING", requestPayload: expect.objectContaining({ refundAmountCents: 3_000, paidAnotherWayTaskId: TASK_ID, handBackTaskId: TASK_ID }) });
      expect(own!.correlationKey).toContain(`:paid-another-way:${TASK_ID}`);
      expect(await refundNoteRows()).toBe(1);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: ORGANISER_PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } })).xeroRefundCreditNoteId).toBe(CANONICAL_NOTE);
      // The completion's own enqueue (`queueCancelledBookingHandBackNoteInTransaction`'s options), asked again: the same row.
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      expect(await enqueueXeroRefundCreditNoteOperation(ORGANISER_PAYMENT_ID, 3_000, { createdByMemberId: OFFICER_ID, refundMethod: "internet-banking", handBackTaskId: TASK_ID, paidAnotherWayTaskId: TASK_ID })).toEqual(
        expect.objectContaining({ queueOperationId: own!.id }),
      );
      expect(await refundNoteRows()).toBe(1);
      // Until that note is raised in Xero, the deploy note lists the payment and the floor's alert is true.
      expect(await deployNoteListedPaymentIds()).toEqual([ORGANISER_PAYMENT_ID]);

      const { BANK_TRANSFER_REFUND_SHORTFALL_ADVICE } = await import("@/lib/xero-inbound/credit-note-bank-transfer-floor");
      const alerts = await watchDivergenceAlertMessages(() => reconcileCanonicalNote(100));
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 13_000, status: "PARTIALLY_REFUNDED" });
      expect(alerts).toEqual([{ operation: `inbound-credit-note-repair:${CANONICAL_NOTE}`, errorMessage: expect.stringContaining(BANK_TRANSFER_REFUND_SHORTFALL_ADVICE) }]);
      expect(alerts[0]!.errorMessage).toContain(ORGANISER_PAYMENT_ID);

      // A total a release before the floor dropped stays low: the floor never raises, and the recount never adds absorbed cash.
      await prisma.payment.update({ where: { id: ORGANISER_PAYMENT_ID }, data: { refundedAmountCents: 10_000 } });
      expect(await watchDivergenceAlerts(() => reconcileCanonicalNote(100))).toEqual([]);
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" });
    });

    it("a refund request's card part on a bank transfer is queued its own note, keyed on its card refund - never absorbed into the canonical note (#4312)", async () => {
      await seedRefundedUnderCanonicalNote({ amountCents: 25_000 });
      // The #4312 cutover marker's finish: the card refund below is made after it, so it gets a note of its own.
      const { CARD_REFUND_NOTE_CUTOVER_MIGRATION } = await import("@/lib/card-refund-own-note-share");
      const [marker] = await prisma.$queryRaw<Array<{ finished_at: Date }>>`SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" = ${CARD_REFUND_NOTE_CUTOVER_MIGRATION}`;
      // An edit's card capture on the bank-transfer payment, $40 of it refunded by the approved request.
      await prisma.paymentTransaction.create({
        data: {
          id: "race-4230-card", paymentId: ORGANISER_PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: "pi_race_4230",
          amountCents: 5_000, refundedAmountCents: 4_000, status: "PARTIALLY_REFUNDED",
        },
      });
      await prisma.paymentRefund.create({
        data: {
          paymentId: ORGANISER_PAYMENT_ID, paymentTransactionId: "race-4230-card", stripeRefundId: "re_race_4230", stripePaymentIntentId: "pi_race_4230",
          amountCents: 4_000, currency: "nzd", status: "succeeded", stripeCreatedAt: new Date(marker!.finished_at.getTime() + 60_000),
        },
      });
      await prisma.payment.update({ where: { id: ORGANISER_PAYMENT_ID }, data: { refundedAmountCents: 14_000 } });
      // The approval's own call for its card part (`refund-requests/[id]`, `queueRefundRequestCardNotes`): the refund its attempt made.
      const { queueRefundRequestCardNotes } = await import("@/lib/card-refund-own-note");
      const queued = await queueRefundRequestCardNotes({
        payment: { id: ORGANISER_PAYMENT_ID, source: "INTERNET_BANKING" }, cardNoteCents: 4_000, plan: [{ madeRefundId: "re_race_4230" }], createdByMemberId: OFFICER_ID,
      });
      const [own] = await prisma.xeroSyncOperation.findMany({ where: { localModel: "Payment", localId: ORGANISER_PAYMENT_ID, entityType: "CREDIT_NOTE" }, select: { id: true, status: true, correlationKey: true, requestPayload: true } });
      expect(queued.queueOperationId).toBe(own!.id);
      expect(own).toMatchObject({ status: "PENDING", requestPayload: expect.objectContaining({ refundAmountCents: 4_000, cardRefundId: "re_race_4230", refundMethod: "card" }) });
      expect(own!.correlationKey).toContain(":card-refund:re_race_4230:");
      expect(await refundNoteRows()).toBe(1);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: ORGANISER_PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } })).xeroRefundCreditNoteId).toBe(CANONICAL_NOTE);
      // Asked again, the same row.
      expect(await queueRefundRequestCardNotes({ payment: { id: ORGANISER_PAYMENT_ID, source: "INTERNET_BANKING" }, cardNoteCents: 4_000, plan: [{ madeRefundId: "re_race_4230" }], createdByMemberId: OFFICER_ID })).toEqual({ queueOperationId: own!.id });
      expect(await refundNoteRows()).toBe(1);
      // Until that note is in Xero, the deploy note lists the payment and the floor's alert is true
      // (`xero-bt-card-refund-notes` raises it and proves every reader then counts it).
      expect(await deployNoteListedPaymentIds()).toEqual([ORGANISER_PAYMENT_ID]);
      const { BANK_TRANSFER_REFUND_SHORTFALL_ADVICE } = await import("@/lib/xero-inbound/credit-note-bank-transfer-floor");
      const alerts = await watchDivergenceAlertMessages(() => reconcileCanonicalNote(100));
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 14_000, status: "PARTIALLY_REFUNDED" });
      expect(alerts).toEqual([{ operation: `inbound-credit-note-repair:${CANONICAL_NOTE}`, errorMessage: expect.stringContaining(BANK_TRANSFER_REFUND_SHORTFALL_ADVICE) }]);
    });

    /** A link on the canonical note, as the inbound sync leaves a voided one: inactive, status VOIDED, any marker. */
    async function voidCanonicalNote(marker?: "answered") {
      await prisma.xeroObjectLink.updateMany({
        where: { localId: ORGANISER_PAYMENT_ID, xeroObjectId: CANONICAL_NOTE },
        data: {
          active: false,
          metadata: { amountCents: 10_000, status: "VOIDED", ...(marker ? { bankRefundVoid: { outcome: marker, at: "2026-06-30T00:00:00.000Z" } } : {}) },
        },
      });
    }

    it("a review's refund on a cancelled booking counts with its own note: listed only when a refund beside it has none (lens Q1)", async () => {
      await seedRefundedUnderCanonicalNote();
      // A review that refunded the member $30 on the cancelled booking, under its own keyed note (#3880).
      await prisma.manualRefundTask.create({
        data: {
          id: "race-4230-review", bookingId: ORGANISER_BOOKING_ID, paymentId: ORGANISER_PAYMENT_ID, amountCents: 3_000, raisedAmountCents: 3_000,
          kind: "EDIT_FINANCIAL_REVIEW", occurrenceKey: "edit-review:race-4230", status: "COMPLETED", settlementDirection: "REFUND_TO_MEMBER", reason: "race 4230 review",
          completedAt: new Date("2026-06-02T00:00:00.000Z"), completedByMemberId: OFFICER_ID,
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: ORGANISER_PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-race-4230-review",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 3_000, status: "AUTHORISED", perDelta: true },
        },
      });
      expect(await deployNoteListedPaymentIds()).toEqual([]);

      // A later $20 hand-back absorbed beside them: $150 paid back against $130 of notes.
      await prisma.manualRefundTask.create({
        data: {
          id: TASK_ID, bookingId: ORGANISER_BOOKING_ID, paymentId: ORGANISER_PAYMENT_ID, amountCents: 2_000, raisedAmountCents: 2_000,
          kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED", settlementDirection: "REFUND_TO_MEMBER", reason: "race 4230 absorbed",
          completedAt: new Date("2026-06-03T00:00:00.000Z"), completedByMemberId: OFFICER_ID,
        },
      });
      // Before the lens fix the review's $30 was a note with no cash beside it, so this hid the $20.
      expect(await deployNoteListedPaymentIds()).toEqual([ORGANISER_PAYMENT_ID]);
    });

    it("a void the nightly follow-up undid is not listed; re-confirmed against its fresh note it is not listed either (lens Q2)", async () => {
      await seedRefundedUnderCanonicalNote();
      await voidCanonicalNote();
      // Waiting for the follow-up: its refund still counts and no live note answers it, so it is listed (a stated limit).
      expect(await deployNoteListedPaymentIds()).toEqual([ORGANISER_PAYMENT_ID]);

      // The follow-up undid it: an open follow-up for the $100 it took back.
      const followUpId = "race-4230-void-follow-up";
      await prisma.manualRefundTask.create({
        data: {
          id: followUpId, bookingId: ORGANISER_BOOKING_ID, paymentId: ORGANISER_PAYMENT_ID, amountCents: 10_000, raisedAmountCents: 10_000,
          kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: `bank-refund-void:${ORGANISER_PAYMENT_ID}:${CANONICAL_NOTE}`, reason: "race 4230 void follow-up",
        },
      });
      expect(await deployNoteListedPaymentIds()).toEqual([]);

      // Dismissed (the transfer bounced): still not listed.
      await prisma.manualRefundTask.update({ where: { id: followUpId }, data: { status: "DISMISSED", note: "bounced", completedAt: new Date("2026-06-04T00:00:00.000Z"), completedByMemberId: OFFICER_ID } });
      expect(await deployNoteListedPaymentIds()).toEqual([]);

      // Re-confirmed instead, with its fresh note: counted once, answered once.
      await prisma.manualRefundTask.update({ where: { id: followUpId }, data: { status: "COMPLETED", note: null, settlementDirection: "REFUND_TO_MEMBER" } });
      expect(await deployNoteListedPaymentIds()).toEqual([ORGANISER_PAYMENT_ID]);
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: ORGANISER_PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-race-4230-fresh",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 10_000, status: "AUTHORISED", perDelta: true },
        },
      });
      expect(await deployNoteListedPaymentIds()).toEqual([]);
    });

    it("which void states reach the alert: none while the void waits for the follow-up or once it is undone; an answered void with its cash kept does (lens A2)", async () => {
      // $100 under the canonical note, and a later $30 hand-back under a note of its own, whose
      // reconcile recounts the payment (a voided note's own later events no longer resolve to it).
      await seedRefundedUnderCanonicalNote();
      await prisma.manualRefundTask.create({
        data: {
          id: TASK_ID, bookingId: ORGANISER_BOOKING_ID, paymentId: ORGANISER_PAYMENT_ID, amountCents: 3_000, raisedAmountCents: 3_000,
          kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED", settlementDirection: "REFUND_TO_MEMBER", reason: "race 4230 noted hand-back",
          completedAt: new Date("2026-06-03T00:00:00.000Z"), completedByMemberId: OFFICER_ID,
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: ORGANISER_PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: OTHER_NOTE, xeroObjectNumber: "CN-4230-B",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 3_000, status: "AUTHORISED", perDelta: true },
        },
      });
      const setCash = async (cents: number) => {
        const status = cents > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED";
        await prisma.paymentTransaction.update({ where: { id: "race-4230-txn" }, data: { refundedAmountCents: cents, status } });
        await prisma.payment.update({ where: { id: ORGANISER_PAYMENT_ID }, data: { refundedAmountCents: cents, status } });
      };
      await setCash(13_000);
      await voidCanonicalNote();
      const reconcileOther = () =>
        watchDivergenceAlertMessages(async () => {
          const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
          const note = { creditNoteID: OTHER_NOTE, creditNoteNumber: "CN-4230-B", status: "AUTHORISED", total: 30, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [] };
          const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
          const apiClient = await import("@/lib/xero-api-client");
          const spies = [
            vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4230" } as never),
            vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
          ];
          try {
            expect((await reconcileXeroCreditNote(OTHER_NOTE)).matchedRefundedPayments).toBe(1);
          } finally {
            for (const spy of spies) spy.mockRestore();
          }
        });

      // Waiting for the nightly follow-up: kept at the rows, logged, no alert.
      expect(await reconcileOther()).toEqual([]);
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 13_000, status: "PARTIALLY_REFUNDED" });

      // Undone by the follow-up: its task raised, the rows and total no longer hold the $100, so nothing is short.
      await prisma.manualRefundTask.create({
        data: {
          id: "race-4230-void-follow-up", bookingId: ORGANISER_BOOKING_ID, paymentId: ORGANISER_PAYMENT_ID, amountCents: 10_000, raisedAmountCents: 10_000,
          kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: `bank-refund-void:${ORGANISER_PAYMENT_ID}:${CANONICAL_NOTE}`, reason: "race 4230 void follow-up",
        },
      });
      await setCash(3_000);
      expect(await reconcileOther()).toEqual([]);
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 3_000, status: "PARTIALLY_REFUNDED" });

      // Answered on Stuck States with the cash kept (a marker, no follow-up, the rows still holding it): the
      // alert fires, and its advice says the replacement comes from that answer, never by hand.
      await prisma.manualRefundTask.delete({ where: { id: "race-4230-void-follow-up" } });
      await setCash(13_000);
      await voidCanonicalNote("answered");
      const { BANK_TRANSFER_REFUND_SHORTFALL_ADVICE } = await import("@/lib/xero-inbound/credit-note-bank-transfer-floor");
      const alerts = await reconcileOther();
      expect(alerts).toEqual([{ operation: `inbound-credit-note-repair:${OTHER_NOTE}`, errorMessage: expect.stringContaining(BANK_TRANSFER_REFUND_SHORTFALL_ADVICE) }]);
      expect(alerts[0]!.errorMessage).toContain(`Bank-transfer payment ${ORGANISER_PAYMENT_ID} on booking ${ORGANISER_BOOKING_ID}:`);
      expect(alerts[0]!.errorMessage).toContain("Found when credit note CN-4230-B changed in Xero.");
      expect(BANK_TRANSFER_REFUND_SHORTFALL_ADVICE).toContain("Never raise one by hand for a refund whose credit note was voided");
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 13_000, status: "PARTIALLY_REFUNDED" });
    });
  },
);
