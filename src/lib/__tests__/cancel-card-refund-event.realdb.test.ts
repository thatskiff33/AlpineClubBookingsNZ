/**
 * Real-PostgreSQL proof of #4145: a member cancel's card refund is recorded -
 * one REFUNDED booking event, dated by the close that made it and for what the
 * frozen plan refunded - whichever close moves its recovery row
 * (`booking_cancel_refund_recovery_<booking>`) to `SUCCEEDED`, and the booking
 * page's narrative follows the refund through every path.
 *
 * What a mock can only imitate, run here against the database through the REAL
 * `cancelBooking`, `runPaymentRecoveryOperationNow`,
 * `closeCardRefundPaidAnotherWay`, `readCancelledCardRefund` and
 * `resolveBookingNarrative`:
 *
 * - Inline success: the cancel's own close writes the one event, as the member
 *   who cancelled; the runner then claims nothing.
 * - Inline failure, then the runner: the cancel writes none - the narrative
 *   says the refund is on its way, not that it was refunded - and the runner's
 *   close writes the one event, at its own close, as no member.
 * - Partial (one slice made, a later one threw) and refused (Stripe answered
 *   `failed`): the cancel writes none; the runner's event is for the whole plan,
 *   the slice made inline included.
 * - Paid another way: the dead row is closed by an officer and no REFUNDED
 *   event is written - nothing went back to the card - and the narrative says
 *   it was paid back another way. Where part did go back first, that close
 *   records the part, dated by Stripe's refund and marked as its own, and the
 *   page says both - and, paid back in part, the rest the club closed.
 * - The deploy boundary: a cancel made before #4145 wrote its event up front;
 *   the runner then closes the row and writes no second one.
 * - The cancel's close landing while the runner holds the row: only the close
 *   that moved it records, so one event.
 * - The cancel's event insert refused: its close rolls back with it, the row
 *   stays open, and the runner's close records it once.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4145-` fixtures. No Stripe call is made: refunds go to the harness's one
 * shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4145-member";
const OFFICER_ID = "race-4145-officer";
const LODGE_ID = "race-4145-lodge";
const BOOKING_ID = "race-4145-booking";
const PAYMENT_ID = "race-4145-payment";
const PRIMARY_TXN = "race-4145-txn-primary";
const PRIMARY_INTENT = "pi_race_4145_primary";
const ADDITIONAL_TXN = "race-4145-txn-additional";
const ADDITIONAL_INTENT = "pi_race_4145_additional";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const PAID_AT = new Date("2026-05-02T00:00:00.000Z");
const PAID_CENTS = 20_000;
// One tier, half back: the cancel refunds $100.00 to the card and keeps $100.00.
const REFUND_CENTS = 10_000;
const REASON = "50% refunded to the original payment method.";
const ROW_KEY = `booking_cancel_refund_recovery_${BOOKING_ID}`;
/** The repository's frozen instant (the cancel's), and two days on: the runner's retry. */
const FROZEN_AT = new Date("2026-07-01T00:00:00.000Z");
const RUNNER_AT = new Date("2026-07-03T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Cancel refund event proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run cancel refund event proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Cancel refund event proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Cancel refund event proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let cancelBooking: (typeof import("@/lib/booking-cancel"))["cancelBooking"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let markBookingCancellationRefundRecoverySucceeded: (typeof import("@/lib/payment-recovery"))["markBookingCancellationRefundRecoverySucceeded"];
let closeRefundRowRecordingEvent: (typeof import("@/lib/booking-events"))["closeRefundRowRecordingEvent"];
let closeCardRefundPaidAnotherWay: (typeof import("@/lib/card-refund-paid-another-way"))["closeCardRefundPaidAnotherWay"];
let readCancelledCardRefund: (typeof import("@/lib/cancel-card-refund-shortfall-status"))["readCancelledCardRefund"];
/** Where the row stands, as the page reads it. */
const readCancelledCardRefundState = async (bookingId: string) => (await readCancelledCardRefund(bookingId)).cardRefundState;
let readCardShortfallTaskStatuses: (typeof import("@/lib/cancel-card-refund-shortfall-status"))["readCardShortfallTaskStatuses"];
let resolveBookingNarrative: (typeof import("@/lib/booking-narrative"))["resolveBookingNarrative"];
let parseRefundAllocationPlan: (typeof import("@/lib/open-card-refund-owed"))["parseRefundAllocationPlan"];
let club: ReturnType<(typeof import("@/lib/club-time"))["bindClubTime"]>;
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "a member cancel's card refund is recorded once, by the close that made it — real PostgreSQL (#4145)",
  { timeout: 60_000 },
  () => {
    async function deletePaymentRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      const rows = await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: rows.map((row) => row.id) } } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    /** A paid booking: its $200.00 captured on one charge, or on two (a $60.00 top-up, refunded first). */
    async function paidBooking({ topUpCents = 0 }: { topUpCents?: number } = {}) {
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: NIGHT, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PAID_CENTS,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: PRIMARY_INTENT,
          // A refund note needs an invoice to credit (#3924).
          xeroInvoiceId: "inv_race_4145",
        },
      });
      await prisma.paymentTransaction.create({
        data: { id: PRIMARY_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT, amountCents: PAID_CENTS - topUpCents, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
      });
      if (topUpCents > 0) {
        await prisma.paymentTransaction.create({
          data: { id: ADDITIONAL_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: ADDITIONAL_INTENT, amountCents: topUpCents, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
        });
      }
      await prisma.bookingEvent.create({ data: { bookingId: BOOKING_ID, type: "MEMBER_PAID", occurredAt: PAID_AT, amountCents: PAID_CENTS } });
    }

    /**
     * Stripe's answer to each refund ask: `succeeded` unless `answer` says
     * otherwise for that intent - a status, or a throw. A repeated key is
     * answered with the refund it already made.
     */
    function stripeAnswers(answer: (intent: string) => "succeeded" | "failed" | "throws" = () => "succeeded", during?: () => Promise<void>) {
      const asked: string[] = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.idempotencyKey ?? "");
        await during?.();
        const status = answer(args.paymentIntentId);
        if (status === "throws") throw new Error("Stripe is unavailable (503)");
        return {
          id: `re_race_4145_${args.idempotencyKey}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status,
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: `ch_${args.paymentIntentId}`,
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      return asked;
    }

    const cancel = async () => {
      const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST, "card");
      expect(result.status).toBe(200);
      return result;
    };
    const rowNow = () => prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: ROW_KEY } });
    const refundedEvents = () =>
      prisma.bookingEvent.findMany({
        where: { bookingId: BOOKING_ID, type: "REFUNDED" },
        select: { amountCents: true, reason: true, actorMemberId: true, occurredAt: true },
      });
    /** The runner's retry, two days after the cancel: its retry due, and the clock moved on to it. */
    const retryComesDue = async (id: string) => {
      await prisma.paymentRecoveryOperation.update({ where: { id }, data: { nextRetryAt: RUNNER_AT } });
      vi.setSystemTime(RUNNER_AT);
    };

    /** The booking page's narrative, built from the rows as the page builds it. */
    async function narrative(): Promise<string> {
      const events = await prisma.bookingEvent.findMany({
        where: { bookingId: BOOKING_ID },
        orderBy: { occurredAt: "asc" },
        select: { type: true, occurredAt: true, amountCents: true, reason: true, snapshot: true },
      });
      return resolveBookingNarrative(
        {
          club,
          booking: {
            status: "CANCELLED",
            finalPriceCents: PAID_CENTS,
            amountOwed: { owedCents: 0, dueCents: 0, appliedCreditCents: 0 },
            checkIn: NIGHT,
            checkOut: CHECK_OUT,
            firstName: "Cancel",
            adminReviewStatus: null,
            adminReviewNotes: null,
            adminReviewReason: null,
          },
          events,
          cardShortfallStatuses: await readCardShortfallTaskStatuses(BOOKING_ID),
          ...(await readCancelledCardRefund(BOOKING_ID)),
        },
        CLUB_FORMAT_TEST,
      ).message;
    }
    const refundedOn = (occurredAt: Date) => `$100.00 was refunded on ${club.instantDate(occurredAt)} and $100.00 was retained`;
    const ON_ITS_WAY = "$100.00 is on its way to your original payment method and $100.00 was retained";

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ cancelBooking } = await import("@/lib/booking-cancel"));
      ({ runPaymentRecoveryOperationNow, markBookingCancellationRefundRecoverySucceeded } = await import("@/lib/payment-recovery"));
      ({ closeRefundRowRecordingEvent } = await import("@/lib/booking-events"));
      ({ closeCardRefundPaidAnotherWay } = await import("@/lib/card-refund-paid-another-way"));
      ({ readCancelledCardRefund, readCardShortfallTaskStatuses } = await import("@/lib/cancel-card-refund-shortfall-status"));
      ({ resolveBookingNarrative } = await import("@/lib/booking-narrative"));
      ({ parseRefundAllocationPlan } = await import("@/lib/open-card-refund-owed"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));
      const { bindClubTime, requireClubTimeZone } = await import("@/lib/club-time");
      club = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);

      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Cancel", lastName: "Refund", ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4145 Lodge", slug: "race-4145" } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
      // The real cancel, runner and paid-another-way modules load cold here: past the 10s default under load.
    }, 120_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deletePaymentRows();
      vi.setSystemTime(FROZEN_AT);
    });

    afterEach(() => {
      // Back to the repository's frozen instant for every suite after this one.
      vi.setSystemTime(FROZEN_AT);
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it("inline success: the cancel's own close records ONE event, as the member; the runner then claims nothing", async () => {
      await paidBooking();
      const asked = stripeAnswers();

      await cancel();

      const row = await rowNow();
      expect(row).toMatchObject({ status: "SUCCEEDED", attempts: 0 });
      const events = await refundedEvents();
      expect(events).toEqual([{ amountCents: REFUND_CENTS, reason: REASON, actorMemberId: MEMBER_ID, occurredAt: FROZEN_AT }]);

      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("not-claimed");
      expect(await refundedEvents()).toHaveLength(1);
      expect(asked).toHaveLength(1);
      expect(await narrative()).toContain(refundedOn(FROZEN_AT));
    });

    it("inline failure, then the runner: none from the cancel - on its way - then ONE from the runner's close, as no member, at its close", async () => {
      await paidBooking();
      let stripeDown = true;
      const asked = stripeAnswers(() => (stripeDown ? "throws" : "succeeded"));

      await cancel();

      const row = await rowNow();
      expect(row).toMatchObject({ status: "PENDING" });
      expect(await refundedEvents()).toEqual([]);
      expect(await readCancelledCardRefundState(BOOKING_ID)).toBe("on-its-way");
      const pending = await narrative();
      expect(pending).toContain(ON_ITS_WAY);
      expect(pending).not.toContain("was refunded");

      stripeDown = false;
      await retryComesDue(row.id);
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      // Dated by the runner's close, two days after the cancel - never the cancel's day.
      expect(await refundedEvents()).toEqual([{ amountCents: REFUND_CENTS, reason: REASON, actorMemberId: null, occurredAt: RUNNER_AT }]);
      // A second run claims nothing, and writes nothing.
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("not-claimed");
      expect(await refundedEvents()).toHaveLength(1);
      expect(asked).toHaveLength(2);
      const refunded = await narrative();
      expect(refunded).toContain(`You cancelled this booking on ${club.instantDate(FROZEN_AT)}`);
      expect(club.instantDate(RUNNER_AT)).not.toBe(club.instantDate(FROZEN_AT));
      expect(refunded).toContain(refundedOn(RUNNER_AT));
    });

    it("partial: one slice made inline, a later one threw - none from the cancel; the runner sends the rest and records the WHOLE plan once", async () => {
      await paidBooking({ topUpCents: 6_000 });
      let primaryDown = true;
      const asked = stripeAnswers((intent) => (intent === PRIMARY_INTENT && primaryDown ? "throws" : "succeeded"));

      await cancel();

      const row = await rowNow();
      expect(row).toMatchObject({ status: "PENDING", amountCents: REFUND_CENTS });
      // The top-up's $60.00 was made and is marked; the $40.00 left threw and keeps its key.
      expect(parseRefundAllocationPlan(row.allocationPlan)).toEqual([
        { paymentTransactionId: ADDITIONAL_TXN, amountCents: 6_000, madeRefundId: expect.any(String) },
        { paymentTransactionId: PRIMARY_TXN, amountCents: 4_000 },
      ]);
      expect(await refundedEvents()).toEqual([]);
      expect(await narrative()).toContain(ON_ITS_WAY);

      primaryDown = false;
      await retryComesDue(row.id);
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      // The made slice was never sent again: two asks inline, one by the runner.
      expect(asked).toHaveLength(3);
      expect(await refundedEvents()).toEqual([{ amountCents: REFUND_CENTS, reason: REASON, actorMemberId: null, occurredAt: RUNNER_AT }]);
      expect(await narrative()).toContain(refundedOn(RUNNER_AT));
    });

    it("refused: Stripe answered failed inline - none from the cancel; the runner retries on the fresh key and records it once", async () => {
      await paidBooking();
      let refusing = true;
      const asked = stripeAnswers(() => (refusing ? "failed" : "succeeded"));

      await cancel();

      const row = await rowNow();
      expect(row).toMatchObject({ status: "PENDING" });
      expect(parseRefundAllocationPlan(row.allocationPlan)).toEqual([{ paymentTransactionId: PRIMARY_TXN, amountCents: REFUND_CENTS, stripeKeySuffix: "refused1" }]);
      expect(await refundedEvents()).toEqual([]);
      expect(await narrative()).toContain(ON_ITS_WAY);

      refusing = false;
      await retryComesDue(row.id);
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(new Set(asked).size).toBe(2);
      expect(await refundedEvents()).toEqual([{ amountCents: REFUND_CENTS, reason: REASON, actorMemberId: null, occurredAt: RUNNER_AT }]);
      expect(await narrative()).toContain(refundedOn(RUNNER_AT));
    });

    it("paid another way: the dead row is closed by an officer and NO REFUNDED event is written; the narrative says it was paid back another way", async () => {
      await paidBooking();
      stripeAnswers(() => "throws");

      await cancel();

      const row = await rowNow();
      // Its retries spent: dead, and the club's to follow up.
      await prisma.paymentRecoveryOperation.update({ where: { id: row.id }, data: { status: "FAILED", attempts: 5, nextRetryAt: null } });
      expect(await readCancelledCardRefundState(BOOKING_ID)).toBe("stalled");
      expect(await narrative()).toContain("$100.00 is being refunded to you and $100.00 was retained; the club will be in touch about the card refund");

      await closeCardRefundPaidAnotherWay({
        operationId: row.id,
        amountCents: REFUND_CENTS,
        paidBack: "full",
        expectedOwedCents: REFUND_CENTS,
        note: "Bank transfer, ref RACE 4145",
        actingMemberId: OFFICER_ID,
      });

      expect(await rowNow()).toMatchObject({ status: "SUCCEEDED" });
      expect(await refundedEvents()).toEqual([]);
      expect(await readCancelledCardRefundState(BOOKING_ID)).toBe("paid-another-way");
      const message = await narrative();
      expect(message).toContain("$100.00 could not go back to your card and was paid back to you another way and $100.00 was retained");
      expect(message).not.toContain("was refunded");
    });

    it("paid another way after part went to the card: the close records the made part as the cancel's card refund event, once, and the page says the two parts apart", async () => {
      await paidBooking({ topUpCents: 6_000 });
      stripeAnswers((intent) => (intent === PRIMARY_INTENT ? "throws" : "succeeded"));

      await cancel();

      const row = await rowNow();
      await prisma.paymentRecoveryOperation.update({ where: { id: row.id }, data: { status: "FAILED", attempts: 5, nextRetryAt: null } });
      expect(await refundedEvents()).toEqual([]);
      // Closed two days later, for the $40.00 the card never took.
      vi.setSystemTime(RUNNER_AT);
      await closeCardRefundPaidAnotherWay({
        operationId: row.id,
        amountCents: 4_000,
        paidBack: "full",
        expectedOwedCents: 4_000,
        note: "Bank transfer, ref RACE 4145 part",
        actingMemberId: OFFICER_ID,
      });

      // Dated by the refund Stripe made at the cancel, not by the officer's close.
      expect(await refundedEvents()).toEqual([
        { amountCents: 6_000, reason: "$60.00 of the 50% refund ($100.00) refunded to the original payment method.", actorMemberId: null, occurredAt: FROZEN_AT },
      ]);
      // Marked as the close's own, so the page reads it as the card's part.
      expect(await prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID, type: "REFUNDED", snapshot: { path: ["kind"], equals: "card_refund_made_before_paid_another_way" } } })).toBe(1);
      expect(await readCancelledCardRefund(BOOKING_ID)).toEqual({ cardRefundState: "paid-another-way", cardRefundClose: { paidBackCents: 4_000, unpaidCents: 0, madeCents: 6_000 } });
      expect(await narrative()).toContain(
        `$60.00 was refunded to your card on ${club.instantDate(FROZEN_AT)}, $40.00 could not go back to your card and was paid back to you another way and $100.00 was retained`,
      );
    });

    it("paid back in part after part went to the card: the page names the card's part, what the officer paid back, and the rest the club closed", async () => {
      // $30.00 on the top-up goes back to the card; the $70.00 on the main charge never does.
      await paidBooking({ topUpCents: 3_000 });
      stripeAnswers((intent) => (intent === PRIMARY_INTENT ? "throws" : "succeeded"));

      await cancel();

      const row = await rowNow();
      await prisma.paymentRecoveryOperation.update({ where: { id: row.id }, data: { status: "FAILED", attempts: 5, nextRetryAt: null } });
      vi.setSystemTime(RUNNER_AT);
      await closeCardRefundPaidAnotherWay({
        operationId: row.id,
        amountCents: 5_000,
        paidBack: "partial",
        expectedOwedCents: 7_000,
        note: "Bank transfer, ref RACE 4145 in part",
        actingMemberId: OFFICER_ID,
      });

      expect(await refundedEvents()).toEqual([
        { amountCents: 3_000, reason: "$30.00 of the 50% refund ($100.00) refunded to the original payment method.", actorMemberId: null, occurredAt: FROZEN_AT },
      ]);
      expect(await readCancelledCardRefund(BOOKING_ID)).toEqual({ cardRefundState: "paid-another-way", cardRefundClose: { paidBackCents: 5_000, unpaidCents: 2_000, madeCents: 3_000 } });
      const message = await narrative();
      expect(message).toContain(
        `$30.00 was refunded to your card on ${club.instantDate(FROZEN_AT)}, $50.00 could not go back to your card and was paid back to you another way, the club checked the remaining $20.00 and closed it and $100.00 was retained`,
      );
      expect(message).not.toContain("$70.00 could not go back");
    });

    it("the deploy boundary, paid another way: an up-front event, $60.00 made inline and the rest closed - no second event, and the page says the card's part from the close's record, never as closed", async () => {
      await paidBooking({ topUpCents: 6_000 });
      stripeAnswers((intent) => (intent === PRIMARY_INTENT ? "throws" : "succeeded"));
      await cancel();
      // What the old cancel wrote after its part-failed refund.
      await prisma.bookingEvent.create({ data: { bookingId: BOOKING_ID, type: "REFUNDED", occurredAt: FROZEN_AT, actorMemberId: MEMBER_ID, amountCents: REFUND_CENTS, reason: REASON } });
      const row = await rowNow();
      await prisma.paymentRecoveryOperation.update({ where: { id: row.id }, data: { status: "FAILED", attempts: 5, nextRetryAt: null } });

      await closeCardRefundPaidAnotherWay({
        operationId: row.id,
        amountCents: 4_000,
        paidBack: "full",
        expectedOwedCents: 4_000,
        note: "Bank transfer, ref RACE 4145 boundary",
        actingMemberId: OFFICER_ID,
      });

      expect(await refundedEvents()).toEqual([{ amountCents: REFUND_CENTS, reason: REASON, actorMemberId: MEMBER_ID, occurredAt: FROZEN_AT }]);
      const message = await narrative();
      expect(message).toContain("$60.00 was refunded to your card, $40.00 could not go back to your card and was paid back to you another way and $100.00 was retained");
      expect(message).not.toContain("closed it");
    });

    it("the deploy boundary: a cancel made before #4145 wrote its event up front - the page says on its way while the row is open, and the runner closes the row with no second event", async () => {
      await paidBooking();
      let stripeDown = true;
      stripeAnswers(() => (stripeDown ? "throws" : "succeeded"));
      await cancel();
      // What the old cancel wrote after its failed refund.
      await prisma.bookingEvent.create({ data: { bookingId: BOOKING_ID, type: "REFUNDED", occurredAt: FROZEN_AT, actorMemberId: MEMBER_ID, amountCents: REFUND_CENTS, reason: REASON } });
      expect(await narrative()).toContain(ON_ITS_WAY);

      const row = await rowNow();
      stripeDown = false;
      await retryComesDue(row.id);
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(await rowNow()).toMatchObject({ status: "SUCCEEDED" });
      expect(await refundedEvents()).toEqual([{ amountCents: REFUND_CENTS, reason: REASON, actorMemberId: MEMBER_ID, occurredAt: FROZEN_AT }]);
      expect(await narrative()).toContain(refundedOn(FROZEN_AT));
    });

    it("the cancel's close landing while the runner holds the row: only the close that moved it records - ONE event, the cancel's", async () => {
      await paidBooking();
      let stripeDown = true;
      // While the runner sends the refund, the cancel's close (its inline refund made under the same keys) moves the row first.
      stripeAnswers(
        () => (stripeDown ? "throws" : "succeeded"),
        async () => {
          if (stripeDown) return;
          const sentPlan = parseRefundAllocationPlan((await rowNow()).allocationPlan) ?? [];
          const moved = await closeRefundRowRecordingEvent(
            { bookingId: BOOKING_ID, amountCents: REFUND_CENTS, actorMemberId: MEMBER_ID, reason: REASON },
            async (tx) => (await markBookingCancellationRefundRecoverySucceeded({ idempotencyKey: ROW_KEY, sentPlan, store: tx })).count === 1,
          );
          expect(moved).toBe(true);
        },
      );
      await cancel();
      const row = await rowNow();
      stripeDown = false;
      await retryComesDue(row.id);

      await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST);

      expect(await rowNow()).toMatchObject({ status: "SUCCEEDED" });
      expect(await refundedEvents()).toEqual([{ amountCents: REFUND_CENTS, reason: REASON, actorMemberId: MEMBER_ID, occurredAt: RUNNER_AT }]);
    });

    it("the cancel's event insert refused: its close rolls back with it, the row stays open, and the runner's close records it once", async () => {
      await paidBooking();
      const asked = stripeAnswers();
      // Every REFUNDED insert for this booking is refused while the trigger stands; its CANCELLED event is not.
      await prisma.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION race_4145_refuse_event() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'race-4145: event refused'; END $$ LANGUAGE plpgsql`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER race_4145_refuse_event BEFORE INSERT ON "BookingEvent" FOR EACH ROW WHEN (NEW."bookingId" = '${BOOKING_ID}' AND NEW."type"::text = 'REFUNDED') EXECUTE FUNCTION race_4145_refuse_event()`,
      );
      try {
        await cancel();
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS race_4145_refuse_event ON "BookingEvent"`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS race_4145_refuse_event()`);
      }
      const row = await rowNow();
      expect(row).toMatchObject({ status: "PENDING", attempts: 0 });
      expect(await refundedEvents()).toEqual([]);
      // The refund was made, but nothing records it yet: the page says it is on its way, never refunded.
      expect(await narrative()).toContain(ON_ITS_WAY);

      await retryComesDue(row.id);
      expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      // #4510 (INV-PAY-147): Stripe lists the cancel's refund with this slice's
      // key as its evidence, so the runner adopts it and asks Stripe nothing more:
      // one refund, the cancel's, and one event.
      expect(asked).toHaveLength(1);
      expect(await prisma.paymentRefund.findMany({ where: { paymentId: PAYMENT_ID }, select: { stripeRefundId: true } })).toEqual([{ stripeRefundId: `re_race_4145_${asked[0]}` }]);
      expect(await refundedEvents()).toEqual([{ amountCents: REFUND_CENTS, reason: REASON, actorMemberId: null, occurredAt: RUNNER_AT }]);
    });
  },
);
