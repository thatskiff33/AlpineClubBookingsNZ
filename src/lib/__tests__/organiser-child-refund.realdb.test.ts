/**
 * Real-PostgreSQL proof of an organiser-settled child's refund out of the
 * group's COMBINED card payment (#3653, `INV-PAY-114`).
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
 *  - the read-only audit tells a mirror Stripe backs from one it does not;
 *  - an edit door's Xero dispatch raises no modification note for a reduction
 *    the executor's refund note covers, so ONE note credits the joiner's issued
 *    invoice across both link roles (fix round);
 *  - a mirror a reconcile or a stale Xero repair zeroed cannot re-promise
 *    refunded money to a reduction or a cancellation (fix round);
 *  - a refund Stripe accepted as pending and then failed is taken back out and
 *    owed again, and still spoken for against the combined capture (fix round).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-3653-`
 * fixtures.
 */
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
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
// Fix round: two more groups of one child each, so their arithmetic is their own.
const B = { organiser: `${P}-b-organiser`, group: `${P}-b-group`, settlement: `${P}-b-settlement`, child: `${P}-b-child`, payment: `${P}-b-pay`, pi: "pi_race_3653_b" };
const C = { organiser: `${P}-c-organiser`, group: `${P}-c-group`, settlement: `${P}-c-settlement`, child: `${P}-c-child`, payment: `${P}-c-pay`, pi: "pi_race_3653_c" };
// Fix round 2: a joiner's own cancel after a reduction (D), behind the group's
// cancel (E), and against a combined payment that holds less than it owes (F).
const D = { organiser: `${P}-d-organiser`, group: `${P}-d-group`, settlement: `${P}-d-settlement`, child: `${P}-d-child`, payment: `${P}-d-pay`, pi: "pi_race_3653_d" };
const E = { organiser: `${P}-e-organiser`, group: `${P}-e-group`, settlement: `${P}-e-settlement`, child: `${P}-e-child`, payment: `${P}-e-pay`, pi: "pi_race_3653_e" };
const F = { organiser: `${P}-f-organiser`, group: `${P}-f-group`, settlement: `${P}-f-settlement`, child: `${P}-f-child`, payment: `${P}-f-pay`, pi: "pi_race_3653_f" };
// Final fix round: a refund Stripe failed after it was recorded, made good on a
// later attempt of the reopened debt (G).
const G = { organiser: `${P}-g-organiser`, group: `${P}-g-group`, settlement: `${P}-g-settlement`, child: `${P}-g-child`, payment: `${P}-g-pay`, pi: "pi_race_3653_g" };
const EXTRA = [D, E, F, G];

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

/**
 * An in-memory Stripe: refunds by idempotency key, listable by intent. A
 * repeated key answers with the ORIGINAL response, as Stripe does for 24 hours;
 * reading a refund back (retrieve, list) sees its live status.
 */
function fakeStripe() {
  const byKey = new Map<string, Stripe.Refund>();
  const liveStatus = new Map<string, string>();
  const live = (refund: Stripe.Refund) =>
    ({ ...refund, status: liveStatus.get(refund.id) ?? refund.status }) as Stripe.Refund;
  let seq = 0;
  let loseNextResponse = false;
  let failNextCall = false;
  let pendNextRefund = false;
  const stripe = {
    calls: 0,
    byKey,
    /** The next NEW refund is answered `pending`, as a bank-debit refund can be. */
    pendNextRefund() {
      pendNextRefund = true;
    },
    /** Stripe later moves a refund on - how a pending refund fails. */
    setStatus(refundId: string, status: string) {
      if (![...byKey.values()].some((candidate) => candidate.id === refundId)) throw new Error(`No refund ${refundId}`);
      liveStatus.set(refundId, status);
    },
    async retrieveRefund(refundId: string) {
      const refund = [...byKey.values()].find((candidate) => candidate.id === refundId);
      if (!refund) throw new Error(`No such refund: ${refundId}`);
      return live(refund);
    },
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
          status: pendNextRefund ? "pending" : "succeeded",
          reason: null,
          created: Math.floor(Date.now() / 1000),
          charge: "ch_race_3653",
          payment_intent: input.paymentIntentId,
          metadata: input.metadata ?? {},
        } as unknown as Stripe.Refund;
        byKey.set(key, refund);
        pendNextRefund = false;
      }
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new Error("Stripe timed out after making the refund");
      }
      return refund;
    },
    async listRefundsForPaymentIntent(paymentIntentId: string) {
      return [...byKey.values()].filter((refund) => refund.payment_intent === paymentIntentId).map(live);
    },
  };
  return stripe;
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let core: typeof import("@/lib/organiser-child-refund");
let executor: typeof import("@/lib/organiser-child-refund-executor");
let audit: typeof import("@/lib/organiser-child-refund-audit");
let xeroEdit: typeof import("@/lib/xero-booking-edit-settlement");

