/**
 * Real-PostgreSQL proof of the booking ledger's settlement sync (#3581).
 *
 * The planner and the sync have focused unit tests; what a mock cannot show is
 * the WHOLE path through the real chokepoint — `reconcilePaymentAggregates`,
 * which every capture, receipt and refund writer ends in — against real rows,
 * with the write door's `ON CONFLICT DO NOTHING` and the table's constraints
 * doing their real work. Four claims:
 *
 *  1. A captured card transaction posts one CARD_CAPTURE line, and running the
 *     chokepoint again posts nothing more.
 *  2. A manual mark-paid posts CASH_RECORDED naming the officer; flipping that
 *     row to FAILED (what a mark-paid reversal does) posts exactly ONE reversal,
 *     and a further run posts nothing.
 *  3. A recorded refund posts CARD_REFUND; the refund later failing posts its
 *     reversal.
 *  4. After the chokepoint runs, the ledger's settled total equals the mirror's
 *     own `amountCents - refundedAmountCents` — the identity C4 (#3583) checks,
 *     proved here for the rows this child posts.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3581-member";
const OFFICER_ID = "race-3581-officer";
const LODGE_ID = "race-3581-lodge";
const BOOKING_ID = "race-3581-booking";
const PAYMENT_ID = "race-3581-payment";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeSettlementSyncRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Settlement-sync proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run settlement-sync proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Settlement-sync proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Settlement-sync proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let reconcilePaymentAggregates: typeof import("@/lib/payment-transactions")["reconcilePaymentAggregates"];
let upsertPaymentIntentTransaction: typeof import("@/lib/payment-transactions")["upsertPaymentIntentTransaction"];

async function lines() {
  return prisma.bookingLedgerLine.findMany({
    where: { bookingId: BOOKING_ID },
    orderBy: { postedAt: "asc" },
    select: { kind: true, sign: true, amountCents: true, postingKey: true, reversesLineId: true, postedByMemberId: true, settlementMethod: true },
  });
}

async function settledCents(): Promise<number> {
  const rows = await prisma.bookingLedgerLine.findMany({
    where: { bookingId: BOOKING_ID, side: "SETTLEMENT" },
    select: { amountCents: true },
  });
  return rows.reduce((sum, row) => sum + row.amountCents, 0);
}

async function resetPayment(): Promise<void> {
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.payment.create({
    data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 0, source: "STRIPE", status: "PENDING" },
  });
}

(RUN ? describe : describe.skip)(
  "the booking ledger's settlement lines converge at the real chokepoint (#3581)",
  () => {
    beforeAll(async () => {
      assertSafeSettlementSyncRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ reconcilePaymentAggregates, upsertPaymentIntentTransaction } = await import("@/lib/payment-transactions"));

      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Settlement",
            lastName: "Proof",
            ageTier: "ADULT",
          },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3581 Lodge", slug: "race-3581" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CONFIRMED",
          totalPriceCents: 10_000,
          finalPriceCents: 10_000,
        },
      });
    });

    beforeEach(resetPayment);

    afterAll(async () => {
      if (!prisma) return;
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    });

    it("posts one card capture per captured transaction, and nothing more on a second run", async () => {
      await prisma.paymentTransaction.create({
        data: { id: "race-3581-txn-card", paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", amountCents: 10_000, status: "SUCCEEDED" },
      });
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });
      expect(await lines()).toEqual([
        expect.objectContaining({ kind: "CARD_CAPTURE", sign: 1, amountCents: 10_000, postingKey: "capture:race-3581-txn-card", settlementMethod: "CARD" }),
      ]);
    });

    it("posts through a REAL writer — the card-capture upsert the webhook uses — not only a hand-built row", async () => {
      // Review of #3604: the suite built rows by hand and called the chokepoint
      // directly, which is how a writer that never reaches it went unnoticed.
      await upsertPaymentIntentTransaction({
        paymentId: PAYMENT_ID,
        kind: "PRIMARY",
        paymentIntentId: "pi_race_3581_writer",
        amountCents: 8_000,
        status: "SUCCEEDED",
        store: prisma,
      });
      // A webhook redelivery: the same upsert again.
      await upsertPaymentIntentTransaction({
        paymentId: PAYMENT_ID,
        kind: "PRIMARY",
        paymentIntentId: "pi_race_3581_writer",
        amountCents: 8_000,
        status: "SUCCEEDED",
        store: prisma,
      });
      const posted = await lines();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ kind: "CARD_CAPTURE", amountCents: 8_000 });
    });

    it("posts a row paid AGAIN after its mark-paid was reversed, keyed off the reversal", async () => {
      // Review of #3604: a reversed mark-paid's row can be revived by a Xero
      // payment; the first cut saw its key taken and posted nothing.
      await prisma.payment.update({
        where: { id: PAYMENT_ID },
        data: { source: "INTERNET_BANKING", manuallyMarkedPaidAt: new Date("2026-06-01T00:00:00.000Z"), manuallyMarkedPaidByMemberId: OFFICER_ID },
      });
      await prisma.paymentTransaction.create({
        data: { id: "race-3581-txn-revived", paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 10_000, status: "SUCCEEDED", reason: "manual_mark_paid" },
      });
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });
      // The reversal.
      await prisma.paymentTransaction.update({ where: { id: "race-3581-txn-revived" }, data: { status: "FAILED", reason: "manual_mark_paid_reversed" } });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null } });
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });
      // The member then pays through Xero, which revives the same row.
      await prisma.paymentTransaction.update({ where: { id: "race-3581-txn-revived" }, data: { status: "SUCCEEDED" } });
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });

      const posted = await lines();
      expect(posted.map((l) => l.kind)).toEqual(["CASH_RECORDED", "CASH_RECORDED", "BANK_RECEIPT"]);
      expect(posted[2]?.postingKey).toMatch(/^capture:race-3581-txn-revived:after:/);
      expect(await settledCents()).toBe(10_000);
    });

    it("posts a manual mark-paid as cash, and its reversal exactly once when the row is flipped to FAILED", async () => {
      await prisma.payment.update({
        where: { id: PAYMENT_ID },
        data: { source: "INTERNET_BANKING", manuallyMarkedPaidAt: new Date("2026-06-01T00:00:00.000Z"), manuallyMarkedPaidByMemberId: OFFICER_ID },
      });
      await prisma.paymentTransaction.create({
        data: { id: "race-3581-txn-cash", paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 10_000, status: "SUCCEEDED", reason: "manual_mark_paid" },
      });
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });
      const [cash] = await lines();
      expect(cash).toMatchObject({ kind: "CASH_RECORDED", settlementMethod: "CASH", postedByMemberId: OFFICER_ID, amountCents: 10_000 });

      // What a mark-paid reversal does to the row, and to the provenance.
      await prisma.paymentTransaction.update({
        where: { id: "race-3581-txn-cash" },
        data: { status: "FAILED", reason: "manual_mark_paid_reversed" },
      });
      await prisma.payment.update({
        where: { id: PAYMENT_ID },
        data: { manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
      });
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });

      const after = await lines();
      expect(after).toHaveLength(2);
      // The reversal copies the cash line — it does not re-read the row, whose
      // provenance now says "not manual".
      expect(after[1]).toMatchObject({ kind: "CASH_RECORDED", settlementMethod: "CASH", sign: -1, amountCents: -10_000 });
      expect(await settledCents()).toBe(0);
    });

    it("posts a recorded refund, and reverses it when the refund later fails — while the mirror keeps counting it", async () => {
      await prisma.paymentTransaction.create({
        data: { id: "race-3581-txn-refunded", paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", amountCents: 10_000, status: "PARTIALLY_REFUNDED", refundedAmountCents: 2_500 },
      });
      await prisma.paymentRefund.create({
        data: { id: "race-3581-refund", paymentId: PAYMENT_ID, paymentTransactionId: "race-3581-txn-refunded", stripeRefundId: "re_race_3581", amountCents: 2_500, currency: "nzd", status: "succeeded" },
      });
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });
      expect((await lines()).map((l) => l.kind).sort()).toEqual(["CARD_CAPTURE", "CARD_REFUND"]);

      // Only the refund's status changes. The transaction's own refunded figure
      // is left exactly as production leaves it: every writer of that column
      // takes a max including its previous value, so it never goes down. The
      // first cut of this test hand-reset it to 0 — which no writer does — and
      // so hid the divergence below (review of #3604).
      await prisma.paymentRefund.update({ where: { id: "race-3581-refund" }, data: { status: "failed" } });
      const mirror = await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });
      const after = await lines();
      expect(after.filter((l) => l.kind === "CARD_REFUND").map((l) => l.sign).sort()).toEqual([-1, 1]);

      // THE KNOWN DIVERGENCE, pinned rather than hidden: the ledger says no
      // money went back; the mirror still says 2,500 did. INV-PAY-050 already
      // names that column as not cash evidence, and C4 (#3583) must classify
      // this difference, not assert an identity across it.
      expect(await settledCents()).toBe(10_000);
      expect(mirror?.refundedAmountCents).toBe(2_500);
    });

    it("matches the mirror's own arithmetic where both read the same rows: captures, and refunds with a refund row", async () => {
      await prisma.paymentTransaction.createMany({
        data: [
          { id: "race-3581-parity-card", paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", amountCents: 10_000, status: "PARTIALLY_REFUNDED", refundedAmountCents: 2_500 },
          { id: "race-3581-parity-extra", paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", amountCents: 3_000, status: "SUCCEEDED" },
          { id: "race-3581-parity-pending", paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", amountCents: 999, status: "PENDING" },
        ],
      });
      await prisma.paymentRefund.create({
        data: { id: "race-3581-parity-refund", paymentId: PAYMENT_ID, paymentTransactionId: "race-3581-parity-card", stripeRefundId: "re_race_3581_parity", amountCents: 2_500, currency: "nzd", status: "succeeded" },
      });
      const mirror = await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });
      expect(mirror).not.toBeNull();
      expect(await settledCents()).toBe((mirror?.amountCents ?? 0) - (mirror?.refundedAmountCents ?? 0));
    });
  },
);
