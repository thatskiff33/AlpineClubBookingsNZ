/**
 * Real-PostgreSQL check of #4022: can the nightly card self-heal
 * (`cron-credit-reconciliation.ts`) fill a bank-transfer hand-back's missing
 * note with a CARD note, settled from the Stripe account?
 *
 * #3924 answered this for a "Paid another way" close, which sits on a card
 * payment. The issue named three more bank hand-backs, found by reading the
 * code. Each is driven here through its REAL completion
 * (`resolveManualRefundTask`) on the only payment its own writer raises it on,
 * its bank note (where it takes one) is then failed past the grace window, and
 * the self-heal's one input (`getRefundsMissingXeroCreditNotes`) is read:
 *
 * - (a) an edit review's hand-back on a cancelled booking (#3880), in both
 *   wordings (#3935). Raised as a hand-back only when the payment is not a
 *   card one (`editReviewRefundGoesBackOnCard`); a card payment takes the
 *   card route instead (`booking-payment-state.test.ts` pins the chooser).
 * - (b) an approved refund request's hand-back (#3827, `INV-PAY-118`). Raised
 *   only on an internet-banking payment (the approval route; a card payment
 *   planned short raises none, `admin-refund-request-review-route.test.ts`).
 * - (c) an edit's refund hand-back (#3827, `INV-PAY-117`). Raised only when the
 *   money was not captured through Stripe (`editRefundGoesBackByHand`, fed by
 *   `hasSucceededPayment`, which needs a card source); it queues no Xero note.
 *
 * So each is on an internet-banking payment, which the self-heal's list never
 * reads (`source: "STRIPE"`), and none is filled with a card note. A positive
 * control shows the same read does list a card payment's uncovered card refund.
 *
 * What this file proves, and what it does not: it pins the source filter, the
 * one guard keeping these hand-backs out of the self-heal (drop it and every
 * case here fails). That each kind is raised only off-card is the routing
 * above, held by the unit suites named there, not by this file; (b) and (c)
 * call their raisers directly. Routes this file does not cover - a payment
 * whose source changes later, and the other hand-back writers - are #4239.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4022-` fixtures. No Stripe or Xero call is made: Xero is not
 * connected, so every note stays the outbox row the app wrote.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import type { CalendarDate } from "@/lib/club-time";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4022-member";
const LODGE_ID = "race-4022-lodge";
const BOOKING_ID = "race-4022-booking";
const GUEST_ID = "race-4022-guest";
const MODIFICATION_ID = "race-4022-modification";
const REFUND_REQUEST_ID = "race-4022-refund-request";
const PAYMENT_ID = "race-4022-payment";
const TRANSACTION_ID = "race-4022-txn";
const INVOICE_ID = "race-4022-xero-invoice";
const CARD_BOOKING_ID = "race-4022-card-booking";
const CARD_PAYMENT_ID = "race-4022-card-payment";
const CARD_TRANSACTION_ID = "race-4022-card-txn";
const CARD_INTENT_ID = "pi_race_4022_card";
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const PRICE_CENTS = 20_000;
/** Past every payment's 24-hour grace: the self-heal's list as a later night reads it. */
const LATER_NIGHT = new Date("2100-01-01T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Self-heal hand-back proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run self-heal hand-back proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Self-heal hand-back proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Self-heal hand-back proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "the nightly card self-heal never fills a bank hand-back's note with a card note - real PostgreSQL (#4022)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      const paymentIds = [PAYMENT_ID, CARD_PAYMENT_ID];
      const bookingIds = [BOOKING_ID, CARD_BOOKING_ID];
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [...paymentIds, ...bookingIds, MODIFICATION_ID] } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [...paymentIds, ...bookingIds, MODIFICATION_ID] } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: bookingIds } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, bookingIds);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.refundRequest.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.auditLog.deleteMany({
        where: { OR: [{ memberId: MEMBER_ID }, { actorMemberId: MEMBER_ID }, { targetId: { in: [...bookingIds, MODIFICATION_ID] } }] },
      });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.bookingModification.deleteMany({ where: { id: MODIFICATION_ID } });
      await prisma.bookingGuest.deleteMany({ where: { id: GUEST_ID } });
      await prisma.booking.deleteMany({ where: { id: { in: [BOOKING_ID, CARD_BOOKING_ID] } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** A $200 booking, paid by internet banking and invoiced in Xero. */
    async function paidByBank() {
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAID", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS } });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PRICE_CENTS, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID,
          transactions: { create: { id: TRANSACTION_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: PRICE_CENTS, status: "SUCCEEDED" } },
        },
      });
      const nights = [CHECK_IN, new Date("2026-08-02T00:00:00.000Z")];
      for (const [index, night] of nights.entries()) {
        await prisma.bookingLedgerLine.create({ data: {
          bookingId: BOOKING_ID, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: 10_000, amountCents: 10_000,
          bookingGuestId: GUEST_ID, nightStart: night, nightEndExclusive: nights[index + 1] ?? CHECK_OUT, ageTier: "ADULT",
          guestNames: ["Hand-back Guest"], anchorKind: "CONFIRMATION", anchorId: BOOKING_ID, narration: "race 4022 confirmation",
          lodgeId: LODGE_ID, postingKey: `race-4022-confirm-${index}`,
        } });
      }
    }

    /** The REAL cancel, at 50% less $20: $80.00 back as account credit. */
    async function cancelAtHalf() {
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 2_000 } });
      const { cancelBooking } = await import("@/lib/booking-cancel");
      expect((await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);
    }

    async function complete(taskId: string, extra: { confirmedAmountCents?: number; handedBackInCash?: boolean } = {}) {
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      return resolveManualRefundTask({
        taskId, resolution: "completed", note: "Paid back by bank transfer.", actingMemberId: MEMBER_ID,
        confirmedAmountCents: extra.confirmedAmountCents ?? null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null,
        ...(extra.handedBackInCash !== undefined ? { handedBackInCash: extra.handedBackInCash } : {}),
      }, CLUB_FORMAT_TEST);
    }

    /** Every refund note on the bank payment: how it is worded and what it answers. */
    async function bankPaymentNotes() {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE" },
        select: { requestPayload: true },
      });
      return rows
        .map(({ requestPayload }) => requestPayload as { queueType?: string; refundAmountCents?: number; refundMethod?: string; noteWording?: string })
        .filter((payload) => payload.queueType === "REFUND_CREDIT_NOTE")
        .map((payload) => ({ cents: payload.refundAmountCents, refundMethod: payload.refundMethod, noteWording: payload.noteWording ?? null }));
    }

    /** The bank note did not land: failed, past the grace window. */
    async function failBankPaymentNotes() {
      await prisma.xeroSyncOperation.updateMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE" },
        data: { status: "FAILED", lastErrorMessage: "race 4022: Xero refused the note" },
      });
    }

    /** The self-heal's one input: its list of payments with an uncovered refund, as a later night reads it. */
    async function selfHealRow(paymentId: string) {
      const { getRefundsMissingXeroCreditNotes } = await import("@/lib/xero-admin-health");
      return (await getRefundsMissingXeroCreditNotes({ now: LATER_NIGHT })).payments.find((payment) => payment.paymentId === paymentId) ?? null;
    }

    async function refundedCents() {
      return (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).refundedAmountCents;
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Hand", lastName: "Back", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4022 Lodge", slug: "race-4022" } });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS },
      });
      await prisma.bookingGuest.create({
        data: { id: GUEST_ID, bookingId: BOOKING_ID, firstName: "Hand-back", lastName: "Guest", ageTier: "ADULT", stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: PRICE_CENTS },
      });
      await prisma.bookingModification.create({
        data: { id: MODIFICATION_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: {} },
      });
      await prisma.booking.create({
        data: { id: CARD_BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS },
      });
    }, 60_000);

    beforeEach(async () => {
      await clearRun();
      await paidByBank();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    it.each([
      { wording: "bank transfer", handedBackInCash: false, noteWording: null },
      { wording: "cash (#3935)", handedBackInCash: true, noteWording: "cash" },
    ])("(a) an edit review's $wording hand-back on a cancelled booking: its note failed, and the self-heal never reads the payment", async ({ handedBackInCash, noteWording }) => {
      const { raiseEditFinancialReviewTask } = await import("@/lib/edit-financial-review");
      const raised = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        return raiseEditFinancialReviewTask({
          occurrence: {
            bookingId: BOOKING_ID, bookingGuestId: GUEST_ID, cause: "NO_STORED_NIGHT_PRICES",
            surrenderedNightDates: ["2026-08-01" as CalendarDate], addedNightDates: [],
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
      await cancelAtHalf();
      const afterCancel = await refundedCents();

      // A $50 share, netted against the cancel's $80 to $25 handed back by hand.
      await complete(raised.taskId, { confirmedAmountCents: 5_000, handedBackInCash });

      expect((await refundedCents()) - afterCancel).toBe(2_500);
      expect(await bankPaymentNotes()).toEqual([{ cents: 2_500, refundMethod: "internet-banking", noteWording }]);
      await failBankPaymentNotes();
      expect(await selfHealRow(PAYMENT_ID)).toBeNull();
    });

    it("(b) an approved refund request's hand-back: its note failed, and the self-heal never reads the payment", async () => {
      await cancelAtHalf();
      const afterCancel = await refundedCents();
      await prisma.refundRequest.create({
        data: {
          id: REFUND_REQUEST_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, reason: "race 4022 appeal", requestedAmountCents: 5_000,
          status: "APPROVED", approvedAmountCents: 5_000, reviewedBy: MEMBER_ID, reviewedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      });
      // What the approval raises on an internet-banking payment, under its lock.
      const { raiseRefundRequestHandBack } = await import("@/lib/edit-refund-hand-back");
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        expect(await raiseRefundRequestHandBack(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, refundRequestId: REFUND_REQUEST_ID, amountCents: 5_000, booking: { organiserSettled: false, parentBookingId: null, payment: null } })).toBe(1);
      });
      const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID, occurrenceKey: { startsWith: "refund-request-hand-back:" } } });

      await complete(task.id);

      expect((await refundedCents()) - afterCancel).toBe(5_000);
      expect(await bankPaymentNotes()).toEqual([{ cents: 5_000, refundMethod: "internet-banking", noteWording: null }]);
      await failBankPaymentNotes();
      expect(await selfHealRow(PAYMENT_ID)).toBeNull();
    });

    it("(c) an edit's refund hand-back: no Xero note of its own, and the self-heal never reads the payment", async () => {
      const { raiseEditRefundHandBackIfOwed } = await import("@/lib/edit-refund-hand-back");
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        // The edit's own test: money not captured through Stripe goes back by hand.
        expect(await raiseEditRefundHandBackIfOwed(tx, {
          bookingId: BOOKING_ID, paymentId: PAYMENT_ID, bookingModificationId: MODIFICATION_ID,
          adjusted: { refundAmountCents: 5_000, hasSucceededPayment: false }, editLabel: "date change", booking: { organiserSettled: false, parentBookingId: null, payment: null },
        })).toBe(true);
      });
      const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID, occurrenceKey: { startsWith: "edit-refund-hand-back:" } } });

      await complete(task.id);

      expect(await refundedCents()).toBe(5_000);
      // `INV-PAY-117`: the edit's own note corrects the invoice; completion queues none.
      expect(await bankPaymentNotes()).toEqual([]);
      expect(await selfHealRow(PAYMENT_ID)).toBeNull();
    });

    it("positive control: the same read lists a card payment's card refund no note answers, as a card ask for exactly it", async () => {
      await prisma.payment.create({
        data: {
          id: CARD_PAYMENT_ID, bookingId: CARD_BOOKING_ID, amountCents: PRICE_CENTS, refundedAmountCents: 5_000, source: "STRIPE", status: "PARTIALLY_REFUNDED",
          stripePaymentIntentId: CARD_INTENT_ID, xeroInvoiceId: `${INVOICE_ID}-card`,
          transactions: {
            create: { id: CARD_TRANSACTION_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: CARD_INTENT_ID, amountCents: PRICE_CENTS, refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" },
          },
        },
      });
      await prisma.paymentRefund.create({
        data: {
          paymentId: CARD_PAYMENT_ID, paymentTransactionId: CARD_TRANSACTION_ID, stripeRefundId: "re_race_4022_card", stripePaymentIntentId: CARD_INTENT_ID,
          amountCents: 5_000, currency: "nzd", status: "succeeded", stripeCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });

      const row = await selfHealRow(CARD_PAYMENT_ID);
      expect(row).toMatchObject({ cashRefundedCents: 5_000, uncoveredCents: 5_000, paidAnotherWayUncoveredCents: 0 });
      // The ask `reconcileCreditBalances` sizes its card note from.
      expect(row!.uncoveredCents - row!.paidAnotherWayUncoveredCents).toBe(5_000);
    });
  },
);
