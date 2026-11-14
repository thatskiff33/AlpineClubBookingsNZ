import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { postBookingReceipts, postHandBackObligation } from "@/lib/member-money/doors";
import { memberMoneyEventKeys, postMemberMoneyEvent } from "@/lib/member-money";
import { readMemberMoneyApplicationState } from "@/lib/member-money/internal/application-read";
import { memberMoneyApplicationTotals, memberMoneyConservationProblems } from "@/lib/member-money/internal/application-state";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
import { JOURNAL_HAND_BACK_DISMISS_REFUSAL } from "@/lib/manual-refund-task-copy";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

/**
 * #4516 (Ledger M4d, owner decision 14 Nov 2026, Q6): a bank or cash hand-back the journal holds as a debt cannot be
 * dismissed until the four-way dismissal ships. Proved on PostgreSQL through the real `resolveManualRefundTask`: the
 * refused dismissal leaves the task OPEN and its R05 open, writes no journal batch and no audit row, and a later
 * "Mark paid" posts R14 applied to that same R05.
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
const eventOf = (eventKey: string) => db.memberMoneyEvent.findUnique({ where: { eventKey }, include: { journal: { include: { reversedBy: true, applications: true, lines: true } } } });

(RUN ? describe : describe.skip)("M4d bank and cash hand-backs on PostgreSQL: dismissal refused for now (#4516)", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "M4d hand-backs");
    process.env.DATABASE_URL = url;
    ({ prisma: db } = await import("@/lib/prisma"));
    resolution = await import("@/lib/manual-refund-task-resolution");
    await cleanHistories(db, PREFIX);
    await seedHistoryFixtures(db, PREFIX);
  }, 60_000);
  afterAll(async () => {
    if (!db) return;
    await cleanHistories(db, PREFIX);
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
});
