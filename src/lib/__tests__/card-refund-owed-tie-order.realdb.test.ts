/**
 * Real-PostgreSQL proof of #4284 (`INV-PAY-121`): the card-refund owed figure
 * reads a `createdAt` tie the same way whatever order PostgreSQL keeps the rows in.
 *
 * Neither `PaymentRecoveryOperation` nor `PaymentRefund` has an insertion
 * sequence, and rows written in one transaction share a `createdAt`. Each case
 * here writes the same tied rows twice, in opposite insertion orders, so the
 * table's physical order - what an unordered read returns - is reversed between
 * the two runs (asserted on `ctid`, so the case cannot pass without forcing both
 * orders). The figure is read through the real Net Collected select
 * (`netCollectedCardRefundSelect`) and must come out the same both times.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4284-` fixtures. No provider is called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4284-member";
const LODGE_ID = "race-4284-lodge";
const BOOKING_ID = "race-4284-booking";
const PAYMENT_ID = "race-4284-payment";
const TXN_ID = "race-4284-txn";
const INTENT_ID = "pi_race_4284";
const PAID_CENTS = 20_000;
const SLICE_CENTS = 5_000;
/** One instant for every tied row: what one ledger write stamps on each. */
const TIED_AT = new Date("2026-06-20T00:00:00.000Z");
const RECORDED_AT = new Date("2026-06-20T00:00:30.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Owed-figure tie proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run owed-figure tie proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Owed-figure tie proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Owed-figure tie proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let netCollectedCardRefundSelect: (typeof import("@/lib/additional-ledger-gap"))["netCollectedCardRefundSelect"];
let openCardRefundOwedByOperation: (typeof import("@/lib/open-card-refund-owed"))["openCardRefundOwedByOperation"];
let cardRefundSliceFilledBy: (typeof import("@/lib/open-card-refund-owed"))["cardRefundSliceFilledBy"];

const OP_A = "race-4284-op-a";
const OP_B = "race-4284-op-b";
const OP_OLD = "race-4284-op-old";
const OP_NEW = "race-4284-op-new";
const RE_X = "re_race_4284_x";
const RE_Y = "re_race_4284_y";
const RE_RESEND = "re_race_4284_resend";

(RUN ? describe : describe.skip)(
  "the card-refund owed figure reads a createdAt tie the same in either physical order — real PostgreSQL (#4284)",
  { timeout: 30_000 },
  () => {
    async function deletePaymentRows() {
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** An open card refund row owing one slice of the capture. */
    async function openRow(id: string, createdAt: Date) {
      await prisma.paymentRecoveryOperation.create({
        data: {
          id,
          type: "REFUND_BOOKING_MODIFICATION",
          status: "FAILED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: INTENT_ID,
          amountCents: SLICE_CENTS,
          idempotencyKey: `card_refund_failed_later_${id}`,
          allocationPlan: [{ paymentTransactionId: TXN_ID, amountCents: SLICE_CENTS }],
          createdAt,
          nextRetryAt: null,
        },
      });
    }

    /** A refund recorded on the capture, not marked on any slice. */
    async function recordedRefund(stripeRefundId: string) {
      await prisma.paymentRefund.create({
        data: {
          paymentId: PAYMENT_ID,
          paymentTransactionId: TXN_ID,
          stripeRefundId,
          stripePaymentIntentId: INTENT_ID,
          amountCents: SLICE_CENTS,
          currency: "nzd",
          status: "succeeded",
          stripeCreatedAt: RECORDED_AT,
          createdAt: RECORDED_AT,
        },
      });
    }

    /** The table's physical order: what a read with no `orderBy` meets the rows in. */
    async function physicalOrder(table: "operations" | "refunds"): Promise<string[]> {
      const rows =
        table === "operations"
          ? await prisma.$queryRaw<Array<{ key: string }>>`
              SELECT "id" AS key FROM "PaymentRecoveryOperation" WHERE "paymentId" = ${PAYMENT_ID} ORDER BY ctid`
          : await prisma.$queryRaw<Array<{ key: string }>>`
              SELECT "stripeRefundId" AS key FROM "PaymentRefund" WHERE "paymentId" = ${PAYMENT_ID} ORDER BY ctid`;
      return rows.map((row) => row.key);
    }

    const readPayment = () =>
      prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ netCollectedCardRefundSelect } = await import("@/lib/additional-ledger-gap"));
      ({ openCardRefundOwedByOperation, cardRefundSliceFilledBy } = await import("@/lib/open-card-refund-owed"));

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Tie",
          lastName: "Order",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4284 Lodge", slug: "race-4284" } });
    });

    beforeEach(async () => {
      await deletePaymentRows();
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: new Date("2026-08-01T00:00:00.000Z"),
          checkOut: new Date("2026-08-02T00:00:00.000Z"),
          status: "PAID",
          totalPriceCents: PAID_CENTS,
          finalPriceCents: PAID_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PAID_CENTS,
          refundedAmountCents: 0,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: INTENT_ID,
          transactions: {
            create: {
              id: TXN_ID,
              kind: "PRIMARY",
              source: "STRIPE",
              stripePaymentIntentId: INTENT_ID,
              amountCents: PAID_CENTS,
              status: "SUCCEEDED",
              createdAt: new Date("2026-05-01T00:00:00.000Z"),
            },
          },
        },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    });

    describe("two rows raised in one write (the #4284 failure scenario)", () => {
      const seen: Array<{ physical: string[]; owed: Record<string, number> }> = [];

      it.each([
        { name: "a then b", order: [OP_A, OP_B] },
        { name: "b then a", order: [OP_B, OP_A] },
      ])("written $name: the one recorded re-send fills the same row", async ({ order }) => {
        for (const id of order) await openRow(id, TIED_AT);
        await recordedRefund(RE_RESEND);
        await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: SLICE_CENTS, status: "PARTIALLY_REFUNDED" } });

        const physical = await physicalOrder("operations");
        expect(physical).toEqual(order);
        const payment = await readPayment();
        // The read itself asks for the one order (`CARD_REFUND_OPERATION_ORDER_BY`).
        expect(payment.recoveryOperations.map((row) => row.id)).toEqual([OP_A, OP_B]);
        const owed = Object.fromEntries(openCardRefundOwedByOperation(payment));
        // `id` breaks the tie: the later id is the "most recent" row and takes the re-send.
        expect(owed).toEqual({ [OP_A]: SLICE_CENTS, [OP_B]: 0 });
        // Fed in the physical order instead, the attribution's own sort still decides.
        const byPhysical = { ...payment, recoveryOperations: physical.map((id) => payment.recoveryOperations.find((row) => row.id === id)!) };
        expect(Object.fromEntries(openCardRefundOwedByOperation(byPhysical))).toEqual(owed);
        seen.push({ physical, owed });
      });

      it("forced both physical orders, and read the same figure from each", () => {
        expect(seen).toHaveLength(2);
        expect(seen[0]?.physical).toEqual([...(seen[1]?.physical ?? [])].reverse());
        expect(seen[0]?.owed).toEqual(seen[1]?.owed);
      });
    });

    describe("two refunds recorded in one write", () => {
      const seen: Array<{ physical: string[]; filledBy: Record<string, string | undefined> }> = [];

      it.each([
        { name: "x then y", order: [RE_X, RE_Y] },
        { name: "y then x", order: [RE_Y, RE_X] },
      ])("written $name: each refund fills the same row", async ({ order }) => {
        await openRow(OP_OLD, TIED_AT);
        await openRow(OP_NEW, new Date(TIED_AT.getTime() + 1_000));
        for (const id of order) await recordedRefund(id);
        await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 2 * SLICE_CENTS, status: "PARTIALLY_REFUNDED" } });

        const physical = await physicalOrder("refunds");
        expect(physical).toEqual(order);
        const payment = await readPayment();
        expect(payment.refunds.map((refund) => refund.stripeRefundId)).toEqual([RE_X, RE_Y]);
        const filledBy = {
          [RE_X]: cardRefundSliceFilledBy(payment, RE_X)?.operation.id,
          [RE_Y]: cardRefundSliceFilledBy(payment, RE_Y)?.operation.id,
        };
        // `stripeRefundId` breaks the tie: the first goes to the newest row, the second to the older.
        expect(filledBy).toEqual({ [RE_X]: OP_NEW, [RE_Y]: OP_OLD });
        const byPhysical = { ...payment, refunds: physical.map((id) => payment.refunds.find((refund) => refund.stripeRefundId === id)!) };
        expect(cardRefundSliceFilledBy(byPhysical, RE_X)?.operation.id).toBe(OP_NEW);
        expect(cardRefundSliceFilledBy(byPhysical, RE_Y)?.operation.id).toBe(OP_OLD);
        seen.push({ physical, filledBy });
      });

      it("forced both physical orders, and attributed each refund the same in each", () => {
        expect(seen).toHaveLength(2);
        expect(seen[0]?.physical).toEqual([...(seen[1]?.physical ?? [])].reverse());
        expect(seen[0]?.filledBy).toEqual(seen[1]?.filledBy);
      });
    });
  },
);
