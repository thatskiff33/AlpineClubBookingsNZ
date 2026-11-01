/**
 * Real-PostgreSQL proof of #4280 (`INV-PAY-103`; owner, 22 and 26 Oct 2026):
 * a card refund's reversal never takes the refunded total below the bank cash
 * a "Paid another way" close recorded.
 *
 * The bug, through the real writers: $200 captured, its dead card refund closed
 * as paid another way for $200 (`closeCardRefundPaidAnotherWay`), then the lost
 * card refund recorded late by the `charge.refunded` sync - capped, so it adds
 * nothing - then reported failed (`recordRefusedCardRefund`). The writer took
 * the whole failed refund off, and its floor counted card refunds and account
 * credit but not the close's cash: the total fell from $200 to $0 while the bank
 * refund stood, reopening $200 of refundable headroom.
 *
 * Proven here, each through the real close, sync and refusal writers:
 *
 * - full and part closes, a late `pending` or `succeeded` refund then `failed`
 *   or `canceled`; the close's note raised, absent, or waiting for a receipt;
 * - duplicate deliveries, one after another and at once;
 * - several charges and refunds, and a close already on another charge's
 *   mirror, counted once;
 * - account credit beside the bank cash;
 * - the cap binding: card refunds still counted plus the close's cash above
 *   what was captured;
 * - a cancel's card refund shortfall, and a hand-back paid through the real
 *   allocation that #4162's unwind took back, never counted (owner, 26 Oct 2026);
 * - the close and the late refund racing in both orders, a failure racing a
 *   second close in both orders, and a failure rolled back with its caller.
 *
 * Each asserts the net position, both mirrors (the payment's refunded total and
 * each charge's), the debt "Refunds owed" reads (`openCardRefundOwedCents`)
 * and the card refund rows. After a full close the payment holds nothing more
 * to refund, so "Refunds owed" reads nothing. THE ROW: a closed row's refund
 * failing later raises one card refund row of its own (`INV-PAY-128`) -
 * exactly one per refund, never a second on a replay or a concurrent delivery
 * - and the floor writes none. Since #4210 (`INV-PAY-142`) that row is HELD:
 * raised with its attempts spent, never re-sent automatically, for an officer
 * to check against the close (`card-refund-failed-later-after-paid-another-way.realdb.test.ts`
 * proves the hold and its alert). After a PART close it counts in "Refunds
 * owed" as every dead row does, up to what the payment still holds.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4280-` fixtures. No Stripe or Xero call is made: the refunds are the
 * payloads Stripe sends, and Xero is not connected.
 */
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4280-member";
const OFFICER_ID = "race-4280-officer";
const LODGE_ID = "race-4280-lodge";
const BOOKING_ID = "race-4280-booking";
const PAYMENT_ID = "race-4280-payment";
const TXN_A = "race-4280-txn-a";
const TXN_B = "race-4280-txn-b";
const INTENT_A = "pi_race_4280_a";
const INTENT_B = "pi_race_4280_b";
const CHARGE_A = "ch_race_4280_a";
const CHARGE_B = "ch_race_4280_b";
const OP_ID = "race-4280-op";
const OP2_ID = "race-4280-op-2";
const APPROVAL_TASK_ID = "race-4280-approval";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");

const CHARGE_A_CENTS = 20_000;
const CHARGE_B_CENTS = 10_000;
const CREDIT_CENTS = 5_000;

