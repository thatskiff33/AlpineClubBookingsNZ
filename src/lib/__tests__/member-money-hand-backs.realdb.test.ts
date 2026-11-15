import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { postBookingReceipts, postHandBackObligation, withdrawRefundObligation } from "@/lib/member-money/doors";
import { memberMoneyEventKeys, postMemberMoneyEvent } from "@/lib/member-money";
import { readMemberMoneyApplicationState } from "@/lib/member-money/internal/application-read";
import { memberMoneyApplicationTotals, memberMoneyConservationProblems } from "@/lib/member-money/internal/application-state";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
import { JOURNAL_HAND_BACK_DISMISS_REFUSAL } from "@/lib/manual-refund-task-copy";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures, settleHistoryByCard } from "./support/booking-ledger-history";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { raceSession } from "./support/race-session-double";

/**
 * #4516 (Ledger M4d, owner decision 14 Nov 2026, Q6): a real bank or cash hand-back the journal holds as a debt cannot
 * be dismissed until the four-way dismissal ships. Proved on PostgreSQL through the real `resolveManualRefundTask`: the
 * refused dismissal leaves the task OPEN and its R05 open, writes no journal batch and no audit row, and a later
 * "Mark paid" posts R14 applied to that same R05. A card shortfall's part to check keeps its dismissal (owner decision,
 * 15 Nov 2026), which withdraws its R05 exactly, so raising and dismissing it leaves the journal as it was.
 *
 * And (#4516 review A, B) each raise through its real door posts one R05 for the task's cents, which Mark paid then
 * pays: the cash cancellation (`cancelBooking`), a card shortfall's bank part and part to check
 * (`raiseCancelCardShortfallHandBack`), and an approved appeal's bank part (`PUT /api/admin/refund-requests/[id]`),
 * which posts its concession against goodwill so the member owes nothing once it is paid.
 *
 * DATABASE_URL must point at the race database before any import builds the Prisma client (#4516 review).
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
const PREFIX = "race-m4d-";
const names = historyNames(PREFIX);
const context = memberMoneyTestContext();
let db: PrismaClient;
let resolution: typeof import("@/lib/manual-refund-task-resolution");
let sequence = 0;

/** A booking paid $100.00 by internet banking, its R01 and receipt in the journal, cancelled keeping $20.00. */
async function cancelledBankBooking() {
  const id = `${PREFIX}${++sequence}`;
  const where = { bookingId: id, lodgeId: names.lodgeId };
  await createHistoryBooking(db, names, id, { payment: { amountCents: 10_000, source: "INTERNET_BANKING" } });
  await db.$transaction((tx) => postMemberMoneyEvent(tx, context, {
    kind: "CHARGE", eventKey: memberMoneyEventKeys.bookingCharge(id), origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic R01",
    obligations: [{ key: memberMoneyEventKeys.bookingCharge(id), kind: "CHARGE", debtor: { kind: "MEMBER", memberId: names.memberId }, faceCents: 10_000, evidence: {} }],
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: 10_000, booking: where, debtor: { kind: "MEMBER", memberId: names.memberId }, obligationKey: memberMoneyEventKeys.bookingCharge(id), evidence: {} },
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: 10_000, booking: where, chargeIdentity: `booking:${id}:test`, evidence: {} },
    ] }));
  const row = await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source: "INTERNET_BANKING", kind: "PRIMARY", status: "SUCCEEDED", amountCents: 10_000 } });
  await db.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: `${id}-payment` }, data: { status: "SUCCEEDED", manuallyMarkedPaidAt: new Date(context.effectiveAt), manuallyMarkedPaidByMemberId: names.officerId } });
    await syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx });
    await postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision: { transactionIds: [row.id], collect: true } });
  });
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await tx.booking.update({ where: { id }, data: { status: "CANCELLED" } });
    await postMemberMoneyEvent(tx, context, { kind: "ADJUSTMENT", eventKey: memberMoneyEventKeys.cancellation(id, 0), origin: "APP",
      source: { kind: "BOOKING", id, version: "cancel" }, reason: "Synthetic R04",
      legs: [
        { type: "revenue", account: "BOOKING_REVENUE", side: "DEBIT", grossCents: 10_000, booking: where, chargeIdentity: `booking:${id}:test`, evidence: {} },
        { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: 2_000, booking: where, chargeIdentity: `booking:${id}:test`, evidence: {} },
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 8_000, booking: where, debtor: { kind: "MEMBER", memberId: names.memberId }, evidence: {} },
      ] });
  });
  return id;
}

