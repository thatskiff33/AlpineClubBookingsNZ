import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { postBookingReceipts, reserveCardRefundSlice } from "@/lib/member-money/doors";
import { memberMoneyEventKeys, MemberMoneyReservationRefused, postMemberMoneyEvent } from "@/lib/member-money";
import { readMemberMoneyApplicationState } from "@/lib/member-money/internal/application-read";
import { memberMoneyApplicationTotals, memberMoneyConservationProblems } from "@/lib/member-money/internal/application-state";
import { MEMBER_MONEY_CAP_PROBLEMS } from "@/lib/member-money/internal/cap-problems";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { cardShortfallLateRefundExample, EXAMPLE_BANK_CENTS, EXAMPLE_CARD_CENTS, EXAMPLE_PRICE_CENTS } from "./support/card-shortfall-late-refund-example";
import { memberMoneyTestContext, MEMBER_MONEY_TEST_TAX_ANCHOR } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks } from "./support/stripe-race-double";

/**
 * #4488 (owner, 28 Oct and 11 Nov 2026), the member-money ledger's half of worked example 1: a $300.00 booking paid
 * $200.00 by card (A) and $100.00 by internet banking (B), cancelled with everything due back. The card refund dies,
 * the treasurer closes it "Paid another way" for $200.00 and marks the $100.00 card refund shortfall paid back by
 * bank; then the lost card refund turns up late through `charge.refunded` and fails.
 *
 * The story runs through the real writers in `support/card-shortfall-late-refund-example.ts`, the driver the refund
 * floor's proof (`card-refund-reversal-shortfall-floor.realdb.test.ts`) also uses. Here the booking is in the
 * journal population first (a synthetic R01, both charges collected by their receipts, as `chargedBooking` in
 * `member-money-hand-backs.realdb.test.ts` seeds one), so every step posts. The journal must then read: each debt
 * raised at the cancel (R05), each paid once by bank (R14), the late refund's R12 reversed exactly once by R13
 * without reopening either debt, the card capture unable to fund another refund, and the caps holding. Over the
 * whole booking, debits equal credits and the bank account reads $100.00 in (B's receipt) less $300.00 paid back.
 *
 * MUTATION (#5373, each seen red on this suite against committed code, 22 Nov 2026, then undone):
 * 1. `expectedRefundedFloorCents` (`payment-transaction-status.ts`) summing every bank-cash kind but
 *    `shortfallPaybackCents`: the closing `mirrors()` line fails with charge A at 10000 and the payment at 20000.
 * 2. `postCardRefundCash` (`member-money/internal/refund-cash.ts`) never calling `reverseFailedRefund`: the R13
 *    count fails, 0 for 1.
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
const PREFIX = "race-m4-4488";
const LATE_REFUND = "re_race_m4_4488_late";
const context = memberMoneyTestContext();
let db: PrismaClient;
let example: ReturnType<typeof cardShortfallLateRefundExample>;

type JournalEvent = Awaited<ReturnType<typeof eventOf>>;
const eventOf = (eventKey: string) => db.memberMoneyEvent.findUnique({ where: { eventKey }, include: { journal: { include: { reversedBy: true, applications: true, lines: true } } } });
const linesOf = (event: JournalEvent) => event?.journal?.lines.map((l) => `${l.side} ${l.account} ${l.amountCents}`).sort();
const appliedOf = (event: JournalEvent) => event?.journal?.applications.reduce((sum, a) => sum + a.amountCents, 0);
/** Signed balance (debit positive) of one account over some journal lines. */
const balance = (lines: ReadonlyArray<{ side: string; amountCents: number }>) => lines.reduce((sum, l) => sum + (l.side === "DEBIT" ? 1 : -1) * l.amountCents, 0);
const stripeClearingOf = (...events: JournalEvent[]) => balance(events.flatMap((e) => e?.journal?.lines ?? []).filter((l) => l.account === "STRIPE_CLEARING"));
const state = () => db.$transaction((tx) => readMemberMoneyApplicationState(tx, example.ids.booking));
const family = async (key: string) => memberMoneyApplicationTotals(await state()).families.get(key) ?? { funded: 0, paid: 0, reserved: 0 };

/** The example's paid booking, put in the journal population: a synthetic R01 for its price and both charges collected. */
async function seedJournalledBooking() {
  const { ids } = example;
  await example.seedPaidBooking();
  const id = ids.booking;
  const where = { bookingId: id, lodgeId: ids.lodge };
  const debtor = { kind: "MEMBER" as const, memberId: ids.member };
  await db.$transaction((tx) => postMemberMoneyEvent(tx, context, {
    kind: "CHARGE", eventKey: memberMoneyEventKeys.bookingCharge(id), origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic R01",
    obligations: [{ key: memberMoneyEventKeys.bookingCharge(id), kind: "CHARGE", debtor, faceCents: EXAMPLE_PRICE_CENTS, evidence: {} }],
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: EXAMPLE_PRICE_CENTS, booking: where, debtor, obligationKey: memberMoneyEventKeys.bookingCharge(id), evidence: {} },
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: EXAMPLE_PRICE_CENTS, booking: where, chargeIdentity: `booking:${id}:test`, taxAnchorDate: MEMBER_MONEY_TEST_TAX_ANCHOR, evidence: {} },
    ] }));
  await db.$transaction(async (tx) => {
    await syncBookingLedgerSettlements({ paymentId: ids.payment, store: tx });
    await postBookingReceipts(tx, context, { paymentId: ids.payment, decision: { transactionIds: [ids.cardTxn, ids.bankTxn], collect: true } });
  });
}

