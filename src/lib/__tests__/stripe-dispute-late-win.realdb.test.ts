import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { postHandBackObligation } from "@/lib/member-money/doors";
import { memberMoneyEventKeys } from "@/lib/member-money";
import { editRefundHandBackOccurrenceKey, EDIT_REFUND_HAND_BACK_REOPEN_AFTER_CANCEL_MESSAGE } from "@/lib/manual-refund-task-settlement-rules";
import { REOPEN_DISMISSAL_STATUS_UNRECORDED_MESSAGE } from "@/lib/manual-refund-task-reopen";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures, settleHistoryByCard } from "./support/booking-ledger-history";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

/**
 * #5197 (`INV-PAY-154`): A LOST CARD DISPUTE STRIPE LATER REPORTS WON, through the real
 * webhook processor (`processStripeWebhookEvent`) on PostgreSQL. A hand-back dismissed while the dispute read lost
 * is reopened with its refund debt posted again, so the journal owes what the task does; a reduction made for the
 * loss is named in the alert and nothing is written; the alert is sent once, however the event is delivered. The
 * officer's real Dismiss and Reduce race the webhook in both orders: whichever commits first, nothing is lost and
 * nothing deadlocks.
 *
 * DATABASE_URL must point at the race database before any import builds the Prisma client.
 */
vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

const sent = vi.hoisted(() => ({ alerts: [] as { stage: string; disputeId: string; disputeNextStep: string }[], undelivered: 0 }));

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());
// The alert's fields, as the treasurer would read them; no email leaves the test.
vi.mock("@/lib/email", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email")),
  sendAdminStripeDisputeAlert: async (fields: { stage: string; disputeId: string; disputeNextStep: string }) => {
    if (sent.undelivered > 0) {
      sent.undelivered -= 1;
      return "undelivered";
    }
    sent.alerts.push(fields);
    return "sent";
  },
}));

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-lw-";
const names = historyNames(PREFIX);
const context = memberMoneyTestContext();
const OPENED = new Date("2026-06-20T00:00:00.000Z");
let db: PrismaClient;
let sequence = 0;
let eventSequence = 0;

/** A card booking settled for $400 (R01 and its receipt in the journal). */
async function cardBooking() {
  const id = `${PREFIX}${++sequence}`;
  const intent = `pi_${id}`;
  const night = { priceCents: 10_000, priceSource: "SOLD" as const };
  await createHistoryBooking(db, names, id, { payment: { amountCents: 40_000, source: "STRIPE", intent }, guests: [[night, night], [night, night]] });
  await settleHistoryByCard(id, 40_000);
  return id;
}

/** One dispute on the booking's capture, its opened and closed alerts already sent (only the late win's is watched). */
async function dispute(id: string, cents: number, status: "LOST" | "OPEN" = "LOST", suffix = "a") {
  const capture = await db.paymentTransaction.findFirstOrThrow({ where: { paymentId: `${id}-payment`, stripePaymentIntentId: `pi_${id}` }, select: { id: true } });
  const disputeId = `dp_${id}_${suffix}`;
  await db.stripeDispute.create({ data: { stripeDisputeId: disputeId, stripeChargeId: `ch_${id}`, stripePaymentIntentId: `pi_${id}`, paymentTransactionId: capture.id,
    paymentId: `${id}-payment`, bookingId: id, amountCents: cents, currency: "nzd", reason: "fraudulent", status, stripeStatus: status.toLowerCase(),
    stripeCreatedAt: OPENED, lastEventCreatedAt: OPENED, stripeEventId: `evt_${disputeId}`, openedAlertedAt: OPENED, closedAlertedAt: OPENED } });
  return disputeId;
}

/** One treasurer task on the booking's payment and its R05, raised together under `lock(1)` as the doors raise them. */
async function raise(id: string, kind: "edit" | "cancel", cents: number, day: number) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const task = await tx.manualRefundTask.create({ data: {
      bookingId: id, paymentId: `${id}-payment`, amountCents: cents, raisedAmountCents: cents, kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: kind === "edit" ? editRefundHandBackOccurrenceKey(`${id}-mod-${day}`) : null,
      reason: `Booking ${id} ${kind === "edit" ? "lowered by a date change" : "cancelled"} while its card payment is disputed by the cardholder.`,
      createdAt: new Date(`2026-06-${String(20 + day).padStart(2, "0")}T00:00:00.000Z`),
    } });
    await postHandBackObligation(tx, context, { bookingId: id, taskId: task.id, amountCents: cents, origin: "APP", debtorRead: "booking-row" });
    return task.id;
  });
}

