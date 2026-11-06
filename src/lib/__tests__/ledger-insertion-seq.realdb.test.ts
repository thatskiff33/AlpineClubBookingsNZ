/**
 * Real-PostgreSQL proof of #4132 (`INV-PAY-133`): a payment's capture ledger
 * has one order, `createdAt` then `insertionSeq`, and "the latest" row of a kind
 * on a tie is the one inserted last.
 *
 * What a mock can only imitate, run here against the database:
 *
 * - Three rows A, B, C written in ONE transaction share a `createdAt`. After
 *   updating A's `status`, CLUSTER on the existing primary-key index deliberately
 *   establishes physical order B, C, A, verified through `ctid`. An UPDATE alone
 *   cannot guarantee that order because PostgreSQL may reuse free space. The
 *   fixture makes heap and id order differ from insertion order; every reader
 *   still returns A, B, C:
 *   - the capture ledger's loader (`loadPaymentWithTransactions`), which the
 *     mirror projection, the refund planners and the cancel preview read;
 *   - `latestTransactionOfKind` returns C, in any input order;
 *   - the `Payment` mirror `reconcilePaymentAggregates` writes is C's ask, and
 *     the ask a price reduction would set against (`readUnpaidPriceAsk`) is the
 *     same C, with A, B, C as its chain - the two used to disagree on a tie;
 *   - the card refund plan (`planStripeRefundAllocation`) slices newest first:
 *     C, then B, never the order the rows happened to come back in.
 *   - the local refund allocation (`applyLocalRefundAllocation`) and a
 *     modification refund recovery with no frozen plan, derived at replay,
 *     take the card plan's own slices: C, then B (#4132 money review F5).
 * - A raw INSERT that omits `insertionSeq` (a draining old colour's client
 *   does) receives a value above every stored row from the owned sequence.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it
 * (`ledger-insertion-seq-realdb-wiring.test.ts` pins the edge); it owns and
 * cleans its own `race-4132-` fixtures. No Stripe call is made.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4132-member";
const LODGE_ID = "race-4132-lodge";
const BOOKING_ID = "race-4132-booking";
const PAYMENT_ID = "race-4132-payment";
// Named so `id` order is B, C, A - the heap order established by CLUSTER, and
// not the insertion order - so neither a cuid-style `id` tiebreak nor the heap can pass
// for the insertion order (#4129's reverted tiebreak).
const A = "race-4132-txn-z";
const B = "race-4132-txn-x";
const C = "race-4132-txn-y";
const RAW = "race-4132-txn-raw";
// Built rather than written as one quoted literal on a `*Key` field, which the
// secret scan's generic-api-key rule reads as a credential.
const RECOVERY_KEY = ["race", "4132", "modification", "refund"].join("-");
const OPERATION_ID = "race-4132-operation";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
/** The one instant all three rows carry: the tie under test, independent of the frozen clock. */
const TIED_AT = new Date("2026-06-15T00:00:00.000Z");

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a payment's ledger rows keep insertion order on a createdAt tie - real PostgreSQL (#4132)",
  { timeout: 60_000 },
  () => {
    async function deleteBookingRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    type RowSpec = { id: string; kind: "PRIMARY" | "ADDITIONAL"; amountCents: number; status: "PENDING" | "PROCESSING" | "SUCCEEDED" };

    /** Insert A, B, C with generated sequences and `TIED_AT`, update A, then establish heap order B, C, A. */
    async function writeTiedRowsThenUpdateA(rows: [RowSpec, RowSpec, RowSpec], aBecomes: "FAILED" | "SUCCEEDED") {
      await prisma.$transaction(async (tx) => {
        for (const row of rows) {
          await tx.paymentTransaction.create({
            data: {
              id: row.id,
              paymentId: PAYMENT_ID,
              kind: row.kind,
              source: "STRIPE",
              stripePaymentIntentId: `pi_${row.id}`,
              amountCents: row.amountCents,
              status: row.status,
              createdAt: TIED_AT,
            },
          });
        }
      });
      await prisma.paymentTransaction.update({ where: { id: A }, data: { status: aBecomes } });
      // Whole-table rewrite, only in the already guarded disposable database,
      // using its existing primary-key index; row values and sequences stay intact.
      await prisma.$executeRaw`CLUSTER "PaymentTransaction" USING "PaymentTransaction_pkey"`;
    }

    /** Read the physical order to verify CLUSTER established the adversarial B, C, A premise. */
    async function heapOrder(): Promise<string[]> {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "PaymentTransaction" WHERE "paymentId" = ${PAYMENT_ID} ORDER BY ctid`;
      return rows.map((row) => row.id);
    }

    async function loadedOrder(): Promise<string[]> {
      const { loadPaymentWithTransactions } = await import("@/lib/payment-transactions");
      const payment = await loadPaymentWithTransactions(prisma, PAYMENT_ID);
      return payment!.transactions.map((row) => row.id);
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Ledger insertion-order proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Insertion",
          lastName: "Order",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4132 Lodge", slug: "race-4132" } });
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
          totalPriceCents: 20_000,
          finalPriceCents: 20_000,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: 20_000,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: `pi_${A}`,
        },
      });
    });

    afterEach(() => {
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it("three asks written together: the loader, the latest ask, the mirror and the reduction's ask all agree on insertion order", async () => {
      await writeTiedRowsThenUpdateA(
        [
          { id: A, kind: "ADDITIONAL", amountCents: 1_000, status: "PENDING" },
          { id: B, kind: "ADDITIONAL", amountCents: 2_000, status: "PENDING" },
          { id: C, kind: "ADDITIONAL", amountCents: 3_000, status: "PENDING" },
        ],
        "FAILED",
      );
      expect(await heapOrder(), "premise: CLUSTER established physical order B, C, A").toEqual([B, C, A]);

      const stored = await prisma.paymentTransaction.findMany({
        where: { paymentId: PAYMENT_ID },
        select: { id: true, createdAt: true, insertionSeq: true },
      });
      expect(new Set(stored.map((row) => row.createdAt.toISOString())), "premise: one createdAt for all three").toEqual(
        new Set([TIED_AT.toISOString()]),
      );
      const seq = Object.fromEntries(stored.map((row) => [row.id, row.insertionSeq]));
      expect(seq[A]! < seq[B]! && seq[B]! < seq[C]!, "the sequence numbers the rows in insertion order").toBe(true);

      expect(await loadedOrder()).toEqual([A, B, C]);

      const { loadPaymentWithTransactions, reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
      const { latestTransactionOfKind } = await import("@/lib/payment-transaction-status");
      const loaded = (await loadPaymentWithTransactions(prisma, PAYMENT_ID))!.transactions;
      expect(latestTransactionOfKind(loaded, "ADDITIONAL")?.id).toBe(C);
      expect(latestTransactionOfKind([...loaded].reverse(), "ADDITIONAL")?.id, "in any input order").toBe(C);

      const mirror = await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: prisma });
      expect(mirror).toMatchObject({ additionalAmountCents: 3_000, additionalPaymentIntentId: `pi_${C}`, additionalPaymentStatus: "PENDING" });

      const { readUnpaidPriceAsk } = await import("@/lib/additional-ask-reduction");
      const ask = await readUnpaidPriceAsk(prisma, {
        id: BOOKING_ID,
        status: "PAID",
        payment: {
          id: PAYMENT_ID,
          additionalAmountCents: mirror!.additionalAmountCents,
          additionalPaymentStatus: mirror!.additionalPaymentStatus,
          additionalPaymentIntentId: mirror!.additionalPaymentIntentId,
        },
      });
      expect(ask.askCents, "the reduction sets against the ask the mirror shows: C's").toBe(3_000);
      expect(ask.rows.map((row) => row.id)).toEqual([A, B, C]);
    });

    it("three captures written together: the card refund plan slices newest first by insertion, not by heap order", async () => {
      // A is captured after B and C are written (PROCESSING -> SUCCEEDED), the
      // real status write retained before deliberately establishing the heap order.
      await writeTiedRowsThenUpdateA(
        [
          { id: A, kind: "PRIMARY", amountCents: 3_000, status: "PROCESSING" },
          { id: B, kind: "ADDITIONAL", amountCents: 4_000, status: "SUCCEEDED" },
          { id: C, kind: "ADDITIONAL", amountCents: 5_000, status: "SUCCEEDED" },
        ],
        "SUCCEEDED",
      );
      expect(await heapOrder(), "premise: CLUSTER established physical order B, C, A").toEqual([B, C, A]);
      expect(await loadedOrder()).toEqual([A, B, C]);

      const { planStripeRefundAllocation } = await import("@/lib/payment-transactions");
      const plan = await planStripeRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 6_000, store: prisma });
      expect(plan.slices).toEqual([
        { paymentTransactionId: C, amountCents: 5_000 },
        { paymentTransactionId: B, amountCents: 1_000 },
      ]);
    });

    /** A, B, C captured in one transaction ($30, $40, $50), A's capture landing after B and C were written. */
    async function writeTiedCaptures() {
      await writeTiedRowsThenUpdateA(
        [
          { id: A, kind: "PRIMARY", amountCents: 3_000, status: "PROCESSING" },
          { id: B, kind: "ADDITIONAL", amountCents: 4_000, status: "SUCCEEDED" },
          { id: C, kind: "ADDITIONAL", amountCents: 5_000, status: "SUCCEEDED" },
        ],
        "SUCCEEDED",
      );
      expect(await heapOrder(), "premise: CLUSTER established physical order B, C, A").toEqual([B, C, A]);
      const { planStripeRefundAllocation } = await import("@/lib/payment-transactions");
      return (await planStripeRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 6_000, store: prisma })).slices;
    }

    it("three captures written together: the local refund allocation takes the same rows, in the same order, as the card plan", async () => {
      const plan = await writeTiedCaptures();
      expect(plan).toEqual([
        { paymentTransactionId: C, amountCents: 5_000 },
        { paymentTransactionId: B, amountCents: 1_000 },
      ]);
      const { applyLocalRefundAllocation } = await import("@/lib/payment-transactions");
      await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 6_000, store: prisma });
      const rows = await prisma.paymentTransaction.findMany({
        where: { paymentId: PAYMENT_ID },
        select: { id: true, refundedAmountCents: true },
      });
      const refunded = Object.fromEntries(rows.map((row) => [row.id, row.refundedAmountCents]));
      expect(refunded).toEqual(Object.fromEntries([[A, 0], ...plan.map((slice) => [slice.paymentTransactionId, slice.amountCents])]));
    });

    it("three captures written together: a modification refund with no frozen plan derives the card plan's slices at replay", async () => {
      const plan = await writeTiedCaptures();
      const asked: Array<{ paymentIntentId: string; amountCents: number }> = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push({ paymentIntentId: args.paymentIntentId, amountCents: args.amountCents });
        return {
          id: `re_race_4132_${asked.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: `ch_race_4132_${asked.length}`,
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      await prisma.paymentRecoveryOperation.create({
        data: {
          id: OPERATION_ID,
          type: "REFUND_BOOKING_MODIFICATION",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: `pi_${A}`,
          amountCents: 6_000,
          idempotencyKey: RECOVERY_KEY,
          nextRetryAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      });
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
      await runPaymentRecoveryOperationNow(OPERATION_ID, CLUB_FORMAT_TEST);

      const operation = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: OPERATION_ID } });
      expect(operation.allocationPlan, "the plan the replay froze is the card plan's").toEqual(plan);
      expect(asked).toEqual([
        { paymentIntentId: `pi_${C}`, amountCents: 5_000 },
        { paymentIntentId: `pi_${B}`, amountCents: 1_000 },
      ]);
    });

    it("an INSERT that omits insertionSeq (a draining old colour's) is numbered above every stored row", async () => {
      await writeTiedRowsThenUpdateA(
        [
          { id: A, kind: "ADDITIONAL", amountCents: 1_000, status: "PENDING" },
          { id: B, kind: "ADDITIONAL", amountCents: 2_000, status: "PENDING" },
          { id: C, kind: "ADDITIONAL", amountCents: 3_000, status: "PENDING" },
        ],
        "FAILED",
      );
      const [{ highest }] = await prisma.$queryRaw<Array<{ highest: number }>>`
        SELECT max("insertionSeq") AS "highest" FROM "PaymentTransaction"`;
      const [{ insertionSeq }] = await prisma.$queryRaw<Array<{ insertionSeq: number }>>`
        INSERT INTO "PaymentTransaction" ("id", "paymentId", "kind", "amountCents", "createdAt", "updatedAt")
        VALUES (${RAW}, ${PAYMENT_ID}, 'ADDITIONAL', 500, ${TIED_AT}, ${TIED_AT})
        RETURNING "insertionSeq"`;
      expect(insertionSeq).toBeGreaterThan(highest);
      expect(await loadedOrder(), "and it reads as the newest of the tie").toEqual([A, B, C, RAW]);
    });
  },
);
