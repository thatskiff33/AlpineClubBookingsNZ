/**
 * Real-PostgreSQL proof of the "Paid another way" close (#3372, owner 7 Oct
 * 2026: "Count + add close action").
 *
 * `closeCardRefundPaidAnotherWay` takes `lock(1)`, re-reads the operation, and
 * claims it with a status-guarded `updateMany` before it records any money. A
 * double click is two closes of one dead card refund at once: the global key
 * queues the second behind the first, and the second must then read the
 * operation closed and write NOTHING - no second allocation on the payment, no
 * second audit row. A mock can only imitate that queueing; this runs it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-3372-paw-` fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3372-paw-member";
const OFFICER_ID = "race-3372-paw-officer";
const LODGE_ID = "race-3372-paw-lodge";
const BOOKING_ID = "race-3372-paw-booking";
const PAYMENT_ID = "race-3372-paw-payment";
const TRANSACTION_ID = "race-3372-paw-txn";
const OPERATION_ID = "race-3372-paw-op";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");

const PAID_CENTS = 20_000;
// Small beside the payment, so a second allocation would still fit its headroom:
// only the claim can stop it.
const REFUND_CENTS = 5_000;

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Paid-another-way race proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run paid-another-way race proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Paid-another-way race proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Paid-another-way race proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let closeCardRefundPaidAnotherWay: (typeof import("@/lib/card-refund-paid-another-way"))["closeCardRefundPaidAnotherWay"];
let CardRefundPaidAnotherWayError: (typeof import("@/lib/card-refund-paid-another-way"))["CardRefundPaidAnotherWayError"];
let openCardRefundOwedCents: (typeof import("@/lib/open-card-refund-owed"))["openCardRefundOwedCents"];
let netCollectedCardRefundSelect: (typeof import("@/lib/additional-ledger-gap"))["netCollectedCardRefundSelect"];

(RUN ? describe : describe.skip)(
  "a dead card refund closes as paid another way exactly once — real PostgreSQL (#3372)",
  { timeout: 20_000 },
  () => {
    async function deleteFixtures() {
      await prisma.auditLog.deleteMany({ where: { entityId: OPERATION_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { id: OPERATION_ID } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    async function owedNow(): Promise<number> {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });
      return openCardRefundOwedCents(payment);
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ closeCardRefundPaidAnotherWay, CardRefundPaidAnotherWayError } = await import(
        "@/lib/card-refund-paid-another-way"
      ));
      ({ openCardRefundOwedCents } = await import("@/lib/open-card-refund-owed"));
      ({ netCollectedCardRefundSelect } = await import("@/lib/additional-ledger-gap"));

      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Refund",
            lastName: "Proof",
            ageTier: "ADULT",
          },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3372 PAW Lodge", slug: "race-3372-paw" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CANCELLED",
          totalPriceCents: PAID_CENTS,
          finalPriceCents: PAID_CENTS,
        },
      });
    });

    beforeEach(async () => {
      await prisma.auditLog.deleteMany({ where: { entityId: OPERATION_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { id: OPERATION_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      // No Xero invoice: the close queues no note, so no outbox is involved.
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "STRIPE", status: "SUCCEEDED" },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: TRANSACTION_ID,
          paymentId: PAYMENT_ID,
          kind: "PRIMARY",
          source: "STRIPE",
          stripePaymentIntentId: "pi_race_3372_paw",
          amountCents: PAID_CENTS,
          status: "SUCCEEDED",
        },
      });
      // The cancellation's card refund, its five attempts spent.
      await prisma.paymentRecoveryOperation.create({
        data: {
          id: OPERATION_ID,
          type: "REFUND_BOOKING_MODIFICATION",
          status: "FAILED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: "pi_race_3372_paw",
          amountCents: REFUND_CENTS,
          allocationPlan: [{ paymentTransactionId: TRANSACTION_ID, amountCents: REFUND_CENTS }],
          idempotencyKey: `booking_cancel_refund_recovery_${BOOKING_ID}`,
          attempts: 5,
          nextRetryAt: null,
        },
      });
      expect(await owedNow()).toBe(REFUND_CENTS);
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    });

    const close = () =>
      closeCardRefundPaidAnotherWay({
        operationId: OPERATION_ID,
        amountCents: REFUND_CENTS,
        note: "Bank transfer, ref RACE",
        actingMemberId: OFFICER_ID,
      });

    it("a double click closes once: one allocation, one audit row, the other refused", async () => {
      const settled = await Promise.allSettled([close(), close()]);

      const fulfilled = settled.filter((outcome) => outcome.status === "fulfilled");
      const rejected = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(CardRefundPaidAnotherWayError);
      expect((rejected[0]?.reason as { status: number }).status).toBe(409);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });
      expect(payment.refundedAmountCents).toBe(REFUND_CENTS);
      const operation = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: OPERATION_ID } });
      expect(operation.status).toBe("SUCCEEDED");
      expect(operation.nextRetryAt).toBeNull();
      expect(await prisma.auditLog.count({ where: { entityId: OPERATION_ID } })).toBe(1);
      // It has left "Refunds owed": nothing is owed by card any more.
      expect(await owedNow()).toBe(0);
    });

    it("a refund still being retried is refused and nothing is written", async () => {
      await prisma.paymentRecoveryOperation.update({ where: { id: OPERATION_ID }, data: { attempts: 4 } });

      await expect(close()).rejects.toMatchObject({ status: 409 });

      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });
      expect(payment.refundedAmountCents).toBe(0);
      const operation = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: OPERATION_ID } });
      expect(operation.status).toBe("FAILED");
      expect(await prisma.auditLog.count({ where: { entityId: OPERATION_ID } })).toBe(0);
    });
  },
);
