/**
 * Real-PostgreSQL proof of #4210 (`INV-PAY-142`; owner, #4361 decision 4:
 * "never re-send automatically; hold it for an officer, with an alert").
 *
 * The bug, through the real writers: a card refund row's runner asks Stripe for
 * refund X and the answer is lost; the treasurer closes the row "Paid another
 * way" (`closeCardRefundPaidAnotherWay`) and pays the member by bank; the
 * `charge.refunded` sync records X late; Stripe then fails X
 * (`recordRefusedCardRefund`). The failed-later writer (`INV-PAY-128`) raised a
 * row for X that the runner sent again automatically - the member paid twice.
 *
 * Proven here, each through the real close, sync, refusal writer and runner:
 *
 * - after a full or a part close, X's row is raised HELD - its attempts spent,
 *   so the runner never claims it and Stripe is never asked - and the officers
 *   are alerted once, told to settle it with "Paid another way", never a new
 *   Stripe dashboard refund (#4361 decision 7). "Refunds owed" counts the held
 *   row as it counts every dead one: nothing after a full close (the payment
 *   holds nothing more), what the payment still holds after a part close. The
 *   officer's existing door - "Paid another way" on the held row - settles it;
 * - duplicate deliveries, one after another and at once: one row, one alert;
 * - with NO close, unchanged: X's row is raised live and the runner re-sends it;
 * - a close on ANOTHER row of the same payment changes nothing for X: the hold
 *   is decided by the row that made X (or whose slice X fills), and a close
 *   settles only the row its record names;
 * - the close and X's failure racing on the Payment row, in both orders: close
 *   first, X is held; failure first, the dead row that counted X owes it again
 *   on its next key and the close against the old figure is refused (409).
 *   Neither order re-sends anything automatically.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4210-` fixtures. No Stripe or Xero call is made: the refunds are the
 * payloads Stripe sends, the runner's refund call goes through the harness's one
 * shared `@/lib/stripe` double, and the officers' alert is spied on.
 */
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4210-member";
const OFFICER_ID = "race-4210-officer";
const LODGE_ID = "race-4210-lodge";
const BOOKING_ID = "race-4210-booking";
const PAYMENT_ID = "race-4210-payment";
const TXN_A = "race-4210-txn-a";
const TXN_B = "race-4210-txn-b";
const INTENT_A = "pi_race_4210_a";
const INTENT_B = "pi_race_4210_b";
const CHARGE_A = "ch_race_4210_a";
const CHARGE_B = "ch_race_4210_b";
const OP_ID = "race-4210-op";
const OP2_ID = "race-4210-op-2";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const RAISED_AT = new Date("2026-06-20T00:00:00.000Z");

const CHARGE_A_CENTS = 20_000;
const CHARGE_B_CENTS = 10_000;

