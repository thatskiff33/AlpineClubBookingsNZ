/**
 * Real-PostgreSQL proof of an organiser-settled child's refund out of the
 * group's COMBINED card payment (#3653, `INV-PAY-111`).
 *
 * Driven through the real reservation, planner and executor against the
 * migrated schema, with Stripe replaced by an in-memory double handed to the
 * executor's seam (no live provider, no `vi.mock` that could leak into the other
 * suites this harness imports). It proves, across modification -> cancellation
 * -> recovery with two joiners and partial refunds:
 *
 *  - a reduction's refund is recorded against the child by Stripe's own refund
 *    id before its mirror, Xero note and settlement status move, exactly once,
 *    and a replay records nothing again;
 *  - an ambiguous Stripe answer (refund made, response lost) converges on the
 *    one refund Stripe holds, found by its key, never a second;
 *  - two reductions racing for the same captured cents cannot both reserve them
 *    (the headroom read and the insert are one decision under `lock(1)`);
 *  - a later cancellation sizes each child from what remains after refunds made
 *    AND owed, freezes its plan, and a re-plan changes nothing;
 *  - total refunds never exceed the combined capture;
 *  - the read-only audit tells a mirror Stripe backs from one it does not.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-3653-`
 * fixtures.
 */
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-3653";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const ORGANISER_BOOKING = `${P}-organiser`;
const GROUP_ID = `${P}-group`;
const SETTLEMENT_ID = `${P}-settlement`;
const PI = "pi_race_3653";
const CHILDREN = [`${P}-child-1`, `${P}-child-2`, `${P}-child-3`];
const PAYMENTS = [`${P}-pay-1`, `${P}-pay-2`, `${P}-pay-3`];
const CHECK_IN = new Date("2027-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");
const CHILD_CENTS = 4_500;
const COMBINED_CENTS = 9_000; // children 1 and 2; child 3 is the legacy fixture

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeOrganiserChildRefundDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Organiser child refund proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(`Refusing to run organiser child refund proofs against port ${parsed.port || "(none)"}.`);
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Organiser child refund proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Organiser child refund proof DB name must contain 'concurrency_race_1881'.");
  }
}

/** An in-memory Stripe: refunds by idempotency key, listable by intent. */
function fakeStripe() {
  const byKey = new Map<string, Stripe.Refund>();
  let seq = 0;
  let loseNextResponse = false;
  let failNextCall = false;
  const stripe = {
    calls: 0,
    byKey,
    loseNextResponse() {
      loseNextResponse = true;
    },
    failNextCall() {
      failNextCall = true;
    },
    async processRefund(input: {
      paymentIntentId: string;
      amountCents: number;
      metadata?: Record<string, string>;
      idempotencyKey?: string;
    }): Promise<Stripe.Refund> {
      stripe.calls += 1;
      if (failNextCall) {
        failNextCall = false;
        throw new Error("Stripe is unavailable");
      }
      const key = input.idempotencyKey ?? `nokey-${seq}`;
      let refund = byKey.get(key);
      if (!refund) {
        seq += 1;
        refund = {
          id: `re_race_3653_${seq}`,
          amount: input.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: null,
          created: Math.floor(Date.now() / 1000),
          charge: "ch_race_3653",
          payment_intent: input.paymentIntentId,
          metadata: input.metadata ?? {},
        } as unknown as Stripe.Refund;
        byKey.set(key, refund);
      }
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new Error("Stripe timed out after making the refund");
      }
      return refund;
    },
    async listRefundsForPaymentIntent(paymentIntentId: string) {
      return [...byKey.values()].filter((refund) => refund.payment_intent === paymentIntentId);
    },
  };
  return stripe;
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let core: typeof import("@/lib/organiser-child-refund");
let executor: typeof import("@/lib/organiser-child-refund-executor");
let audit: typeof import("@/lib/organiser-child-refund-audit");

