/**
 * Real-PostgreSQL proof of #4154 (`INV-PAY-135`): the part of a capacity race's
 * charge its card refund plan does not carry is a hand-back task to check,
 * raised with the cancel, which the officers can close either way.
 *
 * What a mock can only imitate, run here against the database through the REAL
 * capacity race (`markBookingPaymentSucceeded` losing the capacity claim), the
 * REAL `resolveManualRefundTask`, the REAL recovery runner
 * (`runPaymentRecoveryOperationNow`) and the booking page's own reads:
 *
 * - A partial plan (the charge's ledger row already reads $60.00 refunded with
 *   no refund row behind it - the records drift #4125 refunds around): the card
 *   refunds $140.00 and the void's own transaction writes ONE
 *   `CANCELLED_BOOKING_HAND_BACK` to CHECK for $60.00, passing every
 *   `ManualRefundTask` CHECK. The capture's success delivered again through
 *   the webhook door settles nothing more and writes no second. The card refund
 *   ADDS to the drifted total, so the charge reads all of it refunded and the
 *   census reports the drift. Marked paid back, the owner's guarded
 *   recalculation (`INV-PAY-135`) lowers the charge to its refund rows, audited
 *   before and after, and the task lands on that charge alone (never on a
 *   charge captured later on the payment, its own case) - posting its `BANK_REFUND` line and ONE Xero refund
 *   note keyed on the task; the member's page reads the whole charge refunded
 *   and the census agrees.
 * - An empty plan whose records drifted (the row reads the whole charge
 *   refunded): nothing by card; marked paid back, corrected to nothing, and the
 *   whole $200.00 is recorded the same way, the census agreeing.
 * - The card refund still being sent (Stripe unreachable): refused (409),
 *   nothing corrected, until the runner makes the race's refund.
 * - A charge made before the refund ledger started: never corrected - refused
 *   naming why, nothing written - and dismissed, the page says the club closed it.
 * - #4154 review: a payment with no Xero invoice (the usual case) completes with
 *   no note (M4); a dashboard refund Stripe shows and the app has not recorded,
 *   or Stripe unread, refuses until it is - then the charge cannot hold the task
 *   (M1); a completion racing the refund sync, and two completions of one task,
 *   leave the totals agreeing and one of everything (M7). The nightly
 *   self-heal's card note, queued but unsent when the task is paid back, bills
 *   nothing at send time in either outbox order: Xero holds X, never 2X.
 *
 * "Refunds owed" is not read: it is club-wide, and capped at what a payment's
 * records still hold, which here read the whole charge refunded.
 *
 * Every refund the double makes is dated after this database's refund ledger
 * started, as a live one is: an earlier date reads as a pre-ledger refund
 * (`refundLedgerStartSeconds`), which is NOT added to the total.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4154-` fixtures. No Stripe call is made: the refund, and the
 * completion's read of the charge (`getPaymentIntent`), go to the harness's one
 * shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";
import { assertNoForeignPendingXeroOperations } from "./support/race-harness-outbox-guard";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4154-member";
const LODGE_ID = "race-4154-lodge";
const BOOKING_ID = "race-4154-booking";
const PAYMENT_ID = "race-4154-payment";
const CARD_TXN = "race-4154-txn-card";
const GUESTS = ["race-4154-g1", "race-4154-g2"];
const INTENT = "pi_race_4154";
const CHARGE_CENTS = 20_000;
const DRIFT_CENTS = 6_000;
const CHECK_KEY = `cancel-card-shortfall:${BOOKING_ID}:capacity-race:${INTENT}:check`;
const LATE_TXN = "race-4154-txn-late";
const LATE_INTENT = "pi_race_4154_late";
// After this database's refund ledger started (its migration runs at real time), as a live charge's is; the
// double's refunds are later still. A charge from before it is one the correction must refuse (`INV-PAY-135`).
const CHARGE_MADE_AT = new Date("2098-06-01T00:00:00.000Z");
const LATE_CHARGE_MADE_AT = new Date("2098-07-01T00:00:00.000Z");
const CORRECTION_ACTION = "booking-payment.capacity-race.refunded-total-corrected";
const RACE_ROW_KEY = `capacity_claim_failed_refund_recovery_${BOOKING_ID}_${INTENT}`;
const XERO_INVOICE_ID = "race-4154-invoice";
// A stay well after today.
const D1 = new Date("2027-08-01T00:00:00.000Z");
const D2 = new Date("2027-08-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Capacity-race shortfall task proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run capacity-race shortfall task proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Capacity-race shortfall task proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Capacity-race shortfall task proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "a capacity race's refund shortfall is a hand-back task to check - real PostgreSQL (#4154)",
  { timeout: 60_000 },
  () => {
    async function clean(): Promise<void> {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: `card-refund-cap-overflow:${CARD_TXN}:` } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    /**
     * A $200 booking - two guests, two nights at $50 - awaiting its card
     * payment, at a lodge with no beds, so the final capacity claim fails. Its
     * payment's ledger already holds the card charge, reading `refundedCents`
     * of it refunded with no refund row (the drift).
     */
    async function seed({ refundedCents, chargeMadeAt = CHARGE_MADE_AT }: { refundedCents: number; chargeMadeAt?: Date }): Promise<void> {
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: D1, checkOut: CHECK_OUT, status: "PAYMENT_PENDING", totalPriceCents: CHARGE_CENTS, finalPriceCents: CHARGE_CENTS },
      });
      for (const id of GUESTS) {
        await prisma.bookingGuest.create({
          data: {
            id,
            bookingId: BOOKING_ID,
            firstName: "Shortfall",
            lastName: id,
            ageTier: "ADULT",
            isMember: true,
            stayStart: D1,
            stayEnd: CHECK_OUT,
            priceCents: 10_000,
            nights: { create: [{ stayDate: D1, priceCents: 5_000, priceSource: "SOLD" }, { stayDate: D2, priceCents: 5_000, priceSource: "SOLD" }] },
          },
        });
      }
      await prisma.payment.create({
        // #4154 review (M4): no invoice on a payment still awaiting its card - a race's payment is usually never invoiced (`invoice()`).
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: CHARGE_CENTS, source: "STRIPE", status: "PENDING", stripePaymentIntentId: INTENT },
      });
      await prisma.paymentTransaction.create({
        data: { id: CARD_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT, amountCents: CHARGE_CENTS, refundedAmountCents: refundedCents, status: "SUCCEEDED", createdAt: chargeMadeAt },
      });
    }

    /** Stripe makes every refund it is asked for, or (`unreachable`) cannot be reached. */
    function stripeRefunds(answer: "make" | "unreachable") {
      const asked: number[] = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.amountCents);
        if (answer === "unreachable") throw new Error("race-4154: Stripe unreachable");
        return {
          id: `re_race_4154_${asked.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          // After the refund ledger started on this database (its migration ran at real time).
          created: Math.floor(Date.UTC(2099, 0, 1) / 1000),
          charge: "ch_race_4154",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      return asked;
    }

    /** The booking invoiced in Xero after its card payment, so a hand-back's refund note has an invoice to credit. */
    const invoice = () => prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: XERO_INVOICE_ID } });

    /**
     * #4154 review (M1): what Stripe says the race's charge has refunded, as the completion reads it before its
     * transaction - or (`unreachable`) that Stripe cannot be read. Each read is counted.
     */
    function stripeShowsRefunded(answer: number | "unreachable") {
      const reads: string[] = [];
      stripeRaceHooks.get = async (id) => {
        reads.push(id);
        if (answer === "unreachable") throw new Error("race-4154: Stripe unreachable");
        return { id, object: "payment_intent", status: "succeeded", latest_charge: { id: "ch_race_4154", object: "charge", amount_refunded: answer } };
      };
      return reads;
    }

    /** A refund made in the Stripe dashboard on the race's charge, reaching the app through the refund sync. */
    async function dashboardRefundRecorded(id: string, amountCents: number) {
      const { recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions");
      return recordStripeRefundsAgainstTransaction({
        paymentId: PAYMENT_ID,
        paymentTransactionId: CARD_TXN,
        refunds: [{ id, amount: amountCents, currency: "nzd", status: "succeeded", created: Math.floor(Date.UTC(2099, 0, 2) / 1000), charge: "ch_race_4154", payment_intent: INTENT }],
        store: prisma,
      });
    }

    /** The card payment completing after the dates filled. */
    async function capacityRace() {
      const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
      return markBookingPaymentSucceeded({ bookingId: BOOKING_ID, paymentIntentId: INTENT, amountCents: CHARGE_CENTS, paymentMethodId: null, format: CLUB_FORMAT_TEST });
    }

    async function resolve(resolution: "completed" | "dismissed", taskId: string, note: string | null = null) {
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      return resolveManualRefundTask(
        resolution === "completed"
          ? { taskId, resolution, note, actingMemberId: MEMBER_ID, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null }
          : { taskId, resolution, note, actingMemberId: MEMBER_ID, recordedNightPrices: null },
        CLUB_FORMAT_TEST,
      );
    }

    /** Every refund credit note queued on the payment by a task: its amount and the task. */
    async function taskRefundNotes(): Promise<Array<{ cents: unknown; taskId: unknown }>> {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE" },
        select: { requestPayload: true },
      });
      return rows
        .map(({ requestPayload }) => {
          const payload = (requestPayload ?? {}) as Record<string, unknown>;
          return { cents: payload.refundAmountCents, taskId: payload.paidAnotherWayTaskId ?? null };
        })
        .filter((note) => note.taskId !== null);
    }

    /** The member's booking page, from what is stored: its events and the live reads it makes. */
    async function memberPage(): Promise<string> {
      const { resolveBookingNarrative } = await import("@/lib/booking-narrative");
      const { readCancelledCardRefund, readCardShortfallTaskStatuses } = await import("@/lib/cancel-card-refund-shortfall-status");
      const { bindClubTime, requireClubTimeZone } = await import("@/lib/club-time");
      const events = await prisma.bookingEvent.findMany({ where: { bookingId: BOOKING_ID }, select: { type: true, occurredAt: true, amountCents: true, reason: true, snapshot: true } });
      return resolveBookingNarrative(
        {
          club: bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST),
          booking: { status: "CANCELLED", finalPriceCents: CHARGE_CENTS, amountOwed: { owedCents: 0, dueCents: 0, appliedCreditCents: 0 }, checkIn: D1, checkOut: CHECK_OUT, firstName: "Shortfall", adminReviewStatus: null, adminReviewNotes: null, adminReviewReason: null },
          events,
          cardShortfallStatuses: await readCardShortfallTaskStatuses(BOOKING_ID),
          // #4145 (merged from main): the page reads the card refund's state and any close's record together.
          ...(await readCancelledCardRefund(BOOKING_ID)),
        },
        CLUB_FORMAT_TEST,
      ).message;
    }

    const checkTask = () => prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: CHECK_KEY } });
    const corrections = () => prisma.auditLog.findMany({ where: { targetId: BOOKING_ID, action: CORRECTION_ACTION }, select: { category: true, entityId: true, metadata: true } });
    const lateCharge = (amountCents: number) =>
      prisma.paymentTransaction.create({
        data: { id: LATE_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: LATE_INTENT, amountCents, status: "SUCCEEDED", createdAt: LATE_CHARGE_MADE_AT },
      });

    /** #4147's census of the booking, after the back-post confirms it on the ledger (`apply`). */
    async function census(backPost?: "apply") {
      const { runBookingLedgerBackPost } = await import("@/lib/booking-ledger-back-post");
      const { readBookingLedgerCensusRow } = await import("@/lib/booking-ledger-projection-census-store");
      const { evaluateBookingLedgerIdentities } = await import("@/lib/booking-ledger-projection-census");
      const posted = backPost ? (await runBookingLedgerBackPost({ client: prisma, apply: true, bookingIds: [BOOKING_ID] })).outcomes[0]! : null;
      const evaluation = evaluateBookingLedgerIdentities((await readBookingLedgerCensusRow(prisma, BOOKING_ID))!);
      return {
        posted,
        price: evaluation.identities.find((each) => each.identity === "PRICE")!,
        disagreements: evaluation.identities.filter((each) => each.status === "DISAGREE").map((each) => each.identity),
        integrity: evaluation.integrity,
      };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Capacity", lastName: "Shortfall", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4154 Lodge", slug: "race-4154" } });
    });

    beforeEach(async () => {
      resetStripeRaceHooks();
      await clean();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    });

    it("a partial plan: the card refunds what it carries, the rest is ONE task to check; marked paid back, the drifted charge is corrected and takes it - line, Xero note, audit, and the census agrees", async () => {
      await seed({ refundedCents: DRIFT_CENTS });
      const asked = stripeRefunds("make");

      expect((await capacityRace()).outcome).toBe("cancelled_refunded");
      expect(asked).toEqual([CHARGE_CENTS - DRIFT_CENTS]);
      const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID } });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        kind: "CANCELLED_BOOKING_HAND_BACK",
        status: "OPEN",
        occurrenceKey: CHECK_KEY,
        paymentId: PAYMENT_ID,
        amountCents: DRIFT_CENTS,
        raisedAmountCents: DRIFT_CENTS,
      });
      expect(tasks[0]!.reason).toContain("Check Stripe and the bank before paying");
      // Until it is closed, the member's page says the club will be in touch about it.
      expect(await memberPage()).toContain("$140.00 was refunded to your card on 1 Jul 2026; the club will be in touch about the remaining $60.00.");

      // The capture's success delivered again (a fresh event for the same intent), through the real webhook door:
      // the booking is cancelled, so it is acknowledged, refunds nothing more and writes no second task.
      const { processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service");
      const again = await processStripeWebhookEvent({
        id: "evt_race_4154_again",
        object: "event",
        type: "payment_intent.succeeded",
        request: null,
        data: { object: { id: INTENT, object: "payment_intent", amount: CHARGE_CENTS, amount_received: CHARGE_CENTS, currency: "nzd", status: "succeeded", payment_method: null, latest_charge: "ch_race_4154", metadata: { bookingId: BOOKING_ID } } },
      } as never);
      expect(again).toEqual({ body: { received: true } });
      expect(asked).toHaveLength(1);
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).toEqual({ status: "CANCELLED" });
      expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
      expect(await prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID, type: "REFUNDED" } })).toBe(1);
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(1);

      // The card refund was ADDED to the drifted total (a live refund, after the ledger started): the charge reads all of it refunded,
      // and the census reports the drift - the back-post will not confirm over a refunded total its refund rows do not make.
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: CARD_TXN }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CHARGE_CENTS });
      expect((await census("apply")).posted).toMatchObject({ kind: "CANNOT_POST", disagreements: [{ identity: "REFUNDED", deltaCents: DRIFT_CENTS }] });

      // Paid back by bank transfer: the charge corrected to its refund rows, then the task on it alone.
      await invoice();
      const reads = stripeShowsRefunded(CHARGE_CENTS - DRIFT_CENTS);
      await resolve("completed", tasks[0]!.id);
      expect(reads).toEqual([INTENT]);
      expect(await checkTask()).toMatchObject({ status: "COMPLETED", amountCents: DRIFT_CENTS });
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: CARD_TXN }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CHARGE_CENTS });
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CHARGE_CENTS });
      expect(await corrections()).toEqual([
        { category: "payment", entityId: CARD_TXN, metadata: expect.objectContaining({ refundedBeforeCents: CHARGE_CENTS, refundedAfterCents: CHARGE_CENTS - DRIFT_CENTS, manualRefundTaskId: tasks[0]!.id }) },
      ]);
      const handBackLines = await prisma.bookingLedgerLine.findMany({
        where: { bookingId: BOOKING_ID, postingKey: `handback:${tasks[0]!.id}` },
        select: { kind: true, amountCents: true },
      });
      expect(handBackLines).toEqual([{ kind: "BANK_REFUND", amountCents: -DRIFT_CENTS }]);
      expect(await taskRefundNotes()).toEqual([{ cents: DRIFT_CENTS, taskId: tasks[0]!.id }]);
      // The member's page counts the hand-back's REFUNDED event: the whole charge reads refunded.
      const page = await memberPage();
      expect(page).toContain("$200.00 was refunded on 1 Jul 2026.");
      expect(page).not.toContain("in touch");

      // #4147's census: confirmed now, and the completed task explains the rest.
      const after = await census("apply");
      expect(after.posted).toMatchObject({ kind: "POSTED" });
      expect(after.price).toMatchObject({ status: "AGREE", deltaCents: 0 });
      expect(after.disagreements).toEqual([]);
      expect(after.integrity).toEqual([]);
    });

    it("an empty plan whose records drifted: nothing by card, the whole charge to check; marked paid back, the charge is corrected and the whole $200.00 posts its line and its Xero note, and the census agrees", async () => {
      await seed({ refundedCents: CHARGE_CENTS });
      const asked = stripeRefunds("make");

      await capacityRace();
      expect(asked).toEqual([]);
      const task = await checkTask();
      expect(task).toMatchObject({ status: "OPEN", amountCents: CHARGE_CENTS });
      expect(await memberPage()).toContain("The club will be in touch about the $200.00.");

      await invoice();
      stripeShowsRefunded(0);
      await resolve("completed", task.id);
      expect(await checkTask()).toMatchObject({ status: "COMPLETED", amountCents: CHARGE_CENTS });
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: CARD_TXN }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CHARGE_CENTS });
      expect(await corrections()).toEqual([
        { category: "payment", entityId: CARD_TXN, metadata: expect.objectContaining({ refundedBeforeCents: CHARGE_CENTS, refundedAfterCents: 0, recordedCardRefundCents: 0 }) },
      ]);
      expect(await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" }, select: { amountCents: true } })).toEqual([{ amountCents: -CHARGE_CENTS }]);
      expect(await taskRefundNotes()).toEqual([{ cents: CHARGE_CENTS, taskId: task.id }]);
      const page = await memberPage();
      expect(page).toContain("$200.00 was refunded on 1 Jul 2026.");
      expect(page).not.toContain("in touch");

      const after = await census("apply");
      expect(after.posted).toMatchObject({ kind: "POSTED" });
      expect(after.price).toMatchObject({ status: "AGREE", deltaCents: 0 });
      expect(after.disagreements).toEqual([]);
      expect(after.integrity).toEqual([]);
    });

    it("MUTATION (PR #4159 F2/F4): a later intent's charge captured on the payment, holding plenty, is never the task's: the corrected race charge takes it", async () => {
      await seed({ refundedCents: DRIFT_CENTS });
      stripeRefunds("make");
      await capacityRace();
      await lateCharge(50_000);

      stripeShowsRefunded(CHARGE_CENTS - DRIFT_CENTS);
      await resolve("completed", (await checkTask()).id);
      expect(await prisma.paymentTransaction.findMany({ where: { paymentId: PAYMENT_ID }, orderBy: { id: "asc" }, select: { id: true, refundedAmountCents: true } })).toEqual([
        { id: CARD_TXN, refundedAmountCents: CHARGE_CENTS },
        { id: LATE_TXN, refundedAmountCents: 0 },
      ]);
    });

    it("the card refund still being sent: completion is refused, and nothing corrected, until the runner makes the race's refund", async () => {
      await seed({ refundedCents: DRIFT_CENTS });
      stripeRefunds("unreachable");

      expect((await capacityRace()).outcome).not.toBe("cancelled_refunded");
      const task = await checkTask();
      expect(task).toMatchObject({ status: "OPEN", amountCents: DRIFT_CENTS });

      stripeShowsRefunded(0);
      await expect(resolve("completed", task.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/still being refunded|waiting to retry/) });
      expect(await checkTask()).toMatchObject({ status: "OPEN" });
      expect(await corrections()).toEqual([]);
      expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" } })).toBe(0);

      // Its retry comes due and Stripe makes it; then the task can be marked.
      stripeRefunds("make");
      const raceRow = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: RACE_ROW_KEY } });
      await prisma.paymentRecoveryOperation.update({ where: { id: raceRow.id }, data: { nextRetryAt: new Date("2020-01-01T00:00:00.000Z") } });
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(raceRow.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      stripeShowsRefunded(CHARGE_CENTS - DRIFT_CENTS);
      await resolve("completed", task.id);
      expect(await checkTask()).toMatchObject({ status: "COMPLETED" });
      expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" } })).toBe(1);
      expect(await corrections()).toHaveLength(1);
    });

    it("MUTATION: a charge made before the refund ledger started is never corrected - refused naming why, nothing written, the later charge untouched; dismissed, the page says the club closed it", async () => {
      await seed({ refundedCents: CHARGE_CENTS, chargeMadeAt: new Date("2026-05-01T00:00:00.000Z") });
      stripeRefunds("make");
      await capacityRace();
      await lateCharge(50_000);
      await invoice();
      const task = await checkTask();

      stripeShowsRefunded(0);
      await expect(resolve("completed", task.id)).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/^The payment's records show too little of this card charge left to refund.*raise its refund credit note in Xero by hand.*the charge was made before the app kept a record of each card refund/),
      });
      expect(await checkTask()).toMatchObject({ status: "OPEN" });
      expect(await prisma.paymentTransaction.findMany({ where: { paymentId: PAYMENT_ID }, orderBy: { id: "asc" }, select: { id: true, refundedAmountCents: true } })).toEqual([
        { id: CARD_TXN, refundedAmountCents: CHARGE_CENTS },
        { id: LATE_TXN, refundedAmountCents: 0 },
      ]);
      expect(await corrections()).toEqual([]);
      expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" } })).toBe(0);

      await resolve("dismissed", task.id, "Refunded in the Stripe dashboard on 2 July.");
      expect(await checkTask()).toMatchObject({ status: "DISMISSED" });
      expect(await taskRefundNotes()).toEqual([]);
      const page = await memberPage();
      expect(page).toContain("The club checked the $200.00 and closed it.");
      expect(page).not.toContain("in touch");
    });
    it("#4154 review (M4): a race's payment with no Xero invoice - the usual case - completes, posts its line and queues no Xero note, and the census agrees", async () => {
      await seed({ refundedCents: CHARGE_CENTS });
      stripeRefunds("make");
      await capacityRace();
      const task = await checkTask();
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroInvoiceId: true } })).toEqual({ xeroInvoiceId: null });

      stripeShowsRefunded(0);
      await resolve("completed", task.id);
      expect(await checkTask()).toMatchObject({ status: "COMPLETED", amountCents: CHARGE_CENTS });
      expect(await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" }, select: { amountCents: true } })).toEqual([{ amountCents: -CHARGE_CENTS }]);
      expect(await taskRefundNotes()).toEqual([]);
      expect((await census("apply")).disagreements).toEqual([]);
    });

    it("MUTATION (review M1): a refund made in the Stripe dashboard whose webhook is late stops the completion until it is recorded - then the charge no longer holds the task, so the officer never pays it twice", async () => {
      await seed({ refundedCents: CHARGE_CENTS });
      stripeRefunds("make");
      await capacityRace();
      await invoice();
      const task = await checkTask();
      const nothingMoved = async () => {
        expect(await checkTask()).toMatchObject({ status: "OPEN" });
        expect(await corrections()).toEqual([]);
        expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" } })).toBe(0);
        expect(await taskRefundNotes()).toEqual([]);
      };

      stripeShowsRefunded(5_000);
      await expect(resolve("completed", task.id)).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/^Stripe shows \$50\.00 of this card charge refunded, but the app has recorded only \$0\.00/),
      });
      await nothingMoved();

      stripeShowsRefunded("unreachable");
      await expect(resolve("completed", task.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/^The app could not read this card charge's refunds from Stripe/) });
      await nothingMoved();

      // The late webhook arrives: its refund is recorded, and Stripe and the app now agree. The charge corrected to its
      // refund rows holds only $150.00 - less than the task - so the app refuses rather than record a second $50.00.
      await dashboardRefundRecorded("re_race_4154_dashboard", 5_000);
      stripeShowsRefunded(5_000);
      await expect(resolve("completed", task.id)).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("even corrected, the charge would not hold this amount"),
      });
      await nothingMoved();
    });

    /**
     * Runs `first` then `second` against a `Payment` row lock held by a third transaction, each started only once
     * the one before it is queued on that lock, then releases it: the lock's queue, not timing, decides the order.
     */
    async function queuedOnPaymentLock<A, B>(first: () => Promise<A>, second: () => Promise<B>) {
      const waiting = async (count: number) => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          if (Number(row!.n) >= count) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("race-4154: a writer never queued on the Payment row lock");
      };
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const blocker = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${PAYMENT_ID} FOR UPDATE`;
        held();
        await released;
      }, { timeout: 30_000 });
      await holding;
      const a = first().then((value) => ({ status: "fulfilled" as const, value }), (reason: unknown) => ({ status: "rejected" as const, reason }));
      await waiting(1);
      const b = second().then((value) => ({ status: "fulfilled" as const, value }), (reason: unknown) => ({ status: "rejected" as const, reason }));
      await waiting(2);
      release();
      await blocker;
      return [await a, await b] as const;
    }

    it.each(["completion", "sync"] as const)("MUTATION (review M7): a completion racing the refund sync recording a new refund on the race's charge, the %s first on the Payment row lock - the totals agree either way", async (firstOnLock) => {
      await seed({ refundedCents: CHARGE_CENTS });
      stripeRefunds("make");
      await capacityRace();
      await invoice();
      const task = await checkTask();
      stripeShowsRefunded(0);

      const complete = () => resolve("completed", task.id);
      const sync = () => dashboardRefundRecorded("re_race_4154_concurrent", 3_000);
      const [completion, synced] =
        firstOnLock === "completion" ? await queuedOnPaymentLock(complete, sync) : await queuedOnPaymentLock(sync, complete).then(([s, c]) => [c, s] as const);
      expect(synced.status).toBe("fulfilled");
      const charge = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: CARD_TXN }, select: { refundedAmountCents: true } });
      const paymentRow = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } });
      expect(paymentRow.refundedAmountCents).toBe(charge.refundedAmountCents);
      expect(charge.refundedAmountCents).toBe(CHARGE_CENTS);
      expect(await prisma.paymentRefund.count({ where: { paymentTransactionId: CARD_TXN, stripeRefundId: "re_race_4154_concurrent" } })).toBe(1);
      const lines = await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" } });
      if (firstOnLock === "completion") {
        // Corrected to nothing, the whole charge handed back; the sync's refund then capped at the charge - logged, and
        // (#4159 review round 2, F2) the officers alerted after the sync's commit, its claim the durable record.
        expect(completion.status).toBe("fulfilled");
        expect(await prisma.alertCooldown.count({ where: { key: { startsWith: `card-refund-cap-overflow:${CARD_TXN}:` } } })).toBe(1);
        expect(await checkTask()).toMatchObject({ status: "COMPLETED" });
        expect(await corrections()).toHaveLength(1);
        expect(lines).toBe(1);
      } else {
        // The sync's refund row is on the charge first, so even corrected the charge cannot hold the task. The drifted
        // total already read the whole charge refunded, so the sync's refund was capped too, and the officers told.
        expect(await prisma.alertCooldown.count({ where: { key: { startsWith: `card-refund-cap-overflow:${CARD_TXN}:` } } })).toBe(1);
        expect(completion).toMatchObject({ status: "rejected", reason: { status: 400, message: expect.stringContaining("even corrected, the charge would not hold this amount") } });
        expect(await checkTask()).toMatchObject({ status: "OPEN" });
        expect(await corrections()).toEqual([]);
        expect(lines).toBe(0);
      }
    });

    it("MUTATION (review M7): two completions of one task at once - exactly one wins; one correction, one line, one Xero note", async () => {
      await seed({ refundedCents: CHARGE_CENTS });
      stripeRefunds("make");
      await capacityRace();
      await invoice();
      const task = await checkTask();
      stripeShowsRefunded(0);

      const outcomes = await Promise.allSettled([resolve("completed", task.id), resolve("completed", task.id)]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const [lost] = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      expect(lost!.reason).toMatchObject({ status: 409 });
      expect(await checkTask()).toMatchObject({ status: "COMPLETED", amountCents: CHARGE_CENTS });
      expect(await corrections()).toHaveLength(1);
      expect(await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" }, select: { amountCents: true } })).toEqual([{ amountCents: -CHARGE_CENTS }]);
      expect(await taskRefundNotes()).toEqual([{ cents: CHARGE_CENTS, taskId: task.id }]);
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: CARD_TXN }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CHARGE_CENTS });
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CHARGE_CENTS });
    });
    /**
     * #4154 review: the nightly self-heal's card note, queued for the race's stray refunded total while the task is
     * OPEN, and not yet sent when the task is marked paid back. Queued through the real self-heal (the payment backdated
     * past its grace window), as the cron does it.
     */
    async function selfHealQueuesCardNote(): Promise<string> {
      await prisma.$executeRaw`UPDATE "Payment" SET "updatedAt" = '2020-01-01T00:00:00Z' WHERE "id" = ${PAYMENT_ID}`;
      const { reconcileCreditBalances } = await import("@/lib/cron-credit-reconciliation");
      await reconcileCreditBalances();
      const cardNotes = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE", status: "PENDING" },
        select: { id: true, requestPayload: true },
      });
      const card = cardNotes.filter(({ requestPayload }) => ((requestPayload ?? {}) as Record<string, unknown>).paidAnotherWayTaskId == null);
      expect(card.map(({ requestPayload }) => ((requestPayload ?? {}) as Record<string, unknown>).refundAmountCents)).toEqual([CHARGE_CENTS]);
      return card[0]!.id;
    }

    /** The payment's refund-note coverage in Xero, as every note's send-time cap reads it. */
    async function xeroCoverage(): Promise<number> {
      const { readResolvedRefundCreditNoteCoverage, sumRefundCreditNoteCoverageCents } = await import("@/lib/xero-resolved-in-xero-fences");
      return sumRefundCreditNoteCoverageCents(PAYMENT_ID, await readResolvedRefundCreditNoteCoverage(PAYMENT_ID, prisma), prisma);
    }

    /** One real worker pass on this row, preserving the chronology of both owned notes. */
    async function outboxSends(operationId: string) {
      await assertNoForeignPendingXeroOperations(prisma, [PAYMENT_ID, BOOKING_ID]);
      const parked = await prisma.xeroSyncOperation.findMany({
        where: { status: "PENDING", localId: { in: [PAYMENT_ID, BOOKING_ID] }, id: { not: operationId } },
        select: { id: true },
      });
      await prisma.xeroSyncOperation.updateMany({ where: { id: { in: parked.map((row) => row.id) } }, data: { status: "PARKED_RACE_4154" } });
      try {
        const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
        expect(await processQueuedXeroOutboxOperations({ limit: 1 })).toMatchObject({ processed: 1 });
      } finally {
        await prisma.xeroSyncOperation.updateMany({ where: { id: { in: parked.map((row) => row.id) } }, data: { status: "PENDING" } });
      }
      return prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true, responsePayload: true } });
    }

    it("MUTATION (review): the self-heal's card note queued but unsent, then the task marked paid back - sent first, the card note bills nothing; the task's note is sized at the whole charge, so Xero holds X, never 2X", async () => {
      await seed({ refundedCents: CHARGE_CENTS });
      stripeRefunds("make");
      await capacityRace();
      await invoice();
      const task = await checkTask();
      const cardNoteId = await selfHealQueuesCardNote();

      // Queued, not sent: nothing covers the payment yet, so the completion's Xero-note guard lets it through.
      expect(await xeroCoverage()).toBe(0);
      stripeShowsRefunded(0);
      await resolve("completed", task.id);
      expect(await taskRefundNotes()).toEqual([{ cents: CHARGE_CENTS, taskId: task.id }]);

      // The outbox sends oldest first: the card note. At send time the task's paid-back cash is answered by its own
      // note, so the card note's cap is zero - it completes without billing Xero (no Xero connection exists here, so
      // any attempt to bill would fail the row).
      expect(await outboxSends(cardNoteId)).toMatchObject({ status: "SUCCEEDED", responsePayload: expect.objectContaining({ skippedNothingUncovered: true }) });
      expect(await xeroCoverage()).toBe(0);
      // The task's own note is sized by its record alone: the whole charge.
      const { readPaidAnotherWayCloseShare } = await import("@/lib/card-refund-paid-another-way-cash");
      expect(await readPaidAnotherWayCloseShare(prisma, PAYMENT_ID, task.id)).toMatchObject({ uncoveredCents: CHARGE_CENTS });
      // And the self-heal, run again, asks for no second card note.
      await prisma.$executeRaw`UPDATE "Payment" SET "updatedAt" = '2020-01-01T00:00:00Z' WHERE "id" = ${PAYMENT_ID}`;
      const { reconcileCreditBalances } = await import("@/lib/cron-credit-reconciliation");
      await reconcileCreditBalances();
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, entityType: "CREDIT_NOTE", status: "PENDING" } })).toBe(1);
    });

    it("MUTATION (review): the other order - the task's note in Xero first, then the queued card note sent - the card note bills nothing and Xero's coverage is X", async () => {
      await seed({ refundedCents: CHARGE_CENTS });
      stripeRefunds("make");
      await capacityRace();
      await invoice();
      const task = await checkTask();
      const cardNoteId = await selfHealQueuesCardNote();
      stripeShowsRefunded(0);
      await resolve("completed", task.id);

      // The task's note raised in Xero, recorded as its send records one: its row names the note, and the note's active link covers it.
      const taskNote = await prisma.xeroSyncOperation.findFirstOrThrow({
        where: { localId: PAYMENT_ID, entityType: "CREDIT_NOTE", requestPayload: { path: ["paidAnotherWayTaskId"], equals: task.id } },
        select: { id: true },
      });
      await prisma.xeroSyncOperation.update({ where: { id: taskNote.id }, data: { status: "SUCCEEDED", xeroObjectId: "race-4154-cn-task", completedAt: new Date() } });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "race-4154-cn-task", role: "REFUND_CREDIT_NOTE", active: true,
          metadata: { amountCents: CHARGE_CENTS, watermarkCents: CHARGE_CENTS },
        },
      });
      expect(await xeroCoverage()).toBe(CHARGE_CENTS);

      expect(await outboxSends(cardNoteId)).toMatchObject({ status: "SUCCEEDED" });
      expect(await prisma.xeroObjectLink.count({ where: { localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", active: true } })).toBe(1);
      expect(await xeroCoverage()).toBe(CHARGE_CENTS);
    });
    it("MUTATION (round 2 F1): the self-heal's card note already SENT for the stray total before the task is marked paid back - the completion goes ahead, posts its line, raises no second note, Xero holds X, and the census agrees", async () => {
      await seed({ refundedCents: CHARGE_CENTS });
      stripeRefunds("make");
      await capacityRace();
      await invoice();
      const task = await checkTask();
      const cardNoteId = await selfHealQueuesCardNote();
      // The card note raised in Xero, recorded as its send records one: its row names the note, its active link covers it.
      await prisma.xeroSyncOperation.update({ where: { id: cardNoteId }, data: { status: "SUCCEEDED", xeroObjectId: "race-4154-cn-card", completedAt: new Date() } });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "race-4154-cn-card", role: "REFUND_CREDIT_NOTE", active: true,
          metadata: { amountCents: CHARGE_CENTS, watermarkCents: CHARGE_CENTS },
        },
      });
      expect(await xeroCoverage()).toBe(CHARGE_CENTS);

      stripeShowsRefunded(0);
      await resolve("completed", task.id);
      expect(await checkTask()).toMatchObject({ status: "COMPLETED", amountCents: CHARGE_CENTS, reviewContext: { paidAnotherWayCardNoteCover: CHARGE_CENTS } });
      expect(await corrections()).toEqual([{ category: "payment", entityId: CARD_TXN, metadata: expect.objectContaining({ refundedAfterCents: 0, cardNoteCoversCents: CHARGE_CENTS }) }]);
      expect(await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" }, select: { amountCents: true } })).toEqual([{ amountCents: -CHARGE_CENTS }]);
      // The card note answers the hand-back's money: the task queues no note of its own, and Xero holds X, never 2X.
      expect(await taskRefundNotes()).toEqual([]);
      expect(await xeroCoverage()).toBe(CHARGE_CENTS);
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, entityType: "CREDIT_NOTE", status: "PENDING" } })).toBe(0);
      // The self-heal, run again, finds nothing uncovered.
      await prisma.$executeRaw`UPDATE "Payment" SET "updatedAt" = '2020-01-01T00:00:00Z' WHERE "id" = ${PAYMENT_ID}`;
      const { reconcileCreditBalances } = await import("@/lib/cron-credit-reconciliation");
      await reconcileCreditBalances();
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, entityType: "CREDIT_NOTE", status: "PENDING" } })).toBe(0);
      const after = await census("apply");
      expect(after.price).toMatchObject({ status: "AGREE", deltaCents: 0 });
      expect(after.disagreements).toEqual([]);
      expect(after.integrity).toEqual([]);
    });
    it("MUTATION (round 3): a card note already sent for part of the stray total - the task keeps that cover and its own note bills only the rest", async () => {
      await seed({ refundedCents: CHARGE_CENTS });
      stripeRefunds("make");
      await capacityRace();
      await invoice();
      const task = await checkTask();
      const PART_CENTS = 12_000;
      // A card note for $120.00 already in Xero on the payment (its row and active link, as a send records them).
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID, status: "SUCCEEDED",
          queueType: "REFUND_CREDIT_NOTE", xeroObjectId: "race-4154-cn-part", completedAt: new Date(),
          idempotencyKey: "race-4154-cn-part", correlationKey: "race-4154-cn-part", requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: PART_CENTS },
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "race-4154-cn-part", role: "REFUND_CREDIT_NOTE", active: true,
          metadata: { amountCents: PART_CENTS, watermarkCents: PART_CENTS },
        },
      });
      expect(await xeroCoverage()).toBe(PART_CENTS);

      stripeShowsRefunded(0);
      await resolve("completed", task.id);
      expect(await checkTask()).toMatchObject({ status: "COMPLETED", amountCents: CHARGE_CENTS, reviewContext: { paidAnotherWayCardNoteCover: PART_CENTS } });
      expect(await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" }, select: { amountCents: true } })).toEqual([{ amountCents: -CHARGE_CENTS }]);
      // The task's own note is the task less the card note's cover: $200.00 - $120.00.
      expect(await taskRefundNotes()).toEqual([{ cents: CHARGE_CENTS - PART_CENTS, taskId: task.id }]);
    });
  },
);