const LEDGER_MIGRATION = "20260509090000_enrich_payment_refund_ledger";
const CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";
const LOCK_POLL_TIMEOUT_MS = 5_000;
const HELD = /failed after the card refund that made it was closed "Paid another way"\. .*check its record before paying\. .*settle it with "Paid another way", never with a new refund in the Stripe dashboard\. .*ask a developer to reconcile it\.$/;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let closeCardRefundPaidAnotherWay: (typeof import("@/lib/card-refund-paid-another-way"))["closeCardRefundPaidAnotherWay"];
let listDeadCardRefunds: (typeof import("@/lib/card-refund-paid-another-way"))["listDeadCardRefunds"];
let deadCardRefundOperationWhere: (typeof import("@/lib/card-refund-paid-another-way"))["deadCardRefundOperationWhere"];
let syncRefundsFromStripeCharge: (typeof import("@/lib/payment-transactions"))["syncRefundsFromStripeCharge"];
let recordRefusedCardRefund: (typeof import("@/lib/card-refund-status-sync"))["recordRefusedCardRefund"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let openCardRefundOwedCents: (typeof import("@/lib/open-card-refund-owed"))["openCardRefundOwedCents"];
let netCollectedCardRefundSelect: (typeof import("@/lib/additional-ledger-gap"))["netCollectedCardRefundSelect"];
let cardRefundOperationRefundMetadata: (typeof import("@/lib/payment-recovery-keys"))["cardRefundOperationRefundMetadata"];
let recoveryAlert: typeof import("@/lib/payment-recovery-alert");
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let realElapsedMs: (typeof import("@/lib/__tests__/helpers/clock"))["realElapsedMs"];
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;
/** When a late refund was made: after both migrations its writers read finished on this database. */
let refundCreatedSeconds = 0;

interface Charge {
  id: string;
  intent: string;
  charge: string;
  cents: number;
}
const A: Charge = { id: TXN_A, intent: INTENT_A, charge: CHARGE_A, cents: CHARGE_A_CENTS };
const B: Charge = { id: TXN_B, intent: INTENT_B, charge: CHARGE_B, cents: CHARGE_B_CENTS };

(RUN ? describe : describe.skip)(
  "a card refund that fails later after its row was closed Paid another way is held, never re-sent — real PostgreSQL (#4210)",
  { timeout: 30_000 },
  () => {
    let alertSpy: MockInstance<(typeof import("@/lib/payment-recovery-alert"))["alertPaymentRecoveryOfficers"]>;
    /** Every Stripe refund the runner asked for. */
    let asked: Array<{ idempotencyKey?: string; amountCents: number }> = [];

    async function deletePaymentRows() {
      await prisma.alertCooldown.deleteMany({ where: { OR: [TXN_A, TXN_B].map((id) => ({ key: { startsWith: `card-refund-cap-overflow:${id}:` } })) } });
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: [OP_ID, OP2_ID] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4210 failed-later refund after Paid another way");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ closeCardRefundPaidAnotherWay, listDeadCardRefunds, deadCardRefundOperationWhere } = await import("@/lib/card-refund-paid-another-way"));
      ({ syncRefundsFromStripeCharge } = await import("@/lib/payment-transactions"));
      ({ recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync"));
      ({ runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ openCardRefundOwedCents } = await import("@/lib/open-card-refund-owed"));
      ({ netCollectedCardRefundSelect } = await import("@/lib/additional-ledger-gap"));
      ({ cardRefundOperationRefundMetadata } = await import("@/lib/payment-recovery-keys"));
      recoveryAlert = await import("@/lib/payment-recovery-alert");
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));
      ({ realElapsedMs } = await import("@/lib/__tests__/helpers/clock"));
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = separate("race-4210-holder");
      observerClient = separate("race-4210-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      // A refund made on this install since the refund ledger and the
      // failed-later cutoff arrived: its sync adds it, and its failure is owed
      // by a row of its own, live unless something holds it. Read, never
      // rewritten: the migration rows stay as `migrate deploy` left them.
      const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
        SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" IN (${LEDGER_MIGRATION}, ${CUTOFF_MIGRATION})`;
      if (rows.length !== 2 || rows.some((row) => row.finished_at === null)) {
        throw new Error("The race database lacks the refund ledger migrations: run prisma migrate deploy against it first.");
      }
      refundCreatedSeconds = Math.max(...rows.map((row) => Math.floor(row.finished_at!.getTime() / 1000))) + 3_600;

      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Held", lastName: "Proof", ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4210 Lodge", slug: "race-4210" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CANCELLED",
          totalPriceCents: CHARGE_A_CENTS + CHARGE_B_CENTS,
          finalPriceCents: CHARGE_A_CENTS + CHARGE_B_CENTS,
        },
      });
    });

    beforeEach(async () => {
      await deletePaymentRows();
      alertSpy = vi.spyOn(recoveryAlert, "alertPaymentRecoveryOfficers").mockResolvedValue(null);
      asked = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push({ idempotencyKey: args.idempotencyKey, amountCents: args.amountCents });
        return {
          id: `re_race_4210_resend_${asked.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "pending",
          created: refundCreatedSeconds + 60,
          charge: CHARGE_A,
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
    });

    afterEach(() => {
      alertSpy.mockRestore();
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      await Promise.all(
        [lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())),
      );
      if (!prisma) return;
      await deleteFixtures();
    });

    // ---------------------------------------------------------------- fixtures

    /** A captured card payment on one or two charges; invoiced, so a close can raise its note. */
    async function seedPayment(charges: Charge[]) {
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: charges.reduce((sum, charge) => sum + charge.cents, 0),
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: charges[0]!.intent,
          xeroInvoiceId: "inv_race_4210",
        },
      });
      for (const [index, charge] of charges.entries()) {
        await prisma.paymentTransaction.create({
          data: {
            id: charge.id,
            paymentId: PAYMENT_ID,
            kind: index === 0 ? "PRIMARY" : "ADDITIONAL",
            source: "STRIPE",
            stripePaymentIntentId: charge.intent,
            amountCents: charge.cents,
            status: "SUCCEEDED",
            createdAt: new Date(Date.UTC(2026, 4, 1 + index)),
          },
        });
      }
    }

    /** A card refund row: dead (retries spent, for the treasurer to close), or made by the runner (SUCCEEDED). */
    async function seedRefundRow({
      id = OP_ID,
      slices,
      idempotencyKey = `booking_cancel_refund_recovery_${BOOKING_ID}`,
      made = false,
      createdAt = RAISED_AT,
    }: {
      id?: string;
      slices: Array<{ charge: Charge; cents: number }>;
      idempotencyKey?: string;
      made?: boolean;
      createdAt?: Date;
    }) {
      return prisma.paymentRecoveryOperation.create({
        data: {
          id,
          type: "REFUND_BOOKING_MODIFICATION",
          status: made ? "SUCCEEDED" : "FAILED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: slices[0]!.charge.intent,
          amountCents: slices.reduce((sum, slice) => sum + slice.cents, 0),
          allocationPlan: slices.map((slice) => ({ paymentTransactionId: slice.charge.id, amountCents: slice.cents })),
          idempotencyKey,
          attempts: made ? 1 : 5,
          nextRetryAt: null,
          createdAt,
          succeededAt: made ? new Date((refundCreatedSeconds + 30) * 1000) : null,
        },
      });
    }

    const close = (operationId: string, amountCents: number, expectedOwedCents = amountCents) =>
      closeCardRefundPaidAnotherWay({
        operationId,
        amountCents,
        paidBack: amountCents === expectedOwedCents ? "full" : "partial",
        expectedOwedCents,
        note: "Bank transfer, ref RACE 4210",
        actingMemberId: OFFICER_ID,
      });

    /** A Stripe refund as `charge.refunded` and `refund.failed` carry it, with the runner metadata of the row that made it. */
    async function stripeRefund(id: string, charge: Charge, cents: number, status: string, madeBy = OP_ID): Promise<Stripe.Refund> {
      const maker = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: madeBy } });
      return {
        id,
        object: "refund",
        amount: cents,
        currency: "nzd",
        status,
        reason: "requested_by_customer",
        created: refundCreatedSeconds,
        charge: charge.charge,
        payment_intent: charge.intent,
        metadata: cardRefundOperationRefundMetadata(maker),
      } as unknown as Stripe.Refund;
    }

    /** The `charge.refunded` sync: Stripe lists every refund on the charge. */
    const syncCharge = (charge: Charge, refunds: Stripe.Refund[]) =>
      syncRefundsFromStripeCharge({
        paymentIntentId: charge.intent,
        stripeChargeId: charge.charge,
        refundedAmountCents: refunds.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amount, 0),
        refunds: refunds as never,
      });

    /** `refund.failed` / `refund.updated` to `canceled`: the webhook's recorder. */
    const deliverRefusal = (refund: Stripe.Refund, status: "failed" | "canceled" = "failed") =>
      recordRefusedCardRefund({ ...refund, status } as Stripe.Refund);

    // -------------------------------------------------------------- readings

    async function owedNow(): Promise<number> {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });
      return openCardRefundOwedCents(payment);
    }

    /** Every card refund row on the booking other than the ones the test seeded. */
    const raisedRows = () =>
      prisma.paymentRecoveryOperation.findMany({
        where: { bookingId: BOOKING_ID, id: { notIn: [OP_ID, OP2_ID] } },
        select: { id: true, idempotencyKey: true, amountCents: true, status: true, attempts: true },
        orderBy: { idempotencyKey: "asc" },
      });
    const failedLaterKey = (refundId: string) => `card_refund_failed_later_${refundId}`;
    /** Raised held: PENDING with its attempts spent - never claimed, closable as paid another way. */
    const heldRow = (refundId: string, cents: number) =>
      expect.objectContaining({ idempotencyKey: failedLaterKey(refundId), amountCents: cents, status: "PENDING", attempts: 5 });
    const liveRow = (refundId: string, cents: number) =>
      expect.objectContaining({ idempotencyKey: failedLaterKey(refundId), amountCents: cents, status: "PENDING", attempts: 0 });

    /**
     * What the officers were told of failed-later refunds, one entry per alert.
     * The same sender carries the cap overflow's alert (#4154) for a late refund
     * the closed charge cannot hold, which is not this proof's.
     */
    const alerts = () => alertSpy.mock.calls.map(([alert]) => alert.errorMessage).filter((message) => /^Stripe (accepted|reported)/.test(message));

    /** The runner, asked to take the row now: a held row is never claimed, and Stripe is never asked. */
    async function expectNeverResent(operationId: string) {
      expect(await prisma.paymentRecoveryOperation.count({ where: { id: operationId, ...deadCardRefundOperationWhere } })).toBe(1);
      expect(await runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("not-claimed");
      expect(asked).toEqual([]);
    }

    // --------------------------------------------------------------- the bug

    describe("closed Paid another way, then its lost card refund recorded late and failed", () => {
      // #4210 review (C2): the lost-answer shape - Stripe made the refund BEFORE the close, which the app
      // recorded after it - so the refund fills the closed row's slice (money paid twice).
      it("made by Stripe before the close and recorded after it: held", async () => {
        await seedPayment([A]);
        await seedRefundRow({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        const frozen = new Date();
        vi.setSystemTime(new Date((refundCreatedSeconds + 60) * 1000));
        try {
          await close(OP_ID, CHARGE_A_CENTS);
        } finally {
          vi.setSystemTime(frozen);
        }
        const closedRow = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: OP_ID } });
        expect(closedRow.succeededAt!.getTime()).toBeGreaterThan(refundCreatedSeconds * 1000);
        const late = await stripeRefund("re_race_4210_before_close", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [late]);
        await deliverRefusal(late);

        const raised = await raisedRows();
        expect(raised).toEqual([heldRow(late.id, CHARGE_A_CENTS)]);
        expect(alerts()).toEqual([expect.stringMatching(HELD)]);
        await expectNeverResent(raised[0]!.id);
        expect(await owedNow()).toBe(0);
      });

      it.each([
        ["pending", "failed"],
        ["succeeded", "failed"],
        ["pending", "canceled"],
      ] as const)("full close, late %s then %s: held for an officer, alerted once, never re-sent; Refunds owed reads nothing", async (lateStatus, refusal) => {
        await seedPayment([A]);
        await seedRefundRow({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        await close(OP_ID, CHARGE_A_CENTS);
        const late = await stripeRefund(`re_race_4210_full_${lateStatus}_${refusal}`, A, CHARGE_A_CENTS, lateStatus);
        await syncCharge(A, [late]);
        expect(alerts()).toEqual([]);

        expect(await deliverRefusal(late, refusal)).toBe("recorded");

        const raised = await raisedRows();
        expect(raised).toEqual([heldRow(late.id, CHARGE_A_CENTS)]);
        expect(alerts()).toEqual([expect.stringMatching(HELD)]);
        expect(alerts()[0]).toContain("$200.00");
        await expectNeverResent(raised[0]!.id);
        // The close paid the member in full: the payment holds nothing more, so nothing reads owed,
        // and (the stated limit, `INV-PAY-142`) no close is offered for the held row.
        expect(await owedNow()).toBe(0);
        expect((await listDeadCardRefunds()).filter((row) => row.bookingId === BOOKING_ID)).toEqual([]);

        // Duplicate deliveries: the refusal again, the sync's stale listing, and the sync's refused one.
        expect(await deliverRefusal(late, refusal)).toBe("recorded");
        await syncCharge(A, [late]);
        await syncCharge(A, [{ ...late, status: refusal } as Stripe.Refund]);
        expect(await raisedRows()).toEqual([heldRow(late.id, CHARGE_A_CENTS)]);
        expect(alerts()).toHaveLength(1);
        await expectNeverResent(raised[0]!.id);
      });

      it("part close ($120 of $200): held; Refunds owed reads the $80 the close recorded as no longer owed, which its record shows the officer", async () => {
        await seedPayment([A]);
        await seedRefundRow({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        await close(OP_ID, 12_000, CHARGE_A_CENTS);
        const late = await stripeRefund("re_race_4210_part", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [late]);
        await deliverRefusal(late);

        const raised = await raisedRows();
        expect(raised).toEqual([heldRow(late.id, CHARGE_A_CENTS)]);
        expect(alerts()).toEqual([expect.stringMatching(HELD)]);
        await expectNeverResent(raised[0]!.id);
        // Counted as every dead row is, capped at what the payment still holds: the $80 the close left.
        expect(await owedNow()).toBe(8_000);
        // Listed for the officer under "Card refunds Stripe gave up on". The figure is what the part close
        // recorded as no longer owed - its record says so - so the alert says to check that record before paying.
        expect((await listDeadCardRefunds()).filter((row) => row.bookingId === BOOKING_ID)).toEqual([
          expect.objectContaining({ operationId: raised[0]!.id, owedCents: 8_000, stripeMayHaveRefunded: false }),
        ]);
        const record = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID, occurrenceKey: { startsWith: "card-refund-paid-another-way:" } } });
        expect(record).toMatchObject({ amountCents: 12_000, raisedAmountCents: CHARGE_A_CENTS });
        expect(asked).toEqual([]);
      });

      it("part close across two charges ($150 of $300): held, and Refunds owed reads the $150 the payment still holds", async () => {
        await seedPayment([A, B]);
        await seedRefundRow({ slices: [{ charge: A, cents: CHARGE_A_CENTS }, { charge: B, cents: CHARGE_B_CENTS }] });
        await close(OP_ID, 15_000, 30_000);
        const late = await stripeRefund("re_race_4210_multi_part", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [late]);
        await deliverRefusal(late);

        const raised = await raisedRows();
        expect(raised).toEqual([heldRow(late.id, CHARGE_A_CENTS)]);
        expect(alerts()).toEqual([expect.stringMatching(HELD)]);
        await expectNeverResent(raised[0]!.id);
        expect(await owedNow()).toBe(15_000);
      });

      it("two deliveries of the failure at once: one held row, one alert", async () => {
        await seedPayment([A]);
        await seedRefundRow({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        await close(OP_ID, CHARGE_A_CENTS);
        const late = await stripeRefund("re_race_4210_twice", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [late]);

        const settled = await inOrder(() => deliverRefusal(late), () => deliverRefusal(late));
        for (const outcome of settled) {
          if (!outcome.ok) throw outcome.error;
        }

        const raised = await raisedRows();
        expect(raised).toEqual([heldRow(late.id, CHARGE_A_CENTS)]);
        expect(alerts()).toEqual([expect.stringMatching(HELD)]);
        await expectNeverResent(raised[0]!.id);
      });
    });

    // ------------------------------------------------------- unchanged paths

    describe("decided by the row that made the refund", () => {
      it("with no close, unchanged: the row the runner made it for owes it again, live, and the runner sends it", async () => {
        await seedPayment([A]);
        await seedRefundRow({ slices: [{ charge: A, cents: CHARGE_A_CENTS }], made: true });
        const made = await stripeRefund("re_race_4210_no_close", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [made]);
        await deliverRefusal(made);

        const raised = await raisedRows();
        expect(raised).toEqual([liveRow(made.id, CHARGE_A_CENTS)]);
        expect(alerts()).toEqual([expect.stringMatching(/will be asked for again automatically/)]);
        expect(await owedNow()).toBe(CHARGE_A_CENTS);
        expect(await runPaymentRecoveryOperationNow(raised[0]!.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        expect(asked).toEqual([{ idempotencyKey: `${failedLaterKey(made.id)}_${TXN_A}_${CHARGE_A_CENTS}`, amountCents: CHARGE_A_CENTS }]);
      });

      // #4210 review (F1): two edits of one reason send the same metadata, and an edit door raises its row only
      // after its inline attempt throws - so neither row fills a slice with the refund the first one lost.
      it("two rows send what it carries and it fills neither: the closed one still holds it", async () => {
        await seedPayment([A, B]);
        const after = new Date((refundCreatedSeconds + 120) * 1000);
        await seedRefundRow({ slices: [{ charge: A, cents: CHARGE_A_CENTS }], idempotencyKey: `race_4210_edit_1_${BOOKING_ID}`, createdAt: after });
        await seedRefundRow({ id: OP2_ID, slices: [{ charge: B, cents: CHARGE_B_CENTS }], idempotencyKey: `race_4210_edit_2_${BOOKING_ID}`, createdAt: after, made: true });
        await close(OP_ID, CHARGE_A_CENTS);
        const lost = await stripeRefund("re_race_4210_two_senders", A, CHARGE_A_CENTS, "pending");
        // Both rows' runners send exactly this metadata.
        expect(lost.metadata).toEqual(await stripeRefund("re_race_4210_two_senders", A, CHARGE_A_CENTS, "pending", OP2_ID).then((refund) => refund.metadata));
        await syncCharge(A, [lost]);
        await deliverRefusal(lost);

        const raised = await raisedRows();
        expect(raised).toEqual([heldRow(lost.id, CHARGE_A_CENTS)]);
        expect(alerts()).toEqual([expect.stringMatching(HELD)]);
        await expectNeverResent(raised[0]!.id);
      });

      it("a close on ANOTHER row of the same payment holds nothing: that close settled only its own row", async () => {
        await seedPayment([A, B]);
        await seedRefundRow({ slices: [{ charge: A, cents: CHARGE_A_CENTS }], made: true });
        await seedRefundRow({ id: OP2_ID, slices: [{ charge: B, cents: CHARGE_B_CENTS }], idempotencyKey: `race_4210_second_refund_${BOOKING_ID}` });
        const made = await stripeRefund("re_race_4210_other_close", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [made]);
        await close(OP2_ID, CHARGE_B_CENTS);
        expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID, occurrenceKey: { startsWith: "card-refund-paid-another-way:" } } })).toBe(1);

        await deliverRefusal(made);

        const raised = await raisedRows();
        expect(raised).toEqual([liveRow(made.id, CHARGE_A_CENTS)]);
        expect(alerts()).toEqual([expect.stringMatching(/will be asked for again automatically/)]);
        expect(await owedNow()).toBe(CHARGE_A_CENTS);
        expect(await runPaymentRecoveryOperationNow(raised[0]!.id, CLUB_FORMAT_TEST)).toBe("succeeded");
        expect(asked).toHaveLength(1);
      });
    });

    // -------------------------------------------------------------- races

    /** Hold the Payment row on a third connection; the writers queue behind it. */
    async function holdPaymentRow() {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const isReady = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const held = lockHolderClient.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${PAYMENT_ID} FOR NO KEY UPDATE`;
          ready();
          await released;
        },
        { timeout: 20_000 },
      );
      await isReady;
      return { release, held };
    }

    /** Wait until `count` backends of this database are blocked, whoever holds them up. */
    async function waitForBlocked(count: number, what: string) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
        if ((rows[0]?.count ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${what} to queue on the payment row.`);
    }

    /** Start `first`, wait until it queues on the held row, then `second`, and release them in that order. */
    async function inOrder<T, U>(first: () => Promise<T>, second: () => Promise<U>) {
      const holder = await holdPaymentRow();
      const one = first().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForBlocked(1, "the first writer");
      const two = second().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForBlocked(2, "the second writer");
      holder.release();
      await holder.held;
      return [await one, await two] as const;
    }

    describe("the close and the refund's failure racing on the payment row", () => {
      /** A dead row over both charges whose refund on A Stripe made: recorded before the close, so $100 is left to close. */
      async function seedMadeOnA() {
        await seedPayment([A, B]);
        await seedRefundRow({ slices: [{ charge: A, cents: CHARGE_A_CENTS }, { charge: B, cents: CHARGE_B_CENTS }] });
        const madeOnA = await stripeRefund("re_race_4210_race", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [madeOnA]);
        expect(await owedNow()).toBe(CHARGE_B_CENTS);
        return madeOnA;
      }

      it("close first: the failure finds the row closed Paid another way, and its row is held, alerted, never re-sent", async () => {
        const madeOnA = await seedMadeOnA();
        const [closed, failed] = await inOrder(() => close(OP_ID, CHARGE_B_CENTS), () => deliverRefusal(madeOnA));
        expect(closed.ok && failed.ok).toBe(true);

        const raised = await raisedRows();
        expect(raised).toEqual([heldRow(madeOnA.id, CHARGE_A_CENTS)]);
        expect(alerts()).toEqual([expect.stringMatching(HELD)]);
        await expectNeverResent(raised[0]!.id);
        // Whether the close paid that $200 back is the officer's to check: it reads owed until then.
        expect(await owedNow()).toBe(CHARGE_A_CENTS);
      });

      it("failure first: the dead row that counted it owes it again on its next key, and the close against the old figure is refused", async () => {
        const madeOnA = await seedMadeOnA();
        const [failed, closed] = await inOrder(() => deliverRefusal(madeOnA), () => close(OP_ID, CHARGE_B_CENTS));
        expect(failed.ok).toBe(true);
        expect(closed).toMatchObject({ ok: false, error: { status: 409 } });
        expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);

        expect(await raisedRows()).toEqual([]);
        const dead = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: OP_ID } });
        expect(dead).toMatchObject({ status: "FAILED", attempts: 5 });
        expect(dead.allocationPlan).toEqual([
          expect.objectContaining({ paymentTransactionId: TXN_A, amountCents: CHARGE_A_CENTS, failedRefundIds: [madeOnA.id] }),
          { paymentTransactionId: TXN_B, amountCents: CHARGE_B_CENTS },
        ]);
        expect(alerts()).toEqual([expect.stringMatching(/retries are already spent: pay the member another way/)]);
        await expectNeverResent(OP_ID);
        expect(await owedNow()).toBe(30_000);
      });
    });
  },
);
