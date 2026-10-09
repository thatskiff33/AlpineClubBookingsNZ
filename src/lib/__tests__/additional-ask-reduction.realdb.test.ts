/**
 * Real-PostgreSQL proof for #3954: a price reduction first cancels or shrinks
 * the unpaid card ask an earlier increase raised, and only what is left is
 * refunded, credited or given back - on a card-paid booking and on a
 * credit-paid ($0) one, through the REAL guest removal
 * (`removeBookingGuestInTransaction`, which settles through
 * `applyPaymentAdjustments`), on real rows: the ledger row the ask lives on, the
 * `Payment` mirror `reconcilePaymentAggregates` derives, the durable Stripe
 * cancellation, the parked Xero supplementary invoice and the booking history.
 *
 * And the race the decision has to survive: the member paying the ask while
 * the reduction is saved.
 *
 *  - Capture FIRST, inside the reduction's read-to-write window: a second
 *    connection marks the ask captured after the reduction read it unpaid. The
 *    retire's fence matches nothing and the whole transaction rolls back - no
 *    row, mirror, cancellation or Xero operation moves.
 *  - Capture AFTER the reduction commits (the browser confirmed the old intent
 *    before Stripe cancelled it): the webhook's first step finds the queued
 *    cancellation and hands the capture to the existing superseded-capture
 *    refund, in full; with that refund recorded the ledger balances again.
 *
 * And "retry nets it off" (owner decision 9 Oct 2026): an increase whose mint
 * FAILED waits on its recovery, not yet a ledger row. A reduction saved in that
 * window nets the waiting ask off exactly as a minted one - closing the recovery
 * so its retry cannot mint the old figure - and a retry that claimed the row
 * first rolls the reduction back (409).
 *
 * Review round 4 adds: one read of the ask for the options and the save, so a
 * capture between them meets only the fence; a stalled retry that wrote its own
 * row netted against that row and fenced off; a retry claimed moments ago
 * refusing for a moment, and the runner's claim hold racing the reduction's
 * close in both orders; and a shrunk ask's re-issue durable from the commit,
 * completed by the door's mint or left to the runner that claimed it.
 *
 * No provider is called: the Stripe cancellation and refund are the recovery
 * rows this change writes and the DB-only halves of their processors.
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`, against
 * a loopback database on port 55442+ named with `concurrency_race_1881`.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/additional-ask-reduction.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3954-member";
const LODGE_ID = "race-3954-lodge";
const BOOKING_ID = "race-3954-booking";
const STAYING_GUEST_ID = "race-3954-guest-stays";
const LEAVING_GUEST_ID = "race-3954-guest-leaves";
const PAYMENT_ID = "race-3954-payment";
const PRIMARY_TXN_ID = "race-3954-primary";
const ASK_TXN_ID = "race-3954-ask";
const ASK_INTENT = "pi_race_3954_ask";
const INCREASE_MOD_ID = "race-3954-increase";
const WAITING_OP_ID = "race-3954-waiting-supplementary";
const RECOVERY_ID = "race-3954-ask-recovery";

const TODAY = new Date("2026-07-01T00:00:00.000Z");
const NIGHTS = [new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z")];
const CHECK_IN = NIGHTS[0]!;
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

/** The sibling harness's envelope, re-declared so running this file alone registers no other suite. */
function assertSafeRaceDbUrl(url: string): void {
  const parsed = new URL(url);
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) throw new Error(`Refusing port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+.`);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) throw new Error("The race DB must be loopback-only.");
  if (!decodeURIComponent(parsed.pathname).includes("concurrency_race_1881")) throw new Error("The race DB name must carry 'concurrency_race_1881'.");
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let webhookClient: PrismaClient;

