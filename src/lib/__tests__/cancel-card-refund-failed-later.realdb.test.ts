/**
 * Real-PostgreSQL proof of #4166 (`INV-PAY-134`): a cancel's card refund that
 * the close recorded - its REFUNDED event - and Stripe then failed (#4104) is
 * told on the booking page by the row that owes it again, never as refunded on
 * the event's date.
 *
 * What a mock can only imitate, run here against the database through the REAL
 * `cancelBooking`, `enqueueCapacityClaimFailedRefundRecovery`,
 * `runPaymentRecoveryOperationNow`, the failed-later writer
 * (`recordRefusedCardRefund` -> `recordStripeRefundsAgainstTransaction`),
 * `closeCardRefundPaidAnotherWay`, `readCancelledCardRefund` and
 * `resolveBookingNarrative`, for a member's cancel and a capacity race alike:
 *
 * - Refunded (Stripe answered `pending`), then failed: on its way - the
 *   runner's retry made it again: refunded to the card, on the retry's date.
 * - The retry failed later too, raised dead on a row of its own: stalled, and
 *   the club follows it up - then closed "Paid another way": said so.
 * - #4166 round 2 (F1): another door's refund of the same amount on the same
 *   charge, recorded first (R), holds the cancel's slice by amount. The writer
 *   records which row made a failed refund by what was sent, so the cancel's
 *   (X) failing is told as its own, and R failing is not.
 * - #4210: the cancel's refund X reached Stripe but its answer was lost; the
 *   treasurer closed the row "Paid another way" and the app recorded X only
 *   after that (paid twice), then Stripe failed X. The close already paid it
 *   back: no row owes it, nothing is re-sent, and the page says paid back
 *   another way. Control: a refund the close counted as made (recorded before
 *   it) is still owed again and re-sent.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4166-` fixtures. No Stripe call is made: refunds go to the harness's one
 * shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4166-member";
const OFFICER_ID = "race-4166-officer";
const LODGE_ID = "race-4166-lodge";
const BOOKING_ID = "race-4166-booking";
const PAYMENT_ID = "race-4166-payment";
const TXN_ID = "race-4166-txn";
const INTENT = "pi_race_4166";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const PAID_AT = new Date("2026-05-02T00:00:00.000Z");
const PAID_CENTS = 20_000;
/** A member's cancel: one tier, half back. */
const MEMBER_REFUND_CENTS = 10_000;
/** A capacity race: the ledger showed less refundable than the charge, so its plan refunds this. */
const RACE_PLANNED_CENTS = 15_000;
const CANCEL_KEY = `booking_cancel_refund_recovery_${BOOKING_ID}`;
const RACE_KEY = `capacity_claim_failed_refund_recovery_${BOOKING_ID}_${INTENT}`;
/** The repository's frozen instant (the cancel's), when Stripe fails it, and the runner's retry. */
const FROZEN_AT = new Date("2026-07-01T00:00:00.000Z");
const FAILED_AT = new Date("2026-07-04T00:00:00.000Z");
const RETRY_AT = new Date("2026-07-06T00:00:00.000Z");
/** When Stripe fails the retry too. */
const RETRY_FAILED_AT = new Date("2026-07-08T00:00:00.000Z");
const CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Failed-later cancel refund proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run failed-later cancel refund proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Failed-later cancel refund proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Failed-later cancel refund proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let cancelBooking: (typeof import("@/lib/booking-cancel"))["cancelBooking"];
let enqueueCapacityClaimFailedRefundRecovery: (typeof import("@/lib/payment-recovery"))["enqueueCapacityClaimFailedRefundRecovery"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let recordRefusedCardRefund: (typeof import("@/lib/card-refund-status-sync"))["recordRefusedCardRefund"];
let recordStripeRefundsAgainstTransaction: (typeof import("@/lib/payment-transactions"))["recordStripeRefundsAgainstTransaction"];
let parseRefundAllocationPlan: (typeof import("@/lib/open-card-refund-owed"))["parseRefundAllocationPlan"];
let closeCardRefundPaidAnotherWay: (typeof import("@/lib/card-refund-paid-another-way"))["closeCardRefundPaidAnotherWay"];
let readCancelledCardRefund: (typeof import("@/lib/cancel-card-refund-shortfall-status"))["readCancelledCardRefund"];
let readCardShortfallTaskStatuses: (typeof import("@/lib/cancel-card-refund-shortfall-status"))["readCardShortfallTaskStatuses"];
let listCardRefundsPaidTwice: (typeof import("@/lib/card-refund-paid-twice"))["listCardRefundsPaidTwice"];
let listDeadCardRefunds: (typeof import("@/lib/card-refund-paid-another-way"))["listDeadCardRefunds"];
let resolveCardRefundPaidTwice: (typeof import("@/lib/card-refund-paid-twice"))["resolveCardRefundPaidTwice"];
let closeCardRefundCheckNotOwed: (typeof import("@/lib/card-refund-check-not-owed"))["closeCardRefundCheckNotOwed"];
let readPaidAnotherWayCounted: (typeof import("@/lib/card-refund-paid-another-way-counted"))["readPaidAnotherWayCounted"];
let resolveBookingNarrative: (typeof import("@/lib/booking-narrative"))["resolveBookingNarrative"];
let club: ReturnType<(typeof import("@/lib/club-time"))["bindClubTime"]>;
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let markerFinishedAt: Date | null = null;

(RUN ? describe : describe.skip)(
  "a cancel's card refund that failed after its REFUNDED event is told by its own row — real PostgreSQL (#4166)",
  { timeout: 60_000 },
  () => {
    async function deletePaymentRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
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

    async function setCutoff(at: Date) {
      await prisma.$executeRaw`UPDATE "_prisma_migrations" SET "finished_at" = ${at} WHERE "migration_name" = ${CUTOFF_MIGRATION}`;
    }

    /** A booking paid $200.00 by card on one charge. */
    async function paidBooking(status: "PAID" | "CANCELLED") {
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: NIGHT, checkOut: CHECK_OUT, status, totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS },
      });
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: INTENT, xeroInvoiceId: "inv_race_4166" },
      });
      await prisma.paymentTransaction.create({
        data: { id: TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT, amountCents: PAID_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
      });
    }

    /**
     * Stripe accepts every refund `pending` (it counts as made) unless told
     * `succeeded`; each is kept, so the test can have Stripe fail it later.
     */
    function stripeAccepts(status: () => "pending" | "succeeded" = () => "pending") {
      const made: Stripe.Refund[] = [];
      stripeRaceHooks.refund = async (args) => {
        const refund = {
          id: `re_race_4166_${made.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: status(),
          reason: "requested_by_customer",
          created: Math.floor(Date.now() / 1000),
          charge: "ch_race_4166",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        } as unknown as Stripe.Refund;
        made.push(refund);
        return refund;
      };
      return made;
    }

    /** Stripe reports a refund it accepted as failed: the real writer raises the row that owes it again. */
    async function stripeFailsLater(refund: Stripe.Refund | undefined, at = FAILED_AT) {
      if (!refund) throw new Error("no refund was made");
      vi.setSystemTime(at);
      expect(await recordRefusedCardRefund({ ...refund, status: "failed" } as Stripe.Refund)).toBe("recorded");
      return prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: `card_refund_failed_later_${refund.id}` } });
    }

    /** The runner's retry, two days on. */
    async function runnerRetries(id: string) {
      vi.setSystemTime(RETRY_AT);
      await prisma.paymentRecoveryOperation.update({ where: { id }, data: { nextRetryAt: RETRY_AT } });
      expect(await runPaymentRecoveryOperationNow(id, CLUB_FORMAT_TEST)).toBe("succeeded");
    }

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
            firstName: "Failed",
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

    /** Its retries spent, then closed by an officer "Paid another way" for all it owes. */
    async function paidAnotherWay(id: string, cents: number) {
      await prisma.paymentRecoveryOperation.update({ where: { id }, data: { status: "FAILED", attempts: 5, nextRetryAt: null } });
      await closeCardRefundPaidAnotherWay({ operationId: id, amountCents: cents, paidBack: "full", expectedOwedCents: cents, note: "Bank transfer, ref RACE 4166", actingMemberId: OFFICER_ID });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ cancelBooking } = await import("@/lib/booking-cancel"));
      ({ enqueueCapacityClaimFailedRefundRecovery, runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync"));
      ({ recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions"));
      ({ parseRefundAllocationPlan } = await import("@/lib/open-card-refund-owed"));
      ({ closeCardRefundPaidAnotherWay, listDeadCardRefunds } = await import("@/lib/card-refund-paid-another-way"));
      ({ listCardRefundsPaidTwice, resolveCardRefundPaidTwice } = await import("@/lib/card-refund-paid-twice"));
      ({ closeCardRefundCheckNotOwed } = await import("@/lib/card-refund-check-not-owed"));
      ({ readPaidAnotherWayCounted } = await import("@/lib/card-refund-paid-another-way-counted"));
      ({ readCancelledCardRefund, readCardShortfallTaskStatuses } = await import("@/lib/cancel-card-refund-shortfall-status"));
      ({ resolveBookingNarrative } = await import("@/lib/booking-narrative"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));
      const { bindClubTime, requireClubTimeZone } = await import("@/lib/club-time");
      club = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);

      // The cutoff marker (#4104, ops 8): finished well before these refunds, so a
      // failed one is re-sent rather than raised dead as backlog; restored after.
      const [marker] = await prisma.$queryRaw<Array<{ finished_at: Date }>>`
        SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" = ${CUTOFF_MIGRATION}`;
      if (!marker) throw new Error(`The race database lacks ${CUTOFF_MIGRATION}: run prisma migrate deploy against it first.`);
      markerFinishedAt = marker.finished_at;
      await setCutoff(new Date("2026-01-01T00:00:00.000Z"));

      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Failed", lastName: "Later", ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4166 Lodge", slug: "race-4166" } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
      // The real cancel, runner and paid-another-way modules load cold here: past the 10s default under load.
    }, 120_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deletePaymentRows();
      // Again for each test: another suite run beside this one (#4104's) restores the
      // marker in its own afterAll, which would make these refunds read as backlog.
      await setCutoff(new Date("2026-01-01T00:00:00.000Z"));
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
      if (markerFinishedAt) await setCutoff(markerFinishedAt);
    });

    describe("a member's cancel", () => {
      const RETAINED = "and $100.00 was retained";

      async function cancelRefunded() {
        await paidBooking("PAID");
        await prisma.bookingEvent.create({ data: { bookingId: BOOKING_ID, type: "MEMBER_PAID", occurredAt: PAID_AT, amountCents: PAID_CENTS } });
        const made = stripeAccepts();
        expect((await cancelBooking(BOOKING_ID, MEMBER_ID, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);
        expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: CANCEL_KEY } })).toMatchObject({ status: "SUCCEEDED" });
        expect(await narrative()).toContain(`$100.00 was refunded on ${club.instantDate(FROZEN_AT)} ${RETAINED}`);
        return made;
      }

      it("refunded, then failed later: on its way - and the runner's retry made it again: refunded to the card on the retry's date", async () => {
        const made = await cancelRefunded();

        const owedAgain = await stripeFailsLater(made[0]);
        expect(owedAgain).toMatchObject({ status: "PENDING", attempts: 0, amountCents: MEMBER_REFUND_CENTS });
        // #4166 (F1): the writer records the cancel row as the refund's maker.
        const cancelRow = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: CANCEL_KEY } });
        expect(parseRefundAllocationPlan(owedAgain.allocationPlan)?.[0]?.madeByOperationId).toBe(cancelRow.id);
        expect((await readCancelledCardRefund(BOOKING_ID)).cardRefundFailedLater).toEqual([{ amountCents: MEMBER_REFUND_CENTS, state: "on-its-way" }]);
        const failed = await narrative();
        expect(failed).toContain(`$100.00 is on its way to your original payment method ${RETAINED}`);
        expect(failed).not.toContain("was refunded");

        await runnerRetries(owedAgain.id);
        const remade = await narrative();
        expect(remade).toContain(`$100.00 was refunded to your card on ${club.instantDate(RETRY_AT)} ${RETAINED}`);
        expect(remade).not.toContain(`refunded on ${club.instantDate(FROZEN_AT)}`);
      });

      it("the retry failed later too: stalled, the club follows it up - then paid another way", async () => {
        const made = await cancelRefunded();
        const owedAgain = await stripeFailsLater(made[0]);
        await runnerRetries(owedAgain.id);

        const dead = await stripeFailsLater(made[1], RETRY_FAILED_AT);
        expect(dead).toMatchObject({ status: "PENDING", attempts: 5 });
        const stalled = await narrative();
        expect(stalled).toContain(`$100.00 is being refunded to you ${RETAINED}; the club will be in touch about the card refund`);
        expect(stalled).not.toContain("was refunded");

        await paidAnotherWay(dead.id, MEMBER_REFUND_CENTS);
        const closed = await narrative();
        expect(closed).toContain(`$100.00 could not go back to your card and was paid back to you another way ${RETAINED}`);
        expect(closed).not.toContain("was refunded");
      });
    });

    // #4166 round 2 (F1): an approved appeal's inline refund R and the cancel's
    // X, both $100.00 on the one charge, R recorded first, inside the cancel
    // row's window - so by amount R fills the cancel's slice.
    describe("a same-amount refund from another door, recorded first", () => {
      const APPEAL = { bookingId: BOOKING_ID, reason: "refund_appeal_approved", refundRequestId: "rr-4166" };

      async function bothRefunded(rStatus: "pending" | "succeeded") {
        await paidBooking("PAID");
        await prisma.bookingEvent.create({ data: { bookingId: BOOKING_ID, type: "MEMBER_PAID", occurredAt: PAID_AT, amountCents: PAID_CENTS } });
        const r = {
          id: "re_race_4166_appeal",
          object: "refund",
          amount: MEMBER_REFUND_CENTS,
          currency: "nzd",
          status: rStatus,
          reason: "requested_by_customer",
          created: Math.floor(FROZEN_AT.getTime() / 1000),
          charge: "ch_race_4166",
          payment_intent: INTENT,
          metadata: APPEAL,
        } as unknown as Stripe.Refund;
        const made = stripeAccepts();
        const accept = stripeRaceHooks.refund;
        if (!accept) throw new Error("no Stripe double");
        // R is recorded while the cancel asks Stripe for X - after the cancel planned
        // its refund and raised its row, before X is recorded - so it is inside the
        // row's window and, recorded first, takes the slice by amount.
        stripeRaceHooks.refund = async (args) => {
          stripeRaceHooks.refund = accept;
          await recordStripeRefundsAgainstTransaction({ paymentId: PAYMENT_ID, paymentTransactionId: TXN_ID, refunds: [r], fallbackPaymentIntentId: INTENT });
          vi.setSystemTime(new Date(FROZEN_AT.getTime() + 500));
          return accept(args);
        };
        expect((await cancelBooking(BOOKING_ID, MEMBER_ID, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);
        const cancelRow = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: CANCEL_KEY } });
        expect(cancelRow.status).toBe("SUCCEEDED");
        expect(await narrative()).toContain(`$100.00 was refunded on ${club.instantDate(FROZEN_AT)} and $100.00 was retained`);
        return { r, x: made[0], cancelRow };
      }
      const madeByRecorded = (row: { allocationPlan: unknown }) => parseRefundAllocationPlan(row.allocationPlan)?.[0]?.madeByOperationId;

      it("MUTATION: X, the cancel's, fails: the writer records the cancel row as its maker, and the page says it is on its way", async () => {
        const { x, cancelRow } = await bothRefunded("succeeded");

        const owedAgain = await stripeFailsLater(x);
        expect(madeByRecorded(owedAgain)).toBe(cancelRow.id);
        const failed = await narrative();
        expect(failed).toContain("$100.00 is on its way to your original payment method and $100.00 was retained");
        expect(failed).not.toContain("was refunded");
      });

      it("MUTATION: R, the appeal's, fails: no row of the payment sent it, so the cancel's refund still reads refunded", async () => {
        const { r } = await bothRefunded("pending");

        const owedAgain = await stripeFailsLater(r);
        expect(madeByRecorded(owedAgain)).toBeNull();
        expect((await readCancelledCardRefund(BOOKING_ID)).cardRefundFailedLater).toBeUndefined();
        expect(await narrative()).toContain(`$100.00 was refunded on ${club.instantDate(FROZEN_AT)} and $100.00 was retained`);
      });
    });

    // #4210: X reached Stripe but the answer was lost, so the officer closed the
    // row "Paid another way" - paying X's $100.00 back by bank - before the app
    // recorded X. Stripe then failed X: the member has had the money once.
    describe("a refund the app recorded only after its row was closed \"Paid another way\"", () => {
      const CLOSED_AT = new Date("2026-07-02T00:00:00.000Z");
      const RECORDED_AT = new Date("2026-07-03T00:00:00.000Z");
      const RETAINED = "and $100.00 was retained";

      /** The cancel asks Stripe for X, which Stripe makes, but the answer is lost. */
      async function cancelAnswerLost() {
        await paidBooking("PAID");
        await prisma.bookingEvent.create({ data: { bookingId: BOOKING_ID, type: "MEMBER_PAID", occurredAt: PAID_AT, amountCents: PAID_CENTS } });
        const made = stripeAccepts();
        const accept = stripeRaceHooks.refund;
        if (!accept) throw new Error("no Stripe double");
        stripeRaceHooks.refund = async (args) => {
          await accept(args);
          throw new Error("Request to Stripe timed out");
        };
        expect((await cancelBooking(BOOKING_ID, MEMBER_ID, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);
        stripeRaceHooks.refund = accept;
        const x = made[0];
        if (!x) throw new Error("Stripe made no refund");
        return { x, cancelRow: await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: CANCEL_KEY } }) };
      }

      /** The `charge.refunded` sync records X as Stripe holds it: still `pending`, counted. */
      async function recordedLate(x: Stripe.Refund) {
        vi.setSystemTime(RECORDED_AT);
        await recordStripeRefundsAgainstTransaction({ paymentId: PAYMENT_ID, paymentTransactionId: TXN_ID, refunds: [x], fallbackPaymentIntentId: INTENT });
        // Dated as the sync recorded it: the database's own clock is not the test's frozen one.
        await prisma.paymentRefund.update({ where: { stripeRefundId: x.id }, data: { createdAt: RECORDED_AT } });
      }

      it("MUTATION: the close already paid it back - no row owes it, nothing is re-sent, the officers' lists and the page say so", async () => {
        const { x, cancelRow } = await cancelAnswerLost();
        expect(cancelRow.status).not.toBe("SUCCEEDED");
        vi.setSystemTime(CLOSED_AT);
        await paidAnotherWay(cancelRow.id, MEMBER_REFUND_CENTS);
        // Round 3 (money F2): the close keeps what it counted - nothing made, X's slice unsent.
        const record = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID } });
        expect(readPaidAnotherWayCounted(record.reviewContext)).toEqual({ refundIds: [], unsentSlices: [{ paymentTransactionId: TXN_ID, amountCents: MEMBER_REFUND_CENTS, exact: true }] });
        await recordedLate(x);
        // Paid twice: by the bank transfer the close recorded, and (Stripe says) by card.
        expect(await listCardRefundsPaidTwice()).toEqual([expect.objectContaining({ operationId: cancelRow.id, paidAnotherWayCents: MEMBER_REFUND_CENTS, refundedByCardCents: MEMBER_REFUND_CENTS })]);

        vi.setSystemTime(FAILED_AT);
        expect(await recordRefusedCardRefund({ ...x, status: "failed" } as Stripe.Refund)).toBe("recorded");

        // Nothing owes it again, so the runner has nothing to send.
        expect(await prisma.paymentRecoveryOperation.findUnique({ where: { idempotencyKey: `card_refund_failed_later_${x.id}` } })).toBeNull();
        expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
        // The officers: no longer paid twice, nothing to close, and the audit log keeps the decision.
        expect(await listCardRefundsPaidTwice()).toEqual([]);
        expect((await listDeadCardRefunds()).filter((each) => each.bookingId === BOOKING_ID)).toEqual([]);
        const audit = await prisma.auditLog.findMany({ where: { targetId: BOOKING_ID, action: "booking-payment.card-refund.failed-later-paid-another-way" } });
        expect(audit).toEqual([expect.objectContaining({ entityType: "PaymentRefund", entityId: x.id, category: "payment" })]);
        expect(audit[0]?.metadata).toMatchObject({ decision: "settled-paid-another-way", operationId: cancelRow.id, paidBackCents: MEMBER_REFUND_CENTS, owedCents: MEMBER_REFUND_CENTS, checkCents: 0, onPaidTwiceList: true });
        // The member's page: paid back another way, never "on its way" or "refunded".
        expect((await readCancelledCardRefund(BOOKING_ID)).cardRefundFailedLater).toBeUndefined();
        const page = await narrative();
        expect(page).toContain(`$100.00 could not go back to your card and was paid back to you another way ${RETAINED}`);
        expect(page).not.toContain("on its way");
        expect(page).not.toContain("was refunded");
      });

      // #4210 round 2 (F3): a part close may have given up the refund's share - that much is left for an officer.
      it("MUTATION: a part close - what it gave up is raised dead for an officer, never sent; the rest stays settled", async () => {
        const { x, cancelRow } = await cancelAnswerLost();
        vi.setSystemTime(CLOSED_AT);
        await prisma.paymentRecoveryOperation.update({ where: { id: cancelRow.id }, data: { status: "FAILED", attempts: 5, nextRetryAt: null } });
        await closeCardRefundPaidAnotherWay({ operationId: cancelRow.id, amountCents: 6_000, paidBack: "partial", expectedOwedCents: MEMBER_REFUND_CENTS, note: "Bank transfer, part", actingMemberId: OFFICER_ID });
        await recordedLate(x);

        vi.setSystemTime(FAILED_AT);
        expect(await recordRefusedCardRefund({ ...x, status: "failed" } as Stripe.Refund)).toBe("recorded");

        const check = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: `card_refund_failed_later_${x.id}` } });
        expect(check).toMatchObject({ status: "PENDING", attempts: 5, amountCents: 4_000 });
        expect(parseRefundAllocationPlan(check.allocationPlan)?.[0]?.madeByOperationId).toBe(cancelRow.id);
        // On the list a treasurer closes from, for what the close gave up - never asked of Stripe.
        expect((await listDeadCardRefunds()).filter((each) => each.bookingId === BOOKING_ID)).toEqual([expect.objectContaining({ operationId: check.id, owedCents: 4_000 })]);
        const audit = await prisma.auditLog.findFirstOrThrow({ where: { targetId: BOOKING_ID, action: "booking-payment.card-refund.failed-later-paid-another-way" } });
        expect(audit.metadata).toMatchObject({ decision: "raised-check-part-close", raisedOperationId: check.id, paidBackCents: 6_000, owedCents: MEMBER_REFUND_CENTS, checkCents: 4_000 });
        expect(parseRefundAllocationPlan(check.allocationPlan)?.[0]?.paidAnotherWayCheck).toEqual({ closedOperationId: cancelRow.id, reason: "part-close" });
        // Round 3 (UX 5): the member's page says the club will be in touch about it, never that it was checked and closed.
        const page = await narrative();
        expect(page).toContain("$60.00 could not go back to your card and was paid back to you another way, the club will be in touch about the remaining $40.00");
        expect(page).not.toContain("checked the remaining");
        expect(page).not.toContain("on its way");

        // Round 3 (UX 2): checked - not owed closes it, moving no money; the page says the club closed it.
        const refundedBefore = (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).refundedAmountCents;
        await closeCardRefundCheckNotOwed({ operationId: check.id, note: "The close's transfer covered it", actingMemberId: OFFICER_ID });
        expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: check.id } })).toMatchObject({ status: "SUCCEEDED" });
        expect((await listDeadCardRefunds()).filter((each) => each.bookingId === BOOKING_ID)).toEqual([]);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).refundedAmountCents).toBe(refundedBefore);
        expect(await prisma.auditLog.count({ where: { targetId: BOOKING_ID, action: "booking-payment.card-refund.checked-not-owed" } })).toBe(1);
        expect(await narrative()).toContain("$60.00 could not go back to your card and was paid back to you another way, the club checked the remaining $40.00 and closed it");
      });

      // #4210 round 2 (F4): the paid-twice row was marked Resolved - the member may have returned the extra.
      it("MUTATION: its paid-twice row marked Resolved - the whole refund is raised dead, with the note audited", async () => {
        const { x, cancelRow } = await cancelAnswerLost();
        vi.setSystemTime(CLOSED_AT);
        await paidAnotherWay(cancelRow.id, MEMBER_REFUND_CENTS);
        await recordedLate(x);
        await resolveCardRefundPaidTwice({ operationId: cancelRow.id, note: "Member paid the card refund back by bank", expectedRefundedByCardCents: MEMBER_REFUND_CENTS, actingMemberId: OFFICER_ID });

        vi.setSystemTime(FAILED_AT);
        expect(await recordRefusedCardRefund({ ...x, status: "failed" } as Stripe.Refund)).toBe("recorded");

        expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: `card_refund_failed_later_${x.id}` } })).toMatchObject({
          status: "PENDING",
          attempts: 5,
          amountCents: MEMBER_REFUND_CENTS,
        });
        const audit = await prisma.auditLog.findFirstOrThrow({ where: { targetId: BOOKING_ID, action: "booking-payment.card-refund.failed-later-paid-another-way" } });
        expect(audit).toMatchObject({ details: "Member paid the card refund back by bank" });
        expect(audit.metadata).toMatchObject({ decision: "raised-check-resolved", checkCents: MEMBER_REFUND_CENTS, resolutionNote: "Member paid the card refund back by bank" });
        // Round 3 (UX 5): the member's page says the club will be in touch about it.
        const page = await narrative();
        expect(page).toContain("$100.00 could not go back to your card and was paid back to you another way, the club will be in touch about $100.00 of the refund");
        expect(page).not.toContain("on its way");
        // Round 3 (UX 1): the officers' list marks it a check, and why.
        expect((await listDeadCardRefunds()).filter((each) => each.bookingId === BOOKING_ID)).toEqual([expect.objectContaining({ owedCents: MEMBER_REFUND_CENTS, check: "resolved" })]);
      });

      it("MUTATION (control): a refund the close counted as made - recorded before it - is owed again and re-sent", async () => {
        // A capacity race's row of two slices: Stripe makes the first (X1, recorded
        // at once), the second's answer is lost. The close pays back only the second.
        await paidBooking("CANCELLED");
        const half = RACE_PLANNED_CENTS / 2;
        await enqueueCapacityClaimFailedRefundRecovery({
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: INTENT,
          amountCents: RACE_PLANNED_CENTS,
          allocationPlan: [
            { paymentTransactionId: TXN_ID, amountCents: half },
            { paymentTransactionId: TXN_ID, amountCents: half },
          ],
        });
        const made = stripeAccepts();
        const accept = stripeRaceHooks.refund;
        if (!accept) throw new Error("no Stripe double");
        stripeRaceHooks.refund = async (args) => {
          if (made.length === 0) return accept(args);
          throw new Error("Request to Stripe timed out");
        };
        const raceRow = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: RACE_KEY } });
        expect(await runPaymentRecoveryOperationNow(raceRow.id, CLUB_FORMAT_TEST)).not.toBe("succeeded");
        stripeRaceHooks.refund = accept;
        const x1 = made[0];
        if (!x1) throw new Error("Stripe made no refund");
        // Dated as the runner recorded it: the database's own clock is not the test's frozen one.
        await prisma.paymentRefund.update({ where: { stripeRefundId: x1.id }, data: { createdAt: FROZEN_AT } });
        vi.setSystemTime(CLOSED_AT);
        await paidAnotherWay(raceRow.id, half);
        expect(await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID } })).toMatchObject({ amountCents: half, raisedAmountCents: half });

        const owedAgain = await stripeFailsLater(x1);
        expect(owedAgain).toMatchObject({ status: "PENDING", attempts: 0, amountCents: half });
        expect(await prisma.auditLog.count({ where: { targetId: BOOKING_ID, action: "booking-payment.card-refund.failed-later-paid-another-way" } })).toBe(0);
      });
    });

    describe("a capacity race", () => {
      const REST = "the club will be in touch about the remaining $50.00";

      async function raceRefunded() {
        await paidBooking("CANCELLED");
        // As the settle writes it (`payment-reconciliation.ts`), before the refund is attempted.
        await prisma.bookingEvent.create({
          data: {
            bookingId: BOOKING_ID,
            type: "CANCELLED",
            occurredAt: FROZEN_AT,
            amountCents: PAID_CENTS,
            snapshot: { policySummary: "x", refundMethod: "card", cancelledBecause: "capacity_race", refundPercentage: 100, paidAmountCents: PAID_CENTS, settledAmountCents: RACE_PLANNED_CENTS, retainedAmountCents: 0 },
          },
        });
        await enqueueCapacityClaimFailedRefundRecovery({
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: INTENT,
          amountCents: RACE_PLANNED_CENTS,
          allocationPlan: [{ paymentTransactionId: TXN_ID, amountCents: RACE_PLANNED_CENTS }],
        });
        const made = stripeAccepts();
        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: RACE_KEY } });
        expect(await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        expect(await narrative()).toContain(`$150.00 was refunded on ${club.instantDate(FROZEN_AT)}; ${REST}`);
        return made;
      }

      it("refunded, then failed later: on its way - and the runner's retry made it again: refunded to the card on the retry's date", async () => {
        const made = await raceRefunded();

        const owedAgain = await stripeFailsLater(made[0]);
        const raceRow = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: RACE_KEY } });
        expect(parseRefundAllocationPlan(owedAgain.allocationPlan)?.[0]?.madeByOperationId).toBe(raceRow.id);
        expect((await readCancelledCardRefund(BOOKING_ID)).cardRefundFailedLater).toEqual([{ amountCents: RACE_PLANNED_CENTS, state: "on-its-way" }]);
        const failed = await narrative();
        expect(failed).toContain(`$150.00 is on its way to your original payment method; ${REST}`);
        expect(failed).not.toContain("was refunded");

        await runnerRetries(owedAgain.id);
        expect(await narrative()).toContain(`$150.00 was refunded to your card on ${club.instantDate(RETRY_AT)}; ${REST}`);
      });

      it("the retry failed later too: stalled, the club follows it up - then paid another way", async () => {
        const made = await raceRefunded();
        const owedAgain = await stripeFailsLater(made[0]);
        await runnerRetries(owedAgain.id);

        const dead = await stripeFailsLater(made[1], RETRY_FAILED_AT);
        expect(await narrative()).toContain(`$150.00 is being refunded to you; the club will be in touch about the card refund and the remaining $50.00`);

        await paidAnotherWay(dead.id, RACE_PLANNED_CENTS);
        const closed = await narrative();
        expect(closed).toContain(`$150.00 could not go back to your card and was paid back to you another way; ${REST}`);
        expect(closed).not.toContain("was refunded");
      });
    });
  },
);