(RUN ? describe : describe.skip)(
  "an organiser child's refund out of the combined card payment — real PostgreSQL (#3653)",
  { timeout: 60_000 },
  () => {
    const stripe = fakeStripe();

    async function deleteFixtures() {
      const bookingIds = [
        ORGANISER_BOOKING, ...CHILDREN, B.organiser, B.child, C.organiser, C.child,
        ...EXTRA.flatMap((group) => [group.organiser, group.child]),
      ];
      const paymentIds = [...PAYMENTS, B.payment, C.payment, ...EXTRA.map((group) => group.payment)];
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: { in: paymentIds } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "BookingModification", localId: { startsWith: P } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: bookingIds } } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
      await prisma.groupBookingSettlement.deleteMany({
        where: { id: { in: [SETTLEMENT_ID, B.settlement, C.settlement, ...EXTRA.map((group) => group.settlement)] } },
      });
      await prisma.groupBooking.deleteMany({ where: { id: { in: [GROUP_ID, B.group, C.group, ...EXTRA.map((group) => group.group)] } } });
      await prisma.booking.deleteMany({ where: { id: { in: [...CHILDREN, B.child, C.child, ...EXTRA.map((group) => group.child)] } } });
      await prisma.booking.deleteMany({
        where: { id: { in: [ORGANISER_BOOKING, B.organiser, C.organiser, ...EXTRA.map((group) => group.organiser)] } },
      });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function settlement() {
      return prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: SETTLEMENT_ID } });
    }

    /** Write an edit's debt the way an edit door does: under lock(1), in its transaction. */
    async function reserveReduction(child: number, modificationId: string, amountCents: number) {
      return reserveFor(
        { settlementId: SETTLEMENT_ID, pi: PI, childId: CHILDREN[child]!, paymentId: PAYMENTS[child]! },
        modificationId,
        amountCents,
      );
    }

    async function reserveFor(
      target: { settlementId: string; pi: string; childId: string; paymentId: string },
      modificationId: string,
      amountCents: number,
    ) {
      const row = await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: target.settlementId } });
      const plan = { settlement: { id: row.id, stripePaymentIntentId: target.pi, amountCents: row.amountCents }, amountCents };
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: target.paymentId } });
        return core.reserveOrganiserChildModificationRefund(tx, {
          plan,
          bookingId: target.childId,
          payment,
          bookingModificationId: modificationId,
        });
      });
    }

    /** A one-child organiser-pays group, settled by card. */
    async function createOneChildGroup(
      group: typeof B,
      settlementCents: number,
      childCents: number,
      base: Record<string, unknown>,
    ) {
      await prisma.booking.create({ data: { ...base, id: group.organiser, status: "PAID" } as never });
      await prisma.groupBooking.create({
        data: { id: group.group, organiserBookingId: group.organiser, organiserMemberId: MEMBER_ID, joinCode: group.group, paymentMode: "ORGANISER_PAYS" },
      });
      await prisma.groupBookingSettlement.create({
        data: { id: group.settlement, groupBookingId: group.group, stripePaymentIntentId: group.pi, source: "STRIPE", amountCents: settlementCents, status: "SUCCEEDED" },
      });
      await prisma.booking.create({
        data: { ...base, id: group.child, status: "PAID", parentBookingId: group.organiser, organiserSettled: true, totalPriceCents: childCents, finalPriceCents: childCents } as never,
      });
      await prisma.payment.create({
        data: { id: group.payment, bookingId: group.child, amountCents: childCents, source: "STRIPE", status: "SUCCEEDED" },
      });
    }

    /**
     * The audit writer is fire-and-forget, so a count is read only once it has
     * stopped moving: at least 300ms in, and unchanged across three reads.
     */
    async function settledAuditCount(where: { action: string; targetId: string }) {
      const started = process.hrtime.bigint();
      let last = -1;
      let stable = 0;
      for (;;) {
        const count = await prisma.auditLog.count({ where });
        stable = count === last ? stable + 1 : 0;
        last = count;
        if (stable >= 3 && realElapsedMs(started) >= 300) return count;
        if (realElapsedMs(started) > 10_000) throw new Error("The audit count never settled");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    /** The joiner cancels their own booking, as the member cancel route does. */
    async function joinerCancels(bookingId: string) {
      const { cancelBooking } = await import("@/lib/booking-cancel");
      const result = await cancelBooking(bookingId, MEMBER_ID, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST, "card");
      if (!("data" in result)) throw new Error(`The cancel was refused: ${JSON.stringify(result)}`);
      expect(result.status).toBe(200);
      return result.data as { refundAmountCents: number; refundPercentage: number; refundMethod: string; message: string };
    }

    async function cancelledSnapshot(bookingId: string) {
      const event = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId, type: "CANCELLED" } });
      return event.snapshot as Record<string, unknown> & { ledger: Record<string, number> };
    }

    /** Stripe forgets an idempotency key once its 24-hour window has passed. */
    function forgetKey(key: string) {
      stripe.byKey.delete(key);
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
      xeroEdit = await import("@/lib/xero-booking-edit-settlement");

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
      // Child 1 has an ISSUED invoice, so both credit-note roles can fire for it.
      await prisma.payment.update({ where: { id: PAYMENTS[0] }, data: { xeroInvoiceId: `${P}-inv-1` } });
      // Group B: 20000 captured, one 10000 child. Group C: 5000 and 5000.
      await createOneChildGroup(B, 20_000, 10_000, booking);
      await createOneChildGroup(C, 5_000, 5_000, booking);
      await createOneChildGroup(D, 10_000, 10_000, booking);
      await createOneChildGroup(E, 5_000, 5_000, booking);
      // F's combined payment holds less than its child's tier would return.
      await createOneChildGroup(F, 3_000, 5_000, booking);
      await createOneChildGroup(G, 5_000, 5_000, booking);
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

      // The edit door's own Xero dispatch, with exactly what the batch door
      // passes for this reduction against an ISSUED invoice. It raises no
      // modification note: the executor's refund note is the one.
      await xeroEdit.queueXeroBookingEditSettlement({
        bookingId: CHILDREN[0]!,
        bookingModificationId: `${P}-mod-1`,
        hasIssuedXeroInvoice: true,
        originalPaymentStatus: "SUCCEEDED",
        priceDiffCents: -1_500,
        changeFeeCents: 0,
        datesChanged: false,
        guestIdentityChanged: false,
        settlementMethod: "card",
        refundedThroughStripe: true,
        organiserChildRefundOwnsCreditNote: true,
        settlementAmountCents: 1_500,
        createPrimaryInvoiceWhenMissing: false,
        requiresAdditionalStripePayment: false,
        additionalPaymentIntentId: null,
      });

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
      // ONE credit note for this refund, across BOTH link roles: the refund
      // note on the payment, and none on the modification.
      const notes = await prisma.xeroSyncOperation.findMany({
        where: {
          entityType: "CREDIT_NOTE",
          OR: [
            { localModel: "Payment", localId: PAYMENTS[0] },
            { localModel: "BookingModification", localId: `${P}-mod-1` },
          ],
        },
      });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ localModel: "Payment" });

      // A replay (a second worker, a re-delivered claim) records nothing again.
      const callsBefore = stripe.calls;
      await run(debt!.id);
      expect(stripe.calls).toBe(callsBefore); // attempt 2 found Stripe's refund by its key
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENTS[0] } })).toBe(1);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENTS[0] } })).refundedAmountCents).toBe(1_500);
      expect(await prisma.xeroSyncOperation.count({ where: { localModel: "Payment", localId: PAYMENTS[0], entityType: "CREDIT_NOTE" } })).toBe(1);

      // Made on its first attempt, so nothing was recovered and nothing says so.
      expect(await settledAuditCount({ action: "booking.payment.refund_recovered", targetId: CHILDREN[0]! })).toBe(0);
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

      // Fix round: the refund an earlier attempt failed to make is audited as
      // recovered - once, and only for the refund that needed recovering (the
      // first test's refund was made on its first attempt). The writer is
      // fire-and-forget, so the count is read once it has settled.
      const recovered = { action: "booking.payment.refund_recovered", targetId: CHILDREN[0]! };
      expect(await settledAuditCount(recovered)).toBe(1);
      const rows = await prisma.auditLog.findMany({ where: recovered });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ category: "booking", entityType: "Booking", entityId: CHILDREN[0] });
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

    it("never re-promises refunded money once a reconcile or a stale Xero repair zeroes the mirror (10000 / 4000 / -> 0)", async () => {
      const target = { settlementId: B.settlement, pi: B.pi, childId: B.child, paymentId: B.payment };
      const first = await reserveFor(target, `${P}-b-mod-1`, 4_000);
      await run(first!.id);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: B.payment } })).refundedAmountCents).toBe(4_000);

      // What `reconcilePaymentAggregates` writes for a child once an ask gave it
      // a transaction row (the +1000 the edit door now refuses), and what a
      // stale inbound Xero repair can write as an absolute figure: a mirror
      // that forgot the 4000.
      await prisma.payment.update({ where: { id: B.payment }, data: { refundedAmountCents: 0, status: "SUCCEEDED" } });

      // 6000 remains of the child's payment, whatever the mirror says.
      await expect(reserveFor(target, `${P}-b-mod-2`, 7_000)).rejects.toBeInstanceOf(core.OrganiserChildRefundRefusedError);

      const plan = await core.planOrganiserCancelChildRefunds({
        settlementId: B.settlement,
        organiserBookingId: B.organiser,
        activeChildStatuses: ["PAYMENT_PENDING", "CONFIRMED", "PAID"],
        daysUntilCheckIn: 300,
        policy: [{ daysBeforeStay: 0, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 }],
      });
      expect(Object.fromEntries(plan)).toEqual({ [B.child]: 6_000 });

      const owed = await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: B.child, status: { not: "SUCCEEDED" } } });
      for (const debt of owed) await run(debt.id);
      const total = await prisma.paymentRefund.aggregate({ where: { stripePaymentIntentId: B.pi }, _sum: { amountCents: true } });
      expect(total._sum.amountCents).toBe(10_000); // the child's whole payment, never more
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: B.payment } })).toMatchObject({
        refundedAmountCents: 10_000,
        status: "REFUNDED",
      });
    });

    it("takes back a refund Stripe accepted as pending and then failed, and keeps it owed", async () => {
      const target = { settlementId: C.settlement, pi: C.pi, childId: C.child, paymentId: C.payment };
      stripe.pendNextRefund();
      const debt = await reserveFor(target, `${P}-c-mod-1`, 2_000);
      const refundId = await run(debt!.id);

      expect(await prisma.paymentRefund.findUniqueOrThrow({ where: { stripeRefundId: refundId } })).toMatchObject({ status: "pending" });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: C.payment } })).refundedAmountCents).toBe(2_000);
      expect((await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: C.settlement } })).status).toBe("PARTIALLY_REFUNDED");

      // Nothing has changed at Stripe yet: the sweep leaves it alone.
      await executor.reconcilePendingOrganiserChildRefunds(stripe);
      expect((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: debt!.id } })).status).toBe("SUCCEEDED");

      stripe.setStatus(refundId, "failed");
      const swept = await executor.reconcilePendingOrganiserChildRefunds(stripe);
      expect(swept.reversed).toBe(1);

      expect(await prisma.paymentRefund.findUniqueOrThrow({ where: { stripeRefundId: refundId } })).toMatchObject({ status: "failed" });
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: C.payment } })).toMatchObject({
        refundedAmountCents: 0,
        status: "SUCCEEDED",
      });
      expect((await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: C.settlement } })).status).toBe("SUCCEEDED");
      const reopened = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: debt!.id } });
      expect(reopened).toMatchObject({ status: "PENDING", attempts: 0, succeededAt: null });
      // Fix round 2 (F2): not due again until Stripe has forgotten the key, so
      // no retry is spent on the original response inside its window.
      const refundCreatedMs = (await stripe.retrieveRefund(refundId)).created * 1000;
      expect(reopened.nextRetryAt!.getTime()).toBeGreaterThan(refundCreatedMs + 24 * 60 * 60 * 1000);

      // Still spoken for: 5000 captured, 2000 owed again, so 4000 cannot fit.
      await expect(reserveFor(target, `${P}-c-mod-2`, 4_000)).rejects.toBeInstanceOf(core.OrganiserChildRefundRefusedError);

      // A replay inside Stripe's key window is answered with the ORIGINAL
      // `pending` response; the refund row knows it failed, so the debt stays
      // owed and nothing is recorded twice. A second sweep finds nothing left
      // to take back.
      await expect(run(debt!.id)).rejects.toThrow("is recorded as failed");
      expect(await prisma.paymentRefund.count({ where: { paymentId: C.payment } })).toBe(1);
      expect((await executor.reconcilePendingOrganiserChildRefunds(stripe)).reversed).toBe(0);
    });

    it("audits a reopened refund as recovered when a later attempt makes it, though the reopen restarted its attempts (final fix round)", async () => {
      const target = { settlementId: G.settlement, pi: G.pi, childId: G.child, paymentId: G.payment };
      stripe.pendNextRefund();
      const debt = await reserveFor(target, `${P}-g-mod-1`, 2_000);
      const failedRefundId = await run(debt!.id);
      stripe.setStatus(failedRefundId, "failed");
      expect((await executor.reconcilePendingOrganiserChildRefunds(stripe)).reversed).toBe(1);

      // The reopen restarts the retry budget, and says durably that it reopened.
      const reopened = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: debt!.id } });
      expect(reopened).toMatchObject({ status: "PENDING", attempts: 0 });
      expect(core.organiserChildRefundWasReopened(reopened.allocationPlan)).toBe(true);
      expect(reopened.allocationPlan).toEqual([
        { paymentTransactionId: reopened.idempotencyKey, amountCents: 2_000, reopenedAfterRefundId: failedRefundId },
      ]);

      // Past Stripe's key window, the first attempt after the reopen makes the
      // refund: attempt 1, so only the marker can say an earlier one failed.
      forgetKey(reopened.idempotencyKey);
      const madeRefundId = await run(debt!.id);
      expect(madeRefundId).not.toBe(failedRefundId);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: debt!.id } })).toMatchObject({
        status: "SUCCEEDED",
        attempts: 1,
      });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: G.payment } })).refundedAmountCents).toBe(2_000);

      const recovered = { action: "booking.payment.refund_recovered", targetId: G.child };
      expect(await settledAuditCount(recovered)).toBe(1);
      const [row] = await prisma.auditLog.findMany({ where: recovered });
      expect(row!.metadata).toMatchObject({ attempts: 1, reopened: true, stripeRefundId: madeRefundId });
    });

    it("refunds a joiner's own cancel after a reduction: the tiered remainder, to the organiser's card (fix round 2, F1)", async () => {
      const target = { settlementId: D.settlement, pi: D.pi, childId: D.child, paymentId: D.payment };
      const reduction = await reserveFor(target, `${P}-d-mod-1`, 4_000);
      await run(reduction!.id);
      await prisma.booking.update({ where: { id: D.child }, data: { totalPriceCents: 6_000, finalPriceCents: 6_000 } });
      // The shape that used to refund nothing: PARTIALLY_REFUNDED with no
      // transaction row, because the organiser's payment holds the money.
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: D.payment } })).toMatchObject({
        status: "PARTIALLY_REFUNDED",
        refundedAmountCents: 4_000,
      });
      expect(await prisma.paymentTransaction.count({ where: { paymentId: D.payment } })).toBe(0);

      const result = await joinerCancels(D.child);
      expect(result).toMatchObject({ refundAmountCents: 6_000, refundPercentage: 100, refundMethod: "card" });
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: D.child } })).status).toBe("CANCELLED");

      // Owed under the cancellation key; the inline attempt had no Stripe here,
      // so the runner makes it.
      const debt = await prisma.paymentRecoveryOperation.findFirstOrThrow({
        where: { bookingId: D.child, idempotencyKey: { not: { endsWith: `${P}-d-mod-1` } } },
      });
      expect(debt.amountCents).toBe(6_000);
      if (debt.status !== "SUCCEEDED") await run(debt.id);
      const total = await prisma.paymentRefund.aggregate({ where: { stripePaymentIntentId: D.pi }, _sum: { amountCents: true } });
      expect(total._sum.amountCents).toBe(10_000);
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: D.payment } })).toMatchObject({
        status: "REFUNDED",
        refundedAmountCents: 10_000,
      });
    });

    it("reports a joiner's cancel behind the group's cancel as the group's refund, with no refund of its own (fix round 2, F4)", async () => {
      const plan = await core.planOrganiserCancelChildRefunds({
        settlementId: E.settlement,
        organiserBookingId: E.organiser,
        activeChildStatuses: ["PAYMENT_PENDING", "CONFIRMED", "PAID"],
        daysUntilCheckIn: 300,
        policy: [{ daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0, creditFixedFeeCents: 0 }],
      });
      expect(Object.fromEntries(plan)).toEqual({ [E.child]: 2_500 });

      // The joiner cancels before the group's cancel reaches this child.
      const result = await joinerCancels(E.child);
      expect(result).toMatchObject({ refundAmountCents: 0, refundPercentage: 0 });
      expect(result.message).toContain("group organiser's cancellation is already refunding");
      expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: E.child } })).toBe(1);

      const snapshot = await cancelledSnapshot(E.child);
      // 5000 paid, the group's 2500 owed: the joiner's cancel returns none of
      // the 2500 left, and records it as kept rather than as refunded.
      expect(snapshot).toMatchObject({ paidAmountCents: 2_500, settledAmountCents: 0, retainedAmountCents: 2_500, refundPercentage: 0 });
      expect(snapshot.ledger.keptCents).toBe(2_500);
    });

    it("records a clamped cancel refund from the final amount, not the policy's first answer (fix round 2, F4)", async () => {
      const result = await joinerCancels(F.child);
      // 100% of 5000 asked; the combined payment holds 3000.
      expect(result).toMatchObject({ refundAmountCents: 3_000, refundPercentage: 60 });
      const snapshot = await cancelledSnapshot(F.child);
      expect(snapshot).toMatchObject({ paidAmountCents: 5_000, settledAmountCents: 3_000, retainedAmountCents: 2_000, refundPercentage: 60 });
      expect(snapshot.ledger.keptCents).toBe(2_000);
    });
  },
);
