/**
 * #5008 child A (`INV-ADDPAY-053`, `INV-PAY-047`) against real PostgreSQL, through
 * the real writer: `settleBookingByDeposit` records a deposit as the officer's cash
 * that settles the booking and raises the rest as one request with cause `balance`
 * and a due date, in one transaction.
 *
 *  1. The booking ends PAID with its beds held; received + credit + owing = worth;
 *     the request is the payment's newest row, its mirror is what the rebuild
 *     derives, and `bookingPartPaid` reads it. The booking ledger shows only the
 *     deposit's cash line; the journal shows the charge (R01), the deposit's
 *     receipt (R08) applied to it and the rest still open, with nothing posted for
 *     the request (R25). Both money records agree and the journal's batches verify.
 *  2. Each refusal writes nothing: a deposit of nothing, or of all that is owing; a
 *     due date in the past, after check-in, or not a date; a moved worth; a request
 *     already open; a booking already paid.
 *  3. Races: two deposit settles (one wins); a deposit settle against a cancel.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against the
 * guarded loopback race database. It cleans its own `race-5008-deposit-` rows.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-5008-deposit-";
const names = historyNames(PREFIX);
/** Two guests, two nights each, at 50.00 a night (`createHistoryBooking`), from 1 to 3 August 2027. */
const WORTH = 20_000;
const CHECK_IN = "2027-08-01";
const DEPOSIT = 5_000;
const DUE_ON = "2027-07-15";

let prisma: PrismaClient;
let reconciliation: typeof import("@/lib/payment-reconciliation");
let census: typeof import("@/lib/booking-ledger-projection-census-store");
let serial = 0;

/** A fresh unpaid booking at the suite's lodge, with no payment row yet. */
async function unpaidBooking(): Promise<string> {
  const id = `${PREFIX}b-${++serial}`;
  await createHistoryBooking(prisma, names, id, { payment: null });
  return id;
}

function settle(bookingId: string, overrides: Partial<Parameters<typeof reconciliation.settleBookingByDeposit>[0]> = {}) {
  return reconciliation.settleBookingByDeposit({
    bookingId,
    depositCents: DEPOSIT,
    balanceDueOn: DUE_ON,
    expectedWorthCents: WORTH,
    actingAdminMemberId: names.officerId,
    note: "Deposit paid by bank transfer before the season",
    ...overrides,
  });
}

async function paymentOf(bookingId: string) {
  return prisma.payment.findUnique({
    where: { bookingId },
    include: { transactions: { orderBy: [{ createdAt: "desc" }, { insertionSeq: "desc" }] } },
  });
}

/** Both money records against the booking's columns: nothing disagrees, lacks coverage or breaks integrity. */
async function expectCensusClean(bookingId: string) {
  const row = await census.readBookingLedgerCensusRow(prisma, bookingId);
  const evaluation = census.evaluateWithJournal(row!);
  const failing = evaluation.identities.filter((identity) => identity.status === "DISAGREE" || identity.status === "COVERAGE");
  expect(failing, `${bookingId}: ${JSON.stringify(failing)}`).toEqual([]);
  expect(evaluation.integrity).toEqual([]);
  return evaluation;
}

/** Beds one booking holds per night of its stay, through the capacity engine itself: occupancy with it, less without it. */
async function bedsHeldBy(bookingId: string) {
  const { checkCapacityForGuestRanges } = await import("@/lib/capacity");
  const occupied = async (exclude?: string) =>
    (await checkCapacityForGuestRanges(names.lodgeId, new Date(`${CHECK_IN}T00:00:00.000Z`), new Date("2027-08-03T00:00:00.000Z"), [], exclude, prisma))
      .nightDetails.map((night) => night.occupiedBeds);
  const [all, others] = [await occupied(), await occupied(bookingId)];
  return all.map((beds, night) => beds - others[night]!);
}

/**
 * The receipt census and the journal's own batch checks, for this booking. A cancelled booking's
 * hand-back still to be paid reads as that much over-collected, as for every cancelled manual payment.
 */