/** The cash cancellation's hand-back task and its R05, raised together under `lock(1)` as the paid cancel raises them. */
async function raiseHandBack(id: string) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const task = await tx.manualRefundTask.create({ data: {
      bookingId: id, paymentId: `${id}-payment`, amountCents: 8_000, raisedAmountCents: 8_000, kind: "CANCELLED_BOOKING_HAND_BACK",
      reason: `Booking ${id} cancelled — cash/manual settlement, refund by hand (80% under the policy in effect at the time).`,
    } });
    await postHandBackObligation(tx, context, { bookingId: id, taskId: task.id, amountCents: 8_000, origin: "APP", debtorRead: "booking-row" });
    return task.id;
  });
}

const resolve = (taskId: string, outcome: "completed" | "dismissed") => outcome === "dismissed"
  ? resolution.resolveManualRefundTask({ taskId, resolution: "dismissed", note: "Member said keep it", actingMemberId: names.officerId, recordedNightPrices: null }, CLUB_FORMAT_TEST)
  : resolution.resolveManualRefundTask({ taskId, resolution: "completed", note: null, actingMemberId: names.officerId, confirmedAmountCents: null,
    direction: "REFUND_TO_MEMBER", handedBackInCash: false, recordedNightPrices: null }, CLUB_FORMAT_TEST);
const state = (id: string) => db.$transaction((tx) => readMemberMoneyApplicationState(tx, id));
const family = async (id: string, key: string) => memberMoneyApplicationTotals(await state(id)).families.get(key) ?? { funded: 0, paid: 0, reserved: 0 };
const ADMIN = `${PREFIX}admin`;
/** Signed balance (debit positive) of one account on the booking's journal lines. */
const balance = async (bookingId: string, account: string) => (await db.memberMoneyLine.findMany({ where: { bookingId, account: account as never }, select: { side: true, amountCents: true } }))
  .reduce((sum, l) => sum + (l.side === "DEBIT" ? 1 : -1) * l.amountCents, 0);
/** Every R05 batch posted for one hand-back task: its face, and whether it is still live. */
const handBackDebts = async (taskId: string) => db.memberMoneyObligation.findMany({ where: { obligationKey: { startsWith: memberMoneyEventKeys.refundObligation("hand-back", taskId) } }, select: { obligationKey: true, faceCents: true } });
const markPaid = (taskId: string) => resolution.resolveManualRefundTask({ taskId, resolution: "completed", note: null, actingMemberId: names.officerId, confirmedAmountCents: null,
  direction: "REFUND_TO_MEMBER", handedBackInCash: false, recordedNightPrices: null }, CLUB_FORMAT_TEST);
const r14Lines = async (taskId: string) => (await eventOf(memberMoneyEventKeys.handBackPaid(taskId)))?.journal?.lines.map((l) => `${l.side} ${l.account} ${l.amountCents}`).sort();
const r14Applied = async (taskId: string) => (await eventOf(memberMoneyEventKeys.handBackPaid(taskId)))?.journal?.applications.reduce((sum, a) => sum + a.amountCents, 0);