(RUN ? describe : describe.skip)(
  "an organiser child's refund out of the combined card payment — real PostgreSQL (#3653)",
  { timeout: 60_000 },
  () => {
    const stripe = fakeStripe();

    async function deleteFixtures() {
      const bookingIds = [ORGANISER_BOOKING, ...CHILDREN];
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: { in: PAYMENTS } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: PAYMENTS } } });
      await prisma.payment.deleteMany({ where: { id: { in: PAYMENTS } } });
      await prisma.groupBookingSettlement.deleteMany({ where: { id: SETTLEMENT_ID } });
      await prisma.groupBooking.deleteMany({ where: { id: GROUP_ID } });
      await prisma.booking.deleteMany({ where: { id: { in: CHILDREN } } });
      await prisma.booking.deleteMany({ where: { id: ORGANISER_BOOKING } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function settlement() {
      return prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: SETTLEMENT_ID } });
    }

    async function combined() {
      const row = await settlement();
      return { id: row.id, stripePaymentIntentId: PI, amountCents: row.amountCents };
    }

    /** Write an edit's debt the way an edit door does: under lock(1), in its transaction. */
    async function reserveReduction(child: number, modificationId: string, amountCents: number) {
      const plan = { settlement: await combined(), amountCents };
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: PAYMENTS[child] } });
        return core.reserveOrganiserChildModificationRefund(tx, {
          plan,
          bookingId: CHILDREN[child]!,
          payment,
          bookingModificationId: modificationId,
        });
      });
    }

    /** Claim the row as the recovery runner does, then run it. */
    async function run(operationId: string) {
      const claimed = await prisma.paymentRecoveryOperation.update({
        where: { id: operationId },
        data: { status: "PROCESSING", attempts: { increment: 1 } },
      });
      return executor.processOrganiserChildRefundOperation(claimed, CLUB_FORMAT_TEST, stripe);
    }

    beforeAll(async () => {
      assertSafeOrganiserChildRefundDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      core = await import("@/lib/organiser-child-refund");
      executor = await import("@/lib/organiser-child-refund-executor");
      audit = await import("@/lib/organiser-child-refund-audit");

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Group", lastName: "Proof", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3653 Lodge", slug: P } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
      const booking = { memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, totalPriceCents: CHILD_CENTS, finalPriceCents: CHILD_CENTS };
      await prisma.booking.create({ data: { ...booking, id: ORGANISER_BOOKING, status: "PAID" } });
      await prisma.groupBooking.create({
        data: { id: GROUP_ID, organiserBookingId: ORGANISER_BOOKING, organiserMemberId: MEMBER_ID, joinCode: P, paymentMode: "ORGANISER_PAYS" },
      });
      await prisma.groupBookingSettlement.create({
        data: { id: SETTLEMENT_ID, groupBookingId: GROUP_ID, stripePaymentIntentId: PI, source: "STRIPE", amountCents: COMBINED_CENTS, status: "SUCCEEDED" },
      });
      for (const [index, id] of CHILDREN.entries()) {
        await prisma.booking.create({ data: { ...booking, id, status: "PAID", parentBookingId: ORGANISER_BOOKING, organiserSettled: true } });
        await prisma.payment.create({
          data: { id: PAYMENTS[index]!, bookingId: id, amountCents: CHILD_CENTS, source: "STRIPE", status: "SUCCEEDED" },
        });
      }
      // Child 3: a pre-#3653 phantom - a mirror nothing backs.
      await prisma.payment.update({ where: { id: PAYMENTS[2] }, data: { refundedAmountCents: 1_000, status: "PARTIALLY_REFUNDED" } });
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    });

    it("records a reduction's refund against the child before its mirror, note and settlement move - once", async () => {
      const debt = await reserveReduction(0, `${P}-mod-1`, 1_500);
      expect(debt?.amountCents).toBe(1_500);

      await run(debt!.id);

      const refunds = await prisma.paymentRefund.findMany({ where: { paymentId: PAYMENTS[0] } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ amountCents: 1_500, stripePaymentIntentId: PI, paymentTransactionId: null });
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENTS[0] } })).toMatchObject({
        refundedAmountCents: 1_500,
        status: "PARTIALLY_REFUNDED",
      });
      expect((await settlement()).status).toBe("PARTIALLY_REFUNDED");
      expect((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: debt!.id } })).status).toBe("SUCCEEDED");
      const notes = await prisma.xeroSyncOperation.findMany({ where: { localModel: "Payment", localId: PAYMENTS[0], entityType: "CREDIT_NOTE" } });
      expect(notes).toHaveLength(1);

      // A replay (a second worker, a re-delivered claim) records nothing again.
      const callsBefore = stripe.calls;
      await run(debt!.id);
      expect(stripe.calls).toBe(callsBefore); // attempt 2 found Stripe's refund by its key
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENTS[0] } })).toBe(1);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENTS[0] } })).refundedAmountCents).toBe(1_500);
      expect(await prisma.xeroSyncOperation.count({ where: { localModel: "Payment", localId: PAYMENTS[0], entityType: "CREDIT_NOTE" } })).toBe(1);
    });

    it("converges an ambiguous Stripe answer on the one refund Stripe made, and keeps a failed call owed", async () => {
      const debt = await reserveReduction(0, `${P}-mod-2`, 3_000);

      stripe.failNextCall();
      await expect(run(debt!.id)).rejects.toThrow("Stripe is unavailable");
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENTS[0] } })).toBe(1);
      expect((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: debt!.id } })).status).toBe("PROCESSING");

      stripe.loseNextResponse();
      await expect(run(debt!.id)).rejects.toThrow("timed out");
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENTS[0] } })).toBe(1);

      const callsBefore = stripe.calls;
      await run(debt!.id);
      expect(stripe.calls).toBe(callsBefore);
      expect([...stripe.byKey.keys()].filter((key) => key.endsWith(`${P}-mod-2`))).toHaveLength(1);
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENTS[0] } })).toBe(2);
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENTS[0] } })).toMatchObject({
        refundedAmountCents: 4_500,
        status: "REFUNDED",
      });
    });

    it("refuses a reduction the child's payment can no longer cover, before the edit commits", async () => {
      await expect(reserveReduction(0, `${P}-mod-3`, 1)).rejects.toBeInstanceOf(core.OrganiserChildRefundRefusedError);
      expect(await prisma.paymentRecoveryOperation.count({ where: { idempotencyKey: { endsWith: `${P}-mod-3` } } })).toBe(0);
    });

    it("lets only one of two racing reductions reserve the same captured cents", async () => {
      const results = await Promise.allSettled([
        reserveReduction(1, `${P}-race-a`, 3_000),
        reserveReduction(1, `${P}-race-b`, 3_000),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((result) => result.status === "rejected");
      expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(core.OrganiserChildRefundRefusedError);
      // The winner stays owed - not executed yet - for the cancellation below.
    });

    it("plans a cancellation from what remains after refunds made AND owed, and freezes it", async () => {
      const plan = await core.planOrganiserCancelChildRefunds({
        settlementId: SETTLEMENT_ID,
        organiserBookingId: ORGANISER_BOOKING,
        activeChildStatuses: ["PAYMENT_PENDING", "CONFIRMED", "PAID"],
        daysUntilCheckIn: 300,
        policy: [{ daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0, creditFixedFeeCents: 0 }],
      });
      // A 50% tier. Child 1 is fully refunded, so it gets nothing. Child 2 has
      // 3000 owed of 4500: 50% of the 1500 that remains is 750 (never 50% of
      // the 4500 paid). Child 3 is the phantom - 1000 already off its mirror -
      // so 50% of 3500 is 1750, clamped to the 750 the combined payment still
      // holds (9000 - 4500 refunded - 3000 owed - 750 just reserved).
      expect(Object.fromEntries(plan)).toEqual({ [CHILDREN[1]!]: 750, [CHILDREN[2]!]: 750 });
      expect((await settlement()).refundPlan).toEqual({
        perChildRefunds: { [CHILDREN[1]!]: 750, [CHILDREN[2]!]: 750 },
      });

      const again = await core.planOrganiserCancelChildRefunds({
        settlementId: SETTLEMENT_ID,
        organiserBookingId: ORGANISER_BOOKING,
        activeChildStatuses: ["PAYMENT_PENDING", "CONFIRMED", "PAID"],
        daysUntilCheckIn: 1,
        policy: [{ daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0, creditFixedFeeCents: 0 }],
      });
      expect(Object.fromEntries(again)).toEqual({ [CHILDREN[1]!]: 750, [CHILDREN[2]!]: 750 });
    });

    it("runs every owed debt to completion without exceeding the combined capture", async () => {
      const owed = await prisma.paymentRecoveryOperation.findMany({
        where: { bookingId: { in: CHILDREN }, status: { not: "SUCCEEDED" } },
      });
      for (const debt of owed) await run(debt.id);

      const total = await prisma.paymentRefund.aggregate({ where: { stripePaymentIntentId: PI }, _sum: { amountCents: true } });
      expect(total._sum.amountCents).toBe(COMBINED_CENTS);
      expect((await settlement()).status).toBe("REFUNDED");
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENTS[1] } })).toMatchObject({
        refundedAmountCents: 3_750,
        status: "PARTIALLY_REFUNDED",
      });
    });

    it("lists the mirror Stripe does not back, and only that one", async () => {
      const findings = (await audit.findUnbackedOrganiserChildRefundMirrors(prisma)).filter((row) =>
        CHILDREN.includes(row.bookingId),
      );
      expect(findings).toEqual([
        expect.objectContaining({ bookingId: CHILDREN[2], classification: "unbacked", unexplainedCents: 1_000 }),
      ]);
    });
  },
);
