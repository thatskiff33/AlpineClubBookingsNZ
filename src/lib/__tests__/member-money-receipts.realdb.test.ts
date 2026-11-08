import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postBookingReceipts, postMemberMergeTransfer } from "@/lib/member-money/doors";
import { memberMoneyEventKeys, postMemberMoneyEvent } from "@/lib/member-money";
import { readMemberMoneyApplicationState } from "@/lib/member-money/internal/application-read";
import { memberMoneyApplicationTotals } from "@/lib/member-money/internal/application-state";
import { readBookingReceiptCensus } from "@/lib/member-money/internal/receipt-census";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-m4b-";
const names = historyNames(PREFIX);
const context = memberMoneyTestContext();
let db: PrismaClient;
let sequence = 0;

async function booking(charge = 10_000, zero = false) {
  const id = `${PREFIX}${++sequence}`;
  await createHistoryBooking(db, names, id, { payment: { amountCents: charge, source: "STRIPE" } });
  await db.$transaction((tx) => postMemberMoneyEvent(tx, context, zero
    ? { kind: "ZERO", eventKey: memberMoneyEventKeys.bookingCharge(id), origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic zero R01" }
    : { kind: "CHARGE", eventKey: memberMoneyEventKeys.bookingCharge(id), origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic R01",
      obligations: [{ key: memberMoneyEventKeys.bookingCharge(id), kind: "CHARGE", debtor: { kind: "MEMBER", memberId: names.memberId }, faceCents: charge, evidence: {} }],
      legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: charge, booking: { bookingId: id, lodgeId: names.lodgeId }, debtor: { kind: "MEMBER", memberId: names.memberId }, obligationKey: memberMoneyEventKeys.bookingCharge(id), evidence: {} },
        { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: charge, booking: { bookingId: id, lodgeId: names.lodgeId }, chargeIdentity: `booking:${id}:test`, evidence: {} },
      ] }));
  return id;
}

async function cash(id: string, cents: number, source: "STRIPE" | "INTERNET_BANKING" = "STRIPE", manual = false) {
  const row = await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source, kind: "PRIMARY", status: "SUCCEEDED", amountCents: cents,
    stripePaymentIntentId: source === "STRIPE" ? `${id}-capture-${++sequence}` : null } });
  await db.$transaction(async (tx) => {
    if (manual) await tx.payment.update({ where: { id: `${id}-payment` }, data: { manuallyMarkedPaidAt: new Date(context.effectiveAt), manuallyMarkedPaidByMemberId: names.officerId } });
    await syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx });
  });
  return row;
}
const post = (id: string, decision?: Parameters<typeof postBookingReceipts>[2]["decision"]) => db.$transaction((tx) => postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision }));
const totals = (id: string) => db.$transaction(async (tx) => memberMoneyApplicationTotals(await readMemberMoneyApplicationState(tx, id)));
const census = (id: string) => db.$transaction((tx) => readBookingReceiptCensus(tx, `${id}-payment`));

