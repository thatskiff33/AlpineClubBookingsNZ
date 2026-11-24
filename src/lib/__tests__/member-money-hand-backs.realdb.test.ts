import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { postBookingReceipts, postHandBackObligation, postMemberMergeTransfer, postRefundObligation, withdrawRefundObligation } from "@/lib/member-money/doors";
import { buildLateCaptureApprovalRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";
import { HAND_BACK_CENSUS_CLASSES, memberMoneyEventKeys, postMemberMoneyEvent, readBookingReceiptCensus, readBookingRefundCensus } from "@/lib/member-money";
import { readMemberMoneyApplicationState } from "@/lib/member-money/internal/application-read";
import { memberMoneyApplicationTotals, memberMoneyConservationProblems } from "@/lib/member-money/internal/application-state";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
import { JOURNAL_HAND_BACK_DISMISS_REFUSAL } from "@/lib/manual-refund-task-copy";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures, settleHistoryByCard } from "./support/booking-ledger-history";
import { memberMoneyTestContext, MEMBER_MONEY_TEST_TAX_ANCHOR } from "./support/member-money-fixtures";
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
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: 10_000, booking: where, chargeIdentity: `booking:${id}:test`, taxAnchorDate: MEMBER_MONEY_TEST_TAX_ANCHOR, evidence: {} },
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
        { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: 2_000, booking: where, chargeIdentity: `booking:${id}:test`, taxAnchorDate: MEMBER_MONEY_TEST_TAX_ANCHOR, evidence: {} },
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
const MERGE_MEMBERS = `${PREFIX}x-`;
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
async function chargedBooking(charges: ReadonlyArray<["STRIPE" | "INTERNET_BANKING", number]>, cancelled = true, memberId = names.memberId) {
  const id = `${PREFIX}${++sequence}`;
  const total = charges.reduce((sum, [, cents]) => sum + cents, 0);
  const where = { bookingId: id, lodgeId: names.lodgeId };
  await createHistoryBooking(db, { ...names, memberId }, id, { payment: { amountCents: total, source: charges[0]![0] } });
  await db.$transaction((tx) => postMemberMoneyEvent(tx, context, {
    kind: "CHARGE", eventKey: memberMoneyEventKeys.bookingCharge(id), origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic R01",
    obligations: [{ key: memberMoneyEventKeys.bookingCharge(id), kind: "CHARGE", debtor: { kind: "MEMBER", memberId }, faceCents: total, evidence: {} }],
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: total, booking: where, debtor: { kind: "MEMBER", memberId }, obligationKey: memberMoneyEventKeys.bookingCharge(id), evidence: {} },
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: total, booking: where, chargeIdentity: `booking:${id}:test`, taxAnchorDate: MEMBER_MONEY_TEST_TAX_ANCHOR, evidence: {} },
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
  await db.member.deleteMany({ where: { id: { startsWith: MERGE_MEMBERS } } });
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

  it("#5191: a part to check dismissed after its owner merged away: its reversal's receivable follows the merge to the survivor", async () => {
    const [from, to] = [`${MERGE_MEMBERS}${++sequence}`, `${MERGE_MEMBERS}${++sequence}`];
    for (const memberId of [from, to]) {
      await db.member.create({ data: { id: memberId, email: `${memberId}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: "Proof", ageTier: "ADULT" } });
    }
    const id = await chargedBooking([["STRIPE", 14_000], ["INTERNET_BANKING", 6_000]], true, from);
    const { raiseCancelCardShortfallHandBack } = await import("@/lib/cancel-card-refund-shortfall");
    const shortfall = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      return raiseCancelCardShortfallHandBack(tx, { bookingId: id, paymentId: `${id}-payment`, refundAmountCents: 20_000, plannedCardRefundCents: 0, format: CLUB_FORMAT_TEST, journal: context, actorMemberId: names.officerId });
    });
    const check = shortfall!.check!;
    const receivable = async (memberId: string) => (await db.memberMoneyLine.findMany({ where: { bookingId: id, account: "MEMBER_RECEIVABLE", debtorKind: "MEMBER", memberId }, select: { side: true, amountCents: true } }))
      .reduce((sum, l) => sum + (l.side === "DEBIT" ? 1 : -1) * l.amountCents, 0);
    const before = await receivable(from);
    // Member merge's order: the owner move, then the D4 transfer of the merged-away member's balances.
    await db.$transaction(async (tx) => {
      await tx.booking.update({ where: { id }, data: { memberId: to } });
      await postMemberMergeTransfer(tx, context, { fromMemberId: from, toMemberId: to, actorMemberId: names.officerId });
    });

    await resolve(check.taskId, "dismissed");

    expect((await eventOf(memberMoneyEventKeys.refundObligation("hand-back", check.taskId)))?.journal?.reversedBy).not.toBeNull();
    // MUTATION: deleting the residue move in `reverseRefundObligation` leaves -14000 on the merged-away member here.
    expect(await receivable(from)).toBe(0);
    expect(await receivable(to)).toBe(before - 14_000);
    expect(await db.memberMoneyEvent.count({ where: { eventKey: { startsWith: "merge-residue:" }, sourceIdentity: id } })).toBe(1);
    expect((await db.$transaction((tx) => readBookingReceiptCensus(tx, `${id}-payment`))).filter((f) => f.kind === "MERGED_DEBTOR_BALANCE")).toEqual([]);
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
    return { id, task, disputeId: `dp_${id}`, r05: memberMoneyEventKeys.refundObligation("hand-back", task.id), intent, captureId: capture.id };
  }
  /** One more dispute on the same payment's capture, as #5061 records each dispute Stripe sends. */
  async function addDispute(d: { id: string; intent: string; captureId: string }, suffix: string, status: "OPEN" | "LOST" | "WON", amountCents: number) {
    const opened = new Date("2026-06-21T00:00:00.000Z");
    await db.stripeDispute.create({ data: { stripeDisputeId: `dp_${d.id}_${suffix}`, stripeChargeId: `ch_${d.id}`, stripePaymentIntentId: d.intent, paymentTransactionId: d.captureId,
      paymentId: `${d.id}-payment`, bookingId: d.id, amountCents, currency: "nzd", reason: "product_unacceptable", status, stripeStatus: status.toLowerCase(),
      stripeCreatedAt: opened, lastEventCreatedAt: opened, stripeEventId: `evt_${d.id}_${suffix}` } });
  }
  const reduce = async (taskId: string, expectedAmountCents: number, expectedReducedByCents: number) =>
    (await import("@/lib/manual-refund-task-dispute-reduction")).reduceDisputedHandBack({ taskId, actingMemberId: names.officerId, expectedAmountCents, expectedReducedByCents });
  const reductions = (taskId: string) => db.memberMoneyEvent.count({ where: { eventKey: { startsWith: `hand-back-reduced:${taskId}|` } } });
  const owed = async (taskId: string) => (await db.manualRefundTask.findUniqueOrThrow({ where: { id: taskId } })).amountCents!;
  const r05Open = async (bookingId: string, r05: string) => (await db.memberMoneyObligation.findUniqueOrThrow({ where: { obligationKey: r05 }, select: { faceCents: true } })).faceCents
    - (await family(bookingId, r05)).paid;
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

  it("(review) a lost group-settlement dispute filed on the booking, with no payment, does not unlock the booking's own hand-back", async () => {
    const id = await cancelledBankBooking();
    const taskId = await raiseHandBack(id);
    const opened = new Date("2026-06-20T00:00:00.000Z");
    // As #5061 records a dispute on an organiser's settlement: matched to the organiser's booking, no Payment or capture.
    await db.stripeDispute.create({ data: { stripeDisputeId: `dp_${id}_settlement`, stripeChargeId: `ch_${id}_settlement`, bookingId: id,
      amountCents: 100_000, currency: "nzd", reason: "fraudulent", status: "LOST", stripeStatus: "lost", stripeCreatedAt: opened, lastEventCreatedAt: opened,
      stripeEventId: `evt_${id}_settlement` } });

    // MUTATION: counting every dispute on the booking (not only the task's payment's) fails here: it would dismiss.
    await expect(resolve(taskId, "dismissed")).rejects.toMatchObject({ status: 409, message: JOURNAL_HAND_BACK_DISMISS_REFUSAL });
    expect((await eventOf(memberMoneyEventKeys.refundObligation("hand-back", taskId)))?.journal?.reversedBy).toBeNull();
    expect(await queuePreview(taskId)).toMatchObject({ journalHandBackDismissRefusal: JOURNAL_HAND_BACK_DISMISS_REFUSAL, disputedHandBackLost: false });
  });

  describe("a dispute lost for part of the hand-back (owner decision, 15 Nov 2026, comment 6893252570)", () => {
    it("reduces it by exactly the lost cents, the rest still owed and open in the journal; a second loss reduces again; the rest lost, it dismisses", async () => {
      const d = await disputedCancel("LOST", 1_000);
      const was = d.task.amountCents!;
      expect(await queuePreview(d.task.id)).toMatchObject({ disputeReduction: { reducedByCents: 1_000, stillOwedCents: was - 1_000 }, disputedHandBackLost: false });

      // MUTATION: dropping the reduction (or the coverage that offers it) fails here.
      expect(await reduce(d.task.id, was, 1_000)).toEqual({ taskId: d.task.id, wasCents: was, reducedByCents: 1_000, stillOwedCents: was - 1_000 });
      expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: d.task.id } })).toMatchObject({ status: "OPEN", amountCents: was - 1_000, raisedAmountCents: was });
      expect(await reductions(d.task.id)).toBe(1);
      expect(await r05Open(d.id, d.r05)).toBe(was - 1_000);
      expect(await balance(d.id, "REFUND_PAYABLE")).toBe(-(was - 1_000));
      expect(memberMoneyConservationProblems(await state(d.id))).toEqual([]);

      await addDispute(d, "second", "LOST", 500);
      expect(await queuePreview(d.task.id)).toMatchObject({ disputeReduction: { reducedByCents: 500, stillOwedCents: was - 1_500 } });
      await reduce(d.task.id, was - 1_000, 500);
      expect(await owed(d.task.id)).toBe(was - 1_500);
      expect(await reductions(d.task.id)).toBe(2);
      expect(await r05Open(d.id, d.r05)).toBe(was - 1_500);

      await addDispute(d, "rest", "LOST", was - 1_500);
      expect(await queuePreview(d.task.id)).toMatchObject({ journalHandBackDismissRefusal: null, disputedHandBackLost: true, disputeReduction: null });
      await resolve(d.task.id, "dismissed");
      expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: d.task.id } })).toMatchObject({ status: "DISMISSED", amountCents: was - 1_500 });
      expect(await eventOf(memberMoneyEventKeys.handBackRestWithdrawn(d.task.id))).not.toBeNull();
      expect(await r05Open(d.id, d.r05)).toBe(0);
      expect(await balance(d.id, "REFUND_PAYABLE")).toBe(0);
      expect(memberMoneyConservationProblems(await state(d.id))).toEqual([]);
    });

    it("review: Mark paid at the full amount is refused while lost for part; after the reduction it pays only what is still owed", async () => {
      const d = await disputedCancel("LOST", 1_000);
      const was = d.task.amountCents!;
      const { DISPUTED_HAND_BACK_REDUCE_BEFORE_PAYING } = await import("@/lib/manual-refund-task-copy");
      await expect(markPaid(d.task.id)).rejects.toMatchObject({ status: 409, message: DISPUTED_HAND_BACK_REDUCE_BEFORE_PAYING });
      expect(await eventOf(memberMoneyEventKeys.handBackPaid(d.task.id))).toBeNull();
      await reduce(d.task.id, was, 1_000);
      await markPaid(d.task.id);
      expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: d.task.id } })).toMatchObject({ status: "COMPLETED", amountCents: was - 1_000 });
      expect(await r14Lines(d.task.id)).toEqual([`CREDIT BANK ${was - 1_000}`, `DEBIT REFUND_PAYABLE ${was - 1_000}`]);
      expect(await r14Applied(d.task.id)).toBe(was - 1_000);
      expect(await r05Open(d.id, d.r05)).toBe(0);
      expect(memberMoneyConservationProblems(await state(d.id))).toEqual([]);
    });

    it("review: lost on one charge beside a dispute still open on another, Mark paid at the full amount and Reduce are both refused, writing nothing", async () => {
      const d = await disputedCancel("LOST", 1_000);
      await addDispute(d, "open", "OPEN", 500);
      const was = d.task.amountCents!;
      const { DISPUTED_HAND_BACK_WAIT_FOR_OPEN_DISPUTE, disputedHandBackReductionRefusal } = await import("@/lib/manual-refund-task-copy");
      await expect(markPaid(d.task.id)).rejects.toMatchObject({ status: 409, message: DISPUTED_HAND_BACK_WAIT_FOR_OPEN_DISPUTE });
      await expect(reduce(d.task.id, was, 1_000)).rejects.toMatchObject({ status: 409, message: disputedHandBackReductionRefusal("OPEN") });
      expect(await eventOf(memberMoneyEventKeys.handBackPaid(d.task.id))).toBeNull();
      expect(await owed(d.task.id)).toBe(was);
      expect(await reductions(d.task.id)).toBe(0);
      expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: d.task.id } })).toMatchObject({ status: "OPEN" });
    });

    it("refuses the reduction while the dispute is open or after it was won, writing nothing", async () => {
      const d = await disputedCancel("OPEN", 1_000);
      const { disputedHandBackReductionRefusal } = await import("@/lib/manual-refund-task-copy");
      await expect(reduce(d.task.id, d.task.amountCents!, 1_000)).rejects.toMatchObject({ status: 409, message: disputedHandBackReductionRefusal("OPEN") });
      await db.stripeDispute.update({ where: { stripeDisputeId: d.disputeId }, data: { status: "WON", stripeStatus: "won" } });
      await expect(reduce(d.task.id, d.task.amountCents!, 1_000)).rejects.toMatchObject({ status: 409, message: disputedHandBackReductionRefusal("WON") });
      expect(await owed(d.task.id)).toBe(d.task.amountCents);
      expect(await reductions(d.task.id)).toBe(0);
    });

    it("a double submit reduces once: one request wins, the other is refused, one journal withdrawal", async () => {
      const d = await disputedCancel("LOST", 1_000);
      const was = d.task.amountCents!;
      const results = await Promise.allSettled([reduce(d.task.id, was, 1_000), reduce(d.task.id, was, 1_000)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)).toEqual([expect.objectContaining({ status: 409 })]);
      expect(await owed(d.task.id)).toBe(was - 1_000);
      expect(await reductions(d.task.id)).toBe(1);
      expect(await r05Open(d.id, d.r05)).toBe(was - 1_000);
    });

    it("racing a dismissal, the reduction wins and the dismissal is refused (lost for part): one change, no rest withdrawn", async () => {
      const d = await disputedCancel("LOST", 1_000);
      const was = d.task.amountCents!;
      const [reduced, dismissed] = await Promise.allSettled([reduce(d.task.id, was, 1_000), resolve(d.task.id, "dismissed")]);
      expect(reduced.status).toBe("fulfilled");
      expect(dismissed).toMatchObject({ status: "rejected", reason: expect.objectContaining({ status: 409 }) });
      expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: d.task.id } })).toMatchObject({ status: "OPEN", amountCents: was - 1_000 });
      expect(await reductions(d.task.id)).toBe(1);
      expect(await eventOf(memberMoneyEventKeys.handBackRestWithdrawn(d.task.id))).toBeNull();
    });

    it("racing Mark paid for the amount the officer saw, the reduction wins (Mark paid is refused at the full amount either way) and nothing is withdrawn or paid twice", async () => {
      const d = await disputedCancel("LOST", 1_000);
      const was = d.task.amountCents!;
      const markPaidAsSeen = () => resolution.resolveManualRefundTask({ taskId: d.task.id, resolution: "completed", note: null, actingMemberId: names.officerId,
        confirmedAmountCents: was, direction: "REFUND_TO_MEMBER", handedBackInCash: false, recordedNightPrices: null }, CLUB_FORMAT_TEST);
      const results = await Promise.allSettled([reduce(d.task.id, was, 1_000), markPaidAsSeen()]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const task = await db.manualRefundTask.findUniqueOrThrow({ where: { id: d.task.id } });
      if (task.status === "COMPLETED") {
        expect(await reductions(d.task.id)).toBe(0);
        expect(await r14Applied(d.task.id)).toBe(was);
      } else {
        expect(task).toMatchObject({ status: "OPEN", amountCents: was - 1_000 });
        expect(await reductions(d.task.id)).toBe(1);
        expect(await eventOf(memberMoneyEventKeys.handBackPaid(d.task.id))).toBeNull();
      }
      expect(memberMoneyConservationProblems(await state(d.id))).toEqual([]);
    });

    it("a dispute recorded lost between the queue's view and the click: refused as stale, then the fresh view's reduction applies", async () => {
      const d = await disputedCancel("LOST", 1_000);
      const was = d.task.amountCents!;
      expect(await queuePreview(d.task.id)).toMatchObject({ disputeReduction: { reducedByCents: 1_000 } });
      await addDispute(d, "late", "LOST", 500);
      const { DISPUTED_HAND_BACK_REDUCTION_STALE_MESSAGE } = await import("@/lib/manual-refund-task-dispute-reduction");
      await expect(reduce(d.task.id, was, 1_000)).rejects.toMatchObject({ status: 409, message: DISPUTED_HAND_BACK_REDUCTION_STALE_MESSAGE });
      expect(await reductions(d.task.id)).toBe(0);
      expect(await queuePreview(d.task.id)).toMatchObject({ disputeReduction: { reducedByCents: 1_500, stillOwedCents: was - 1_500 } });
      await reduce(d.task.id, was, 1_500);
      expect(await owed(d.task.id)).toBe(was - 1_500);
    });
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

  describe("#5185: the hand-back census and report v3 over this file's bookings", () => {
    const HAND_BACK_KINDS: readonly string[] = HAND_BACK_CENSUS_CLASSES;
    /** The census's evaluations of this file's bookings, from one read-only repeatable-read snapshot, as the census reads them. */
    const census = async () => {
      const { evaluateBookingLedgerPages } = await import("@/lib/booking-ledger-projection-census-store");
      const evaluations = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return evaluateBookingLedgerPages(tx);
      }, { isolationLevel: "RepeatableRead", timeout: 60_000 });
      return evaluations.filter((evaluation) => evaluation.bookingId.startsWith(PREFIX));
    };
    const handBackFindings = async () => (await census()).flatMap((evaluation) => evaluation.integrity.filter((finding) => HAND_BACK_KINDS.includes(finding.kind)))
      .map((finding) => `${finding.kind} ${finding.lineId}`);
    const refundPayable = async (bookingId: string) => (await census()).find((evaluation) => evaluation.bookingId === bookingId)!
      .identities.find((identity) => identity.identity === "JOURNAL_REFUND_PAYABLE")!;
    const refundCensusKinds = async (bookingId: string) => db.$transaction((tx) => readBookingRefundCensus(tx, `${bookingId}-payment`))
      .then((findings) => findings.filter((finding) => HAND_BACK_KINDS.includes(finding.kind)).map((finding) => `${finding.kind} ${finding.identity}`));
    /** A journal hand-back task written straight to the table, as a door that skipped its R05 would leave it. */
    const bareTask = (id: string, data: { status?: "OPEN" | "COMPLETED"; completedAt?: Date } = {}) => db.manualRefundTask.create({ data: {
      bookingId: id, paymentId: `${id}-payment`, amountCents: 3_000, raisedAmountCents: 3_000, kind: "CANCELLED_BOOKING_HAND_BACK",
      reason: `Booking ${id} cancelled, refund by hand.`, ...data } });

    it("every scenario above reads consistent: no hand-back class, and v3 agrees on every booking whose R01 is in the journal", async () => {
      expect(await handBackFindings()).toEqual([]);
      const refunds = (await census()).flatMap((evaluation) => evaluation.identities.filter((identity) => identity.identity === "JOURNAL_REFUND_PAYABLE"));
      expect(refunds.length).toBeGreaterThan(0);
      expect(refunds.filter((identity) => identity.status !== "AGREE")).toEqual([]);
      // A booking holding hand-back debts reads non-zero on both sides, so v3 is no zero-equals-zero comparison.
      expect(refunds.some((identity) => identity.columnCents > 0)).toBe(true);
    });

    it("reports a raise that skipped its R05, then its unapplied payment, in the census and the refund command", async () => {
      const id = await chargedBooking([["INTERNET_BANKING", 10_000]]);
      const task = await bareTask(id);
      expect(await handBackFindings()).toEqual([`HAND_BACK_WITHOUT_EVENT ${task.id}`]);
      await markPaid(task.id); // no debt in the journal, so its R14 posts unapplied
      expect(await r14Applied(task.id)).toBe(0);
      expect(await handBackFindings()).toEqual([`HAND_BACK_WITHOUT_EVENT ${task.id}`, `UNAPPLIED_HAND_BACK ${task.id}`]);
      expect(await refundCensusKinds(id)).toEqual([`HAND_BACK_WITHOUT_EVENT ${task.id}`, `UNAPPLIED_HAND_BACK ${task.id}`]);
      await db.manualRefundTask.delete({ where: { id: task.id } });
    });

    it("reports a hand-back completed with no payment in the journal", async () => {
      const id = await chargedBooking([["INTERNET_BANKING", 10_000]]);
      const taskId = await raiseHandBack(id);
      await db.manualRefundTask.update({ where: { id: taskId }, data: { status: "COMPLETED", completedAt: new Date(), completedByMemberId: names.officerId } });
      const findings = await handBackFindings();
      expect(findings).toContain(`HAND_BACK_PAID_WITHOUT_EVENT ${taskId}`);
      // Its debt is still open while its task is closed: drift too, and v3 disagrees by the debt.
      expect(findings).toContain(`HAND_BACK_OBLIGATION_DRIFT ${taskId}`);
      expect(await refundPayable(id)).toMatchObject({ status: "DISAGREE", columnCents: 8_000, ledgerCents: 0 });
      await db.manualRefundTask.update({ where: { id: taskId }, data: { status: "OPEN", completedAt: null, completedByMemberId: null } });
      expect(await handBackFindings()).toEqual([]);
    });

    it("reports a debt that drifted from its task's amount, and an open debt whose task row is gone (#5212)", async () => {
      const id = await chargedBooking([["INTERNET_BANKING", 10_000]]);
      const taskId = await raiseHandBack(id);
      await db.manualRefundTask.update({ where: { id: taskId }, data: { amountCents: 5_000 } });
      expect(await handBackFindings()).toEqual([`HAND_BACK_OBLIGATION_DRIFT ${taskId}`]);
      expect(await refundPayable(id)).toMatchObject({ status: "DISAGREE", columnCents: 8_000, ledgerCents: 5_000 });
      await db.manualRefundTask.delete({ where: { id: taskId } }); // as `release_claim` would, without withdrawing the R05
      expect(await handBackFindings()).toEqual([`HAND_BACK_OBLIGATION_DRIFT ${taskId}`]);
      expect(await refundPayable(id)).toMatchObject({ status: "DISAGREE", columnCents: 8_000, ledgerCents: 0 });
      await db.$transaction((tx) => withdrawRefundObligation(tx, context, { bookingId: id, scope: "hand-back", id: taskId, actorMemberId: ADMIN, reason: "census test", senderKeyPrefix: `census-${taskId}` }));
      expect(await handBackFindings()).toEqual([]);
    });

    it("(review fix 1) a late capture whose automatic refund Stripe refused agrees while held, with a failed row on its debt, and once kept", async () => {
      const id = await chargedBooking([["STRIPE", 10_000]]);
      const intent = `pi_${id}_refused`;
      await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source: "STRIPE", kind: "ADDITIONAL", status: "SUCCEEDED", amountCents: 2_500, stripePaymentIntentId: intent } });
      // The automatic refund's reservation step posts the capture-return R05 (`ensureFaceCents`); Stripe's refusal
      // releases only the reservation, so the R05 alone is what it leaves. Posted here through the same door.
      await db.$transaction((tx) => postRefundObligation(tx, context, { bookingId: id, scope: "capture-return", id: intent, amountCents: 2_500, origin: "APP", debtorRead: "plain" }));
      // The refusal holds the capture on an OPEN approval task (`holdLateCaptureForTreasurerIfRequired`).
      const task = await db.manualRefundTask.create({ data: { bookingId: id, paymentId: `${id}-payment`, amountCents: 2_500, raisedAmountCents: 2_500,
        kind: "DELETED_BOOKING_LATE_CAPTURE", lateCaptureApprovalIntentId: intent, reason: "A late card charge held for the treasurer.", status: "OPEN" } });
      expect(await refundPayable(id)).toMatchObject({ status: "AGREE", columnCents: 2_500, ledgerCents: 2_500 });
      // A card refund row left FAILED on the same debt is counted once: the row, not the task beside it.
      await db.paymentRecoveryOperation.create({ data: { type: "REFUND_BOOKING_MODIFICATION", status: "FAILED", attempts: 9, bookingId: id, paymentId: `${id}-payment`,
        paymentIntentId: intent, amountCents: 2_500, idempotencyKey: buildLateCaptureApprovalRefundRecoveryIdempotencyKey(intent) } });
      expect(await refundPayable(id)).toMatchObject({ status: "AGREE", columnCents: 2_500, ledgerCents: 2_500 });
      // Held OPEN, the task is no keep yet: only a dismissed task's intent is read for one.
      expect(await handBackFindings()).toEqual([]);
      // The treasurer keeps it through the real door: the debt is reversed (`closeKeptCaptureReturn`) and the keep posts.
      await resolve(task.id, "dismissed");
      expect(await db.manualRefundTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })).toEqual({ status: "DISMISSED" });
      expect(await refundPayable(id)).toMatchObject({ status: "AGREE", columnCents: 0, ledgerCents: 0 });
      expect(await handBackFindings()).toEqual([]);
      await db.paymentRecoveryOperation.deleteMany({ where: { bookingId: id } });
    });

    it("reports a late capture kept with no keep in the journal", async () => {
      const id = await chargedBooking([["STRIPE", 10_000]]);
      const intent = `pi_${id}_late`;
      await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source: "STRIPE", kind: "ADDITIONAL", status: "SUCCEEDED", amountCents: 2_500, stripePaymentIntentId: intent } });
      const task = await db.manualRefundTask.create({ data: { bookingId: id, paymentId: `${id}-payment`, amountCents: 2_500, raisedAmountCents: 2_500,
        kind: "DELETED_BOOKING_LATE_CAPTURE", lateCaptureApprovalIntentId: intent, reason: "A late card charge held for the treasurer.",
        status: "DISMISSED", completedAt: new Date(), completedByMemberId: names.officerId } });
      expect(await handBackFindings()).toEqual([`KEEP_WITHOUT_EVENT ${task.id}`]);
      expect(await refundCensusKinds(id)).toEqual([`KEEP_WITHOUT_EVENT ${task.id}`]);
      await db.manualRefundTask.delete({ where: { id: task.id } });
    });
  });
});
