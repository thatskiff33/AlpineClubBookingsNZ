/**
 * Real-PostgreSQL proof of #3835: a review completed AFTER the REAL
 * `cancelBooking` on a captured payment gives back only what the cancellation's
 * refund left owed (owner decision 2 on #3791).
 *
 * The issue's worked example - $200, a $50 share - paid by card and by credit
 * plus card ($100 each), cancelled at 100%, at 50% with a $20 fee and at 0%,
 * then completed through the REAL `resolveManualRefundTask` on the Stripe
 * route; one case on the account-credit route that mints against the payment;
 * and two sibling reviews. What the member gets back is read from the rows the
 * app wrote: each refund's frozen Stripe debt (its recovery operation, which the
 * inline call and every replay send byte for byte) and the member's credit.
 *
 * No Stripe call leaves this process. The operational key resolver answers
 * "unconfigured" while this file runs, so each refund stays the PENDING debt a
 * recovery replay would send; every other suite in the #1881 harness sees the
 * real resolver.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-3835-`
 * fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import type { CalendarDate } from "@/lib/club-time";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3835-member";
const LODGE_ID = "race-3835-lodge";
const BOOKING_ID = "race-3835-booking";
const GUEST_ID = "race-3835-guest";
const MODIFICATION_ID = "race-3835-modification";
const PAYMENT_ID = "race-3835-payment";
const TRANSACTION_ID = "race-3835-txn";
const INTENT_ID = "pi_race_3835";
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Unconfigured only while this file runs; a pass-through for the rest of the harness. */
const stripeKey = vi.hoisted(() => ({ unconfigured: false }));
vi.mock("@/lib/stripe-config", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/stripe-config");
  return {
    ...actual,
    getOperationalStripeSecretKey: () =>
      stripeKey.unconfigured ? Promise.resolve(undefined) : actual.getOperationalStripeSecretKey(),
  };
});

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeCapturedCancelRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Captured-cancel review proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run captured-cancel review proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Captured-cancel review proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Captured-cancel review proof DB name must contain 'concurrency_race_1881'.");
  }
}

const TIERS = [
  { tier: "100%", rule: { refundPercentage: 100, fixedFeeCents: 0 }, owedCents: 0, totalBackCents: 20_000 },
  { tier: "50% with a $20 fee", rule: { refundPercentage: 50, fixedFeeCents: 2_000 }, owedCents: 2_500, totalBackCents: 10_500 },
  { tier: "0%", rule: { refundPercentage: 0, fixedFeeCents: 0 }, owedCents: 5_000, totalBackCents: 5_000 },
];
const PAYMENTS = [
  { paid: "card", cardCents: 20_000, appliedCents: 0, source: "STRIPE" as const },
  { paid: "credit plus card", cardCents: 10_000, appliedCents: 10_000, source: "STRIPE" as const },
];
/** Paid by bank transfer: the cancellation returns account credit (#3527 D2), the review hands back by hand. */
const BANK_PAYMENTS = [
  { paid: "internet banking", cardCents: 20_000, appliedCents: 0, source: "INTERNET_BANKING" as const },
  { paid: "credit plus internet banking", cardCents: 10_000, appliedCents: 10_000, source: "INTERNET_BANKING" as const },
];
type Tier = (typeof TIERS)[number];

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let raiseEditFinancialReviewTask: (typeof import("@/lib/edit-financial-review"))["raiseEditFinancialReviewTask"];
let resolveManualRefundTask: (typeof import("@/lib/manual-refund-task-resolution"))["resolveManualRefundTask"];
let credit: typeof import("@/lib/member-credit");
let previewEditReviewStillOwed: (typeof import("@/lib/edit-financial-review-still-owed"))["previewEditReviewStillOwed"];
let payments: typeof import("@/lib/payment-transactions");
let censusStore: typeof import("@/lib/booking-ledger-projection-census-store");
/** When the refund ledger began, so a recorded refund is dated after it. */
let ledgerStartSeconds = 0;

/**
 * What the settle dialog shows before completing, through the dialog's own
 * server read - which must be the figure the completion then settles.
 */
async function dialogSays(taskId: string, shareCents = 5_000) {
  const { readClubTimeZoneOutsideRequest } = await import("@/lib/club-time-zone-runtime");
  return previewEditReviewStillOwed({ taskId, shareCents, clubZone: await readClubTimeZoneOutsideRequest(), format: CLUB_FORMAT_TEST });
}

