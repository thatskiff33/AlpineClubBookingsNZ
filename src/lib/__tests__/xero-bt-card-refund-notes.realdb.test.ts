/**
 * Real-PostgreSQL proofs for #4312 (owner decision 24 Oct 2026,
 * `INV-ADDPAY-047`): on a bank-transfer payment, each card refund gets its own
 * Xero credit note, keyed on its `PaymentRefund` row (`cardRefundId`) and
 * sized at its amount - never folded into the payment's canonical note - and
 * only for a refund Stripe made since the cutover marker.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking; the payment and its charge rows (what an Internet
 *   Banking receipt and an edit's card capture leave); each OPEN cancellation
 *   hand-back (the shape the cancel's manual branch raises); each PENDING
 *   refund request (the member's request route writes exactly that row); a
 *   late capture's held approval task, DISMISSED as a treasurer keeping the
 *   money leaves it (`late-capture-refund-hold.ts`, then the dismissal), with
 *   the kept-capture invoice's link its worker writes once Xero has it
 *   (`createXeroKeptLateCaptureInvoice`); and, as an older release's
 *   `charge.refunded` sync left them, refund rows made before the cutover.
 *   The cutover is the marker migration's own `_prisma_migrations` row, moved
 *   to a fixed instant for the suite and put back after.
 * - REAL: completions (`resolveManualRefundTask`); the refund request's
 *   approval (`PUT /api/admin/refund-requests/[id]`, the session guard and the
 *   member email doubled); the recovery replay (`runPaymentRecoveryOperationNow`);
 *   `charge.refunded` (`processStripeWebhookEvent`); every Stripe refund and
 *   refund list through the harness's one shared `@/lib/stripe` double,
 *   answered as Stripe answers; every note through the outbox worker and every
 *   Xero event through the inbound reconcile, against a fake Xero transport (no
 *   provider call); the nightly void follow-up (`followUpVoidedBankRefundNote`).
 *
 * Proven, per writer: one note per card refund at its amount, no absorption,
 * the payment's canonical pointer untouched; the coverage and gap readers show
 * nothing uncovered, the #4162 floor raises no alert, the #4230 deploy note
 * lists nothing, and the hand-back cash reader (#4314) neither counts nor is
 * squeezed by these notes. A refund made before the cutover is never given a
 * note; two writers asking for one refund at once raise one row; a voided card
 * note is never matched to a bank refund and undone.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4312-`
 * fixtures.
 */
import { NextRequest } from "next/server";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { raceSession } from "@/lib/__tests__/support/race-session-double";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The shared doubles: the LAST file to register a factory wins, so every realdb file registers these same ones. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4312";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const BANK_TXN_ID = `${P}-bank-txn`;
const CARD_TXN_ID = `${P}-card-txn`;
const CARD2_TXN_ID = `${P}-card2-txn`;
const CARD_INTENT_ID = "pi_race_4312";
const CHARGE_ID = "ch_race_4312";
const INVOICE_ID = `${P}-invoice`;
/** The marker migration's name, read from the code in `beforeAll` (`CARD_REFUND_NOTE_CUTOVER_MIGRATION`). */
let CUTOVER_MIGRATION = "";
const LEDGER_START_MIGRATION = "20260509090000_enrich_payment_refund_ledger";
/** A day after this install's refund ledger started, so every refund here is one the ledger counts (#3640): set in `beforeAll`. */
let CUTOVER_SECONDS = 0;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let markerFinishedAt: Date | null = null;
let eventSequence = 0;

/** Stripe's refunds as it holds them: one per idempotency key, listed per charge. Each made since the cutover unless dated. */
const stripe = {
  createdSeconds: 0, byKey: new Map<string, Stripe.Refund>(), failNext: 0, refuseOn: null as string | null,
  /** Stripe's answer to a refund it makes: `pending` is what a card refund Stripe can fail later is first answered (#4104). */
  answer: "succeeded",
  /** Stripe makes the next refund, and its answer never reaches the caller (a timeout after the request landed). */
  lostAnswers: 0,
  /**
   * #4312 round 6: the app's clock runs with Stripe's - each refund Stripe makes moves the frozen test clock to just
   * after it - so a row raised, closed or failed after a refund is dated after it, as in production.
   */
  tracksAppClock: false,
};
/** Stripe's clock moves on a minute and makes a refund then; the app's clock follows it when it tracks Stripe's. */
function nextStripeSecond(): number {
  stripe.createdSeconds += 60;
  if (stripe.tracksAppClock) vi.setSystemTime((stripe.createdSeconds + 1) * 1_000);
  return stripe.createdSeconds;
}
function stripeRefund(id: string, amount: number, metadata: Record<string, string>, created: number, status = "succeeded"): Stripe.Refund {
  return {
    id, object: "refund", amount, currency: "nzd", status, reason: "requested_by_customer", created,
    charge: CHARGE_ID, payment_intent: CARD_INTENT_ID, metadata,
  } as unknown as Stripe.Refund;
}
function answerRefundsAsStripeWould() {
  stripeRaceHooks.refund = async (args) => {
    if (stripe.failNext > 0) {
      stripe.failNext -= 1;
      throw new Error("Stripe is unreachable (race-4312)");
    }
    const key = args.idempotencyKey ?? `${P}-${stripe.byKey.size}`;
    if (!stripe.byKey.has(key)) {
      const created = nextStripeSecond();
      // A slice on the charge `refuseOn` names is answered refused (`failed`), as Stripe refuses one.
      const status = stripe.refuseOn !== null && key.includes(stripe.refuseOn) ? "failed" : stripe.answer;
      stripe.byKey.set(key, stripeRefund(`re_race_4312_${stripe.byKey.size}`, args.amountCents, args.metadata ?? {}, created, status));
      if (stripe.lostAnswers > 0) {
        stripe.lostAnswers -= 1;
        throw new Error("Stripe timed out after making the refund (race-4312)");
      }
    }
    return stripe.byKey.get(key)!;
  };
  stripeRaceHooks.listChargeRefunds = async () => [...stripe.byKey.values()];
}