async function expectJournalClean(bookingId: string, paymentId: string, handBackOwedCents = 0) {
  const { readBookingReceiptCensus } = await import("@/lib/member-money/internal/receipt-census");
  const findings = await prisma.$transaction((tx) => readBookingReceiptCensus(tx, paymentId));
  expect(findings).toEqual(handBackOwedCents > 0 ? [expect.objectContaining({ kind: "OVER_COLLECTED", cents: handBackOwedCents })] : []);
  const problems = await prisma.$queryRaw<Array<{ problem: string }>>`
    SELECT unnest(public.member_money_batch_errors(j.id)) AS problem
    FROM "MemberMoneyJournal" j
    WHERE j.id IN (SELECT "journalId" FROM "MemberMoneyLine" WHERE "bookingId" = ${bookingId})`;
  expect(problems).toEqual([]);
}

/** What the member still owes on the journal: receivable debits less credits on the booking. */
async function journalReceivableCents(bookingId: string) {
  const lines = await prisma.memberMoneyLine.findMany({ where: { bookingId, account: "MEMBER_RECEIVABLE" }, select: { side: true, amountCents: true } });
  return lines.reduce((sum, line) => sum + (line.side === "DEBIT" ? line.amountCents : -line.amountCents), 0);
}

/** Nothing written: the booking still unpaid, and no payment row (or the one it had) untouched. */
async function expectNothingWritten(bookingId: string) {
  expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true } })).status).toBe("PAYMENT_PENDING");
  expect(await prisma.paymentTransaction.count({ where: { payment: { bookingId } } })).toBe(0);
  expect(await prisma.bookingLedgerLine.count({ where: { bookingId } })).toBe(0);
  expect(await prisma.memberMoneyLine.count({ where: { bookingId } })).toBe(0);
}