(RUN ? describe : describe.skip)(
  "a review completed after the REAL cancel of a captured payment nets its share - real PostgreSQL (#3835)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [MODIFICATION_ID, BOOKING_ID, PAYMENT_ID] } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({
        where: { OR: [{ memberId: MEMBER_ID }, { actorMemberId: MEMBER_ID }, { targetId: { in: [BOOKING_ID, MODIFICATION_ID] } }] },
      });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID, id: { not: MODIFICATION_ID } } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuestId: GUEST_ID } });
      await prisma.bookingGuest.updateMany({ where: { id: GUEST_ID }, data: { priceCents: 20_000 } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.bookingModification.deleteMany({ where: { id: MODIFICATION_ID } });
      await prisma.bookingGuest.deleteMany({ where: { id: GUEST_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** A $200 booking, paid: the card capture, and any credit applied through the real writer. */
    async function paid({ cardCents, appliedCents, source }: (typeof PAYMENTS | typeof BANK_PAYMENTS)[number]) {
      const intentId = source === "STRIPE" ? INTENT_ID : null;
      await clearRun();
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAID", totalPriceCents: 20_000, finalPriceCents: 20_000 } });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: cardCents,
          creditAppliedCents: appliedCents,
          source,
          status: "SUCCEEDED",
          stripePaymentIntentId: intentId,
          transactions: {
            create: { id: TRANSACTION_ID, kind: "PRIMARY", source, stripePaymentIntentId: intentId, amountCents: cardCents, status: "SUCCEEDED" },
          },
        },
      });
      // The stay on the booking ledger, one line a night, as a confirmation posts it (#3527).
      const nights = [CHECK_IN, new Date("2026-08-02T00:00:00.000Z")];
      for (const [index, night] of nights.entries()) {
        await prisma.bookingLedgerLine.create({ data: {
          bookingId: BOOKING_ID, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: 10_000, amountCents: 10_000,
          bookingGuestId: GUEST_ID, nightStart: night, nightEndExclusive: nights[index + 1] ?? CHECK_OUT, ageTier: "ADULT",
          guestNames: ["Review Guest"], anchorKind: "CONFIRMATION", anchorId: BOOKING_ID, narration: "race 3835 confirmation",
          lodgeId: LODGE_ID, postingKey: `race-3835-confirm-${index}`,
        } });
      }
      if (appliedCents > 0) {
        await prisma.memberCredit.create({
          data: { memberId: MEMBER_ID, amountCents: appliedCents, type: "ADMIN_ADJUSTMENT", description: "race 3835 opening balance" },
        });
        await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, appliedCents, BOOKING_ID, tx, CLUB_FORMAT_TEST));
      }
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(0);
    }

    /** A review of the edit, raised while the card money was in (the task carries the payment). */
    const raise = (night: string, paymentId: string | null = PAYMENT_ID) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        return raiseEditFinancialReviewTask({
          occurrence: {
            bookingId: BOOKING_ID,
            bookingGuestId: GUEST_ID,
            cause: "NO_STORED_NIGHT_PRICES",
            surrenderedNightDates: [night as CalendarDate],
            addedNightDates: [],
            storedEvidence: { guestTotalCents: null, nightPrices: [] },
          },
          guestMemberId: MEMBER_ID,
          bookingCheckIn: "2026-08-01" as CalendarDate,
          bookingCheckOut: "2026-08-03" as CalendarDate,
          bookingModificationId: MODIFICATION_ID,
          paymentId,
          guestsAddedByEdit: null,
          store: tx,
        });
      });

    async function cancelAt(rule: Tier["rule"]) {
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, ...rule } });
      const { cancelBooking } = await import("@/lib/booking-cancel");
      const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
      expect(result.status).toBe(200);
    }

    const completeShare = (taskId: string, confirmedAmountCents = 5_000) =>
      resolveManualRefundTask({
        taskId,
        resolution: "completed",
        note: "Priced from the booking's own payment history.",
        actingMemberId: MEMBER_ID,
        confirmedAmountCents,
        direction: "REFUND_TO_MEMBER",
        recordedNightPrices: null,
      }, CLUB_FORMAT_TEST);

    /** The card refund each completed step froze for Stripe, in order. */
    const cardDebts = async () =>
      (await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING_ID }, orderBy: { createdAt: "asc" }, select: { amountCents: true, idempotencyKey: true } }));
    /** What reviews handed back by bank transfer, as their `BANK_REFUND` lines record it. */
    const handBacks = () =>
      prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND", anchorKind: "REVIEW_TASK" }, select: { unitCents: true, anchorId: true } });
    /** Everything the member has back: card refunds owed to the card, hand-backs, and credit. */
    const totalBackCents = async () =>
      (await cardDebts()).reduce((sum, debt) => sum + debt.amountCents, 0) +
      (await handBacks()).reduce((sum, line) => sum + line.unitCents, 0) +
      (await credit.getMemberCreditBalance(MEMBER_ID));

    /**
     * #3907: the lines the cut-over census (#3583) finds no source for. These
     * hand-built fixtures post no capture and key their nights by hand, so the
     * census has other things to say about them; what it must not say is that
     * a review's stand-in or hand-back is unexplained. The census-clean proof
     * of every shape is the next describe.
     */
    async function censusDrift() {
      const report = await censusStore.censusBookingLedgerProjection(prisma);
      return report.integrity.findings.filter((finding) => finding.bookingId === BOOKING_ID && finding.kind === "SOURCE_DRIFT").map((finding) => finding.detail);
    }

    beforeAll(async () => {
      assertSafeCapturedCancelRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ raiseEditFinancialReviewTask } = await import("@/lib/edit-financial-review"));
      ({ resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution"));
      credit = await import("@/lib/member-credit");
      ({ previewEditReviewStillOwed } = await import("@/lib/edit-financial-review-still-owed"));
      payments = await import("@/lib/payment-transactions");
      censusStore = await import("@/lib/booking-ledger-projection-census-store");
      const startRows = await prisma.$queryRaw<Array<{ finished_at: Date }>>`
        SELECT "finished_at" FROM "_prisma_migrations"
        WHERE "migration_name" = '20260509090000_enrich_payment_refund_ledger' AND "finished_at" IS NOT NULL
        LIMIT 1
      `;
      ledgerStartSeconds = Math.floor((startRows[0]?.finished_at ?? new Date(0)).getTime() / 1000);

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Netting", lastName: "Proof", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3835 Lodge", slug: "race-3835" } });
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

    beforeEach(() => {
      stripeKey.unconfigured = true;
    });

    afterAll(async () => {
      stripeKey.unconfigured = false;
      await Promise.all([lockHolderClient, observerClient].map((client) => client?.$disconnect().catch(() => {})));
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /** Two more connections: one holds the member's credit-ledger key, one looks. */
    let lockHolderClient: PrismaClient | undefined;
    let observerClient: PrismaClient | undefined;
    async function separateClient(applicationName: string): Promise<PrismaClient> {
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const url = new URL(RACE_DB_URL);
      url.searchParams.set("connection_limit", "1");
      url.searchParams.set("application_name", applicationName);
      const client = new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      await client.$connect();
      return client;
    }

    /**
     * Review round 2 F2 (`INV-LOCK-002`): a completion that gives credit back
     * takes the member's credit-ledger key BEFORE it touches the Payment row -
     * the order the Xero inbound applied-credit repair takes them in, so the two
     * cannot deadlock. Forced, not hoped for: another connection holds the
     * member key; once the completion is seen queued behind it, a third
     * connection must still be able to lock the Payment row without waiting.
     */
    async function expectMemberKeyBeforePaymentRow(taskId: string, shareCents: number) {
      lockHolderClient ??= await separateClient("race-3835-member-key");
      observerClient ??= await separateClient("race-3835-observer");
      const held = deferred();
      const release = deferred();
      let holderPid = 0;
      const holder = lockHolderClient.$transaction(async (tx) => {
        holderPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`)[0]!.pid;
        await credit.lockMemberCreditLedger(MEMBER_ID, tx as never);
        held.resolve();
        await release.promise;
      }, { maxWait: 5_000, timeout: 30_000 });
      await held.promise;
      const completion = completeShare(taskId, shareCents);
      let queued = 0;
      let paymentRowFree = false;
      try {
        const startedAt = process.hrtime.bigint();
        while (realElapsedMs(startedAt) < 10_000 && queued < 1) {
          queued = (await observerClient.$queryRaw<Array<{ count: number }>>`
            SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
            WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
          `)[0]!.count;
          if (queued < 1) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        paymentRowFree = await observerClient.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`;
          await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${PAYMENT_ID} FOR NO KEY UPDATE`;
          return true;
        }).catch(() => false);
      } finally {
        release.resolve();
        await holder;
      }
      await completion;
      expect(queued, "the completion never queued behind the member's credit-ledger key").toBeGreaterThanOrEqual(1);
      expect(paymentRowFree, "the completion held the Payment row while it waited for the member's key").toBe(true);
    }

    for (const payment of PAYMENTS) {
      it.each(TIERS)(`${payment.paid}, the REAL cancel at $tier, then the review on the card route: $owedCents cents of the $50 share, $totalBackCents in all`, async ({ rule, owedCents, totalBackCents: expectedBackCents }) => {
        await paid(payment);
        const raised = await raise("2026-08-01");
        await cancelAt(rule);
        const backAfterCancelCents = await totalBackCents();
        const shown = await dialogSays(raised.taskId);
        expect(shown).toEqual({ shareCents: 5_000, stillOwedCents: owedCents, captureCents: owedCents, creditCents: 0, route: "card" });

        const result = await completeShare(raised.taskId);

        expect(result.status).toBe("COMPLETED");
        expect(result.amountCents).toBe(5_000);
        // The dialog's figure is the one the completion settled.
        expect(result.settlementAmountCents).toBe(owedCents);
        expect((await totalBackCents()) - backAfterCancelCents).toBe(owedCents);
        expect(await totalBackCents()).toBe(expectedBackCents);
        // The card refund this review froze is the netted figure, or none.
        const reviewDebts = (await cardDebts()).filter((debt) => debt.idempotencyKey.includes(raised.taskId));
        expect(reviewDebts.map((debt) => debt.amountCents)).toEqual(owedCents > 0 ? [owedCents] : []);
        // The ledger records what was refunded - none at zero.
        const standIns = await prisma.bookingLedgerLine.findMany({
          where: { bookingId: BOOKING_ID, kind: "AGREED_ADJUSTMENT", anchorId: raised.taskId },
          select: { amountCents: true },
        });
        expect(standIns.map((line) => line.amountCents)).toEqual(owedCents > 0 ? [-owedCents] : []);
        // Nothing is raised against the cancelled booking's invoice.
        expect(await prisma.xeroSyncOperation.count({ where: { localId: { in: [MODIFICATION_ID, BOOKING_ID] }, entityType: "CREDIT_NOTE" } })).toBe(0);
        expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
      });
    }

    for (const payment of BANK_PAYMENTS) {
      it.each(TIERS)(`${payment.paid}, the REAL cancel at $tier returns credit, then the review hands back by bank transfer: $owedCents cents of the $50 share, $totalBackCents in all`, async ({ rule, owedCents, totalBackCents: expectedBackCents }) => {
        await paid(payment);
        const raised = await raise("2026-08-01");
        await cancelAt(rule);
        const backAfterCancelCents = await totalBackCents();
        // The cancellation sent nothing by card: it credited the member.
        expect(await cardDebts()).toEqual([]);
        // The settle dialog says what to hand back BEFORE the officer transfers it.
        const shown = await dialogSays(raised.taskId);
        expect(shown).toEqual({ shareCents: 5_000, stillOwedCents: owedCents, captureCents: owedCents, creditCents: 0, route: "hand-back" });

        const result = await completeShare(raised.taskId);
        expect(result.settlementAmountCents).toBe(owedCents);

        expect(result.status).toBe("COMPLETED");
        expect((await totalBackCents()) - backAfterCancelCents).toBe(owedCents);
        expect(await totalBackCents()).toBe(expectedBackCents);
        // The hand-back, its line and its event are the netted figure, or none.
        expect((await handBacks()).map((line) => line.unitCents)).toEqual(owedCents > 0 ? [owedCents] : []);
        const refunded = await prisma.bookingEvent.findMany({ where: { bookingId: BOOKING_ID, type: "REFUNDED", reason: "manual_refund_completed" }, select: { amountCents: true } });
        expect(refunded.map((event) => event.amountCents)).toEqual(owedCents > 0 ? [owedCents] : []);
        expect(await prisma.xeroSyncOperation.count({ where: { localId: { in: [MODIFICATION_ID, BOOKING_ID] }, entityType: "CREDIT_NOTE" } })).toBe(0);
        expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
      });
    }

    it("two $20 reviews after the REAL bank-transfer cancel at 50% less $20 net cumulatively: $10 handed back each", async () => {
      await paid(BANK_PAYMENTS[0]!);
      const first = await raise("2026-08-01");
      const second = await raise("2026-08-02");
      await cancelAt(TIERS[1]!.rule);
      expect(await totalBackCents()).toBe(8_000);

      await completeShare(first.taskId, 2_000);
      // The second's dialog already counts the first's hand-back.
      expect(await dialogSays(second.taskId, 2_000)).toMatchObject({ stillOwedCents: 1_000 });
      await completeShare(second.taskId, 2_000);

      expect((await handBacks()).map((line) => line.unitCents)).toEqual([1_000, 1_000]);
      expect(await totalBackCents()).toBe(10_000);
      expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
    });

    it("credit plus card at 50% less $20, a review raised before the card was paid takes the account-credit route and mints only the $25 still owed", async () => {
      await paid(PAYMENTS[1]!);
      const raised = await raise("2026-08-01", null);
      await cancelAt(TIERS[1]!.rule);
      const backAfterCancelCents = await totalBackCents();
      expect(await dialogSays(raised.taskId)).toEqual({ shareCents: 5_000, stillOwedCents: 2_500, captureCents: 0, creditCents: 2_500, route: "account-credit" });

      await completeShare(raised.taskId);

      const minted = await prisma.memberCredit.findMany({ where: { sourceBookingModificationId: MODIFICATION_ID }, select: { amountCents: true } });
      expect(minted.map((row) => row.amountCents)).toEqual([2_500]);
      expect((await totalBackCents()) - backAfterCancelCents).toBe(2_500);
      expect(await totalBackCents()).toBe(10_500);
      expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
    });

    /**
     * Stripe answers every refund frozen so far, as the inline call or the
     * recovery replay would: recorded through the real writer, debt closed.
     */
    async function stripeRefundsWhatIsOwed() {
      const debts = await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING_ID, status: { not: "SUCCEEDED" } } });
      for (const [index, debt] of debts.entries()) {
        await payments.recordStripeRefundsAgainstTransaction({
          paymentId: PAYMENT_ID,
          paymentTransactionId: TRANSACTION_ID,
          refunds: [{
            id: `re_race_3835_${debt.id}`, amount: debt.amountCents, currency: "nzd", status: "succeeded",
            reason: "requested_by_customer", created: ledgerStartSeconds + 60 + index, charge: "ch_race_3835", payment_intent: INTENT_ID,
          } as never],
          fallbackPaymentIntentId: INTENT_ID,
        });
        await prisma.paymentRecoveryOperation.update({ where: { id: debt.id }, data: { status: "SUCCEEDED" } });
      }
    }
    const capture = async () =>
      (await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: TRANSACTION_ID }, select: { amountCents: true } })).amountCents;

    it("review round 2 F2: the bank-transfer hand-back with a credit part takes the member's credit-ledger key before the Payment row", async () => {
      await paid({ paid: "credit plus internet banking", cardCents: 5_000, appliedCents: 15_000, source: "INTERNET_BANKING" });
      const raised = await raise("2026-08-01");
      await cancelAt({ refundPercentage: 50, fixedFeeCents: 0 });
      expect(await dialogSays(raised.taskId, 10_000)).toMatchObject({ captureCents: 2_500, creditCents: 2_500, route: "hand-back" });

      await expectMemberKeyBeforePaymentRow(raised.taskId, 10_000);

      expect((await handBacks()).map((line) => line.unitCents)).toEqual([2_500]);
      expect(await totalBackCents()).toBe(15_000);
      expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
    });

    it("review round 2 F2: the minted-credit route with a credit part takes the member's credit-ledger key before the Payment row", async () => {
      await paid({ paid: "credit plus card", cardCents: 5_000, appliedCents: 15_000, source: "STRIPE" });
      const raised = await raise("2026-08-01", null);
      await cancelAt({ refundPercentage: 50, fixedFeeCents: 0 });
      expect(await dialogSays(raised.taskId, 10_000)).toMatchObject({ stillOwedCents: 5_000, route: "account-credit" });

      await expectMemberKeyBeforePaymentRow(raised.taskId, 10_000);

      expect(await totalBackCents()).toBe(15_000);
      expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
    });

    it("#3809 then #3835: a credit-paid $200 booking reduced to $150 through the give-back ($5 back), cancelled at 50% less $20 on the cap ($55), then a $50 review: the re-tier reproduces on the cap and nets to $47.50 - what the review first would have left", async () => {
      await clearRun();
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAID", totalPriceCents: 20_000, finalPriceCents: 20_000 } });
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 0, creditAppliedCents: 20_000, source: "STRIPE", status: "SUCCEEDED" },
      });
      await prisma.memberCredit.create({ data: { memberId: MEMBER_ID, amountCents: 20_000, type: "ADMIN_ADJUSTMENT", description: "race 3835 opening balance" } });
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, 20_000, BOOKING_ID, tx, CLUB_FORMAT_TEST));
      const raised = await raise("2026-08-01", null);
      // #3809's settlement of a $50 reduction at 50% less $20: the price drops,
      // $5 of applied credit comes back, and the edit's history marks the cap.
      const { giveBackCancelledShareCredit } = await import("@/lib/edit-financial-review-account-credit");
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { totalPriceCents: 15_000, finalPriceCents: 15_000 } });
      await prisma.$transaction((tx) => giveBackCancelledShareCredit({ memberId: MEMBER_ID, bookingId: BOOKING_ID, cents: 500, format: CLUB_FORMAT_TEST, store: tx }));
      await prisma.bookingModification.create({
        data: { bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: { appliedCreditGiveBack: { basisCents: 5_000, givenBackCents: 500 } } },
      });
      const { bookingReducedThroughCreditGiveBack } = await import("@/lib/booking-credit-give-back-marker");
      expect(await bookingReducedThroughCreditGiveBack(BOOKING_ID, prisma)).toBe(true);

      await cancelAt(TIERS[1]!.rule);
      const cancelled = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: BOOKING_ID, type: "CANCELLED" }, select: { snapshot: true } });
      expect(cancelled.snapshot).toMatchObject({ ledger: { appliedCreditCents: 19_500, appliedCreditBaseCents: 15_000, creditRestoredCents: 5_500 } });
      const balanceAfterCancel = await credit.getMemberCreditBalance(MEMBER_ID);
      expect(balanceAfterCancel).toBe(6_000); // $5 given back + $55 restored

      await completeShare(raised.taskId);

      // Review first: $50 back leaves $145 applied, tiered under the cap at 50% less $20: $52.50.
      // So $5 + $50 + $52.50 = $107.50 in all; cancel first gave $60, so $47.50 more.
      expect(await credit.getMemberCreditBalance(MEMBER_ID) - balanceAfterCancel).toBe(4_750);
      const task = await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: raised.taskId }, select: { status: true } });
      expect(task.status).toBe("COMPLETED");
      expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
    });

    it("integration review H: $100 card + $100 credit on a booking #3809's give-back reduced to $150, cancelled at 50% less $20 under the cap ($55), then a $30 review: $85 in all, the review-first figure", async () => {
      await paid(PAYMENTS[1]!);
      const raised = await raise("2026-08-01");
      // #3809's reduction to $150: the marker the cancel's cap reads.
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { totalPriceCents: 15_000, finalPriceCents: 15_000 } });
      await prisma.bookingModification.create({
        data: { bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: { appliedCreditGiveBack: { basisCents: 5_000, givenBackCents: 0 } } },
      });

      await cancelAt(TIERS[1]!.rule);
      const cancelled = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: BOOKING_ID, type: "CANCELLED" }, select: { snapshot: true } });
      // The cap tiered $50 of the $100 credit: $30 to the card, $25 restored.
      expect(cancelled.snapshot).toMatchObject({ settledAmountCents: 3_000, ledger: { appliedCreditCents: 10_000, appliedCreditBaseCents: 5_000, creditRestoredCents: 2_500 } });
      expect(await totalBackCents()).toBe(5_500);

      // Review first: $30 back to the card leaves $70 tiered (less $20: $15) and room under the cap for $80 of credit ($40).
      expect(await dialogSays(raised.taskId, 3_000)).toMatchObject({ stillOwedCents: 3_000, captureCents: 1_500, creditCents: 1_500, route: "card" });
      await completeShare(raised.taskId, 3_000);

      expect(await totalBackCents()).toBe(8_500);
      expect((await cardDebts()).reduce((sum, debt) => sum + debt.amountCents, 0)).toBeLessThanOrEqual(await capture());
      expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
    });

    it("review F1: $150 credit + $50 card, cancelled at 50% (no fee), a $100 share: $25 to the card and $25 given back as credit - the card never promised more than it took", async () => {
      await paid({ paid: "credit plus card", cardCents: 5_000, appliedCents: 15_000, source: "STRIPE" });
      const raised = await raise("2026-08-01");
      await cancelAt({ refundPercentage: 50, fixedFeeCents: 0 });
      expect((await cardDebts()).map((debt) => debt.amountCents)).toEqual([2_500]);
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(7_500);

      expect(await dialogSays(raised.taskId, 10_000)).toEqual({ shareCents: 10_000, stillOwedCents: 5_000, captureCents: 2_500, creditCents: 2_500, route: "card" });
      const result = await completeShare(raised.taskId, 10_000);
      expect(result.settlementAmountCents).toBe(5_000);

      const cardPromised = (await cardDebts()).reduce((sum, debt) => sum + debt.amountCents, 0);
      expect(cardPromised).toBe(5_000);
      expect(cardPromised).toBeLessThanOrEqual(await capture());
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(10_000);
      expect(await totalBackCents()).toBe(15_000);
      // Stripe can honour every promise: nothing is refused at the provider.
      await stripeRefundsWhatIsOwed();
      const refunded = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } });
      expect(refunded.refundedAmountCents).toBe(5_000);
      expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
    });

    it("a $50 share settled BEFORE the cancel, then the cancel at 50% less $20, then another $50 share: $130 in all", async () => {
      await paid(PAYMENTS[0]!);
      const before = await raise("2026-08-01");
      const after = await raise("2026-08-02");
      await completeShare(before.taskId);
      await stripeRefundsWhatIsOwed();
      await cancelAt(TIERS[1]!.rule);
      // The cancel tiered the $150 left: $75 less $20.
      // (Sorted: the frozen clock gives both debts one createdAt.)
      expect((await cardDebts()).map((debt) => debt.amountCents).sort((a, b) => a - b)).toEqual([5_000, 5_500]);

      expect(await dialogSays(after.taskId)).toMatchObject({ stillOwedCents: 2_500, captureCents: 2_500 });
      await completeShare(after.taskId);

      expect(await totalBackCents()).toBe(13_000);
      expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
    });

    /** The strand now sells for `cents` in exact SOLD nights, so a review's re-price moves the booking to it. */
    async function strandSellsFor(cents: number) {
      await prisma.bookingGuest.update({ where: { id: GUEST_ID }, data: { priceCents: cents } });
      await prisma.bookingGuestNight.createMany({
        data: [
          { bookingGuestId: GUEST_ID, stayDate: CHECK_IN, priceCents: cents / 2, priceSource: "SOLD" },
          { bookingGuestId: GUEST_ID, stayDate: new Date("2026-08-02T00:00:00.000Z"), priceCents: cents / 2, priceSource: "SOLD" },
        ],
      });
    }

    it.each([
      ["100%", TIERS[0]!.rule, 10_000, 20_000],
      ["50% with a $20 fee", TIERS[1]!.rule, 3_000, 13_000],
    ])("review round 2 F1: review A re-prices the booking to $100 before the REAL cancel at %s; review B's $50 still comes back whole, as B first would", async (_tier, rule, cancelRefundCents, expectedBackCents) => {
      await paid(PAYMENTS[0]!);
      const first = await raise("2026-08-01");
      const second = await raise("2026-08-02");
      // A's re-price takes the strands' sum, which already drops B's removed nights too.
      await strandSellsFor(10_000);
      await completeShare(first.taskId);
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { finalPriceCents: true } });
      expect(booking.finalPriceCents).toBe(10_000);
      await stripeRefundsWhatIsOwed();
      await cancelAt(rule);
      // $150 paid, tiered on the $100 price: the $50 above it is left untiered.
      const cancelled = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: BOOKING_ID, type: "CANCELLED" }, select: { snapshot: true } });
      expect(cancelled.snapshot).toMatchObject({ paidAmountCents: 15_000, refundableBaseCents: 10_000, settledAmountCents: cancelRefundCents });

      expect(await dialogSays(second.taskId)).toMatchObject({ stillOwedCents: 5_000, captureCents: 5_000, creditCents: 0 });
      await completeShare(second.taskId);

      expect(await totalBackCents()).toBe(expectedBackCents);
      expect((await cardDebts()).reduce((sum, debt) => sum + debt.amountCents, 0)).toBeLessThanOrEqual(await capture());
      expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
    });

    it("a $150 share then a $40 share after the REAL card cancel at 50% less $20 net cumulatively: $75 then $35, $190 in all", async () => {
      await paid(PAYMENTS[0]!);
      const first = await raise("2026-08-01");
      const second = await raise("2026-08-02");
      await cancelAt(TIERS[1]!.rule);

      await completeShare(first.taskId, 15_000);
      expect(await totalBackCents()).toBe(15_500);
      await completeShare(second.taskId, 4_000);

      expect(await totalBackCents()).toBe(19_000);
      expect((await cardDebts()).reduce((sum, debt) => sum + debt.amountCents, 0)).toBeLessThanOrEqual(await capture());
      expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
    });

    it("two $20 reviews after the REAL card cancel at 50% less $20 net cumulatively: $10 each, $100 in all", async () => {
      await paid(PAYMENTS[0]!);
      const first = await raise("2026-08-01");
      const second = await raise("2026-08-02");
      expect(second.taskId).not.toBe(first.taskId);
      await cancelAt(TIERS[1]!.rule);
      expect(await totalBackCents()).toBe(8_000);

      await completeShare(first.taskId, 2_000);
      expect(await totalBackCents()).toBe(9_000);
      await completeShare(second.taskId, 2_000);

      expect(await totalBackCents()).toBe(10_000);
      expect(await censusDrift(), "#3907: a review line the census cannot explain").toEqual([]);
    });
  },
);

/**
 * #3907: the cut-over census (#3583, `INV-MONEY-037`) reads what these routes
 * leave. Each booking is built only by the real writers - the settle's own
 * confirmation and capture, the real credit apply, the real raise, the REAL
 * `cancelBooking` and the REAL completion - so the census has nothing of the
 * fixture's to say, and the card refunds are answered as Stripe would. A
 * review's netted stand-in is borne out by its own refund (card or hand-back)
 * plus its give-back and minted credit; then a corrupted line, refund or
 * hand-back must still disagree.
 */
const CENSUS = "race-3907-";
const OFFICER = `${CENSUS}officer`;
const CENSUS_LODGE = `${CENSUS}lodge`;
const NIGHT_2 = new Date("2026-08-02T00:00:00.000Z");
const HALF_LESS_FEE = { refundPercentage: 50, fixedFeeCents: 2_000 };
const FULL = { refundPercentage: 100, fixedFeeCents: 0 };

(RUN ? describe : describe.skip)("the census reads a review completed after the REAL cancel of a captured payment as agreeing - real PostgreSQL (#3907)", { timeout: 120_000 }, () => {
  let db: (typeof import("@/lib/prisma"))["prisma"];
  let census: typeof import("@/lib/booking-ledger-projection-census-store");
  const memberOf = (id: string) => `${id}-member`;
  const paymentOf = async (id: string) => (await db.payment.findUniqueOrThrow({ where: { bookingId: id }, select: { id: true } })).id;

  async function clean() {
    const ids = (await db.booking.findMany({ where: { id: { startsWith: CENSUS } }, select: { id: true } })).map((row) => row.id);
    const where = { bookingId: { in: ids } };
    const paymentIds = (await db.payment.findMany({ where, select: { id: true } })).map((row) => row.id);
    await db.xeroSyncOperation.deleteMany({ where: { localId: { in: [...ids, ...paymentIds, ...ids.map((id) => `${id}-mod`)] } } });
    await db.bookingLedgerLine.deleteMany({ where });
    await db.memberCredit.deleteMany({ where: { memberId: { in: ids.map(memberOf) } } });
    await db.manualRefundTask.deleteMany({ where });
    await db.paymentRecoveryOperation.deleteMany({ where });
    await db.bookingEvent.deleteMany({ where });
    await db.auditLog.deleteMany({ where: { OR: [{ targetId: { in: ids } }, { memberId: { in: ids.map(memberOf) } }, { actorMemberId: OFFICER }] } });
    await db.bookingModification.deleteMany({ where });
    await db.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await db.paymentTransaction.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await db.payment.deleteMany({ where });
    await db.bookingGuestNight.deleteMany({ where: { bookingGuest: where } });
    await db.bookingGuest.deleteMany({ where });
    await db.booking.deleteMany({ where: { id: { in: ids } } });
    await db.member.deleteMany({ where: { id: { in: ids.map(memberOf) } } });
  }

  /**
   * A $200 stay, two $100 nights, paid: the card or bank transfer for
   * `cardCents` through the real settle (which confirms it on the ledger), the
   * rest by account credit through the real apply. The parked edit then leaves
   * the strand unpriced, so a closure posts its share as the stand-in.
   */
  async function paidBooking(name: string, { cardCents, appliedCents, source }: { cardCents: number; appliedCents: number; source: "STRIPE" | "INTERNET_BANKING" }) {
    const id = `${CENSUS}${name}`;
    const memberId = memberOf(id);
    await db.member.create({ data: { id: memberId, email: `${memberId}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Census", lastName: "Captured", ageTier: "ADULT" } });
    await db.booking.create({
      data: {
        id, memberId, lodgeId: CENSUS_LODGE, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAYMENT_PENDING", totalPriceCents: 20_000, finalPriceCents: 20_000,
        capacityOverriddenAt: new Date("2026-06-01T00:00:00.000Z"), capacityOverriddenByMemberId: OFFICER,
      },
    });
    await db.bookingGuest.create({
      data: {
        id: `${id}-guest`, bookingId: id, firstName: "Census", lastName: "Guest", ageTier: "ADULT", isMember: true, stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: 20_000,
        nights: { create: [{ stayDate: CHECK_IN, priceCents: 10_000, priceSource: "SOLD" }, { stayDate: NIGHT_2, priceCents: 10_000, priceSource: "SOLD" }] },
      },
    });
    await db.bookingModification.create({ data: { id: `${id}-mod`, bookingId: id, memberId, modificationType: "BATCH_MODIFY", previousData: {}, newData: {} } });
    const memberCredit = await import("@/lib/member-credit");
    if (appliedCents > 0) {
      await db.memberCredit.create({ data: { memberId, amountCents: appliedCents, type: "ADMIN_ADJUSTMENT", description: "race 3907 opening balance" } });
      await db.$transaction((tx) => memberCredit.applyCreditToBooking(memberId, appliedCents, id, tx, CLUB_FORMAT_TEST));
    }
    const reconciliation = await import("@/lib/payment-reconciliation");
    if (source === "STRIPE") {
      const settled = await reconciliation.markBookingPaymentSucceeded({ bookingId: id, paymentIntentId: `pi_${id}`, amountCents: cardCents, paymentMethodId: null, format: CLUB_FORMAT_TEST });
      expect(settled.outcome).toBe("paid");
    } else {
      const existing = await db.payment.findUnique({ where: { bookingId: id }, select: { id: true } });
      if (existing) await db.payment.update({ where: { id: existing.id }, data: { amountCents: cardCents, source } });
      else await db.payment.create({ data: { id: `${id}-payment`, bookingId: id, amountCents: cardCents, source, status: "PENDING" } });
      await reconciliation.markBookingPaymentManuallySettled({ bookingId: id, actingAdminMemberId: OFFICER, note: "paid by bank transfer", expectedAmountCents: cardCents, notifyMember: false, format: CLUB_FORMAT_TEST });
    }
    await db.bookingGuestNight.deleteMany({ where: { bookingGuestId: `${id}-guest` } });
    return id;
  }

  const raiseOn = (id: string, night: string, withPayment = true) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const payment = withPayment ? await tx.payment.findUniqueOrThrow({ where: { bookingId: id }, select: { id: true } }) : null;
      const { raiseEditFinancialReviewTask } = await import("@/lib/edit-financial-review");
      const raised = await raiseEditFinancialReviewTask({
        occurrence: {
          bookingId: id, bookingGuestId: `${id}-guest`, cause: "NO_STORED_NIGHT_PRICES", surrenderedNightDates: [night as CalendarDate], addedNightDates: [],
          storedEvidence: { guestTotalCents: null, nightPrices: [] },
        },
        guestMemberId: memberOf(id), bookingCheckIn: "2026-08-01" as CalendarDate, bookingCheckOut: "2026-08-03" as CalendarDate,
        bookingModificationId: `${id}-mod`, paymentId: payment?.id ?? null, guestsAddedByEdit: null, store: tx,
      });
      return raised.taskId;
    });

  async function cancelOn(id: string, rule: { refundPercentage: number; fixedFeeCents: number }) {
    await db.cancellationPolicy.deleteMany({ where: { lodgeId: CENSUS_LODGE } });
    await db.cancellationPolicy.create({ data: { lodgeId: CENSUS_LODGE, daysBeforeStay: 0, ...rule } });
    const { cancelBooking } = await import("@/lib/booking-cancel");
    expect((await cancelBooking(id, OFFICER, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);
    // A bank transfer's cancellation refund is handed back by the officer, through the real resolver.
    const handBack = await db.manualRefundTask.findFirst({ where: { bookingId: id, kind: "CANCELLED_BOOKING_HAND_BACK", status: "OPEN" }, select: { id: true } });
    if (handBack) {
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask({ taskId: handBack.id, resolution: "completed", note: null, actingMemberId: OFFICER, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null }, CLUB_FORMAT_TEST);
    }
  }

  async function complete(taskId: string, confirmedAmountCents: number) {
    const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
    const result = await resolveManualRefundTask({
      taskId, resolution: "completed", note: "Priced from the booking's own payment history.", actingMemberId: OFFICER,
      confirmedAmountCents, direction: "REFUND_TO_MEMBER", recordedNightPrices: null,
    }, CLUB_FORMAT_TEST);
    return result.settlementAmountCents;
  }

  /** Stripe answers every card refund the booking froze, as the inline call or a replay would. */
  async function stripeAnswers(id: string) {
    const paymentId = await paymentOf(id);
    const capture = await db.paymentTransaction.findFirstOrThrow({ where: { paymentId, kind: "PRIMARY" }, select: { id: true } });
    const { recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions");
    for (const debt of await db.paymentRecoveryOperation.findMany({ where: { bookingId: id, status: { not: "SUCCEEDED" } }, orderBy: { id: "asc" } })) {
      await recordStripeRefundsAgainstTransaction({
        paymentId, paymentTransactionId: capture.id,
        refunds: [{ id: `re_${debt.id}`, amount: debt.amountCents, currency: "nzd", status: "succeeded", created: null }],
        store: db,
      });
      await db.paymentRecoveryOperation.update({ where: { id: debt.id }, data: { status: "SUCCEEDED" } });
    }
  }

  async function says(id: string) {
    const report = await census.censusBookingLedgerProjection(db);
    const mine = <T extends { bookingId: string }>(rows: readonly T[]) => rows.filter((row) => row.bookingId === id);
    return {
      disagreements: mine(report.disagreements).map((row) => `${row.identity} ${row.deltaCents}`),
      integrity: mine(report.integrity.findings).map((finding) => `${finding.kind}: ${finding.detail}`),
      coverage: Object.entries(report.coverage).flatMap(([kind, ids]) => (ids.includes(id) ? [kind] : [])),
      classes: Object.entries(report.classes).flatMap(([name, entry]) => mine(entry.instances).map((instance) => `${name} ${instance.identity} ${instance.cents}`)),
    };
  }
  const NOTHING_TO_SAY = { disagreements: [], integrity: [], coverage: [], classes: [] };
  const reviewLine = (id: string, taskId: string, kind: "AGREED_ADJUSTMENT" | "BANK_REFUND") =>
    db.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: id, kind, anchorKind: "REVIEW_TASK", anchorId: taskId }, select: { id: true, amountCents: true } });
  const setLine = (lineId: string, amountCents: number) =>
    db.bookingLedgerLine.update({ where: { id: lineId }, data: { unitCents: Math.abs(amountCents), amountCents } });

  const built: Record<string, { id: string; tasks: string[] }> = {};

  beforeAll(async () => {
    assertSafeCapturedCancelRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma: db } = await import("@/lib/prisma"));
    census = await import("@/lib/booking-ledger-projection-census-store");
    await clean();
    await db.cancellationPolicy.deleteMany({ where: { lodgeId: CENSUS_LODGE } });
    await db.lodge.deleteMany({ where: { id: CENSUS_LODGE } });
    await db.member.deleteMany({ where: { id: OFFICER } });
    await db.member.create({ data: { id: OFFICER, email: `${OFFICER}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Census", lastName: "Officer", role: "ADMIN", ageTier: "ADULT" } });
    await db.lodge.create({ data: { id: CENSUS_LODGE, name: "Race 3907 Lodge", slug: "race-3907" } });
  }, 60_000);

  beforeEach(() => {
    stripeKey.unconfigured = true;
  });

  afterAll(async () => {
    stripeKey.unconfigured = false;
    if (!db) return;
    await clean();
    await db.cancellationPolicy.deleteMany({ where: { lodgeId: CENSUS_LODGE } });
    await db.lodge.deleteMany({ where: { id: CENSUS_LODGE } });
    await db.member.deleteMany({ where: { id: OFFICER } });
  }, 60_000);

  const CARD = { cardCents: 20_000, appliedCents: 0, source: "STRIPE" as const };
  const CREDIT_PLUS_CARD = { cardCents: 10_000, appliedCents: 10_000, source: "STRIPE" as const };
  const BANK = { cardCents: 20_000, appliedCents: 0, source: "INTERNET_BANKING" as const };
  const CREDIT_PLUS_BANK = { cardCents: 10_000, appliedCents: 10_000, source: "INTERNET_BANKING" as const };

  it.each([
    ["card-half", CARD, HALF_LESS_FEE, 2_500],
    ["card-full", CARD, FULL, 0],
    ["cc-half", CREDIT_PLUS_CARD, HALF_LESS_FEE, 2_500],
    ["cc-full", CREDIT_PLUS_CARD, FULL, 0],
  ] as const)("%s: the card route's netted refund is the stand-in's own evidence", async (name, paid, rule, owedCents) => {
    const id = await paidBooking(name, paid);
    const taskId = await raiseOn(id, "2026-08-01");
    await cancelOn(id, rule);
    expect(await complete(taskId, 5_000)).toBe(owedCents);
    await stripeAnswers(id);
    built[name] = { id, tasks: [taskId] };
    expect(await says(id)).toEqual(NOTHING_TO_SAY);
  });

  it.each([
    ["bank-half", BANK, HALF_LESS_FEE, 2_500],
    ["bank-full", BANK, FULL, 0],
    ["cb-half", CREDIT_PLUS_BANK, HALF_LESS_FEE, 2_500],
    ["cb-full", CREDIT_PLUS_BANK, FULL, 0],
  ] as const)("%s: the bank-transfer hand-back is the stand-in's own evidence, and its own line is borne out by it", async (name, paid, rule, owedCents) => {
    const id = await paidBooking(name, paid);
    const taskId = await raiseOn(id, "2026-08-01");
    await cancelOn(id, rule);
    expect(await complete(taskId, 5_000)).toBe(owedCents);
    built[name] = { id, tasks: [taskId] };
    const found = await says(id);
    expect({ ...found, classes: [] }).toEqual(NOTHING_TO_SAY);
    // What raised the refunded column without a card refund is named, never drift.
    expect(found.classes.filter((entry) => !entry.startsWith("REFUND_MIRROR_"))).toEqual([]);
  });

  it("the captured account-credit route: the give-back and the credit minted against the payment make the stand-in", async () => {
    const id = await paidBooking("acct", CREDIT_PLUS_CARD);
    const taskId = await raiseOn(id, "2026-08-01", false);
    await cancelOn(id, HALF_LESS_FEE);
    await complete(taskId, 5_000);
    expect((await reviewLine(id, taskId, "AGREED_ADJUSTMENT")).amountCents).toBe(-2_500);
    await stripeAnswers(id);
    built.acct = { id, tasks: [taskId] };
    const found = await says(id);
    expect({ ...found, classes: [] }).toEqual(NOTHING_TO_SAY);
    expect(found.classes.filter((entry) => !entry.startsWith("REFUND_MIRROR_"))).toEqual([]);
  });

  it("$150 credit + $50 card at 50%, a $100 share: $25 to the card and $25 given back make the stand-in together", async () => {
    const id = await paidBooking("split", { cardCents: 5_000, appliedCents: 15_000, source: "STRIPE" });
    const taskId = await raiseOn(id, "2026-08-01");
    await cancelOn(id, { refundPercentage: 50, fixedFeeCents: 0 });
    expect(await complete(taskId, 10_000)).toBe(5_000);
    await stripeAnswers(id);
    built.split = { id, tasks: [taskId] };
    expect(await says(id)).toEqual(NOTHING_TO_SAY);
  });

  it("$150 credit + $50 bank transfer at 0%, a $100 share: the whole share, $50 handed back and $50 given back", async () => {
    const id = await paidBooking("split-bank", { cardCents: 5_000, appliedCents: 15_000, source: "INTERNET_BANKING" });
    const taskId = await raiseOn(id, "2026-08-01");
    await cancelOn(id, { refundPercentage: 0, fixedFeeCents: 0 });
    expect(await complete(taskId, 10_000)).toBe(10_000);
    expect((await reviewLine(id, taskId, "BANK_REFUND")).amountCents).toBe(-5_000);
    built["split-bank"] = { id, tasks: [taskId] };
    const found = await says(id);
    expect({ ...found, classes: [] }).toEqual(NOTHING_TO_SAY);
    expect(found.classes.filter((entry) => !entry.startsWith("REFUND_MIRROR_"))).toEqual([]);
  });

  it.each([
    ["sib-card", CARD],
    ["sib-bank", BANK],
  ] as const)("%s: two 2,000-cent sibling reviews after the cancel at half less 2,000 net cumulatively, each made by its own refund", async (name, paid) => {
    const id = await paidBooking(name, paid);
    const tasks = [await raiseOn(id, "2026-08-01"), await raiseOn(id, "2026-08-02")];
    await cancelOn(id, HALF_LESS_FEE);
    expect([await complete(tasks[0]!, 2_000), await complete(tasks[1]!, 2_000)]).toEqual([1_000, 1_000]);
    if (paid.source === "STRIPE") await stripeAnswers(id);
    built[name] = { id, tasks };
    const found = await says(id);
    expect({ ...found, classes: [] }).toEqual(NOTHING_TO_SAY);
    expect(found.classes.filter((entry) => !entry.startsWith("REFUND_MIRROR_"))).toEqual([]);
  });

  it("a corrupted line, card refund or hand-back still disagrees", async () => {
    const drifted = async (id: string) => (await says(id)).integrity.filter((entry) => entry.startsWith("SOURCE_DRIFT"));
    // The card route's stand-in, a cent too large: its own refund no longer makes it.
    const card = built["card-half"]!;
    const cardLine = await reviewLine(card.id, card.tasks[0]!, "AGREED_ADJUSTMENT");
    await setLine(cardLine.id, cardLine.amountCents - 1);
    expect(await drifted(card.id)).toHaveLength(1);
    expect((await says(card.id)).disagreements).toEqual(["PRICE 1"]);
    // The card route's frozen refund, a cent short: the line it made is unexplained.
    const ccTask = built["cc-half"]!.tasks[0]!;
    await db.paymentRecoveryOperation.updateMany({ where: { bookingId: built["cc-half"]!.id, idempotencyKey: { contains: ccTask } }, data: { amountCents: 2_499 } });
    expect(await drifted(built["cc-half"]!.id)).toHaveLength(1);
    // The split's card refund removed: $25 of give-back cannot make $50.
    await db.paymentRecoveryOperation.deleteMany({ where: { bookingId: built.split!.id, idempotencyKey: { contains: built.split!.tasks[0]! } } });
    expect(await drifted(built.split!.id)).toHaveLength(1);
    // A hand-back a cent larger: neither it nor the stand-in is borne out, and the refunded column says so.
    const bank = built["bank-half"]!;
    const handBack = await reviewLine(bank.id, bank.tasks[0]!, "BANK_REFUND");
    await setLine(handBack.id, handBack.amountCents - 1);
    expect(await drifted(bank.id)).toHaveLength(2);
    expect((await says(bank.id)).disagreements).toEqual(expect.arrayContaining([expect.stringMatching(/^REFUNDED /)]));
    // One sibling's netted stand-in, $5 too large.
    const sibling = built["sib-bank"]!;
    const sibLine = await reviewLine(sibling.id, sibling.tasks[1]!, "AGREED_ADJUSTMENT");
    await setLine(sibLine.id, sibLine.amountCents - 500);
    expect(await drifted(sibling.id)).toHaveLength(2);
    // The account-credit route's minted credit, a cent less: the stand-in is unexplained.
    // (Its own MEMBER_CREDIT line no longer matches the row either.)
    await db.memberCredit.updateMany({ where: { sourceBookingModificationId: `${built.acct!.id}-mod` }, data: { amountCents: { decrement: 1 } } });
    expect(await drifted(built.acct!.id)).toEqual(expect.arrayContaining([expect.stringContaining("after the cancellation")]));
    expect(await drifted(built.acct!.id)).toHaveLength(2);
    expect((await census.censusBookingLedgerProjection(db)).verdict).toBe("GATE_CLOSED");
  });
});
