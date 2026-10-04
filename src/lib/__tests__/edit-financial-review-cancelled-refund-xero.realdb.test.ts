/**
 * Real-PostgreSQL proof of #3880: a review's card refund or bank-transfer
 * hand-back on an ALREADY-CANCELLED booking reaches Xero as the paid
 * cancellation's own card refund does - a refund credit note on the payment,
 * through the same enqueue and outbox - sized to the figure #3835 netted, keyed
 * on the review task, and never touching the cancelled invoice.
 *
 * $200 paid by card, by bank transfer, and by $150 credit plus $50 card,
 * cancelled through the REAL `cancelBooking` at 100% and at 50% with a $20 fee,
 * then a $50 review completed through the REAL `resolveManualRefundTask`. What
 * Xero is asked for is read from the outbox rows the app wrote.
 *
 * No Stripe or Xero call leaves this process. Stripe's refund create answers as
 * Stripe would (one refund per idempotency key) only while this file runs; Xero
 * is not connected, so every document stays the PENDING outbox row the worker
 * would raise. Every other suite in the #1881 harness sees the real modules.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-3880-`
 * fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import type { CalendarDate } from "@/lib/club-time";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3880-member";
const LODGE_ID = "race-3880-lodge";
const BOOKING_ID = "race-3880-booking";
const GUEST_ID = "race-3880-guest";
const MODIFICATION_ID = "race-3880-modification";
const PAYMENT_ID = "race-3880-payment";
const TRANSACTION_ID = "race-3880-txn";
const INTENT_ID = "pi_race_3880";
const INVOICE_ID = "race-3880-xero-invoice";
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

/**
 * While this file's cases run, Stripe's refund create answers once per
 * idempotency key, as Stripe does. A spy installed per case and restored after,
 * not a `vi.mock`: the #3402 and #3835 files the harness imports beside this one
 * own `@/lib/stripe`'s and `@/lib/stripe-config`'s mocks, and a second factory
 * for either module would replace theirs for the whole harness.
 */
const stripe = { createdSeconds: 0, byKey: new Map<string, unknown>() };
function answerRefundsAsStripeWould(params: { paymentIntentId: string; amountCents: number; metadata?: Record<string, string>; idempotencyKey?: string }) {
  const key = params.idempotencyKey ?? `race-3880-${stripe.byKey.size}`;
  if (!stripe.byKey.has(key)) {
    stripe.createdSeconds += 1;
    stripe.byKey.set(key, {
      id: `re_race_3880_${stripe.byKey.size}`, object: "refund", amount: params.amountCents, currency: "nzd", status: "succeeded",
      reason: "requested_by_customer", created: stripe.createdSeconds, charge: "ch_race_3880", payment_intent: params.paymentIntentId,
      metadata: params.metadata ?? {},
    });
  }
  return Promise.resolve(stripe.byKey.get(key) as never);
}

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeCancelledRefundXeroRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Cancelled-refund Xero proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run cancelled-refund Xero proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Cancelled-refund Xero proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Cancelled-refund Xero proof DB name must contain 'concurrency_race_1881'.");
  }
}

const TIERS = [
  { tier: "100%", rule: { refundPercentage: 100, fixedFeeCents: 0 }, cancelBackCents: 20_000, owedCents: 0 },
  { tier: "50% with a $20 fee", rule: { refundPercentage: 50, fixedFeeCents: 2_000 }, cancelBackCents: 8_000, owedCents: 2_500 },
];
type Paid = { cardCents: number; appliedCents: number; source: "STRIPE" | "INTERNET_BANKING" };
const CARD: Paid = { cardCents: 20_000, appliedCents: 0, source: "STRIPE" };
const BANK: Paid = { cardCents: 20_000, appliedCents: 0, source: "INTERNET_BANKING" };

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let raiseEditFinancialReviewTask: (typeof import("@/lib/edit-financial-review"))["raiseEditFinancialReviewTask"];
let resolveManualRefundTask: (typeof import("@/lib/manual-refund-task-resolution"))["resolveManualRefundTask"];
let credit: typeof import("@/lib/member-credit");
let outbox: typeof import("@/lib/xero-operation-outbox");

