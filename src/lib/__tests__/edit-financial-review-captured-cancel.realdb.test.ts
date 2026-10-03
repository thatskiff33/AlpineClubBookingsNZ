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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

/**
 * What the settle dialog shows before completing, through the dialog's own
 * server read - which must be the figure the completion then settles.
 */
async function dialogSays(taskId: string, shareCents = 5_000) {
  const { readClubTimeZoneOutsideRequest } = await import("@/lib/club-time-zone-runtime");
  return previewEditReviewStillOwed({ taskId, shareCents, clubZone: await readClubTimeZoneOutsideRequest() });
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

    beforeAll(async () => {
      assertSafeCapturedCancelRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ raiseEditFinancialReviewTask } = await import("@/lib/edit-financial-review"));
      ({ resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution"));
      credit = await import("@/lib/member-credit");
      ({ previewEditReviewStillOwed } = await import("@/lib/edit-financial-review-still-owed"));

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
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    for (const payment of PAYMENTS) {
      it.each(TIERS)(`${payment.paid}, the REAL cancel at $tier, then the review on the card route: $owedCents cents of the $50 share, $totalBackCents in all`, async ({ rule, owedCents, totalBackCents: expectedBackCents }) => {
        await paid(payment);
        const raised = await raise("2026-08-01");
        await cancelAt(rule);
        const backAfterCancelCents = await totalBackCents();
        const shown = await dialogSays(raised.taskId);
        expect(shown).toEqual({ shareCents: 5_000, stillOwedCents: owedCents, route: "card" });

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
        expect(shown).toEqual({ shareCents: 5_000, stillOwedCents: owedCents, route: "hand-back" });

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
    });

    it("credit plus card at 50% less $20, a review raised before the card was paid takes the account-credit route and mints only the $25 still owed", async () => {
      await paid(PAYMENTS[1]!);
      const raised = await raise("2026-08-01", null);
      await cancelAt(TIERS[1]!.rule);
      const backAfterCancelCents = await totalBackCents();
      expect(await dialogSays(raised.taskId)).toEqual({ shareCents: 5_000, stillOwedCents: 2_500, route: "account-credit" });

      await completeShare(raised.taskId);

      const minted = await prisma.memberCredit.findMany({ where: { sourceBookingModificationId: MODIFICATION_ID }, select: { amountCents: true } });
      expect(minted.map((row) => row.amountCents)).toEqual([2_500]);
      expect((await totalBackCents()) - backAfterCancelCents).toBe(2_500);
      expect(await totalBackCents()).toBe(10_500);
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
    });
  },
);
