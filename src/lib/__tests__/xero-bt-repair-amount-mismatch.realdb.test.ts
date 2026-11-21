/**
 * Real-PostgreSQL proof of #4328 (`INV-ADDPAY-043`, `INV-ADDPAY-047`): the
 * booking-vs-Xero repair tool judges a bank-transfer payment's refund by all of
 * its live refund notes together, never by its canonical note alone.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking; the payment and its charge rows (what an Internet
 *   Banking receipt and, later, an edit's card capture leave); each OPEN
 *   cancellation hand-back (the shape the cancel's manual branch raises).
 * - REAL: completions (`resolveManualRefundTask`); the card refund
 *   (`refundPaymentTransactions`, Stripe answered through the harness's one
 *   shared `@/lib/stripe` double) and its own note (`queueCardRefundOwnNotes`),
 *   made since the cutover marker, moved for the suite as #4312's suite moves
 *   it and put back after; every note through the outbox worker and every Xero
 *   event through the inbound reconcile, against a fake Xero transport (no
 *   provider call); the coverage reader; the repair tool with its real loader.
 *
 * Proven: a $100 canonical note, a $30 hand-back note and a $20 card-refund
 * note cover the $150 refunded, and the tool reports no amount mismatch (before
 * #4328 it compared the $150 with the $100 note). A note recorded short is one
 * manual-review mismatch naming every note, and `--apply` queues nothing.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4328-`
 * fixtures.
 */
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The shared doubles: the LAST file to register a factory wins, so every realdb file registers these same ones. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4328";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const CARD_INTENT_ID = "pi_race_4328";
const INVOICE_ID = `${P}-invoice`;
const CANONICAL_NOTE = `${P}-canonical`;
const HAND_BACK_NOTE = `${P}-hand-back-note`;
const CARD_NOTE = `${P}-card-note`;
/** The marker migration's name, read from the code in `beforeAll` (`CARD_REFUND_NOTE_CUTOVER_MIGRATION`). */
let CUTOVER_MIGRATION = "";
const LEDGER_START_MIGRATION = "20260509090000_enrich_payment_refund_ledger";
/** A day after this install's refund ledger started, so the card refund is one the ledger counts (#3640): set in `beforeAll`. */
let CUTOVER_SECONDS = 0;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let markerFinishedAt: Date | null = null;