const LEDGER_MIGRATION = "20260509090000_enrich_payment_refund_ledger";
const CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let closeCardRefundPaidAnotherWay: (typeof import("@/lib/card-refund-paid-another-way"))["closeCardRefundPaidAnotherWay"];
let syncRefundsFromStripeCharge: (typeof import("@/lib/payment-transactions"))["syncRefundsFromStripeCharge"];
let recordStripeRefundsAgainstTransaction: (typeof import("@/lib/payment-transactions"))["recordStripeRefundsAgainstTransaction"];
let applyLocalRefundAllocation: (typeof import("@/lib/payment-transactions"))["applyLocalRefundAllocation"];
let reconcilePaymentAggregates: (typeof import("@/lib/payment-transactions"))["reconcilePaymentAggregates"];
let unwindLocalRefundAllocation: (typeof import("@/lib/refund-allocation-unwind"))["unwindLocalRefundAllocation"];
let recordRefusedCardRefund:(typeof import("@/lib/card-refund-status-sync"))["recordRefusedCardRefund"];
let createCancellationCredit: (typeof import("@/lib/member-credit"))["createCancellationCredit"];
let openCardRefundOwedCents: (typeof import("@/lib/open-card-refund-owed"))["openCardRefundOwedCents"];
let netCollectedCardRefundSelect: (typeof import("@/lib/additional-ledger-gap"))["netCollectedCardRefundSelect"];
let cardRefundOperationRefundMetadata: (typeof import("@/lib/payment-recovery-keys"))["cardRefundOperationRefundMetadata"];
let readPaidAnotherWayCash: (typeof import("@/lib/card-refund-paid-another-way-cash"))["readPaidAnotherWayCash"];
let auditRefundedTotalShortfalls: (typeof import("@/lib/refunded-total-shortfall-audit"))["auditRefundedTotalShortfalls"];
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
  "a card refund's reversal keeps the bank cash a Paid another way close recorded — real PostgreSQL (#4280)",
  { timeout: 30_000 },
  () => {
    async function deletePaymentRows() {
      await prisma.alertCooldown.deleteMany({ where: { OR: [TXN_A, TXN_B].map((id) => ({ key: { startsWith: `card-refund-cap-overflow:${id}:` } })) } });
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: [OP_ID, OP2_ID] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, APPROVAL_TASK_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, APPROVAL_TASK_ID] } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
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
      assertSafeRaceDbUrl(RACE_DB_URL, "#4280 bank cash reversal floor");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ closeCardRefundPaidAnotherWay } = await import("@/lib/card-refund-paid-another-way"));
      ({ syncRefundsFromStripeCharge, recordStripeRefundsAgainstTransaction, applyLocalRefundAllocation, reconcilePaymentAggregates } = await import("@/lib/payment-transactions"));
      ({ recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync"));
      ({ unwindLocalRefundAllocation } = await import("@/lib/refund-allocation-unwind"));
      ({ createCancellationCredit } = await import("@/lib/member-credit"));
      ({ openCardRefundOwedCents } = await import("@/lib/open-card-refund-owed"));
      ({ netCollectedCardRefundSelect } = await import("@/lib/additional-ledger-gap"));
      ({ cardRefundOperationRefundMetadata } = await import("@/lib/payment-recovery-keys"));
      ({ readPaidAnotherWayCash } = await import("@/lib/card-refund-paid-another-way-cash"));
      ({ auditRefundedTotalShortfalls } = await import("@/lib/refunded-total-shortfall-audit"));
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
      lockHolderClient = separate("race-4280-holder");
      observerClient = separate("race-4280-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      // A refund made on this install since the refund ledger and the
      // failed-later cutoff arrived: its sync adds it, and its failure is owed
      // by a row of its own. Read, never rewritten: the migration rows stay as
      // `migrate deploy` left them.
      const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
        SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" IN (${LEDGER_MIGRATION}, ${CUTOFF_MIGRATION})`;
      if (rows.length !== 2 || rows.some((row) => row.finished_at === null)) {
        throw new Error("The race database lacks the refund ledger migrations: run prisma migrate deploy against it first.");
      }
      refundCreatedSeconds = Math.max(...rows.map((row) => Math.floor(row.finished_at!.getTime() / 1000))) + 3_600;

      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Floor", lastName: "Proof", ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4280 Lodge", slug: "race-4280" } });
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
    async function seedPayment({ charges, invoiced = true }: { charges: Charge[]; invoiced?: boolean }) {
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: charges.reduce((sum, charge) => sum + charge.cents, 0),
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: charges[0]!.intent,
          xeroInvoiceId: invoiced ? "inv_race_4280" : null,
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

    /** A card refund row whose retries are spent: dead, for the treasurer to close. */
    async function seedDeadRefund({
      id = OP_ID,
      slices,
      idempotencyKey = `booking_cancel_refund_recovery_${BOOKING_ID}`,
    }: {
      id?: string;
      slices: Array<{ charge: Charge; cents: number }>;
      idempotencyKey?: string;
    }) {
      return prisma.paymentRecoveryOperation.create({
        data: {
          id,
          type: "REFUND_BOOKING_MODIFICATION",
          status: "FAILED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: slices[0]!.charge.intent,
          amountCents: slices.reduce((sum, slice) => sum + slice.cents, 0),
          allocationPlan: slices.map((slice) => ({ paymentTransactionId: slice.charge.id, amountCents: slice.cents })),
          idempotencyKey,
          attempts: 5,
          nextRetryAt: null,
          createdAt: new Date("2026-06-20T00:00:00.000Z"),
        },
      });
    }

    const close = (operationId: string, amountCents: number, expectedOwedCents = amountCents) =>
      closeCardRefundPaidAnotherWay({
        operationId,
        amountCents,
        paidBack: amountCents === expectedOwedCents ? "full" : "partial",
        expectedOwedCents,
        note: "Bank transfer, ref RACE 4280",
        actingMemberId: OFFICER_ID,
      });

    /** A Stripe refund as `charge.refunded` and `refund.failed` carry it - the dead row's own, unless told otherwise. */
    async function stripeRefund(
      id: string,
      charge: Charge,
      cents: number,
      status: string,
      { madeBy = OP_ID }: { madeBy?: string | null } = {},
    ): Promise<Stripe.Refund> {
      const maker = madeBy ? await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: madeBy } }) : null;
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
        // The runner's own metadata, or (a refund made by hand in the Stripe dashboard) none.
        metadata: maker ? cardRefundOperationRefundMetadata(maker) : {},
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
    const deliverRefusal = (refund: Stripe.Refund, status: "failed" | "canceled") =>
      recordRefusedCardRefund({ ...refund, status } as Stripe.Refund);

    /** A member's cancel settling account credit: the allocation and the credit it mints, together. */
    async function settleCredit(cents: number) {
      await prisma.$transaction(async (tx) => {
        await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: cents, store: tx });
        await createCancellationCredit(MEMBER_ID, cents, BOOKING_ID, undefined, tx);
      });
    }

    // -------------------------------------------------------------- readings

    /** Both mirrors: the payment's refunded total, and each charge's. */
    async function mirrors() {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { amountCents: true, refundedAmountCents: true, transactions: { select: { id: true, refundedAmountCents: true }, orderBy: { id: "asc" } } },
      });
      return {
        payment: payment.refundedAmountCents,
        charges: Object.fromEntries(payment.transactions.map((row) => [row.id, row.refundedAmountCents])),
        /** What the club still holds of what it captured: the refundable headroom a later cancel or refund reads. */
        retained: payment.amountCents - payment.refundedAmountCents,
      };
    }

    async function owedNow(): Promise<number> {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });
      return openCardRefundOwedCents(payment);
    }

    /** Every card refund row on the booking other than the dead ones the test seeded. */
    const raisedRows = () =>
      prisma.paymentRecoveryOperation.findMany({
        where: { bookingId: BOOKING_ID, id: { notIn: [OP_ID, OP2_ID] } },
        select: { idempotencyKey: true, amountCents: true, status: true, attempts: true },
        orderBy: { idempotencyKey: "asc" },
      });
    /** #4210 (`INV-PAY-142`): the failure's row of its own, held - PENDING with its attempts spent, never re-sent automatically. */
    const rowOfItsOwn = (refundId: string, cents: number) =>
      expect.objectContaining({ idempotencyKey: `card_refund_failed_later_${refundId}`, amountCents: cents, status: "PENDING", attempts: 5 });

    const refundStatus = async (stripeRefundId: string) =>
      (await prisma.paymentRefund.findUniqueOrThrow({ where: { stripeRefundId }, select: { status: true } })).status;

    /** The refunded-total audit's finding for this payment, if any (#3640): it reads the same floor. */
    async function auditFinding() {
      return (await auditRefundedTotalShortfalls()).findings.find((finding) => finding.paymentId === PAYMENT_ID) ?? null;
    }

    // --------------------------------------------------------------- the bug

    describe("one charge, closed in full, then its lost card refund recorded late and failed", () => {
      it.each([
        ["pending", "failed"],
        ["succeeded", "failed"],
        ["pending", "canceled"],
      ] as const)("late %s then %s: the total keeps the close's bank cash, and Refunds owed reads nothing", async (lateStatus, refusal) => {
        await seedPayment({ charges: [A] });
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        expect(await owedNow()).toBe(CHARGE_A_CENTS);
        await close(OP_ID, CHARGE_A_CENTS);
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });
        expect(await owedNow()).toBe(0);

        const late = await stripeRefund("re_race_4280_late", A, CHARGE_A_CENTS, lateStatus);
        await syncCharge(A, [late]);
        // The cap: the charge cannot hold a second $200.
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });

        expect(await deliverRefusal(late, refusal)).toBe("recorded");

        // The bank refund stands: nothing of the $200 is refundable again.
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });
        expect(await refundStatus("re_race_4280_late")).toBe(refusal);
        // The failure's row (`INV-PAY-128`), held (#4210, see the header): one. Refunds owed reads nothing.
        expect(await raisedRows()).toEqual([rowOfItsOwn("re_race_4280_late", CHARGE_A_CENTS)]);
        expect(await owedNow()).toBe(0);
        // The audit, which reads the same floor, finds nothing short.
        expect(await auditFinding()).toBeNull();

        // Duplicate deliveries: the sync's stale listing and the refusal again.
        await syncCharge(A, [late]);
        expect(await deliverRefusal(late, refusal)).toBe("recorded");
        await syncCharge(A, [{ ...late, status: refusal } as Stripe.Refund]);
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });
        expect(await refundStatus("re_race_4280_late")).toBe(refusal);
        expect(await raisedRows()).toEqual([rowOfItsOwn("re_race_4280_late", CHARGE_A_CENTS)]);
        expect(await owedNow()).toBe(0);
      });

      it("a part close keeps only what it paid: $120 of $200, the $80 given up is refundable no more and never re-counted", async () => {
        await seedPayment({ charges: [A] });
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        await close(OP_ID, 12_000, CHARGE_A_CENTS);
        expect(await mirrors()).toEqual({ payment: 12_000, charges: { [TXN_A]: 12_000 }, retained: 8_000 });

        const late = await stripeRefund("re_race_4280_part", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [late]);
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });

        await deliverRefusal(late, "failed");

        expect(await mirrors()).toEqual({ payment: 12_000, charges: { [TXN_A]: 12_000 }, retained: 8_000 });
        expect(await raisedRows()).toEqual([rowOfItsOwn("re_race_4280_part", CHARGE_A_CENTS)]);
        // What "Refunds owed" reads: the failure's held row, counted as every dead row is, up to what the
        // payment still holds - the $80 the part close left. Never re-sent: an officer checks it (#4210).
        expect(await owedNow()).toBe(8_000);
        expect(await auditFinding()).toBeNull();
      });

      it("account credit beside the bank cash: both stay", async () => {
        await seedPayment({ charges: [A] });
        await settleCredit(CREDIT_CENTS);
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS - CREDIT_CENTS }] });
        await close(OP_ID, CHARGE_A_CENTS - CREDIT_CENTS);
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });

        const late = await stripeRefund("re_race_4280_credit", A, CHARGE_A_CENTS - CREDIT_CENTS, "pending");
        await syncCharge(A, [late]);
        await deliverRefusal(late, "failed");

        // Unfloored by the close it read the credit alone: $50.
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });
        expect(await raisedRows()).toEqual([rowOfItsOwn(late.id, CHARGE_A_CENTS - CREDIT_CENTS)]);
        expect(await owedNow()).toBe(0);
        expect(await auditFinding()).toBeNull();
      });
    });

    describe("the close's note - raised, absent, or waiting for the charge's receipt - never changes its cash", () => {
      it.each([
        ["raised now", { invoiced: true, lateCapture: false }, "", "notedCents"],
        ["absent: no invoice to credit", { invoiced: false, lateCapture: false }, ":no-xero-note", "unnotedCents"],
        ["waiting for the late charge's receipt", { invoiced: true, lateCapture: true }, ":note-after-receipt", "awaitingReceiptCents"],
      ] as const)("note %s: the floor counts the whole close", async (_state, { invoiced, lateCapture }, keySuffix, bucket) => {
        await seedPayment({ charges: [A], invoiced });
        if (lateCapture) {
          // A late card charge the treasurer approved refunding, its receipt not yet in Xero.
          await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }], idempotencyKey: `late_capture_approval_refund_recovery_${INTENT_A}` });
          await prisma.manualRefundTask.create({
            data: {
              id: APPROVAL_TASK_ID,
              bookingId: BOOKING_ID,
              paymentId: PAYMENT_ID,
              kind: "DELETED_BOOKING_LATE_CAPTURE",
              status: "COMPLETED",
              lateCaptureApprovalIntentId: INTENT_A,
              amountCents: CHARGE_A_CENTS,
              completedAt: NIGHT,
              completedByMemberId: OFFICER_ID,
              reason: "Late capture approved for refund (race 4280)",
            },
          });
        } else {
          await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        }
        await close(OP_ID, CHARGE_A_CENTS);
        const record = await prisma.manualRefundTask.findFirstOrThrow({
          where: { bookingId: BOOKING_ID, occurrenceKey: { startsWith: "card-refund-paid-another-way:" } },
        });
        expect(record.occurrenceKey).toBe(`card-refund-paid-another-way:${OP_ID}${keySuffix}`);
        // How Xero hears of it, by the note pipeline's own reader: one bucket each.
        expect(await readPaidAnotherWayCash(prisma, PAYMENT_ID)).toEqual({
          notedCents: 0,
          unnotedCents: 0,
          awaitingReceiptCents: 0,
          [bucket]: CHARGE_A_CENTS,
        });

        const late = await stripeRefund(`re_race_4280_note_${keySuffix.length}`, A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [late]);
        await deliverRefusal(late, "failed");

        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });
        expect(await raisedRows()).toEqual([rowOfItsOwn(late.id, CHARGE_A_CENTS)]);
        expect(await owedNow()).toBe(0);
        expect(await auditFinding()).toBeNull();
      });
    });

    describe("several charges and refunds: the close's cash is read payment-wide and counted once", () => {
      it("a close across both charges, each charge's late refund failing in turn: every cent of the close stays", async () => {
        await seedPayment({ charges: [A, B] });
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }, { charge: B, cents: CHARGE_B_CENTS }] });
        await close(OP_ID, CHARGE_A_CENTS + CHARGE_B_CENTS);
        expect(await mirrors()).toEqual({ payment: 30_000, charges: { [TXN_A]: CHARGE_A_CENTS, [TXN_B]: CHARGE_B_CENTS }, retained: 0 });

        const lateA = await stripeRefund("re_race_4280_multi_a", A, CHARGE_A_CENTS, "pending");
        const lateB = await stripeRefund("re_race_4280_multi_b", B, CHARGE_B_CENTS, "pending");
        await syncCharge(A, [lateA]);
        await syncCharge(B, [lateB]);
        await deliverRefusal(lateA, "failed");
        expect(await mirrors()).toEqual({ payment: 30_000, charges: { [TXN_A]: CHARGE_A_CENTS, [TXN_B]: CHARGE_B_CENTS }, retained: 0 });
        await deliverRefusal(lateB, "failed");

        expect(await mirrors()).toEqual({ payment: 30_000, charges: { [TXN_A]: CHARGE_A_CENTS, [TXN_B]: CHARGE_B_CENTS }, retained: 0 });
        expect(await raisedRows()).toEqual([rowOfItsOwn(lateA.id, CHARGE_A_CENTS), rowOfItsOwn(lateB.id, CHARGE_B_CENTS)]);
        expect(await owedNow()).toBe(0);
        expect(await auditFinding()).toBeNull();
      });

      it("a part close across both charges keeps exactly what it paid, wherever the allocation put it", async () => {
        await seedPayment({ charges: [A, B] });
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }, { charge: B, cents: CHARGE_B_CENTS }] });
        await close(OP_ID, 15_000, 30_000);
        const closed = await mirrors();
        expect(closed.payment).toBe(15_000);

        const lateA = await stripeRefund("re_race_4280_multi_part", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [lateA]);
        await deliverRefusal(lateA, "failed");

        // The charges hold the close's $150 between them, exactly as it placed them.
        expect(await mirrors()).toEqual(closed);
        expect(await raisedRows()).toEqual([rowOfItsOwn(lateA.id, CHARGE_A_CENTS)]);
        // As above: the held row counts up to the $150 the payment still holds; never re-sent (#4210).
        expect(await owedNow()).toBe(15_000);
        expect(await auditFinding()).toBeNull();
      });

      it("the cap binds: card refunds still counted plus the close's cash exceed what was captured, and the total holds at the capture", async () => {
        await seedPayment({ charges: [A, B] });
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        await close(OP_ID, CHARGE_A_CENTS);
        // Refunds made by hand in the Stripe dashboard, which succeeded: one fills charge B,
        // one more on the closed charge A is capped (the member was paid twice on it).
        const onB = await stripeRefund("re_race_4280_cap_b", B, CHARGE_B_CENTS, "succeeded", { madeBy: null });
        const extraA = await stripeRefund("re_race_4280_cap_a_extra", A, 5_000, "succeeded", { madeBy: null });
        const late = await stripeRefund("re_race_4280_cap_a_late", A, CHARGE_A_CENTS, "pending");
        await syncCharge(B, [onB]);
        await syncCharge(A, [extraA, late]);
        expect(await mirrors()).toEqual({ payment: 30_000, charges: { [TXN_A]: CHARGE_A_CENTS, [TXN_B]: CHARGE_B_CENTS }, retained: 0 });

        await deliverRefusal(late, "failed");

        // Counted $100 + $50 plus the close's $200 = $350, capped at the $300 captured; less B's $100.
        expect(await mirrors()).toEqual({ payment: 30_000, charges: { [TXN_A]: CHARGE_A_CENTS, [TXN_B]: CHARGE_B_CENTS }, retained: 0 });
        expect(await raisedRows()).toEqual([rowOfItsOwn(late.id, CHARGE_A_CENTS)]);
        expect(await owedNow()).toBe(0);
        // The audit's expected figure is capped too: uncapped it would read $350 and report $50 short.
        expect(await auditFinding()).toBeNull();
      });

      it("a close already on ANOTHER charge's mirror is not counted again: a dashboard refund's failure on this charge goes to $0", async () => {
        await seedPayment({ charges: [A, B] });
        await seedDeadRefund({ slices: [{ charge: B, cents: CHARGE_B_CENTS }] });
        await close(OP_ID, CHARGE_B_CENTS);
        expect(await mirrors()).toEqual({ payment: CHARGE_B_CENTS, charges: { [TXN_A]: 0, [TXN_B]: CHARGE_B_CENTS }, retained: 20_000 });

        // A refund made by hand in the Stripe dashboard on the other charge.
        const dashboard = await stripeRefund("re_race_4280_dashboard", A, 7_000, "pending", { madeBy: null });
        await syncCharge(A, [dashboard]);
        expect(await mirrors()).toEqual({ payment: 17_000, charges: { [TXN_A]: 7_000, [TXN_B]: CHARGE_B_CENTS }, retained: 13_000 });
        await deliverRefusal(dashboard, "failed");

        // Counted twice, the close's $100 would have held $100 on this charge too.
        expect(await mirrors()).toEqual({ payment: CHARGE_B_CENTS, charges: { [TXN_A]: 0, [TXN_B]: CHARGE_B_CENTS }, retained: 20_000 });
        // Not the club's refund to make again: no row (`INV-PAY-128`).
        expect(await raisedRows()).toEqual([]);
        expect(await owedNow()).toBe(0);
      });
    });

    describe("only Paid another way closes count (owner, 26 Oct 2026)", () => {
      it("a completed card refund shortfall and a bank hand-back #4162 undid raise no floor: with no close, the failure goes to $0", async () => {
        await seedPayment({ charges: [A] });
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        // A bank hand-back paid back through the real allocation (the mirror holds it), then
        // undone by #4162's money writer when Xero voided its note: its task still reads COMPLETED.
        await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: CHARGE_A_CENTS, store: prisma });
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });
        // As its one caller does: the unwind, then the aggregate re-derived, in one transaction.
        await prisma.$transaction(async (tx) => {
          await unwindLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: CHARGE_A_CENTS, store: tx });
          await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: tx });
        });
        expect(await mirrors()).toEqual({ payment: 0, charges: { [TXN_A]: 0 }, retained: CHARGE_A_CENTS });
        // Completed records whose cash no longer stands in this total, or is outside this repair.
        const handBack = await prisma.manualRefundTask.create({
          data: {
            bookingId: BOOKING_ID,
            paymentId: PAYMENT_ID,
            kind: "CANCELLED_BOOKING_HAND_BACK",
            status: "COMPLETED",
            amountCents: CHARGE_A_CENTS,
            completedAt: NIGHT,
            completedByMemberId: OFFICER_ID,
            reason: "Cancellation hand-back (race 4280)",
          },
        });
        await prisma.manualRefundTask.create({
          data: {
            bookingId: BOOKING_ID,
            paymentId: PAYMENT_ID,
            kind: "CANCELLED_BOOKING_HAND_BACK",
            status: "OPEN",
            occurrenceKey: `bank-refund-void:${PAYMENT_ID}:cn_race_4280`,
            amountCents: CHARGE_A_CENTS,
            reason: "Refund to re-confirm (race 4280)",
            reviewContext: { bankRefundVoidFollowUp: { originalTaskId: handBack.id } },
          },
        });
        await prisma.manualRefundTask.create({
          data: {
            bookingId: BOOKING_ID,
            paymentId: PAYMENT_ID,
            kind: "CANCELLED_BOOKING_HAND_BACK",
            status: "COMPLETED",
            // Its record alone: card shortfalls are outside this bounded repair (owner, 26 Oct 2026).
            occurrenceKey: `cancel-card-shortfall:${BOOKING_ID}:race-4280`,
            amountCents: CHARGE_A_CENTS,
            completedAt: NIGHT,
            completedByMemberId: OFFICER_ID,
            reason: "Card refund shortfall paid back (race 4280)",
          },
        });

        // The dead row's refund, made after all and recorded late: it fills the slice.
        const late = await stripeRefund("re_race_4280_no_close", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [late]);
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });
        await deliverRefusal(late, "failed");

        expect(await mirrors()).toEqual({ payment: 0, charges: { [TXN_A]: 0 }, retained: CHARGE_A_CENTS });
        // The dead row that counted it owes it again, on its next key: owed once.
        expect(await raisedRows()).toEqual([]);
        expect(await owedNow()).toBe(CHARGE_A_CENTS);
      });
    });

    // -------------------------------------------------------------- races

    /** Hold the Payment row on a third connection; the writers queue behind it. */
    async function holdPaymentRow() {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: (pid: number) => void;
      const pid = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const held = lockHolderClient.$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${PAYMENT_ID} FOR NO KEY UPDATE`;
          ready(row!.pid);
          await released;
        },
        { timeout: 20_000 },
      );
      return { pid: await pid, release, held };
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

    describe("the close and the late refund racing on the payment row", () => {
      it("close first: the late refund is capped, and its failure leaves the close's $200", async () => {
        await seedPayment({ charges: [A] });
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        const late = await stripeRefund("re_race_4280_race_close_first", A, CHARGE_A_CENTS, "pending");

        const [closed, synced] = await inOrder(() => close(OP_ID, CHARGE_A_CENTS), () => syncCharge(A, [late]));
        expect(closed.ok && synced.ok).toBe(true);
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });

        await deliverRefusal(late, "failed");
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });
        expect(await raisedRows()).toEqual([rowOfItsOwn(late.id, CHARGE_A_CENTS)]);
        expect(await owedNow()).toBe(0);
      });

      it("refund first: the close reads it and refuses, so no bank cash is recorded - and its failure leaves nothing, owed once", async () => {
        await seedPayment({ charges: [A] });
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        const late = await stripeRefund("re_race_4280_race_refund_first", A, CHARGE_A_CENTS, "pending");

        const [synced, closed] = await inOrder(() => syncCharge(A, [late]), () => close(OP_ID, CHARGE_A_CENTS));
        expect(synced.ok).toBe(true);
        expect(closed).toMatchObject({ ok: false, error: { status: 409 } });
        expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });

        await deliverRefusal(late, "failed");
        expect(await mirrors()).toEqual({ payment: 0, charges: { [TXN_A]: 0 }, retained: CHARGE_A_CENTS });
        // The dead row that counted it is moved to its next key: it owes it, once.
        expect(await raisedRows()).toEqual([]);
        expect(await owedNow()).toBe(CHARGE_A_CENTS);
      });
    });

    describe("a late refund's failure racing a second close on the same payment", () => {
      async function seedTwoCloses() {
        await seedPayment({ charges: [A, B] });
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        await seedDeadRefund({ id: OP2_ID, slices: [{ charge: B, cents: CHARGE_B_CENTS }], idempotencyKey: `race_4280_second_refund_${BOOKING_ID}` });
        await close(OP_ID, CHARGE_A_CENTS);
        // A refund made by hand in the dashboard on the closed charge, recorded late: capped.
        const late = await stripeRefund("re_race_4280_race_second", A, CHARGE_A_CENTS, "pending", { madeBy: null });
        await syncCharge(A, [late]);
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS, [TXN_B]: 0 }, retained: CHARGE_B_CENTS });
        expect(await owedNow()).toBe(CHARGE_B_CENTS);
        return late;
      }

      it.each([
        ["the failure first", "failure"],
        ["the second close first", "close"],
      ] as const)("%s: both closes' cash stays, each on its own charge", async (_name, firstWriter) => {
        const late = await seedTwoCloses();
        const failure = () => deliverRefusal(late, "failed");
        const secondClose = () => close(OP2_ID, CHARGE_B_CENTS);

        const settled = firstWriter === "failure" ? await inOrder(failure, secondClose) : await inOrder(secondClose, failure);
        for (const outcome of settled) {
          if (!outcome.ok) throw outcome.error;
        }

        expect(await mirrors()).toEqual({ payment: 30_000, charges: { [TXN_A]: CHARGE_A_CENTS, [TXN_B]: CHARGE_B_CENTS }, retained: 0 });
        expect(await refundStatus(late.id)).toBe("failed");
        expect(await raisedRows()).toEqual([]);
        expect(await owedNow()).toBe(0);
        expect(await auditFinding()).toBeNull();
      });
    });

    describe("rollback", () => {
      it("a failure recorded on a caller's transaction that rolls back changes nothing; delivered again, it keeps the close's cash", async () => {
        await seedPayment({ charges: [A] });
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        await close(OP_ID, CHARGE_A_CENTS);
        const late = await stripeRefund("re_race_4280_rollback", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [late]);

        let readInside: number | null = null;
        await expect(
          prisma.$transaction(async (tx) => {
            await recordStripeRefundsAgainstTransaction({
              paymentId: PAYMENT_ID,
              paymentTransactionId: TXN_A,
              refunds: [{ ...late, status: "failed" } as never],
              fallbackPaymentIntentId: INTENT_A,
              store: tx,
            });
            // Inside the caller's transaction the subtraction is already floored at the close's
            // cash. That the floor reads the close records on this client is pinned by the unit
            // test's `manualRefundTask.groupBy` assertion (`payment-transactions-refunds.test.ts`),
            // not by this figure, which a committed close would give on any client.
            readInside = (await tx.paymentTransaction.findUniqueOrThrow({ where: { id: TXN_A } })).refundedAmountCents;
            throw new Error("the caller rolls back");
          }),
        ).rejects.toThrow("the caller rolls back");
        expect(readInside).toBe(CHARGE_A_CENTS);
        expect(await refundStatus(late.id)).toBe("pending");
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });
        expect(await raisedRows()).toEqual([]);

        await deliverRefusal(late, "failed");
        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });
        expect(await raisedRows()).toEqual([rowOfItsOwn(late.id, CHARGE_A_CENTS)]);
      });

      it("two deliveries of the failure at once take it out once, write one row, and keep the close's cash", async () => {
        await seedPayment({ charges: [A] });
        await seedDeadRefund({ slices: [{ charge: A, cents: CHARGE_A_CENTS }] });
        await close(OP_ID, CHARGE_A_CENTS);
        const late = await stripeRefund("re_race_4280_twice", A, CHARGE_A_CENTS, "pending");
        await syncCharge(A, [late]);

        const settled = await inOrder(() => deliverRefusal(late, "failed"), () => deliverRefusal(late, "failed"));
        for (const outcome of settled) {
          if (!outcome.ok) throw outcome.error;
        }

        expect(await mirrors()).toEqual({ payment: CHARGE_A_CENTS, charges: { [TXN_A]: CHARGE_A_CENTS }, retained: 0 });
        expect(await raisedRows()).toEqual([rowOfItsOwn(late.id, CHARGE_A_CENTS)]);
        expect(await owedNow()).toBe(0);
      });
    });
  },
);