(RUN ? describe : describe.skip)(
  "a review's refund on a cancelled booking takes the cancellation's Xero refund note - real PostgreSQL (#3880)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({
        where: { OR: [{ memberId: MEMBER_ID }, { actorMemberId: MEMBER_ID }, { targetId: { in: [BOOKING_ID, MODIFICATION_ID] } }] },
      });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      stripe.byKey.clear();
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.bookingModification.deleteMany({ where: { id: MODIFICATION_ID } });
      await prisma.bookingGuest.deleteMany({ where: { id: GUEST_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** A $200 booking, paid and invoiced in Xero: the capture, and any credit applied through the real writer. */
    async function paid({ cardCents, appliedCents, source }: Paid) {
      const intentId = source === "STRIPE" ? INTENT_ID : null;
      await clearRun();
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAID", totalPriceCents: 20_000, finalPriceCents: 20_000 } });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: cardCents, creditAppliedCents: appliedCents, source, status: "SUCCEEDED",
          stripePaymentIntentId: intentId, xeroInvoiceId: INVOICE_ID,
          transactions: {
            create: { id: TRANSACTION_ID, kind: "PRIMARY", source, stripePaymentIntentId: intentId, amountCents: cardCents, status: "SUCCEEDED" },
          },
        },
      });
      const nights = [CHECK_IN, new Date("2026-08-02T00:00:00.000Z")];
      for (const [index, night] of nights.entries()) {
        await prisma.bookingLedgerLine.create({ data: {
          bookingId: BOOKING_ID, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: 10_000, amountCents: 10_000,
          bookingGuestId: GUEST_ID, nightStart: night, nightEndExclusive: nights[index + 1] ?? CHECK_OUT, ageTier: "ADULT",
          guestNames: ["Review Guest"], anchorKind: "CONFIRMATION", anchorId: BOOKING_ID, narration: "race 3880 confirmation",
          lodgeId: LODGE_ID, postingKey: `race-3880-confirm-${index}`,
        } });
      }
      if (appliedCents > 0) {
        await prisma.memberCredit.create({
          data: { memberId: MEMBER_ID, amountCents: appliedCents, type: "ADMIN_ADJUSTMENT", description: "race 3880 opening balance" },
        });
        await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, appliedCents, BOOKING_ID, tx, CLUB_FORMAT_TEST));
      }
    }

    const raise = (night: string) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        return raiseEditFinancialReviewTask({
          occurrence: {
            bookingId: BOOKING_ID, bookingGuestId: GUEST_ID, cause: "NO_STORED_NIGHT_PRICES",
            surrenderedNightDates: [night as CalendarDate], addedNightDates: [],
            storedEvidence: { guestTotalCents: null, nightPrices: [] },
          },
          guestMemberId: MEMBER_ID,
          bookingCheckIn: "2026-08-01" as CalendarDate,
          bookingCheckOut: "2026-08-03" as CalendarDate,
          bookingModificationId: MODIFICATION_ID,
          paymentId: PAYMENT_ID,
          guestsAddedByEdit: null,
          store: tx,
        });
      });

    async function cancelAt(rule: (typeof TIERS)[number]["rule"]) {
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, ...rule } });
      const { cancelBooking } = await import("@/lib/booking-cancel");
      expect((await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);
    }

    const completeShare = (taskId: string, confirmedAmountCents = 5_000) =>
      resolveManualRefundTask({
        taskId, resolution: "completed", note: "Priced from the booking's own payment history.", actingMemberId: MEMBER_ID,
        confirmedAmountCents, direction: "REFUND_TO_MEMBER", recordedNightPrices: null,
      }, CLUB_FORMAT_TEST);

    /** Every Xero document this booking has asked for, oldest first. */
    async function xeroAsks() {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { localModel: true, entityType: true, operationType: true, status: true, correlationKey: true, requestPayload: true },
      });
      return rows.map((row) => {
        const payload = row.requestPayload as { queueType?: string; refundAmountCents?: number; refundMethod?: string };
        return {
          on: `${row.localModel}:${row.entityType}:${row.operationType}`,
          queueType: payload.queueType,
          cents: payload.refundAmountCents,
          refundMethod: payload.refundMethod,
          key: row.correlationKey,
        };
      });
    }
    const refundNotes = async () => (await xeroAsks()).filter((ask) => ask.queueType === "REFUND_CREDIT_NOTE");
    /** Cash that left Stripe: the provider-backed refund ledger. */
    const stripeCashOutCents = async () =>
      (await prisma.paymentRefund.aggregate({ where: { paymentId: PAYMENT_ID, status: "succeeded" }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
    /** Cash the club handed back by bank transfer: the reviews' `BANK_REFUND` lines. */
    const bankCashOutCents = async () =>
      (await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" }, select: { unitCents: true } }))
        .reduce((sum, line) => sum + line.unitCents, 0);
    const notedCents = async () => (await refundNotes()).reduce((sum, note) => sum + (note.cents ?? 0), 0);

    /** Invariant 1: nothing reaches the cancelled invoice - no edit note, no allocation, no invoice write. */
    async function expectInvoiceUntouched() {
      const asks = await xeroAsks();
      expect(asks.filter((ask) => ask.on !== "Payment:CREDIT_NOTE:CREATE")).toEqual([]);
      expect(asks.filter((ask) => !["REFUND_CREDIT_NOTE", "ACCOUNT_CREDIT_NOTE"].includes(ask.queueType ?? ""))).toEqual([]);
    }

    beforeAll(async () => {
      assertSafeCancelledRefundXeroRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ raiseEditFinancialReviewTask } = await import("@/lib/edit-financial-review"));
      ({ resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution"));
      credit = await import("@/lib/member-credit");
      outbox = await import("@/lib/xero-operation-outbox");
      const startRows = await prisma.$queryRaw<Array<{ finished_at: Date }>>`
        SELECT "finished_at" FROM "_prisma_migrations"
        WHERE "migration_name" = '20260509090000_enrich_payment_refund_ledger' AND "finished_at" IS NOT NULL
        LIMIT 1
      `;
      stripe.createdSeconds = Math.floor((startRows[0]?.finished_at ?? new Date(0)).getTime() / 1000) + 60;

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Xero", lastName: "Proof", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3880 Lodge", slug: "race-3880" } });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: 20_000, finalPriceCents: 20_000 },
      });
      await prisma.bookingGuest.create({
        data: { id: GUEST_ID, bookingId: BOOKING_ID, firstName: "Review", lastName: "Guest", ageTier: "ADULT", stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: 20_000 },
      });
      await prisma.bookingModification.create({
        data: { id: MODIFICATION_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: {} },
      });
    }, 60_000);

    let refundSpy: { mockRestore: () => void } | undefined;
    beforeEach(async () => {
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

    it.each(TIERS)("card, the REAL cancel at $tier: its refund note, then the review's own for the $owedCents cents still owed", async ({ rule, cancelBackCents, owedCents }) => {
      await paid(CARD);
      const raised = await raise("2026-08-01");
      await cancelAt(rule);
      // What the paid cancellation's card refund raises: a refund note on the payment.
      expect(await refundNotes()).toEqual([
        { on: "Payment:CREDIT_NOTE:CREATE", queueType: "REFUND_CREDIT_NOTE", cents: cancelBackCents, refundMethod: undefined, key: `payment:${PAYMENT_ID}:refund-credit-note:${cancelBackCents}:v2` },
      ]);

      await completeShare(raised.taskId);

      const reviewNotes = (await refundNotes()).slice(1);
      expect(reviewNotes).toEqual(owedCents > 0
        ? [{ on: "Payment:CREDIT_NOTE:CREATE", queueType: "REFUND_CREDIT_NOTE", cents: owedCents, refundMethod: "card", key: `payment:${PAYMENT_ID}:refund-credit-note:${owedCents}:v2:review-task:${raised.taskId}` }]
        : []);
      // Invariant 2: a document for every cent that left Stripe.
      expect(await stripeCashOutCents()).toBe(cancelBackCents + owedCents);
      expect(await notedCents()).toBe(await stripeCashOutCents());
      await expectInvoiceUntouched();
    });

    it.each(TIERS)("bank transfer, the REAL cancel at $tier credits the member, then the review hands back $owedCents cents: a bank-transfer refund note for exactly that", async ({ rule, owedCents }) => {
      await paid(BANK);
      const raised = await raise("2026-08-01");
      await cancelAt(rule);
      // The cancellation returned account credit, so its document is the account note.
      expect((await xeroAsks()).map((ask) => ask.queueType)).toEqual(["ACCOUNT_CREDIT_NOTE"]);

      await completeShare(raised.taskId);

      expect(await refundNotes()).toEqual(owedCents > 0
        ? [{ on: "Payment:CREDIT_NOTE:CREATE", queueType: "REFUND_CREDIT_NOTE", cents: owedCents, refundMethod: "internet-banking", key: `payment:${PAYMENT_ID}:refund-credit-note:${owedCents}:v2:review-task:${raised.taskId}` }]
        : []);
      expect(await notedCents()).toBe(await bankCashOutCents());
      await expectInvoiceUntouched();
    });

    it("two $20 reviews after the REAL card cancel at 50% less $20: a $10 note each, neither folded into the other", async () => {
      await paid(CARD);
      const first = await raise("2026-08-01");
      const second = await raise("2026-08-02");
      await cancelAt(TIERS[1]!.rule);
      await completeShare(first.taskId, 2_000);
      await completeShare(second.taskId, 2_000);

      // The watermark counts only notes Xero has raised, so with all three still
      // queued the two reviews' watermarks are equal: the task is what keeps them apart.
      expect((await refundNotes()).map((note) => [note.cents, note.key])).toEqual([
        [8_000, `payment:${PAYMENT_ID}:refund-credit-note:8000:v2`],
        [1_000, `payment:${PAYMENT_ID}:refund-credit-note:1000:v2:review-task:${first.taskId}`],
        [1_000, `payment:${PAYMENT_ID}:refund-credit-note:1000:v2:review-task:${second.taskId}`],
      ]);
      expect(await notedCents()).toBe(await stripeCashOutCents());
    });

    it("two $20 reviews after the REAL bank-transfer cancel at 50% less $20: a $10 hand-back note each on the one payment", async () => {
      await paid(BANK);
      const first = await raise("2026-08-01");
      const second = await raise("2026-08-02");
      await cancelAt(TIERS[1]!.rule);
      await completeShare(first.taskId, 2_000);
      await completeShare(second.taskId, 2_000);

      expect((await refundNotes()).map((note) => [note.cents, note.refundMethod, note.key])).toEqual([
        [1_000, "internet-banking", `payment:${PAYMENT_ID}:refund-credit-note:1000:v2:review-task:${first.taskId}`],
        [1_000, "internet-banking", `payment:${PAYMENT_ID}:refund-credit-note:1000:v2:review-task:${second.taskId}`],
      ]);
      expect(await notedCents()).toBe(await bankCashOutCents());
    });

    it("$150 credit + $50 card at 50%, a $100 review: the card's $25 is noted; the $25 of credit given back is noteless, as the cancellation's restore is (#2717)", async () => {
      await paid({ cardCents: 5_000, appliedCents: 15_000, source: "STRIPE" });
      const raised = await raise("2026-08-01");
      await cancelAt({ refundPercentage: 50, fixedFeeCents: 0 });

      await completeShare(raised.taskId, 10_000);

      expect((await refundNotes()).map((note) => note.cents)).toEqual([2_500, 2_500]);
      expect(await notedCents()).toBe(await stripeCashOutCents());
      // Invariant 3: the member's app credit is $100 - $75 restored by the cancel,
      // $25 given back by the review - and both are noteless rows, minted a note
      // when spent (#2717), so Xero's credit is the app's less exactly these.
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(10_000);
      const noteless = await prisma.memberCredit.findMany({
        where: { memberId: MEMBER_ID, amountCents: { gt: 0 }, type: { not: "ADMIN_ADJUSTMENT" }, xeroCreditNoteId: null },
        select: { amountCents: true },
        orderBy: { createdAt: "asc" },
      });
      expect(noteless.map((row) => row.amountCents).sort((a, b) => a - b)).toEqual([2_500, 7_500]);
      // And nothing deallocated: the cancelled invoice keeps its credit.
      await expectInvoiceUntouched();
    });

    /**
     * L1 of the #3880 review: two sibling hand-backs' rows, both queued at
     * watermark $10 (nothing was recorded when either enqueued), raced through
     * the REAL worker and `createXeroCreditNote` against a Xero that dedupes on
     * the idempotency key as Xero does. The first row is held inside its Xero
     * create; the second is claimed by another worker meanwhile.
     */
    it("two sibling bank hand-backs raced through the real worker: the second waits for the first's note, then sizes past it - two notes for the $20", async () => {
      await paid(BANK);
      const first = await raise("2026-08-01");
      const second = await raise("2026-08-02");
      await cancelAt(TIERS[1]!.rule);
      await completeShare(first.taskId, 2_000);
      await completeShare(second.taskId, 2_000);
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localId: PAYMENT_ID, queueType: "REFUND_CREDIT_NOTE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(rows.map((row) => (row.requestPayload as { watermarkCents: number }).watermarkCents)).toEqual([1_000, 1_000]);

      // The worker takes the oldest PENDING rows of every kind; anything not
      // this race's (the cancel's account note, another suite's leftovers) is
      // parked for the duration and put back.
      const parked = await prisma.xeroSyncOperation.findMany({
        where: { status: "PENDING", id: { notIn: rows.map((row) => row.id) } },
        select: { id: true },
      });
      await prisma.xeroSyncOperation.updateMany({ where: { id: { in: parked.map((row) => row.id) } }, data: { status: "PARKED_RACE_3880" } });

      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const firstCreateEntered = new Promise<void>((resolve) => { entered = resolve; });
      let holdNext = true;
      const notesByKey = new Map<string, { creditNoteID: string; creditNoteNumber: string; total: number }>();
      const xero = {
        accountingApi: {
          createCreditNotes: async (_tenant: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }, _s?: unknown, _u?: unknown, key?: string) => {
            let note = notesByKey.get(key!);
            if (!note) {
              note = { creditNoteID: `cn-race-3880-${notesByKey.size + 1}`, creditNoteNumber: `CN-3880-${notesByKey.size + 1}`, total: body.creditNotes[0]!.lineItems[0]!.unitAmount };
              notesByKey.set(key!, note);
              if (holdNext) {
                holdNext = false;
                entered();
                await held;
              }
            }
            return { body: { creditNotes: [note] } };
          },
          createPayments: async (_tenant: string, body: { payments: Array<{ amount: number }> }) => ({
            body: { payments: [{ paymentID: `pay-race-3880-${notesByKey.size}`, amount: body.payments[0]!.amount }] },
          }),
        },
      };
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-3880" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-3880"),
        vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
          options.run({ contactId: options.currentContactId })) as never),
      ];
      try {
        const workerA = outbox.processQueuedXeroOutboxOperations({ limit: 1 });
        await firstCreateEntered;
        // Worker B, while A is inside Xero with its note unrecorded.
        const workerB = await outbox.processQueuedXeroOutboxOperations({ limit: 5 });
        expect(workerB).toMatchObject({ found: 1, succeeded: 0, failed: 0, skipped: 1 });
        expect((await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: rows[1]!.id } })).status).toBe("PENDING");
        release();
        expect(await workerA).toMatchObject({ found: 1, succeeded: 1 });
        // The next scan raises the waiting row past the recorded note.
        expect(await outbox.processQueuedXeroOutboxOperations({ limit: 5 })).toMatchObject({ found: 1, succeeded: 1 });
      } finally {
        release();
        for (const spy of spies) spy.mockRestore();
        await prisma.xeroSyncOperation.updateMany({ where: { id: { in: parked.map((row) => row.id) } }, data: { status: "PENDING" } });
      }

      const done = await prisma.xeroSyncOperation.findMany({ where: { id: { in: rows.map((row) => row.id) } }, orderBy: { createdAt: "asc" } });
      expect(done.map((row) => row.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
      expect(new Set(done.map((row) => row.xeroObjectId)).size).toBe(2);
      const links = await prisma.xeroObjectLink.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE", active: true },
        // Frozen clock: the note ids, numbered as Xero raised them, order the links.
        orderBy: { xeroObjectId: "asc" },
      });
      expect(links.map((link) => (link.metadata as { amountCents: number; watermarkCents: number }))).toEqual([
        expect.objectContaining({ amountCents: 1_000, watermarkCents: 1_000 }),
        expect.objectContaining({ amountCents: 1_000, watermarkCents: 2_000 }),
      ]);
      expect([...notesByKey.values()].map((note) => note.total)).toEqual([10, 10]);
      expect(links.reduce((sum, link) => sum + (link.metadata as { amountCents: number }).amountCents, 0)).toBe(await bankCashOutCents());
    });

    it("the hand-back's note is queued inside the completion: a completion that fails after it leaves no row, no hand-back and the task OPEN", async () => {
      await paid(BANK);
      const raised = await raise("2026-08-01");
      await cancelAt(TIERS[1]!.rule);
      const audit = await import("@/lib/manual-refund-task-audit");
      const failing = vi.spyOn(audit, "recordManualRefundTaskClosureAudit").mockRejectedValueOnce(new Error("race 3880: the completion fails after the enqueue"));
      try {
        await expect(completeShare(raised.taskId)).rejects.toThrow("race 3880");
      } finally {
        failing.mockRestore();
      }

      expect(await refundNotes()).toEqual([]);
      expect(await bankCashOutCents()).toBe(0);
      expect((await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: raised.taskId } })).status).toBe("OPEN");

      // And the completion that commits carries its row with it.
      await completeShare(raised.taskId);
      expect((await refundNotes()).map((note) => [note.cents, note.refundMethod])).toEqual([[2_500, "internet-banking"]]);
      expect(await notedCents()).toBe(await bankCashOutCents());
    });

    /**
     * A Xero that answers as Xero does for the duration of `run`: one note per
     * idempotency key, read back by id, and a refund payment that settles it.
     * `failCreate` / `failPayment` refuse a call while they answer true. Every
     * PENDING row not this booking's is parked for the duration and put back.
     */
    async function withFakeXero<T>(
      behaviour: { failCreate?: () => boolean; failPayment?: (creditNoteId: string) => boolean },
      run: (fake: { keys: string[]; noteIds: () => string[] }) => Promise<T>,
    ): Promise<T> {
      type Note = { creditNoteID: string; creditNoteNumber: string; total: number; remainingCredit: number; status: string; payments: Array<{ paymentID: string; amount: number; status: string }> };
      const byKey = new Map<string, Note>();
      const byId = new Map<string, Note>();
      const keys: string[] = [];
      const xero = {
        accountingApi: {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }, _s?: unknown, _u?: unknown, key?: string) => {
            if (behaviour.failCreate?.()) throw new Error("race 3880: Xero refused the credit note");
            keys.push(key!);
            let note = byKey.get(key!);
            if (!note) {
              const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
              note = { creditNoteID: `cn-race-3880-${byKey.size + 1}`, creditNoteNumber: `CN-3880-${byKey.size + 1}`, total, remainingCredit: total, status: "AUTHORISED", payments: [] };
              byKey.set(key!, note);
              byId.set(note.creditNoteID, note);
            }
            return { body: { creditNotes: [note] } };
          },
          getCreditNote: async (_t: string, id: string) => ({ body: { creditNotes: byId.has(id) ? [byId.get(id)!] : [] } }),
          createPayments: async (_t: string, body: { payments: Array<{ amount: number; creditNote: { creditNoteID: string } }> }) => {
            const { amount, creditNote } = body.payments[0]!;
            if (behaviour.failPayment?.(creditNote.creditNoteID)) throw new Error("race 3880: Xero refused the refund payment");
            const note = byId.get(creditNote.creditNoteID)!;
            const payment = { paymentID: `pay-${creditNote.creditNoteID}`, amount, status: "AUTHORISED" };
            note.payments = [payment];
            note.remainingCredit = 0;
            note.status = "PAID";
            return { body: { payments: [payment] } };
          },
        },
      };
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-3880" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-3880"),
        vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
          options.run({ contactId: options.currentContactId })) as never),
        // The club's bank-transfer refund account is mapped, so a hand-back's note is paid from it.
        vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "record", bankCode: "090" }),
      ];
      try {
        return await run({ keys, noteIds: () => [...byId.keys()] });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /** The real worker, on this one row: every other PENDING row is parked meanwhile and put back. */
    async function processOnly(rowId: string) {
      const parked = await prisma.xeroSyncOperation.findMany({ where: { status: "PENDING", id: { not: rowId } }, select: { id: true } });
      await prisma.xeroSyncOperation.updateMany({ where: { id: { in: parked.map((row) => row.id) } }, data: { status: "PARKED_RACE_3880" } });
      try {
        return await outbox.processQueuedXeroOutboxOperations({ limit: 1 });
      } finally {
        await prisma.xeroSyncOperation.updateMany({ where: { id: { in: parked.map((row) => row.id) } }, data: { status: "PENDING" } });
      }
    }
    /** The payment's one queued refund-note row: the review's (`reviewTaskId`) or the cancellation's. */
    async function refundNoteRow(review: boolean) {
      const rows = await prisma.xeroSyncOperation.findMany({ where: { localId: PAYMENT_ID, queueType: "REFUND_CREDIT_NOTE" } });
      const matching = rows.filter((row) => Boolean((row.requestPayload as { reviewTaskId?: string }).reviewTaskId) === review);
      expect(matching).toHaveLength(1);
      return matching[0]!;
    }

    /** A `CANCELLED_BOOKING_HAND_BACK` (#3529) of `cents`, completed through the REAL resolver. */
    async function completeCancellationHandBack(cents: number) {
      const task = await prisma.manualRefundTask.create({
        data: { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: cents, raisedAmountCents: cents, reason: "race 3880 cancellation hand-back" },
      });
      await resolveManualRefundTask({
        taskId: task.id, resolution: "completed", note: null, actingMemberId: MEMBER_ID,
        confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null,
      }, CLUB_FORMAT_TEST);
      return task.id;
    }

    const coveredCents = async () => {
      const fences = await import("@/lib/xero-resolved-in-xero-fences");
      return fences.sumRefundCreditNoteCoverageCents(PAYMENT_ID, await fences.readResolvedRefundCreditNoteCoverage(PAYMENT_ID));
    };
    const refundNoteLinks = () =>
      prisma.xeroObjectLink.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE" },
        // The test clock is frozen, so the notes' ids, numbered as Xero raised them, order them.
        orderBy: { xeroObjectId: "asc" },
        select: { xeroObjectId: true, active: true, metadata: true },
      });
    const refundNoteField = async () => (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).xeroRefundCreditNoteId;

    it("F4: a cancellation hand-back's note is queued inside its completion - a completion that fails after it leaves no row and the task OPEN", async () => {
      await paid(BANK);
      await cancelAt(TIERS[1]!.rule);
      const refundedBefore = (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).refundedAmountCents;
      const audit = await import("@/lib/manual-refund-task-audit");
      const failing = vi.spyOn(audit, "recordManualRefundTaskClosureAudit").mockRejectedValueOnce(new Error("race 3880: the completion fails after the enqueue"));
      try {
        await expect(completeCancellationHandBack(5_000)).rejects.toThrow("race 3880");
      } finally {
        failing.mockRestore();
      }
      expect(await refundNotes()).toEqual([]);
      expect((await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID, kind: "CANCELLED_BOOKING_HAND_BACK" } })).status).toBe("OPEN");
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).refundedAmountCents).toBe(refundedBefore);

      // And the completion that commits carries its row with it.
      await resolveManualRefundTask({
        taskId: (await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID, kind: "CANCELLED_BOOKING_HAND_BACK" } })).id,
        resolution: "completed", note: null, actingMemberId: MEMBER_ID,
        confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null,
      }, CLUB_FORMAT_TEST);
      expect((await refundNotes()).map((note) => [note.cents, note.refundMethod])).toEqual([[5_000, "internet-banking"]]);
    });

    /**
     * F1 of the #3880 concurrency review. A bank payment carries the
     * cancellation hand-back's note H ($50, canonical) and a review's per-refund
     * note D ($25) whose refund payment failed. The operator's retry repairs D;
     * Xero's inbound reconcile then re-reads H. Before the fix the retry pointed
     * `xeroRefundCreditNoteId` at D, the reconcile wrote H's link inactive, the
     * coverage read $25 for $75 of cash, and the next refund run raised another
     * $50 - $125 of notes for $75 of cash.
     */
    it("F1: a repaired per-refund note never becomes the payment's canonical one, and the cancellation's note stays counted", async () => {
      await paid(BANK);
      const raised = await raise("2026-08-01");
      await cancelAt(TIERS[1]!.rule);
      const retry = await import("@/lib/xero-operation-retry");
      const inbound = await import("@/lib/xero-inbound/credit-note");
      let refusePaymentFor: string | null = null;
      await withFakeXero({ failPayment: (id) => id === refusePaymentFor }, async ({ noteIds }) => {
        // The cancellation's hand-back: its note H raised and paid, the canonical one.
        await completeCancellationHandBack(5_000);
        expect(await processOnly((await refundNoteRow(false)).id)).toMatchObject({ succeeded: 1 });
        const [h] = noteIds();
        expect(await refundNoteField()).toBe(h);

        // The review's hand-back: D raised, its refund payment refused - PARTIAL.
        await completeShare(raised.taskId);
        const reviewRow = await refundNoteRow(true);
        expect(reviewRow.requestPayload).toMatchObject({ refundAmountCents: 2_500, watermarkCents: 7_500, refundMethod: "internet-banking" });
        expect(reviewRow.correlationKey).toBe(`payment:${PAYMENT_ID}:refund-credit-note:7500:v2:review-task:${raised.taskId}`);
        refusePaymentFor = "cn-race-3880-2";
        await processOnly(reviewRow.id);
        const d = noteIds()[1]!;
        expect(d).toBe("cn-race-3880-2");
        expect(await refundNoteField()).toBe(h);
        const dRow = await prisma.xeroSyncOperation.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: d } });
        expect(dRow.status).toBe("PARTIAL");
        expect(dRow.requestPayload).toMatchObject({ perDelta: true, reviewTaskId: raised.taskId });
        const cashOut = await bankCashOutCents();
        expect(cashOut).toBe(7_500);

        // The operator's retry repairs D's refund payment - and leaves the field on H.
        refusePaymentFor = null;
        await retry.retryXeroSyncOperation(dRow.id, CLUB_FORMAT_TEST);
        expect((await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: dRow.id } })).status).toBe("SUCCEEDED");
        expect(await refundNoteField()).toBe(h);

        // Inbound re-reads H: still active, still counted.
        await inbound.reconcileXeroCreditNote(h!);
        expect((await refundNoteLinks()).map((link) => [link.xeroObjectId, link.active])).toEqual([[h, true], [d, true]]);
        expect(await coveredCents()).toBe(cashOut);

        // A field an older writer pointed at D (this deploy rolled back and
        // forward) is read as no canonical note: H's re-read keeps H counted.
        await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroRefundCreditNoteId: d } });
        await inbound.reconcileXeroCreditNote(h!);
        expect((await refundNoteLinks()).map((link) => [link.xeroObjectId, link.active])).toEqual([[h, true], [d, true]]);
        expect(await coveredCents()).toBe(cashOut);

        // The rollback note's list and repair (docs/xero/ARCHITECTURE.md, #3880),
        // as written there: D is listed, and a D the old code switched off is
        // counted again once set active by hand.
        const listed: unknown = await prisma.$queryRaw`SELECT "localId", "xeroObjectId", active FROM "XeroObjectLink" WHERE role = 'REFUND_CREDIT_NOTE' AND metadata->>'perDelta' = 'true'`;
        expect((listed as Array<Record<string, unknown>>).filter((row) => row.localId === PAYMENT_ID)).toEqual([{ localId: PAYMENT_ID, xeroObjectId: d, active: true }]);
        await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID, xeroObjectId: d }, data: { active: false } });
        expect(await coveredCents()).toBe(5_000);
        await prisma.$executeRaw`UPDATE "XeroObjectLink" SET active = true WHERE role = 'REFUND_CREDIT_NOTE' AND "localId" = ${PAYMENT_ID} AND "xeroObjectId" = ${d}`;
        expect(await coveredCents()).toBe(cashOut);
      });

      // Every cent has its document, so the next refund run on the payment raises nothing.
      const next = await outbox.enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 5_000, { refundMethod: "internet-banking", reviewTaskId: "race-3880-next-review" });
      expect(next.queueOperationId).toBeNull();
    });

    /**
     * F2 of the #3880 concurrency review. A review's row fails before Xero
     * raises anything; the operator's retry runs inline under a row it creates
     * itself (no outbox queue type), and that fails too. Retrying THAT row must
     * still raise the review's own $25 note - not call the cancellation's $50
     * note its cover, and not raise a single-note `v1` note.
     */
    it("F2: a retry of the retry's own failed row stays in delta mode and raises the review's per-refund note", async () => {
      await paid(BANK);
      const raised = await raise("2026-08-01");
      await cancelAt(TIERS[1]!.rule);
      const retry = await import("@/lib/xero-operation-retry");
      let refuseCreate = false;
      await withFakeXero({ failCreate: () => refuseCreate }, async ({ keys, noteIds }) => {
        await completeCancellationHandBack(5_000);
        expect(await processOnly((await refundNoteRow(false)).id)).toMatchObject({ succeeded: 1 });
        const [h] = noteIds();
        await completeShare(raised.taskId);
        refuseCreate = true;
        const reviewRow = await refundNoteRow(true);
        await processOnly(reviewRow.id);
        expect((await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: reviewRow.id } })).status).toBe("FAILED");

        // The operator's retry runs inline, under a row of its own, and fails.
        await expect(retry.retryXeroSyncOperation(reviewRow.id, CLUB_FORMAT_TEST)).rejects.toThrow("race 3880");
        const inline = await prisma.xeroSyncOperation.findFirstOrThrow({
          where: { localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE", queueType: null, status: "FAILED" },
        });
        expect(inline.requestPayload).toMatchObject({ watermarkCents: 7_500, perDelta: true, reviewTaskId: raised.taskId });
        // The rollback note's step (1) list (docs/xero/ARCHITECTURE.md, #3880), as
        // written there: the inline row with no queue type is listed beside the queued one.
        const unfinished: unknown = await prisma.$queryRaw`SELECT id, "queueType", status FROM "XeroSyncOperation" WHERE "localModel" = 'Payment' AND "entityType" = 'CREDIT_NOTE' AND "requestPayload"->>'reviewTaskId' IS NOT NULL AND status IN ('PENDING', 'RUNNING', 'FAILED', 'PARTIAL')`;
        expect(new Set((unfinished as Array<{ id: string }>).map((row) => row.id))).toEqual(new Set([reviewRow.id, inline.id]));

        // Retrying the inline row raises the review's own note.
        refuseCreate = false;
        await retry.retryXeroSyncOperation(inline.id, CLUB_FORMAT_TEST);
        expect(noteIds()).toHaveLength(2);
        expect(keys.at(-1)).toMatch(/:v2$/);
        expect(await refundNoteField()).toBe(h);
        const links = await refundNoteLinks();
        expect(links.map((link) => [link.active, (link.metadata as { amountCents: number; perDelta?: boolean }).amountCents, (link.metadata as { perDelta?: boolean }).perDelta ?? false]))
          .toEqual([[true, 5_000, false], [true, 2_500, true]]);
      });
      expect(await coveredCents()).toBe(await bankCashOutCents());
    });

    /**
     * Round 3 of the #3880 review. The daily `xero-link-cleanup` once exempted
     * only Stripe per-delta links, so on a bank payment a review's per-refund
     * note D - never the field's note - was deactivated every night, coverage
     * under-read, and inbound reconcile (which reaches only active links) never
     * brought it back. The drift report listed D as stale.
     */
    it("round 3: the daily link cleanup and the drift report keep a bank payment's per-refund note, and still retire a VOIDED one", async () => {
      await paid(BANK);
      const raised = await raise("2026-08-01");
      await cancelAt(TIERS[1]!.rule);
      const ids = await withFakeXero({}, async ({ noteIds }) => {
        await completeCancellationHandBack(5_000);
        expect(await processOnly((await refundNoteRow(false)).id)).toMatchObject({ succeeded: 1 });
        await completeShare(raised.taskId);
        expect(await processOnly((await refundNoteRow(true)).id)).toMatchObject({ succeeded: 1 });
        return noteIds();
      });
      const [h, d] = ids;
      expect(await refundNoteField()).toBe(h);
      const cashOut = await bankCashOutCents();
      expect(cashOut).toBe(7_500);
      expect(await coveredCents()).toBe(cashOut);

      const { cleanupStaleCanonicalXeroObjectLinks } = await import("@/lib/xero-hardening-canonical-links");
      const { buildXeroReconciliationReport } = await import("@/lib/xero-hardening-report");
      const driftOnPayment = async () =>
        (await buildXeroReconciliationReport(CLUB_FORMAT_TEST)).issueSections
          .filter((section) => section.id === "canonical-link-drift")
          .flatMap((section) => section.items)
          // The fixture's invoice has no link row; only the refund notes are judged here.
          .filter((item) => item.localId === PAYMENT_ID && item.xeroObjectType === "CREDIT_NOTE")
          .map((item) => item.xeroObjectId);

      // Live: both notes stay active and counted, and the report names neither.
      await cleanupStaleCanonicalXeroObjectLinks();
      expect((await refundNoteLinks()).map((link) => [link.xeroObjectId, link.active])).toEqual([[h, true], [d, true]]);
      expect(await coveredCents()).toBe(cashOut);
      expect(await driftOnPayment()).toEqual([]);

      // H's link lost: H is missing - and D, a sibling, is not "the active
      // link" the field disagrees with, so no mismatch is reported beside it.
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID, xeroObjectId: h }, data: { active: false } });
      expect(await driftOnPayment()).toEqual([h]);
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID, xeroObjectId: h }, data: { active: true } });

      // VOIDED in Xero: D's mirror is stale drift - reported, then deactivated.
      const dLink = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: d } });
      await prisma.xeroObjectLink.update({ where: { id: dLink.id }, data: { metadata: { ...(dLink.metadata as Record<string, unknown>), status: "VOIDED" } } });
      expect(await driftOnPayment()).toEqual([d]);
      await cleanupStaleCanonicalXeroObjectLinks();
      expect((await refundNoteLinks()).map((link) => [link.xeroObjectId, link.active])).toEqual([[h, true], [d, false]]);
    });

    /**
     * Round 3 of the #3880 review. The booking-repair pass read the refund-note
     * gap for Stripe payments only, and a per-refund note is never the
     * canonical note it resolves - so a cancelled bank booking documented only
     * by a review's per-refund note fell into the missing-refund-note arm on
     * every scan: here, beside the cancellation's account credit, a spurious
     * "ambiguous" manual review; without credit, a critical ask for the cash.
     */
    it("round 3: the booking repair finds nothing missing on a cancelled bank booking its per-refund note covers, and still flags a real gap", async () => {
      await paid(BANK);
      const raised = await raise("2026-08-01");
      await cancelAt(TIERS[1]!.rule);
      await withFakeXero({}, async () => {
        await completeShare(raised.taskId);
        expect(await processOnly((await refundNoteRow(true)).id)).toMatchObject({ succeeded: 1 });
      });
      const links = await refundNoteLinks();
      expect(links.map((link) => [link.active, (link.metadata as { amountCents: number; perDelta?: boolean }).amountCents, (link.metadata as { perDelta?: boolean }).perDelta]))
        .toEqual([[true, 2_500, true]]);
      expect(await refundNoteField()).toBeNull();

      const { runBookingXeroRepair } = await import("@/lib/xero-booking-repair");
      const missingNote = async () => {
        const booking = (await runBookingXeroRepair(CLUB_FORMAT_TEST, { scope: { bookingId: BOOKING_ID } })).passes[0]!.bookings[0]!;
        return [
          ...booking.actions.filter((action) => action.type === "QUEUE_REFUND_CREDIT_NOTE").map((action) => action.type),
          ...booking.findings
            .filter((finding) => finding.code === "CANCELLED_BOOKING_OPEN_INVOICE" || /missing Xero (cancellation credit|refund) note amount/.test(finding.summary))
            .map((finding) => finding.code),
        ];
      };
      // The cash the cancellation handed back as account credit is the account
      // note's; the review's $25 of bank cash is its per-refund note's: covered.
      expect(await missingNote()).toEqual([]);

      // A per-refund note that answers $10 of the $25 leaves a real gap, still flagged.
      await prisma.xeroObjectLink.updateMany({
        where: { localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE" },
        data: { metadata: { ...(links[0]!.metadata as Record<string, unknown>), amountCents: 1_000 } },
      });
      expect(await missingNote()).not.toEqual([]);
    });

    it("a replay of the review's note while queued, or after Xero raised it, raises nothing more", async () => {
      await paid(CARD);
      const raised = await raise("2026-08-01");
      await cancelAt(TIERS[1]!.rule);
      await completeShare(raised.taskId);
      const before = await refundNotes();
      expect(before).toHaveLength(2);

      // Replayed while queued: the PENDING row answers.
      const queued = await outbox.enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 2_500, { refundMethod: "card", reviewTaskId: raised.taskId });
      expect(queued.queueOperationId).not.toBeNull();
      expect(await refundNotes()).toEqual(before);

      // The worker raised both: their links cover the cash, so a replay sizes to nothing.
      const ops = await prisma.xeroSyncOperation.findMany({ where: { localId: PAYMENT_ID }, orderBy: { createdAt: "asc" } });
      for (const [index, op] of ops.entries()) {
        const cents = (op.requestPayload as { refundAmountCents: number }).refundAmountCents;
        await prisma.xeroSyncOperation.update({ where: { id: op.id }, data: { status: "SUCCEEDED" } });
        await prisma.xeroObjectLink.create({
          data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: `race-3880-cn-${index}`, role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: cents } },
        });
      }
      const replayed = await outbox.enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 2_500, { refundMethod: "card", reviewTaskId: raised.taskId });
      expect(replayed.queueOperationId).toBeNull();
      expect(await refundNotes()).toEqual(before);
    });
  },
);
