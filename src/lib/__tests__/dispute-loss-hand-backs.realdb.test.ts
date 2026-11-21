import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { postHandBackObligation } from "@/lib/member-money/doors";
import { memberMoneyEventKeys } from "@/lib/member-money";
import { editRefundHandBackOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND, DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND_REDUCTION, DISPUTED_HAND_BACK_LOST_NOT_PAYABLE } from "@/lib/manual-refund-task-copy";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures, settleHistoryByCard } from "./support/booking-ledger-history";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

/**
 * #4516 (owner decision, 18 Nov 2026, comment 6951152823): a hand-back raised by a dispute-held edit (#5151) follows
 * the cancellation's dispute rules, and lost card dispute cents are applied ONCE across all of a payment's hand-backs,
 * oldest open task first (`disputeLossAvailableToTask`). Proved on PostgreSQL through the real doors
 * (`resolveManualRefundTask`, `reduceDisputedHandBack`): which task each loss goes to, that the journal's refund
 * payable falls by exactly the cents applied and never by more than was lost, and that two officers acting on two
 * tasks of one payment at the same moment cannot both apply the same lost cents.
 *
 * DATABASE_URL must point at the race database before any import builds the Prisma client.
 */
vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-dl-";
const names = historyNames(PREFIX);
const context = memberMoneyTestContext();
let db: PrismaClient;
let sequence = 0;

/** A card booking settled for $400 (R01 and its receipt in the journal) with one dispute on its capture. */
async function disputedCardBooking(dispute: { status: "LOST" | "WON" | "OPEN"; cents: number }) {
  const id = `${PREFIX}${++sequence}`;
  const intent = `pi_${id}`;
  const night = { priceCents: 10_000, priceSource: "SOLD" as const };
  await createHistoryBooking(db, names, id, { payment: { amountCents: 40_000, source: "STRIPE", intent }, guests: [[night, night], [night, night]] });
  await settleHistoryByCard(id, 40_000);
  const capture = await db.paymentTransaction.findFirstOrThrow({ where: { paymentId: `${id}-payment`, stripePaymentIntentId: intent }, select: { id: true } });
  const opened = new Date("2026-06-20T00:00:00.000Z");
  await db.stripeDispute.create({ data: { stripeDisputeId: `dp_${id}`, stripeChargeId: `ch_${id}`, stripePaymentIntentId: intent, paymentTransactionId: capture.id,
    paymentId: `${id}-payment`, bookingId: id, amountCents: dispute.cents, currency: "nzd", reason: "fraudulent", status: dispute.status,
    stripeStatus: dispute.status.toLowerCase(), stripeCreatedAt: opened, lastEventCreatedAt: opened, stripeEventId: `evt_${id}` } });
  return id;
}

/**
 * One treasurer task on the booking's payment and its R05, raised together under `lock(1)` as the doors raise them:
 * an edit's (#5151's dispute-held reduction) or a cancellation's own (#5061). `day` orders them.
 */
async function raise(id: string, kind: "edit" | "cancel", cents: number, day: number) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const task = await tx.manualRefundTask.create({ data: {
      bookingId: id, paymentId: `${id}-payment`, amountCents: cents, raisedAmountCents: cents, kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: kind === "edit" ? editRefundHandBackOccurrenceKey(`${id}-mod-${day}`) : null,
      reason: `Booking ${id} ${kind === "edit" ? "lowered by a date change" : "cancelled"} while its card payment is disputed by the cardholder (Stripe dispute dp_${id}).`,
      createdAt: new Date(`2026-06-${String(20 + day).padStart(2, "0")}T00:00:00.000Z`),
    } });
    await postHandBackObligation(tx, context, { bookingId: id, taskId: task.id, amountCents: cents, origin: "APP", debtorRead: "booking-row" });
    return task.id;
  });
}

const dismiss = async (taskId: string) => (await import("@/lib/manual-refund-task-resolution")).resolveManualRefundTask(
  { taskId, resolution: "dismissed", note: "Dispute lost", actingMemberId: names.officerId, recordedNightPrices: null }, CLUB_FORMAT_TEST);
const reduce = async (taskId: string, expectedAmountCents: number, expectedReducedByCents: number) =>
  (await import("@/lib/manual-refund-task-dispute-reduction")).reduceDisputedHandBack({ taskId, actingMemberId: names.officerId, expectedAmountCents, expectedReducedByCents });
const decide = async (taskId: string, resolution: "completed" | "dismissed") => db.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  const task = await tx.manualRefundTask.findUniqueOrThrow({ where: { id: taskId } });
  return (await import("@/lib/manual-refund-task-hand-back-journal")).decideJournalHandBackDismissal(tx, task, resolution);
});
const status = async (taskId: string) => db.manualRefundTask.findUniqueOrThrow({ where: { id: taskId }, select: { status: true, amountCents: true } });
/** What the journal says the club still owes the member as refunds on this booking (credit balance of refund payable). */
const refundPayable = async (bookingId: string) => (await db.memberMoneyLine.findMany({ where: { bookingId, account: "REFUND_PAYABLE" }, select: { side: true, amountCents: true } }))
  .reduce((sum, l) => sum + (l.side === "CREDIT" ? l.amountCents : -l.amountCents), 0);

