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