/** A booking whose R01 is in the journal and whose charges are collected: one row per [source, cents]. */
async function chargedBooking(charges: ReadonlyArray<["STRIPE" | "INTERNET_BANKING", number]>, cancelled = true) {
  const id = `${PREFIX}${++sequence}`;
  const total = charges.reduce((sum, [, cents]) => sum + cents, 0);
  const where = { bookingId: id, lodgeId: names.lodgeId };
  await createHistoryBooking(db, names, id, { payment: { amountCents: total, source: charges[0]![0] } });
  await db.$transaction((tx) => postMemberMoneyEvent(tx, context, {
    kind: "CHARGE", eventKey: memberMoneyEventKeys.bookingCharge(id), origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic R01",
    obligations: [{ key: memberMoneyEventKeys.bookingCharge(id), kind: "CHARGE", debtor: { kind: "MEMBER", memberId: names.memberId }, faceCents: total, evidence: {} }],
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: total, booking: where, debtor: { kind: "MEMBER", memberId: names.memberId }, obligationKey: memberMoneyEventKeys.bookingCharge(id), evidence: {} },
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: total, booking: where, chargeIdentity: `booking:${id}:test`, evidence: {} },
    ] }));
  const rows: { id: string }[] = [];
  for (const [source, cents] of charges) {
    rows.push(await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source, kind: "PRIMARY", status: "SUCCEEDED", amountCents: cents,
      stripePaymentIntentId: source === "STRIPE" ? `pi_${id}_${rows.length}` : null } }));
  }
  await db.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: `${id}-payment` }, data: { status: "SUCCEEDED", ...(charges[0]![0] === "STRIPE" ? { stripePaymentIntentId: `pi_${id}_0` } : {}) } });
    await syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx });
    await postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision: { transactionIds: rows.map((r) => r.id), collect: true } });
    if (cancelled) await tx.booking.update({ where: { id }, data: { status: "CANCELLED" } });
  });
  return id;
}

const eventOf = (eventKey: string) => db.memberMoneyEvent.findUnique({ where: { eventKey }, include: { journal: { include: { reversedBy: true, applications: true, lines: true } } } });

async function cleanup() {
  await db.stripeDispute.deleteMany({ where: { stripeDisputeId: { startsWith: `dp_${PREFIX}` } } });
  await cleanHistories(db, PREFIX);
  await db.auditLog.deleteMany({ where: { OR: [{ actorMemberId: ADMIN }, { memberId: ADMIN }] } });
  await db.memberAccessRole.deleteMany({ where: { memberId: ADMIN } });
  await db.member.deleteMany({ where: { id: ADMIN } });
}