(RUN ? describe : describe.skip)("dispute-held edit hand-backs and lost cents applied once across a payment (#4516, owner decision 18 Nov 2026)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "dispute-loss hand-backs");
    process.env.DATABASE_URL = url;
    ({ prisma: db } = await import("@/lib/prisma"));
    await cleanHistories(db, PREFIX);
    await seedHistoryFixtures(db, PREFIX);
  }, 60_000);
  afterAll(async () => {
    if (!db) return;
    await db.stripeDispute.deleteMany({ where: { stripeDisputeId: { startsWith: `dp_${PREFIX}` } } });
    await cleanHistories(db, PREFIX);
  }, 60_000);

  it("an edit's hand-back alone: lost in full it dismisses and its R05 is withdrawn; Mark paid is refused", async () => {
    const id = await disputedCardBooking({ status: "LOST", cents: 10_000 });
    const edit = await raise(id, "edit", 10_000, 1);
    expect(await refundPayable(id)).toBe(10_000);
    expect((await decide(edit, "completed")).refusal).toBe(DISPUTED_HAND_BACK_LOST_NOT_PAYABLE);

    await dismiss(edit);

    expect(await status(edit)).toMatchObject({ status: "DISMISSED" });
    expect(await refundPayable(id)).toBe(0);
  });

  it("$100 lost; a $100 edit hand-back, then a $200 cancel hand-back: the edit dismisses, the cancel is neither dismissed nor reduced, $100 written off in all", async () => {
    const id = await disputedCardBooking({ status: "LOST", cents: 10_000 });
    const edit = await raise(id, "edit", 10_000, 1);
    const cancel = await raise(id, "cancel", 20_000, 2);
    expect(await refundPayable(id)).toBe(30_000);

    // MUTATION (once-only allocation): counting the loss against each task alone lets the cancel be reduced by $100 too.
    await expect(reduce(cancel, 20_000, 10_000)).rejects.toMatchObject({ status: 409, message: DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND_REDUCTION });
    await expect(dismiss(cancel)).rejects.toMatchObject({ status: 409, message: DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND });
    expect((await decide(cancel, "completed")).refusal).toBeNull(); // the cancel stays payable in full
    await dismiss(edit);
    await expect(reduce(cancel, 20_000, 10_000)).rejects.toMatchObject({ status: 409 });

    expect(await status(edit)).toMatchObject({ status: "DISMISSED" });
    expect(await status(cancel)).toMatchObject({ status: "OPEN", amountCents: 20_000 });
    expect(await refundPayable(id)).toBe(20_000);
  });

  it("the other order: a $200 cancel hand-back, then a $100 edit hand-back: the cancel is reduced by $100, the edit stays owed in full", async () => {
    const id = await disputedCardBooking({ status: "LOST", cents: 10_000 });
    const cancel = await raise(id, "cancel", 20_000, 1);
    const edit = await raise(id, "edit", 10_000, 2);

    await expect(dismiss(edit)).rejects.toMatchObject({ status: 409, message: DISPUTED_HAND_BACK_LOSS_ON_ANOTHER_REFUND });
    expect(await reduce(cancel, 20_000, 10_000)).toMatchObject({ reducedByCents: 10_000, stillOwedCents: 10_000 });
    await expect(dismiss(edit)).rejects.toMatchObject({ status: 409 });
    expect((await decide(edit, "completed")).refusal).toBeNull();

    expect(await status(cancel)).toMatchObject({ status: "OPEN", amountCents: 10_000 });
    expect(await status(edit)).toMatchObject({ status: "OPEN", amountCents: 10_000 });
    expect(await refundPayable(id)).toBe(20_000);
  });

  it("$90 lost across a $60 edit hand-back and a $100 cancel hand-back: the edit dismisses, the cancel is reduced by $30, $90 in all", async () => {
    const id = await disputedCardBooking({ status: "LOST", cents: 9_000 });
    const edit = await raise(id, "edit", 6_000, 1);
    const cancel = await raise(id, "cancel", 10_000, 2);

    await dismiss(edit);
    expect(await reduce(cancel, 10_000, 3_000)).toMatchObject({ reducedByCents: 3_000, stillOwedCents: 7_000 });
    await expect(reduce(cancel, 7_000, 3_000)).rejects.toMatchObject({ status: 409 });

    expect(await refundPayable(id)).toBe(7_000);
    expect(await db.memberMoneyEvent.count({ where: { eventKey: { startsWith: `hand-back-reduced:${cancel}|` } } })).toBe(1);
  });

  it("a won dispute leaves an edit's hand-back payable and not dismissible", async () => {
    const id = await disputedCardBooking({ status: "WON", cents: 10_000 });
    const edit = await raise(id, "edit", 10_000, 1);
    await expect(dismiss(edit)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/dispute was won, so the club still owes it/) });
    expect((await decide(edit, "completed")).refusal).toBeNull();
    expect(await refundPayable(id)).toBe(10_000);
  });

  /**
   * Two officers at the same moment: hold `lock(1)`, start both doors, wait (bounded) until both are queued on it,
   * then let them race. Returns each door's outcome, in the order given.
   */
  async function race(first: () => Promise<unknown>, second: () => Promise<unknown>) {
    const { PrismaClient: Client } = await import("@prisma/client");
    const { createPrismaPgAdapter } = await import("@/lib/prisma-adapter");
    const blocker = new Client({ adapter: createPrismaPgAdapter(process.env.CONCURRENCY_RACE_DATABASE_URL) });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = blocker.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      locked();
      await held;
    }, { timeout: 60_000, maxWait: 10_000 });
    try {
      await lockTaken;
      const outcomes = Promise.allSettled([first(), second()]);
      const waiting = async () => Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = 1`)[0]!.n);
      for (let tries = 0; tries < 200 && (await waiting()) < 2; tries += 1) await new Promise((r) => setTimeout(r, 50));
      release();
      await holder;
      return await outcomes;
    } finally {
      release();
      await holder.catch(() => undefined);
      await blocker.$disconnect();
    }
  }
  const audits = (taskId: string, action: string) => db.auditLog.count({ where: { entityId: taskId, action } });
  const events = (prefix: string) => db.memberMoneyEvent.count({ where: { eventKey: { startsWith: prefix } } });

  // What this pins: the allocation is order-independent (dismissing or reducing an older task by x raises what is
  // applied by x and lowers what older tasks owe by x, so no other task's share moves), so the younger task's
  // Reduce is refused whichever door runs first. The money race is two officers on the SAME task (below).
  it("two officers at the same moment on two tasks: the $100 edit hand-back dismissed, the $200 cancel's Reduce refused in either order", async () => {
    const id = await disputedCardBooking({ status: "LOST", cents: 10_000 });
    const edit = await raise(id, "edit", 10_000, 1);
    const cancel = await raise(id, "cancel", 20_000, 2);

    const [dismissed, reduced] = await race(() => dismiss(edit), () => reduce(cancel, 20_000, 10_000));
    expect(dismissed.status).toBe("fulfilled");
    expect(reduced.status).toBe("rejected");

    expect(await status(edit)).toMatchObject({ status: "DISMISSED" });
    expect(await status(cancel)).toMatchObject({ status: "OPEN", amountCents: 20_000 });
    expect(await refundPayable(id)).toBe(20_000);
    expect(await db.memberMoneyObligation.count({ where: { obligationKey: memberMoneyEventKeys.refundObligation("hand-back", cancel) } })).toBe(1);
  });

  it("two officers reducing the SAME task by the same lost $30 at the same moment: one reduction, one withdrawal, the loser writes nothing", async () => {
    const id = await disputedCardBooking({ status: "LOST", cents: 3_000 });
    const cancel = await raise(id, "cancel", 10_000, 1);

    const before = await db.memberMoneyEvent.count();
    const outcomes = await race(() => reduce(cancel, 10_000, 3_000), () => reduce(cancel, 10_000, 3_000));
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);

    expect(await status(cancel)).toMatchObject({ status: "OPEN", amountCents: 7_000 });
    expect(await events(`hand-back-reduced:${cancel}|`)).toBe(1);
    expect(await db.memberMoneyEvent.count()).toBe(before + 1);
    expect(await audits(cancel, "booking-payment.manual-refund-task.reduce-by-lost-dispute")).toBe(1);
    expect(await refundPayable(id)).toBe(7_000);
  });

  it("two officers dismissing the SAME fully lost edit hand-back at the same moment: one dismissal, one withdrawal, the loser writes nothing", async () => {
    const id = await disputedCardBooking({ status: "LOST", cents: 10_000 });
    const edit = await raise(id, "edit", 10_000, 1);

    const before = await db.memberMoneyEvent.count();
    const outcomes = await race(() => dismiss(edit), () => dismiss(edit));
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);

    expect(await status(edit)).toMatchObject({ status: "DISMISSED" });
    // The raise's R05 and exactly one withdrawal of it (a whole debt is reversed), nothing from the loser.
    expect(await db.memberMoneyEvent.count()).toBe(before + 1);
    expect(await db.memberMoneyJournal.count({ where: { reverses: { event: { eventKey: memberMoneyEventKeys.refundObligation("hand-back", edit) } } } })).toBe(1);
    expect(await audits(edit, "booking-payment.manual-refund-task.dismiss")).toBe(1);
    expect(await refundPayable(id)).toBe(0);
  });
});
