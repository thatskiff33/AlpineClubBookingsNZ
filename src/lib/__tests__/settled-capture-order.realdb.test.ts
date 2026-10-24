/**
 * Real-PostgreSQL proof of #4177 (`INV-PAY-133`): when a different card
 * capture arrives on an already-PAID booking with no recorded settler (#4211:
 * paid before `Payment.settledByTransactionId` existed) and several captures
 * could be the one that settled it, the duplicate-capture guard names the
 * OLDEST-INSERTED (`createdAt`, then `insertionSeq`) - the rule #4163 set for
 * the Xero settling capture - whatever order PostgreSQL keeps the rows in. It
 * keeps the arriving capture and the admins' alert names that capture.
 *
 * What a mock can only imitate, run here through the REAL
 * `markBookingPaymentSucceeded`:
 *
 * - Two settled captures, the first inserted before the second. CLUSTER on the
 *   primary key, whose ids are named so the LATER capture sorts first, puts the
 *   later one first in the heap, verified through `ctid`.
 * - **The proof: both captures tied on one `createdAt`**, where only
 *   `insertionSeq` tells them apart. The production read repeated with no
 *   order meets the later capture first, under any plan (a btree keeps equal
 *   keys in heap order): the premise an unordered read gets wrong. The
 *   arriving third capture is kept, nothing is refunded, and the guard's
 *   verdict - what the admins' alert names - is the FIRST capture.
 * - **A regression pin, not a proof: captures created apart.** An index on
 *   `createdAt` can return the first capture without any `orderBy`, so this
 *   case cannot show the order is needed; it pins that the earlier-created
 *   capture is the one named.
 * - The Xero second-instrument conflict's reading of the superseded-intent
 *   machinery (`listSupersededIntentIdsOwningCaptures`): a superseded refund
 *   counts until it SUCCEEDED, a cancel only while in flight
 *   (`PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE`), where guard (b′) counts
 *   both until SUCCEEDED; and (#4221) a capture with a superseded refund
 *   counts while an open row owes money back on it again after a refund
 *   Stripe failed later, whichever door made it: a failed-later row on its
 *   own intent, or an open card refund row's slice on its transaction that
 *   the failure re-planned and nothing has made again. The read's whole shape,
 *   escaped key prefix included, is pinned by the unit suite's
 *   `EXPECTED_READ`; this proves the rows PostgreSQL returns for it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it
 * (`settled-capture-order-realdb-wiring.test.ts` pins the edge); it owns and
 * cleans its own `race-4177-` fixtures. No Stripe call is made: the refund goes
 * to the harness's one shared `@/lib/stripe` double.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4177-member";
const LODGE_ID = "race-4177-lodge";
const BOOKING_ID = "race-4177-booking";
const PAYMENT_ID = "race-4177-payment";
// Named so `id` order puts the LATER capture first: CLUSTER on the primary key
// then makes the heap disagree with insertion order.
const FIRST = "race-4177-txn-z";
const LATER = "race-4177-txn-x";
const ARRIVING = "race-4177-txn-y";
const FIRST_PI = "pi_race_4177_first";
const LATER_PI = "pi_race_4177_later";
const ARRIVING_PI = "pi_race_4177_arriving";
const PRICE_CENTS = 20_000;
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const EARLIER = new Date("2026-06-14T00:00:00.000Z");
const TIED_AT = new Date("2026-06-15T00:00:00.000Z");
/** #4221 round 5: what a capture holds again that nothing owes back (a hand refund that failed later). */
const HELD_UNOWED = 3_000;
const RAISED_AGAIN_AT = new Date("2026-06-16T00:00:00.000Z");
const RESENT_AT = new Date("2026-06-17T00:00:00.000Z");

let prisma: (typeof import("@/lib/prisma"))["prisma"];

