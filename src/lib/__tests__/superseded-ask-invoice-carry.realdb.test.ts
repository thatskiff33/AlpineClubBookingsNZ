/**
 * Real-PostgreSQL proof for #3403 (owner decision 26 Oct 2026, "follow the
 * money"; `INV-PAY-140`, `INV-PAY-104`): a superseded card change's waiting
 * Xero supplementary invoice moves onto the request that carries its balance.
 *
 * Every state is reached through the real writers: the edit's mint
 * (`createModificationAdditionalPaymentIntent`, which supersedes the earlier
 * ask and moves its invoice before it returns), the edit's Xero leg
 * (`queueXeroBookingEditSettlement`, which parks the change's own invoice on
 * its intent), the supersede's durable cancel (`runPaymentRecoveryOperationNow`),
 * Stripe's success and failure events (`processStripeWebhookEvent`), the
 * booking cancel, the waiting-invoice reaper, a price reduction's retire
 * (`retireUnpaidAskChain`) and the repair pass's enqueue. Only Stripe is a
 * fake, an in-memory intent store in which a capture is something the test
 * does. The booking's primary Xero invoice is a seeded fact; nothing here
 * writes an outbox outcome by hand.
 *
 * Cases:
 *  - A -> B -> B captured: both invoices released, each for its own amount,
 *    and the payments they record sum to the capture;
 *  - B never paid (the booking is cancelled): nothing is invoiced, both retired;
 *  - B captured before A's cancel lands: A's invoice is released at the move;
 *  - a DECLINED A: cancelled at Stripe at B's mint (#4422), and still moved;
 *  - A -> B -> C: three invoices on C's capture, summing to it;
 *  - the move against a price reduction's retire, both orders, forced on the
 *    anchor's key: the reduction retires and counts A's invoice once;
 *  - the move against the repair pass's enqueue, both orders: one invoice;
 *  - two bank-transfer edits: nothing waits, nothing moves;
 *  - review round: a declined A left confirmable (superseded before #4422)
 *    and paid from a stale tab takes its invoice back (M1); a capture between A and a newer request carries A (C4); the move
 *    against the captured carrier's own receipt deciding on the carrier's key,
 *    both orders, one recorder (C2, review 2 F5); B's capture landing while
 *    the move waits on A's key (C5);
 *  - review 2: B captured late while C supersedes it carries A's moved invoice
 *    on to C (F1); A's stale-tab capture between an unpaid move and its
 *    release takes the invoice back paid (F2); A and B both paid and kept,
 *    both orders - each captured dollar recorded once, the double payment
 *    alerted once (F3); a carrier whose receipt is still queued gets A's
 *    invoice unpaid, so its receipt records it rather than standing down (F6);
 *  - #4422: a declined A's stale-tab capture racing its cancel after B was paid
 *    and released, the webhook first and the runner first - handed to the
 *    superseded refund once, both invoices still on B summing to its capture,
 *    nothing recorded for A and no double-payment alert.
 *  - #4442: A paid from a stale tab after B was sized and before B's queue
 *    committed - from inside B's mint, while B's queue waits on the global key,
 *    and inside the recovery runner's replay - withholds B, and the replay
 *    asks for B's own change alone: A's balance is never asked for twice;
 *    and a frozen replay (no figure to re-derive) stays refused on its next retry.
 *
 * M1, F2 and F3 prove the take-back for a declined ask no live cancel row owns.
 * Since #4422 a supersede cancels a declined ask, so they reach that state the
 * way a booking superseded before #4422 is in it: B's inline cancel of A fails
 * and A's cancel row is then removed (`supersedeDeclinedAskWithoutCancel`).
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`,
 * against a loopback database on port 55442+ named with
 * `concurrency_race_1881`. It owns and cleans its own `race-3403-` fixtures.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/superseded-ask-invoice-carry.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

// The harness's one shared Stripe double: pass-through unless a case hooks it.
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3403-member";
const LODGE_ID = "race-3403-lodge";
const BOOKING_ID = "race-3403-booking";
const PAYMENT_ID = "race-3403-payment";
const PRIMARY_INTENT = "pi_race_3403_primary";
const MOD_A = "race-3403-mod-a";
const MOD_B = "race-3403-mod-b";
const MOD_C = "race-3403-mod-c";
const MODS = [MOD_A, MOD_B, MOD_C];
const CHECK_IN = new Date("2027-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

const PAID_CENTS = 20_000;
const A_CENTS = 5_000;
const B_CENTS = 3_000;
const C_CENTS = 2_000;

const LOCK_POLL_TIMEOUT_MS = 10_000;

type FakeIntent = {
  id: string;
  object: "payment_intent";
  amount: number;
  currency: string;
  status: Stripe.PaymentIntent.Status;
  client_secret: string;
  payment_method: string | null;
  metadata: Record<string, string>;
  latest_charge: string | null;
  last_payment_error: { message: string } | null;
};

/** Stripe, in memory: intents keep their status, and a cancel or capture moves it. */
const stripe = {
  intents: new Map<string, FakeIntent>(),
  created: [] as string[],
  /** The next cancel throws, as a Stripe outage would: the durable row waits for its retry. */
  failCancels: 0,
};
let webhookEventSequence = 0;

let prisma: PrismaClient;
let holderClient: PrismaClient;
let observerClient: PrismaClient;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