/** The booking cancelled at `at`, as every cancellation records it. */
async function cancelled(id: string, at: Date) {
  await db.booking.update({ where: { id }, data: { status: "CANCELLED" } });
  await db.bookingEvent.create({ data: { bookingId: id, type: "CANCELLED", occurredAt: at, createdAt: at } });
}

const dismiss = async (taskId: string) => (await import("@/lib/manual-refund-task-resolution")).resolveManualRefundTask(
  { taskId, resolution: "dismissed", note: "Dispute lost", actingMemberId: names.officerId, recordedNightPrices: null }, CLUB_FORMAT_TEST);
const reduce = async (taskId: string, expectedAmountCents: number, expectedReducedByCents: number) =>
  (await import("@/lib/manual-refund-task-dispute-reduction")).reduceDisputedHandBack({ taskId, actingMemberId: names.officerId, expectedAmountCents, expectedReducedByCents });
const officerReopen = async (taskId: string) =>
  (await import("@/lib/manual-refund-task-reopen")).reopenManualRefundTask({ taskId, actingMemberId: names.officerId, note: "Dismissed by mistake" });

/** Stripe's `charge.dispute.closed` (or another dispute event) reporting it won, through the real webhook processor. */
async function deliverWon(disputeId: string, eventId = `evt_${PREFIX}${++eventSequence}`, type = "charge.dispute.closed") {
  const row = await db.stripeDispute.findUniqueOrThrow({ where: { stripeDisputeId: disputeId } });
  const { processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service");
  const object = { id: disputeId, object: "dispute", amount: row.amountCents, currency: "nzd", reason: "fraudulent", status: "won",
    charge: row.stripeChargeId, payment_intent: row.stripePaymentIntentId, created: Math.floor(OPENED.getTime() / 1000), balance_transactions: [] };
  const event = { id: eventId, object: "event", type, livemode: false, created: Math.floor(OPENED.getTime() / 1000) + 86_400 + eventSequence,
    request: null, data: { object } } as unknown as Stripe.Event;
  const result = await processStripeWebhookEvent(event);
  return result.init?.status ?? 200;
}

const task = async (taskId: string) => db.manualRefundTask.findUniqueOrThrow({ where: { id: taskId }, select: { status: true, amountCents: true } });
/** What the journal says the club still owes the member as refunds on this booking (credit balance of refund payable). */
const refundPayable = async (bookingId: string) => (await db.memberMoneyLine.findMany({ where: { bookingId, account: "REFUND_PAYABLE" }, select: { side: true, amountCents: true } }))
  .reduce((sum, l) => sum + (l.side === "CREDIT" ? l.amountCents : -l.amountCents), 0);
const lateWinAlerts = (disputeId: string) => sent.alerts.filter((alert) => alert.stage === "won-after-loss" && alert.disputeId === disputeId);
const reopenAudits = (taskId: string) => db.auditLog.count({ where: { entityId: taskId, action: "booking-payment.manual-refund-task.reopen" } });
const liveHandBackDebts = (taskId: string) => db.memberMoneyEvent.count({ where: {
  eventKey: { startsWith: memberMoneyEventKeys.refundObligation("hand-back", taskId) }, journal: { reversedBy: null },
} });

(RUN ? describe : describe.skip)("a lost card dispute Stripe later reports won (#5197)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "late-won dispute hand-backs");
    process.env.DATABASE_URL = url;
    ({ prisma: db } = await import("@/lib/prisma"));
    await cleanup();
    await seedHistoryFixtures(db, PREFIX);
  }, 60_000);
  afterAll(async () => {
    if (db) await cleanup();
  }, 60_000);
  beforeEach(() => {
    sent.alerts.length = 0;
    sent.undelivered = 0;
  });

  async function cleanup() {
    await db.alertCooldown.deleteMany({ where: { key: { contains: `dp_${PREFIX}` } } });
    await db.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: `evt_${PREFIX}` } } });
    await db.stripeDispute.deleteMany({ where: { stripeDisputeId: { startsWith: `dp_${PREFIX}` } } });
    await cleanHistories(db, PREFIX);
  }

  it("a hand-back dismissed while lost, then a late win: reopened, its debt owed again exactly, one alert naming it", async () => {
    const id = await cardBooking();
    const disputeId = await dispute(id, 10_000);
    const cancel = await raise(id, "cancel", 10_000, 1);
    await dismiss(cancel);
    expect(await refundPayable(id)).toBe(0);

    expect(await deliverWon(disputeId)).toBe(200);

    expect(await task(cancel)).toEqual({ status: "OPEN", amountCents: 10_000 });
    expect(await refundPayable(id)).toBe(10_000);
    expect(await liveHandBackDebts(cancel)).toBe(1);
    expect(await reopenAudits(cancel)).toBe(1);
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: cancel, action: "booking-payment.manual-refund-task.reopen" } });
    expect(audit.actorMemberId).toBeNull();
    expect(audit.metadata).toMatchObject({ lateWinDisputeId: disputeId, dismissedByMemberId: names.officerId });
    const [alert, ...more] = lateWinAlerts(disputeId);
    expect(more).toEqual([]);
    expect(alert!.disputeNextStep).toContain(`reopened the refund tasks dismissed while the dispute read lost, and the club owes the member again: task ${cancel} ($100.00)`);
  });

  it("a hand-back reduced after a part-lost dispute, then a late win: the alert names the cents, nothing is written", async () => {
    const id = await cardBooking();
    const disputeId = await dispute(id, 3_000);
    const cancel = await raise(id, "cancel", 10_000, 1);
    await reduce(cancel, 10_000, 3_000);
    const events = await db.memberMoneyEvent.count();

    expect(await deliverWon(disputeId)).toBe(200);

    expect(await task(cancel)).toEqual({ status: "OPEN", amountCents: 7_000 });
    expect(await refundPayable(id)).toBe(7_000);
    expect(await db.memberMoneyEvent.count()).toBe(events);
    expect(await reopenAudits(cancel)).toBe(0);
    expect(lateWinAlerts(disputeId)).toHaveLength(1);
    expect(lateWinAlerts(disputeId)[0]!.disputeNextStep).toContain(`the amount taken off is owed to the member again: task ${cancel} ($30.00)`);
  });

  it("reduced, then dismissed: a late win of the later loss restores the rest; an officer's reopen does too, and a re-dismissal withdraws it again", async () => {
    const id = await cardBooking();
    const partly = await dispute(id, 3_000, "LOST", "a");
    const cancel = await raise(id, "cancel", 10_000, 1);
    await reduce(cancel, 10_000, 3_000);
    const rest = await dispute(id, 7_000, "LOST", "b");
    await dismiss(cancel);
    expect(await refundPayable(id)).toBe(0);

    // The officer's own reopen of a dispute-loss hand-back restores its debt too, and the chain lets it go again.
    await officerReopen(cancel);
    expect(await refundPayable(id)).toBe(7_000);
    await dismiss(cancel);
    expect(await refundPayable(id)).toBe(0);
    expect(await db.memberMoneyEvent.count({ where: { eventKey: { startsWith: memberMoneyEventKeys.handBackRestWithdrawn(cancel) } } })).toBe(2);

    expect(await deliverWon(rest)).toBe(200);

    expect(await task(cancel)).toEqual({ status: "OPEN", amountCents: 7_000 });
    expect(await refundPayable(id)).toBe(7_000);
    // The $30 lost dispute still reads lost, so the reduction it made stands and is not named.
    expect(lateWinAlerts(rest)[0]!.disputeNextStep).not.toContain("owed to the member again: task");
    expect(partly).toBeDefined();
  });

  it("$100 edit and $300 cancel hand-backs, both dismissed after the cancel for a $400 loss: a late win reopens both and owes $400 again", async () => {
    const id = await cardBooking();
    const edit = await raise(id, "edit", 10_000, 1);
    await cancelled(id, new Date("2026-06-25T00:00:00.000Z"));
    const cancel = await raise(id, "cancel", 30_000, 6);
    const disputeId = await dispute(id, 40_000);
    await dismiss(edit);
    await dismiss(cancel);
    expect(await refundPayable(id)).toBe(0);

    expect(await deliverWon(disputeId)).toBe(200);

    expect(await task(edit)).toEqual({ status: "OPEN", amountCents: 10_000 });
    expect(await task(cancel)).toEqual({ status: "OPEN", amountCents: 30_000 });
    expect(await refundPayable(id)).toBe(40_000);
    expect(lateWinAlerts(disputeId)[0]!.disputeNextStep).toContain(`task ${cancel} ($300.00); task ${edit} ($100.00)`);
  });

  it("an edit hand-back dismissed before the cancel is not reopened: the alert says the cancellation counted it", async () => {
    const id = await cardBooking();
    const disputeId = await dispute(id, 10_000);
    const edit = await raise(id, "edit", 10_000, 1);
    await dismiss(edit);
    await cancelled(id, new Date("2026-08-01T00:00:00.000Z"));

    expect(await deliverWon(disputeId)).toBe(200);

    expect(await task(edit)).toEqual({ status: "DISMISSED", amountCents: 10_000 });
    expect(await refundPayable(id)).toBe(0);
    expect(lateWinAlerts(disputeId)[0]!.disputeNextStep).toContain(`its cancellation counted that money in its own refund: task ${edit} ($100.00).`);
    expect(lateWinAlerts(disputeId)[0]!.disputeNextStep).not.toContain("could not reopen");
    // The officer meets the same refusal, in its own words.
    await expect(officerReopen(edit)).rejects.toMatchObject({ status: 409, message: EDIT_REFUND_HAND_BACK_REOPEN_AFTER_CANCEL_MESSAGE });
  });

  it("an edit hand-back dismissed after the cancel before its status was recorded is listed to check by hand, never as counted", async () => {
    const id = await cardBooking();
    const edit = await raise(id, "edit", 10_000, 1);
    await cancelled(id, new Date("2026-06-25T00:00:00.000Z"));
    const disputeId = await dispute(id, 10_000);
    await dismiss(edit);
    // As a dismissal recorded before #5197 reads: its audit row has no booking status.
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: edit, action: "booking-payment.manual-refund-task.dismiss" } });
    const { bookingStatusAtClosure, ...older } = audit.metadata as Record<string, unknown>;
    expect(bookingStatusAtClosure).toBe("CANCELLED");
    await db.auditLog.update({ where: { id: audit.id }, data: { metadata: older as object } });

    expect(await deliverWon(disputeId)).toBe(200);

    expect(await task(edit)).toEqual({ status: "DISMISSED", amountCents: 10_000 });
    expect(await refundPayable(id)).toBe(0);
    const step = lateWinAlerts(disputeId)[0]!.disputeNextStep;
    expect(step).toContain(`could not reopen them: task ${edit} ($100.00): ${REOPEN_DISMISSAL_STATUS_UNRECORDED_MESSAGE}`);
    expect(step).not.toContain("counted that money in its own refund");
    await expect(officerReopen(edit)).rejects.toMatchObject({ status: 409, message: REOPEN_DISMISSAL_STATUS_UNRECORDED_MESSAGE });
  });

  it("a part win: one of two lost disputes won reopens the task whole, says how much is owed again, and Reduce takes the rest", async () => {
    const id = await cardBooking();
    await dispute(id, 30_000, "LOST", "a");
    const won = await dispute(id, 10_000, "LOST", "b");
    const cancel = await raise(id, "cancel", 40_000, 1);
    await dismiss(cancel);

    // The first alert reaches nobody: the redelivery plans the same reopen from its marker, with the same cents.
    sent.undelivered = 1;
    expect(await deliverWon(won)).toBe(500);
    expect(await deliverWon(won)).toBe(200);

    expect(await task(cancel)).toEqual({ status: "OPEN", amountCents: 40_000 });
    expect(await reopenAudits(cancel)).toBe(1);
    expect(await refundPayable(id)).toBe(40_000);
    expect(lateWinAlerts(won)[0]!.disputeNextStep).toContain(`task ${cancel} ($400.00, of which $100.00 is owed again`);
    expect(await reduce(cancel, 40_000, 30_000)).toMatchObject({ stillOwedCents: 10_000 });
    expect(await refundPayable(id)).toBe(10_000);
  });

  it("redelivered, the same event and another: one reopen, one debt, one audit row and one alert", async () => {
    const id = await cardBooking();
    const disputeId = await dispute(id, 10_000);
    const cancel = await raise(id, "cancel", 10_000, 1);
    await dismiss(cancel);

    const eventId = `evt_${PREFIX}${++eventSequence}`;
    expect(await deliverWon(disputeId, eventId)).toBe(200);
    expect(await deliverWon(disputeId, eventId)).toBe(200);
    expect(await deliverWon(disputeId, undefined, "charge.dispute.funds_reinstated")).toBe(200);

    expect(await reopenAudits(cancel)).toBe(1);
    expect(await liveHandBackDebts(cancel)).toBe(1);
    expect(await refundPayable(id)).toBe(10_000);
    expect(lateWinAlerts(disputeId)).toHaveLength(1);
  });

  it("delivered twice at once: one reopen, one debt, one audit row and one alert, and the alert names it reopened", async () => {
    const id = await cardBooking();
    const disputeId = await dispute(id, 10_000);
    const cancel = await raise(id, "cancel", 10_000, 1);
    await dismiss(cancel);

    const statuses = await Promise.all([deliverWon(disputeId), deliverWon(disputeId)]);
    // A delivery whose alert the other claimed answers 500; Stripe redelivers it.
    for (const status of statuses) if (status !== 200) expect(await deliverWon(disputeId)).toBe(200);

    expect(statuses).toContain(200);
    expect(await reopenAudits(cancel)).toBe(1);
    expect(await liveHandBackDebts(cancel)).toBe(1);
    expect(await refundPayable(id)).toBe(10_000);
    expect(lateWinAlerts(disputeId)).toHaveLength(1);
    expect(lateWinAlerts(disputeId)[0]!.disputeNextStep).toContain(`club owes the member again: task ${cancel} ($100.00)`);
  });

  /** Hold `sql` in a transaction on its own connection until `release`; resolves once it holds. */
  async function hold(sql: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<unknown>) {
    const { PrismaClient: Client } = await import("@prisma/client");
    const { createPrismaPgAdapter } = await import("@/lib/prisma-adapter");
    const blocker = new Client({ adapter: createPrismaPgAdapter(process.env.CONCURRENCY_RACE_DATABASE_URL) });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const taken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = blocker.$transaction(async (tx) => { await sql(tx); locked(); await held; }, { timeout: 60_000, maxWait: 10_000 });
    await taken;
    return async () => {
      release();
      await holder.catch(() => undefined);
      await blocker.$disconnect();
    };
  }

  it("a booking row held past the reopen's bound: the alert says the task was not reopened, and a later officer reopen works", async () => {
    const id = await cardBooking();
    const disputeId = await dispute(id, 10_000);
    const cancel = await raise(id, "cancel", 10_000, 1);
    await dismiss(cancel);

    const release = await hold((tx) => tx.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" = ${id} FOR UPDATE`);
    try {
      expect(await deliverWon(disputeId)).toBe(200);
    } finally {
      await release();
    }

    expect(await task(cancel)).toEqual({ status: "DISMISSED", amountCents: 10_000 });
    expect(lateWinAlerts(disputeId)[0]!.disputeNextStep).toContain(`could not reopen them: task ${cancel} ($100.00): The booking was busy`);
    await officerReopen(cancel);
    expect(await refundPayable(id)).toBe(10_000);
  });

  it("lock(1) held past the WON event's bound: the webhook answers 500 and writes nothing; Stripe's redelivery then reopens", async () => {
    const id = await cardBooking();
    const disputeId = await dispute(id, 10_000);
    const cancel = await raise(id, "cancel", 10_000, 1);
    await dismiss(cancel);

    const release = await hold((tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`);
    try {
      expect(await deliverWon(disputeId)).toBe(500);
    } finally {
      await release();
    }
    expect((await db.stripeDispute.findUniqueOrThrow({ where: { stripeDisputeId: disputeId } })).status).toBe("LOST");
    expect(lateWinAlerts(disputeId)).toHaveLength(0);

    expect(await deliverWon(disputeId)).toBe(200);
    expect(await task(cancel)).toEqual({ status: "OPEN", amountCents: 10_000 });
  });

  describe("the officer's Dismiss or Reduce racing the webhook (barriers on lock(1))", () => {
    const waiting = async () => Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = 1`)[0]!.n);
    async function until(count: number) {
      for (let tries = 0; tries < 200 && (await waiting()) < count; tries += 1) await new Promise((r) => setTimeout(r, 25));
      expect(await waiting()).toBeGreaterThanOrEqual(count);
    }
    /** Queue `first` then `second` on a held lock(1), in that order, then release: PostgreSQL grants it first come, first served. */
    async function inOrder(first: () => Promise<unknown>, second: () => Promise<unknown>) {
      const release = await hold((tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`);
      try {
        const a = first();
        await until(1);
        const b = second();
        await until(2);
        await release();
        return await Promise.allSettled([a, b]);
      } finally {
        await release();
      }
    }

    it("Dismiss first: the dismissal commits, then the late win reopens the task and restores its debt", async () => {
      const id = await cardBooking();
      const disputeId = await dispute(id, 10_000);
      const cancel = await raise(id, "cancel", 10_000, 1);

      const [dismissed, webhook] = await inOrder(() => dismiss(cancel), () => deliverWon(disputeId));
      expect(dismissed.status).toBe("fulfilled");
      expect(webhook).toEqual({ status: "fulfilled", value: 200 });

      expect(await task(cancel)).toEqual({ status: "OPEN", amountCents: 10_000 });
      expect(await refundPayable(id)).toBe(10_000);
      expect(await reopenAudits(cancel)).toBe(1);
    });

    it("WON first: the officer reads it won and is refused; nothing changes", async () => {
      const id = await cardBooking();
      const disputeId = await dispute(id, 10_000);
      const cancel = await raise(id, "cancel", 10_000, 1);

      const [webhook, dismissed] = await inOrder(() => deliverWon(disputeId), () => dismiss(cancel));
      expect(webhook).toEqual({ status: "fulfilled", value: 200 });
      expect(dismissed).toMatchObject({ status: "rejected", reason: { status: 409, message: expect.stringMatching(/dispute was won/) } });

      expect(await task(cancel)).toEqual({ status: "OPEN", amountCents: 10_000 });
      expect(await refundPayable(id)).toBe(10_000);
      expect(await reopenAudits(cancel)).toBe(0);
    });

    it("Reduce first: the reduction commits, then the late win names its cents", async () => {
      const id = await cardBooking();
      const disputeId = await dispute(id, 3_000);
      const cancel = await raise(id, "cancel", 10_000, 1);

      const [reduced, webhook] = await inOrder(() => reduce(cancel, 10_000, 3_000), () => deliverWon(disputeId));
      expect(reduced.status).toBe("fulfilled");
      expect(webhook).toEqual({ status: "fulfilled", value: 200 });

      expect(await task(cancel)).toEqual({ status: "OPEN", amountCents: 7_000 });
      expect(lateWinAlerts(disputeId)[0]!.disputeNextStep).toContain(`owed to the member again: task ${cancel} ($30.00)`);
    });

    it("WON first: the reduction is refused; nothing changes", async () => {
      const id = await cardBooking();
      const disputeId = await dispute(id, 3_000);
      const cancel = await raise(id, "cancel", 10_000, 1);

      const [webhook, reduced] = await inOrder(() => deliverWon(disputeId), () => reduce(cancel, 10_000, 3_000));
      expect(webhook).toEqual({ status: "fulfilled", value: 200 });
      expect(reduced).toMatchObject({ status: "rejected", reason: { status: 409 } });

      expect(await task(cancel)).toEqual({ status: "OPEN", amountCents: 10_000 });
      expect(await refundPayable(id)).toBe(10_000);
      expect(lateWinAlerts(disputeId)[0]!.disputeNextStep).toContain("No refund task on this payment was dismissed or reduced");
    });
  });
});
