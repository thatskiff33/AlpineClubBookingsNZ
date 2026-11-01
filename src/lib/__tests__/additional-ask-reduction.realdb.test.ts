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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

// Round 6: the harness's one shared Stripe double - pass-through unless a case
// installs a hook (see `support/stripe-race-double.ts`).
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

// #4036 review: a seam between an ordinary ask's mint and the runner's
// claim-held write, so a case can record the adopted intent elsewhere in that
// window. Pass-through unless a case installs `afterMint`.
const ordinaryAskMintHooks = vi.hoisted(() => ({
  afterMint: null as null | ((minted: { intent: { id: string }; adopted: boolean }) => Promise<void>),
}));
vi.mock("@/lib/ordinary-ask-mint", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/ordinary-ask-mint");
  return {
    ...actual,
    mintOrdinaryAskIntent: async (...args: Parameters<typeof actual.mintOrdinaryAskIntent>) => {
      const minted = await actual.mintOrdinaryAskIntent(...args);
      await ordinaryAskMintHooks.afterMint?.(minted);
      return minted;
    },
  };
});

// #4081: the officers' recovery alert, counted. Pass-through; no other file
// in the harness doubles this module.
const recoveryAlerts = vi.hoisted(() => ({ sent: [] as Array<{ operationId?: string; errorMessage: string }> }));
vi.mock("@/lib/payment-recovery-alert", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/payment-recovery-alert");
  return {
    ...actual,
    alertPaymentRecoveryOfficers: async (...args: Parameters<typeof actual.alertPaymentRecoveryOfficers>) => {
      recoveryAlerts.sent.push({ operationId: args[0].operationId, errorMessage: args[0].errorMessage });
      return actual.alertPaymentRecoveryOfficers(...args);
    },
  };
});

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
const PRIMARY_INVOICE_ID = "inv_race_3954_primary";
/** When the increase's ask row was written. */
const ASK_WRITTEN_AT = new Date("2026-06-20T00:00:00.000Z");

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
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, ...modifications.map((row) => row.id)] } } });
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
      /**
       * Round 7: which invoice billed the ask is the asking edit's own answer,
       * stamped on its row (or its recovery's, for a row a recovery minted).
       * `primary-after-increase`: the edit saw no primary invoice, so the one
       * raised afterwards billed the ask; `primary-before-increase`: it saw one,
       * so the increase's own supplementary invoice (not queued yet) bills it;
       * `primary-unrecorded`: a row minted before the answer was stamped.
       * `late-link` (over-credit shape): as `primary-before-increase`, with the
       * primary invoice's link backfilled AFTER the row was written.
       * `recovery-minted` (under-credit shape): the edit saw no invoice, its
       * mint failed, the primary invoice was linked, and only then did its
       * recovery mint the row - the recovery's frozen answer decides.
       */
      invoice:
        | "parked"
        | "primary-after-increase"
        | "primary-before-increase"
        | "primary-unrecorded"
        | "late-link"
        | "recovery-minted" = "parked",
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
          // Round 5: the primary invoice was raised AFTER the increase, so it
          // bills the ask and no supplementary invoice was ever parked on it.
          ...(invoice !== "parked" ? { xeroInvoiceId: PRIMARY_INVOICE_ID } : {}),
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
      const stampedAnswer =
        invoice === "primary-before-increase" || invoice === "late-link"
          ? true
          : invoice === "primary-after-increase"
            ? false
            : null;
      await prisma.paymentTransaction.create({
        data: {
          id: ASK_TXN_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", status: "PENDING",
          amountCents: 5_000, stripePaymentIntentId: ASK_INTENT,
          reason: invoice === "recovery-minted" ? "modification_additional_recovery" : "guest_add_price_increase",
          createdAt: ASK_WRITTEN_AT,
          ...(invoice === "parked" ? {} : { hadIssuedXeroInvoice: stampedAnswer }),
        },
      });
      if (invoice === "late-link" || invoice === "recovery-minted") {
        // Round 6 dated the row against this link: a backfilled link after the
        // row read "billed by the primary" (over-credit); a link before a
        // recovery's late mint read "supplementary" (under-credit).
        await prisma.xeroObjectLink.create({
          data: {
            localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: PRIMARY_INVOICE_ID, role: "PRIMARY_INVOICE",
            createdAt: invoice === "late-link" ? new Date("2026-06-25T00:00:00.000Z") : new Date("2026-06-10T00:00:00.000Z"),
          },
        });
      }
      if (invoice === "recovery-minted") {
        const { buildAdditionalIntentRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys");
        await prisma.paymentRecoveryOperation.create({
          data: {
            id: RECOVERY_ID, type: "CREATE_ADDITIONAL_PAYMENT_INTENT", status: "SUCCEEDED", bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
            paymentIntentId: ASK_INTENT, amountCents: 5_000, hadIssuedXeroInvoice: false,
            idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(INCREASE_MOD_ID), attempts: 2, nextRetryAt: null,
            createdAt: new Date("2026-06-05T00:00:00.000Z"), succeededAt: ASK_WRITTEN_AT,
          },
        });
      }
      if (invoice === "parked") await prisma.xeroSyncOperation.create({
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

    afterEach(() => {
      resetStripeRaceHooks();
      ordinaryAskMintHooks.afterMint = null;
      recoveryAlerts.sent = [];
    });

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

    // #4217 (`INV-LOCK-002`): the capture webhook (`markPaymentIntentTransactionSucceeded`)
    // takes the Payment row, then the ask's row. A retire that stamped the row
    // first and reached the Payment row only at its reconcile would deadlock it.
    // Forced: the webhook connection holds the Payment row, as its first step
    // does; the retire starts and queues behind it; only then does the webhook
    // record the capture and commit.
    it("RACE (#4217): the capture webhook holding the Payment row while the retire starts: no deadlock, the fence refuses the retire (409), the capture stands", async () => {
      await grownBooking("card", 2_500);
      const { readUnpaidPriceAsk, retireUnpaidAskChain } = await import("@/lib/additional-ask-reduction");
      const { lockPaymentForRefundedTotal, markPaymentIntentTransactionSucceeded } = await import("@/lib/payment-transactions");

      let resolveHeld!: () => void;
      const held = new Promise<void>((resolve) => (resolveHeld = resolve));
      let resolveQueued!: () => void;
      const retireQueued = new Promise<void>((resolve) => (resolveQueued = resolve));
      let webhookPid = 0;
      const webhook = webhookClient
        .$transaction(
          async (tx) => {
            webhookPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`)[0]!.pid;
            await lockPaymentForRefundedTotal(tx, PAYMENT_ID);
            resolveHeld();
            await retireQueued;
            await markPaymentIntentTransactionSucceeded({ paymentIntentId: ASK_INTENT, amountCents: 5_000, paymentMethodId: "pm_race_3954", store: tx });
            return "captured";
          },
          { maxWait: 5_000, timeout: 30_000 },
        )
        .catch((err: unknown) => {
          resolveHeld();
          return err;
        });
      await held;

      const retire = prisma
        .$transaction(
          async (tx) => {
            const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
            const ask = await readUnpaidPriceAsk(tx, booking);
            await retireUnpaidAskChain(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, ask });
            return "committed";
          },
          { maxWait: 5_000, timeout: 30_000 },
        )
        .catch((err: unknown) => err);

      let queued = 0;
      try {
        const startedAt = process.hrtime.bigint();
        while (realElapsedMs(startedAt) < 3_000) {
          const rows = await prisma.$queryRaw<Array<{ count: number }>>`
            SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
            WHERE datname = current_database() AND ${webhookPid}::int = ANY(pg_blocking_pids(pid))
          `;
          queued = rows[0]?.count ?? 0;
          if (queued >= 1) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        resolveQueued();
      }
      const [webhookOutcome, retireOutcome] = await Promise.all([webhook, retire]);
      expect(queued, "the retire never queued behind the webhook's Payment row").toBeGreaterThanOrEqual(1);

      // No deadlock on either side: the webhook committed, and the retire's
      // refusal is its fence's - a 409 with no database error behind it.
      expect(webhookOutcome).toBe("captured");
      const { AdditionalAskChangedDuringReductionError } = await import("@/lib/additional-ask-reduction-error");
      expect(retireOutcome).toBeInstanceOf(AdditionalAskChangedDuringReductionError);
      expect((retireOutcome as Error).cause, `the retire deadlocked: ${String((retireOutcome as Error).cause)}`).toBeUndefined();
      expect(await askAfter()).toEqual({ status: "SUCCEEDED", withdrawnAt: null });
      expect(await cancellations()).toEqual([]);
      expect(await waitingOp()).toEqual({ status: "WAITING_PAYMENT", lastErrorCode: null });
      expect(await payment()).toMatchObject({ additionalAmountCents: 5_000, additionalPaymentStatus: "SUCCEEDED", amountCents: 15_000 });
    });

    it("RACE: a capture after the reduction commits is handed to the superseded-capture refund, in full, and the books balance once it lands", async () => {
      await grownBooking("card", 2_500);
      await removeLeavingGuest();
      expect(await residual()).toBe(0);

      // The webhook's first step for a succeeded intent.
      const { queueSupersededPaymentIntentRefundRecovery } = await import("@/lib/payment-recovery");
      expect(
        await queueSupersededPaymentIntentRefundRecovery({ id: ASK_INTENT, amount: 5_000, payment_method: null }),
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
        const { PENDING_ASK_NETTED_BY_REDUCTION_NOTE } = await import("@/lib/additional-ask-recovery-close");
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

    // #4217 review (F1): one order for the Payment row and the recovery row -
    // Payment first. A reduction that gives credit back has written the Payment
    // row before its retire closes the waiting recovery; the runner's claim hold
    // used to re-stamp the recovery row and only then reach the Payment row (its
    // row write). Forced, through the REAL runner: it claims the waiting mint
    // and pauses at its Stripe call; ten minutes on, the edit reads that claim
    // as stalled (closeable) and writes the Payment row as the give-back does;
    // the runner resumes and queues at its claim hold; only then does the edit
    // run the REAL retire. Before the fix the hold held the recovery row the
    // retire's close waited on, while waiting on the edit's Payment row: 40P01.
    it("RACE (#4217 F1): a credit give-back's reduction racing the runner's claim hold on a stalled retry: no deadlock - the reduction nets it off, the runner's hold finds its claim gone", async () => {
      await grownBooking("credit", 4_000, 100, "awaiting-retry");
      const frozenNow = new Date();
      const stripe = fakeStripe();
      const { readUnpaidPriceAsk, retireUnpaidAskChain } = await import("@/lib/additional-ask-reduction");
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");

      let resolveHeld!: () => void;
      const held = new Promise<void>((resolve) => (resolveHeld = resolve));
      let resolveQueued!: () => void;
      const runnerQueued = new Promise<void>((resolve) => (resolveQueued = resolve));
      let editPid = 0;
      let edit: Promise<unknown> = Promise.resolve("never started");
      stripeRaceHooks.create = (async (args: Parameters<typeof stripe.create>[0]) => {
        // The runner has claimed the recovery; to the edit that claim is now stalled.
        vi.setSystemTime(new Date(frozenNow.getTime() + 10 * 60_000));
        edit = webhookClient
          .$transaction(
            async (tx) => {
              editPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`)[0]!.pid;
              const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
              const ask = await readUnpaidPriceAsk(tx, booking);
              expect(ask.recoveries).toEqual([expect.objectContaining({ id: RECOVERY_ID, status: "PROCESSING", attempts: 2 })]);
              // The give-back's write of the Payment row (`booking-modify-credit-give-back.ts`).
              await tx.payment.update({ where: { id: PAYMENT_ID }, data: { creditAppliedCents: { decrement: 0 } } });
              resolveHeld();
              await runnerQueued;
              await retireUnpaidAskChain(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, ask });
              return "committed";
            },
            { maxWait: 5_000, timeout: 30_000 },
          )
          .catch((err: unknown) => {
            resolveHeld();
            return err;
          });
        await held;
        return stripe.create(args);
      }) as never;

      let queued = 0;
      let runnerOutcome: unknown;
      try {
        const runner = runPaymentRecoveryOperationNow(RECOVERY_ID, CLUB_FORMAT_TEST).catch((err: unknown) => err);
        await held;
        try {
          const startedAt = process.hrtime.bigint();
          while (realElapsedMs(startedAt) < 3_000) {
            const rows = await prisma.$queryRaw<Array<{ count: number }>>`
              SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
              WHERE datname = current_database() AND ${editPid}::int = ANY(pg_blocking_pids(pid))
            `;
            queued = rows[0]?.count ?? 0;
            if (queued >= 1) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } finally {
          resolveQueued();
        }
        runnerOutcome = await runner;
      } finally {
        vi.setSystemTime(frozenNow);
      }
      const editOutcome = await edit;
      expect(queued, "the runner's claim hold never queued behind the edit's Payment row").toBeGreaterThanOrEqual(1);

      // No deadlock: the reduction committed, netting the stalled retry off;
      // the runner's hold then found its claim gone and wrote nothing.
      expect(editOutcome, `the reduction failed: ${String((editOutcome as Error)?.cause ?? editOutcome)}`).toBe("committed");
      expect(runnerOutcome).not.toBe("failed");
      expect(runnerOutcome).not.toBeInstanceOf(Error);
      const closed = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: RECOVERY_ID }, select: { status: true, lastError: true } });
      expect(closed.status).toBe("SUCCEEDED");
      expect(closed.lastError ?? "").not.toMatch(/deadlock|40P01/);
      expect(await liveAsks()).toEqual([]);
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
        import("@/lib/additional-ask-reissue"),
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
      const { writeReissuedAskUnderRecovery, readReissuedAskRecovery } = await import("@/lib/additional-ask-reissue");
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

    // ROUND 5 (owner decision 10 Oct 2026, "Auto credit note"): the primary
    // invoice raised after the increase bills the ask, so the part of the
    // offset it billed takes a scoped invoice-correction note against it,
    // queued in the edit's own transaction and keyed on the reducing edit.
    const billedOffsetNotes = (bookingModificationId: string) =>
      prisma.xeroSyncOperation.findMany({
        where: { entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "BookingModification", localId: bookingModificationId },
        select: { id: true, status: true, correlationKey: true, requestPayload: true },
      });

    it.each([
      { shape: "card" as const, leavingNightCents: 2_500, billedCents: 5_000, reissuedCents: 0 },
      { shape: "credit" as const, leavingNightCents: 2_500, billedCents: 5_000, reissuedCents: 0 },
      { shape: "card" as const, leavingNightCents: 1_000, billedCents: 2_000, reissuedCents: 3_000 },
    ])(
      "ROUND 5: $shape-paid, the primary invoice billed the ask - a $billedCents offset queues one scoped invoice-correction note for exactly it, and every replay finds that one",
      async ({ shape, leavingNightCents, billedCents, reissuedCents }) => {
        await grownBooking(shape, leavingNightCents, 100, "minted", "primary-after-increase");

        const result = await removeLeavingGuest();
        const reductionId = result.bookingModificationId!;

        expect(result.refundAmountCents).toBe(0);
        expect(result.additionalAsk.amountCents).toBe(reissuedCents);
        const history = await prisma.bookingModification.findUniqueOrThrow({ where: { id: reductionId }, select: { newData: true } });
        expect(history.newData).toMatchObject({ unpaidAskOffsetCents: billedCents, unpaidAskBilledOffsetCents: billedCents });
        // Never doubled with decision A: nothing of the ask's money was on a
        // parked invoice, so the smaller re-issue has no invoice of its own.
        expect(history.newData).not.toHaveProperty("reissuedAskInvoiceCents");

        const { buildXeroIdempotencyKey } = await import("@/lib/xero-sync");
        const { UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE } = await import("@/lib/xero-review-task-key");
        const key = buildXeroIdempotencyKey("booking-mod", reductionId, "review-task", UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE, "mod-credit-note", billedCents, "v1");
        const [note, ...others] = await billedOffsetNotes(reductionId);
        expect(others).toEqual([]);
        expect(note).toMatchObject({
          status: "PENDING",
          correlationKey: key,
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: BOOKING_ID,
            bookingModificationId: reductionId,
            refundAmountCents: billedCents,
            noteWording: "invoice-correction",
            reviewTaskId: UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE,
          },
        });

        // Replays: the door's follow-ups again, then the repair pass's enqueue
        // while it is pending, and again once it has landed in Xero.
        const { queueReductionAskFollowUps } = await import("@/lib/unpaid-ask-billed-offset-note");
        await prisma.$transaction((tx) =>
          queueReductionAskFollowUps(tx, {
            bookingId: BOOKING_ID,
            paymentId: PAYMENT_ID,
            bookingModificationId: reductionId,
            settled: { ...result, hasIssuedXeroInvoice: true, unpaidAskBilledOffsetCents: billedCents },
          }),
        );
        const { enqueueXeroModificationCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
        const repairEnqueue = () =>
          enqueueXeroModificationCreditNoteOperation({
            bookingId: BOOKING_ID,
            bookingModificationId: reductionId,
            refundAmountCents: billedCents,
            noteWording: "invoice-correction",
            reviewTaskId: UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE,
          });
        expect((await repairEnqueue()).queueOperationId).toBe(note!.id);
        await prisma.xeroSyncOperation.update({ where: { id: note!.id }, data: { status: "SUCCEEDED", completedAt: TODAY } });
        expect((await repairEnqueue()).queueOperationId).toBe(note!.id);
        expect((await billedOffsetNotes(reductionId)).map((row) => row.id)).toEqual([note!.id]);
      },
    );

    it.each([
      { leavingNightCents: 4_000, refundLeftCents: 3_000, expected: true },
      { leavingNightCents: 2_500, refundLeftCents: 0, expected: false },
    ])(
      "ROUND 7 (F6), #4049: the billed-offset note and the edit's history record whether the edit's own note is expected - a $refundLeftCents refund left after the ask",
      async ({ leavingNightCents, refundLeftCents, expected }) => {
        await grownBooking("card", leavingNightCents, 100, "minted", "primary-after-increase");
        const result = await removeLeavingGuest();
        expect(result.xeroRefundAmountCents).toBe(refundLeftCents);
        const [note, ...others] = await billedOffsetNotes(result.bookingModificationId!);
        expect(others).toEqual([]);
        expect((note!.requestPayload as Record<string, unknown>).ownNoteExpected ?? false).toBe(expected);
        // #4049: the edit's history row records the same answer, for the repair pass.
        const history = await prisma.bookingModification.findUniqueOrThrow({ where: { id: result.bookingModificationId! }, select: { newData: true } });
        expect((history.newData as Record<string, unknown>).unpaidAskBilledOffsetOwnNoteExpected).toBe(expected);
      },
    );

    it("ROUND 5: where the increase's own invoice was parked on the ask, it is retired instead and no note is queued", async () => {
      await grownBooking("card", 2_500);
      const result = await removeLeavingGuest();

      expect(await waitingOp()).toEqual({ status: "CANCELLED", lastErrorCode: "ADDITIONAL_ASK_RETIRED_BY_REDUCTION" });
      const history = await prisma.bookingModification.findUniqueOrThrow({ where: { id: result.bookingModificationId! }, select: { newData: true } });
      expect(history.newData).not.toHaveProperty("unpaidAskBilledOffsetCents");
      expect(await billedOffsetNotes(result.bookingModificationId!)).toEqual([]);
    });

    it("ROUND 5: the note commits with the edit - an edit that rolls back leaves no note behind", async () => {
      await grownBooking("card", 2_500, 100, "minted", "primary-after-increase");
      const { removeBookingGuestInTransaction } = await import("@/lib/booking-guest-removal-service");
      let reductionId: string | undefined;

      const outcome = await prisma
        .$transaction(
          async (tx) => {
            const result = await removeBookingGuestInTransaction({
              tx, bookingId: BOOKING_ID, guestId: LEAVING_GUEST_ID, actorMemberId: MEMBER_ID, actorRole: "ADMIN", today: TODAY, format: CLUB_FORMAT_TEST,
              settlementMethod: "card",
            });
            reductionId = result.bookingModificationId!;
            // Queued inside the edit's transaction, visible to it before commit.
            expect(await tx.xeroSyncOperation.count({ where: { entityType: "CREDIT_NOTE", localId: reductionId } })).toBe(1);
            throw new Error("a later step of the same edit failed");
          },
          { maxWait: 10_000, timeout: 20_000 },
        )
        .catch((err: unknown) => err);

      expect((outcome as Error).message).toBe("a later step of the same edit failed");
      expect(reductionId).toBeDefined();
      expect(await billedOffsetNotes(reductionId!)).toEqual([]);
      expect(await askAfter()).toEqual({ status: "PENDING", withdrawnAt: null });
    });
  
    // ROUND 6. A fake Stripe with Stripe's own idempotency rule: a key replayed
    // with the same parameters returns the first intent; with different ones it
    // is refused (`idempotency_error`).
    function fakeStripe() {
      const intents = new Map<string, { id: string; amount: number; currency: string; customer: string | null; created: number; client_secret: string; metadata: Record<string, string>; status: string }>();
      const byKey = new Map<string, { params: string; id: string }>();
      const create = async (args: { amountCents: number; customerId?: string; metadata?: Record<string, string>; idempotencyKey?: string }) => {
        const params = JSON.stringify({ amount: args.amountCents, customer: args.customerId ?? null, metadata: args.metadata ?? {} });
        const previous = args.idempotencyKey ? byKey.get(args.idempotencyKey) : undefined;
        if (previous) {
          if (previous.params !== params) {
            throw Object.assign(new Error("Keys for idempotent requests can only be used with the same parameters"), { rawType: "idempotency_error" });
          }
          return intents.get(previous.id)!;
        }
        // #4036: the fields an ordinary ask's refused replay matches on.
        const { stripeChargeCurrency } = await import("@/lib/stripe-charge-currency");
        const intent = {
          id: `pi_fake_3954_${intents.size + 1}`, amount: args.amountCents, currency: stripeChargeCurrency(CLUB_FORMAT_TEST),
          customer: args.customerId ?? null, created: Math.floor(Date.now() / 1000), client_secret: `secret_${intents.size + 1}`,
          metadata: args.metadata ?? {}, status: "requires_payment_method",
        };
        intents.set(intent.id, intent);
        if (args.idempotencyKey) byKey.set(args.idempotencyKey, { params, id: intent.id });
        return intent;
      };
      stripeRaceHooks.create = create as never;
      stripeRaceHooks.findByMetadata = (async ({ metadataKey, metadataValue }: { metadataKey: string; metadataValue: string }) =>
        [...intents.values()].find((intent) => intent.metadata[metadataKey] === metadataValue) ?? null) as never;
      stripeRaceHooks.list = (async ({ matches }: { matches: (intent: never) => boolean }) => ({
        intents: [...intents.values()].filter((intent) => matches(intent as never)),
        complete: true,
      })) as never;
      stripeRaceHooks.cancel = (async (id: string) => ({ paymentIntent: { id, status: "canceled" }, canceled: true })) as never;
      return { intents, create };
    }

    async function reissueRecovery(bookingModificationId: string) {
      const { buildAdditionalIntentRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys");
      return prisma.paymentRecoveryOperation.findUniqueOrThrow({
        where: { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(bookingModificationId) },
      });
    }

    async function mintAtDoor(result: Awaited<ReturnType<typeof removeLeavingGuest>>) {
      const { createModificationAdditionalPaymentIntent } = await import("@/lib/booking-modification-settlement");
      return createModificationAdditionalPaymentIntent({
        format: CLUB_FORMAT_TEST, bookingId: BOOKING_ID, result: result as never, door: "guestRemoval",
        failureMessage: "race 3954 door mint",
      });
    }

    const liveAsks = () =>
      prisma.paymentTransaction.findMany({
        where: { paymentId: PAYMENT_ID, kind: "ADDITIONAL", withdrawnAt: null, status: "PENDING" },
        select: { stripePaymentIntentId: true, amountCents: true, carriedAskCents: true, reason: true },
      });

    it("ROUND 6 (F1): the door minted at Stripe and lost the reply - the runner's replay under the same key gets that SAME intent, never an idempotency_error", async () => {
      await grownBooking("card", 1_000);
      const result = await removeLeavingGuest();
      const stripe = fakeStripe();
      let lose = true;
      stripeRaceHooks.create = (async (args: Parameters<typeof stripe.create>[0]) => {
        const intent = await stripe.create(args);
        if (lose) {
          lose = false;
          throw new Error("socket hang up");
        }
        return intent;
      }) as never;

      expect((await mintAtDoor(result)).additionalPaymentIntentId).toBeUndefined();
      const recovery = await reissueRecovery(result.bookingModificationId!);
      expect(recovery.status).toBe("PENDING");
      // The grace passes; the runner replays it.
      await prisma.paymentRecoveryOperation.update({ where: { id: recovery.id }, data: { nextRetryAt: new Date("2026-06-30T00:00:00.000Z") } });
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(stripe.intents.size).toBe(1);
      const [intent] = [...stripe.intents.values()];
      const { REISSUED_ASK_REASON } = await import("@/lib/payment-recovery-keys");
      expect(await liveAsks()).toEqual([{ stripePaymentIntentId: intent!.id, amountCents: 3_000, carriedAskCents: 3_000, reason: REISSUED_ASK_REASON }]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id }, select: { status: true, paymentIntentId: true } }))
        .toEqual({ status: "SUCCEEDED", paymentIntentId: intent!.id });
    });

    it("ROUND 6 (F1): the runner minted first while the door was minting - the door's request gets the same intent and writes nothing beside it", async () => {
      await grownBooking("card", 1_000);
      const result = await removeLeavingGuest();
      const stripe = fakeStripe();
      const recovery = await reissueRecovery(result.bookingModificationId!);
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      let doorFirst = true;
      stripeRaceHooks.create = (async (args: Parameters<typeof stripe.create>[0]) => {
        if (doorFirst) {
          doorFirst = false;
          // The door read its recovery PENDING and is minting; the grace passes
          // and the runner claims, mints and writes first.
          await prisma.paymentRecoveryOperation.update({ where: { id: recovery.id }, data: { nextRetryAt: new Date("2026-06-30T00:00:00.000Z") } });
          expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        }
        return stripe.create(args);
      }) as never;

      // #4052: the door lost its fence to the runner, which owns this intent - never cancelled.
      const cancelled: string[] = [];
      stripeRaceHooks.cancel = (async (id: string) => {
        cancelled.push(id);
        return { paymentIntent: { id, status: "canceled" }, canceled: true };
      }) as never;

      expect((await mintAtDoor(result)).additionalPaymentIntentId).toBeUndefined();

      expect(stripe.intents.size).toBe(1);
      const [intent] = [...stripe.intents.values()];
      expect((await liveAsks()).map((row) => row.stripePaymentIntentId)).toEqual([intent!.id]);
      expect((await payment()).additionalPaymentIntentId).toBe(intent!.id);
      expect(cancelled.filter((id) => stripe.intents.has(id))).toEqual([]); // the retired ask's own cancel is not this one
    });

    // #4052: a later edit closes the waiting re-issue's recovery without a mint
    // (`closeWaitingAskRecoveries`, through its real writers) - a reduction
    // netting it off, or an increase folding it into its own ask.
    async function closeWaitingReissue(by: "netted" | "folded") {
      const [{ readUnpaidPriceAsk, retireUnpaidAskChain }, { foldWaitingReissuedAsks }] = await Promise.all([
        import("@/lib/additional-ask-reduction"),
        import("@/lib/additional-ask-reissue"),
      ]);
      await webhookClient.$transaction(async (tx) => {
        const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
        if (by === "folded") {
          expect((await foldWaitingReissuedAsks(tx as never, booking as never)).cents).toBe(3_000);
          return;
        }
        const ask = await readUnpaidPriceAsk(tx as never, booking as never);
        await retireUnpaidAskChain(tx as never, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, ask });
      });
    }

    it.each(["netted", "folded"] as const)(
      "#4052: a re-issue %s by a later edit while the door mints it - the door's unused intent is cancelled at Stripe, and nothing is written for it",
      async (by) => {
        await grownBooking("card", 1_000);
        const result = await removeLeavingGuest();
        const stripe = fakeStripe();
        const recovery = await reissueRecovery(result.bookingModificationId!);
        const cancelled: string[] = [];
        stripeRaceHooks.cancel = (async (id: string) => {
          cancelled.push(id);
          stripe.intents.get(id)!.status = "canceled";
          return { paymentIntent: { id, status: "canceled" }, canceled: true };
        }) as never;
        let doorFirst = true;
        stripeRaceHooks.create = (async (args: Parameters<typeof stripe.create>[0]) => {
          if (doorFirst) {
            doorFirst = false;
            // The door read its recovery PENDING and is minting.
            await closeWaitingReissue(by);
          }
          return stripe.create(args);
        }) as never;

        const minted = await mintAtDoor(result);

        expect(minted).toEqual({ additionalPaymentClientSecret: undefined, additionalPaymentIntentId: undefined, additionalAskRetired: by === "netted" });
        expect(stripe.intents.size).toBe(1);
        const [intent] = [...stripe.intents.values()];
        expect(cancelled.filter((id) => stripe.intents.has(id))).toEqual([intent!.id]);
        expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: intent!.id } })).toBeNull();
        expect((await cancellations()).filter((row) => row.paymentIntentId === intent!.id)).toEqual([]);
        expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id }, select: { status: true, paymentIntentId: true } }))
          .toEqual({ status: "SUCCEEDED", paymentIntentId: recovery.paymentIntentId });
        expect(await liveAsks()).toEqual([]);

        // Repeated: Stripe answers "already cancelled", and nothing else moves.
        const { settleLostReissuedAskFence } = await import("@/lib/reissued-ask-abandoned-intent");
        stripeRaceHooks.cancel = (async (id: string) => {
          cancelled.push(id);
          return { paymentIntent: { id, status: "canceled" }, canceled: false };
        }) as never;
        await settleLostReissuedAskFence({ bookingId: BOOKING_ID, bookingModificationId: result.bookingModificationId!, paymentIntentId: intent!.id });
        expect(cancelled.filter((id) => stripe.intents.has(id))).toEqual([intent!.id, intent!.id]);
        expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: intent!.id } })).toBeNull();
      },
    );

    it("#4052: a re-issue a later reduction netted off BEFORE the door minted is not minted, and nothing is cancelled", async () => {
      await grownBooking("card", 1_000);
      const result = await removeLeavingGuest();
      const stripe = fakeStripe();
      const cancelled: string[] = [];
      stripeRaceHooks.cancel = (async (id: string) => {
        cancelled.push(id);
        return { paymentIntent: { id, status: "canceled" }, canceled: true };
      }) as never;
      await closeWaitingReissue("netted");

      expect(await mintAtDoor(result)).toEqual({ additionalPaymentClientSecret: undefined, additionalPaymentIntentId: undefined, additionalAskRetired: true });
      expect(stripe.intents.size).toBe(0);
      expect(cancelled.filter((id) => stripe.intents.has(id))).toEqual([]); // the retired ask's own cancel is not this one
    });

    // #4052: a declined card fails the row and nothing more; only a retiring
    // writer's evidence makes it retired - here a supersede's queued cancel.
    it("#4052: a declined ask stays live; once a supersede queues its cancellation it is retired", async () => {
      await grownBooking("card", 1_000);
      const [{ markPaymentIntentTransactionFailed }, { isMintedAskStillLive }, { queueSupersededAdditionalIntentCancellationRows }] = await Promise.all([
        import("@/lib/payment-transactions"),
        import("@/lib/reissued-ask-invoice"),
        import("@/lib/booking-payment-cleanup"),
      ]);
      await markPaymentIntentTransactionFailed({ paymentIntentId: ASK_INTENT });
      expect(await askAfter()).toEqual({ status: "FAILED", withdrawnAt: null });
      expect(await isMintedAskStillLive(ASK_INTENT)).toBe(true);

      await queueSupersededAdditionalIntentCancellationRows({ bookingId: BOOKING_ID, paymentId: PAYMENT_ID, newPaymentIntentId: null });
      expect((await cancellations()).map((row) => row.paymentIntentId)).toEqual([ASK_INTENT]);
      expect(await isMintedAskStillLive(ASK_INTENT)).toBe(false);
    });

    // #4442 review M4: the re-issue's two writers re-read the live ask they
    // carry under the queue's locks. An ask minted since the reduction (C) is
    // carried by the re-issue; a stale tab paying C after the re-issue was sized
    // and before its write must refuse the write, so C is never asked twice.
    const LIVE_SINCE_MOD_ID = "race-3954-live-since-reduction";
    const LIVE_SINCE_CENTS = 2_000;

    /** C: an ordinary ask minted after the reduction, through the real door; it folds nothing and carries nothing. */
    async function askMintedSinceReduction(): Promise<string> {
      const [{ createModificationAdditionalPaymentIntent }, { sizeAdditionalAsk }] = await Promise.all([
        import("@/lib/booking-modification-settlement"),
        import("@/lib/additional-payment-ask"),
      ]);
      await prisma.bookingModification.create({
        data: { id: LIVE_SINCE_MOD_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "GUEST_ADD", previousData: {}, newData: {}, priceDiffCents: LIVE_SINCE_CENTS },
      });
      const minted = await createModificationAdditionalPaymentIntent({
        format: CLUB_FORMAT_TEST,
        bookingId: BOOKING_ID,
        door: "guestAdd",
        failureMessage: "race 4442 live ask",
        result: {
          pendingRefundAmountCents: 0,
          organiserChildRefund: null,
          paymentId: PAYMENT_ID,
          additionalAsk: sizeAdditionalAsk({ priceDiffCents: LIVE_SINCE_CENTS, changeFeeCents: 0, payment: await payment() }),
          retiredAdditionalAsks: [],
          hasSucceededPayment: true,
          hasIssuedXeroInvoice: false,
          paymentCustomerId: null,
          memberEmail: "race-3954@example.invalid",
          memberName: "Ask Payer",
          memberFirstName: "Ask",
          memberId: MEMBER_ID,
          bookingModificationId: LIVE_SINCE_MOD_ID,
          priceLines: null,
        } as never,
      });
      expect(minted.additionalPaymentIntentId, "C was minted").toBeDefined();
      return minted.additionalPaymentIntentId!;
    }

    /** A stale tab pays C: Stripe captures it and the settle the webhook runs records it. */
    async function staleTabPays(stripe: ReturnType<typeof fakeStripe>, intentId: string) {
      stripe.intents.get(intentId)!.status = "succeeded";
      const { markPaymentIntentTransactionSucceeded } = await import("@/lib/payment-transactions");
      await markPaymentIntentTransactionSucceeded({ paymentIntentId: intentId, amountCents: LIVE_SINCE_CENTS, paymentMethodId: "pm_race_4442" });
    }

    /** The re-issue minted at last: its own $30 alone, nothing of the captured C carried, and C never cancelled. */
    async function expectReissueAlone(c: string, recoveryId: string) {
      const { REISSUED_ASK_REASON } = await import("@/lib/payment-recovery-keys");
      const live = await liveAsks();
      expect(live).toEqual([{ stripePaymentIntentId: expect.any(String), amountCents: 3_000, carriedAskCents: 3_000, reason: REISSUED_ASK_REASON }]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recoveryId }, select: { status: true, paymentIntentId: true } }))
        .toEqual({ status: "SUCCEEDED", paymentIntentId: live[0]!.stripePaymentIntentId });
      expect((await cancellations()).filter((row) => row.paymentIntentId === c)).toEqual([]);
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { stripePaymentIntentId: c }, select: { status: true } }))
        .toEqual({ status: "SUCCEEDED" });
    }

    it("#4442 M4: C paid between the re-issue door's sizing and its write - the door writes nothing, the recovery stays PENDING, and the replay carries none of C", async () => {
      await grownBooking("card", 1_000);
      const result = await removeLeavingGuest();
      const stripe = fakeStripe();
      const c = await askMintedSinceReduction();
      const recovery = await reissueRecovery(result.bookingModificationId!);
      const { REISSUED_ASK_REASON } = await import("@/lib/payment-recovery-keys");
      stripeRaceHooks.create = (async (args: Parameters<typeof stripe.create>[0]) => {
        // The door sized the re-issue on C's live $20 ($50 in all); C is paid before its write.
        if (args.metadata?.reason === REISSUED_ASK_REASON && stripe.intents.get(c)!.status !== "succeeded") {
          expect(args.amountCents).toBe(5_000);
          await staleTabPays(stripe, c);
        }
        return stripe.create(args);
      }) as never;

      expect((await mintAtDoor(result)).additionalPaymentIntentId).toBeUndefined();

      const refused = [...stripe.intents.values()].find((intent) => intent.amount === 5_000)!;
      expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: refused.id } })).toBeNull();
      expect((await cancellations()).filter((row) => row.paymentIntentId === c)).toEqual([]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id }, select: { status: true, paymentIntentId: true } }))
        .toEqual({ status: "PENDING", paymentIntentId: recovery.paymentIntentId });

      await prisma.paymentRecoveryOperation.update({ where: { id: recovery.id }, data: { nextRetryAt: new Date("2026-06-30T00:00:00.000Z") } });
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      await expectReissueAlone(c, recovery.id);
    });

    it("#4442 M4: C paid inside the runner's re-issue replay - its claim hold writes nothing, and the next replay carries none of C", async () => {
      await grownBooking("card", 1_000);
      const result = await removeLeavingGuest();
      const stripe = fakeStripe();
      // The door's own mint never reaches Stripe, so the runner owns the re-issue.
      let doorFails = true;
      stripeRaceHooks.create = (async (args: Parameters<typeof stripe.create>[0]) => {
        if (doorFails) {
          doorFails = false;
          throw new Error("socket hang up");
        }
        return stripe.create(args);
      }) as never;
      expect((await mintAtDoor(result)).additionalPaymentIntentId).toBeUndefined();
      const c = await askMintedSinceReduction();
      const recovery = await reissueRecovery(result.bookingModificationId!);
      const { REISSUED_ASK_REASON } = await import("@/lib/payment-recovery-keys");
      stripeRaceHooks.create = (async (args: Parameters<typeof stripe.create>[0]) => {
        if (args.metadata?.reason === REISSUED_ASK_REASON && stripe.intents.get(c)!.status !== "succeeded") {
          expect(args.amountCents).toBe(5_000);
          await staleTabPays(stripe, c);
        }
        return stripe.create(args);
      }) as never;

      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      const runOnce = async () => {
        await prisma.paymentRecoveryOperation.update({ where: { id: recovery.id }, data: { nextRetryAt: new Date("2026-06-30T00:00:00.000Z") } });
        return runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST);
      };
      expect(await runOnce()).toBe("failed");

      const refused = [...stripe.intents.values()].find((intent) => intent.amount === 5_000)!;
      expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: refused.id } })).toBeNull();
      expect((await cancellations()).filter((row) => row.paymentIntentId === c)).toEqual([]);
      expect((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id }, select: { status: true } })).status).not.toBe("SUCCEEDED");

      expect(await runOnce()).toBe("succeeded");
      await expectReissueAlone(c, recovery.id);
    });

    it("ROUND 6 (F2+F3): an increase that folded a waiting re-issue in and failed to mint - its replay asks for both, and queues the re-issue's own invoice on its intent", async () => {
      // The primary invoice predates the first increase, whose own supplementary
      // invoice bills the ask - so the $30 re-issue has a $30 invoice of its own.
      await grownBooking("card", 1_000, 100, "minted", "primary-before-increase");
      const reduction = await removeLeavingGuest();
      const reductionId = reduction.bookingModificationId!;
      expect((await prisma.bookingModification.findUniqueOrThrow({ where: { id: reductionId }, select: { newData: true } })).newData)
        .toMatchObject({ reissuedAskInvoiceCents: 3_000 });
      const [{ applyPaymentAdjustments }, { noReductionAgainstUnpaidAsk }, { unpaidAskOffsetHistory }] = await Promise.all([
        import("@/lib/booking-modify-settlement"),
        import("@/lib/additional-ask-reduction"),
        import("@/lib/unpaid-ask-offset-marker"),
      ]);
      // A later +$10 increase, while the $30 re-issue still waits on its mint.
      const increase = await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true, guests: true } });
        const adjusted = await applyPaymentAdjustments(tx, {
          booking: booking as never, priceDiffCents: 1_000, changeFeeCents: 0, reduction: noReductionAgainstUnpaidAsk(1_000),
          todayAtClub: "2026-07-01" as never, format: CLUB_FORMAT_TEST,
        });
        const row = await tx.bookingModification.create({
          data: { bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "GUEST_ADD", previousData: {}, newData: unpaidAskOffsetHistory(adjusted), priceDiffCents: 1_000 },
        });
        return { adjusted, id: row.id };
      }, { maxWait: 10_000, timeout: 20_000 });
      expect(increase.adjusted.additionalAsk.amountCents).toBe(4_000);
      expect((await reissueRecovery(reductionId)).status).toBe("SUCCEEDED");

      // Its own mint fails, so its recovery is the only thing left to ask.
      const [{ enqueueAdditionalPaymentIntentRecovery, runPaymentRecoveryOperationNow }, { buildAdditionalIntentRecoveryIdempotencyKey }] = await Promise.all([
        import("@/lib/payment-recovery"),
        import("@/lib/payment-recovery-keys"),
      ]);
      const operation = await enqueueAdditionalPaymentIntentRecovery({
        bookingId: BOOKING_ID, paymentId: PAYMENT_ID, idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(increase.id),
        amountCents: 4_000, stripeIdempotencyKey: `mod_guest_${BOOKING_ID}_${increase.id}`, hadIssuedXeroInvoice: false,
        nextRetryAt: new Date("2026-06-30T00:00:00.000Z"),
      });
      const stripe = fakeStripe();
      expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      const [intent] = [...stripe.intents.values()];
      expect(intent?.amount).toBe(4_000);
      expect(await liveAsks()).toEqual([expect.objectContaining({ stripePaymentIntentId: intent!.id, amountCents: 4_000, carriedAskCents: 3_000 })]);
      // Decision A, kept: the reduction's $30 invoice, waiting on the increase's intent.
      const invoices = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "BookingModification", localId: reductionId, entityType: "INVOICE", operationType: "CREATE" },
        select: { status: true, requestPayload: true },
      });
      expect(invoices).toEqual([
        expect.objectContaining({ status: "WAITING_PAYMENT", requestPayload: expect.objectContaining({ paymentIntentId: intent!.id, priceDiffCents: 3_000 }) }),
      ]);
    });

    it("ROUND 7 (F2): a later ask minted while a folding increase's recovery waits never overtakes it - the replay asks for the folded re-issue, its own money and the later ask, superseding that ask", async () => {
      // paid 10000; E1 +5000 asked; E2 -2000 leaves a 3000 re-issue waiting.
      await grownBooking("card", 1_000, 100, "minted", "primary-before-increase");
      const reduction = await removeLeavingGuest();
      const [{ applyPaymentAdjustments }, { noReductionAgainstUnpaidAsk }, { unpaidAskOffsetHistory }] = await Promise.all([
        import("@/lib/booking-modify-settlement"),
        import("@/lib/additional-ask-reduction"),
        import("@/lib/unpaid-ask-offset-marker"),
      ]);
      const increaseBy = (cents: number) =>
        prisma.$transaction(async (tx) => {
          const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true, guests: true } });
          const adjusted = await applyPaymentAdjustments(tx, {
            booking: booking as never, priceDiffCents: cents, changeFeeCents: 0, reduction: noReductionAgainstUnpaidAsk(cents),
            todayAtClub: "2026-07-01" as never, format: CLUB_FORMAT_TEST,
          });
          const row = await tx.bookingModification.create({
            data: { bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "GUEST_ADD", previousData: {}, newData: unpaidAskOffsetHistory(adjusted), priceDiffCents: cents },
          });
          return { adjusted, id: row.id };
        }, { maxWait: 10_000, timeout: 20_000 });
      // E3 +1000 folds the waiting 3000 re-issue in; its own mint fails.
      const folding = await increaseBy(1_000);
      expect(folding.adjusted.additionalAsk.amountCents).toBe(4_000);
      expect((await reissueRecovery(reduction.bookingModificationId!)).status).toBe("SUCCEEDED");
      const [{ enqueueAdditionalPaymentIntentRecovery, runPaymentRecoveryOperationNow }, { buildAdditionalIntentRecoveryIdempotencyKey }, { upsertPaymentIntentTransaction }] = await Promise.all([
        import("@/lib/payment-recovery"),
        import("@/lib/payment-recovery-keys"),
        import("@/lib/payment-transactions"),
      ]);
      const operation = await enqueueAdditionalPaymentIntentRecovery({
        bookingId: BOOKING_ID, paymentId: PAYMENT_ID, idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(folding.id),
        amountCents: 4_000, stripeIdempotencyKey: `mod_guest_${BOOKING_ID}_${folding.id}`, hadIssuedXeroInvoice: true,
        nextRetryAt: new Date("2026-06-30T00:00:00.000Z"),
      });
      // The failed mint was queued before E4's ask was written (the frozen
      // clock would otherwise stamp both the same instant).
      await prisma.paymentRecoveryOperation.update({ where: { id: operation.id }, data: { createdAt: new Date("2026-06-30T00:00:00.000Z") } });
      // E4 +500, sized off the Payment, which shows neither E3 nor what it folded: its door mints 500.
      const later = await increaseBy(500);
      expect(later.adjusted.additionalAsk.amountCents).toBe(500);
      await upsertPaymentIntentTransaction({
        paymentId: PAYMENT_ID, kind: "ADDITIONAL", paymentIntentId: "pi_race_3954_later", amountCents: 500,
        carriedAskCents: later.adjusted.additionalAsk.carriedCents, status: "PENDING", reason: "guest_add_price_increase",
        hadIssuedXeroInvoice: true, store: prisma,
      });

      // E3's replay: not overtaken. It asks for its 1000, the folded 3000 and E4's 500.
      const stripe = fakeStripe();
      expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      const [intent] = [...stripe.intents.values()];
      expect(intent?.amount).toBe(4_500);
      expect(await liveAsks()).toEqual([
        expect.objectContaining({ stripePaymentIntentId: intent!.id, amountCents: 4_500, carriedAskCents: 3_500 }),
      ]);
      // E4's ask is superseded, its cancellation queued.
      expect(await prisma.paymentRecoveryOperation.findMany({
        where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT", paymentIntentId: "pi_race_3954_later" },
        select: { paymentIntentId: true },
      })).toEqual([{ paymentIntentId: "pi_race_3954_later" }]);
      expect((await payment()).additionalAmountCents).toBe(4_500);
    });

    it("ROUND 6 (F5): the billed-offset note's scoped link never refuses the edit's own note, nor the repair pass's re-queue of it", async () => {
      await grownBooking("card", 1_000, 100, "minted", "primary-after-increase");
      const result = await removeLeavingGuest();
      const reductionId = result.bookingModificationId!;
      const { UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE } = await import("@/lib/xero-review-task-key");
      // The scoped note was raised first: its link is on the reduction.
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "BookingModification", localId: reductionId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_race_3954_billed",
          role: "MODIFICATION_CREDIT_NOTE", metadata: { reviewTaskId: UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE },
        },
      });
      const { enqueueXeroModificationCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const own = await enqueueXeroModificationCreditNoteOperation({ bookingId: BOOKING_ID, bookingModificationId: reductionId, refundAmountCents: 1_000 });
      expect(own.queueOperationId).not.toBeNull();

      // The edit's own link still answers the edit's own note.
      await prisma.xeroObjectLink.create({
        data: { localModel: "BookingModification", localId: reductionId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_race_3954_own", role: "MODIFICATION_CREDIT_NOTE" },
      });
      expect((await enqueueXeroModificationCreditNoteOperation({ bookingId: BOOKING_ID, bookingModificationId: reductionId, refundAmountCents: 1_500 })).queueOperationId).toBeNull();
    });

    it.each([
      { invoice: "primary-before-increase" as const, billed: 0, unsure: 0, reissueInvoice: 3_000, reissueUnsure: 0 },
      { invoice: "primary-unrecorded" as const, billed: 0, unsure: 2_000, reissueInvoice: 0, reissueUnsure: 3_000 },
      // ROUND 7 (F1), over-credit: the door stamped "invoice issued"; a link
      // backfilled after the row no longer reads as "the primary billed it".
      { invoice: "late-link" as const, billed: 0, unsure: 0, reissueInvoice: 3_000, reissueUnsure: 0 },
    ])(
      "ROUND 6 (F6) / ROUND 7 (F1, F3): $invoice, the increase's invoice not parked - nothing is credit-noted on a guess",
      async ({ invoice, billed, unsure, reissueInvoice, reissueUnsure }) => {
        await grownBooking("card", 1_000, 100, "minted", invoice);
        const result = await removeLeavingGuest();
        const reductionId = result.bookingModificationId!;
        const history = (await prisma.bookingModification.findUniqueOrThrow({ where: { id: reductionId }, select: { newData: true } }))
          .newData as Record<string, unknown>;
        expect(history.unpaidAskBilledOffsetCents ?? 0).toBe(billed);
        expect(history.unpaidAskBilledOffsetUnsureCents ?? 0).toBe(unsure);
        expect(history.reissuedAskInvoiceCents ?? 0).toBe(reissueInvoice);
        expect(history.reissuedAskInvoiceUnsureCents ?? 0).toBe(reissueUnsure);
        expect(await billedOffsetNotes(reductionId)).toEqual([]);
      },
    );

    it("ROUND 8 (F1): an ask a reduction retired before its increase queued its invoice is named by the edit stamped on its row - the repair pass never bills it again", async () => {
      // 10000 paid; the increase's door minted the 5000 ask and stamped its
      // edit on the row, but had not yet queued the increase's invoice.
      await grownBooking("card", 1_000, 100, "minted", "primary-before-increase");
      await prisma.paymentTransaction.update({ where: { id: ASK_TXN_ID }, data: { bookingModificationId: INCREASE_MOD_ID } });
      const increase = await prisma.bookingModification.findUniqueOrThrow({ where: { id: INCREASE_MOD_ID }, select: { createdAt: true } });
      // The primary invoice was raised before the increase.
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "INVOICE", operationType: "CREATE", status: "SUCCEEDED", localModel: "Payment", localId: PAYMENT_ID,
          xeroObjectType: "INVOICE", xeroObjectId: PRIMARY_INVOICE_ID, completedAt: new Date(increase.createdAt.getTime() - 60_000),
        },
      });
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: PRIMARY_INVOICE_ID, role: "PRIMARY_INVOICE" },
      });

      // A 2000 reduction retires the ask and re-issues 3000, its invoice 3000.
      const result = await removeLeavingGuest();
      const history = (await prisma.bookingModification.findUniqueOrThrow({ where: { id: result.bookingModificationId! }, select: { newData: true } }))
        .newData as Record<string, unknown>;
      expect(history).toMatchObject({ unpaidAskRetiredModificationIds: [INCREASE_MOD_ID], reissuedAskInvoiceCents: 3_000 });

      // The increase's door re-reads its row: retired, so it offers no secret -
      // and its Xero leg, still handed the intent, parks the increase's own
      // invoice on it, which the reaper later retires as unpayable.
      const { isMintedAskStillLive } = await import("@/lib/reissued-ask-invoice");
      expect(await isMintedAskStillLive(ASK_INTENT)).toBe(false);
      const { enqueueXeroSupplementaryInvoiceOperation } = await import("@/lib/xero-operation-outbox");
      const parked = await enqueueXeroSupplementaryInvoiceOperation(
        { bookingId: BOOKING_ID, priceDiffCents: 5_000, changeFeeCents: 0, bookingModificationId: INCREASE_MOD_ID },
        { paymentIntentId: ASK_INTENT, waitForConfirmedAdditionalPayment: true, recordPayment: true },
      );
      await prisma.xeroSyncOperation.update({
        where: { id: parked.queueOperationId! },
        data: { status: "CANCELLED", completedAt: new Date(), lastErrorCode: "STALE_WAITING_PAYMENT" },
      });

      const { runBookingXeroRepair } = await import("@/lib/xero-booking-repair");
      const report = (await runBookingXeroRepair(CLUB_FORMAT_TEST, { scope: { bookingId: BOOKING_ID } })).passes[0]!.bookings[0]!;
      expect(
        report.actions.filter(
          (action) => action.type === "QUEUE_SUPPLEMENTARY_INVOICE" && action.payload.bookingModificationId === INCREASE_MOD_ID,
        ),
      ).toEqual([]);
      expect(
        report.findings.filter(
          (finding) => finding.code === "MISSING_SUPPLEMENTARY_INVOICE" && (finding.details as { modificationId?: string }).modificationId === INCREASE_MOD_ID,
        ),
      ).toEqual([]);
    });

    it("ROUND 8 (concurrency F1): the outbox scan leaves out a note waiting for its edit's own note until its recheck is due - and only that", async () => {
      await deleteFixtures();
      const { BILLED_OFFSET_AWAITING_OWN_NOTE_CODE, BILLED_OFFSET_OWN_NOTE_RECHECK_MS, outboxScanLeavesAwaitingOwnNote } = await import(
        "@/lib/unpaid-ask-billed-offset-order"
      );
      const row = (id: string, lastErrorCode: string | null) => ({
        id, direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", status: "PENDING",
        localModel: "Payment", localId: PAYMENT_ID, queueType: "MODIFICATION_CREDIT_NOTE", lastErrorCode,
      });
      await prisma.xeroSyncOperation.createMany({
        data: [
          row("race-3954-scan-null", null),
          row("race-3954-scan-other", "SOME_OTHER_CODE"),
          row("race-3954-scan-waiting", BILLED_OFFSET_AWAITING_OWN_NOTE_CODE),
          row("race-3954-scan-due", BILLED_OFFSET_AWAITING_OWN_NOTE_CODE),
        ],
      });
      // Clock-relative, never the database's own NOW(): the test clock is frozen.
      const now = new Date();
      await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "updatedAt" = ${new Date(now.getTime() - 60 * 60 * 1000)} WHERE id = 'race-3954-scan-due'`;
      await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "updatedAt" = ${now} WHERE id <> 'race-3954-scan-due' AND "localId" = ${PAYMENT_ID}`;
      const scanned = await prisma.xeroSyncOperation.findMany({
        where: { localId: PAYMENT_ID, status: "PENDING", AND: [outboxScanLeavesAwaitingOwnNote(now)] },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      expect(scanned.map((op) => op.id)).toEqual(["race-3954-scan-due", "race-3954-scan-null", "race-3954-scan-other"]);
      expect(BILLED_OFFSET_OWN_NOTE_RECHECK_MS).toBeLessThan(60 * 60 * 1000);
    });

    it("ROUND 7 (F1), under-credit: a row a recovery minted after the primary invoice was linked reads the recovery's 'no invoice yet' - the primary billed the 5000, and the note is queued for it", async () => {
      await grownBooking("card", 2_500, 100, "minted", "recovery-minted");
      const result = await removeLeavingGuest();
      const reductionId = result.bookingModificationId!;
      const history = (await prisma.bookingModification.findUniqueOrThrow({ where: { id: reductionId }, select: { newData: true } }))
        .newData as Record<string, unknown>;
      expect(history).toMatchObject({ unpaidAskOffsetCents: 5_000, unpaidAskBilledOffsetCents: 5_000 });
      expect(history).not.toHaveProperty("unpaidAskBilledOffsetUnsureCents");
      expect((await billedOffsetNotes(reductionId)).map((note) => (note.requestPayload as { refundAmountCents: number }).refundAmountCents))
        .toEqual([5_000]);
    });

    // #4036. An ORDINARY increase's door and its recovery replay send one
    // Stripe request (`planOrdinaryAskMint`), and a replay Stripe still refuses
    // finds the intent the key minted (`mintOrdinaryAskIntent`). The fake above
    // applies Stripe's rule: same key, other parameters -> `idempotency_error`.
    async function ordinaryIncrease(cents: number) {
      const [{ applyPaymentAdjustments }, { noReductionAgainstUnpaidAsk }, { unpaidAskOffsetHistory }] = await Promise.all([
        import("@/lib/booking-modify-settlement"),
        import("@/lib/additional-ask-reduction"),
        import("@/lib/unpaid-ask-offset-marker"),
      ]);
      return prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true, guests: true } });
        const adjusted = await applyPaymentAdjustments(tx, {
          booking: booking as never, priceDiffCents: cents, changeFeeCents: 0, reduction: noReductionAgainstUnpaidAsk(cents),
          todayAtClub: "2026-07-01" as never, format: CLUB_FORMAT_TEST,
        });
        const row = await tx.bookingModification.create({
          data: { bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "GUEST_ADD", previousData: {}, newData: unpaidAskOffsetHistory(adjusted), priceDiffCents: cents },
        });
        return { adjusted, id: row.id };
      }, { maxWait: 10_000, timeout: 20_000 });
    }

    /** The guest-add door's after-commit mint of `increase`, through the real minter. */
    async function mintIncreaseAtDoor(increase: Awaited<ReturnType<typeof ordinaryIncrease>>) {
      const { createModificationAdditionalPaymentIntent } = await import("@/lib/booking-modification-settlement");
      return createModificationAdditionalPaymentIntent({
        format: CLUB_FORMAT_TEST, bookingId: BOOKING_ID,
        result: {
          pendingRefundAmountCents: 0, organiserChildRefund: null, paymentId: PAYMENT_ID,
          additionalAsk: increase.adjusted.additionalAsk, retiredAdditionalAsks: [], hasSucceededPayment: true,
          hasIssuedXeroInvoice: false, paymentCustomerId: "cus_race_3954", memberEmail: "race-3954@example.invalid",
          memberName: "Ask Payer", memberFirstName: "Ask", memberId: MEMBER_ID, bookingModificationId: increase.id, priceLines: null,
        },
        door: "guestAdd",
        failureMessage: "race 4036 door mint",
      });
    }

    /** A grown booking (a $50 ask minted), then a +$10 increase whose door mint loses its reply. */
    async function increaseWhoseReplyIsLost() {
      await grownBooking("card", 1_000, 100, "minted", "primary-before-increase");
      const increase = await ordinaryIncrease(1_000);
      expect(increase.adjusted.additionalAsk.amountCents).toBe(6_000);
      const stripe = fakeStripe();
      let lose = true;
      stripeRaceHooks.create = (async (args: Parameters<typeof stripe.create>[0]) => {
        const intent = await stripe.create(args);
        if (lose) {
          lose = false;
          throw new Error("socket hang up");
        }
        return intent;
      }) as never;
      expect((await mintIncreaseAtDoor(increase)).additionalPaymentIntentId).toBeUndefined();
      const { buildAdditionalIntentRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys");
      const recovery = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
        where: { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(increase.id) },
      });
      expect(recovery).toMatchObject({ status: "PENDING", amountCents: 6_000, paymentIntentId: `mod_guest_${BOOKING_ID}_${increase.id}` });
      // The door's lost reply minted exactly one intent, with the door's own request.
      expect(stripe.intents.size).toBe(1);
      return { stripe, recovery, doorIntent: [...stripe.intents.values()][0]! };
    }

    it("#4036: the door minted at Stripe and lost the reply - the runner's replay sends the door's request and gets that SAME intent", async () => {
      const { stripe, recovery, doorIntent } = await increaseWhoseReplyIsLost();
      // The request every release's guest-add door has sent, so a row written
      // before this change replays it too.
      expect(doorIntent).toMatchObject({
        amount: 6_000, customer: "cus_race_3954",
        metadata: { bookingId: BOOKING_ID, type: "modification_additional", reason: "guest_add_price_increase" },
      });
      // Answered by the replay itself: never refused, so nothing is looked up.
      const sent = stripeRaceHooks.create as unknown as typeof stripe.create;
      let refused = 0;
      stripeRaceHooks.create = (async (args: Parameters<typeof stripe.create>[0]) =>
        sent(args).catch((err: unknown) => {
          refused += 1;
          throw err;
        })) as never;

      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(refused).toBe(0);
      expect(stripe.intents.size).toBe(1);
      const { ORDINARY_ASK_RECOVERY_REASON } = await import("@/lib/ordinary-ask-request");
      expect(await liveAsks()).toEqual([
        { stripePaymentIntentId: doorIntent.id, amountCents: 6_000, carriedAskCents: 5_000, reason: ORDINARY_ASK_RECOVERY_REASON },
      ]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id }, select: { status: true, paymentIntentId: true } }))
        .toEqual({ status: "SUCCEEDED", paymentIntentId: doorIntent.id });
      expect((await payment()).additionalPaymentIntentId).toBe(doorIntent.id);
    });

    it("#4036: the runner's replay is refused (the stored customer moved since the door) - it finds the door's intent, records it, and leaves the payment's customer alone", async () => {
      const { stripe, recovery, doorIntent } = await increaseWhoseReplyIsLost();
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { stripeCustomerId: "cus_race_4036_moved" } });
      let refused = 0;
      const replay = stripeRaceHooks.create as unknown as typeof stripe.create;
      stripeRaceHooks.create = (async (args: Parameters<typeof stripe.create>[0]) => {
        try {
          return await replay(args);
        } catch (err) {
          refused += 1;
          throw err;
        }
      }) as never;

      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(refused).toBe(1);
      expect(stripe.intents.size).toBe(1);
      expect((await liveAsks()).map((row) => row.stripePaymentIntentId)).toEqual([doorIntent.id]);
      // Review round: an ADOPTED intent's customer is never written over the
      // payment's - it was found by what it asks for, and the payment's saved
      // card stays paired with the customer it was saved under.
      expect((await payment()).stripeCustomerId).toBe("cus_race_4036_moved");
      expect((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id } })).status).toBe("SUCCEEDED");
    });

    // #4079: only the pre-#4036 runner sent its own reason under a door's key,
    // and no row of its remains, so such an intent is no longer adopted.
    it("#4079: a refused replay does not adopt an intent minted under the key with the pre-#4036 runner's reason - it fails closed and retries", async () => {
      await grownBooking("card", 1_000, 100, "minted", "primary-before-increase");
      const increase = await ordinaryIncrease(1_000);
      const stripe = fakeStripe();
      // The door's mint failed outright; the previous release's runner then
      // minted under the door's key with its own reason and lost the reply.
      stripeRaceHooks.create = (async () => {
        throw new Error("Stripe was unavailable");
      }) as never;
      expect((await mintIncreaseAtDoor(increase)).additionalPaymentIntentId).toBeUndefined();
      stripeRaceHooks.create = stripe.create as never;
      const oldRunnerIntent = await stripe.create({
        amountCents: 6_000, customerId: "cus_race_3954", idempotencyKey: `mod_guest_${BOOKING_ID}_${increase.id}`,
        metadata: { bookingId: BOOKING_ID, type: "modification_additional", reason: "modification_additional_recovery" },
      });

      const { buildAdditionalIntentRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys");
      const recovery = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
        where: { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(increase.id) },
      });
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("failed");
      expect(stripe.intents.size).toBe(1);
      expect((await liveAsks()).map((row) => row.stripePaymentIntentId)).not.toContain(oldRunnerIntent.id);
      const after = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id } });
      expect(after).toMatchObject({ status: "FAILED", attempts: 1 });
      expect(after.nextRetryAt).not.toBeNull();
    });

    it("#4036: a refused replay that matches two unrecorded intents fails closed - nothing is recorded and the recovery stays open to retry", async () => {
      const { stripe, recovery } = await increaseWhoseReplyIsLost();
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { stripeCustomerId: "cus_race_4036_moved" } });
      // Another unrecorded intent asking the same of the same booking, minted under no key.
      await stripe.create({
        amountCents: 6_000, customerId: "cus_race_3954",
        metadata: { bookingId: BOOKING_ID, type: "modification_additional", reason: "guest_add_price_increase" },
      });
      stripeRaceHooks.create = stripe.create as never;

      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("failed");

      // The $50 ask still stands alone; the debt waits on its retry.
      expect((await liveAsks()).map((row) => row.stripePaymentIntentId)).toEqual([ASK_INTENT]);
      const after = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id } });
      expect(after).toMatchObject({ status: "FAILED", attempts: 1, paymentIntentId: recovery.paymentIntentId });
      expect(after.nextRetryAt).not.toBeNull();
    });

    // #4036 review: the refused replay finds the door's intent, and another
    // ask records that same intent before the runner's claim-held write. The
    // runner must not write over that row: its write rolls back. The other ask
    // is a ledger row written AFTER this recovery's row, as production always
    // writes it, so the retry finds the recovery overtaken (#4150): it closes
    // with nothing to mint (`isRecoveryOvertakenByLaterAsk`, #3340's rule).
    it("#4036: an adopted intent another ask recorded meanwhile is never written over - the replay fails, and its retry completes the recovery as overtaken, minting nothing", async () => {
      const { stripe, recovery, doorIntent } = await increaseWhoseReplyIsLost();
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { stripeCustomerId: "cus_race_4036_moved" } });
      stripeRaceHooks.create = stripe.create as never;
      const OTHER_ROW = { reason: "date_change_price_increase", amountCents: 6_000 };
      // One second after the recovery row (the frozen clock would stamp both
      // the same instant, and the overtake rule is a strict `>`).
      const OTHER_ROW_WRITTEN_AT = new Date("2026-07-01T00:00:01.000Z");
      expect(recovery.createdAt.getTime()).toBeLessThan(OTHER_ROW_WRITTEN_AT.getTime());
      ordinaryAskMintHooks.afterMint = async ({ intent, adopted }) => {
        expect(adopted).toBe(true);
        await webhookClient.paymentTransaction.create({
          data: {
            paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: intent.id,
            status: "PENDING", createdAt: OTHER_ROW_WRITTEN_AT, ...OTHER_ROW,
          },
        });
      };

      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("failed");

      const otherRow = () =>
        prisma.paymentTransaction.findUniqueOrThrow({
          where: { stripePaymentIntentId: doorIntent.id },
          select: { reason: true, amountCents: true, carriedAskCents: true, bookingModificationId: true },
        });
      // The other ask's row is exactly as it wrote it.
      expect(await otherRow()).toEqual({ ...OTHER_ROW, carriedAskCents: 0, bookingModificationId: null });
      const failed = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id } });
      expect(failed).toMatchObject({ status: "FAILED", attempts: 1, paymentIntentId: recovery.paymentIntentId });

      // The retry: another ask's row now stands on the ledger, written after
      // this recovery's row, so a later mint priced the booking and this
      // recovery has nothing left to mint - it completes, and nothing is
      // adopted or written over.
      ordinaryAskMintHooks.afterMint = null;
      await prisma.paymentRecoveryOperation.update({ where: { id: recovery.id }, data: { nextRetryAt: new Date("2026-06-01T00:00:00.000Z") } });
      expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(await otherRow()).toEqual({ ...OTHER_ROW, carriedAskCents: 0, bookingModificationId: null });
      expect(stripe.intents.size).toBe(1);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id } }))
        .toMatchObject({ status: "SUCCEEDED", attempts: 2, paymentIntentId: recovery.paymentIntentId, nextRetryAt: null, succeededAt: expect.any(Date) });
    });

    it("#4036: a refused replay does not adopt an intent another edit's unfinished recovery could own (same door, same amount)", async () => {
      const { stripe, recovery } = await increaseWhoseReplyIsLost();
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { stripeCustomerId: "cus_race_4036_moved" } });
      stripeRaceHooks.create = stripe.create as never;
      // Another guest-add edit of this booking, its own ask for the same figure
      // still waiting on its recovery: its replay could be what minted the match.
      const { buildAdditionalIntentRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys");
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "CREATE_ADDITIONAL_PAYMENT_INTENT", status: "PENDING", bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
          paymentIntentId: `mod_guest_${BOOKING_ID}_race-4036-rival`, amountCents: 6_000,
          idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey("race-4036-rival"),
          nextRetryAt: new Date("2026-07-02T00:00:00.000Z"),
        },
      });

      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("failed");

      expect((await liveAsks()).map((row) => row.stripePaymentIntentId)).toEqual([ASK_INTENT]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id } }))
        .toMatchObject({ status: "FAILED", attempts: 1, paymentIntentId: recovery.paymentIntentId });
    });

    // #4036 review: a recovery row is written only once its door's create has
    // failed, so an intent under a door's reason created after the row (beyond
    // the clock skew) is a later door's mint, never this ask's.
    it("#4036: a refused replay does not adopt a door-reason intent created after its recovery row - another edit's door is minting it", async () => {
      const { stripe, recovery, doorIntent } = await increaseWhoseReplyIsLost();
      // The key's own intent is gone, and the stored customer moved, so the replay is refused.
      doorIntent.status = "canceled";
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { stripeCustomerId: "cus_race_4036_moved" } });
      stripeRaceHooks.create = stripe.create as never;
      // Another guest-add edit's door, minting the same figure after the row, not yet recorded.
      const laterDoor = await stripe.create({
        amountCents: 6_000, customerId: "cus_race_3954", idempotencyKey: `mod_guest_${BOOKING_ID}_race-4036-later`,
        metadata: { bookingId: BOOKING_ID, type: "modification_additional", reason: "guest_add_price_increase" },
      });
      const { DOOR_INTENT_CLOCK_SKEW_MS } = await import("@/lib/ordinary-ask-request");
      laterDoor.created = Math.floor((recovery.createdAt.getTime() + DOOR_INTENT_CLOCK_SKEW_MS) / 1000) + 1;

      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("failed");

      expect((await liveAsks()).map((row) => row.stripePaymentIntentId)).toEqual([ASK_INTENT]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id } }))
        .toMatchObject({ status: "FAILED", attempts: 1, paymentIntentId: recovery.paymentIntentId });
    });

    // #4036 delta review. Two guest-add edits of one booking, X and Y, each
    // asking $60. X's door request differed from its replay (an old door named
    // another customer) and that intent is gone, so X's replay is refused and
    // looks for its intent by what it asks for - and finds Y's.
    async function twoEditsOneFigure({ yDoorFails }: { yDoorFails: boolean }) {
      await grownBooking("card", 1_000, 100, "minted", "primary-before-increase");
      const stripe = fakeStripe();
      const { buildAdditionalIntentRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys");
      const recoveryOf = (editId: string) =>
        prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(editId) } });
      const failDoor = () => {
        stripeRaceHooks.create = (async () => {
          throw new Error("Stripe was unavailable");
        }) as never;
      };
      // X: its door failed; the request an old door sent under X's key named
      // another customer, and that intent was cancelled since.
      const x = await ordinaryIncrease(1_000);
      expect(x.adjusted.additionalAsk.amountCents).toBe(6_000);
      failDoor();
      expect((await mintIncreaseAtDoor(x)).additionalPaymentIntentId).toBeUndefined();
      const xOld = await stripe.create({
        amountCents: 6_000, customerId: "cus_race_4036_old_door", idempotencyKey: `mod_guest_${BOOKING_ID}_${x.id}`,
        metadata: { bookingId: BOOKING_ID, type: "modification_additional", reason: "guest_add_price_increase" },
      });
      xOld.status = "canceled";
      // Y: the same figure. Its door failed too, or has yet to mint.
      const y = await ordinaryIncrease(1_000);
      expect(y.adjusted.additionalAsk.amountCents).toBe(6_000);
      if (yDoorFails) expect((await mintIncreaseAtDoor(y)).additionalPaymentIntentId).toBeUndefined();
      stripeRaceHooks.create = stripe.create as never;
      return { stripe, x, y, xRecovery: await recoveryOf(x.id), yRecovery: yDoorFails ? await recoveryOf(y.id) : null, recoveryOf };
    }

    /** Y's replay mints Y's own intent (its write then failed), exactly as the runner sends it. */
    async function yMinted(stripe: ReturnType<typeof fakeStripe>, yId: string) {
      return stripe.create({
        amountCents: 6_000, customerId: "cus_race_3954", idempotencyKey: `mod_guest_${BOOKING_ID}_${yId}`,
        metadata: { bookingId: BOOKING_ID, type: "modification_additional", reason: "guest_add_price_increase" },
      });
    }

    it("#4036 delta review (finding 1): Y between retries (FAILED, retry scheduled) is still Y's - X's refused replay does not adopt Y's intent, and Y's retry records it", async () => {
      const { stripe, y, xRecovery, yRecovery } = await twoEditsOneFigure({ yDoorFails: true });
      const yIntent = await yMinted(stripe, y.id);
      await prisma.paymentRecoveryOperation.update({
        where: { id: yRecovery!.id },
        data: { status: "FAILED", attempts: 1, nextRetryAt: new Date("2026-07-02T00:00:00.000Z"), lastError: "write failed" },
      });

      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(xRecovery.id, CLUB_FORMAT_TEST)).toBe("failed");
      expect((await liveAsks()).map((row) => row.stripePaymentIntentId)).toEqual([ASK_INTENT]);

      // Y's retry gets its own intent back and records it as Y's.
      await prisma.paymentRecoveryOperation.update({ where: { id: yRecovery!.id }, data: { nextRetryAt: new Date("2026-06-01T00:00:00.000Z") } });
      expect(await runPaymentRecoveryOperationNow(yRecovery!.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { stripePaymentIntentId: yIntent.id }, select: { bookingModificationId: true } }))
        .toEqual({ bookingModificationId: y.id });
      expect(stripe.intents.size).toBe(2);
    });

    it("#4036 delta review (findings 2, 3): X adopted Y's intent while Y's door was minting it - Y's own write then refuses, and X's row stays X's", async () => {
      const { stripe, x, y, xRecovery, recoveryOf } = await twoEditsOneFigure({ yDoorFails: false });
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      // Between Y's door mint and its ledger write, X's runner runs: refused,
      // it finds Y's fresh intent - no rival row, created inside the skew - and adopts it.
      let xOutcome: string | null = null;
      ordinaryAskMintHooks.afterMint = async ({ adopted }) => {
        if (adopted || xOutcome !== null) return;
        xOutcome = await runPaymentRecoveryOperationNow(xRecovery.id, CLUB_FORMAT_TEST);
      };

      const yDoor = await mintIncreaseAtDoor(y);

      expect(xOutcome).toBe("succeeded");
      const live = [...stripe.intents.values()].filter((intent) => intent.status !== "canceled");
      expect(live).toHaveLength(1);
      const yIntentId = live[0]!.id;
      const row = () =>
        prisma.paymentTransaction.findUniqueOrThrow({
          where: { stripePaymentIntentId: yIntentId },
          select: { bookingModificationId: true, reason: true, amountCents: true },
        });
      const { ORDINARY_ASK_RECOVERY_REASON } = await import("@/lib/ordinary-ask-request");
      expect(await row()).toEqual({ bookingModificationId: x.id, reason: ORDINARY_ASK_RECOVERY_REASON, amountCents: 6_000 });
      // Y's door got its own key's intent back, and its write refused rather
      // than write Y over X's row: no secret offered, the debt kept on Y's recovery.
      expect(yDoor.additionalPaymentIntentId).toBeUndefined();
      const yRecovery = await recoveryOf(y.id);
      expect(yRecovery).toMatchObject({ status: "PENDING", paymentIntentId: `mod_guest_${BOOKING_ID}_${y.id}` });
      expect(await row()).toEqual({ bookingModificationId: x.id, reason: ORDINARY_ASK_RECOVERY_REASON, amountCents: 6_000 });

      // Y's retry re-sizes from the ledger, which now carries X's $60 ask, so
      // it asks $70 under the amount-named key: a new intent, recorded as Y's,
      // superseding X's. X's row still names X.
      await prisma.paymentRecoveryOperation.update({ where: { id: yRecovery.id }, data: { nextRetryAt: new Date("2026-06-01T00:00:00.000Z") } });
      expect(await runPaymentRecoveryOperationNow(yRecovery.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect((await row()).bookingModificationId).toBe(x.id);
      expect(await liveAsks()).toEqual([
        expect.objectContaining({ amountCents: 7_000, carriedAskCents: 6_000, reason: ORDINARY_ASK_RECOVERY_REASON }),
      ]);
    });

    // #4081. The same X-adopts-Y order, but Y's retry re-derives the figure Y's
    // door asked (here the frozen fallback: Y's own net reads zero), so Stripe
    // hands back the intent X recorded and the write is refused again. A retry
    // can only repeat that, so the recovery ends on the first refusal and an
    // officer hears now, not after five attempts (about 5h20m of backoff).
    it("#4081: Y's retry re-derives Y's own figure and is handed X's recorded intent - the recovery ends at once, one alert naming the cause, no further attempt", async () => {
      const { stripe, x, y, xRecovery, recoveryOf } = await twoEditsOneFigure({ yDoorFails: false });
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      let xOutcome: string | null = null;
      ordinaryAskMintHooks.afterMint = async ({ adopted }) => {
        if (adopted || xOutcome !== null) return;
        xOutcome = await runPaymentRecoveryOperationNow(xRecovery.id, CLUB_FORMAT_TEST);
      };
      expect((await mintIncreaseAtDoor(y)).additionalPaymentIntentId).toBeUndefined();
      expect(xOutcome).toBe("succeeded");
      ordinaryAskMintHooks.afterMint = null;
      const [xIntent] = [...stripe.intents.values()].filter((intent) => intent.status !== "canceled");
      const xRow = () =>
        prisma.paymentTransaction.findUniqueOrThrow({
          where: { stripePaymentIntentId: xIntent!.id },
          select: { bookingModificationId: true, status: true, amountCents: true },
        });
      expect(await xRow()).toEqual({ bookingModificationId: x.id, status: "PENDING", amountCents: 6_000 });
      // Y's retry falls back to the frozen figure, the one its door asked for.
      await prisma.bookingModification.update({ where: { id: y.id }, data: { priceDiffCents: 0, changeFeeCents: 0 } });
      const yRecovery = await recoveryOf(y.id);
      await prisma.paymentRecoveryOperation.update({ where: { id: yRecovery.id }, data: { nextRetryAt: new Date("2026-06-01T00:00:00.000Z") } });
      const intentsBefore = stripe.intents.size;
      recoveryAlerts.sent = [];

      expect(await runPaymentRecoveryOperationNow(yRecovery.id, CLUB_FORMAT_TEST)).toBe("failed");

      const { MAX_PAYMENT_RECOVERY_ATTEMPTS } = await import("@/lib/payment-recovery-constants");
      const dead = await recoveryOf(y.id);
      // Dead at once, at the ceiling every dead-row reader tests, and the debt still on the row.
      expect(dead).toMatchObject({
        status: "FAILED", nextRetryAt: null, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, processingStartedAt: null,
        amountCents: 6_000, paymentIntentId: `mod_guest_${BOOKING_ID}_${y.id}`,
      });
      expect(dead.lastError).toContain(`card request ${xIntent!.id}, which is already recorded for another change to the same booking`);
      expect(recoveryAlerts.sent).toEqual([
        { operationId: yRecovery.id, errorMessage: expect.stringContaining(`failed after 1 attempt: The card request for the "Guests Added" change to this booking`) },
      ]);
      // X's row is untouched, and Stripe was asked nothing new.
      expect(await xRow()).toEqual({ bookingModificationId: x.id, status: "PENDING", amountCents: 6_000 });
      expect(stripe.intents.size).toBe(intentsBefore);

      // No further attempt: the runner will not claim it again, and its queue read skips it.
      expect(await runPaymentRecoveryOperationNow(yRecovery.id, CLUB_FORMAT_TEST)).toBe("not-claimed");
      const { processPaymentRecoveryOperations } = await import("@/lib/payment-recovery");
      await processPaymentRecoveryOperations({ limit: 50 });
      expect(await recoveryOf(y.id)).toMatchObject({ status: "FAILED", attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null });
      expect(recoveryAlerts.sent.filter((alert) => alert.operationId === yRecovery.id)).toHaveLength(1);
      expect(stripe.intents.size).toBe(intentsBefore);
      // The stuck-state page counts it with the recoveries that ran out.
      const { countExhaustedPaymentRecoveryOperations } = await import("@/lib/payment-recovery-health");
      expect(await countExhaustedPaymentRecoveryOperations()).toBeGreaterThanOrEqual(1);
    });

    // #4081: an edit's write claims a row naming no edit - a webhook's - and
    // never lowers its status. Sequentially, and with the capture committing
    // while the claim waits on the row's lock.
    const WEBHOOK_INTENT = "pi_race_4081_webhook";
    async function webhookRowFor(increaseId: string | null) {
      await webhookClient.paymentTransaction.create({
        data: {
          paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: WEBHOOK_INTENT,
          status: "PENDING", amountCents: 6_000, ...(increaseId ? { bookingModificationId: increaseId } : {}),
        },
      });
    }
    async function claimAsEdit(increaseId: string | undefined) {
      const { upsertPaymentIntentTransaction } = await import("@/lib/payment-transactions");
      await upsertPaymentIntentTransaction({
        paymentId: PAYMENT_ID, kind: "ADDITIONAL", paymentIntentId: WEBHOOK_INTENT, amountCents: 6_000, carriedAskCents: 5_000,
        status: "PENDING", reason: "modification_additional_recovery", bookingModificationId: increaseId, store: prisma,
      });
    }
    const webhookRow = () =>
      prisma.paymentTransaction.findUniqueOrThrow({
        where: { stripePaymentIntentId: WEBHOOK_INTENT },
        select: { status: true, bookingModificationId: true, carriedAskCents: true, reason: true },
      });

    it.each(["an edit's claim", "a plain write"] as const)(
      "#4081: a webhook marks the row SUCCEEDED, then %s lands on it - the status stays SUCCEEDED",
      async (writer) => {
        await grownBooking("card", 1_000, 100, "minted", "primary-before-increase");
        const increase = await ordinaryIncrease(1_000);
        await webhookRowFor(null);
        await webhookClient.paymentTransaction.update({ where: { stripePaymentIntentId: WEBHOOK_INTENT }, data: { status: "SUCCEEDED" } });

        await claimAsEdit(writer === "an edit's claim" ? increase.id : undefined);

        expect(await webhookRow()).toEqual({
          status: "SUCCEEDED", bookingModificationId: writer === "an edit's claim" ? increase.id : null,
          carriedAskCents: 5_000, reason: "modification_additional_recovery",
        });
        // The mirror reads it as paid, not as an open ask.
        expect((await payment()).additionalPaymentStatus).not.toBe("PENDING");
      },
    );

    it("#4081: a capture committing while an edit's claim waits on the row's lock - the claim's re-checked WHERE keeps SUCCEEDED", async () => {
      await grownBooking("card", 1_000, 100, "minted", "primary-before-increase");
      const increase = await ordinaryIncrease(1_000);
      await webhookRowFor(null);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const rowLocked = new Promise<void>((resolve) => (locked = resolve));
      const capture = webhookClient.$transaction(async (tx) => {
        await tx.paymentTransaction.update({ where: { stripePaymentIntentId: WEBHOOK_INTENT }, data: { status: "SUCCEEDED" } });
        locked();
        await held;
      }, { maxWait: 10_000, timeout: 20_000 });
      await rowLocked;

      const claim = claimAsEdit(increase.id);
      // The claim's first statement queues behind the capture's row lock.
      const startedAt = process.hrtime.bigint();
      for (;;) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE application_name IS DISTINCT FROM 'race-3954-webhook' AND wait_event_type = 'Lock' AND query ILIKE '%PaymentTransaction%'
        `;
        if ((rows[0]?.count ?? 0) > 0) break;
        if (realElapsedMs(startedAt) > 5_000) throw new Error("The edit's claim never queued behind the capture");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      release();
      await capture;
      await claim;

      expect(await webhookRow()).toEqual({
        status: "SUCCEEDED", bookingModificationId: increase.id, carriedAskCents: 5_000, reason: "modification_additional_recovery",
      });
    });

    // #4036, the other ordering. An ordinary ask's recovery row is written only
    // once the door's own create has FAILED (`keepTheDebt`), so the door never
    // upserts after the runner: its call has already returned. What can arrive
    // after the runner is the door's REQUEST - one the door gave up on whose
    // delivery to Stripe was delayed. Stripe answers it with the runner's intent,
    // because the two sent one request under one key.
    it("#4036: the runner mints and records first; the door's delayed request then reaches Stripe and is answered with that same intent, never refused", async () => {
      await grownBooking("card", 1_000, 100, "minted", "primary-before-increase");
      const increase = await ordinaryIncrease(1_000);
      const stripe = fakeStripe();
      // The door's request leaves but has not reached Stripe when the door's
      // client gives up on it.
      let delayed: Parameters<typeof stripe.create>[0] | null = null;
      stripeRaceHooks.create = (async (args: Parameters<typeof stripe.create>[0]) => {
        delayed = args;
        throw new Error("Request timed out");
      }) as never;
      expect((await mintIncreaseAtDoor(increase)).additionalPaymentIntentId).toBeUndefined();
      expect(stripe.intents.size).toBe(0);
      const { buildAdditionalIntentRecoveryIdempotencyKey } = await import("@/lib/payment-recovery-keys");
      const recovery = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
        where: { idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(increase.id) },
      });

      // The runner first: it mints under the door's key and records the row.
      stripeRaceHooks.create = stripe.create as never;
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(recovery.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(stripe.intents.size).toBe(1);
      const runnerIntent = [...stripe.intents.values()][0]!;

      // Then the door's delayed request lands: the same intent, no refusal.
      expect(delayed).not.toBeNull();
      await expect(stripe.create(delayed!)).resolves.toBe(runnerIntent);
      expect(stripe.intents.size).toBe(1);
      const { ORDINARY_ASK_RECOVERY_REASON } = await import("@/lib/ordinary-ask-request");
      expect(await liveAsks()).toEqual([
        { stripePaymentIntentId: runnerIntent.id, amountCents: 6_000, carriedAskCents: 5_000, reason: ORDINARY_ASK_RECOVERY_REASON },
      ]);
      expect((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: recovery.id } })).status).toBe("SUCCEEDED");
    });
  },
);