(RUN ? describe : describe.skip)("#4488 card refund shortfall paid back, then the lost card refund fails late — member-money journal on PostgreSQL", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#4488 member-money late refund");
    process.env.DATABASE_URL = url;
    ({ prisma: db } = await import("@/lib/prisma"));
    example = cardShortfallLateRefundExample(db, PREFIX, CLUB_FORMAT_TEST);
    await example.createFixtures();
  }, 60_000);
  afterAll(async () => {
    resetStripeRaceHooks();
    if (db) await example.deleteFixtures();
  }, 60_000);

  it("both debts are paid once by bank, the late R12 is reversed once by R13, neither debt reopens, and the card funds no further refund", async () => {
    const { ids } = example;
    const bookingId = ids.booking;
    const cardDebt = memberMoneyEventKeys.refundObligation("cancellation", bookingId);
    await seedJournalledBooking();

    // Step 1: the cancel raises both debts; the card refund's retries are spent with Stripe silent.
    await example.cancel();
    expect((await example.spendCardRefundRetries()).status).toBe("FAILED");
    const taskId = (await example.shortfallTask()).id;
    const handBackDebt = memberMoneyEventKeys.refundObligation("hand-back", taskId);
    // The hand-back's R05 is posted at the raise for the shortfall's face, and nothing pays it yet.
    expect(await db.memberMoneyObligation.findMany({ where: { obligationKey: handBackDebt }, select: { faceCents: true } })).toEqual([{ faceCents: EXAMPLE_BANK_CENTS }]);
    expect(linesOf(await eventOf(handBackDebt))).toEqual([`CREDIT REFUND_PAYABLE ${EXAMPLE_BANK_CENTS}`, `DEBIT MEMBER_RECEIVABLE ${EXAMPLE_BANK_CENTS}`]);
    expect(await family(handBackDebt)).toMatchObject({ paid: 0 });
    expect(await db.memberMoneyObligation.findMany({ where: { obligationKey: cardDebt }, select: { faceCents: true } })).toEqual([{ faceCents: EXAMPLE_CARD_CENTS }]);
    expect(linesOf(await eventOf(cardDebt))).toEqual([`CREDIT REFUND_PAYABLE ${EXAMPLE_CARD_CENTS}`, `DEBIT MEMBER_RECEIVABLE ${EXAMPLE_CARD_CENTS}`]);
    expect(await family(cardDebt)).toMatchObject({ paid: 0 });

    // Step 2: the shortfall waits for the card refund's close; then both are paid by bank.
    await expect(example.resolveShortfall()).rejects.toThrow();
    expect(await eventOf(memberMoneyEventKeys.handBackPaid(taskId))).toBeNull();
    await example.closeCardRefund();
    await example.resolveShortfall();

    const handBackPaid = await eventOf(memberMoneyEventKeys.handBackPaid(taskId));
    expect(linesOf(handBackPaid)).toEqual([`CREDIT BANK ${EXAMPLE_BANK_CENTS}`, `DEBIT REFUND_PAYABLE ${EXAMPLE_BANK_CENTS}`]);
    expect(appliedOf(handBackPaid)).toBe(EXAMPLE_BANK_CENTS);
    const closes = await db.manualRefundTask.findMany({ where: { bookingId, NOT: { id: taskId } }, select: { id: true } });
    expect(closes).toHaveLength(1);
    const paidAnotherWay = await eventOf(memberMoneyEventKeys.paidAnotherWay(closes[0]!.id));
    expect(linesOf(paidAnotherWay)).toEqual([`CREDIT BANK ${EXAMPLE_CARD_CENTS}`, `DEBIT REFUND_PAYABLE ${EXAMPLE_CARD_CENTS}`]);
    expect(appliedOf(paidAnotherWay)).toBe(EXAMPLE_CARD_CENTS);

    // The hand-back is funded from B's receipt (the bank charge's own collected credit) and paid by its R14.
    const receiptB = await db.memberMoneyLine.findFirstOrThrow({ where: { bookingId, account: "MEMBER_RECEIVABLE", side: "CREDIT",
      journal: { event: { eventKey: { startsWith: `receipt:${ids.bankTxn}:` } } } }, select: { id: true } });
    const paidLine = handBackPaid!.journal!.lines.find((l) => l.account === "REFUND_PAYABLE")!;
    const settled = await state();
    const handBackObligationId = settled.obligations.find((o) => o.key === handBackDebt)!.id;
    const reversedIds = new Set(settled.applications.map((a) => a.reversesApplicationId));
    const liveOnHandBack = settled.applications.filter((a) => a.obligationId === handBackObligationId && a.reversesApplicationId === null && !reversedIds.has(a.id));
    expect(liveOnHandBack.map((a) => [a.sourceLineId, a.amountCents]).sort()).toEqual([[receiptB.id, EXAMPLE_BANK_CENTS], [paidLine.id, EXAMPLE_BANK_CENTS]].sort());

    const before = { hand: await family(handBackDebt), card: await family(cardDebt) };
    expect(before.hand).toMatchObject({ funded: EXAMPLE_BANK_CENTS, paid: EXAMPLE_BANK_CENTS, reserved: 0 });
    expect(before.card).toMatchObject({ funded: EXAMPLE_CARD_CENTS, paid: EXAMPLE_CARD_CENTS, reserved: 0 });

    // Step 3: the lost card refund arrives through `charge.refunded`, then fails - each delivered twice.
    const late = await example.stripeRefund(LATE_REFUND, EXAMPLE_CARD_CENTS, "succeeded");
    await example.syncCardCharge([late]);
    await example.syncCardCharge([late]);
    await example.deliverFailure(late);
    await example.deliverFailure(late);

    const r12 = await eventOf(memberMoneyEventKeys.refund(LATE_REFUND));
    expect(linesOf(r12)).toEqual([`CREDIT STRIPE_CLEARING ${EXAMPLE_CARD_CENTS}`, `DEBIT MEMBER_RECEIVABLE ${EXAMPLE_CARD_CENTS}`]);
    expect(appliedOf(r12)).toBe(0); // the close already paid the card debt: the late refund answers nothing
    const r13Key = memberMoneyEventKeys.reversal(r12!.journal!.id);
    expect(await db.memberMoneyEvent.count({ where: { eventKey: r13Key } })).toBe(1);
    const r13 = await eventOf(r13Key);
    expect(r12?.journal?.reversedBy?.id).toBe(r13?.journal?.id);
    expect(r13?.journal?.reversedBy).toBeNull();
    expect(stripeClearingOf(r12, r13)).toBe(0);
    // Stripe still holds A's capture: the late refund leaves the club's card cash where it was.
    expect(balance(await db.memberMoneyLine.findMany({ where: { bookingId, account: "STRIPE_CLEARING" }, select: { side: true, amountCents: true } }))).toBe(EXAMPLE_CARD_CENTS);

    // Neither debt reopens: both bank payments stand.
    expect(await family(handBackDebt)).toEqual(before.hand);
    expect(await family(cardDebt)).toEqual(before.card);
    expect((await eventOf(handBackPaid!.eventKey))?.journal?.reversedBy).toBeNull();
    expect((await eventOf(paidAnotherWay!.eventKey))?.journal?.reversedBy).toBeNull();

    // The card capture funds no further refund: A's whole receipt already funds the card debt (C1, before Stripe is asked).
    const senderKeyPrefix = `booking_cancel_refund_recovery_${bookingId}`;
    const attemptKey = `${senderKeyPrefix}_${ids.cardTxn}_${EXAMPLE_BANK_CENTS}`;
    await expect(db.$transaction((tx) => reserveCardRefundSlice(tx, context, { paymentId: ids.payment, obligation: { scope: "cancellation", id: bookingId },
      attemptKey, senderKeyPrefix, paymentTransactionId: ids.cardTxn, amountCents: EXAMPLE_BANK_CENTS, planAttemptKeys: [attemptKey] })))
      .rejects.toSatisfy((error) => error instanceof MemberMoneyReservationRefused
        && error.problems.length === 1 && error.problems[0]!.startsWith(`${MEMBER_MONEY_CAP_PROBLEMS.C1}: receipt line `));
    expect(await db.memberMoneyRefundReservation.count({ where: { attemptKey: { startsWith: senderKeyPrefix } } })).toBe(0);

    // The whole booking in the journal. Debits equal credits over every line on it, and the bank cash is one figure:
    // B's receipt came in by bank and both debts went back out by bank, so $300.00 was returned against $100.00 in.
    const bookingLines = await db.memberMoneyLine.findMany({ where: { bookingId }, select: { account: true, side: true, amountCents: true } });
    expect(balance(bookingLines)).toBe(0);
    expect(balance(bookingLines.filter((l) => l.account === "BANK"))).toBe(EXAMPLE_BANK_CENTS - EXAMPLE_PRICE_CENTS);

    expect(memberMoneyConservationProblems(await state())).toEqual([]);
    expect(await example.mirrors()).toMatchObject({ a: EXAMPLE_CARD_CENTS, b: EXAMPLE_BANK_CENTS, payment: EXAMPLE_PRICE_CENTS });
  });
});