/** Stripe's refund create, answered once per idempotency key as Stripe does, each made a minute after the cutover. */
function answerRefundsAsStripeWould() {
  const byKey = new Map<string, Stripe.Refund>();
  stripeRaceHooks.refund = async (args) => {
    const key = args.idempotencyKey ?? `${P}-${byKey.size}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: `re_race_4328_${byKey.size}`, object: "refund", amount: args.amountCents, currency: "nzd", status: "succeeded",
        reason: "requested_by_customer", created: CUTOVER_SECONDS + 60 * (byKey.size + 1), charge: "ch_race_4328",
        payment_intent: args.paymentIntentId, metadata: args.metadata ?? {},
      } as unknown as Stripe.Refund);
    }
    return byKey.get(key)!;
  };
}

(RUN ? describe : describe.skip)(
  "the repair tool judges a bank-transfer payment's refund by all its live refund notes - real PostgreSQL (#4328)",
  { timeout: 90_000 },
  () => {
    async function clearRun() {
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: OFFICER_ID }, { targetId: BOOKING_ID }, { entityId: { startsWith: P } }] } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Bank-transfer repair amount mismatch (#4328)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ CARD_REFUND_NOTE_CUTOVER_MIGRATION: CUTOVER_MIGRATION } = await import("@/lib/card-refund-own-note-share"));
      await deleteFixtures();
      const [marker] = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" = ${CUTOVER_MIGRATION}`;
      const [ledgerStart] = await prisma.$queryRaw<Array<{ finished_at: Date }>>`SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" = ${LEDGER_START_MIGRATION}`;
      expect(marker).toBeDefined();
      markerFinishedAt = marker!.finished_at;
      CUTOVER_SECONDS = Math.floor(ledgerStart!.finished_at.getTime() / 1000) + 86_400;
      await prisma.$executeRaw`UPDATE "_prisma_migrations" SET "finished_at" = ${new Date(CUTOVER_SECONDS * 1000)} WHERE "migration_name" = ${CUTOVER_MIGRATION}`;
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Several", lastName: "Notes", role, ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4328 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 25_000, finalPriceCents: 25_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
    }, 120_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
      await clearRun();
      answerRefundsAsStripeWould();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
      await prisma.$executeRaw`UPDATE "_prisma_migrations" SET "finished_at" = ${markerFinishedAt} WHERE "migration_name" = ${CUTOVER_MIGRATION}`;
    }, 60_000);

    async function handBack(id: string, cents: number) {
      await prisma.manualRefundTask.create({
        data: { id, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: cents, raisedAmountCents: cents, kind: "CANCELLED_BOOKING_HAND_BACK", reason: `${P} hand-back` },
      });
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        { taskId: id, resolution: "completed", note: null, actingMemberId: OFFICER_ID, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null },
        CLUB_FORMAT_TEST,
      );
    }

    /** The refund-note rows on the payment, oldest first: amount asked, and the records it names. */
    async function noteRows() {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, status: true, correlationKey: true, requestPayload: true },
      });
      const { parsePaymentCreditNoteRetryInput } = await import("@/lib/xero-payment-credit-note-payload");
      return rows.map((row) => {
        const recorded = parsePaymentCreditNoteRetryInput(row);
        return { id: row.id, cents: recorded?.amountCents, handBackTaskId: recorded?.handBackTaskId ?? null, cardRefundId: recorded?.cardRefundId ?? null };
      });
    }

    /** The outbox worker for one queued note, then Xero's event for it reconciled - both against a fake Xero. */
    async function raiseAndReconcile(operationId: string, noteId: string, cents: number) {
      const note = { creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, status: "AUTHORISED", total: cents / 100, appliedAmount: 0, remainingCredit: cents / 100, allocations: [], payments: [] };
      const sent: number[] = [];
      const xero = {
        accountingApi: {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }) => {
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            sent.push(Math.round(total * 100));
            return { body: { creditNotes: [{ ...note, total }] } };
          },
          getCreditNote: async () => ({ body: { creditNotes: [note] } }),
        },
      };
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      const alerting = await import("@/lib/xero-error-alert");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4328" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-4328"),
        vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (opts: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
          opts.run({ contactId: opts.currentContactId })) as never),
        vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: P }),
        vi.spyOn(alerting, "notifyXeroSyncError").mockResolvedValue(undefined as never),
      ];
      try {
        // Oldest first is the worker's order: this row goes first, alone.
        await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${operationId}`;
        const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
        await processQueuedXeroOutboxOperations({ limit: 1 });
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
        await reconcileXeroCreditNote(noteId);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      expect(sent).toEqual([cents]);
    }

    /** The payment's refunded total and what its live refund notes cover, through the one coverage reader. */
    async function refundedAndCovered() {
      const { readRefundCreditNoteGap } = await import("@/lib/xero-admin-health");
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { id: true, bookingId: true, refundedAmountCents: true } });
      return { refundedCents: payment.refundedAmountCents, coveredCents: (await readRefundCreditNoteGap(payment)).coveredCents };
    }

    async function repairTool(apply = false) {
      const { runBookingXeroRepair } = await import("@/lib/xero-booking-repair");
      const booking = (await runBookingXeroRepair(CLUB_FORMAT_TEST, { scope: { bookingId: BOOKING_ID }, apply })).passes[0]!.bookings[0]!;
      return {
        mismatches: booking.findings.filter((finding) => finding.code === "XERO_AMOUNT_MISMATCH"),
        queued: booking.actions.filter((action) => action.type === "QUEUE_REFUND_CREDIT_NOTE"),
      };
    }

    it("a canonical note, a later hand-back's note and a card refund's note together answer the refund: no mismatch; one recorded short is a person's to check, and --apply queues nothing", async () => {
      // A $200 Internet Banking receipt; the cancellation's first $100 hand-back becomes the payment's canonical note.
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
      });
      await prisma.paymentTransaction.create({
        data: { id: `${P}-bank-txn`, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 20_000, status: "SUCCEEDED" },
      });
      await handBack(`${P}-first`, 10_000);
      const [first] = await noteRows();
      await raiseAndReconcile(first!.id, CANONICAL_NOTE, 10_000);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } })).xeroRefundCreditNoteId).toBe(CANONICAL_NOTE);

      // An edit's $50 card capture on it, then a second $30 hand-back: its own note (#4287).
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { amountCents: 25_000 } });
      await prisma.paymentTransaction.create({
        data: { id: `${P}-card-txn`, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: CARD_INTENT_ID, amountCents: 5_000, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
      });
      await handBack(`${P}-second`, 3_000);
      const second = (await noteRows()).find((row) => row.handBackTaskId === `${P}-second`);
      expect(second).toMatchObject({ cents: 3_000 });
      await raiseAndReconcile(second!.id, HAND_BACK_NOTE, 3_000);

      // A $20 card refund of the capture, since the cutover: its own note (#4312).
      const { refundPaymentTransactions } = await import("@/lib/payment-transactions");
      await refundPaymentTransactions({ paymentId: PAYMENT_ID, amountCents: 2_000, idempotencyKeyPrefix: `${P}-card`, format: CLUB_FORMAT_TEST });
      const [cardRefund] = await prisma.paymentRefund.findMany({ where: { paymentId: PAYMENT_ID }, select: { stripeRefundId: true } });
      const { queueCardRefundOwnNotes } = await import("@/lib/card-refund-own-note");
      await queueCardRefundOwnNotes({ paymentId: PAYMENT_ID, stripeRefundIds: [cardRefund!.stripeRefundId] });
      const card = (await noteRows()).find((row) => row.cardRefundId === cardRefund!.stripeRefundId);
      expect(card).toMatchObject({ cents: 2_000 });
      await raiseAndReconcile(card!.id, CARD_NOTE, 2_000);

      const links = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE", active: true },
        select: { xeroObjectId: true, metadata: true },
        orderBy: { xeroObjectId: "asc" },
      });
      expect(links.map((link) => [link.xeroObjectId, (link.metadata as { perDelta?: boolean }).perDelta ?? false])).toEqual([
        [CANONICAL_NOTE, false],
        [CARD_NOTE, true],
        [HAND_BACK_NOTE, true],
      ]);
      expect(await refundedAndCovered()).toEqual({ refundedCents: 15_000, coveredCents: 15_000 });

      // Before #4328: one mismatch - the $150 refunded against the $100 canonical note.
      expect(await repairTool()).toEqual({ mismatches: [], queued: [] });

      // The hand-back's note recorded $10 short: the notes no longer answer the refund.
      const handBackLink = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: HAND_BACK_NOTE }, select: { id: true, metadata: true } });
      await prisma.xeroObjectLink.update({ where: { id: handBackLink.id }, data: { metadata: { ...(handBackLink.metadata as Record<string, unknown>), amountCents: 2_000 } } });
      try {
        expect(await refundedAndCovered()).toEqual({ refundedCents: 15_000, coveredCents: 14_000 });
        const { mismatches, queued } = await repairTool();
        expect(queued).toEqual([]);
        expect(mismatches).toEqual([
          expect.objectContaining({
            severity: "manual_review",
            safeToAutoApply: false,
            details: expect.objectContaining({
              paymentId: PAYMENT_ID,
              expectedAmountCents: 15_000,
              coveredCents: 14_000,
              canonicalCreditNoteId: CANONICAL_NOTE,
              otherRefundNotes: expect.arrayContaining([
                { creditNoteId: HAND_BACK_NOTE, amountCents: 2_000 },
                { creditNoteId: CARD_NOTE, amountCents: 2_000 },
              ]),
            }),
          }),
        ]);
        expect(mismatches[0]!.actions.map((action) => action.type)).toEqual(["MARK_MANUAL_REVIEW"]);

        // --apply with no action confirmed raises nothing: no note row is added.
        const before = (await noteRows()).length;
        await repairTool(true);
        expect(await noteRows()).toHaveLength(before);
      } finally {
        await prisma.xeroObjectLink.update({ where: { id: handBackLink.id }, data: { metadata: handBackLink.metadata as object } });
      }
      expect(await repairTool()).toEqual({ mismatches: [], queued: [] });
    });
  },
);