(RUN ? describe : describe.skip)(
  "a card refund on a bank-transfer payment gets its own Xero credit note - real PostgreSQL (#4312)",
  { timeout: 90_000 },
  () => {
    async function clearRun() {
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_4312_" } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_4312_" } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [PAYMENT_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localModel: "ManualRefundTask", localId: { startsWith: P } } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.refundRequest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: OFFICER_ID }, { targetId: BOOKING_ID }, { entityId: { startsWith: P } }] } });
      stripe.byKey.clear();
      stripe.failNext = 0;
      stripe.refuseOn = null;
      stripe.answer = "succeeded";
      stripe.lostAnswers = 0;
      stripe.tracksAppClock = false;
      stripe.createdSeconds = CUTOVER_SECONDS;
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Bank-transfer card refund notes (#4312)");
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
          // The officer signs in (`canLogin`) and holds the admin access role, as the approval's real guard requires.
          data: {
            id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Card", lastName: "Refund", role, ageTier: "ADULT", canLogin: role === "ADMIN",
            accessRoles: { create: { role: role === "ADMIN" ? "ADMIN" : "USER" } },
          },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4312 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 25_000, finalPriceCents: 25_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
    }, 120_000); // cold import of the route and webhook module graphs

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

    /** A $200 Internet Banking receipt and (unless `bankOnly`) an edit's $50 card capture on it: what the receipt and capture writers leave. */
    async function paid({ bankOnly = false }: { bankOnly?: boolean } = {}) {
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: bankOnly ? 20_000 : 25_000, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
      });
      await prisma.paymentTransaction.create({
        data: { id: BANK_TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 20_000, status: "SUCCEEDED" },
      });
      if (bankOnly) return;
      await prisma.paymentTransaction.create({
        // Captured before the receipt was recorded, so a hand-back's allocation (newest first) takes the bank row.
        data: { id: CARD_TXN_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: CARD_INTENT_ID, amountCents: 5_000, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
      });
    }

    /**
     * A $50 card payment (an edit's request) captured after the booking was cancelled, as the late-capture handler records it
     * (its transaction row, `CANCELLED_BOOKING_LATE_CAPTURE_REASON`), held for the treasurer who kept the
     * money (`late-capture-refund-hold.ts`, then the dismissal), its kept-capture invoice in Xero as the
     * invoice's worker links it (`createXeroKeptLateCaptureInvoice`).
     */
    async function lateCaptureKept() {
      const { CANCELLED_BOOKING_LATE_CAPTURE_REASON } = await import("@/lib/cancellation-settled-money");
      const { KEPT_LATE_CAPTURE_INVOICE_ROLE } = await import("@/lib/late-capture-kept-xero-rules");
      await prisma.paymentTransaction.create({
        // An edit's card request the member paid after the cancel: on a bank transfer it is never the PRIMARY row.
        data: { id: CARD_TXN_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: CARD_INTENT_ID, amountCents: 5_000, status: "SUCCEEDED", reason: CANCELLED_BOOKING_LATE_CAPTURE_REASON },
      });
      const task = await prisma.manualRefundTask.create({
        data: {
          id: `${P}-late-task`, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: 5_000, raisedAmountCents: 5_000, kind: "DELETED_BOOKING_LATE_CAPTURE",
          lateCaptureApprovalIntentId: CARD_INTENT_ID, reason: `${P} held late capture`, status: "DISMISSED",
        },
      });
      await prisma.xeroObjectLink.create({ data: { localModel: "ManualRefundTask", localId: task.id, xeroObjectType: "INVOICE", xeroObjectId: `${P}-kept-invoice`, role: KEPT_LATE_CAPTURE_INVOICE_ROLE } });
    }

    /** What a completion before #4287 left when its note was absorbed: the task, its allocation and ledger line, and no note of its own. */
    async function absorbedHandBack(cents: number) {
      const id = `${P}-absorbed`;
      const { applyLocalRefundAllocation } = await import("@/lib/payment-transactions");
      const { postHandBackLedgerLine } = await import("@/lib/booking-ledger-hand-back");
      await prisma.$transaction(async (tx) => {
        await tx.manualRefundTask.create({
          data: {
            id, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: cents, raisedAmountCents: cents, kind: "CANCELLED_BOOKING_HAND_BACK",
            status: "COMPLETED", completedAt: new Date("2026-06-01T00:00:00.000Z"), completedByMemberId: OFFICER_ID, settlementDirection: "REFUND_TO_MEMBER", reason: `${P} absorbed`,
          },
        });
        await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: cents, store: tx });
        await postHandBackLedgerLine({
          bookingId: BOOKING_ID, lodgeId: LODGE_ID, manualRefundTaskId: id, amountCents: cents, refundMethod: "internet-banking",
          paymentSource: "INTERNET_BANKING", officerMemberId: OFFICER_ID, store: tx,
        });
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

    /** The refund-note rows on the payment, oldest first: amount asked, the record it names, its key. */
    async function noteRows() {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, status: true, correlationKey: true, requestPayload: true },
      });
      const { parsePaymentCreditNoteRetryInput } = await import("@/lib/xero-payment-credit-note-payload");
      return rows.map((row) => {
        const recorded = parsePaymentCreditNoteRetryInput(row);
        return {
          id: row.id, status: row.status, cents: recorded?.amountCents, cardRefundId: recorded?.cardRefundId ?? null,
          ownRecord: recorded?.paidAnotherWayTaskId ?? null, paymentIntentId: recorded?.paymentIntentId ?? null, key: row.correlationKey,
        };
      });
    }

    /** The outbox worker for one queued note, against a fake Xero. Returns what Xero was asked to raise, and the invoice it credits. */
    async function raiseQueuedNote(operationId: string, noteId: string) {
      const sent = await withFakeXero(noteId, async () => {
        // Oldest first is the worker's order: this row goes first, alone.
        await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${operationId}`;
        const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
        await processQueuedXeroOutboxOperations({ limit: 1 });
      });
      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true, requestPayload: true } });
      expect(row.status).toBe("SUCCEEDED");
      return sent;
    }

    /** The outbox worker for one queued note, against a Xero that times out after the call went: the row fails with its outcome unknown. */
    async function failQueuedNote(operationId: string) {
      await withFakeXero(null, async () => {
        await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${operationId}`;
        const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
        await processQueuedXeroOutboxOperations({ limit: 1 });
      });
      expect((await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true } })).status).toBe("FAILED");
    }

    /** An officer's Retry on a failed note (`retryXeroSyncOperation`), against a fake Xero: what Xero was asked to raise. */
    async function retryNote(operationId: string, noteId: string) {
      return withFakeXero(noteId, async () => {
        const { retryXeroSyncOperation } = await import("@/lib/xero-operation-retry");
        await retryXeroSyncOperation(operationId, CLUB_FORMAT_TEST, { createdByMemberId: OFFICER_ID });
      });
    }

    /** Runs `run` against a fake Xero that raises `noteId` for each credit note asked for, or (null) times out on it. */
    async function withFakeXero(noteId: string | null, run: () => Promise<void>): Promise<number[]> {
      const sent: number[] = [];
      const xero = {
        accountingApi: {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }) => {
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            if (noteId === null) throw Object.assign(new Error("Xero timed out (race-4312)"), { response: { statusCode: 504 } });
            sent.push(Math.round(total * 100));
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
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4312" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-4312"),
        vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (opts: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
          opts.run({ contactId: opts.currentContactId })) as never),
        vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: P }),
      ];
      try {
        await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return sent;
    }

    /** The inbound reconcile of one note, read from a fake Xero, and the refund-ledger divergence alerts it raised. */
    async function reconcile(noteId: string, cents: number, status = "AUTHORISED"): Promise<string[]> {
      const note = { creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, status, total: cents / 100, appliedAmount: 0, remainingCredit: cents / 100, allocations: [], payments: [] };
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const alerting = await import("@/lib/xero-error-alert");
      const alertSpy = vi.spyOn(alerting, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4312" } as never),
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

    /**
     * The UPGRADING switch-window query (#4312), run as an operator would, with its timestamp set to
     * when this version began serving alone (written in UTC, `+00`) and in a session of that time zone
     * (the shipped compose file sets the club's on PostgreSQL): the note rows it lists, refund and note id.
     */
    async function switchWindowListed(servingAloneAt: Date, timeZone = "UTC"): Promise<Array<{ stripeRefundId: string; operationId: string | null; creditNoteId: string | null }>> {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const doc = readFileSync(resolve(__dirname, "../../../docs/UPGRADING.md"), "utf8");
      const sql = /```sql\n([\s\S]*?)\n```/.exec(doc.slice(doc.indexOf("**Card refunds made in the switch window (#4312).**")))?.[1];
      expect(sql).toBeDefined();
      const at = servingAloneAt.toISOString().replace("T", " ").replace("Z", "+00");
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${timeZone}'`);
        return tx.$queryRawUnsafe<Array<{ paymentId: string; stripeRefundId: string; operationId: string | null; creditNoteId: string | null }>>(
          sql!.replace(/TIMESTAMPTZ '[^']*'/, `TIMESTAMPTZ '${at}'`),
        );
      });
      return rows.filter((row) => row.paymentId === PAYMENT_ID).map(({ stripeRefundId, operationId, creditNoteId }) => ({ stripeRefundId, operationId, creditNoteId }));
    }

    /** What the coverage, gap and hand-back cash readers report, and the payment's refunded total against its charge rows. */
    async function readers() {
      const { readResolvedRefundCreditNoteCoverage, sumRefundCreditNoteCoverageCents } = await import("@/lib/xero-resolved-in-xero-fences");
      const { readRefundCreditNoteGap } = await import("@/lib/xero-admin-health");
      const { readPaidAnotherWayCash } = await import("@/lib/card-refund-paid-another-way-cash");
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { id: true, bookingId: true, refundedAmountCents: true } });
      const rows = await prisma.paymentTransaction.aggregate({ where: { paymentId: PAYMENT_ID }, _sum: { refundedAmountCents: true } });
      return {
        refundedCents: payment.refundedAmountCents,
        rowsCents: rows._sum.refundedAmountCents ?? 0,
        coveredCents: await sumRefundCreditNoteCoverageCents(PAYMENT_ID, await readResolvedRefundCreditNoteCoverage(PAYMENT_ID)),
        uncoveredCents: (await readRefundCreditNoteGap(payment)).uncoveredCents,
        notedBankCents: (await readPaidAnotherWayCash(prisma, PAYMENT_ID)).notedCents,
      };
    }

    async function canonicalPointer() {
      return (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } })).xeroRefundCreditNoteId;
    }

    /** The first hand-back ($100), completed and noted through the real writers. On a payment holding card money it takes its own route (#4287). */
    async function firstHandBackNoted() {
      const id = `${P}-hand-back`;
      await prisma.manualRefundTask.create({
        data: { id, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: 10_000, raisedAmountCents: 10_000, kind: "CANCELLED_BOOKING_HAND_BACK", reason: `${P} hand-back` },
      });
      await complete(id);
      const [row] = await noteRows();
      expect(await raiseQueuedNote(row!.id, `${P}-hand-back-note`)).toEqual([10_000]);
      expect(await reconcile(`${P}-hand-back-note`, 10_000)).toEqual([]);
      return id;
    }

    /** A canonical note on the payment, as the cancel's card branch queues one (`booking-cancel.ts`, no keyed options) for a $10 card refund: the note a later card refund used to fold into. */
    async function canonicalCardNote() {
      const { refundPaymentTransactions } = await import("@/lib/payment-transactions");
      const { buildBookingCancellationRefundMetadata } = await import("@/lib/payment-recovery-keys");
      await refundPaymentTransactions({ paymentId: PAYMENT_ID, amountCents: 1_000, metadata: buildBookingCancellationRefundMetadata(BOOKING_ID), idempotencyKeyPrefix: `booking_cancel_refund_${BOOKING_ID}`, format: CLUB_FORMAT_TEST });
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 1_000, { createdByMemberId: OFFICER_ID });
      expect(await raiseQueuedNote(queued.queueOperationId!, `${P}-canonical`)).toEqual([1_000]);
      expect(await reconcile(`${P}-canonical`, 1_000)).toEqual([]);
      expect(await canonicalPointer()).toBe(`${P}-canonical`);
    }

    /** A PENDING refund request on the booking, as the member's request route writes it. */
    async function requestRefund(id: string, cents: number) {
      await prisma.refundRequest.create({ data: { id, bookingId: BOOKING_ID, memberId: MEMBER_ID, reason: `${P} please`, requestedAmountCents: cents } });
      return id;
    }

    /** The officer approves it: the real route and its real admin guard, under the officer's session (the harness's one `@/lib/auth` double, `race-session-double.ts`). */
    async function approve(requestId: string, cents: number) {
      const email = await import("@/lib/email");
      const spies = [vi.spyOn(email, "sendEmail").mockResolvedValue(undefined as never)];
      raceSession.current = { user: { id: OFFICER_ID, role: "ADMIN" } };
      try {
        const { PUT } = await import("@/app/api/admin/refund-requests/[id]/route");
        const response = await PUT(
          new NextRequest(`http://localhost/api/admin/refund-requests/${requestId}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "APPROVED", approvedAmountCents: cents, notifyMember: false }),
          }),
          { params: Promise.resolve({ id: requestId }) },
        );
        expect({ status: response.status, body: response.status === 200 ? null : await response.json() }).toEqual({ status: 200, body: null });
      } finally {
        raceSession.current = null;
        for (const spy of spies) spy.mockRestore();
      }
    }

    /** Stripe's `charge.refunded` for the card capture - the real webhook processor, Stripe listing every refund it holds. */
    async function deliverChargeRefunded() {
      eventSequence += 1;
      const refunds = [...stripe.byKey.values()];
      const event = {
        id: `evt_race_4312_${eventSequence}`, object: "event", type: "charge.refunded", request: null,
        data: { object: { id: CHARGE_ID, object: "charge", payment_intent: CARD_INTENT_ID, amount_refunded: refunds.reduce((sum, refund) => sum + refund.amount, 0), refunds: { data: refunds } } },
      } as unknown as Stripe.Event;
      const webhook = await import("@/lib/stripe-webhook-service");
      return webhook.processStripeWebhookEvent(event);
    }

    /** A refund made in the Stripe dashboard: Stripe holds it; nothing in the app has recorded it yet. */
    function refundInDashboard(cents: number, created = nextStripeSecond()) {
      const refund = stripeRefund(`re_race_4312_dashboard_${stripe.byKey.size}`, cents, {}, created);
      stripe.byKey.set(`dashboard-${stripe.byKey.size}`, refund);
      return refund.id;
    }

    /**
     * A refund of the late capture made before the cutover, as an older release's `charge.refunded`
     * left it: recorded by the ledger's one sync (`syncRefundsFromStripeCharge`), with no note of its own.
     */
    async function olderReleaseRecordedLateRefund() {
      const older = stripeRefund("re_race_4312_late_older", 800, {}, CUTOVER_SECONDS - 3_600);
      stripe.byKey.set("older", older);
      const { syncRefundsFromStripeCharge } = await import("@/lib/payment-transactions");
      await syncRefundsFromStripeCharge({ paymentIntentId: CARD_INTENT_ID, stripeChargeId: CHARGE_ID, refundedAmountCents: 800, refunds: [older] });
    }

    async function cardRefundIds() {
      return (await prisma.paymentRefund.findMany({ where: { paymentId: PAYMENT_ID }, orderBy: [{ stripeCreatedAt: "asc" }], select: { stripeRefundId: true, amountCents: true } }));
    }

    it("a refund request's card part: the approval notes each refund it made on its own record, never folded into the canonical note", async () => {
      await paid();
      await firstHandBackNoted();
      await canonicalCardNote();
      const request = await requestRefund(`${P}-request`, 4_000);
      await approve(request, 4_000);

      const [, , own, ...rest] = await noteRows();
      expect(rest).toEqual([]);
      const refund = (await cardRefundIds()).find((row) => row.amountCents === 4_000)!;
      expect(own).toMatchObject({ status: "PENDING", cents: 4_000, cardRefundId: refund.stripeRefundId, ownRecord: null });
      expect(own!.key).toContain(`:card-refund:${refund.stripeRefundId}:0:v3`);
      // Queued with no watermark: a previous release's worker (the switch window, a rollback) runs it as the one note it would fold into.
      const queuedPayload = (await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: own!.id }, select: { requestPayload: true } })).requestPayload as Record<string, unknown>;
      expect(queuedPayload).not.toHaveProperty("watermarkCents");
      expect(await raiseQueuedNote(own!.id, `${P}-request-note`)).toEqual([4_000]);
      expect(await reconcile(`${P}-request-note`, 4_000)).toEqual([]);

      // A per-refund link beside the canonical note, which keeps the payment's pointer.
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-request-note` }, select: { metadata: true } });
      expect((link.metadata as { perDelta?: boolean }).perDelta).toBe(true);
      expect(await canonicalPointer()).toBe(`${P}-canonical`);
      // Every reader counts it through its link; the hand-back cash reader counts the hand-back alone.
      expect(await readers()).toEqual({ refundedCents: 15_000, rowsCents: 15_000, coveredCents: 15_000, uncoveredCents: 0, notedBankCents: 10_000 });
      expect(await reconcile(`${P}-canonical`, 1_000)).toEqual([]);
      expect(await reconcile(`${P}-hand-back-note`, 10_000)).toEqual([]);
      expect(await deployNoteLists()).toBe(false);

      // The same refund asked for again - its webhook, or a replay - is the same row or nothing, never a second note.
      const { queueCardRefundOwnNotes } = await import("@/lib/card-refund-own-note");
      expect(await queueCardRefundOwnNotes({ paymentId: PAYMENT_ID, stripeRefundIds: [refund.stripeRefundId] })).toEqual([]);
      await deliverChargeRefunded();
      expect(await noteRows()).toHaveLength(3);
    });

    it("a refund request's card part the recovery queue makes later: the replay notes the refund it records, which did not exist at approval", async () => {
      await paid();
      await canonicalCardNote();
      const request = await requestRefund(`${P}-recovered`, 3_000);
      stripe.failNext = 1;
      await approve(request, 3_000);
      // Nothing was refunded and nothing is noted: the card part waits on the recovery row, marked as noting each refund.
      expect(await noteRows()).toHaveLength(1);
      const operation = await prisma.paymentRecoveryOperation.findFirstOrThrow({ where: { bookingId: BOOKING_ID }, select: { id: true, stripeKeyPrefix: true } });
      expect(operation.stripeKeyPrefix).toBe(`refund_request_${request}`);

      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      const refund = (await cardRefundIds()).find((row) => row.amountCents === 3_000)!;
      const [, own] = await noteRows();
      expect(own).toMatchObject({ cents: 3_000, cardRefundId: refund.stripeRefundId });
      expect(await raiseQueuedNote(own!.id, `${P}-recovered-note`)).toEqual([3_000]);
      expect(await reconcile(`${P}-recovered-note`, 3_000)).toEqual([]);
      expect(await readers()).toMatchObject({ refundedCents: 4_000, rowsCents: 4_000, coveredCents: 4_000, uncoveredCents: 0 });
      expect(await deployNoteLists()).toBe(false);
    });

    it("a replay whose second slice Stripe refuses still notes the slice it made, on that very attempt", async () => {
      await paid();
      // A second $40 card capture on the payment (a later edit's), so the request's card refund plans two slices.
      await prisma.paymentTransaction.create({
        data: { id: CARD2_TXN_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: "pi_race_4312_second", amountCents: 4_000, status: "SUCCEEDED", createdAt: new Date("2026-06-02T00:00:00.000Z") },
      });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { amountCents: 29_000 } });
      const request = await requestRefund(`${P}-two-slices`, 6_000);
      stripe.failNext = 1;
      await approve(request, 6_000);
      const operation = await prisma.paymentRecoveryOperation.findFirstOrThrow({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      expect(await noteRows()).toEqual([]);

      // The replay: the newer capture's $40 slice is made; Stripe refuses the older capture's $20 slice.
      stripe.refuseOn = CARD_TXN_ID;
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("failed");
      const made = (await prisma.paymentRefund.findMany({ where: { paymentId: PAYMENT_ID, status: "succeeded" }, select: { stripeRefundId: true, amountCents: true } }));
      expect(made.map((refund) => refund.amountCents)).toEqual([4_000]);
      expect((await noteRows()).map((row) => [row.cents, row.cardRefundId])).toEqual([[4_000, made[0]!.stripeRefundId]]);
    });

    it("while the cutover marker has not finished, an approval takes the one note for its card part, as before, and marks no recovery row", async () => {
      await paid();
      await prisma.$executeRaw`UPDATE "_prisma_migrations" SET "rolled_back_at" = ${new Date()} WHERE "migration_name" = ${CUTOVER_MIGRATION}`;
      try {
        const request = await requestRefund(`${P}-no-marker`, 3_000);
        stripe.failNext = 1;
        await approve(request, 3_000);
        // The card part went to the recovery queue: its one note was queued at approval, for all of it, and the row is unmarked.
        expect((await noteRows()).map((row) => [row.cents, row.cardRefundId])).toEqual([[3_000, null]]);
        const operation = await prisma.paymentRecoveryOperation.findFirstOrThrow({ where: { bookingId: BOOKING_ID }, select: { stripeKeyPrefix: true } });
        expect(operation.stripeKeyPrefix).toBeNull();
      } finally {
        await prisma.$executeRaw`UPDATE "_prisma_migrations" SET "rolled_back_at" = NULL WHERE "migration_name" = ${CUTOVER_MIGRATION}`;
      }
    });

    it("a recovery row an older approval wrote (no marker: that approval noted the card part itself) raises no note of its own on replay", async () => {
      await paid();
      await canonicalCardNote();
      const request = await requestRefund(`${P}-older`, 2_000);
      await prisma.refundRequest.update({ where: { id: request }, data: { status: "APPROVED", approvedAmountCents: 2_000, reviewedBy: OFFICER_ID, reviewedAt: new Date("2026-06-01T00:00:00.000Z") } });
      // The older release's call: the same enqueue, with no `notesEachRefund`.
      const { enqueueRefundRequestRefundRecovery, runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      const { planStripeRefundAllocation } = await import("@/lib/payment-transactions");
      const plan = await planStripeRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 2_000 });
      await enqueueRefundRequestRefundRecovery({ bookingId: BOOKING_ID, paymentId: PAYMENT_ID, refundRequestId: request, amountCents: 2_000, allocationPlan: plan.slices });
      const operation = await prisma.paymentRecoveryOperation.findFirstOrThrow({ where: { bookingId: BOOKING_ID }, select: { id: true, stripeKeyPrefix: true } });
      expect(operation.stripeKeyPrefix).toBeNull();
      expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect((await cardRefundIds()).map((row) => row.amountCents)).toEqual([1_000, 2_000]);
      expect(await noteRows()).toHaveLength(1);
    });

    it("the webhook: a refund made in the Stripe dashboard gets its own note; one made before the cutover folds as before and is never given one", async () => {
      await paid();
      await canonicalCardNote();
      const dashboard = refundInDashboard(1_500);
      // An older refund Stripe made before the cutover, arriving in the same event with no row yet.
      const older = refundInDashboard(500, CUTOVER_SECONDS - 3_600);
      await deliverChargeRefunded();

      const rows = await noteRows();
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ cents: 1_500, cardRefundId: dashboard });
      expect(rows.some((row) => row.cardRefundId === older)).toBe(false);
      expect(await raiseQueuedNote(rows[1]!.id, `${P}-dashboard-note`)).toEqual([1_500]);
      expect(await canonicalPointer()).toBe(`${P}-canonical`);
      // The older refund is still short in Xero: its alert is true, as before #4312.
      expect(await reconcile(`${P}-dashboard-note`, 1_500)).toEqual([`inbound-credit-note-repair:${P}-dashboard-note`]);
      expect(await readers()).toMatchObject({ refundedCents: 3_000, rowsCents: 3_000, coveredCents: 2_500 });
      expect(await deployNoteLists()).toBe(true);
    });

    it("with no note on the payment yet, a refund made before the cutover still takes the one note an older release gave it; asked for on its own record, it gets none", async () => {
      await paid();
      const older = refundInDashboard(500, CUTOVER_SECONDS - 3_600);
      const fresh = refundInDashboard(1_500);
      await deliverChargeRefunded();
      const rows = await noteRows();
      // The older refund's delta is the payment's one note, as before #4312; the newer one is noted on its own record.
      expect(rows.map((row) => [row.cents, row.cardRefundId])).toEqual([[1_500, fresh], [500, null]]);
      // Asked for directly on its own record, the older refund raises nothing: the share's one answer.
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      expect(await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 500, { refundMethod: "card", cardRefundId: older })).toMatchObject({ queueOperationId: null });
      const { queueCardRefundOwnNotes } = await import("@/lib/card-refund-own-note");
      expect(await queueCardRefundOwnNotes({ paymentId: PAYMENT_ID, stripeRefundIds: [older] })).toEqual([]);
      expect(await noteRows()).toHaveLength(2);
    });

    it("the webhook leaves a refund request's refund to the approval and another door's refund to its own note", async () => {
      // No note on the payment yet, so the delta it queues is the payment's one note, at exactly the cash it carries.
      await paid();
      const { buildRefundRequestRefundMetadata, buildBookingModificationRefundMetadata } = await import("@/lib/payment-recovery-keys");
      stripe.byKey.set("request", stripeRefund("re_race_4312_request_first", 2_000, buildRefundRequestRefundMetadata(BOOKING_ID, `${P}-r`), (stripe.createdSeconds += 60)));
      stripe.byKey.set("edit", stripeRefund("re_race_4312_edit_first", 700, buildBookingModificationRefundMetadata(BOOKING_ID, "edit_financial_review"), (stripe.createdSeconds += 60)));
      await deliverChargeRefunded();
      // The request's refund: no note here. The edit's: in the delta - the payment's one note, as before - and nothing else.
      expect((await noteRows()).map((row) => [row.cents, row.cardRefundId])).toEqual([[700, null]]);
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(2);
    });

    it("a late capture's refund on a bank transfer gets its own note against the capture's receipt; an older refund of it keeps the capture's one note", async () => {
      await paid({ bankOnly: true });
      // The payment's first refund, a hand-back, takes its canonical note (no card money on it yet).
      await firstHandBackNoted();
      expect(await canonicalPointer()).toBe(`${P}-hand-back-note`);
      await lateCaptureKept();
      // An older refund of it, recorded by an older release's sync, with no note of its own.
      await olderReleaseRecordedLateRefund();
      const fresh = refundInDashboard(1_200);
      await deliverChargeRefunded();

      const rows = await noteRows();
      const own = rows.find((row) => row.cardRefundId === fresh);
      expect(own).toMatchObject({ cents: 1_200, paymentIntentId: CARD_INTENT_ID });
      // The older refund's ask is the capture's one note, which the canonical note absorbs, as before #4312: no row.
      expect(rows.map((row) => row.cardRefundId)).toEqual([null, fresh]);
      // The switch-window query lists it while the previous version is taken to have served past it, and not once this version served alone before it.
      expect(await switchWindowListed(new Date((CUTOVER_SECONDS + 86_400) * 1000))).toEqual([{ stripeRefundId: fresh, operationId: own!.id, creditNoteId: null }]);
      expect(await switchWindowListed(new Date(CUTOVER_SECONDS * 1000))).toEqual([]);
      expect(await raiseQueuedNote(own!.id, `${P}-late-note`)).toEqual([1_200]);
      expect(await switchWindowListed(new Date((CUTOVER_SECONDS + 86_400) * 1000))).toEqual([{ stripeRefundId: fresh, operationId: own!.id, creditNoteId: `${P}-late-note` }]);
      const executed = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: own!.id }, select: { requestPayload: true } });
      expect((executed.requestPayload as { allocation: { invoiceId: string } }).allocation.invoiceId).toBe(`${P}-kept-invoice`);
      expect(await canonicalPointer()).toBe(`${P}-hand-back-note`);

      // Asked again for the capture - the kept invoice's credit-back - nothing more.
      const { creditBackLateCaptureRefunds } = await import("@/lib/late-capture-refund-credit-note");
      await creditBackLateCaptureRefunds(CARD_INTENT_ID);
      expect(await noteRows()).toHaveLength(rows.length);
    });

    it("MUTATION: the switch-window query compares in UTC, in whole seconds, whatever the session's time zone, and dates an undated refund by its record", async () => {
      await paid({ bankOnly: true });
      await lateCaptureKept();
      // The marker finishes partway through a second; a refund made in that second is made since the cutover (the app floors both).
      await prisma.$executeRaw`UPDATE "_prisma_migrations" SET "finished_at" = ${new Date(CUTOVER_SECONDS * 1000 + 400)} WHERE "migration_name" = ${CUTOVER_MIGRATION}`;
      try {
        const atMarker = refundInDashboard(1_200, CUTOVER_SECONDS);
        await deliverChargeRefunded();
        const own = (await noteRows()).find((row) => row.cardRefundId === atMarker);
        expect(own).toMatchObject({ cents: 1_200, paymentIntentId: CARD_INTENT_ID });
        // An hour's window - shorter than New Zealand's offset, so a comparison through the session's zone drops it.
        const end = new Date((CUTOVER_SECONDS + 3_600) * 1000);
        for (const timeZone of ["UTC", "Pacific/Auckland"]) {
          expect(await switchWindowListed(end, timeZone), timeZone).toEqual([{ stripeRefundId: atMarker, operationId: own!.id, creditNoteId: null }]);
        }
        // Recorded without Stripe's time, the refund is dated by its record, as the app dates it.
        await prisma.paymentRefund.updateMany({ where: { paymentId: PAYMENT_ID, stripeRefundId: atMarker }, data: { stripeCreatedAt: null, createdAt: new Date(CUTOVER_SECONDS * 1000 + 30_000) } });
        expect(await switchWindowListed(end, "Pacific/Auckland")).toEqual([{ stripeRefundId: atMarker, operationId: own!.id, creditNoteId: null }]);
        // The operator's moment is read in UTC too: a window that ended before the refund lists nothing.
        expect(await switchWindowListed(new Date(CUTOVER_SECONDS * 1000 + 10_000), "Pacific/Auckland")).toEqual([]);
        // A refund whose note row was resolved by hand is left out: the app counts that note as in Xero.
        await prisma.xeroSyncOperation.update({ where: { id: own!.id }, data: { status: "FAILED", manuallyResolvedAt: new Date() } });
        expect(await switchWindowListed(end, "Pacific/Auckland")).toEqual([]);
        await prisma.xeroSyncOperation.update({ where: { id: own!.id }, data: { status: "FAILED", manuallyResolvedAt: null } });
        expect(await switchWindowListed(end, "Pacific/Auckland")).toEqual([{ stripeRefundId: atMarker, operationId: own!.id, creditNoteId: null }]);
        // A cancelled row never raises a note, but the refund stays listed with none: a later event may ask for it again.
        await prisma.xeroSyncOperation.update({ where: { id: own!.id }, data: { status: "CANCELLED" } });
        expect(await switchWindowListed(end, "Pacific/Auckland")).toEqual([{ stripeRefundId: atMarker, operationId: null, creditNoteId: null }]);
        // As shipped, its timestamp is a placeholder PostgreSQL refuses, so it never runs with a moment nobody set.
        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const doc = readFileSync(resolve(__dirname, "../../../docs/UPGRADING.md"), "utf8");
        const shipped = /```sql\n([\s\S]*?)\n```/.exec(doc.slice(doc.indexOf("**Card refunds made in the switch window (#4312).**")))![1]!;
        await expect(prisma.$queryRawUnsafe(shipped)).rejects.toThrow(/invalid input syntax for type timestamp with time zone/);
      } finally {
        await prisma.$executeRaw`UPDATE "_prisma_migrations" SET "finished_at" = ${new Date(CUTOVER_SECONDS * 1000)} WHERE "migration_name" = ${CUTOVER_MIGRATION}`;
      }
    });

    it("MUTATION: the switch-window query lists a window refund the previous version folded, with no row, until this version notes it on the next event", async () => {
      await paid({ bankOnly: true });
      await firstHandBackNoted();
      await lateCaptureKept();
      // While the previous version serves, it handles the refund as this one does a refund made before the cutover:
      // the marker is taken to finish after it, so the capture's ask folds into the payment's first note.
      await prisma.$executeRaw`UPDATE "_prisma_migrations" SET "finished_at" = ${new Date((CUTOVER_SECONDS + 7_200) * 1000)} WHERE "migration_name" = ${CUTOVER_MIGRATION}`;
      let windowRefund: string;
      try {
        windowRefund = refundInDashboard(1_200);
        await deliverChargeRefunded();
      } finally {
        await prisma.$executeRaw`UPDATE "_prisma_migrations" SET "finished_at" = ${new Date(CUTOVER_SECONDS * 1000)} WHERE "migration_name" = ${CUTOVER_MIGRATION}`;
      }
      expect((await noteRows()).filter((row) => row.cardRefundId !== null)).toEqual([]);
      // Made after the marker and before this version served alone: listed, with no note row of its own yet.
      const servedAlone = new Date((CUTOVER_SECONDS + 86_400) * 1000);
      expect(await switchWindowListed(servedAlone)).toEqual([{ stripeRefundId: windowRefund, operationId: null, creditNoteId: null }]);

      // A later refund of the same capture: this version now notes the window refund on its own record too.
      const later = refundInDashboard(700);
      await deliverChargeRefunded();
      const rows = await noteRows();
      const windowRow = rows.find((row) => row.cardRefundId === windowRefund);
      const laterRow = rows.find((row) => row.cardRefundId === later);
      expect(windowRow).toMatchObject({ cents: 1_200, paymentIntentId: CARD_INTENT_ID });
      expect(laterRow).toMatchObject({ cents: 700, paymentIntentId: CARD_INTENT_ID });
      expect(await switchWindowListed(servedAlone)).toEqual(
        expect.arrayContaining([
          { stripeRefundId: windowRefund, operationId: windowRow!.id, creditNoteId: null },
          { stripeRefundId: later, operationId: laterRow!.id, creditNoteId: null },
        ]),
      );
    });

    it("MUTATION: the switch-window query leaves out a failed note row a retry already raised, so nobody resolves it", async () => {
      await paid({ bankOnly: true });
      await lateCaptureKept();
      const fresh = refundInDashboard(1_200);
      await deliverChargeRefunded();
      const own = (await noteRows()).find((row) => row.cardRefundId === fresh)!;
      const servedAlone = new Date((CUTOVER_SECONDS + 86_400) * 1000);
      // Xero timed out on it: failed, its outcome unknown. Listed, for the officer to look in Xero and resolve.
      await failQueuedNote(own.id);
      expect(await switchWindowListed(servedAlone)).toEqual([{ stripeRefundId: fresh, operationId: own.id, creditNoteId: null }]);
      // An officer's retry raises the note on a row of its own, found as this refund's.
      expect(await retryNote(own.id, `${P}-retried`)).toEqual([1_200]);
      const retried = (await noteRows()).filter((row) => row.cardRefundId === fresh && row.id !== own.id);
      expect(retried).toHaveLength(1);
      // Only the retry's row is listed: the failed one it superseded would, resolved, count the refund twice.
      expect(await switchWindowListed(servedAlone)).toEqual([{ stripeRefundId: fresh, operationId: retried[0]!.id, creditNoteId: `${P}-retried` }]);
    });

    it("a late capture's refund whose own note Xero voided is not noted again when a later refund of the same capture arrives", async () => {
      await paid({ bankOnly: true });
      await firstHandBackNoted();
      await lateCaptureKept();
      const first = refundInDashboard(1_200);
      await deliverChargeRefunded();
      const own = (await noteRows()).find((row) => row.cardRefundId === first)!;
      expect(await raiseQueuedNote(own.id, `${P}-late-voided`)).toEqual([1_200]);
      await reconcile(`${P}-late-voided`, 1_200);
      // Xero voids it, and the nightly follow-up sends it to a person.
      await reconcile(`${P}-late-voided`, 1_200, "VOIDED");
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-late-voided` }, select: { id: true } });
      const { followUpVoidedBankRefundNote } = await import("@/lib/bank-refund-void-follow-up");
      expect(await followUpVoidedBankRefundNote(link.id)).toMatchObject({ outcome: "unmatched" });

      // A second refund of the same capture: only it is asked for, never the voided refund again.
      const second = refundInDashboard(700);
      await deliverChargeRefunded();
      const { creditBackLateCaptureRefunds } = await import("@/lib/late-capture-refund-credit-note");
      await creditBackLateCaptureRefunds(CARD_INTENT_ID);
      const rows = await noteRows();
      expect(rows.filter((row) => row.cardRefundId === first).map((row) => row.id)).toEqual([own.id]);
      expect(rows.filter((row) => row.cardRefundId === second).map((row) => row.cents)).toEqual([700]);
    });

    it("a late capture on a payment with no note yet: its older refund takes the capture's one note, its newer one its own", async () => {
      await paid({ bankOnly: true });
      await lateCaptureKept();
      await olderReleaseRecordedLateRefund();
      const fresh = refundInDashboard(1_200);
      await deliverChargeRefunded();
      const rows = await noteRows();
      expect(rows.map((row) => [row.cents, row.cardRefundId, row.paymentIntentId]).sort()).toEqual([[1_200, fresh, CARD_INTENT_ID], [800, null, CARD_INTENT_ID]].sort());
    });

    it("two writers asking for one card refund at once raise one row (race)", async () => {
      await paid();
      await canonicalCardNote();
      const dashboard = refundInDashboard(900);
      const { syncRefundsFromStripeCharge } = await import("@/lib/payment-transactions");
      await syncRefundsFromStripeCharge({ paymentIntentId: CARD_INTENT_ID, stripeChargeId: CHARGE_ID, refundedAmountCents: 1_900, refunds: [...stripe.byKey.values()] });
      const { queueCardRefundOwnNotes } = await import("@/lib/card-refund-own-note");
      const asks = await Promise.all(Array.from({ length: 4 }, () => queueCardRefundOwnNotes({ paymentId: PAYMENT_ID, stripeRefundIds: [dashboard] })));
      const own = (await noteRows()).filter((row) => row.cardRefundId === dashboard);
      expect(own).toHaveLength(1);
      expect(new Set(asks.flat())).toEqual(new Set([own[0]!.id]));
    });

    it("a card refund's voided note is never matched to a bank refund of the same amount and undone: it goes to a person", async () => {
      await paid();
      // A $50 hand-back an older release absorbed: its line is covered by no note of its own.
      await absorbedHandBack(5_000);
      // A $50 dashboard refund, noted on its own record.
      refundInDashboard(5_000);
      await deliverChargeRefunded();
      const own = (await noteRows()).find((row) => row.cardRefundId !== null)!;
      expect(await raiseQueuedNote(own.id, `${P}-card-voided`)).toEqual([5_000]);
      await reconcile(`${P}-card-voided`, 5_000);
      // Xero voids the card refund's note; the nightly follow-up looks at it.
      await reconcile(`${P}-card-voided`, 5_000, "VOIDED");
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: `${P}-card-voided` }, select: { id: true } });
      const { classifyVoidedBankRefundNote } = await import("@/lib/bank-refund-void-scan");
      expect((await classifyVoidedBankRefundNote(prisma, link.id))?.classification).toMatchObject({ kind: "unmatched", reason: "card-refund" });
      const { followUpVoidedBankRefundNote } = await import("@/lib/bank-refund-void-follow-up");
      expect(await followUpVoidedBankRefundNote(link.id)).toMatchObject({ outcome: "unmatched" });
      // The bank hand-back stands: no follow-up undid it, and the payment still records both refunds.
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID, occurrenceKey: { startsWith: "bank-refund-void:" } } })).toBe(0);
      expect(await readers()).toMatchObject({ refundedCents: 10_000, rowsCents: 10_000 });

      // On Stuck States it offers nothing to pick, though a $50 bank refund sits beside it, and a person answers it.
      const { listBankRefundVoidsForAPerson } = await import("@/lib/bank-refund-void-scan");
      expect((await listBankRefundVoidsForAPerson(prisma)).filter((item) => item.linkId === link.id)).toEqual([expect.objectContaining({ reason: "card-refund", pickableLines: [] })]);
      const { markUnmatchedBankRefundVoidAnswered } = await import("@/lib/bank-refund-void-follow-up");
      await withVoidWrites(() => markUnmatchedBankRefundVoidAnswered({ linkId: link.id, note: "Raised the card refund's note again in Xero by hand.", actingMemberId: OFFICER_ID }));
      const answered = await prisma.xeroObjectLink.findUniqueOrThrow({ where: { id: link.id }, select: { metadata: true } });
      expect(answered.metadata).toMatchObject({ bankRefundVoid: { outcome: "answered", memberId: OFFICER_ID } });
      expect((await classifyVoidedBankRefundNote(prisma, link.id))?.classification).toMatchObject({ kind: "handled", by: "answered" });
      expect(await readers()).toMatchObject({ refundedCents: 10_000, rowsCents: 10_000 });
    });

    /**
     * Stripe fails a refund it had answered `pending` (#4104): Stripe now lists it failed, and its
     * refund-failed event reaches the app's recorder (`recordRefusedCardRefund`), the one door for it.
     */
    async function stripeFailsLater(stripeRefundId: string) {
      const [key, refund] = [...stripe.byKey.entries()].find(([, each]) => each.id === stripeRefundId)!;
      const failed = { ...refund, status: "failed" } as Stripe.Refund;
      stripe.byKey.set(key, failed);
      if (stripe.tracksAppClock) vi.setSystemTime(Date.now() + 30_000); // Stripe fails it later

      const { recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync");
      expect(await recordRefusedCardRefund(failed)).toBe("recorded");
    }

    /** The recovery row's backoff has passed, as the payments cron finds it. */
    async function due(operationId: string) {
      await prisma.paymentRecoveryOperation.update({ where: { id: operationId }, data: { nextRetryAt: new Date(Date.now() - 1_000) } });
    }

    describe("a card refund Stripe failed later and sent again (#4312 round 5, #4104)", () => {
      // Round 6: these read when a refund was made against when a row was raised, closed or failed, so the app's
      // clock runs with Stripe's from the suite's cutover (which the ledger start and #4104's cutoff precede), as in
      // production, rather than staying frozen months before every refund; it is frozen again after.
      beforeEach(() => {
        vi.setSystemTime((stripe.createdSeconds + 1) * 1_000);
        stripe.tracksAppClock = true;
      });
      afterEach(() => {
        stripe.tracksAppClock = false;
        vi.setSystemTime(frozenTestNow());
      });

      it("MUTATION (a): the refund request's replay sends the failed slice again; the failed refund's own note answers it, and only the other slice is noted", async () => {
        await paid();
        await prisma.paymentTransaction.create({
          data: { id: CARD2_TXN_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: "pi_race_4312_second", amountCents: 4_000, status: "SUCCEEDED", createdAt: new Date("2026-06-02T00:00:00.000Z") },
        });
        await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { amountCents: 29_000 } });
        const request = await requestRefund(`${P}-failed-later-a`, 6_000);
        stripe.failNext = 1;
        await approve(request, 6_000);
        const operation = await prisma.paymentRecoveryOperation.findFirstOrThrow({ where: { bookingId: BOOKING_ID }, select: { id: true } });

        // The replay: Stripe accepts the newer capture's $40 slice `pending` and refuses the older capture's $20 one, so the row stays open.
        stripe.answer = "pending";
        stripe.refuseOn = CARD_TXN_ID;
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("failed");
        const [failedNote] = await noteRows();
        expect(failedNote).toMatchObject({ cents: 4_000 });
        const failedId = failedNote!.cardRefundId!;
        expect(await raiseQueuedNote(failedNote!.id, `${P}-failed-later-note`)).toEqual([4_000]);
        expect(await reconcile(`${P}-failed-later-note`, 4_000)).toEqual([]);

        // Days later Stripe fails it: the open row's slice is re-planned to send it again (#4104).
        await stripeFailsLater(failedId);
        const { parseRefundAllocationPlan } = await import("@/lib/open-card-refund-owed");
        const replanned = parseRefundAllocationPlan((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operation.id } })).allocationPlan);
        expect(replanned?.find((slice) => slice.paymentTransactionId === CARD2_TXN_ID)?.failedRefundIds).toEqual([failedId]);

        // The next replay makes both slices.
        stripe.answer = "succeeded";
        stripe.refuseOn = null;
        await due(operation.id);
        expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        const resent = (await prisma.paymentRefund.findMany({ where: { paymentId: PAYMENT_ID, status: "succeeded" }, select: { stripeRefundId: true, amountCents: true, paymentTransactionId: true } }));
        const resentId = resent.find((refund) => refund.paymentTransactionId === CARD2_TXN_ID)!.stripeRefundId;
        const otherId = resent.find((refund) => refund.paymentTransactionId === CARD_TXN_ID)!.stripeRefundId;
        // The failed refund's note answers the re-sent $40: only the $20 slice gets a note of its own.
        const rows = await noteRows();
        expect(rows.filter((row) => row.status === "PENDING").map((row) => [row.cents, row.cardRefundId])).toEqual([[2_000, otherId]]);
        expect(rows.some((row) => row.cardRefundId === resentId)).toBe(false);
        await raiseQueuedNote(rows.find((row) => row.cardRefundId === otherId)!.id, `${P}-other-slice-note`);
        // Asked for again - a replay, an officer's retry of the ask - the re-sent refund still raises nothing.
        // (No `charge.refunded` here: this suite's Stripe double lists every refund under the first capture's charge.)
        const { queueCardRefundOwnNotes } = await import("@/lib/card-refund-own-note");
        expect(await queueCardRefundOwnNotes({ paymentId: PAYMENT_ID, stripeRefundIds: [resentId] })).toEqual([]);
        expect(await noteRows()).toHaveLength(2);
        expect(await readers()).toMatchObject({ refundedCents: 6_000, rowsCents: 6_000, coveredCents: 6_000, uncoveredCents: 0 });
      });

      it("MUTATION (b): a failed-later row's re-send the webhook records first takes no canonical note, which would be sized on another refund's gap", async () => {
        await paid();
        const request = await requestRefund(`${P}-failed-later-b`, 4_000);
        stripe.answer = "pending";
        await approve(request, 4_000);
        const [failedNote] = await noteRows();
        const failedId = failedNote!.cardRefundId!;
        expect(await raiseQueuedNote(failedNote!.id, `${P}-failed-later-note`)).toEqual([4_000]);
        // The approval's own note: the payment has no canonical note.
        expect(await canonicalPointer()).toBeNull();
        // A $10 refund made in the Stripe dashboard, whose own note Xero times out on: it waits for an officer's Retry.
        stripe.answer = "succeeded";
        const dashboard = refundInDashboard(1_000);
        await deliverChargeRefunded();
        const dashboardNote = (await noteRows()).find((row) => row.cardRefundId === dashboard)!;
        await failQueuedNote(dashboardNote.id);

        // Stripe fails the request's refund; no open row made it, so a row of its own owes it (#4104).
        await stripeFailsLater(failedId);
        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: `card_refund_failed_later_${failedId}` }, select: { id: true } });
        // The runner asks Stripe again; Stripe makes the refund, and its answer is lost on the way back.
        stripe.lostAnswers = 1;
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("failed");
        // Stripe's `charge.refunded` records the re-send first: the failed refund's note answers it, so nothing is queued.
        await deliverChargeRefunded();
        expect((await noteRows()).map((note) => note.id)).toEqual([failedNote!.id, dashboardNote.id]);
        // The runner's retry reads Stripe's answer back: it asks for the refund's note, which raises nothing either.
        await due(row.id);
        expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        expect((await noteRows()).map((note) => note.id)).toEqual([failedNote!.id, dashboardNote.id]);
        // The officer's Retry raises the dashboard refund's note, and Xero credits exactly what went back.
        expect(await retryNote(dashboardNote.id, `${P}-dashboard-retried`)).toEqual([1_000]);
        expect(await readers()).toMatchObject({ refundedCents: 5_000, rowsCents: 5_000, coveredCents: 5_000, uncoveredCents: 0 });
      });

      it("MUTATION (c): a failure that overtook the failed refund's note before it was raised: the re-send the runner records is noted, once", async () => {
        await paid();
        const request = await requestRefund(`${P}-failed-later-c`, 4_000);
        stripe.answer = "pending";
        await approve(request, 4_000);
        const [failedNote] = await noteRows();
        const failedId = failedNote!.cardRefundId!;
        // Stripe fails it before the outbox raised its note.
        await stripeFailsLater(failedId);
        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: `card_refund_failed_later_${failedId}` }, select: { id: true } });
        stripe.answer = "succeeded";
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        const resent = (await prisma.paymentRefund.findFirstOrThrow({ where: { paymentId: PAYMENT_ID, status: "succeeded" }, select: { stripeRefundId: true } })).stripeRefundId;
        // The failed refund's note raises nothing (it paid nothing back); the re-send's own note answers the money.
        expect(await raiseQueuedNote(failedNote!.id, `${P}-overtaken`)).toEqual([]);
        const resentNote = (await noteRows()).find((note) => note.cardRefundId === resent)!;
        expect(resentNote).toMatchObject({ cents: 4_000 });
        expect(await raiseQueuedNote(resentNote.id, `${P}-resent-note`)).toEqual([4_000]);
        await deliverChargeRefunded();
        expect(await noteRows()).toHaveLength(2);
        expect(await readers()).toMatchObject({ refundedCents: 4_000, rowsCents: 4_000, coveredCents: 4_000, uncoveredCents: 0 });
      });

      it("MUTATION (d, chain of three): a re-send Stripe failed too passes on what it answered, through the slice marked with it - Xero credits what went back", async () => {
        await paid();
        await prisma.paymentTransaction.create({
          data: { id: CARD2_TXN_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: "pi_race_4312_second", amountCents: 4_000, status: "SUCCEEDED", createdAt: new Date("2026-06-02T00:00:00.000Z") },
        });
        await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { amountCents: 29_000 } });
        const request = await requestRefund(`${P}-failed-later-d`, 6_000);
        stripe.failNext = 1;
        await approve(request, 6_000);
        const operation = await prisma.paymentRecoveryOperation.findFirstOrThrow({ where: { bookingId: BOOKING_ID }, select: { id: true } });
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        const { parseRefundAllocationPlan } = await import("@/lib/open-card-refund-owed");
        const planOf = async (id: string) => parseRefundAllocationPlan((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id } })).allocationPlan) ?? [];

        // F0: the replay makes the $40 slice `pending` and Stripe refuses the $20 one, so the row stays open. F0 is noted.
        stripe.answer = "pending";
        stripe.refuseOn = CARD_TXN_ID;
        expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("failed");
        const [f0Note] = await noteRows();
        const f0 = f0Note!.cardRefundId!;
        expect(await raiseQueuedNote(f0Note!.id, `${P}-f0-note`)).toEqual([4_000]);
        expect(await reconcile(`${P}-f0-note`, 4_000)).toEqual([]);

        // Stripe fails F0: the open row re-plans its slice. The next replay makes both slices, and marks the re-sent one with R1.
        await stripeFailsLater(f0);
        stripe.refuseOn = null;
        await due(operation.id);
        expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        const resentSlice = (await planOf(operation.id)).find((slice) => slice.paymentTransactionId === CARD2_TXN_ID)!;
        expect(resentSlice.failedRefundIds).toEqual([f0]);
        const r1 = resentSlice.madeRefundId!;
        expect(r1).toBeTruthy();
        // F0's note answers R1: only the $20 slice is noted.
        const other = (await noteRows()).filter((note) => note.id !== f0Note!.id);
        expect(other.map((note) => [note.cents, note.cardRefundId === r1])).toEqual([[2_000, false]]);
        expect(await raiseQueuedNote(other[0]!.id, `${P}-other-slice-note`)).toEqual([2_000]);

        // Stripe fails R1 too. Its row has closed, so a row of its own owes it; R1 carried the request's metadata, so it is
        // sent again automatically, and that replay marks its slice with R2.
        await stripeFailsLater(r1);
        const own = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: `card_refund_failed_later_${r1}` }, select: { id: true } });
        stripe.answer = "succeeded";
        expect(await runPaymentRecoveryOperationNow(own.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        const r2 = (await planOf(own.id))[0]?.madeRefundId;
        expect(r2).toBeTruthy();
        // R2 answers R1, and F0 through the slice marked with R1: F0's note covers it, so nothing more is noted.
        const { readFailedRefundsAnsweredBy } = await import("@/lib/card-refund-resend-answer");
        expect(await readFailedRefundsAnsweredBy(prisma, PAYMENT_ID, r2!)).toEqual({ failedRefundIds: [r1, f0], ownNoted: true, coverCents: 4_000 });
        expect(await noteRows()).toHaveLength(2);
        expect(await readers()).toMatchObject({ refundedCents: 6_000, rowsCents: 6_000, coveredCents: 6_000, uncoveredCents: 0 });
      });

      /** A $20 refund request's refund, noted on its own record, that Stripe then fails: a row of its own owes it. */
      async function failedRequestRefundOwedByItsOwnRow(id: string, { withDashboard = true } = {}) {
        await paid();
        const request = await requestRefund(id, 2_000);
        stripe.answer = "pending";
        await approve(request, 2_000);
        const [failedNote] = await noteRows();
        const failedId = failedNote!.cardRefundId!;
        expect(await raiseQueuedNote(failedNote!.id, `${P}-failed-later-note`)).toEqual([2_000]);
        expect(await reconcile(`${P}-failed-later-note`, 2_000)).toEqual([]);
        await stripeFailsLater(failedId);
        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: `card_refund_failed_later_${failedId}` }, select: { id: true } });
        stripe.answer = "succeeded";
        if (!withDashboard) return { failedId, failedNoteId: failedNote!.id, dashboardNote: null, rowId: row.id };
        // Before the runner gets to it, the treasurer refunds the $20 in the Stripe dashboard: no recovery row made that
        // refund, so it is noted in full.
        const dashboard = refundInDashboard(2_000);
        await deliverChargeRefunded();
        const dashboardNote = (await noteRows()).find((note) => note.cardRefundId === dashboard)!;
        expect(dashboardNote).toMatchObject({ cents: 2_000 });
        return { failedId, failedNoteId: failedNote!.id, dashboardNote, rowId: row.id };
      }

      it("MUTATION (e, finding 1): a dashboard refund before the replay, whose re-send charge.refunded records first - $40 in Xero for $40 refunded", async () => {
        const { failedId, failedNoteId, dashboardNote: note, rowId } = await failedRequestRefundOwedByItsOwnRow(`${P}-failed-later-e`);
        const dashboardNote = note!;
        // The runner sends the slice all the same (#4359); its answer is lost, so `charge.refunded` records it first. It is
        // a failed-later row's refund the replay has not marked yet: left to the replay, never the canonical delta.
        stripe.lostAnswers = 1;
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        expect(await runPaymentRecoveryOperationNow(rowId, CLUB_FORMAT_TEST)).toBe("failed");
        await deliverChargeRefunded();
        expect((await noteRows()).map((note) => note.id)).toEqual([failedNoteId, dashboardNote.id]);
        // The runner's retry reads Stripe's answer back, marks its slice with it and asks: the failed refund's note answers it.
        await due(rowId);
        expect(await runPaymentRecoveryOperationNow(rowId, CLUB_FORMAT_TEST)).toBe("succeeded");
        await resentAnsweredByTheFailure(rowId, failedId, [failedNoteId, dashboardNote.id]);
        expect(await raiseQueuedNote(dashboardNote.id, `${P}-dashboard-note`)).toEqual([2_000]);
        expect(await readers()).toMatchObject({ refundedCents: 4_000, rowsCents: 4_000, coveredCents: 4_000, uncoveredCents: 0 });
      });

      it("MUTATION (f, finding 1): the same, with the replay recording its re-send first - one answer whichever writer records it", async () => {
        const { failedId, failedNoteId, dashboardNote: note, rowId } = await failedRequestRefundOwedByItsOwnRow(`${P}-failed-later-f`);
        const dashboardNote = note!;
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        expect(await runPaymentRecoveryOperationNow(rowId, CLUB_FORMAT_TEST)).toBe("succeeded");
        await resentAnsweredByTheFailure(rowId, failedId, [failedNoteId, dashboardNote.id]);
        await deliverChargeRefunded();
        expect((await noteRows()).map((note) => note.id)).toEqual([failedNoteId, dashboardNote.id]);
        expect(await raiseQueuedNote(dashboardNote.id, `${P}-dashboard-note`)).toEqual([2_000]);
        expect(await readers()).toMatchObject({ refundedCents: 4_000, rowsCents: 4_000, coveredCents: 4_000, uncoveredCents: 0 });
      });

      /** The runner's first four tries fail before Stripe makes anything, so its next claim is its last (`MAX_PAYMENT_RECOVERY_ATTEMPTS`). */
      async function toFinalAttempt(rowId: string) {
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        const { MAX_PAYMENT_RECOVERY_ATTEMPTS } = await import("@/lib/payment-recovery-constants");
        for (let attempt = 1; attempt < MAX_PAYMENT_RECOVERY_ATTEMPTS; attempt += 1) {
          stripe.failNext = 1;
          expect(await runPaymentRecoveryOperationNow(rowId, CLUB_FORMAT_TEST)).toBe("failed");
          await due(rowId);
        }
      }

      /** The row is dead: FAILED, retries spent, never claimed again. */
      async function expectDead(rowId: string) {
        const { MAX_PAYMENT_RECOVERY_ATTEMPTS } = await import("@/lib/payment-recovery-constants");
        expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: rowId }, select: { status: true, attempts: true, nextRetryAt: true } }))
          .toEqual({ status: "FAILED", attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null });
      }

      it("MUTATION (g, round 8 F2): the reaper moves a stalled final attempt to FAILED; the late attempt's mark still lands, so its re-send is answered", async () => {
        const { failedId, failedNoteId, rowId } = await failedRequestRefundOwedByItsOwnRow(`${P}-failed-later-g`, { withDashboard: false });
        await toFinalAttempt(rowId);
        // The final attempt stalls past the reaper's limit after Stripe made the re-send: the payments cron reaps it, dead.
        const answer = stripeRaceHooks.refund!;
        stripeRaceHooks.refund = async (args) => {
          const made = await answer(args);
          vi.setSystemTime(Date.now() + 31 * 60_000);
          const { processPaymentRecoveryOperations } = await import("@/lib/payment-recovery");
          await processPaymentRecoveryOperations({ limit: 1 });
          await expectDead(rowId);
          return made;
        };
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        expect(await runPaymentRecoveryOperationNow(rowId, CLUB_FORMAT_TEST)).toBe("succeeded");
        // Stripe's answer is a fact whoever holds the row: the slice is marked with it, and the failed refund's note answers it.
        await resentAnsweredByTheFailure(rowId, failedId, [failedNoteId]);
        await deliverChargeRefunded();
        expect((await noteRows()).map((note) => note.id)).toEqual([failedNoteId]);
        expect(await readers()).toMatchObject({ refundedCents: 2_000, rowsCents: 2_000, coveredCents: 2_000, uncoveredCents: 0 });
      });

      it("MUTATION (h, round 8 F2): the final attempt's answer is lost and the row dies; charge.refunded marks the dead row's re-send and the rule answers it", async () => {
        const { failedId, failedNoteId, rowId } = await failedRequestRefundOwedByItsOwnRow(`${P}-failed-later-h`, { withDashboard: false });
        await toFinalAttempt(rowId);
        stripe.lostAnswers = 1;
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        expect(await runPaymentRecoveryOperationNow(rowId, CLUB_FORMAT_TEST)).toBe("failed");
        await expectDead(rowId);
        // Nobody replays a dead row: Stripe's `charge.refunded` is the writer that sees the re-send, and marks the one slice it answers.
        await deliverChargeRefunded();
        await resentAnsweredByTheFailure(rowId, failedId, [failedNoteId]);
        expect(await readers()).toMatchObject({ refundedCents: 2_000, rowsCents: 2_000, coveredCents: 2_000, uncoveredCents: 0 });
      });

      it("STATED LIMIT (round 8): charge.refunded that arrives during the final attempt leaves the re-send to it; its answer lost, nobody marks it", async () => {
        const { rowId } = await failedRequestRefundOwedByItsOwnRow(`${P}-failed-later-limit`, { withDashboard: false });
        await toFinalAttempt(rowId);
        const answer = stripeRaceHooks.refund!;
        stripeRaceHooks.refund = async (args) => {
          await answer(args).catch(() => undefined); // Stripe makes it; the answer is still on its way
          await deliverChargeRefunded();
          throw new Error("Stripe timed out after making the refund (race-4312)");
        };
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        expect(await runPaymentRecoveryOperationNow(rowId, CLUB_FORMAT_TEST)).toBe("failed");
        await expectDead(rowId);
        const { parseRefundAllocationPlan } = await import("@/lib/open-card-refund-owed");
        const plan = parseRefundAllocationPlan((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: rowId } })).allocationPlan);
        expect(plan?.[0]?.madeRefundId).toBeUndefined();
      });

      it("MUTATION (i, round 8 F1): a re-planned slice's re-send on another door's row, recorded first by charge.refunded, never enters the canonical delta", async () => {
        await paid();
        await prisma.paymentTransaction.create({
          data: { id: CARD2_TXN_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: "pi_race_4312_second", amountCents: 4_000, status: "SUCCEEDED", createdAt: new Date("2026-06-02T00:00:00.000Z") },
        });
        await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { amountCents: 29_000 } });
        // An edit review's card refund (its runner's own reason, not a refund request's): $40 off the first capture - the
        // charge this suite's `charge.refunded` lists - and $20 off the newer one.
        const { enqueueEditFinancialReviewRefundRecovery } = await import("@/lib/payment-recovery");
        await enqueueEditFinancialReviewRefundRecovery({
          bookingId: BOOKING_ID, paymentId: PAYMENT_ID, taskId: `${P}-review-i`, amountCents: 6_000,
          allocationPlan: [{ paymentTransactionId: CARD_TXN_ID, amountCents: 4_000 }, { paymentTransactionId: CARD2_TXN_ID, amountCents: 2_000 }],
        });
        const operation = await prisma.paymentRecoveryOperation.findFirstOrThrow({ where: { bookingId: BOOKING_ID }, select: { id: true } });
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        // Stripe makes the $40 `pending` and refuses the $20, so the row stays open; then fails the $40 later: its slice is re-planned.
        stripe.answer = "pending";
        stripe.refuseOn = CARD2_TXN_ID;
        expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("failed");
        const [failed] = await cardRefundIds();
        await stripeFailsLater(failed!.stripeRefundId);
        const notesBefore = (await noteRows()).map((note) => note.id);

        // The replay sends the re-planned slice again; its answer is lost, so `charge.refunded` records the re-send first.
        stripe.answer = "succeeded";
        stripe.refuseOn = null;
        stripe.lostAnswers = 1;
        await due(operation.id);
        expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("failed");
        await deliverChargeRefunded();
        // Left to the replay: no canonical delta, whose payment-wide gap would hand it another refund's share.
        expect((await noteRows()).map((note) => note.id)).toEqual(notesBefore);
        // The retry reads Stripe's answer back under the same key and marks the slice with it.
        await due(operation.id);
        expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        const { parseRefundAllocationPlan } = await import("@/lib/open-card-refund-owed");
        const resent = parseRefundAllocationPlan((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operation.id } })).allocationPlan)
          ?.find((slice) => slice.paymentTransactionId === CARD_TXN_ID);
        expect(resent?.failedRefundIds).toEqual([failed!.stripeRefundId]);
        expect(resent?.madeRefundId).toBeTruthy();
        expect((await noteRows()).map((note) => note.id)).toEqual(notesBefore);
      });

      /** The row's slice is marked with its re-send, which answers the failure exactly and raises no note: `noteIds` stay the payment's only rows. */
      async function resentAnsweredByTheFailure(rowId: string, failedId: string, noteIds: string[]) {
        const { parseRefundAllocationPlan } = await import("@/lib/open-card-refund-owed");
        const resent = parseRefundAllocationPlan((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: rowId } })).allocationPlan)?.[0]?.madeRefundId;
        expect(resent).toBeTruthy();
        const { readFailedRefundsAnsweredBy } = await import("@/lib/card-refund-resend-answer");
        expect(await readFailedRefundsAnsweredBy(prisma, PAYMENT_ID, resent!)).toEqual({ failedRefundIds: [failedId], ownNoted: true, coverCents: 2_000 });
        expect((await noteRows()).map((note) => note.id)).toEqual(noteIds);
      }
    });

    /** The #4162 writes switch, on for one call and put back as it was. */
    async function withVoidWrites<T>(run: () => Promise<T>): Promise<T> {
      const before = process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES;
      process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES = "true";
      try {
        return await run();
      } finally {
        if (before === undefined) delete process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES;
        else process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES = before;
      }
    }
  },
);