(RUN ? describe : describe.skip)(
  "#3954: a reduction cancels or shrinks the unpaid card ask before it refunds - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      const modifications = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      await prisma.xeroSyncOperation.deleteMany({
        where: { OR: [{ id: WAITING_OP_ID }, { localId: { in: [PAYMENT_ID, BOOKING_ID, ...modifications.map((row) => row.id)] } }] },
      });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: MEMBER_ID }, { actorMemberId: MEMBER_ID }, { targetId: BOOKING_ID }] } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * The issue's worked example after the increase: a $150 PAID booking whose
     * first $100 was paid (by card, or wholly by account credit) and whose
     * latest $50 is an unpaid card ask, its supplementary Xero invoice parked
     * WAITING_PAYMENT on that intent. `leavingNightCents` sizes the guest the
     * reduction removes: 2500 a night is the whole $50, less shrinks the ask,
     * more cancels it and leaves a remainder.
     */
    async function grownBooking(
      shape: "card" | "credit",
      leavingNightCents: number,
      refundPercentage = 100,
      ask: "minted" | "awaiting-retry" = "minted",
    ) {
      const stayingNightCents = 7_500 - leavingNightCents;
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: "race-3954@example.invalid", passwordHash: "x", firstName: "Ask", lastName: "Payer", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3954 Lodge", slug: "race-3954" } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage, fixedFeeCents: 0 } });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: 15_000, finalPriceCents: 15_000 },
      });
      for (const guest of [
        { id: STAYING_GUEST_ID, firstName: "Staying", nightCents: stayingNightCents },
        { id: LEAVING_GUEST_ID, firstName: "Leaving", nightCents: leavingNightCents },
      ]) {
        await prisma.bookingGuest.create({
          data: {
            id: guest.id, bookingId: BOOKING_ID, firstName: guest.firstName, lastName: "Guest", ageTier: "ADULT",
            stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: guest.nightCents * 2,
          },
        });
        await prisma.bookingGuestNight.createMany({
          data: NIGHTS.map((stayDate) => ({ bookingGuestId: guest.id, stayDate, priceCents: guest.nightCents, priceSource: "SOLD" as const })),
        });
        for (const [index, night] of NIGHTS.entries()) {
          await prisma.bookingLedgerLine.create({ data: {
            bookingId: BOOKING_ID, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: guest.nightCents, amountCents: guest.nightCents,
            bookingGuestId: guest.id, nightStart: night, nightEndExclusive: NIGHTS[index + 1] ?? CHECK_OUT, ageTier: "ADULT",
            guestNames: [`${guest.firstName} Guest`], anchorKind: "CONFIRMATION", anchorId: BOOKING_ID, narration: "race 3954 confirmation",
            lodgeId: LODGE_ID, postingKey: `race-3954-confirm-${guest.id}-${index}`,
          } });
        }
      }
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, status: "SUCCEEDED", source: "STRIPE", stripeCustomerId: "cus_race_3954",
          amountCents: shape === "card" ? 10_000 : 0,
          creditAppliedCents: shape === "card" ? 0 : 10_000,
          ...(shape === "card" ? { stripePaymentIntentId: "pi_race_3954_primary" } : {}),
        },
      });
      if (shape === "card") {
        await prisma.paymentTransaction.create({
          data: {
            id: PRIMARY_TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", status: "SUCCEEDED",
            amountCents: 10_000, stripePaymentIntentId: "pi_race_3954_primary",
          },
        });
      } else {
        const credit = await import("@/lib/member-credit");
        await prisma.memberCredit.create({
          data: { memberId: MEMBER_ID, amountCents: 10_000, type: "ADMIN_ADJUSTMENT", description: "race 3954 opening balance" },
        });
        await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, 10_000, BOOKING_ID, tx, CLUB_FORMAT_TEST));
      }
      // The increase that raised the ask, and the ask itself, as the minter wrote it.
      await prisma.bookingModification.create({
        data: { id: INCREASE_MOD_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "GUEST_ADD", previousData: {}, newData: {}, priceDiffCents: 5_000 },
      });
      if (ask === "awaiting-retry") {
        // #3954 "retry nets it off": the mint failed at the provider, so the ask
        // is a recovery row the cron will retry, not yet a ledger row or mirror.
        const { buildAdditionalIntentRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys");
        await prisma.paymentRecoveryOperation.create({
          data: {
            id: RECOVERY_ID, type: "CREATE_ADDITIONAL_PAYMENT_INTENT", status: "FAILED", bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
            paymentIntentId: `mod_guest_add_${BOOKING_ID}_${INCREASE_MOD_ID}`, amountCents: 5_000, hadIssuedXeroInvoice: false,
            idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(INCREASE_MOD_ID), attempts: 1, nextRetryAt: TODAY,
            lastError: "Stripe was unavailable",
          },
        });
        expect((await payment()).additionalAmountCents).toBe(0);
        // Owed by the price and asked of nobody until the retry runs.
        expect(await residual()).toBe(5_000);
        return;
      }
      await prisma.paymentTransaction.create({
        data: {
          id: ASK_TXN_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", status: "PENDING",
          amountCents: 5_000, stripePaymentIntentId: ASK_INTENT, reason: "guest_add_price_increase",
        },
      });
      await prisma.xeroSyncOperation.create({
        data: {
          id: WAITING_OP_ID, direction: "OUTBOUND", entityType: "INVOICE", operationType: "CREATE", status: "WAITING_PAYMENT",
          localModel: "BookingModification", localId: INCREASE_MOD_ID, queueType: "SUPPLEMENTARY_INVOICE",
          requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", bookingId: BOOKING_ID, paymentIntentId: ASK_INTENT, priceDiffCents: 5_000, changeFeeCents: 0 },
        },
      });
      const { reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
      const mirror = await payment();
      expect(mirror).toMatchObject({
        amountCents: shape === "card" ? 10_000 : 0,
        status: "SUCCEEDED",
        additionalAmountCents: 5_000,
        additionalPaymentStatus: "PENDING",
        additionalPaymentIntentId: ASK_INTENT,
      });
      expect(await residual()).toBe(0);
    }

    const payment = () => prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });

    /** `INV-PAY-047`'s residual, on the rows as they stand. */
    async function residual(): Promise<number> {
      const { bookingLedgerResidualCents } = await import("@/lib/additional-payment-ask");
      const [booking, row] = await Promise.all([
        prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { finalPriceCents: true } }),
        payment(),
      ]);
      return bookingLedgerResidualCents({ ...row, finalPriceCents: booking.finalPriceCents });
    }

    async function removeLeavingGuest() {
      const { removeBookingGuestInTransaction } = await import("@/lib/booking-guest-removal-service");
      return prisma.$transaction(
        (tx) => removeBookingGuestInTransaction({
          tx, bookingId: BOOKING_ID, guestId: LEAVING_GUEST_ID, actorMemberId: MEMBER_ID, actorRole: "ADMIN", today: TODAY, format: CLUB_FORMAT_TEST,
          settlementMethod: "card",
        }),
        { maxWait: 10_000, timeout: 20_000 },
      );
    }

    async function askAfter() {
      return prisma.paymentTransaction.findUniqueOrThrow({
        where: { id: ASK_TXN_ID },
        select: { status: true, withdrawnAt: true },
      });
    }

    const cancellations = () =>
      prisma.paymentRecoveryOperation.findMany({
        where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT" },
        select: { paymentIntentId: true, paymentTransactionId: true, status: true },
      });

    const waitingOp = () =>
      prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: WAITING_OP_ID }, select: { status: true, lastErrorCode: true } });

    async function waitForWebhookLock() {
      const startedAt = process.hrtime.bigint();
      for (;;) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE application_name = 'race-3954-webhook' AND wait_event_type = 'Lock'
        `;
        if ((rows[0]?.count ?? 0) > 0) return;
        if (realElapsedMs(startedAt) > 5_000) throw new Error("The webhook connection's statement never queued behind the edit");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const url = new URL(RACE_DB_URL);
      url.searchParams.set("connection_limit", "1");
      url.searchParams.set("application_name", "race-3954-webhook");
      webhookClient = new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      await webhookClient.$connect();
    }, 60_000);

    afterAll(async () => {
      await webhookClient?.$disconnect().catch(() => {});
      if (typeof prisma !== "undefined") {
        // Not swallowed: a leaked fixture is a false result in another suite of this shared database.
        try {
          await deleteFixtures();
        } finally {
          await prisma.$disconnect().catch(() => {});
        }
      }
    });

    it.each(["card", "credit"] as const)(
      "%s-paid: removing the 5000-cent guest cancels the 5000-cent ask - nothing refunded, the ask retired at every layer, the books balanced",
      async (shape) => {
        await grownBooking(shape, 2_500);

        const result = await removeLeavingGuest();

        expect(result.priceDiffCents).toBe(-5_000);
        expect(result.refundAmountCents).toBe(0);
        expect(result.pendingRefundAmountCents).toBe(0);
        expect(result.accountCreditAmountCents).toBe(0);
        expect(result.appliedCreditGivenBackCents).toBe(0);
        expect(result.additionalAsk.amountCents).toBe(0);
        // The ask's row, FAILED and stamped; the mirror reads past it.
        expect(await askAfter()).toEqual({ status: "FAILED", withdrawnAt: expect.any(Date) });
        expect(await payment()).toMatchObject({
          amountCents: shape === "card" ? 10_000 : 0,
          status: "SUCCEEDED",
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
          additionalPaymentIntentId: null,
        });
        // The chase and the pay door read the mirror: nothing is owed.
        const { isAdditionalPaymentOwed } = await import("@/lib/additional-payment-chase");
        expect(isAdditionalPaymentOwed({ bookingStatus: "PAID", payment: await payment() })).toBe(false);
        // Stripe's cancellation, durably queued in the edit's own transaction.
        expect(await cancellations()).toEqual([
          { paymentIntentId: ASK_INTENT, paymentTransactionId: ASK_TXN_ID, status: "PENDING" },
        ]);
        expect(result.retiredAdditionalAsks).toHaveLength(1);
        // Nothing reached Xero for the unpaid ask; its parked invoice is retired.
        expect(await waitingOp()).toEqual({ status: "CANCELLED", lastErrorCode: "ADDITIONAL_ASK_RETIRED_BY_REDUCTION" });
        // The history row the repair pass reads.
        const modification = await prisma.bookingModification.findUniqueOrThrow({ where: { id: result.bookingModificationId }, select: { newData: true } });
        expect(modification.newData).toMatchObject({ unpaidAskOffsetCents: 5_000 });
        // INV-PAY-047: $100 price, $100 paid, nothing asked.
        expect(await residual()).toBe(0);

        // Stripe confirms the cancel (the webhook's DB-only half): the queued row
        // closes and nothing comes back.
        const { completeCanceledSupersededPaymentIntentRecovery } = await import("@/lib/payment-recovery");
        expect(await completeCanceledSupersededPaymentIntentRecovery({ paymentIntentId: ASK_INTENT })).toBe(true);
        expect(await cancellations()).toEqual([
          { paymentIntentId: ASK_INTENT, paymentTransactionId: ASK_TXN_ID, status: "SUCCEEDED" },
        ]);
        expect((await payment()).additionalAmountCents).toBe(0);
        expect(await residual()).toBe(0);
      },
    );

    it.each(["card", "credit"] as const)(
      "%s-paid: removing a 2000-cent guest shrinks the 5000-cent ask to a 3000-cent re-issue that carries it, and the mint makes it the live ask",
      async (shape) => {
        await grownBooking(shape, 1_000);

        const result = await removeLeavingGuest();

        expect(result.priceDiffCents).toBe(-2_000);
        expect(result.refundAmountCents).toBe(0);
        expect(result.additionalAsk.amountCents).toBe(3_000);
        expect(result.additionalAsk.carriedCents).toBe(3_000);
        expect(result.additionalAsk.reissuesUnpaidAsk).toBe(true);
        expect(await askAfter()).toEqual({ status: "FAILED", withdrawnAt: expect.any(Date) });
        expect(await waitingOp()).toEqual({ status: "CANCELLED", lastErrorCode: "ADDITIONAL_ASK_RETIRED_BY_REDUCTION" });
        // Decision A: the retired $50 invoice less the $20 offset - the smaller
        // ask's own invoice, raised once it is minted - and the increase named.
        const history = await prisma.bookingModification.findUniqueOrThrow({ where: { id: result.bookingModificationId }, select: { newData: true } });
        expect(history.newData).toMatchObject({ unpaidAskOffsetCents: 2_000, reissuedAskInvoiceCents: 3_000, unpaidAskRetiredModificationIds: [INCREASE_MOD_ID] });
        expect(history.newData).not.toHaveProperty("unpaidAskBilledOffsetCents");

        // The mint after commit - the minter's own writer, without the provider.
        const { upsertPaymentIntentTransaction } = await import("@/lib/payment-transactions");
        await upsertPaymentIntentTransaction({
          paymentId: PAYMENT_ID,
          kind: "ADDITIONAL",
          paymentIntentId: "pi_race_3954_reissued",
          amountCents: result.additionalAsk.amountCents,
          carriedAskCents: result.additionalAsk.carriedCents,
          status: "PENDING",
          store: prisma,
        });
        expect(await payment()).toMatchObject({
          additionalAmountCents: 3_000,
          additionalPaymentStatus: "PENDING",
          additionalPaymentIntentId: "pi_race_3954_reissued",
        });
        // $130 price, $100 paid, $30 asked.
        expect(await residual()).toBe(0);
      },
    );

    it("card-paid at a 50% tier: an $80 reduction cancels the $50 ask and refunds half of the $30 left", async () => {
      await grownBooking("card", 4_000, 50);

      const result = await removeLeavingGuest();

      expect(result.priceDiffCents).toBe(-8_000);
      expect(result.refundAmountCents).toBe(1_500);
      expect(result.pendingRefundAmountCents).toBe(1_500);
      expect(result.additionalAsk.amountCents).toBe(0);
      expect((await payment()).additionalAmountCents).toBe(0);
      // Before the Stripe refund lands the club holds $100 for a $70 booking;
      // once it does, it holds exactly the policy's $15.
      expect(await residual()).toBe(-3_000);
    });

    it("credit-paid: an $80 reduction cancels the $50 ask and gives back only the $30 left, as credit", async () => {
      await grownBooking("credit", 4_000);

      const result = await removeLeavingGuest();

      expect(result.appliedCreditGivenBackCents).toBe(3_000);
      expect(result.refundAmountCents).toBe(0);
      expect((await payment()).creditAppliedCents).toBe(7_000);
      expect((await payment()).additionalAmountCents).toBe(0);
      expect(await residual()).toBe(0);
    });

    it("RACE: a capture landing between the reduction's read and its retire fails the fence and rolls the whole edit back", async () => {
      await grownBooking("card", 2_500);
      const { readUnpaidPriceAsk, retireUnpaidAskChain } = await import("@/lib/additional-ask-reduction");

      const outcome = await prisma
        .$transaction(async (tx) => {
          const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
          const ask = await readUnpaidPriceAsk(tx, booking);
          expect(ask.askCents).toBe(5_000);
          // The member's payment lands on another connection - the webhook,
          // which takes none of the edit's locks.
          await webhookClient.paymentTransaction.update({ where: { id: ASK_TXN_ID }, data: { status: "SUCCEEDED" } });
          await retireUnpaidAskChain(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, ask });
          return "committed";
        })
        .catch((err: unknown) => err);

      const { ApiError } = await import("@/lib/api-error");
      expect(outcome).toBeInstanceOf(ApiError);
      expect((outcome as InstanceType<typeof ApiError>).status).toBe(409);
      // Rolled back: the paid row stays paid and unstamped, nothing was queued,
      // the parked invoice still waits for the payment that arrived.
      expect(await askAfter()).toEqual({ status: "SUCCEEDED", withdrawnAt: null });
      expect(await cancellations()).toEqual([]);
      expect(await waitingOp()).toEqual({ status: "WAITING_PAYMENT", lastErrorCode: null });
    });

    it("RACE: a capture after the reduction commits is handed to the superseded-capture refund, in full, and the books balance once it lands", async () => {
      await grownBooking("card", 2_500);
      await removeLeavingGuest();
      expect(await residual()).toBe(0);

      // The webhook's first step for a succeeded intent.
      const { queueSupersededPaymentIntentRefundRecovery } = await import("@/lib/payment-recovery");
      expect(
        await queueSupersededPaymentIntentRefundRecovery({ paymentIntentId: ASK_INTENT, amountCents: 5_000, paymentMethodId: null }),
      ).toBe(true);

      // Captured on the ledger, still not the live ask, and owed back whole.
      expect(await askAfter()).toEqual({ status: "SUCCEEDED", withdrawnAt: expect.any(Date) });
      expect(await payment()).toMatchObject({ amountCents: 15_000, additionalAmountCents: 0, additionalPaymentStatus: null });
      const refunds = await prisma.paymentRecoveryOperation.findMany({
        where: { bookingId: BOOKING_ID, type: "REFUND_SUPERSEDED_PAYMENT" },
        select: { paymentIntentId: true, amountCents: true, status: true },
      });
      expect(refunds).toEqual([{ paymentIntentId: ASK_INTENT, amountCents: 5_000, status: "PENDING" }]);
      expect(await cancellations()).toEqual([
        { paymentIntentId: ASK_INTENT, paymentTransactionId: ASK_TXN_ID, status: "SUCCEEDED" },
      ]);
      // $100 booking, $150 captured: retained until the refund lands...
      expect(await residual()).toBe(-5_000);

      // ...and balanced once it does (the refund processor's ledger write).
      const { recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions");
      await recordStripeRefundsAgainstTransaction({
        paymentId: PAYMENT_ID,
        paymentTransactionId: ASK_TXN_ID,
        refunds: [{ id: "re_race_3954", amount: 5_000, currency: CLUB_FORMAT_TEST.currencyCode.toLowerCase(), status: "succeeded" }],
        fallbackPaymentIntentId: ASK_INTENT,
      });
      expect(await payment()).toMatchObject({ amountCents: 15_000, refundedAmountCents: 5_000, additionalAmountCents: 0 });
      expect(await residual()).toBe(0);
    });

    const recovery = () =>
      prisma.paymentRecoveryOperation.findUniqueOrThrow({
        where: { id: RECOVERY_ID },
        select: { status: true, attempts: true, nextRetryAt: true, succeededAt: true, lastError: true },
      });

    it.each(["card", "credit"] as const)(
      "%s-paid, the increase's mint awaiting its retry: removing a 2000-cent guest nets the waiting ask off - nothing refunded, the recovery closed, a 3000-cent re-issue, and the retry has nothing left to claim",
      async (shape) => {
        await grownBooking(shape, 1_000, 100, "awaiting-retry");

        const result = await removeLeavingGuest();

        expect(result.priceDiffCents).toBe(-2_000);
        expect(result.refundAmountCents).toBe(0);
        expect(result.pendingRefundAmountCents).toBe(0);
        expect(result.accountCreditAmountCents).toBe(0);
        expect(result.appliedCreditGivenBackCents).toBe(0);
        expect(result.retiredAdditionalAsks).toEqual([]);
        expect(result.additionalAsk.amountCents).toBe(3_000);
        expect(result.additionalAsk.carriedCents).toBe(3_000);
        expect(result.additionalAsk.reissuesUnpaidAsk).toBe(true);
        const { PENDING_ASK_NETTED_BY_REDUCTION_NOTE } = await import("@/lib/additional-ask-reduction");
        expect(await recovery()).toEqual({
          status: "SUCCEEDED", attempts: 1, nextRetryAt: null, succeededAt: expect.any(Date), lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE,
        });
        const modification = await prisma.bookingModification.findUniqueOrThrow({ where: { id: result.bookingModificationId }, select: { newData: true } });
        expect(modification.newData).toMatchObject({ unpaidAskOffsetCents: 2_000, unpaidAskRetiredModificationIds: [INCREASE_MOD_ID] });

        // The retry, when the cron reaches it: nothing to claim, no provider call.
        const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
        expect(await runPaymentRecoveryOperationNow(RECOVERY_ID, CLUB_FORMAT_TEST)).toBe("not-claimed");
        expect((await recovery()).status).toBe("SUCCEEDED");

        // The re-issue's mint after commit - the minter's own writer.
        const { upsertPaymentIntentTransaction } = await import("@/lib/payment-transactions");
        await upsertPaymentIntentTransaction({
          paymentId: PAYMENT_ID,
          kind: "ADDITIONAL",
          paymentIntentId: "pi_race_3954_reissued",
          amountCents: result.additionalAsk.amountCents,
          carriedAskCents: result.additionalAsk.carriedCents,
          status: "PENDING",
          store: prisma,
        });
        // $130 price, $100 paid, $30 asked - not the $50 the retry would have minted.
        expect((await payment()).additionalAmountCents).toBe(3_000);
        expect(await residual()).toBe(0);
      },
    );

    it("card-paid at a 50% tier, the mint awaiting its retry: an $80 reduction nets the whole $50 off and refunds half of the $30 left - the recovery closed with nothing to mint", async () => {
      await grownBooking("card", 4_000, 50, "awaiting-retry");

      const result = await removeLeavingGuest();

      expect(result.priceDiffCents).toBe(-8_000);
      expect(result.refundAmountCents).toBe(1_500);
      expect(result.additionalAsk.amountCents).toBe(0);
      expect((await recovery()).status).toBe("SUCCEEDED");
      expect((await payment()).additionalAmountCents).toBe(0);
      // Before the Stripe refund lands the club holds $100 for a $70 booking -
      // the policy's $15 plus the $15 refund in flight; nothing is asked.
      expect(await residual()).toBe(-3_000);
    });

    it("RACE: the retry claiming the waiting ask between the reduction's read and its retire fails the fence and rolls the whole edit back", async () => {
      await grownBooking("card", 1_000, 100, "awaiting-retry");
      const { readUnpaidPriceAsk, retireUnpaidAskChain } = await import("@/lib/additional-ask-reduction");

      const outcome = await prisma
        .$transaction(async (tx) => {
          const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
          const ask = await readUnpaidPriceAsk(tx, booking);
          expect(ask).toMatchObject({ askCents: 5_000, rows: [], recoveries: [{ id: RECOVERY_ID, attempts: 1, askCents: 5_000 }] });
          // The recovery runner's claim, on another connection that takes none
          // of the edit's locks (`claimPaymentRecoveryOperation`'s write).
          await webhookClient.paymentRecoveryOperation.update({
            where: { id: RECOVERY_ID },
            data: { status: "PROCESSING", attempts: { increment: 1 }, processingStartedAt: TODAY, lastError: null },
          });
          await retireUnpaidAskChain(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, ask });
          return "committed";
        })
        .catch((err: unknown) => err);

      const { ApiError } = await import("@/lib/api-error");
      expect(outcome).toBeInstanceOf(ApiError);
      expect((outcome as InstanceType<typeof ApiError>).status).toBe(409);
      // The retry keeps its claim and mints what it re-derives; the edit wrote
      // nothing, so the member's next save nets against the ask that retry mints.
      expect(await recovery()).toMatchObject({ status: "PROCESSING", attempts: 2, succeededAt: null });
      expect((await payment()).additionalAmountCents).toBe(0);
    });

    it("ROUND 4 (item 1): one read for the options and the save - a capture landing between them is the fence's 409, and nothing moves", async () => {
      await grownBooking("card", 4_000, 50);
      const [{ readReductionAgainstUnpaidAsk }, { calculateModificationSettlementOptions, applyPaymentAdjustments }, { AdditionalAskChangedDuringReductionError }] =
        await Promise.all([
          import("@/lib/additional-ask-reduction"),
          import("@/lib/booking-modify-settlement"),
          import("@/lib/additional-ask-reduction-error"),
        ]);

      const outcome = await prisma
        .$transaction(async (tx) => {
          const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true, guests: true } });
          const reduction = await readReductionAgainstUnpaidAsk(tx, booking, -8_000);
          const settlementOptions = await calculateModificationSettlementOptions({
            booking: booking as never, netChargeCents: -8_000, reduction, db: tx, todayAtClub: "2026-07-01" as never,
          });
          // Sized on what the $50 ask leaves: $30, at the 50% tier.
          expect(settlementOptions?.basisAmountCents).toBe(3_000);
          // The member pays the $50 ask between the options and the save.
          await webhookClient.paymentTransaction.update({ where: { id: ASK_TXN_ID }, data: { status: "SUCCEEDED" } });
          await applyPaymentAdjustments(tx, {
            booking: booking as never, priceDiffCents: -8_000, changeFeeCents: 0, reduction, settlementOptions,
            settlementMethod: "card", todayAtClub: "2026-07-01" as never, format: CLUB_FORMAT_TEST,
          });
          return "committed";
        }, { maxWait: 10_000, timeout: 20_000 })
        .catch((err: unknown) => err);

      expect(outcome).toBeInstanceOf(AdditionalAskChangedDuringReductionError);
      expect(await askAfter()).toEqual({ status: "SUCCEEDED", withdrawnAt: null });
      expect(await cancellations()).toEqual([]);
      expect(await waitingOp()).toEqual({ status: "WAITING_PAYMENT", lastErrorCode: null });
      expect((await payment()).refundedAmountCents).toBe(0);
    });

    it("ROUND 4 (item 2): a stalled retry that wrote its own row is netted against that row and closed, and cannot write again", async () => {
      await grownBooking("card", 1_000, 100, "awaiting-retry");
      const STALLED_AT = new Date("2026-06-30T23:50:00.000Z");
      // The runner claimed the retry ten minutes ago, minted $50 and wrote its
      // row - then stalled before completing.
      await prisma.paymentRecoveryOperation.update({
        where: { id: RECOVERY_ID },
        data: { status: "PROCESSING", attempts: 2, processingStartedAt: STALLED_AT, lastError: null, paymentIntentId: "pi_race_3954_retry" },
      });
      await prisma.paymentTransaction.create({
        data: { id: "race-3954-retry-row", paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", status: "PENDING", amountCents: 5_000, stripePaymentIntentId: "pi_race_3954_retry",
          // Written after its recovery was queued, as the runner's row always is.
          createdAt: new Date("2026-07-01T00:00:01.000Z") },
      });
      const { reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID });

      const result = await removeLeavingGuest();

      // Netted against the row, counted once - not skipped as overtaken.
      expect(result.refundAmountCents).toBe(0);
      expect(result.additionalAsk.amountCents).toBe(3_000);
      const modification = await prisma.bookingModification.findUniqueOrThrow({ where: { id: result.bookingModificationId }, select: { newData: true } });
      expect(modification.newData).toMatchObject({ unpaidAskOffsetCents: 2_000, unpaidAskRetiredModificationIds: [INCREASE_MOD_ID] });
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: "race-3954-retry-row" }, select: { status: true, withdrawnAt: true } }))
        .toEqual({ status: "FAILED", withdrawnAt: expect.any(Date) });
      expect(await recovery()).toMatchObject({ status: "SUCCEEDED", attempts: 2 });

      // The runner wakes and re-asserts its claim before writing again: nothing.
      const held = await webhookClient.paymentRecoveryOperation.updateMany({
        where: { id: RECOVERY_ID, status: "PROCESSING", attempts: 2, processingStartedAt: STALLED_AT },
        data: { processingStartedAt: new Date() },
      });
      expect(held.count).toBe(0);
    });

    it("ROUND 4 (item 5): a retry claimed moments ago refuses the reduction for a moment, writing nothing", async () => {
      await grownBooking("card", 1_000, 100, "awaiting-retry");
      await prisma.paymentRecoveryOperation.update({
        where: { id: RECOVERY_ID },
        data: { status: "PROCESSING", attempts: 2, processingStartedAt: new Date("2026-06-30T23:59:30.000Z") },
      });
      const { ADDITIONAL_ASK_BEING_RAISED_MESSAGE } = await import("@/lib/additional-ask-reduction-error");

      const outcome = await removeLeavingGuest().catch((err: unknown) => err);

      expect(outcome).toMatchObject({ status: 409, message: ADDITIONAL_ASK_BEING_RAISED_MESSAGE });
      expect(await recovery()).toMatchObject({ status: "PROCESSING", attempts: 2 });
      expect(await prisma.bookingModification.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
    });

    it("ROUND 4 (item 5): a stalled runner re-stamping its claim AFTER the reduction read it rolls the reduction back (409)", async () => {
      await grownBooking("card", 1_000, 100, "awaiting-retry");
      const STALLED_AT = new Date("2026-06-30T23:50:00.000Z");
      await prisma.paymentRecoveryOperation.update({
        where: { id: RECOVERY_ID },
        data: { status: "PROCESSING", attempts: 2, processingStartedAt: STALLED_AT },
      });
      const { readUnpaidPriceAsk, retireUnpaidAskChain } = await import("@/lib/additional-ask-reduction");

      const outcome = await prisma
        .$transaction(async (tx) => {
          const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
          const ask = await readUnpaidPriceAsk(tx, booking);
          expect(ask.recoveries).toMatchObject([{ id: RECOVERY_ID, status: "PROCESSING", processingStartedAt: STALLED_AT }]);
          // The runner wakes and holds its claim to write its row
          // (`holdAdditionalIntentRecoveryClaim`'s statement), and commits.
          const held = await webhookClient.paymentRecoveryOperation.updateMany({
            where: { id: RECOVERY_ID, status: "PROCESSING", attempts: 2, processingStartedAt: STALLED_AT },
            data: { processingStartedAt: new Date() },
          });
          expect(held.count).toBe(1);
          await retireUnpaidAskChain(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, ask });
          return "committed";
        })
        .catch((err: unknown) => err);

      expect(outcome).toMatchObject({ status: 409 });
      expect(await recovery()).toMatchObject({ status: "PROCESSING", attempts: 2 });
    });

    it("ROUND 4 (item 5): a reduction closing a stalled retry first makes the runner's claim hold wait, then match nothing", async () => {
      await grownBooking("card", 1_000, 100, "awaiting-retry");
      const STALLED_AT = new Date("2026-06-30T23:50:00.000Z");
      await prisma.paymentRecoveryOperation.update({
        where: { id: RECOVERY_ID },
        data: { status: "PROCESSING", attempts: 2, processingStartedAt: STALLED_AT },
      });
      const { readUnpaidPriceAsk, retireUnpaidAskChain } = await import("@/lib/additional-ask-reduction");
      let hold: Promise<{ count: number }> | null = null;

      await prisma.$transaction(
        async (tx) => {
          const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
          await retireUnpaidAskChain(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, ask: await readUnpaidPriceAsk(tx, booking) });
          hold = webhookClient.paymentRecoveryOperation
            .updateMany({
              where: { id: RECOVERY_ID, status: "PROCESSING", attempts: 2, processingStartedAt: STALLED_AT },
              data: { processingStartedAt: new Date() },
            })
            .then((held) => held);
          await waitForWebhookLock();
        },
        { maxWait: 10_000, timeout: 20_000 },
      );

      expect(await hold).toEqual({ count: 0 });
      expect(await recovery()).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    });

    it("ROUND 4 (item 4): a shrunk ask's re-issue is durable from the commit - its recovery waits out the door's grace, and the door's mint completes it with its row in one write", async () => {
      await grownBooking("card", 1_000);
      const result = await removeLeavingGuest();
      const { buildAdditionalIntentRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys");
      const reissue = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
        where: { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(result.bookingModificationId!) },
      });
      expect(reissue).toMatchObject({
        type: "CREATE_ADDITIONAL_PAYMENT_INTENT", status: "PENDING", attempts: 0, amountCents: 3_000,
        paymentIntentId: `mod_reissued_ask_${result.bookingModificationId}`,
        nextRetryAt: new Date("2026-07-01T00:01:00.000Z"),
      });
      // Before the door mints: nothing is live, and a crash here leaves the
      // recovery to ask - the runner cannot claim it inside the grace.
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(reissue.id, CLUB_FORMAT_TEST)).toBe("not-claimed");

      const [{ writeReissuedAskUnderRecovery, readReissuedAskRecovery }, { upsertPaymentIntentTransaction }] = await Promise.all([
        import("@/lib/additional-ask-reduction"),
        import("@/lib/payment-transactions"),
      ]);
      const read = (await readReissuedAskRecovery(result.bookingModificationId!))!;
      const wrote = await writeReissuedAskUnderRecovery(read, "pi_race_3954_reissued", (store) =>
        upsertPaymentIntentTransaction({
          paymentId: PAYMENT_ID, kind: "ADDITIONAL", paymentIntentId: "pi_race_3954_reissued", amountCents: 3_000,
          carriedAskCents: 3_000, status: "PENDING", store,
        }).then(() => true),
      );
      expect(wrote).toBe(true);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: reissue.id }, select: { status: true, paymentIntentId: true } }))
        .toEqual({ status: "SUCCEEDED", paymentIntentId: "pi_race_3954_reissued" });
      expect((await payment()).additionalAmountCents).toBe(3_000);
      expect(await residual()).toBe(0);
    });

    it("ROUND 4 (item 4): a runner that claimed the re-issue first leaves the door's mint writing nothing", async () => {
      await grownBooking("card", 1_000);
      const result = await removeLeavingGuest();
      const { writeReissuedAskUnderRecovery, readReissuedAskRecovery } = await import("@/lib/additional-ask-reduction");
      const read = (await readReissuedAskRecovery(result.bookingModificationId!))!;
      // The grace passed and the runner claimed it (`claimPaymentRecoveryOperation`'s write).
      await webhookClient.paymentRecoveryOperation.update({
        where: { id: read.id },
        data: { status: "PROCESSING", attempts: { increment: 1 }, processingStartedAt: new Date() },
      });
      let wrote = false;
      const outcome = await writeReissuedAskUnderRecovery(read, "pi_race_3954_reissued", async () => {
        wrote = true;
      });
      expect(outcome).toBeNull();
      expect(wrote).toBe(false);
      expect((await payment()).additionalAmountCents).toBe(0);
    });

    it("RACE: a retry claiming while the reduction holds the waiting ask waits for its commit, then matches nothing", async () => {
      await grownBooking("card", 1_000, 100, "awaiting-retry");
      const { readUnpaidPriceAsk, retireUnpaidAskChain } = await import("@/lib/additional-ask-reduction");
      let claim: Promise<{ count: number }> | null = null;

      await prisma.$transaction(
        async (tx) => {
          const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
          const ask = await readUnpaidPriceAsk(tx, booking);
          await retireUnpaidAskChain(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, ask });
          // The runner's claim, exactly as `claimPaymentRecoveryOperation` filters
          // it, issued while the edit's close is uncommitted: it queues on the row.
          // `.then` sends it now: a Prisma query is lazy until something awaits it.
          claim = webhookClient.paymentRecoveryOperation
            .updateMany({
              where: { id: RECOVERY_ID, status: { in: ["PENDING", "FAILED"] }, attempts: { lt: 5 }, nextRetryAt: { lte: TODAY } },
              data: { status: "PROCESSING", attempts: { increment: 1 }, processingStartedAt: TODAY },
            })
            .then((claimed) => claimed);
          const startedAt = process.hrtime.bigint();
          for (;;) {
            const rows = await prisma.$queryRaw<Array<{ count: number }>>`
              SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
              WHERE application_name = 'race-3954-webhook' AND wait_event_type = 'Lock'
            `;
            if ((rows[0]?.count ?? 0) > 0) break;
            if (realElapsedMs(startedAt) > 5_000) throw new Error("The retry's claim never queued behind the reduction's close");
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        },
        { maxWait: 10_000, timeout: 20_000 },
      );

      expect(await claim).toEqual({ count: 0 });
      expect(await recovery()).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
    });
  },
);