(RUN ? describe : describe.skip)("M4b receipts on synthetic PostgreSQL bookings", () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "M4b receipts");
    process.env.DATABASE_URL = url;
    ({ prisma: db } = await import("@/lib/prisma"));
    await cleanHistories(db, PREFIX);
    await seedHistoryFixtures(db, PREFIX);
  }, 60_000);
  afterAll(async () => { if (db) await cleanHistories(db, PREFIX); }, 60_000);

  it("catches up full receipts unapplied, then collects only the exact chosen instrument up to C2", async () => {
    const id = await booking();
    const first = await cash(id, 7_000);
    const second = await cash(id, 8_000);
    expect((await census(id)).filter((f) => f.kind === "RECEIPT_WITHOUT_EVENT")).toHaveLength(2);
    expect(await post(id)).toBe(2);
    expect((await totals(id)).collected).toBe(0);
    expect(await post(id, { paymentIntentId: first.stripePaymentIntentId!, collect: true })).toBe(1);
    expect((await totals(id)).collected).toBe(7_000);
    expect(await post(id, { paymentIntentId: second.stripePaymentIntentId!, collect: true })).toBe(1);
    expect((await totals(id)).collected).toBe(10_000);
    expect(await post(id, { paymentIntentId: second.stripePaymentIntentId!, collect: true })).toBe(0);
    const money = await db.memberMoneyLine.aggregate({ where: { bookingId: id, account: "STRIPE_CLEARING", side: "DEBIT" }, _sum: { amountCents: true } });
    expect(money._sum.amountCents).toBe(15_000);
    expect((await census(id)).filter((f) => f.kind === "RECEIPT_WITHOUT_EVENT")).toEqual([]);
  });

  it("uses the provider capture instant and its club day, not the processing day", async () => {
    const id = await booking(); const row = await cash(id, 1_000);
    await post(id, { paymentIntentId: row.stripePaymentIntentId!, collect: false, effectiveAt: new Date("2026-06-29T11:59:00Z") });
    const event = await db.memberMoneyEvent.findUniqueOrThrow({ where: { eventKey: memberMoneyEventKeys.capture(row.stripePaymentIntentId!) } });
    expect(event.effectiveAt.toISOString()).toBe("2026-06-29T11:59:00.000Z");
    expect(event.effectiveDate.toISOString()).toBe("2026-06-29T00:00:00.000Z");
  });

  it("reverses exactly an officer receipt and its later collection once, then records the revived bank receipt separately", async () => {
    const id = await booking(); const row = await cash(id, 10_000, "INTERNET_BANKING", true);
    await post(id, { transactionIds: [row.id], collect: true });
    expect((await totals(id)).collected).toBe(10_000);
    await db.$transaction(async (tx) => {
      await tx.paymentTransaction.update({ where: { id: row.id }, data: { status: "FAILED" } });
      await tx.payment.update({ where: { id: `${id}-payment` }, data: { manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null } });
      await syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx });
      await postBookingReceipts(tx, context, { paymentId: `${id}-payment` });
    });
    expect((await totals(id)).collected).toBe(0);
    expect(await post(id)).toBe(0);
    await db.$transaction(async (tx) => {
      await tx.paymentTransaction.update({ where: { id: row.id }, data: { status: "SUCCEEDED" } });
      await syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx });
      await postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision: { transactionIds: [row.id], collect: true } });
    });
    expect((await totals(id)).collected).toBe(10_000);
    const legs = await db.memberMoneyLine.findMany({ where: { bookingId: id, account: { in: ["CASH", "BANK"] } } });
    expect(legs.map((l) => [l.account, l.side, l.amountCents]).sort()).toEqual([["BANK", "DEBIT", 10_000], ["CASH", "CREDIT", 10_000], ["CASH", "DEBIT", 10_000]]);
  });

  it("opens the obligation lazily after ZERO R01 without charging revenue twice", async () => {
    const id = await booking(10_000, true);
    await db.$transaction((tx) => postMemberMoneyEvent(tx, context, { kind: "ADJUSTMENT", eventKey: memberMoneyEventKeys.modification(id), origin: "APP",
      source: { kind: "BOOKING", id, version: "edit" }, reason: "Synthetic increase from zero", legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: 10_000, debtor: { kind: "MEMBER", memberId: names.memberId }, booking: { bookingId: id, lodgeId: names.lodgeId }, evidence: {} },
        { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: 10_000, chargeIdentity: `booking:${id}:test`, booking: { bookingId: id, lodgeId: names.lodgeId }, evidence: {} },
      ] }));
    const row = await cash(id, 5_000);
    await post(id, { transactionIds: [row.id], collect: true });
    expect((await totals(id)).collected).toBe(5_000);
    expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.chargeOpen(id) } })).toBe(1);
    expect((await db.memberMoneyObligation.findUniqueOrThrow({ where: { obligationKey: memberMoneyEventKeys.bookingCharge(id) } })).faceCents).toBe(10_000);
  });

  it("D4 transfers open charge obligations to successors, preserving prior collection and replay", async () => {
    const id = await booking(); const row = await cash(id, 4_000);
    await post(id, { transactionIds: [row.id], collect: true });
    await db.$transaction(async (tx) => {
      await tx.booking.update({ where: { id }, data: { memberId: names.officerId } });
      await postMemberMergeTransfer(tx, context, { fromMemberId: names.memberId, toMemberId: names.officerId, actorMemberId: names.officerId });
    });
    const successor = await db.memberMoneyObligation.findUniqueOrThrow({ where: { obligationKey: `${memberMoneyEventKeys.bookingCharge(id)}|for|MEMBER|${names.officerId}` } });
    expect(successor.faceCents).toBe(6_000);
    const next = await cash(id, 6_000);
    await post(id, { transactionIds: [next.id], collect: true });
    expect((await totals(id)).collected).toBe(10_000);
    expect((await census(id)).filter((f) => f.kind === "MERGED_DEBTOR_BALANCE")).toEqual([]);
  });

  it("moves only a receipt that landed on the merged-away member after the snapshot", async () => {
    const id = await booking();
    const early = await cash(id, 4_000);
    await post(id, { paymentIntentId: early.stripePaymentIntentId!, collect: false });
    await db.$transaction(async (tx) => {
      await tx.booking.update({ where: { id }, data: { memberId: names.officerId } });
      await postMemberMergeTransfer(tx, context, { fromMemberId: names.memberId, toMemberId: names.officerId, actorMemberId: names.officerId });
    });
    const strayIntent = `${id}-stray`;
    await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source: "STRIPE", kind: "ADDITIONAL", status: "SUCCEEDED", amountCents: 2_000, stripePaymentIntentId: strayIntent } });
    await db.$transaction(async (tx) => {
      await syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx });
      const line = await tx.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: id, anchorId: { not: early.id }, side: "SETTLEMENT", kind: "CARD_CAPTURE" } });
      await postMemberMoneyEvent(tx, context, { kind: "RECEIPT", eventKey: memberMoneyEventKeys.capture(strayIntent), origin: "STRIPE",
        source: { kind: "PAYMENT", id: line.anchorId!, version: line.id }, reason: "Receipt read the owner before the merge committed",
        legs: [
          { type: "amount", account: "STRIPE_CLEARING", side: "DEBIT", amountCents: 2_000, booking: { bookingId: id, lodgeId: names.lodgeId }, evidence: {} },
          { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 2_000, debtor: { kind: "MEMBER", memberId: names.memberId }, booking: { bookingId: id, lodgeId: names.lodgeId }, evidence: {} },
        ] });
    });
    expect((await census(id)).some((f) => f.kind === "MERGED_DEBTOR_BALANCE" && f.identity === names.memberId)).toBe(true);
    await post(id);
    expect((await census(id)).filter((f) => f.kind === "MERGED_DEBTOR_BALANCE")).toEqual([]);
    expect(await db.memberMoneyEvent.findUnique({ where: { eventKey: memberMoneyEventKeys.mergeResidue(names.memberId, names.officerId, memberMoneyEventKeys.capture(strayIntent)) } })).not.toBeNull();
    expect(await db.memberMoneyEvent.count({ where: { eventKey: { startsWith: `merge-residue:${names.officerId}` } } })).toBe(0);
  });

  it("reports drift without rewriting cash", async () => {
    const id = await booking(); const row = await cash(id, 8_000);
    await post(id);
    await db.paymentTransaction.update({ where: { id: row.id }, data: { amountCents: 9_000 } });
    expect((await census(id)).filter((f) => f.kind === "RECEIPT_AMOUNT_DRIFT")).toEqual([expect.objectContaining({ cents: 1_000 })]);
    expect(await post(id)).toBe(0);
  });
  it("ignores organiser-share mirrors and bookings outside the R01 population", async () => {
    const id = await booking();
    const row = await cash(id, 1_000);
    const { ORGANISER_SHARE_RECEIPT_REASON } = await import("@/lib/organiser-extra-state");
    await db.paymentTransaction.update({ where: { id: row.id }, data: { reason: ORGANISER_SHARE_RECEIPT_REASON } });
    expect(await post(id)).toBe(0);
    const outside = `${PREFIX}outside`;
    await createHistoryBooking(db, names, outside, { payment: { amountCents: 1_000, source: "STRIPE" } });
    await cash(outside, 1_000);
    expect(await post(outside)).toBe(0);
  });

  it("serialises two collectors under the Payment row, preserving both full cash receipts", async () => {
    const id = await booking(); const first = await cash(id, 8_000); const second = await cash(id, 8_000);
    await Promise.all([post(id, { transactionIds: [first.id], collect: true }), post(id, { transactionIds: [second.id], collect: true })]);
    expect((await totals(id)).collected).toBe(10_000);
    const receipts = await db.memberMoneyLine.aggregate({ where: { bookingId: id, account: "STRIPE_CLEARING", side: "DEBIT" }, _sum: { amountCents: true } });
    expect(receipts._sum.amountCents).toBe(16_000);
  });

  it("rolls back the writer's legacy change with a journal refusal", async () => {
    const id = await booking(); const row = await cash(id, 1_000);
    await expect(db.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: `${id}-payment` }, data: { manualPaymentNote: "must roll back" } });
      await postBookingReceipts(tx, { ...context, currency: "INVALID" }, { paymentId: `${id}-payment`, decision: { transactionIds: [row.id], collect: true } });
    })).rejects.toThrow();
    expect((await db.payment.findUniqueOrThrow({ where: { id: `${id}-payment` } })).manualPaymentNote).toBeNull();
    expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.capture(row.stripePaymentIntentId!) } })).toBe(0);
  });

  it("the real additional-capture writer receives an explicit hold/collect decision", async () => {
    const { markPaymentIntentTransactionSucceeded } = await import("@/lib/payment-transactions");
    for (const collect of [false, true]) {
      const id = await booking();
      const intent = `${id}-additional`;
      await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: intent, status: "PENDING", amountCents: 5_000 } });
      await db.$transaction((tx) => markPaymentIntentTransactionSucceeded({ paymentIntentId: intent, amountCents: 5_000, store: tx, journal: context,
        receiptDecision: { collect, effectiveAt: new Date(context.effectiveAt) } }));
      expect((await totals(id)).collected).toBe(collect ? 5_000 : 0);
      expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.capture(intent) } })).toBe(1);
    }
  });

  it("the real saved-card writer records the full capture held before the settlement decides collect", async () => {
    const { settleSavedCardChargeAttempt } = await import("@/lib/saved-card-charge-settle");
    const id = await booking();
    const row = await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, kind: "PRIMARY", source: "STRIPE", status: "PENDING", amountCents: 10_000 } });
    const result = await db.$transaction((tx) => settleSavedCardChargeAttempt({ attemptRowId: row.id, paymentId: `${id}-payment`, store: tx, journal: context,
      paymentIntent: { id: `${id}-capture`, amount: 10_000, status: "succeeded", payment_method: null, created: 1_782_864_000 } }));
    expect(result.newlyCaptured).toBe(true);
    expect((await totals(id)).collected).toBe(0);
    expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.capture(`${id}-capture`) } })).toBe(1);
    await post(id, { paymentIntentId: `${id}-capture`, collect: true });
    expect((await totals(id)).collected).toBe(10_000);
  });

  it("the real officer settle posts cash and its real reversal restores both cash and collection", async () => {
    const { markBookingPaymentManuallySettled, reverseManualBookingPayment } = await import("@/lib/payment-reconciliation");
    const { CLUB_FORMAT_TEST } = await import("./support/club-format-fixture");
    const id = await booking(20_000);
    await markBookingPaymentManuallySettled({ bookingId: id, actingAdminMemberId: names.officerId, expectedAmountCents: 20_000, note: "Synthetic cash", notifyMember: false, format: CLUB_FORMAT_TEST });
    expect((await totals(id)).collected).toBe(20_000);
    await reverseManualBookingPayment({ bookingId: id, actingAdminMemberId: names.officerId, note: "Synthetic correction" });
    expect((await totals(id)).collected).toBe(0);
    const cashLegs = await db.memberMoneyLine.findMany({ where: { bookingId: id, account: "CASH" } });
    expect(cashLegs.reduce((n, l) => n + (l.side === "DEBIT" ? l.amountCents : -l.amountCents), 0)).toBe(0);
  });

});