/** Every capture on the payment, as the Xero reader weighs what each holds (#4221). */
function capturesOnPayment() {
  return prisma.paymentTransaction.findMany({
    where: { paymentId: PAYMENT_ID },
    select: { stripePaymentIntentId: true, amountCents: true, refundedAmountCents: true },
  });
}

(RUN ? describe : describe.skip)(
  "the duplicate-capture refund names the first-inserted settled capture, not heap order - real PostgreSQL (#4177)",
  { timeout: 60_000 },
  () => {
    async function deleteBookingRows() {
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: BOOKING_ID } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
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

    /**
     * Insert the first settled capture, then the later one (with the given
     * `createdAt`s), then the arriving capture still PROCESSING; then establish
     * a heap order with the later capture ahead of the first.
     */
    async function writeCapturesLaterFirstInHeap(createdAt: { first: Date; later: Date }) {
      const capture = (id: string, paymentIntentId: string, at: Date, status: "SUCCEEDED" | "PROCESSING") => ({
        id,
        paymentId: PAYMENT_ID,
        kind: "PRIMARY" as const,
        source: "STRIPE" as const,
        stripePaymentIntentId: paymentIntentId,
        amountCents: PRICE_CENTS,
        status,
        createdAt: at,
      });
      await prisma.$transaction(async (tx) => {
        await tx.paymentTransaction.create({ data: capture(FIRST, FIRST_PI, createdAt.first, "SUCCEEDED") });
        await tx.paymentTransaction.create({ data: capture(LATER, LATER_PI, createdAt.later, "SUCCEEDED") });
      });
      await prisma.paymentTransaction.create({
        data: capture(ARRIVING, ARRIVING_PI, new Date("2026-06-20T00:00:00.000Z"), "PROCESSING"),
      });
      // Whole-table rewrite, only in the already guarded disposable database,
      // on the existing primary-key index; row values and sequences stay intact.
      await prisma.$executeRaw`CLUSTER "PaymentTransaction" USING "PaymentTransaction_pkey"`;

      const heap = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "PaymentTransaction" WHERE "paymentId" = ${PAYMENT_ID} ORDER BY ctid`;
      expect(heap.map((row) => row.id), "premise: CLUSTER put the later capture first in the heap").toEqual([
        LATER,
        ARRIVING,
        FIRST,
      ]);
      const seq = Object.fromEntries(
        (
          await prisma.paymentTransaction.findMany({
            where: { paymentId: PAYMENT_ID },
            select: { id: true, insertionSeq: true },
          })
        ).map((row) => [row.id, row.insertionSeq]),
      );
      expect(seq[FIRST]! < seq[LATER]!, "premise: the first capture was inserted first").toBe(true);
      if (createdAt.first.getTime() !== createdAt.later.getTime()) return;
      // On a tie every plan returns heap order (a btree keeps equal keys in heap
      // order), so the duplicate-capture guard's own read - its exported
      // `where` (`otherSettledCaptureWhere`), without its `orderBy` -
      // meets the later capture first: the answer the unordered read gave.
      // Apart, an index on `createdAt` may return the first, so the premise is
      // asserted only here.
      const { otherSettledCaptureWhere } = await import("@/lib/duplicate-capture-guard");
      const { listLiveSupersededIntentIds } = await import("@/lib/superseded-intent-ownership");
      const { listDuplicateCaptureRefundIntentIds } = await import("@/lib/duplicate-capture-ownership");
      const unordered = await prisma.paymentTransaction.findFirst({
        where: otherSettledCaptureWhere({
          paymentId: PAYMENT_ID,
          arrivingPaymentIntentId: ARRIVING_PI,
          liveSupersededIntentIds: await listLiveSupersededIntentIds(prisma, PAYMENT_ID),
          duplicateRefundIntentIds: await listDuplicateCaptureRefundIntentIds({ bookingId: BOOKING_ID, store: prisma }),
        }),
        select: { id: true, stripePaymentIntentId: true },
      });
      expect(unordered?.id, "premise: the unordered production read meets the later capture first").toBe(LATER);
    }

    /** Stripe makes the refund it is asked for, recording the intents asked. */
    function stripeMakesRefunds(): string[] {
      const asked: string[] = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.paymentIntentId);
        return {
          id: `re_race_4177_${asked.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: "ch_race_4177",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      return asked;
    }

    async function settleArrivingCapture() {
      const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
      const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
      return markBookingPaymentSucceeded({
        bookingId: BOOKING_ID,
        paymentIntentId: ARRIVING_PI,
        amountCents: PRICE_CENTS,
        paymentMethodId: null,
        format: CLUB_FORMAT_TEST,
      });
    }

    /** #4211: the capture the guard names to the admins, read through its real verdict. */
    async function settledIntentTheAlertNames(): Promise<unknown> {
      const { judgeCaptureOnPaidBooking } = await import("@/lib/duplicate-capture-guard");
      const verdict = await prisma.$transaction((tx) =>
        judgeCaptureOnPaidBooking(tx, {
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          recordedSettlerId: null,
          paymentIntentId: ARRIVING_PI,
          amountCents: PRICE_CENTS,
        }),
      );
      expect(verdict.verdict).toBe("keep_unrecorded_settler");
      return verdict.verdict === "keep_unrecorded_settler" ? verdict.otherPaymentIntentId : undefined;
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Settled-capture order proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Settled",
          lastName: "Capture",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4177 Lodge", slug: "race-4177" } });
    }, 120_000);

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
          stripePaymentIntentId: FIRST_PI,
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

    // A regression pin, not a proof: apart, an index on `createdAt` may return the
    // first capture with no `orderBy` at all (see the file header).
    it("regression pin: captures created apart, the later one first in the heap: the arriving capture is kept and the alert names the first", async () => {
      await writeCapturesLaterFirstInHeap({ first: EARLIER, later: TIED_AT });
      const asked = stripeMakesRefunds();

      const result = await settleArrivingCapture();

      expect(result.outcome).toBe("duplicate_capture_kept");
      expect(asked, "nothing is refunded with no recorded settler").toEqual([]);
      expect(await settledIntentTheAlertNames()).toBe(FIRST_PI);
    });

    it("proof: captures tied on createdAt, the later one first in the heap: insertionSeq decides, and the alert names the first", async () => {
      await writeCapturesLaterFirstInHeap({ first: TIED_AT, later: TIED_AT });
      const asked = stripeMakesRefunds();

      const result = await settleArrivingCapture();

      expect(result.outcome).toBe("duplicate_capture_kept");
      expect(asked, "nothing is refunded with no recorded settler").toEqual([]);
      expect(await settledIntentTheAlertNames()).toBe(FIRST_PI);
    });

    it("the Xero reader counts a superseded refund until it SUCCEEDED and a cancel only while in flight; (b′) counts both until SUCCEEDED", async () => {
      const operations = [
        { intent: "pi_race_4177_refund_retrying", type: "REFUND_SUPERSEDED_PAYMENT", status: "FAILED", attempts: 2, nextRetryAt: TIED_AT },
        { intent: "pi_race_4177_refund_dead", type: "REFUND_SUPERSEDED_PAYMENT", status: "FAILED", attempts: 5, nextRetryAt: null },
        { intent: "pi_race_4177_refund_done", type: "REFUND_SUPERSEDED_PAYMENT", status: "SUCCEEDED", attempts: 1, nextRetryAt: null },
        { intent: "pi_race_4177_cancel_waiting", type: "CANCEL_PAYMENT_INTENT", status: "PENDING", attempts: 0, nextRetryAt: TIED_AT },
        { intent: "pi_race_4177_cancel_running", type: "CANCEL_PAYMENT_INTENT", status: "PROCESSING", attempts: 1, nextRetryAt: null },
        { intent: "pi_race_4177_cancel_retrying", type: "CANCEL_PAYMENT_INTENT", status: "FAILED", attempts: 2, nextRetryAt: TIED_AT },
        { intent: "pi_race_4177_cancel_dead", type: "CANCEL_PAYMENT_INTENT", status: "FAILED", attempts: 5, nextRetryAt: null },
        { intent: "pi_race_4177_cancel_raised_dead", type: "CANCEL_PAYMENT_INTENT", status: "PENDING", attempts: 5, nextRetryAt: TIED_AT },
      ] as const;
      await prisma.paymentRecoveryOperation.createMany({
        data: operations.map((operation) => ({
          type: operation.type,
          status: operation.status,
          attempts: operation.attempts,
          nextRetryAt: operation.nextRetryAt,
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentIntentId: operation.intent,
          amountCents: PRICE_CENTS,
          idempotencyKey: ["race", "4177", operation.intent].join("-"),
        })),
      });
      const { listLiveSupersededIntentIds, listSupersededIntentIdsOwningCaptures } = await import(
        "@/lib/superseded-intent-ownership"
      );

      expect((await listSupersededIntentIdsOwningCaptures(prisma, PAYMENT_ID, await capturesOnPayment())).sort()).toEqual(
        [
          "pi_race_4177_cancel_retrying",
          "pi_race_4177_cancel_running",
          "pi_race_4177_cancel_waiting",
          "pi_race_4177_refund_dead",
          "pi_race_4177_refund_retrying",
        ],
      );
      expect((await listLiveSupersededIntentIds(prisma, PAYMENT_ID)).sort()).toEqual(
        operations
          .filter((operation) => operation.status !== "SUCCEEDED")
          .map((operation) => operation.intent)
          .sort(),
      );
    });

    it("the Xero reader counts a capture whose superseded refund is owed back again while an open row asks for it (#4221)", async () => {
      const { CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX, nextRefusedRefundKeySuffix } = await import("@/lib/payment-recovery-keys");
      const cases = [
        "open",
        "dead",
        "chain",
        "closed",
        "other_door",
        "misplaced",
        "no_superseded",
        "decoy",
        "replanned",
        "remade",
        "replanned_closed",
        "short",
        "closed_plan",
        "resent",
        "dashboard",
      ] as const;
      type Case = (typeof cases)[number];
      const txn = (name: Case) => `race-4177-txn-4221-${name}`;
      const intent = (name: Case) => `pi_race_4221_${name}`;
      const refundOp = (name: Case) => `race-4177-op-4221-refund-${name}`;
      await prisma.paymentTransaction.createMany({
        data: cases.map((name) => ({
          id: txn(name),
          paymentId: PAYMENT_ID,
          kind: "PRIMARY" as const,
          source: "STRIPE" as const,
          stripePaymentIntentId: intent(name),
          amountCents: PRICE_CENTS,
          // Each re-planned capture holds the 5000 its slice owes back again,
          // after its superseded refund took the rest; short holds all of it.
          refundedAmountCents: ["replanned", "remade", "replanned_closed", "closed_plan"].includes(name)
            ? PRICE_CENTS - 5000
            : ["resent", "dashboard"].includes(name)
              ? PRICE_CENTS - HELD_UNOWED
              : 0,
          status: "SUCCEEDED" as const,
          createdAt: EARLIER,
        })),
      });
      const base = { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: PRICE_CENTS };
      await prisma.paymentRecoveryOperation.createMany({
        data: [
          // Each capture but no_superseded, refunded by its SUCCEEDED REFUND_SUPERSEDED_PAYMENT.
          ...cases
            .filter((name) => name !== "no_superseded")
            .map((name) => ({
              ...base,
              id: refundOp(name),
              type: "REFUND_SUPERSEDED_PAYMENT" as const,
              status: "SUCCEEDED" as const,
              attempts: 1,
              nextRetryAt: null,
              paymentTransactionId: txn(name),
              paymentIntentId: intent(name),
              idempotencyKey: `race-4177-4221-superseded-${name}`,
              // #4103/#4104: closed after re-sending its own re-planned refusal
              // slice, which its plan keeps. Closed, it owes nothing.
              ...(name === "closed_plan"
                ? {
                    allocationPlan: [
                      {
                        paymentTransactionId: txn(name),
                        amountCents: 5000,
                        stripeKeySuffix: nextRefusedRefundKeySuffix(undefined),
                        failedRefundIds: ["re_race_4221_closed_plan"],
                      },
                    ],
                  }
                : {}),
            })),
          // Another door's refund on the other_door capture (the money lens's F2).
          {
            ...base,
            id: "race-4177-op-4221-edit",
            type: "REFUND_BOOKING_MODIFICATION" as const,
            status: "SUCCEEDED" as const,
            paymentIntentId: intent("other_door"),
            idempotencyKey: "race-4177-4221-edit-refund",
          },
        ],
      });
      const failedLater = (
        name: string,
        rowIntent: Case,
        madeBy: string | null | undefined,
        state: { status?: "PENDING" | "SUCCEEDED"; attempts?: number; sliceOn?: Case } = {},
        key = `${CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX}re_race_4221_${name}`,
      ) => ({
        ...base,
        id: `race-4177-op-4221-failed-${name}`,
        type: "REFUND_BOOKING_MODIFICATION" as const,
        status: state.status ?? ("PENDING" as const),
        attempts: state.attempts ?? 0,
        nextRetryAt: TIED_AT,
        paymentIntentId: intent(rowIntent),
        idempotencyKey: key,
        stripeKeyPrefix: key,
        allocationPlan: [
          {
            paymentTransactionId: txn(state.sliceOn ?? rowIntent),
            amountCents: PRICE_CENTS,
            ...(madeBy === undefined ? {} : { madeByOperationId: madeBy }),
          },
        ],
      });
      await prisma.paymentRecoveryOperation.createMany({
        data: [
          failedLater("open", "open", refundOp("open")),
          failedLater("dead", "dead", null, { attempts: 5 }),
          failedLater("chain_1", "chain", refundOp("chain"), { status: "SUCCEEDED" }),
          failedLater("chain_2", "chain", "race-4177-op-4221-failed-chain_1", { attempts: 5 }),
          failedLater("closed", "closed", refundOp("closed"), { status: "SUCCEEDED" }),
          failedLater("other_door", "other_door", "race-4177-op-4221-edit"),
          // Keyed on the row's own intent: this one names misplaced's refund
          // and slice, but sits on no_superseded's intent, which has no
          // superseded refund. Neither capture counts.
          failedLater("misplaced", "no_superseded", refundOp("misplaced"), { sliceOn: "misplaced" }),
          // Missed by the escaped prefix and rejected by the key's own rule
          // (`cardRefundFailedLaterRefundId`); read only as an open card
          // refund row, whose slice nothing re-planned. It shows nothing alone.
          failedLater("decoy", "decoy", refundOp("decoy"), {}, "card-refund-failed-later-re_race_4221_decoy"),
        ],
      });
      // The other door's path: an open edit refund row whose slices made
      // refunds Stripe failed later, each re-planned (`failedRefundIds`, its
      // next key) rather than given a failed-later row. Only the slice on
      // replanned, not made again, beside a superseded refund and owing all
      // its capture holds, counts.
      const replannedSlice = (name: Case, extra: Record<string, unknown> = {}) => ({
        paymentTransactionId: txn(name),
        amountCents: 5000,
        stripeKeySuffix: nextRefusedRefundKeySuffix(undefined),
        failedRefundIds: [`re_race_4221_slice_${name}`],
        ...extra,
      });
      await prisma.paymentRecoveryOperation.createMany({
        data: [
          {
            ...base,
            id: "race-4177-op-4221-edit-open",
            type: "REFUND_BOOKING_MODIFICATION" as const,
            status: "FAILED" as const,
            attempts: 2,
            nextRetryAt: TIED_AT,
            paymentIntentId: intent("other_door"),
            idempotencyKey: "race-4177-4221-edit-open",
            allocationPlan: [
              replannedSlice("replanned"),
              replannedSlice("remade", { madeRefundId: "re_race_4221_remade_again" }),
              replannedSlice("no_superseded"),
              // Owes back 5000 of the 20000 short holds: the rest is owed by nothing.
              replannedSlice("short"),
            ],
          },
          {
            ...base,
            id: "race-4177-op-4221-edit-closed",
            type: "REFUND_BOOKING_MODIFICATION" as const,
            status: "SUCCEEDED" as const,
            attempts: 1,
            nextRetryAt: null,
            paymentIntentId: intent("other_door"),
            idempotencyKey: "race-4177-4221-edit-closed",
            allocationPlan: [replannedSlice("replanned_closed")],
          },
        ],
      });
      // Round 5: a re-send already recorded owes nothing, closed or not. Each
      // of resent and dashboard holds HELD_UNOWED again only because a refund
      // made by hand in Stripe failed later too (owed by nothing), beside its
      // superseded refund's, which a failed-later row owed and has re-sent:
      // resent's row has not closed (a worker that crashed before its close);
      // dashboard's is dead, paid by a refund in the Stripe dashboard.
      const resentCents = PRICE_CENTS - HELD_UNOWED;
      // Their superseded refunds closed before the failed-later rows were raised.
      await prisma.paymentRecoveryOperation.updateMany({
        where: { id: { in: [refundOp("resent"), refundOp("dashboard")] } },
        data: { createdAt: EARLIER, succeededAt: TIED_AT },
      });
      for (const [name, state] of [
        ["resent", { status: "PROCESSING" as const, attempts: 1 }],
        ["dashboard", { status: "PENDING" as const, attempts: 5 }],
      ] as const) {
        const key = `${CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX}re_race_4221_${name}_s`;
        await prisma.paymentRecoveryOperation.create({
          data: {
            ...base,
            ...state,
            id: `race-4177-op-4221-failed-${name}`,
            type: "REFUND_BOOKING_MODIFICATION",
            amountCents: resentCents,
            // Raised after its superseded refund closed, and before Stripe made
            // the re-send: explicit, so the attribution never reads a tie.
            createdAt: RAISED_AGAIN_AT,
            nextRetryAt: TIED_AT,
            paymentIntentId: intent(name),
            idempotencyKey: key,
            stripeKeyPrefix: key,
            allocationPlan: [{ paymentTransactionId: txn(name), amountCents: resentCents, madeByOperationId: refundOp(name) }],
          },
        });
        // Recorded after the row was raised, as Stripe's answers are.
        await prisma.paymentRefund.createMany({
          data: [
            [`re_race_4221_${name}_a`, HELD_UNOWED, "failed"],
            [`re_race_4221_${name}_s`, resentCents, "failed"],
            [`re_race_4221_${name}_again`, resentCents, "succeeded"],
          ].map(([stripeRefundId, amountCents, status]) => ({
            paymentId: PAYMENT_ID,
            paymentTransactionId: txn(name),
            stripeRefundId: stripeRefundId as string,
            amountCents: amountCents as number,
            currency: "nzd",
            status: status as string,
            createdAt: RESENT_AT,
          })),
        });
      }
      const { listSupersededIntentIdsOwningCaptures } = await import("@/lib/superseded-intent-ownership");

      expect((await listSupersededIntentIdsOwningCaptures(prisma, PAYMENT_ID, await capturesOnPayment())).sort()).toEqual(
        [intent("chain"), intent("dead"), intent("open"), intent("other_door"), intent("replanned")].sort(),
      );
    });
  },
);
