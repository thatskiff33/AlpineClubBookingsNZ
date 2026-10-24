/**
 * Real-PostgreSQL proof of #4097 (`INV-PAY-129`): an own-card cancel whose
 * frozen card refund plan carries less than the refund due owes the rest by
 * hand.
 *
 * What a mock can only imitate, run here against the database through the REAL
 * `cancelBooking` and `resolveManualRefundTask`:
 *
 * - A partial plan (a $60.00 part of the payment the card cannot refund): the
 *   card refunds $140.00, and the claim's own transaction writes ONE
 *   `CANCELLED_BOOKING_HAND_BACK` for $60.00 under its key - passing every
 *   `ManualRefundTask` CHECK - which "Refunds owed" and Net Collected count. A
 *   re-driven cancel is refused and writes no second one. Marked paid back, it records the
 *   refund on the payment and posts its `BANK_REFUND` line on the card payment,
 *   and stops being owed.
 *   Its Xero refund note is ONE bank-transfer note for exactly the task's
 *   amount, keyed on the task, which a replay does not repeat and no card note
 *   (the self-heal's gap) may answer - with Stripe refund rows on the payment,
 *   and (a third case) with none.
 * - The card part still being refunded: the cancel's card refund refused
 *   inline, the shortfall's completion is refused until the retry makes it,
 *   and the final figures match the order where the card refund was made
 *   inline.
 * - A zero plan (the payment's ledger reads the card refunded, its record does
 *   not): no Stripe call, the whole refund raised as owed. It cannot be marked
 *   paid back against a ledger with nothing left on it, so the treasurer
 *   dismisses it with a note, and it stops being owed.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4097-` fixtures. No Stripe call is made: the cancel's refund goes to the
 * harness's one shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4097-member";
const LODGE_ID = "race-4097-lodge";
const BOOKING_ID = "race-4097-booking";
const PAYMENT_ID = "race-4097-payment";
const CARD_TXN = "race-4097-txn-card";
const BANK_TXN = "race-4097-txn-bank";
const INTENT = "pi_race_4097";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const PRICE_CENTS = 20_000;
const CARD_CENTS = 14_000;
const BANK_CENTS = 6_000;
const TASK_KEY = `cancel-card-shortfall:${BOOKING_ID}`;
const CHECK_KEY = `${TASK_KEY}:check`;
const XERO_INVOICE_ID = "race-4097-invoice";

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Card refund shortfall proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run card refund shortfall proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Card refund shortfall proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Card refund shortfall proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "a cancel's card refund shortfall is owed by hand - real PostgreSQL (#4097)",
  { timeout: 60_000 },
  () => {
    async function deleteBookingRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** The payment's owed-back parts, as Net Collected reads them. */
    async function handBackOwedNow(): Promise<number> {
      const { netCollectedPaymentSelect } = await import("@/lib/additional-ledger-gap");
      const { getNetCollectedPaymentParts } = await import("@/lib/payment-net-collected");
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: netCollectedPaymentSelect });
      return getNetCollectedPaymentParts(payment).handBackOwedCents;
    }

    async function refundsOwedNow(): Promise<number> {
      const { readRefundsAndCreditsOwed } = await import("@/lib/refunds-and-credits-owed");
      return (await readRefundsAndCreditsOwed(prisma)).refundsOwedCents;
    }

    /** Every refund credit note queued on the payment: its amount and the record it answers, if any. */
    async function refundNotes(): Promise<Array<{ cents: unknown; taskId: unknown }>> {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE" },
        select: { requestPayload: true },
      });
      // Sorted here, never by `createdAt`: under the frozen test clock two rows
      // queued in one run carry the same stamp, so the database's order is not
      // stable (it reddened the race harness once in five runs).
      return rows
        .map(({ requestPayload }) => {
          const payload = (requestPayload ?? {}) as Record<string, unknown>;
          return { cents: payload.refundAmountCents, taskId: payload.paidAnotherWayTaskId ?? null };
        })
        .sort((a, b) => Number(a.taskId !== null) - Number(b.taskId !== null) || Number(a.cents) - Number(b.cents));
    }

    /**
     * The payment's refund-note gap as the nightly self-heal and the repair tool
     * read it: what a CARD note may still answer is the gap less the bank cash
     * the task's own note answers (`paidAnotherWayUncoveredCents`).
     */
    async function cardNoteGapNow(): Promise<{ cardCents: number; bankCents: number }> {
      const { readRefundCreditNoteGap } = await import("@/lib/xero-admin-health");
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { id: true, bookingId: true, refundedAmountCents: true } });
      const gap = await readRefundCreditNoteGap(payment);
      return { cardCents: gap.uncoveredCents - gap.paidAnotherWayUncoveredCents, bankCents: gap.paidAnotherWayUncoveredCents };
    }

    async function cancel() {
      const { cancelBooking } = await import("@/lib/booking-cancel");
      return cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
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

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Short",
          lastName: "Plan",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4097 Lodge", slug: "race-4097" } });
      // One tier, all of it back: the cancellation's refund is the whole $200.00.
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
    });

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deleteBookingRows();
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "PAID",
          totalPriceCents: PRICE_CENTS,
          finalPriceCents: PRICE_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PRICE_CENTS,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: INTENT,
          // An invoice the refund notes credit (Xero is not connected here: notes are only queued).
          xeroInvoiceId: XERO_INVOICE_ID,
        },
      });
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it("a partial plan: the card refunds what it carries, and the rest is ONE task, owed until it is paid back by bank transfer", async () => {
      // $140.00 by card and a $60.00 part the card cannot refund (taken by bank transfer).
      await prisma.paymentTransaction.createMany({
        data: [
          { id: CARD_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT, amountCents: CARD_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
          { id: BANK_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "INTERNET_BANKING", amountCents: BANK_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
        ],
      });
      const asked: number[] = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.amountCents);
        return {
          id: "re_race_4097",
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: "ch_race_4097",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      const owedBefore = await refundsOwedNow();

      const result = await cancel();

      expect(result.status).toBe(200);
      expect(result).toMatchObject({ data: { refundAmountCents: PRICE_CENTS, ownCardRefund: { method: "card", amountCents: CARD_CENTS, byHandCents: BANK_CENTS } } });
      expect(asked).toEqual([CARD_CENTS]);
      const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID } });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        kind: "CANCELLED_BOOKING_HAND_BACK",
        status: "OPEN",
        occurrenceKey: TASK_KEY,
        paymentId: PAYMENT_ID,
        amountCents: BANK_CENTS,
        raisedAmountCents: BANK_CENTS,
      });
      expect(await handBackOwedNow()).toBe(BANK_CENTS);
      expect((await refundsOwedNow()) - owedBefore).toBe(BANK_CENTS);

      // A re-driven cancel is refused (the booking is cancelled) and writes nothing.
      expect((await cancel()).status).not.toBe(200);
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(1);

      // Paid back by bank transfer: on the payment, on the ledger, and owed nowhere.
      await resolve("completed", tasks[0]!.id);
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: tasks[0]!.id }, select: { status: true } })).toEqual({ status: "COMPLETED" });
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: PRICE_CENTS });
      const handBackLines = await prisma.bookingLedgerLine.findMany({
        where: { bookingId: BOOKING_ID, postingKey: `handback:${tasks[0]!.id}` },
        select: { kind: true, amountCents: true, settlementMethod: true },
      });
      expect(handBackLines).toEqual([{ kind: "BANK_REFUND", amountCents: -BANK_CENTS, settlementMethod: "INTERNET_BANKING" }]);
      expect(await handBackOwedNow()).toBe(0);
      expect(await refundsOwedNow()).toBe(owedBefore);
      // The booking page reads the part's status for its narrative.
      const { readCardShortfallTaskStatuses } = await import("@/lib/cancel-card-refund-shortfall-status");
      expect(await readCardShortfallTaskStatuses(BOOKING_ID)).toEqual({ bank: "COMPLETED", card: "settled" });

      // Xero: the card's own note from the cancel, and ONE bank-transfer note
      // for exactly the task's amount, keyed on the task - nothing payment-wide.
      expect(await refundNotes()).toEqual([
        { cents: CARD_CENTS, taskId: null },
        { cents: BANK_CENTS, taskId: tasks[0]!.id },
      ]);
      // A replay of the task's note, and of a completion, queues none.
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, BANK_CENTS, { refundMethod: "internet-banking", paidAnotherWayTaskId: tasks[0]!.id });
      await expect(resolve("completed", tasks[0]!.id)).rejects.toMatchObject({ status: 409 });
      expect(await refundNotes()).toHaveLength(2);
      // With Stripe refund rows on the payment, a card note may answer only the
      // card's $140.00 (already queued by the cancel); the bank $60.00 is the
      // task's own note's alone.
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBeGreaterThan(0);
      expect(await cardNoteGapNow()).toEqual({ cardCents: CARD_CENTS, bankCents: BANK_CENTS });
    });

    it("no Stripe refund rows (a zero plan whose remainder sits on a bank-paid part): ONE note for the task, and no card note may answer it", async () => {
      // $140.00 by card, refunded before the ledger kept refund rows; a $60.00
      // part the card cannot refund. The policy's refund is the $60.00 left.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: CARD_CENTS, status: "PARTIALLY_REFUNDED" } });
      await prisma.paymentTransaction.createMany({
        data: [
          { id: CARD_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT, amountCents: CARD_CENTS, refundedAmountCents: CARD_CENTS, status: "REFUNDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
          { id: BANK_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "INTERNET_BANKING", amountCents: BANK_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
        ],
      });
      stripeRaceHooks.refund = async () => {
        throw new Error("no card refund may be asked for on a zero plan");
      };

      expect(await cancel()).toMatchObject({ status: 200, data: { ownCardRefund: { amountCents: 0, byHandCents: BANK_CENTS } } });
      const task = await prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: TASK_KEY } });
      expect(task).toMatchObject({ amountCents: BANK_CENTS });

      await resolve("completed", task.id);

      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
      expect(await refundNotes()).toEqual([{ cents: BANK_CENTS, taskId: task.id }]);
      // On the legacy mirror, a card note may answer only the earlier card
      // refund's $140.00, never the bank transfer the task's own note answers.
      expect(await cardNoteGapNow()).toEqual({ cardCents: CARD_CENTS, bankCents: BANK_CENTS });
    });

    it("a zero plan: no card refund, the whole refund owed; with nothing left on the ledger it is dismissed with a note, and owed no more", async () => {
      // The ledger reads the charge refunded; the payment record does not.
      await prisma.paymentTransaction.create({
        data: { id: CARD_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT, amountCents: PRICE_CENTS, refundedAmountCents: PRICE_CENTS, status: "REFUNDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
      });
      let asked = 0;
      stripeRaceHooks.refund = async () => {
        asked += 1;
        throw new Error("no card refund may be asked for on a zero plan");
      };
      const owedBefore = await refundsOwedNow();

      const result = await cancel();

      expect(result.status).toBe(200);
      expect(result).toMatchObject({ data: { ownCardRefund: { method: "card", amountCents: 0 } } });
      expect(asked).toBe(0);
      // Nothing holds it: a part to check, never a bank transfer promised.
      expect(result).toMatchObject({ data: { ownCardRefund: { toCheckCents: PRICE_CENTS }, message: expect.stringContaining("The club will be in touch about the $200.00 refund.") } });
      const task = await prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: CHECK_KEY } });
      expect(task).toMatchObject({ status: "OPEN", amountCents: PRICE_CENTS });
      expect((await refundsOwedNow()) - owedBefore).toBe(PRICE_CENTS);

      // Nothing on the ledger to record it against: refused, still OPEN, and told to dismiss it.
      await expect(resolve("completed", task.id)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/dismiss this task with a note/) });
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })).toEqual({ status: "OPEN" });

      await resolve("dismissed", task.id, "Refunded in the Stripe dashboard on 2 July.");
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })).toEqual({ status: "DISMISSED" });
      expect(await refundsOwedNow()).toBe(owedBefore);
    });

    // #4097 (coordinator decision 2 on PR #4122): a shortfall's completion
    // waits for the card part. Whichever order the card refund and the
    // treasurer's completion run in, the figures end the same.
    describe("the card part still being refunded", () => {
      /** Stripe's answer: refused on the first ask when `refuseFirst`, made after. */
      function stripeAnswers(refuseFirst: boolean) {
        let asked = 0;
        stripeRaceHooks.refund = async (args) => {
          asked += 1;
          return {
            id: `re_race_4097_${asked}`,
            object: "refund",
            amount: args.amountCents,
            currency: "nzd",
            status: refuseFirst && asked === 1 ? "failed" : "succeeded",
            reason: "requested_by_customer",
            created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
            charge: "ch_race_4097",
            payment_intent: args.paymentIntentId,
            metadata: args.metadata ?? {},
          };
        };
      }

      async function finalFigures() {
        const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } });
        const txns = await prisma.paymentTransaction.findMany({ where: { paymentId: PAYMENT_ID }, orderBy: { id: "asc" }, select: { id: true, refundedAmountCents: true } });
        const task = await prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: TASK_KEY }, select: { status: true, amountCents: true } });
        const cardRefunds = await prisma.paymentRefund.findMany({ where: { paymentId: PAYMENT_ID, status: "succeeded" }, select: { amountCents: true } });
        const bankLine = await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" }, select: { amountCents: true } });
        const notes = (await refundNotes()).filter((note) => note.taskId !== null).map((note) => note.cents);
        return { payment, txns, task, cardRefunds, bankLine, notes };
      }

      it.each([
        ["the card refund is refused inline, completion waits, the retry makes it, then completion", true],
        ["the card refund is made inline, then completion", false],
      ])("%s: the same final figures", async (_label, refuseFirst) => {
        await prisma.paymentTransaction.createMany({
          data: [
            { id: CARD_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT, amountCents: CARD_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
            { id: BANK_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "INTERNET_BANKING", amountCents: BANK_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
          ],
        });
        stripeAnswers(refuseFirst);
        expect((await cancel()).status).toBe(200);
        const task = await prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: TASK_KEY } });
        const cardRefund = () =>
          prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: `booking_cancel_refund_recovery_${BOOKING_ID}` } });

        if (refuseFirst) {
          expect(await cardRefund()).toMatchObject({ status: "PENDING" });
          // The card part is still owed: the shortfall cannot be marked yet, and nothing moved.
          // Refused inline, so it says to wait for the retry.
          await expect(resolve("completed", task.id)).rejects.toMatchObject({
            status: 409,
            message: expect.stringMatching(/failed and is waiting to retry: wait for its retry to go through, then mark this/),
          });
          const { readCardShortfallTaskStatuses } = await import("@/lib/cancel-card-refund-shortfall-status");
          expect(await readCardShortfallTaskStatuses(BOOKING_ID)).toEqual({ bank: "OPEN", card: "on-its-way" });
          expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })).toEqual({ status: "OPEN" });
          // The card retry makes it.
          const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
          expect(await runPaymentRecoveryOperationNow((await cardRefund()).id, CLUB_FORMAT_TEST)).toBe("succeeded");
        }
        expect(await cardRefund()).toMatchObject({ status: "SUCCEEDED" });

        await resolve("completed", task.id);

        expect(await finalFigures()).toEqual({
          payment: { refundedAmountCents: PRICE_CENTS },
          txns: [
            { id: BANK_TXN, refundedAmountCents: BANK_CENTS },
            { id: CARD_TXN, refundedAmountCents: CARD_CENTS },
          ],
          task: { status: "COMPLETED", amountCents: BANK_CENTS },
          cardRefunds: [{ amountCents: CARD_CENTS }],
          bankLine: [{ amountCents: -BANK_CENTS }],
          notes: [BANK_CENTS],
        });
      });
    });

    // #4119: the cancel preview sizes the card line from the same plan and the
    // same split, read without writing. Asked first, with the refund the cancel
    // then computes, it must quote exactly what the cancel then does.
    describe("the cancel preview quotes what the cancel does (#4119)", () => {
      const at = (day: string) => new Date(`${day}T00:00:00.000Z`);
      it.each([
        {
          shape: "a bank-paid part the card cannot refund",
          payment: {},
          ledger: [
            { id: CARD_TXN, kind: "PRIMARY" as const, source: "STRIPE" as const, stripePaymentIntentId: INTENT, amountCents: CARD_CENTS, refundedAmountCents: 0, status: "SUCCEEDED" as const, createdAt: at("2026-05-01") },
            { id: BANK_TXN, kind: "ADDITIONAL" as const, source: "INTERNET_BANKING" as const, amountCents: BANK_CENTS, refundedAmountCents: 0, status: "SUCCEEDED" as const, createdAt: at("2026-06-01") },
          ],
          due: PRICE_CENTS,
          split: { cardCents: CARD_CENTS, bankCents: BANK_CENTS, checkCents: 0 },
        },
        {
          shape: "both parts",
          payment: {},
          ledger: [
            { id: CARD_TXN, kind: "PRIMARY" as const, source: "STRIPE" as const, stripePaymentIntentId: INTENT, amountCents: CARD_CENTS, refundedAmountCents: 0, status: "SUCCEEDED" as const, createdAt: at("2026-05-01") },
            { id: BANK_TXN, kind: "ADDITIONAL" as const, source: "INTERNET_BANKING" as const, amountCents: 2_000, refundedAmountCents: 0, status: "SUCCEEDED" as const, createdAt: at("2026-06-01") },
          ],
          due: PRICE_CENTS,
          split: { cardCents: CARD_CENTS, bankCents: 2_000, checkCents: 4_000 },
        },
        {
          // The record shows $30.00 refunded that no ledger row does. The
          // cancel's claim folds it onto the oldest captured row - the card -
          // before it plans; unfolded, the preview would quote the card $140.00.
          shape: "a partly refunded record the ledger does not show, folded first",
          payment: { status: "PARTIALLY_REFUNDED" as const, refundedAmountCents: 3_000 },
          ledger: [
            { id: CARD_TXN, kind: "PRIMARY" as const, source: "STRIPE" as const, stripePaymentIntentId: INTENT, amountCents: CARD_CENTS, refundedAmountCents: 0, status: "SUCCEEDED" as const, createdAt: at("2026-05-01") },
            { id: BANK_TXN, kind: "ADDITIONAL" as const, source: "INTERNET_BANKING" as const, amountCents: BANK_CENTS, refundedAmountCents: 0, status: "SUCCEEDED" as const, createdAt: at("2026-06-01") },
          ],
          due: PRICE_CENTS - 3_000,
          split: { cardCents: CARD_CENTS - 3_000, bankCents: BANK_CENTS, checkCents: 0 },
        },
        {
          shape: "a zero plan",
          payment: {},
          ledger: [
            { id: CARD_TXN, kind: "PRIMARY" as const, source: "STRIPE" as const, stripePaymentIntentId: INTENT, amountCents: PRICE_CENTS, refundedAmountCents: PRICE_CENTS, status: "REFUNDED" as const, createdAt: at("2026-05-01") },
          ],
          due: PRICE_CENTS,
          split: { cardCents: 0, bankCents: 0, checkCents: PRICE_CENTS },
        },
        {
          // No ledger rows: read as the backfill would write them, which the
          // preview must not do - the cancel's own backfill would then collide
          // with it on the intent id.
          shape: "a pre-ledger payment the card carries",
          payment: {},
          ledger: [],
          due: PRICE_CENTS,
          split: null,
        },
      ])("$shape", async ({ payment, ledger, due, split }) => {
        if (Object.keys(payment).length > 0) await prisma.payment.update({ where: { id: PAYMENT_ID }, data: payment });
        if (ledger.length > 0) await prisma.paymentTransaction.createMany({ data: ledger.map((row) => ({ ...row, paymentId: PAYMENT_ID })) });
        stripeRaceHooks.refund = async (args) => ({
          id: "re_race_4119", object: "refund", amount: args.amountCents, currency: "nzd", status: "succeeded",
          reason: "requested_by_customer", created: Math.floor(Date.UTC(2026, 6, 1) / 1000), charge: "ch_race_4119",
          payment_intent: args.paymentIntentId, metadata: args.metadata ?? {},
        });
        const ledgerNow = () => prisma.paymentTransaction.findMany({ where: { paymentId: PAYMENT_ID }, orderBy: { id: "asc" }, select: { id: true, refundedAmountCents: true } });
        const before = await ledgerNow();

        const { cancelPreviewCardShortfall } = await import("@/lib/cancel-card-refund-shortfall-preview");
        const fresh = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { id: true, source: true, manuallyMarkedPaidAt: true } });
        const quoted = await cancelPreviewCardShortfall(prisma, { payment: fresh, organiserCard: false, organiserByBank: false, refundAmountCents: due });
        expect(quoted.cardShortfall ?? null).toEqual(split);
        // The preview wrote nothing: no backfill, no fold.
        expect(await ledgerNow()).toEqual(before);

        const result = await cancel();
        expect(result).toMatchObject({ status: 200, data: { refundAmountCents: due } });
        const own = (result as unknown as { data: { ownCardRefund: { amountCents: number; byHandCents?: number; toCheckCents?: number } } }).data.ownCardRefund;
        expect({ cardCents: own.amountCents, bankCents: own.byHandCents ?? 0, checkCents: own.toCheckCents ?? 0 }).toEqual(split ?? { cardCents: due, bankCents: 0, checkCents: 0 });
        const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID }, select: { occurrenceKey: true, amountCents: true } });
        expect(Object.fromEntries(tasks.map((task) => [task.occurrenceKey, task.amountCents]))).toEqual({
          ...(split?.bankCents ? { [TASK_KEY]: split.bankCents } : {}),
          ...(split?.checkCents ? { [CHECK_KEY]: split.checkCents } : {}),
        });
      });
    });

    // Round 4 (coordinator decision 1): a part to check settles only on what
    // its bank-transfer part leaves, so it waits for that part.
    it("both parts: check-then-bank is refused, bank-then-check settles both", async () => {
      const LATE_TXN = "race-4097-txn-late";
      await prisma.paymentTransaction.createMany({
        data: [
          { id: CARD_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT, amountCents: CARD_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
          { id: BANK_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "INTERNET_BANKING", amountCents: 2_000, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
        ],
      });
      stripeRaceHooks.refund = async (args) => ({
        id: "re_race_4097_both", object: "refund", amount: args.amountCents, currency: "nzd", status: "succeeded",
        reason: "requested_by_customer", created: Math.floor(Date.UTC(2026, 6, 1) / 1000), charge: "ch_race_4097",
        payment_intent: args.paymentIntentId, metadata: args.metadata ?? {},
      });

      expect(await cancel()).toMatchObject({ status: 200, data: { ownCardRefund: { amountCents: CARD_CENTS, byHandCents: 2_000, toCheckCents: 4_000 } } });
      const bank = await prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: TASK_KEY } });
      const check = await prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: CHECK_KEY } });
      expect([bank.amountCents, check.amountCents]).toEqual([2_000, 4_000]);
      // The check finds the rest really is owed, and a later bank receipt now holds it.
      await prisma.paymentTransaction.create({
        data: { id: LATE_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "INTERNET_BANKING", amountCents: 4_000, status: "SUCCEEDED", createdAt: new Date("2026-06-20T00:00:00.000Z") },
      });

      // Check first: refused, and nothing moved.
      await expect(resolve("completed", check.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/^Mark the bank-transfer part of this cancellation's refund first/) });
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CARD_CENTS });

      // Bank, then check: both settle, on the non-card charges.
      await resolve("completed", bank.id);
      await resolve("completed", check.id);
      expect(await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID }, orderBy: { occurrenceKey: "asc" }, select: { status: true } })).toEqual([
        { status: "COMPLETED" },
        { status: "COMPLETED" },
      ]);
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: PRICE_CENTS });
      const nonCard = await prisma.paymentTransaction.findMany({ where: { paymentId: PAYMENT_ID, source: "INTERNET_BANKING" }, select: { refundedAmountCents: true } });
      expect(nonCard.reduce((sum, row) => sum + row.refundedAmountCents, 0)).toBe(6_000);
      const { readCardShortfallTaskStatuses } = await import("@/lib/cancel-card-refund-shortfall-status");
      expect(await readCardShortfallTaskStatuses(BOOKING_ID)).toEqual({ bank: "COMPLETED", check: "COMPLETED", card: "settled" });
    });
  },
);