(RUN ? describe : describe.skip)(
  "#3403: a superseded card change's waiting Xero invoice follows the request that carries its balance - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID, ...MODS] } } });
      // A capture's receipt is anchored on its ledger row; its payload names the booking.
      await prisma.xeroSyncOperation.deleteMany({ where: { requestPayload: { path: ["bookingId"], equals: BOOKING_ID } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID, ...MODS] } } });
      // A receipt's payment link is on its ledger row; the fake Xero names its payments.
      await prisma.xeroObjectLink.deleteMany({ where: { xeroObjectId: { startsWith: "pay_race_3403_" } } });
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_3403_" } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_3403_" } } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: BOOKING_ID } } });
      await prisma.emailLog.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: BOOKING_ID }, { subjectMemberId: MEMBER_ID }] } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      const payment = await prisma.payment.findUnique({ where: { id: PAYMENT_ID }, select: { id: true } });
      if (payment) await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** A booking paid in full, with its primary Xero invoice issued. */
    async function seedPaidBooking(source: "STRIPE" | "INTERNET_BANKING" = "STRIPE") {
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Follow", lastName: "Money", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3403 Lodge", slug: "race-3403" } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
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
          source,
          status: "SUCCEEDED",
          xeroInvoiceId: "inv_race_3403_primary",
          ...(source === "STRIPE"
            ? {
                stripePaymentIntentId: PRIMARY_INTENT,
                stripeCustomerId: "cus_race_3403",
                transactions: {
                  create: { kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT, amountCents: PAID_CENTS, status: "SUCCEEDED" },
                },
              }
            : {}),
        },
      });
    }

    /**
     * One priced increase of `ownCents`: its history row, the card ask its door
     * mints (carrying whatever the payment still asks for), and its Xero leg,
     * which parks the change's own invoice on that ask - in the door's order.
     */
    async function priceIncrease(modificationId: string, ownCents: number, options: { xeroLeg?: boolean } = {}): Promise<string> {
      const [{ createModificationAdditionalPaymentIntent }, { sizeAdditionalAsk }] = await Promise.all([
        import("@/lib/booking-modification-settlement"),
        import("@/lib/additional-payment-ask"),
      ]);
      await prisma.bookingModification.create({
        data: { id: modificationId, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "GUEST_ADD", previousData: {}, newData: {}, priceDiffCents: ownCents },
      });
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { finalPriceCents: { increment: ownCents }, totalPriceCents: { increment: ownCents } } });
      const mirror = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { additionalAmountCents: true, additionalPaymentStatus: true },
      });
      const minted = await createModificationAdditionalPaymentIntent({
        format: CLUB_FORMAT_TEST,
        bookingId: BOOKING_ID,
        door: "guestAdd",
        failureMessage: "race-3403: the mint failed",
        result: {
          pendingRefundAmountCents: 0,
          organiserChildRefund: null,
          paymentId: PAYMENT_ID,
          additionalAsk: sizeAdditionalAsk({ priceDiffCents: ownCents, changeFeeCents: 0, payment: mirror }),
          retiredAdditionalAsks: [],
          hasSucceededPayment: true,
          hasIssuedXeroInvoice: true,
          paymentCustomerId: "cus_race_3403",
          memberEmail: `${MEMBER_ID}@example.invalid`,
          memberName: "Follow Money",
          memberFirstName: "Follow",
          memberId: MEMBER_ID,
          bookingModificationId: modificationId,
          priceLines: null,
        },
      });
      const intentId = minted.additionalPaymentIntentId;
      if (!intentId) throw new Error(`race-3403: ${modificationId}'s ask was not minted`);
      if (options.xeroLeg !== false) await editXeroLeg(modificationId, ownCents, intentId);
      return intentId;
    }

    /** The edit's Xero leg: parks the change's own invoice on its ask (or, on an ask already superseded, follows it on). */
    async function editXeroLeg(modificationId: string, ownCents: number, intentId: string) {
      const { queueXeroBookingEditSettlement } = await import("@/lib/xero-booking-edit-settlement");
      await queueXeroBookingEditSettlement({
        bookingId: BOOKING_ID,
        bookingModificationId: modificationId,
        hasIssuedXeroInvoice: true,
        originalPaymentStatus: "SUCCEEDED",
        priceDiffCents: ownCents,
        changeFeeCents: 0,
        requiresAdditionalStripePayment: true,
        additionalPaymentIntentId: intentId,
      });
    }

    /** A bank-transfer edit's Xero leg: its invoice is queued unpaid, there is no card ask. */
    async function priceBankTransferIncrease(modificationId: string, ownCents: number) {
      const { queueXeroBookingEditSettlement } = await import("@/lib/xero-booking-edit-settlement");
      await prisma.bookingModification.create({
        data: { id: modificationId, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "GUEST_ADD", previousData: {}, newData: {}, priceDiffCents: ownCents },
      });
      await queueXeroBookingEditSettlement({
        bookingId: BOOKING_ID,
        bookingModificationId: modificationId,
        hasIssuedXeroInvoice: true,
        originalPaymentStatus: "SUCCEEDED",
        priceDiffCents: ownCents,
        changeFeeCents: 0,
        requiresAdditionalStripePayment: false,
        additionalPaymentIntentId: null,
      });
    }

    async function deliver(type: "payment_intent.succeeded" | "payment_intent.payment_failed", intentId: string) {
      const webhook = await import("@/lib/stripe-webhook-service");
      webhookEventSequence += 1;
      const event = {
        id: `evt_race_3403_${webhookEventSequence}`,
        object: "event",
        type,
        request: null,
        data: { object: { ...stripe.intents.get(intentId)! } },
      } as unknown as Stripe.Event;
      return webhook.processStripeWebhookEvent(event);
    }

    /** The member pays this request: Stripe captures it, then its success event arrives. */
    async function payWithCard(intentId: string) {
      const intent = stripe.intents.get(intentId)!;
      if (intent.status === "canceled" || intent.status === "succeeded") throw new Error(`fake Stripe: cannot capture a ${intent.status} intent`);
      intent.status = "succeeded";
      intent.payment_method = "pm_race_3403";
      intent.latest_charge = `ch_${intentId}`;
      await deliver("payment_intent.succeeded", intentId);
    }

    /** The member's card is declined on this request: it stays confirmable with another card. */
    async function declineCard(intentId: string) {
      const intent = stripe.intents.get(intentId)!;
      intent.status = "requires_payment_method";
      intent.last_payment_error = { message: "Your card was declined." };
      await deliver("payment_intent.payment_failed", intentId);
    }

    /** The recovery worker, after its backoff: every open cancel on the booking, run now. */
    async function drainCancels() {
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      const open = await prisma.paymentRecoveryOperation.findMany({
        where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT", status: { in: ["PENDING", "FAILED"] } },
        select: { id: true },
      });
      for (const row of open) {
        await prisma.paymentRecoveryOperation.update({ where: { id: row.id }, data: { nextRetryAt: new Date(0) } });
        await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST);
      }
    }

    /**
     * B supersedes the declined A as a supersede did before #4422: no cancel row
     * names A and A stays confirmable. A seeded legacy fact - B's inline cancel
     * of A fails and that row is then removed - so the take-back for a capture
     * no cancel row owns is still proved.
     */
    async function supersedeDeclinedAskWithoutCancel(a: string, mint: () => Promise<string>) {
      stripe.failCancels = 1;
      const b = await mint();
      expect(stripe.failCancels, "B's mint tried to cancel the declined A").toBe(0);
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT", paymentIntentId: a } });
      expect(stripe.intents.get(a)?.status).toBe("requires_payment_method");
      return b;
    }

    async function invoices() {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "BookingModification", localId: { in: MODS }, queueType: "SUPPLEMENTARY_INVOICE" },
        // By change (a, b, c): rows written under the frozen clock tie on createdAt.
        orderBy: [{ localId: "asc" }, { createdAt: "asc" }],
        select: { id: true, localId: true, status: true, lastErrorCode: true, requestPayload: true },
      });
      return rows.map((row) => {
        const payload = row.requestPayload as Record<string, unknown>;
        return {
          id: row.id,
          change: row.localId,
          status: row.status,
          lastErrorCode: row.lastErrorCode,
          waitsOn: payload.paymentIntentId,
          parkedFrom: payload.parkedFromPaymentIntentId,
          cents: (payload.priceDiffCents as number) + (payload.changeFeeCents as number),
          recordPayment: payload.recordPayment,
        };
      });
    }

    async function invoiceFor(change: string) {
      const rows = (await invoices()).filter((row) => row.change === change);
      expect(rows, `one supplementary invoice for ${change}`).toHaveLength(1);
      return rows[0]!;
    }

    /** The capture's own receipt rows (`INV-PAY-139`), any status but CANCELLED. */
    async function receiptsFor(intentId: string) {
      return prisma.xeroSyncOperation.findMany({
        where: {
          queueType: "ADDITIONAL_CAPTURE_RECEIPT",
          status: { not: "CANCELLED" },
          requestPayload: { path: ["paymentIntentId"], equals: intentId },
        },
        select: { id: true, status: true },
      });
    }

    /**
     * Who records a capture (`INV-PAY-139`): the cents of every invoice naming
     * it that records a payment, and its own receipt rows.
     */
    async function recordersOf(intentId: string) {
      const naming = await prisma.xeroSyncOperation.findMany({
        where: { queueType: "SUPPLEMENTARY_INVOICE", status: { not: "CANCELLED" }, requestPayload: { path: ["paymentIntentId"], equals: intentId } },
        select: { requestPayload: true },
      });
      const invoicedCents = naming
        .map((row) => row.requestPayload as Record<string, unknown>)
        .filter((payload) => payload.recordPayment !== false)
        .reduce((sum, payload) => sum + (payload.priceDiffCents as number) + (payload.changeFeeCents as number), 0);
      return { invoicedCents, receipts: (await receiptsFor(intentId)).length };
    }

    /** The once-ever "this change was paid twice" alert's claims (`alertTakenBackInvoicesPaidAgain`). */
    async function paidTwiceAlerts() {
      return prisma.alertCooldown.count({ where: { key: { startsWith: `supplementary-invoice-paid-twice:${BOOKING_ID}:` } } });
    }

    async function captured(intentId: string) {
      const row = await prisma.paymentTransaction.findUniqueOrThrow({ where: { stripePaymentIntentId: intentId }, select: { status: true, amountCents: true } });
      expect(row.status).toBe("SUCCEEDED");
      return row.amountCents;
    }

    /** No WAITING invoice anywhere but this suite's, before the global reaper runs. */
    async function assertNoForeignWaitingInvoices() {
      const foreign = await prisma.xeroSyncOperation.findMany({
        where: { status: "WAITING_PAYMENT", NOT: { localId: { in: MODS } } },
        select: { id: true, localId: true },
      });
      expect(foreign, "another suite left WAITING_PAYMENT work the reaper would decide").toEqual([]);
    }

    async function queuedInLine(holderPid: number): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        WITH RECURSIVE line(pid) AS (
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity activity
          JOIN line ON line.pid = ANY(pg_blocking_pids(activity.pid))
          WHERE activity.datname = current_database()
        )
        SELECT COUNT(*)::int AS "count" FROM line
      `;
      return rows[0]?.count ?? 0;
    }

    async function waitForQueue(holderPid: number, depth: number, what: string) {
      const startedAt = process.hrtime.bigint();
      let seen = 0;
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        seen = await queuedInLine(holderPid);
        if (seen >= depth) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`${what}: ${seen} session(s) in line behind pid ${holderPid}, expected ${depth}.`);
    }

    /** Hold A's supplementary-invoice anchor key on a third connection until `release` resolves. */
    async function holdAnchor(anchorId: string, release: Promise<void>) {
      const held = deferred();
      let pid = 0;
      let error: unknown;
      const holder = holderClient
        .$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
            pid = rows[0]?.pid ?? 0;
            const { lockSupplementaryInvoiceAnchor } = await import("@/lib/xero-operation-outbox");
            await lockSupplementaryInvoiceAnchor(tx, anchorId);
            held.resolve();
            await release;
          },
          { maxWait: 5_000, timeout: 30_000 },
        )
        .catch((err: unknown) => {
          error = err;
          held.resolve();
        });
      await held.promise;
      if (error) throw new Error(`The holder could not take the anchor key: ${String(error)}`);
      return { pid, holder };
    }

    /** Hold the global key, `lock(1)`, on a third connection until `release` resolves. */
    async function holdGlobalKey(release: Promise<void>) {
      const held = deferred();
      let pid = 0;
      let error: unknown;
      const holder = holderClient
        .$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
            pid = rows[0]?.pid ?? 0;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
            held.resolve();
            await release;
          },
          { maxWait: 5_000, timeout: 30_000 },
        )
        .catch((err: unknown) => {
          error = err;
          held.resolve();
        });
      await held.promise;
      if (error) throw new Error(`The holder could not take the global key: ${String(error)}`);
      return { pid, holder };
    }

    /** The edit's recovery row for B after its mint was withheld, run now as the worker would after its backoff. */
    async function runAskRecovery() {
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      const retry = await prisma.paymentRecoveryOperation.findFirstOrThrow({ where: {
        bookingId: BOOKING_ID, type: "CREATE_ADDITIONAL_PAYMENT_INTENT", status: { in: ["PENDING", "FAILED"] },
      } });
      await prisma.paymentRecoveryOperation.update({ where: { id: retry.id }, data: { nextRetryAt: new Date(0) } });
      return runPaymentRecoveryOperationNow(retry.id, CLUB_FORMAT_TEST);
    }

    /** B, re-planned by its recovery after A was paid: B's own change, nothing carried, paid once. */
    async function expectReplayAsksOnlyForB(refused: string) {
      const b = stripe.created.at(-1)!;
      expect(b).not.toBe(refused);
      expect(stripe.intents.get(b)?.amount).toBe(B_CENTS);
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { stripePaymentIntentId: b } }))
        .toMatchObject({ amountCents: B_CENTS, carriedAskCents: 0 });
      await payWithCard(b);
      expect(await captured(b)).toBe(B_CENTS);
      expect(await paidTwiceAlerts()).toBe(0);
    }

    /** A price reduction's retire of the unpaid chain, in a transaction of its own, as the edit runs it. */
    async function reductionRetiresTheChain() {
      const [{ readUnpaidPriceAsk, retireUnpaidAskChain }, { unpaidAskBillingEvidence }] = await Promise.all([
        import("@/lib/additional-ask-reduction"),
        import("@/lib/unpaid-ask-billing-evidence"),
      ]);
      return prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: BOOKING_ID },
          select: {
            id: true,
            status: true,
            payment: { select: { id: true, additionalAmountCents: true, additionalPaymentStatus: true, additionalPaymentIntentId: true } },
          },
        });
        const ask = await readUnpaidPriceAsk(tx, booking);
        const retired = await retireUnpaidAskChain(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, ask });
        const evidence = await unpaidAskBillingEvidence(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, rows: ask.rows, retired });
        return { ask, retired, evidence };
      });
    }

    function installStripe() {
      stripeRaceHooks.customer = async () => ({ id: "cus_race_3403", object: "customer", metadata: {} });
      stripeRaceHooks.create = async (args) => {
        const id = `pi_race_3403_${stripe.created.length + 1}`;
        stripe.intents.set(id, {
          id,
          object: "payment_intent",
          amount: args.amountCents,
          currency: "nzd",
          status: "requires_payment_method",
          client_secret: `${id}_secret`,
          payment_method: null,
          metadata: args.metadata ?? {},
          latest_charge: null,
          last_payment_error: null,
        });
        stripe.created.push(id);
        return { ...stripe.intents.get(id)! };
      };
      stripeRaceHooks.get = async (id) => {
        const intent = stripe.intents.get(id);
        if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
        return { ...intent };
      };
      stripeRaceHooks.cancel = async (id) => {
        if (stripe.failCancels > 0) {
          stripe.failCancels -= 1;
          throw new Error("fake Stripe: connection reset");
        }
        const intent = stripe.intents.get(id);
        if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
        if (intent.status === "succeeded" || intent.status === "canceled") return { paymentIntent: { ...intent }, canceled: false };
        intent.status = "canceled";
        return { paymentIntent: { ...intent }, canceled: true };
      };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#3403 superseded-invoice carry");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const createSeparateClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      holderClient = createSeparateClient("race-3403-holder");
      observerClient = createSeparateClient("race-3403-observer");
      await Promise.all([holderClient.$connect(), observerClient.$connect()]);
    });

    beforeEach(async () => {
      await deleteFixtures();
      stripe.intents.clear();
      stripe.created = [];
      stripe.failCancels = 0;
      installStripe();
    });

    afterEach(() => {
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
      await Promise.all([holderClient?.$disconnect(), observerClient?.$disconnect()]);
    });

    it("#4442: A captures after B is sized; B is withheld and recovery asks only for B's own change", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      const create = stripeRaceHooks.create!;
      // Real webhook on real rows, after the sizing read and before B's queue
      // transaction. No cancel row exists yet, so A settles normally.
      stripeRaceHooks.create = async (args) => {
        stripeRaceHooks.create = create;
        await payWithCard(a);
        return create(args);
      };
      await expect(priceIncrease(MOD_B, B_CENTS)).rejects.toThrow("ask was not minted");
      const refusedIntent = stripe.created.at(-1)!;
      expect(stripe.intents.get(refusedIntent)?.amount).toBe(A_CENTS + B_CENTS);
      expect(await captured(a)).toBe(A_CENTS);
      expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: refusedIntent } })).toBeNull();
      expect(await prisma.paymentRecoveryOperation.count({ where: {
        paymentIntentId: a, type: "CANCEL_PAYMENT_INTENT",
      } })).toBe(0);
      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "PENDING", waitsOn: a });

      expect(await runAskRecovery()).toBe("succeeded");
      await expectReplayAsksOnlyForB(refusedIntent);
    });

    it("#4442: A captured while B's queue waits on the global key is read under the lock; B is withheld", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      const release = deferred();
      const { pid, holder } = await holdGlobalKey(release.promise);
      let mint: Promise<unknown> = Promise.resolve();
      try {
        // B is sized and minted at Stripe, then its queue transaction waits on the global key.
        mint = priceIncrease(MOD_B, B_CENTS).then(() => null, (err: unknown) => err);
        await waitForQueue(pid, 1, "B's queue behind the global key");
        expect(stripe.created, "B was minted before it queued").toHaveLength(2);
        // The capture takes the Payment row, not the global key, so it commits meanwhile.
        await Promise.race([
          payWithCard(a),
          new Promise((_, reject) => setTimeout(() => reject(new Error("A's capture waited on the global key")), LOCK_POLL_TIMEOUT_MS)),
        ]);
      } finally {
        release.resolve();
        await holder;
      }
      expect(String(await mint)).toContain("ask was not minted");
      const refusedIntent = stripe.created.at(-1)!;
      expect(stripe.intents.get(refusedIntent)?.amount).toBe(A_CENTS + B_CENTS);
      expect(await captured(a)).toBe(A_CENTS);
      expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: refusedIntent } })).toBeNull();
      expect(await prisma.paymentRecoveryOperation.count({ where: { paymentIntentId: a, type: "CANCEL_PAYMENT_INTENT" } })).toBe(0);

      expect(await runAskRecovery()).toBe("succeeded");
      await expectReplayAsksOnlyForB(refusedIntent);
    });

    it("#4442: A captured inside the recovery runner's replay of B; the claim hold refuses it and the next replay asks only for B", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      const create = stripeRaceHooks.create!;
      // B's inline mint fails at Stripe, so its recovery row carries the ask.
      stripeRaceHooks.create = async () => {
        stripeRaceHooks.create = create;
        throw new Error("fake Stripe: connection reset");
      };
      await expect(priceIncrease(MOD_B, B_CENTS)).rejects.toThrow("ask was not minted");
      expect(stripe.created).toHaveLength(1);
      // The replay sizes B on A's live balance, then A is paid before its claim hold writes.
      stripeRaceHooks.create = async (args) => {
        stripeRaceHooks.create = create;
        await payWithCard(a);
        return create(args);
      };
      expect(await runAskRecovery()).toBe("failed");
      const refusedIntent = stripe.created.at(-1)!;
      expect(stripe.intents.get(refusedIntent)?.amount).toBe(A_CENTS + B_CENTS);
      expect(await captured(a)).toBe(A_CENTS);
      expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: refusedIntent } })).toBeNull();
      expect(await prisma.paymentRecoveryOperation.count({ where: { paymentIntentId: a, type: "CANCEL_PAYMENT_INTENT" } })).toBe(0);

      expect(await runAskRecovery()).toBe("succeeded");
      await expectReplayAsksOnlyForB(refusedIntent);
    });

    it("#4442 C-F2: a frozen replay re-reads the live balance it was minted over - A paid inside its mint refuses the write", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      // An edit whose own net reads zero: its recovery cannot re-derive the ask,
      // so it replays the figure frozen when its mint failed, A's balance in it.
      await prisma.bookingModification.create({
        data: { id: MOD_B, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "GUEST_ADD", previousData: {}, newData: {}, priceDiffCents: 0 },
      });
      const [{ enqueueAdditionalPaymentIntentRecovery }, { buildAdditionalIntentRecoveryIdempotencyKey }] = await Promise.all([
        import("@/lib/payment-recovery"),
        import("@/lib/payment-recovery-keys"),
      ]);
      await enqueueAdditionalPaymentIntentRecovery({
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        idempotencyKey: buildAdditionalIntentRecoveryIdempotencyKey(MOD_B),
        amountCents: A_CENTS + B_CENTS,
        stripeIdempotencyKey: `mod_guest_${BOOKING_ID}_${MOD_B}`,
        hadIssuedXeroInvoice: true,
      });
      const create = stripeRaceHooks.create!;
      stripeRaceHooks.create = async (args) => {
        stripeRaceHooks.create = create;
        await payWithCard(a);
        return create(args);
      };

      expect(await runAskRecovery()).toBe("failed");

      const refused = stripe.created.at(-1)!;
      expect(stripe.intents.get(refused)?.amount).toBe(A_CENTS + B_CENTS);
      expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: refused } })).toBeNull();
      expect(await captured(a)).toBe(A_CENTS);
      expect(await prisma.paymentRecoveryOperation.count({ where: { paymentIntentId: a, type: "CANCEL_PAYMENT_INTENT" } })).toBe(0);

      // A second attempt must not accept the old A+B amount just because its
      // new balance snapshot is now zero. No provenance can separate A from B.
      const minted = stripe.created.length;
      expect(await runAskRecovery()).toBe("failed");
      expect(stripe.created).toHaveLength(minted);
      expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: refused } })).toBeNull();
      expect(await captured(a)).toBe(A_CENTS);
    });

    it("A -> B -> B captured: both invoices go out, each for its own amount, and their payments sum to the capture", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: a, cents: A_CENTS });

      const b = await priceIncrease(MOD_B, B_CENTS);
      // B carries A's $50; A's ask is cancelled and its invoice moved, before B's secret was returned.
      expect(stripe.intents.get(a)?.status).toBe("canceled");
      expect(stripe.intents.get(b)?.amount).toBe(A_CENTS + B_CENTS);
      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: b, parkedFrom: a, cents: A_CENTS });
      expect(await invoiceFor(MOD_B)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: b, cents: B_CENTS });

      await payWithCard(b);

      const both = await invoices();
      expect(both.map((row) => [row.change, row.status, row.cents, row.recordPayment])).toEqual([
        [MOD_A, "PENDING", A_CENTS, true],
        [MOD_B, "PENDING", B_CENTS, true],
      ]);
      // Each records its own net as received (`createXeroSupplementaryInvoice`): together, exactly the capture.
      expect(both.reduce((sum, row) => sum + row.cents, 0)).toBe(await captured(b));
    });

    it("B never paid: nothing is invoiced, and when the booking is cancelled both invoices are retired", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      const b = await priceIncrease(MOD_B, B_CENTS);
      expect((await invoices()).map((row) => [row.status, row.waitsOn])).toEqual([
        ["WAITING_PAYMENT", b],
        ["WAITING_PAYMENT", b],
      ]);
      expect(a).not.toBe(b);

      const { cancelBooking } = await import("@/lib/booking-cancel");
      await cancelBooking(BOOKING_ID, MEMBER_ID, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST, "credit");
      await drainCancels();
      // The cancel step for B finds no live carrier: nothing moves anywhere.
      expect((await invoices()).every((row) => row.status === "WAITING_PAYMENT" && row.waitsOn === b)).toBe(true);

      await assertNoForeignWaitingInvoices();
      const { reapStaleWaitingPaymentXeroOutboxOperations } = await import("@/lib/xero-waiting-invoice-reaper");
      await reapStaleWaitingPaymentXeroOutboxOperations({ failedTransactionGraceHours: 0 });

      expect((await invoices()).map((row) => [row.change, row.status, row.lastErrorCode])).toEqual([
        [MOD_A, "CANCELLED", "STALE_WAITING_PAYMENT"],
        [MOD_B, "CANCELLED", "STALE_WAITING_PAYMENT"],
      ]);
    });

    it("B captured before A's cancel lands: A's invoice is released at the move", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      // Stripe is down for B's inline cancel of A: A stays open, so nothing moves yet.
      stripe.failCancels = 1;
      const b = await priceIncrease(MOD_B, B_CENTS);
      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: a });

      await payWithCard(b);
      expect(await invoiceFor(MOD_B)).toMatchObject({ status: "PENDING", cents: B_CENTS });
      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: a });

      // The durable cancel retries: A is cancelled, and its invoice follows the money onto the captured B.
      await drainCancels();

      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "PENDING", waitsOn: b, parkedFrom: a, cents: A_CENTS, recordPayment: true });
      expect((await invoices()).reduce((sum, row) => sum + row.cents, 0)).toBe(await captured(b));
    });

    it("#4422: a DECLINED A is cancelled at Stripe at B's mint, so a stale tab cannot pay it, and its invoice moves all the same", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      await declineCard(a);
      const declined = await prisma.paymentTransaction.findUniqueOrThrow({ where: { stripePaymentIntentId: a }, select: { status: true, reason: true } });
      expect(declined.status).toBe("FAILED");

      const b = await priceIncrease(MOD_B, B_CENTS);
      expect(stripe.intents.get(a)?.status).toBe("canceled");
      expect(
        await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT" }, select: { paymentIntentId: true, status: true } }),
      ).toEqual([{ paymentIntentId: a, status: "SUCCEEDED" }]);
      // The declined row keeps its own record; the supersede's FAILED write is fenced on an open status.
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { stripePaymentIntentId: a }, select: { status: true, reason: true } })).toEqual(declined);
      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: b, parkedFrom: a });
      await expect(payWithCard(a)).rejects.toThrow("cannot capture a canceled intent");

      await payWithCard(b);
      expect((await invoices()).map((row) => row.status)).toEqual(["PENDING", "PENDING"]);
    });

    it("A -> B -> C: three invoices on C's capture, each its own, summing to it", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      const b = await priceIncrease(MOD_B, B_CENTS);
      const c = await priceIncrease(MOD_C, C_CENTS);
      expect(stripe.intents.get(c)?.amount).toBe(A_CENTS + B_CENTS + C_CENTS);
      expect((await invoices()).map((row) => [row.change, row.waitsOn, row.parkedFrom ?? null])).toEqual([
        [MOD_A, c, a],
        [MOD_B, c, b],
        [MOD_C, c, null],
      ]);

      await payWithCard(c);

      const all = await invoices();
      expect(all.map((row) => [row.status, row.cents])).toEqual([
        ["PENDING", A_CENTS],
        ["PENDING", B_CENTS],
        ["PENDING", C_CENTS],
      ]);
      expect(all.reduce((sum, row) => sum + row.cents, 0)).toBe(await captured(c));
    });

    describe("review round (db90565cb)", () => {
      it("M1: a DECLINED A paid from a stale tab after its invoice moved takes it back: A's capture records A's invoice", async () => {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        await declineCard(a);
        const b = await supersedeDeclinedAskWithoutCancel(a, () => priceIncrease(MOD_B, B_CENTS));
        expect(await invoiceFor(MOD_A)).toMatchObject({ waitsOn: b, parkedFrom: a });

        // No cancel row names it, so the old secret still confirms with another card.
        await payWithCard(a);

        expect(await captured(a)).toBe(A_CENTS);
        expect(await invoiceFor(MOD_A)).toMatchObject({ status: "PENDING", waitsOn: a, parkedFrom: undefined, cents: A_CENTS, recordPayment: true });
        expect(await invoiceFor(MOD_B)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: b, cents: B_CENTS });
      });

      it("C4: a capture after A, then a newer request: A's invoice moves onto the capture that absorbed it, never dropped", async () => {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        // Stripe is down for B's inline cancel of A; C's mint finds A's cancel already queued, in its backoff.
        stripe.failCancels = 1;
        const b = await priceIncrease(MOD_B, B_CENTS);
        await payWithCard(b);
        const c = await priceIncrease(MOD_C, C_CENTS);
        expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: a });

        await drainCancels();

        expect(await invoiceFor(MOD_A)).toMatchObject({ status: "PENDING", waitsOn: b, parkedFrom: a, cents: A_CENTS });
        expect(await invoiceFor(MOD_C)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: c });
        const onB = (await invoices()).filter((row) => row.waitsOn === b);
        expect(onB.reduce((sum, row) => sum + row.cents, 0)).toBe(await captured(b));
      });

      describe("C2 (review 2, F5): the move onto a captured carrier against that carrier's REAL receipt deciding, on the carrier's key", () => {
        /**
         * B has no invoice of its own, so its capture queues its own receipt
         * (`enqueueAdditionalCaptureReceiptOperation`); the outbox claims it and
         * the real worker plans it, storing its decision under B's change key.
         * A's durable cancel runs the move onto B under the same key. Xero is a
         * fake that reads the primary with room for B and stops at the payment.
         */
        async function race(first: "receipt" | "move") {
          await seedPaidBooking();
          const a = await priceIncrease(MOD_A, A_CENTS);
          stripe.failCancels = 1;
          const b = await priceIncrease(MOD_B, B_CENTS, { xeroLeg: false });
          await payWithCard(b);
          expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: a });
          const [receipt] = await receiptsFor(b);
          if (!receipt) throw new Error("race-3403: B's capture queued no receipt");
          const [{ claimXeroSyncOperationToRunning }, worker, busy] = await Promise.all([
            import("@/lib/xero-operation-claim"),
            import("@/lib/additional-capture-xero-receipt"),
            import("@/lib/xero-applied-credit-operation-serialization"),
          ]);
          const receiptClaim = await claimXeroSyncOperationToRunning(receipt.id, { localModel: { in: ["PaymentTransaction"] } });
          expect(receiptClaim).not.toBeNull();
          const runReceipt = () =>
            worker.recordAdditionalCaptureReceipt(
              { syncOperation: receiptClaim! },
              {
                getAuthenticatedXeroClient: (async () => ({ xero: {}, tenantId: "tenant_race_3403" })) as never,
                callXeroApi: (async () => ({
                  body: { invoices: [{ invoiceID: "inv_race_3403_primary", status: "AUTHORISED", amountDue: 1_000, payments: [] }] },
                })) as never,
                createXeroPaymentForInvoice: async () => {
                  throw new busy.XeroAppliedCreditOperationBusyError("test: stop at the Xero payment");
                },
                readStripeCaptureDocumentDate: async () => null,
              },
            );

          const release = deferred();
          const { pid, holder } = await holdAnchor(MOD_B, release.promise);
          const started: Promise<unknown>[] = [];
          try {
            if (first === "receipt") {
              started.push(runReceipt());
              await waitForQueue(pid, 1, "the receipt's decision behind B's key");
              started.push(drainCancels());
              await waitForQueue(pid, 2, "the move behind the receipt");
            } else {
              started.push(drainCancels());
              await waitForQueue(pid, 1, "the move behind B's key");
              started.push(runReceipt());
              await waitForQueue(pid, 2, "the receipt's decision behind the move");
            }
            expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: a });
          } finally {
            release.resolve();
            await holder;
          }
          const [receiptRun] = await Promise.allSettled(first === "receipt" ? started : [...started].reverse());
          const stored = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: receipt.id }, select: { requestPayload: true } });
          return { a, b, receiptRun, plan: (stored.requestPayload as Record<string, unknown>).plan ?? null };
        }

        it("the receipt decides first: it records B, and A's invoice moved onto B goes out unpaid", async () => {
          const { a, b, plan } = await race("receipt");
          expect(plan).toMatchObject({ target: "PRIMARY_INVOICE", invoiceId: "inv_race_3403_primary", capturedCents: await captured(b) });
          expect(await invoiceFor(MOD_A)).toMatchObject({ status: "PENDING", waitsOn: b, parkedFrom: a, recordPayment: false });
          // Exactly one recorder of B's capture: its receipt.
          expect(await recordersOf(b)).toEqual({ invoicedCents: 0, receipts: 1 });
        });

        it("the move decides first: the receipt already running counts, so A's invoice still goes out unpaid and the receipt records B against it", async () => {
          const { a, b, receiptRun, plan } = await race("move");
          expect(await invoiceFor(MOD_A)).toMatchObject({ status: "PENDING", waitsOn: b, parkedFrom: a, recordPayment: false });
          // Its decision, read again under the key, finds the invoice it now belongs to: nothing stored, decided next run.
          expect(plan).toBeNull();
          expect(receiptRun).toMatchObject({ status: "rejected" });
          const { readCaptureRecorder } = await import("@/lib/additional-capture-recorder");
          const recorder = await readCaptureRecorder({ bookingId: BOOKING_ID, primaryInvoiceId: "inv_race_3403_primary", paymentIntentId: b, bookingModificationId: MOD_B });
          expect(recorder).toMatchObject({ kind: "receipt", target: { kind: "CHANGE_INVOICE", operation: { id: (await invoiceFor(MOD_A)).id } } });
          expect(await recordersOf(b)).toEqual({ invoicedCents: 0, receipts: 1 });
        });
      });

      it("C5: B's capture lands while the move waits on A's key - the move, reading under the key, releases A's invoice itself", async () => {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        stripe.failCancels = 1;
        const b = await priceIncrease(MOD_B, B_CENTS);

        const release = deferred();
        const { pid, holder } = await holdAnchor(MOD_A, release.promise);
        let cancel: Promise<void> | undefined;
        try {
          cancel = drainCancels();
          await waitForQueue(pid, 1, "the move behind A's key");
          // B is paid now: its release sees only B's own invoice on B.
          await payWithCard(b);
          expect(await invoiceFor(MOD_B)).toMatchObject({ status: "PENDING" });
          expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: a });
        } finally {
          release.resolve();
          await holder;
          await cancel;
        }
        expect(await invoiceFor(MOD_A)).toMatchObject({ status: "PENDING", waitsOn: b, parkedFrom: a });
        expect((await invoices()).reduce((sum, row) => sum + row.cents, 0)).toBe(await captured(b));
      });
    });

    describe("review 2 (9a0c129d4)", () => {
      it("F1: A moved to B, then B captured late while C supersedes - both invoices follow on to C, never stranded on the refunded B", async () => {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        await declineCard(a);
        const b = await priceIncrease(MOD_B, B_CENTS);
        expect(await invoiceFor(MOD_A)).toMatchObject({ waitsOn: b, parkedFrom: a });

        // Stripe is down for C's inline cancel of B: B stays confirmable, its cancel queued.
        stripe.failCancels = 1;
        const c = await priceIncrease(MOD_C, C_CENTS);
        expect(stripe.intents.get(c)?.amount).toBe(A_CENTS + B_CENTS + C_CENTS);
        expect((await invoices()).map((row) => [row.change, row.waitsOn])).toEqual([
          [MOD_A, b],
          [MOD_B, b],
          [MOD_C, c],
        ]);

        // B is paid from its old tab before its cancel lands: a late capture, refunded.
        await payWithCard(b);
        await drainCancels();

        expect((await invoices()).map((row) => [row.change, row.status, row.waitsOn, row.parkedFrom ?? null])).toEqual([
          [MOD_A, "WAITING_PAYMENT", c, a],
          [MOD_B, "WAITING_PAYMENT", c, b],
          [MOD_C, "WAITING_PAYMENT", c, null],
        ]);

        await payWithCard(c);
        const all = await invoices();
        expect(all.map((row) => [row.status, row.cents])).toEqual([
          ["PENDING", A_CENTS],
          ["PENDING", B_CENTS],
          ["PENDING", C_CENTS],
        ]);
        expect(all.reduce((sum, row) => sum + row.cents, 0)).toBe(await captured(c));
      });
    });

    describe("review 2 (9a0c129d4), F2", () => {
      it("a move made unpaid by the carrier's own receipt is paid again when A's own capture takes it back", async () => {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS, { xeroLeg: false });
        await declineCard(a);
        // B has no invoice of its own: its capture is recorded by its own receipt.
        const b = await supersedeDeclinedAskWithoutCancel(a, () => priceIncrease(MOD_B, B_CENTS, { xeroLeg: false }));
        await payWithCard(b);
        const [receiptB] = await receiptsFor(b);
        expect(receiptB).toBeDefined();
        // The outbox has claimed it: it is being sent, which the move counts (`anchorCaptureHasReceipt`).
        const { claimXeroSyncOperationToRunning } = await import("@/lib/xero-operation-claim");
        expect(await claimXeroSyncOperationToRunning(receiptB!.id, { localModel: { in: ["PaymentTransaction"] } })).toBeTruthy();

        // A's edit leg lands late, on the declined ask: its invoice moves onto the captured B,
        // unpaid. Between that move's commit and its release, A is paid from its stale tab.
        const lateCapture = await import("@/lib/xero-supplementary-invoice-late-capture");
        const release = lateCapture.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent;
        let paidA = false;
        const spy = vi
          .spyOn(lateCapture, "releaseXeroSupplementaryInvoiceForCapturedPaymentIntent")
          .mockImplementation(async (intentId: string) => {
            if (intentId === b && !paidA) {
              paidA = true;
              expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: b, recordPayment: false });
              await payWithCard(a);
            }
            return release(intentId);
          });
        try {
          await editXeroLeg(MOD_A, A_CENTS, a);
        } finally {
          spy.mockRestore();
        }
        expect(paidA).toBe(true);

        // A's capture records A's invoice: paid again, never left unpaid with A recorded nowhere.
        const invoiceA = await invoiceFor(MOD_A);
        expect(invoiceA).toMatchObject({ status: "PENDING", waitsOn: a, parkedFrom: undefined, cents: A_CENTS, recordPayment: true });
        const payloadA = (await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: invoiceA.id } })).requestPayload as Record<string, unknown>;
        expect(payloadA).not.toHaveProperty("movedUnpaidOntoCarrier");
        expect(await receiptsFor(a)).toEqual([]);
        expect(await captured(a)).toBe(A_CENTS);
        // B's capture keeps its one recorder, its own receipt.
        expect(await receiptsFor(b)).toEqual([{ id: receiptB!.id, status: "RUNNING" }]);
      });
    });

    describe("review 2 (9a0c129d4), F3: the superseded ask AND its carrier both paid and kept", () => {
      /** A declined (and left confirmable), its invoice moved onto B, which carries A's balance as well as its own. */
      async function aCarriedByB() {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        await declineCard(a);
        const b = await supersedeDeclinedAskWithoutCancel(a, () => priceIncrease(MOD_B, B_CENTS));
        expect(await invoiceFor(MOD_A)).toMatchObject({ waitsOn: b, parkedFrom: a });
        return { a, b };
      }

      it("the carrier first: its invoices record all of B; A's own capture is recorded by its own receipt, never stood down", async () => {
        const { a, b } = await aCarriedByB();
        await payWithCard(b);
        await payWithCard(a);

        // Every captured dollar has exactly one recorder.
        expect(await recordersOf(b)).toEqual({ invoicedCents: await captured(b), receipts: 0 });
        expect(await recordersOf(a)).toEqual({ invoicedCents: 0, receipts: 1 });
        expect(await captured(a)).toBe(A_CENTS);
        // The repair's view agrees: A's change invoice records B's capture, not A's.
        const { readSupplementaryRecordedIntents, readCapturedStripeCash } = await import("@/lib/additional-capture-recorder");
        const recorded = await readSupplementaryRecordedIntents(BOOKING_ID, await readCapturedStripeCash(BOOKING_ID));
        expect(recorded.has(b)).toBe(true);
        expect(recorded.has(a)).toBe(false);
        expect(await paidTwiceAlerts()).toBe(0);
      });

      it("the ask first: A's invoice comes back and records A; B's own invoice records only B's own amount, and an officer is told once that B paid A's change again", async () => {
        const { a, b } = await aCarriedByB();
        // The officer alert reaches one admin (the CI harness doubles this sender for another suite).
        const email = await import("@/lib/email");
        const alert = vi
          .spyOn(email, "sendAdminXeroSyncErrorAlert")
          .mockResolvedValue({ deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 } as never);
        const paidTwiceSends = () =>
          alert.mock.calls.filter(([data]) => (data as { errorType: string }).errorType === "SUPPLEMENTARY_INVOICE_CHANGE_PAID_TWICE");
        try {
          await payWithCard(a);
          expect(await invoiceFor(MOD_A)).toMatchObject({ status: "PENDING", waitsOn: a, recordPayment: true });
          expect(paidTwiceSends()).toHaveLength(0);

          await payWithCard(b);

          expect(await recordersOf(a)).toEqual({ invoicedCents: await captured(a), receipts: 0 });
          // B's capture carried A's balance too: only B's own amount is recorded, never A's twice...
          expect(await captured(b)).toBe(A_CENTS + B_CENTS);
          expect(await recordersOf(b)).toEqual({ invoicedCents: B_CENTS, receipts: 0 });
          // ...and the A_CENTS of it nothing bills is an officer's, told once whoever releases B again.
          expect(paidTwiceSends()).toHaveLength(1);
          expect(await paidTwiceAlerts()).toBe(1);
          const { releaseXeroSupplementaryInvoiceForCapturedPaymentIntent } = await import("@/lib/xero-supplementary-invoice-late-capture");
          await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(b);
          expect(paidTwiceSends()).toHaveLength(1);
        } finally {
          alert.mockRestore();
        }
      });
    });

    describe("review 2 (9a0c129d4), F6", () => {
      it("a carrier with no invoice of its own whose receipt is still queued: the move writes A's invoice unpaid, so B's receipt records B instead of standing down", async () => {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        stripe.failCancels = 1;
        const b = await priceIncrease(MOD_B, B_CENTS, { xeroLeg: false });
        await payWithCard(b);
        const [receipt] = await receiptsFor(b);
        expect(receipt).toMatchObject({ status: "PENDING" });

        // A's cancel lands before the outbox picks B's receipt up: the move onto the captured B.
        await drainCancels();
        const invoiceA = await invoiceFor(MOD_A);
        expect(invoiceA).toMatchObject({ status: "PENDING", waitsOn: b, parkedFrom: a, recordPayment: false });
        // Unpaid, it is never B's recorder: B's receipt does not stand down to it.
        const { readCaptureRecorder } = await import("@/lib/additional-capture-recorder");
        const recorder = await readCaptureRecorder({ bookingId: BOOKING_ID, primaryInvoiceId: "inv_race_3403_primary", paymentIntentId: b, bookingModificationId: MOD_B });
        expect(recorder).toMatchObject({ kind: "receipt", target: { kind: "CHANGE_INVOICE", operation: { id: invoiceA.id } } });

        // A's invoice reaches Xero (the outbox's create, a seeded fact here), then the receipt
        // runs through the outbox's claim and the real worker; Xero is a fake.
        await prisma.xeroSyncOperation.update({ where: { id: invoiceA.id }, data: { status: "SUCCEEDED", completedAt: new Date() } });
        await prisma.xeroObjectLink.create({
          data: { localModel: "BookingModification", localId: MOD_A, xeroObjectType: "INVOICE", xeroObjectId: "inv_race_3403_mod_a", role: "SUPPLEMENTARY_INVOICE" },
        });
        const [{ claimXeroSyncOperationToRunning }, worker] = await Promise.all([
          import("@/lib/xero-operation-claim"),
          import("@/lib/additional-capture-xero-receipt"),
        ]);
        const receiptClaim = await claimXeroSyncOperationToRunning(receipt!.id, { localModel: { in: ["PaymentTransaction"] } });
        expect(receiptClaim).not.toBeNull();
        const sent: Array<{ invoiceId: string; amountCents: number }> = [];
        await worker.recordAdditionalCaptureReceipt(
          { syncOperation: receiptClaim! },
          {
            getAuthenticatedXeroClient: (async () => ({ xero: {}, tenantId: "tenant_race_3403" })) as never,
            callXeroApi: (async (_call: unknown, meta: { context: string }) => ({
              body: {
                invoices: meta.context.includes("inv_race_3403_mod_a")
                  ? [{ invoiceID: "inv_race_3403_mod_a", status: "AUTHORISED", amountDue: A_CENTS / 100, payments: [] }]
                  : [{ invoiceID: "inv_race_3403_primary", status: "AUTHORISED", amountDue: 1_000, payments: [] }],
              },
            })) as never,
            createXeroPaymentForInvoice: async (input: { invoiceId: string; amountCents: number }) => {
              sent.push({ invoiceId: input.invoiceId, amountCents: input.amountCents });
              return "pay_race_3403_receipt_b";
            },
            readStripeCaptureDocumentDate: async () => null,
          } as never,
        );

        // B's capture is recorded once, by its own receipt, against the invoice that bills A's part
        // of it; no invoice records it. What A's invoice has no room for - B's own change, which
        // has no invoice - is not guessed onto another document: the receipt tells an officer.
        expect(await captured(b)).toBe(A_CENTS + B_CENTS);
        expect(sent).toEqual([{ invoiceId: "inv_race_3403_mod_a", amountCents: A_CENTS }]);
        expect(await recordersOf(b)).toEqual({ invoicedCents: 0, receipts: 1 });
        const done = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: receipt!.id }, select: { status: true, responsePayload: true } });
        expect(done).toMatchObject({ status: "SUCCEEDED", responsePayload: { unrecordedCents: B_CENTS } });
      });
    });

    describe("the move against a price reduction's retire (`retireUnpaidAskChain`)", () => {
      it("the reduction first, the move queued on A's anchor: A's invoice is retired, counted once, and never moved", async () => {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        stripe.failCancels = 1;
        const b = await priceIncrease(MOD_B, B_CENTS);
        expect(await invoiceFor(MOD_A)).toMatchObject({ waitsOn: a });

        const release = deferred();
        const { pid, holder } = await holdAnchor(MOD_A, release.promise);
        let reduction: Awaited<ReturnType<typeof reductionRetiresTheChain>>;
        let cancel: Promise<void> | undefined;
        try {
          // A's durable cancel runs: A FAILED, then the move queues on A's anchor.
          cancel = drainCancels();
          await waitForQueue(pid, 1, "the move behind the anchor holder");
          reduction = await reductionRetiresTheChain();
        } finally {
          release.resolve();
          await holder;
          await cancel;
        }

        expect(reduction.retired.invoicedCents).toBe(A_CENTS + B_CENTS);
        expect(reduction.evidence.supplementaryInvoicedCents).toBe(A_CENTS + B_CENTS);
        const after = await invoices();
        expect(after.map((row) => [row.change, row.status, row.waitsOn])).toEqual([
          [MOD_A, "CANCELLED", a],
          [MOD_B, "CANCELLED", b],
        ]);
      });

      it("the move first: the reduction still retires A's invoice off B and reads it as A's own money, once", async () => {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        const b = await priceIncrease(MOD_B, B_CENTS);
        expect(await invoiceFor(MOD_A)).toMatchObject({ waitsOn: b, parkedFrom: a });

        const reduction = await reductionRetiresTheChain();

        expect(reduction.retired.invoicedCents).toBe(A_CENTS + B_CENTS);
        // Attributed to A's row (where it was first asked), not B's: B's own invoice covers B.
        expect(reduction.retired.parkedOps).toEqual(
          expect.arrayContaining([
            { intentId: a, anchorId: MOD_A },
            { intentId: b, anchorId: MOD_B },
          ]),
        );
        expect(reduction.evidence).toEqual({ supplementaryInvoicedCents: A_CENTS + B_CENTS, established: true });
        expect((await invoices()).map((row) => row.status)).toEqual(["CANCELLED", "CANCELLED"]);
      });
    });

    describe("the move against the repair pass's enqueue of A's invoice", () => {
      async function race(first: "repair" | "move") {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        stripe.failCancels = 1;
        const b = await priceIncrease(MOD_B, B_CENTS);
        const { enqueueXeroSupplementaryInvoiceOperation } = await import("@/lib/xero-operation-outbox");
        // The repair's QUEUE_SUPPLEMENTARY_INVOICE for an ordinary edit: no plan, the enqueue's defaults.
        const repair = () => enqueueXeroSupplementaryInvoiceOperation({ bookingId: BOOKING_ID, bookingModificationId: MOD_A, priceDiffCents: A_CENTS, changeFeeCents: 0 });

        const release = deferred();
        const { pid, holder } = await holdAnchor(MOD_A, release.promise);
        const started: Promise<unknown>[] = [];
        try {
          if (first === "repair") {
            started.push(repair());
            await waitForQueue(pid, 1, "the repair behind the anchor holder");
            started.push(drainCancels());
            await waitForQueue(pid, 2, "the move behind the repair");
          } else {
            started.push(drainCancels());
            await waitForQueue(pid, 1, "the move behind the anchor holder");
            started.push(repair());
            await waitForQueue(pid, 2, "the repair behind the move");
          }
        } finally {
          release.resolve();
          await holder;
          await Promise.all(started);
        }
        return { a, b };
      }

      it.each(["repair", "move"] as const)("%s first: one invoice for A's change, waiting on B", async (first) => {
        const { a, b } = await race(first);
        expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: b, parkedFrom: a, cents: A_CENTS });
      });
    });

    /*
      #4422: B superseded a DECLINED A while Stripe was down for A's cancel, so
      A's cancel row waits for its retry and A is still confirmable. B is paid
      and released: A's and B's invoices both record B's capture. Then the
      member pays A from a stale tab while the cancel runs - Stripe has captured
      it by the time the runner's cancel arrives. Before #4422 no cancel row
      named a declined A, so that capture settled as a late capture and took
      A's invoice back off the already-released B: the member paid twice and
      B's A_CENTS was recorded nowhere. Now the live row owns it, whichever of
      the webhook and the runner's hand-off claims it first.
    */
    describe("#4422: a declined ask's stale-tab capture racing its cancel, the carrier already paid and released", () => {
      it.each(["webhook", "runner"] as const)("the %s claims A first: one superseded refund, both invoices stay on B, nothing recorded for A", async (first) => {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        await declineCard(a);
        stripe.failCancels = 1;
        const b = await priceIncrease(MOD_B, B_CENTS);
        expect(stripe.intents.get(a)?.status).toBe("requires_payment_method");
        expect(
          await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT" }, select: { paymentIntentId: true, status: true } }),
        ).toEqual([{ paymentIntentId: a, status: "FAILED" }]);

        await payWithCard(b);
        expect((await invoices()).map((row) => [row.change, row.status, row.waitsOn])).toEqual([
          [MOD_A, "PENDING", b],
          [MOD_B, "PENDING", b],
        ]);

        // The stale tab pays A between the runner's read and its cancel.
        const cancelAtStripe = stripeRaceHooks.cancel!;
        stripeRaceHooks.cancel = async (id) => {
          if (id === a) {
            const intent = stripe.intents.get(a)!;
            intent.status = "succeeded";
            intent.payment_method = "pm_race_3403_stale_tab";
            intent.latest_charge = `ch_${a}`;
            if (first === "webhook") await deliver("payment_intent.succeeded", a);
          }
          return cancelAtStripe(id);
        };
        await drainCancels();
        if (first === "runner") await deliver("payment_intent.succeeded", a);

        expect(await captured(a)).toBe(A_CENTS);
        expect(
          await prisma.paymentRecoveryOperation.findMany({
            where: { bookingId: BOOKING_ID, paymentIntentId: a },
            orderBy: { type: "asc" },
            select: { type: true, status: true, amountCents: true },
          }),
        ).toEqual([
          { type: "CANCEL_PAYMENT_INTENT", status: "SUCCEEDED", amountCents: A_CENTS },
          { type: "REFUND_SUPERSEDED_PAYMENT", status: "PENDING", amountCents: A_CENTS },
        ]);
        // B's capture keeps both invoices; A's capture is going back, so nothing records it.
        const all = await invoices();
        expect(all.map((row) => [row.change, row.status, row.waitsOn, row.recordPayment])).toEqual([
          [MOD_A, "PENDING", b, true],
          [MOD_B, "PENDING", b, true],
        ]);
        expect(all.reduce((sum, row) => sum + row.cents, 0)).toBe(await captured(b));
        expect(await recordersOf(b)).toEqual({ invoicedCents: await captured(b), receipts: 0 });
        expect(await recordersOf(a)).toEqual({ invoicedCents: 0, receipts: 0 });
        expect(await paidTwiceAlerts()).toBe(0);
      });
    });

    it("two bank-transfer edits: each invoice was queued unpaid when priced; nothing waits and nothing moves", async () => {
      await seedPaidBooking("INTERNET_BANKING");
      await priceBankTransferIncrease(MOD_A, A_CENTS);
      await priceBankTransferIncrease(MOD_B, B_CENTS);
      const before = await invoices();
      expect(before.map((row) => [row.change, row.status, row.waitsOn, row.recordPayment])).toEqual([
        [MOD_A, "PENDING", null, false],
        [MOD_B, "PENDING", null, false],
      ]);

      const { followSupersededAskInvoicesToCarrier } = await import("@/lib/superseded-ask-invoice-carry");
      expect(await followSupersededAskInvoicesToCarrier({ paymentId: PAYMENT_ID })).toEqual({
        carrierPaymentIntentIds: [],
        moved: 0,
        refusals: [],
        releasedOnCapturedCarrier: false,
      });
      expect(await invoices()).toEqual(before);
    });
  },
);