(RUN ? describe : describe.skip)("settling a booking by a deposit (#5008 child A)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#5008 deposit settle");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    reconciliation = await import("@/lib/payment-reconciliation");
    census = await import("@/lib/booking-ledger-projection-census-store");
    await cleanHistories(prisma, PREFIX);
    await seedHistoryFixtures(prisma, PREFIX);
  }, 120_000);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (prisma) await cleanHistories(prisma, PREFIX);
  }, 120_000);

  it("settles PAID by the deposit, holds the beds and raises the rest as one balance request", async () => {
    const id = await unpaidBooking();
    const result = await settle(id);
    expect(result).toMatchObject({ bookingId: id, depositCents: DEPOSIT, creditAppliedCents: 0, balanceCents: WORTH - DEPOSIT, balanceDueOn: DUE_ON });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("PAID");
    expect(await bedsHeldBy(id)).toEqual([2, 2]);

    const payment = (await paymentOf(id))!;
    expect(payment).toMatchObject({
      status: "SUCCEEDED",
      source: "INTERNET_BANKING",
      amountCents: DEPOSIT,
      creditAppliedCents: 0,
      additionalAmountCents: WORTH - DEPOSIT,
      additionalPaymentStatus: "PENDING",
      additionalPaymentIntentId: null,
      manuallyMarkedPaidByMemberId: names.officerId,
    });
    // INV-PAY-047: received + credit + still owed = the booking's worth.
    expect(payment.amountCents + payment.creditAppliedCents + payment.additionalAmountCents).toBe(WORTH);
    const [request, deposit] = payment.transactions;
    expect(request).toMatchObject({ kind: "ADDITIONAL", source: "INTERNET_BANKING", status: "PENDING", amountCents: WORTH - DEPOSIT, reason: "deposit_balance", stripePaymentIntentId: null, withdrawnAt: null });
    expect(request!.balanceDueOn).toEqual(new Date(`${DUE_ON}T00:00:00.000Z`));
    expect(deposit).toMatchObject({ kind: "PRIMARY", source: "INTERNET_BANKING", status: "SUCCEEDED", amountCents: DEPOSIT, reason: "deposit_settle", balanceDueOn: null });
    expect(payment.transactions).toHaveLength(2);
    expect(payment.settledByTransactionId).toBe(deposit!.id);

    // The one predicate every "Paid" surface will ask reads it as part paid.
    const { bookingPartPaid } = await import("@/lib/additional-payment-chase");
    expect(bookingPartPaid({ bookingStatus: "PAID", payment })).toEqual({ owingCents: WORTH - DEPOSIT, dueOn: DUE_ON });

    // The mirror the settle wrote is the one the rebuild derives from the rows.
    const { reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
    await reconcilePaymentAggregates({ paymentId: payment.id, store: prisma });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({
      status: "SUCCEEDED", amountCents: DEPOSIT, additionalAmountCents: WORTH - DEPOSIT, additionalPaymentStatus: "PENDING", additionalPaymentIntentId: null,
    });

    // Booking ledger: only the deposit's officer cash; the request carries no money.
    expect(await prisma.bookingLedgerLine.findMany({ where: { bookingId: id, side: "SETTLEMENT" }, select: { kind: true, amountCents: true } }))
      .toEqual([{ kind: "CASH_RECORDED", amountCents: DEPOSIT }]);
    // Journal: R01 for the whole worth, the deposit's R08 applied to it, the balance still open (R25: nothing for the request).
    const events = await prisma.memberMoneyEvent.findMany({ where: { journal: { lines: { some: { bookingId: id } } } }, select: { kind: true, origin: true, sourceIdentity: true } });
    expect(events.filter((event) => event.kind === "RECEIPT")).toEqual([expect.objectContaining({ origin: "OFFICER", sourceIdentity: deposit!.id })]);
    expect(events.some((event) => event.sourceIdentity === request!.id)).toBe(false);
    expect(await journalReceivableCents(id)).toBe(WORTH - DEPOSIT);
    await expectCensusClean(id);
    await expectJournalClean(id, payment.id);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { targetId: id, action: "booking-payment.deposit.settle" } });
    expect(audit.metadata).toMatchObject({ depositCents: DEPOSIT, balanceCents: WORTH - DEPOSIT, balanceDueOn: DUE_ON, creditAppliedCents: 0 });
  });

  it("accepts a due date on the check-in day, and refuses to reverse a deposit as a manual payment", async () => {
    const id = await unpaidBooking();
    await settle(id, { balanceDueOn: CHECK_IN });
    expect((await paymentOf(id))!.transactions[0]!.balanceDueOn).toEqual(new Date(`${CHECK_IN}T00:00:00.000Z`));
    await expect(reconciliation.reverseManualBookingPayment({ bookingId: id, actingAdminMemberId: names.officerId, note: null }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/deposit/) });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("PAID");
  });

  it.each([
    ["a deposit of nothing", { depositCents: 0 }, /more than nothing/],
    ["a deposit of all that is owing", { depositCents: WORTH }, /less than the amount owing/],
    ["a deposit of more than is owing", { depositCents: WORTH + 1 }, /less than the amount owing/],
    ["a deposit that is not whole cents", { depositCents: 50.5 }, /more than nothing/],
    ["a due date in the past", { balanceDueOn: "2026-06-30" }, /in the past/],
    ["a due date after check-in", { balanceDueOn: "2027-08-02" }, /after check-in/],
    ["a moved worth", { expectedWorthCents: WORTH - 1 }, /changed while you were recording/],
  ])("refuses %s and writes nothing", async (_label, overrides, message) => {
    const id = await unpaidBooking();
    await expect(settle(id, overrides)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(message) });
    await expectNothingWritten(id);
  });

  it("refuses a due date that is not a calendar date", async () => {
    const id = await unpaidBooking();
    await expect(settle(id, { balanceDueOn: "2027-02-30" })).rejects.toMatchObject({ status: 400 });
    await expectNothingWritten(id);
  });

  it("refuses a booking that already has a request open", async () => {
    const id = await unpaidBooking();
    const payment = await prisma.payment.create({
      data: { bookingId: id, amountCents: WORTH, source: "INTERNET_BANKING", status: "PENDING", additionalAmountCents: 3_000, additionalPaymentStatus: "PENDING" },
    });
    await prisma.paymentTransaction.create({
      data: { paymentId: payment.id, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: `pi_${PREFIX}open`, amountCents: 3_000, status: "PENDING", reason: "booking_modification" },
    });
    await expect(settle(id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/request open/) });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("PAYMENT_PENDING");
    expect(await prisma.paymentTransaction.count({ where: { paymentId: payment.id } })).toBe(1);
  });

  it("refuses a second deposit on a booking it already settled", async () => {
    const id = await unpaidBooking();
    await settle(id);
    await expect(settle(id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already paid/) });
    expect(await prisma.paymentTransaction.count({ where: { payment: { bookingId: id }, kind: "ADDITIONAL" } })).toBe(1);
  });

  it("RACE: two deposit settles on one booking; one wins, the other writes nothing", async () => {
    const id = await unpaidBooking();
    const outcomes = await Promise.allSettled([settle(id), settle(id, { depositCents: 6_000 })]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const payment = (await paymentOf(id))!;
    expect(payment.transactions.filter((row) => row.kind === "ADDITIONAL")).toHaveLength(1);
    expect(payment.transactions.filter((row) => row.kind === "PRIMARY")).toHaveLength(1);
    expect(payment.amountCents + payment.additionalAmountCents).toBe(WORTH);
    await expectCensusClean(id);
    await expectJournalClean(id, payment.id);
  });

  it("RACE: a deposit settle against a cancel; one serialises after the other and the records agree either way", async () => {
    const id = await unpaidBooking();
    const { cancelBooking } = await import("@/lib/booking-cancel");
    const [settled, cancelled] = await Promise.allSettled([settle(id), cancelBooking(id, names.officerId, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST)]);
    const { bookingPartPaid } = await import("@/lib/additional-payment-chase");
    const status = (await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    const payment = await paymentOf(id);
    expect(cancelled.status).toBe("fulfilled");
    const cancelStatus = cancelled.status === "fulfilled" ? cancelled.value.status : 0;
    if (settled.status === "rejected") {
      // The cancel committed first: the settle refuses a cancelled booking and writes nothing.
      expect(cancelStatus).toBe(200);
      expect(settled.reason).toMatchObject({ status: 409 });
      expect(status).toBe("CANCELLED");
      expect(payment?.transactions ?? []).toEqual([]);
      return;
    }
    // The settle committed first. A cancel that read the booking unpaid refuses (its own drift
    // guard) and the booking stays part paid; one that read it paid cancels it, and nothing is owed.
    expect(payment!.transactions.filter((row) => row.reason === "deposit_balance")).toHaveLength(1);
    let handBackOwedCents = 0;
    if (cancelStatus === 200) {
      expect(status).toBe("CANCELLED");
      expect(bookingPartPaid({ bookingStatus: status, payment })).toBeNull();
      handBackOwedCents = (await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: id }, select: { amountCents: true } })).amountCents;
    } else {
      expect(cancelStatus).toBe(409);
      expect(status).toBe("PAID");
      expect(bookingPartPaid({ bookingStatus: status, payment })).toEqual({ owingCents: WORTH - DEPOSIT, dueOn: DUE_ON });
    }
    await expectCensusClean(id);
    await expectJournalClean(id, payment!.id, handBackOwedCents);
  });

  it("a cancel after a deposit settle ends the booking owing nothing, both records agreeing", async () => {
    const id = await unpaidBooking();
    await settle(id);
    const { cancelBooking } = await import("@/lib/booking-cancel");
    expect((await cancelBooking(id, names.officerId, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST)).status).toBe(200);
    const payment = (await paymentOf(id))!;
    const { bookingPartPaid } = await import("@/lib/additional-payment-chase");
    expect(bookingPartPaid({ bookingStatus: "CANCELLED", payment })).toBeNull();
    expect(await bedsHeldBy(id)).toEqual([0, 0]);
    // Refunded from the money held (`INV-ADDPAY-015`): half the deposit, by hand, never the unpaid balance.
    const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: id }, select: { amountCents: true, status: true } });
    expect(task).toEqual({ amountCents: DEPOSIT / 2, status: "OPEN" });
    await expectCensusClean(id);
    // Until the hand-back is paid, the receipt census shows that much over-collected, as for any cancelled manual payment.
    await expectJournalClean(id, payment.id, task.amountCents);
  });
});