(RUN ? describe : describe.skip)("M4d bank and cash hand-backs on PostgreSQL: dismissal refused for now (#4516)", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "M4d hand-backs");
    process.env.DATABASE_URL = url;
    ({ prisma: db } = await import("@/lib/prisma"));
    resolution = await import("@/lib/manual-refund-task-resolution");
    await cleanup();
    await seedHistoryFixtures(db, PREFIX);
    await db.member.create({ data: { id: ADMIN, email: `${ADMIN}@example.invalid`, passwordHash: "not-a-real-password", firstName: "M4d", lastName: "Admin", ageTier: "ADULT",
      role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } } } });
  }, 60_000);
  afterAll(async () => {
    if (!db) return;
    await cleanup();
  }, 60_000);

  it("a refused dismissal leaves the task OPEN and its R05 open, writing nothing; Mark paid then posts R14 applied to that R05", async () => {
    const id = await cancelledBankBooking();
    const taskId = await raiseHandBack(id);
    const r05 = memberMoneyEventKeys.refundObligation("hand-back", taskId);
    expect((await eventOf(r05))?.journal?.reversedBy).toBeNull(); // the debt, live
    expect(await family(id, r05)).toMatchObject({ paid: 0 });
    const batchesBefore = await db.memberMoneyEvent.count({ where: { sourceIdentity: { in: [id, taskId] } } });

    // MUTATION: deleting the refusal in `resolveManualRefundTask` fails here: the claim writes DISMISSED.
    await expect(resolve(taskId, "dismissed")).rejects.toMatchObject({ status: 409, message: JOURNAL_HAND_BACK_DISMISS_REFUSAL });

    expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: "OPEN", note: null, completedAt: null, completedByMemberId: null });
    expect((await eventOf(r05))?.journal?.reversedBy).toBeNull();
    expect(await family(id, r05)).toMatchObject({ paid: 0 });
    expect(await db.memberMoneyEvent.count({ where: { sourceIdentity: { in: [id, taskId] } } })).toBe(batchesBefore);
    expect(await db.auditLog.count({ where: { targetId: id, action: { startsWith: "booking-payment.manual-refund-task." } } })).toBe(0);

    await resolve(taskId, "completed");

    expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: "COMPLETED" });
    const r14 = await eventOf(memberMoneyEventKeys.handBackPaid(taskId));
    expect(r14?.journal?.lines.map((l) => `${l.side} ${l.account} ${l.amountCents}`).sort()).toEqual(["CREDIT BANK 8000", "DEBIT REFUND_PAYABLE 8000"]);
    expect(r14?.journal?.applications.reduce((sum, a) => sum + a.amountCents, 0)).toBe(8_000);
    expect(await family(id, r05)).toMatchObject({ paid: 8_000 });
    expect((await eventOf(r05))?.journal?.reversedBy).toBeNull();
    expect(memberMoneyConservationProblems(await state(id))).toEqual([]);
  });
  it("MUTATION (review B): a cash cancellation through the real cancelBooking posts one R05 for its task's cents; Mark paid applies R14 to it", async () => {
    const id = `${PREFIX}${++sequence}`;
    await createHistoryBooking(db, names, id, { payment: { amountCents: 20_000, source: "INTERNET_BANKING" } });
    const { markBookingPaymentManuallySettled } = await import("@/lib/payment-reconciliation");
    await markBookingPaymentManuallySettled({ bookingId: id, actingAdminMemberId: names.officerId, note: "cash at the lodge", expectedAmountCents: 20_000, notifyMember: false, format: CLUB_FORMAT_TEST });
    expect(await eventOf(memberMoneyEventKeys.bookingCharge(id))).not.toBeNull(); // the settle posted R01: the booking is in the population
    const { cancelBooking } = await import("@/lib/booking-cancel");
    expect((await cancelBooking(id, names.officerId, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);
    const task = await db.manualRefundTask.findFirstOrThrow({ where: { bookingId: id }, select: { id: true, amountCents: true } });
    expect(task.amountCents).toBe(10_000);
    expect(await handBackDebts(task.id)).toEqual([{ obligationKey: memberMoneyEventKeys.refundObligation("hand-back", task.id), faceCents: 10_000 }]);

    await markPaid(task.id);
    expect(await r14Lines(task.id)).toEqual(["CREDIT BANK 10000", "DEBIT REFUND_PAYABLE 10000"]);
    expect(await r14Applied(task.id)).toBe(10_000);
    expect(memberMoneyConservationProblems(await state(id))).toEqual([]);
  });

  it("MUTATION (review B): a card shortfall's bank part and part to check each post one R05 for their cents at the raise; Mark paid applies R14 to each", async () => {
    const id = await chargedBooking([["STRIPE", 14_000], ["INTERNET_BANKING", 6_000]]);
    const { raiseCancelCardShortfallHandBack } = await import("@/lib/cancel-card-refund-shortfall");
    const shortfall = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      return raiseCancelCardShortfallHandBack(tx, { bookingId: id, paymentId: `${id}-payment`, refundAmountCents: 20_000, plannedCardRefundCents: 0, format: CLUB_FORMAT_TEST, journal: context, actorMemberId: names.officerId });
    });
    const bank = shortfall!.bank!;
    const check = shortfall!.check!;
    expect([bank.cents, check.cents]).toEqual([6_000, 14_000]);
    expect(await handBackDebts(bank.taskId)).toEqual([{ obligationKey: memberMoneyEventKeys.refundObligation("hand-back", bank.taskId), faceCents: 6_000 }]);
    expect(await handBackDebts(check.taskId)).toEqual([{ obligationKey: memberMoneyEventKeys.refundObligation("hand-back", check.taskId), faceCents: 14_000 }]);

    await markPaid(bank.taskId);
    await markPaid(check.taskId);
    expect(await r14Applied(bank.taskId)).toBe(6_000);
    expect(await r14Applied(check.taskId)).toBe(14_000);
    expect(memberMoneyConservationProblems(await state(id))).toEqual([]);
  });

  it("(owner decision, 15 Nov 2026) a part to check dismisses through the real door and its R05 is withdrawn exactly; its bank part's dismissal is refused and its R05 stays open", async () => {
    const id = await chargedBooking([["STRIPE", 14_000], ["INTERNET_BANKING", 6_000]]);
    const receivableBefore = await balance(id, "MEMBER_RECEIVABLE");
    const payableBefore = await balance(id, "REFUND_PAYABLE");
    const { raiseCancelCardShortfallHandBack } = await import("@/lib/cancel-card-refund-shortfall");
    const shortfall = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      return raiseCancelCardShortfallHandBack(tx, { bookingId: id, paymentId: `${id}-payment`, refundAmountCents: 20_000, plannedCardRefundCents: 0, format: CLUB_FORMAT_TEST, journal: context, actorMemberId: names.officerId });
    });
    const bank = shortfall!.bank!;
    const check = shortfall!.check!;
    const checkR05 = memberMoneyEventKeys.refundObligation("hand-back", check.taskId);
    const bankR05 = memberMoneyEventKeys.refundObligation("hand-back", bank.taskId);
    expect((await eventOf(checkR05))?.journal?.reversedBy).toBeNull();

    // MUTATION: putting the part to check back under the refusal fails here with the 409.
    await resolve(check.taskId, "dismissed");

    expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: check.taskId } })).toMatchObject({ status: "DISMISSED", note: "Member said keep it", completedByMemberId: names.officerId });
    // MUTATION: deleting `withdrawDismissedCheckPartDebt` fails here: the debt stays live on a closed task.
    expect((await eventOf(checkR05))?.journal?.reversedBy).not.toBeNull();
    expect(await family(id, checkR05)).toMatchObject({ paid: 0 });
    // Raised then dismissed, the part to check leaves the journal as it was: only the bank part's debt remains.
    expect(await balance(id, "REFUND_PAYABLE")).toBe(payableBefore - 6_000);
    expect(await balance(id, "MEMBER_RECEIVABLE")).toBe(receivableBefore + 6_000);
    expect(await db.auditLog.count({ where: { targetId: id, action: "booking-payment.manual-refund-task.dismiss" } })).toBe(1);

    // MUTATION: deleting the refusal fails here: the bank part would be DISMISSED.
    await expect(resolve(bank.taskId, "dismissed")).rejects.toMatchObject({ status: 409, message: JOURNAL_HAND_BACK_DISMISS_REFUSAL });
    expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: bank.taskId } })).toMatchObject({ status: "OPEN", completedAt: null });
    expect((await eventOf(bankR05))?.journal?.reversedBy).toBeNull();
    expect(await db.auditLog.count({ where: { targetId: id, action: "booking-payment.manual-refund-task.dismiss" } })).toBe(1);
    expect(memberMoneyConservationProblems(await state(id))).toEqual([]);
  });

  /** A card booking settled for real, its capture disputed (`status`), cancelled by a member asking for a card refund (#5061). */
  async function disputedCancel(status: "OPEN" | "LOST", disputedCents = 20_000) {
    const id = `${PREFIX}${++sequence}`;
    const intent = `pi_${id}`;
    await createHistoryBooking(db, names, id, { payment: { amountCents: 20_000, source: "STRIPE", intent } });
    await settleHistoryByCard(id, 20_000);
    expect(await eventOf(memberMoneyEventKeys.bookingCharge(id))).not.toBeNull(); // the settle posted R01: the booking is in the population
    const capture = await db.paymentTransaction.findFirstOrThrow({ where: { paymentId: `${id}-payment`, stripePaymentIntentId: intent }, select: { id: true } });
    const opened = new Date("2026-06-20T00:00:00.000Z");
    await db.stripeDispute.create({ data: { stripeDisputeId: `dp_${id}`, stripeChargeId: `ch_${id}`, stripePaymentIntentId: intent, paymentTransactionId: capture.id,
      paymentId: `${id}-payment`, bookingId: id, amountCents: disputedCents, currency: "nzd", reason: "fraudulent", status, stripeStatus: status.toLowerCase(),
      stripeCreatedAt: opened, lastEventCreatedAt: opened, stripeEventId: `evt_${id}` } });
    // INV-PAY-154: the member asked for a card refund; the dispute hands the whole refund due to the treasurer instead.
    const { cancelBooking } = await import("@/lib/booking-cancel");
    expect((await cancelBooking(id, names.officerId, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);
    const tasks = await db.manualRefundTask.findMany({ where: { bookingId: id }, select: { id: true, amountCents: true, reason: true } });
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.reason).toContain(`dp_${id}`);
    expect(task.amountCents).toBeGreaterThan(0);
    return { id, task, disputeId: `dp_${id}`, r05: memberMoneyEventKeys.refundObligation("hand-back", task.id) };
  }
  /** What the officers' queue (the real GET route) says about one task: the same rule the server asks. */
  async function queuePreview(taskId: string) {
    raceSession.current = { user: { id: ADMIN, role: "ADMIN" } };
    try {
      const { GET } = await import("@/app/api/admin/payments/manual-refund-tasks/route");
      const body = await (await GET()).json() as { tasks: Array<{ id: string; journalHandBackDismissRefusal: string | null; disputedHandBackLost: boolean }> };
      return body.tasks.find((t) => t.id === taskId);
    } finally {
      raceSession.current = null;
    }
  }

  it("(#5061 reconciled; owner decision, 15 Nov 2026) a disputed card cancel posts the hand-back's R05 once and no card R05; once the dispute is lost it dismisses and the R05 is withdrawn exactly", async () => {
    const { id, task, r05 } = await disputedCancel("LOST");
    // One refund debt for the one refund: the hand-back's, for its cents. No card refund was planned, so no card R05.
    expect(await handBackDebts(task.id)).toEqual([{ obligationKey: r05, faceCents: task.amountCents }]);
    expect(await db.memberMoneyObligation.count({ where: { obligationKey: { startsWith: memberMoneyEventKeys.refundObligation("cancellation", id) } } })).toBe(0);
    expect(await db.memberMoneyObligation.count({ where: { kind: "REFUND", lines: { some: { bookingId: id } } } })).toBe(1);
    expect(await db.paymentRecoveryOperation.count({ where: { bookingId: id } })).toBe(0);
    expect(await queuePreview(task.id)).toMatchObject({ journalHandBackDismissRefusal: null, disputedHandBackLost: true });

    // MUTATION: refusing it again (dropping the lost exemption) fails here with the 409.
    await resolve(task.id, "dismissed");

    expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "DISMISSED", completedByMemberId: names.officerId });
    // MUTATION: dropping the withdrawal fails here: the debt would stay live on a closed task.
    expect((await eventOf(r05))?.journal?.reversedBy).not.toBeNull();
    expect(await family(id, r05)).toMatchObject({ paid: 0 });
    expect(await balance(id, "REFUND_PAYABLE")).toBe(0);
    expect(memberMoneyConservationProblems(await state(id))).toEqual([]);
  });

  it("(owner decision, 15 Nov 2026) while the dispute is open its Dismiss is refused, saying so; the queue says the same; recorded lost between that preview and the dismissal, it dismisses", async () => {
    const { id, task, disputeId, r05 } = await disputedCancel("OPEN");
    const { disputedHandBackDismissRefusal } = await import("@/lib/manual-refund-task-copy");
    const openRefusal = disputedHandBackDismissRefusal("OPEN");

    // MUTATION: dropping the lost requirement fails here: the open dispute's task would be DISMISSED.
    await expect(resolve(task.id, "dismissed")).rejects.toMatchObject({ status: 409, message: openRefusal });
    expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "OPEN", completedAt: null });
    expect((await eventOf(r05))?.journal?.reversedBy).toBeNull();
    expect(await queuePreview(task.id)).toMatchObject({ journalHandBackDismissRefusal: openRefusal, disputedHandBackLost: false });

    // The race: Stripe records the dispute lost after the officer's preview and before the dismissal. The door
    // re-reads the disputes under its locks, so it answers the dispute as it now stands.
    await db.stripeDispute.update({ where: { stripeDisputeId: disputeId }, data: { status: "LOST", stripeStatus: "lost" } });
    await resolve(task.id, "dismissed");

    expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "DISMISSED" });
    expect((await eventOf(r05))?.journal?.reversedBy).not.toBeNull();
    expect(memberMoneyConservationProblems(await state(id))).toEqual([]);
  });

  it("(review, High) a dispute lost for less than the refund: refused, never dismissed or withdrawn, and the queue says so", async () => {
    const { id, task, r05 } = await disputedCancel("LOST", 1_000);
    expect(task.amountCents).toBeGreaterThan(1_000);
    const { DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL } = await import("@/lib/manual-refund-task-copy");

    // MUTATION: dropping the coverage check fails here: the $10.00 lost dispute would close a larger refund.
    await expect(resolve(task.id, "dismissed")).rejects.toMatchObject({ status: 409, message: DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL });
    expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "OPEN" });
    expect((await eventOf(r05))?.journal?.reversedBy).toBeNull();
    expect(await queuePreview(task.id)).toMatchObject({ journalHandBackDismissRefusal: DISPUTED_HAND_BACK_PARTLY_LOST_REFUSAL, disputedHandBackLost: false });
    expect(memberMoneyConservationProblems(await state(id))).toEqual([]);
  });

  it("(owner decision, 15 Nov 2026) a dispute won between the queue's preview and the dismissal: refused, saying the club still owes it, and its debt stays open", async () => {
    const { id, task, disputeId, r05 } = await disputedCancel("OPEN");
    const { disputedHandBackDismissRefusal } = await import("@/lib/manual-refund-task-copy");
    expect(await queuePreview(task.id)).toMatchObject({ journalHandBackDismissRefusal: disputedHandBackDismissRefusal("OPEN") });

    await db.stripeDispute.update({ where: { stripeDisputeId: disputeId }, data: { status: "WON", stripeStatus: "won" } });

    await expect(resolve(task.id, "dismissed")).rejects.toMatchObject({ status: 409, message: disputedHandBackDismissRefusal("WON") });
    expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "OPEN", completedAt: null });
    expect((await eventOf(r05))?.journal?.reversedBy).toBeNull();
    expect(await queuePreview(task.id)).toMatchObject({ journalHandBackDismissRefusal: disputedHandBackDismissRefusal("WON"), disputedHandBackLost: false });
    expect(memberMoneyConservationProblems(await state(id))).toEqual([]);
  });

  it("MUTATION (review A): an appeal approved by bank through the real route posts its concession; once paid the member owes nothing, goodwill carries it, refund payable is clear", async () => {
    const id = await chargedBooking([["INTERNET_BANKING", 10_000]]); // cancelled with nothing refunded
    expect(await balance(id, "MEMBER_RECEIVABLE")).toBe(0);
    const requestId = `${id}-appeal`;
    await db.refundRequest.create({ data: { id: requestId, bookingId: id, memberId: names.memberId, reason: "race m4d appeal", requestedAmountCents: 10_000 } });
    const email = await import("@/lib/email");
    const spy = vi.spyOn(email, "sendEmail").mockResolvedValue(undefined as never);
    raceSession.current = { user: { id: ADMIN, role: "ADMIN" } };
    try {
      const { PUT } = await import("@/app/api/admin/refund-requests/[id]/route");
      const response = await PUT(new NextRequest(`http://localhost/api/admin/refund-requests/${requestId}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "APPROVED", approvedAmountCents: 10_000, notifyMember: false }),
      }), { params: Promise.resolve({ id: requestId }) });
      expect(response.status).toBe(200);
    } finally {
      raceSession.current = null;
      spy.mockRestore();
    }
    const task = await db.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: `refund-request-hand-back:${requestId}` }, select: { id: true, amountCents: true } });
    expect(task.amountCents).toBe(10_000);
    expect(await handBackDebts(task.id)).toEqual([{ obligationKey: memberMoneyEventKeys.refundObligation("hand-back", task.id), faceCents: 10_000 }]);
    expect(await balance(id, "GOODWILL")).toBe(10_000);

    await markPaid(task.id);
    expect(await balance(id, "MEMBER_RECEIVABLE")).toBe(0);
    expect(await balance(id, "GOODWILL")).toBe(10_000);
    expect(await balance(id, "REFUND_PAYABLE")).toBe(0);
    expect(await r14Lines(task.id)).toEqual(["CREDIT BANK 10000", "DEBIT REFUND_PAYABLE 10000"]);
    expect(memberMoneyConservationProblems(await state(id))).toEqual([]);
  });

  it("(review A) a released appeal approval reverses the bank part's concession with its R05; the re-approval's new task posts it once again", async () => {
    const id = await chargedBooking([["INTERNET_BANKING", 10_000]]);
    const { raiseRefundRequestHandBack } = await import("@/lib/edit-refund-hand-back");
    const { refundRequestHandBackOccurrenceKey } = await import("@/lib/manual-refund-task-settlement-rules");
    const requestId = `${id}-appeal`;
    await db.refundRequest.create({ data: { id: requestId, bookingId: id, memberId: names.memberId, reason: "race m4d appeal", requestedAmountCents: 10_000 } });
    const approve = () => db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const booking = await tx.booking.findUniqueOrThrow({ where: { id }, include: { payment: true } });
      await raiseRefundRequestHandBack(tx, { bookingId: id, paymentId: `${id}-payment`, refundRequestId: requestId, amountCents: 10_000, booking, journal: context, actorMemberId: ADMIN });
      return (await tx.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: refundRequestHandBackOccurrenceKey(requestId) }, select: { id: true } })).id;
    });
    const first = await approve();
    // The release, as `release_claim` runs it: the OPEN task deleted, its R05 withdrawn, under lock(1).
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await tx.manualRefundTask.deleteMany({ where: { occurrenceKey: refundRequestHandBackOccurrenceKey(requestId), status: "OPEN" } });
      expect(await withdrawRefundObligation(tx, context, { bookingId: id, scope: "hand-back", id: first, actorMemberId: ADMIN, reason: "release", senderKeyPrefix: `refund_request_refund_${requestId}` })).toBe(true);
    });
    expect(await balance(id, "GOODWILL")).toBe(0);
    expect(await balance(id, "REFUND_PAYABLE")).toBe(0);
    expect(await balance(id, "MEMBER_RECEIVABLE")).toBe(0);

    const second = await approve();
    expect(second).not.toBe(first);
    expect(await handBackDebts(second)).toEqual([{ obligationKey: memberMoneyEventKeys.refundObligation("hand-back", second), faceCents: 10_000 }]);
    expect(await balance(id, "GOODWILL")).toBe(10_000);
    expect(await balance(id, "REFUND_PAYABLE")).toBe(-10_000);
    expect(memberMoneyConservationProblems(await state(id))).toEqual([]);
  });
});
